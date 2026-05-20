#!/usr/bin/env python3
"""
Conformance test runner for sungrowlib.

Orchestrates the Modbus simulator and lib CLI to validate YAML scenarios.

Usage:
    python run.py --scenarios scenarios/ --cli sungrowlib [--tags detect,read] [--verbose]
"""

import argparse
import json
import math
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import yaml

SIMULATOR_SCRIPT = Path(__file__).parent.parent / "simulator" / "simulator.py"
CALL_LOG_PATH = Path("/tmp/sungrow-sim-calls.json")
DEAD_PORT = 59999  # Port for "unreachable" hosts — nothing should listen here


# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------

class Check:
    def __init__(self, name: str, passed: bool, detail: str = "",
                 expected: Any = None, actual: Any = None):
        self.name = name
        self.passed = passed
        self.detail = detail
        self.expected = expected
        self.actual = actual

    def __repr__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        msg = f"[{status}] {self.name}"
        if not self.passed:
            msg += f": expected={self.expected!r}, actual={self.actual!r}"
            if self.detail:
                msg += f" ({self.detail})"
        return msg


# ---------------------------------------------------------------------------
# Value matching
# ---------------------------------------------------------------------------

def match_value(name: str, actual: dict, expect: dict) -> list[Check]:
    """Match a single register value against expectations."""
    checks: list[Check] = []

    if "value" in expect:
        exp = expect["value"]
        act = actual.get("value")
        if isinstance(exp, float) and isinstance(act, (int, float)):
            ok = math.isclose(act, exp, abs_tol=0.01)
        else:
            ok = act == exp
        checks.append(Check(f"{name}.value", ok, expected=exp, actual=act))

    if "approx" in expect:
        tol = expect.get("tolerance", 0.1)
        act = actual.get("value")
        if isinstance(act, (int, float)):
            ok = abs(act - expect["approx"]) <= tol
        else:
            ok = False
        checks.append(Check(
            f"{name}.value", ok,
            detail=f"±{tol}",
            expected=expect["approx"],
            actual=act,
        ))

    if "matches" in expect:
        act = str(actual.get("value", ""))
        ok = bool(re.match(expect["matches"], act))
        checks.append(Check(
            f"{name}.value", ok,
            detail=f"regex /{expect['matches']}/",
            expected=expect["matches"],
            actual=act,
        ))

    if "unit" in expect:
        act = actual.get("unit")
        ok = act == expect["unit"]
        checks.append(Check(f"{name}.unit", ok, expected=expect["unit"], actual=act))

    if "supported" in expect:
        act = actual.get("supported")
        ok = act == expect["supported"]
        checks.append(Check(f"{name}.supported", ok, expected=expect["supported"], actual=act))

    return checks


# ---------------------------------------------------------------------------
# Assertion runners
# ---------------------------------------------------------------------------

def check_info(info_json: dict, expectations: dict) -> list[Check]:
    """Check inverter info fields."""
    checks: list[Check] = []
    field_map = {
        "model": "model",
        "serial_number": "serialNumber",
        "connection_mode": "connectionMode",
        "has_battery": "hasBattery",
        "has_meter": "hasMeter",
        "output_type": "outputType",
        "slave_count": "slaveCount",
    }
    for yaml_key, json_key in field_map.items():
        if yaml_key in expectations:
            exp = expectations[yaml_key]
            act = info_json.get(json_key)
            ok = act == exp
            checks.append(Check(f"info.{yaml_key}", ok, expected=exp, actual=act))
    return checks


def check_groups(groups_json: dict, expectations: dict) -> list[Check]:
    """Check active groups."""
    checks: list[Check] = []
    for group, expected in expectations.items():
        actual = groups_json.get(group)
        ok = actual == expected
        checks.append(Check(f"group.{group}", ok, expected=expected, actual=actual))
    return checks


def check_read(read_data: list[dict], expectations: dict) -> list[Check]:
    """Check decoded register values from read output."""
    by_name = {v["name"]: v for v in read_data}
    checks: list[Check] = []

    for name, expect in expectations.items():
        if expect == "absent":
            ok = name not in by_name
            checks.append(Check(f"read.{name}", ok, detail="should be absent",
                                expected="absent", actual="present" if not ok else "absent"))
            continue
        if expect == "any":
            ok = name in by_name
            checks.append(Check(f"read.{name}", ok, detail="should exist",
                                expected="any", actual="missing" if not ok else "present"))
            continue

        actual = by_name.get(name)
        if actual is None:
            checks.append(Check(f"read.{name}", False, detail="not in output",
                                expected=expect, actual=None))
            continue
        checks.extend(match_value(f"read.{name}", actual, expect))

    return checks


def check_modbus_calls(call_log: dict, expectations: dict, inverter_id: str = "") -> list[Check]:
    """Check Modbus call efficiency against expectations."""
    checks: list[Check] = []

    # Aggregate across all inverters if no specific one targeted
    if inverter_id and inverter_id in call_log.get("inverters", {}):
        inv_log = call_log["inverters"][inverter_id]
    else:
        # Sum all inverters
        inv_log = {"calls": [], "total": 0, "input_calls": 0, "holding_calls": 0}
        for inv_data in call_log.get("inverters", {}).values():
            inv_log["calls"].extend(inv_data.get("calls", []))
            inv_log["total"] += inv_data.get("total", 0)
            inv_log["input_calls"] += inv_data.get("input_calls", 0)
            inv_log["holding_calls"] += inv_data.get("holding_calls", 0)

    if "total_calls" in expectations:
        limit = expectations["total_calls"].get("max", 999)
        actual = inv_log["total"]
        ok = actual <= limit
        checks.append(Check("modbus.total_calls", ok,
                            detail=f"max {limit}", expected=f"≤{limit}", actual=actual))

    if "input_calls" in expectations:
        limit = expectations["input_calls"].get("max", 999)
        actual = inv_log["input_calls"]
        ok = actual <= limit
        checks.append(Check("modbus.input_calls", ok,
                            detail=f"max {limit}", expected=f"≤{limit}", actual=actual))

    if "holding_calls" in expectations:
        limit = expectations["holding_calls"].get("max", 999)
        actual = inv_log["holding_calls"]
        ok = actual <= limit
        checks.append(Check("modbus.holding_calls", ok,
                            detail=f"max {limit}", expected=f"≤{limit}", actual=actual))

    if "no_single_reads" in expectations:
        forbidden = set(expectations["no_single_reads"])
        for call in inv_log["calls"]:
            if call["count"] == 1 and call["start"] in forbidden:
                checks.append(Check(
                    f"modbus.no_single_read@{call['start']}", False,
                    detail="register read individually instead of in a block",
                    expected="block read", actual=f"single read FC{call['fc']} @{call['start']}",
                ))
        if not any(not c.passed for c in checks if c.name.startswith("modbus.no_single")):
            checks.append(Check("modbus.no_single_reads", True, detail="all in blocks"))

    return checks


# ---------------------------------------------------------------------------
# CLI execution
# ---------------------------------------------------------------------------

def run_cli(cli: str, command: str, hosts: list[tuple[str, int]],
            extra_args: list[str] | None = None, timeout: int = 30) -> tuple[str, str, int]:
    """Run the sungrowlib CLI and return (stdout, stderr, returncode)."""
    args = shlex.split(cli) + [command, "--format", "json"]
    for host, port in hosts:
        args.extend(["-H", f"{host}:{port}"])
    if extra_args:
        args.extend(extra_args)

    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return result.stdout, result.stderr, result.returncode


# ---------------------------------------------------------------------------
# Simulator lifecycle
# ---------------------------------------------------------------------------

def start_simulator(
    scenario_path: Path, base_port: int, fixtures_dir: Path
) -> tuple[subprocess.Popen, dict[str, int]]:
    """Start the simulator process and return (process, port_map)."""
    cmd = [
        sys.executable, str(SIMULATOR_SCRIPT),
        "--scenario", str(scenario_path),
        "--base-port", str(base_port),
        "--fixtures-dir", str(fixtures_dir),
        "--call-log", str(CALL_LOG_PATH),
    ]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    # Read port mapping from stdout (first line)
    line = proc.stdout.readline().strip()
    if not line:
        stderr = proc.stderr.read()
        proc.kill()
        raise RuntimeError(f"Simulator failed to start: {stderr}")

    port_info = json.loads(line)
    port_map = port_info.get("ports", {})

    # Give server a moment to be ready
    time.sleep(0.2)

    return proc, port_map


def stop_simulator(proc: subprocess.Popen) -> dict:
    """Stop the simulator and return the call log."""
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    # Read call log
    if CALL_LOG_PATH.exists():
        return json.loads(CALL_LOG_PATH.read_text())
    return {}


# ---------------------------------------------------------------------------
# Scenario runner
# ---------------------------------------------------------------------------

def resolve_hosts(
    expect: dict, port_map: dict[str, int]
) -> list[tuple[str, int]]:
    """Determine which hosts to pass to the CLI based on expect section."""
    if "system" in expect:
        sys_expect = expect["system"]
        hosts = []
        for h in sys_expect.get("hosts", []):
            if h == "unreachable":
                hosts.append(("127.0.0.1", DEAD_PORT))
            elif h in port_map:
                hosts.append(("127.0.0.1", port_map[h]))
            else:
                raise ValueError(f"Unknown host id '{h}' — not in inverters")
        return hosts

    # Default: first inverter
    if port_map:
        first_id = next(iter(port_map))
        return [("127.0.0.1", port_map[first_id])]
    return []


def run_scenario(
    scenario: dict, scenario_path: Path, cli: str,
    fixtures_dir: Path, base_port: int, verbose: bool
) -> tuple[bool, list[Check]]:
    """Run a single scenario and return (passed, checks)."""
    proc, port_map = start_simulator(scenario_path, base_port, fixtures_dir)

    try:
        all_checks: list[Check] = []
        expect = scenario.get("expect", {})

        # --- info + active_groups ---
        if "info" in expect or "active_groups" in expect:
            hosts = resolve_hosts(expect, port_map)
            stdout, stderr, rc = run_cli(cli, "info", hosts)
            if rc != 0:
                # Check if error is expected
                if "system" in expect and "error" in expect["system"]:
                    exp_error = expect["system"]["error"]
                    ok = exp_error.lower() in stderr.lower()
                    all_checks.append(Check("system.error", ok,
                                            expected=exp_error, actual=stderr.strip()))
                    return all(c.passed for c in all_checks), all_checks
                else:
                    all_checks.append(Check("cli.info", False,
                                            detail=f"exit code {rc}", expected=0, actual=rc))
                    if verbose:
                        print(f"  stderr: {stderr.strip()}", file=sys.stderr)
                    return False, all_checks

            info_json = json.loads(stdout)
            if "info" in expect:
                all_checks.extend(check_info(info_json, expect["info"]))
            if "active_groups" in expect:
                groups = info_json.get("activeGroups", {})
                all_checks.extend(check_groups(groups, expect["active_groups"]))

        # --- system error (no info section) ---
        if "system" in expect and "error" in expect["system"] and "info" not in expect:
            hosts = resolve_hosts(expect, port_map)
            stdout, stderr, rc = run_cli(cli, "info", hosts)
            exp_error = expect["system"]["error"]
            ok = exp_error.lower() in stderr.lower()
            all_checks.append(Check("system.error", ok,
                                    expected=exp_error, actual=stderr.strip()))

        # --- system topology ---
        if "system" in expect and "error" not in expect.get("system", {}):
            sys_expect = expect["system"]
            hosts = resolve_hosts(expect, port_map)
            stdout, stderr, rc = run_cli(cli, "info", hosts)
            if rc == 0:
                info_json = json.loads(stdout)
                if "has_slaves" in sys_expect:
                    has_slaves = bool(info_json.get("slaveDetails"))
                    ok = has_slaves == sys_expect["has_slaves"]
                    all_checks.append(Check("system.has_slaves", ok,
                                            expected=sys_expect["has_slaves"], actual=has_slaves))
                if "slave_count" in sys_expect:
                    actual_count = len(info_json.get("slaveDetails", []))
                    ok = actual_count == sys_expect["slave_count"]
                    all_checks.append(Check("system.slave_count", ok,
                                            expected=sys_expect["slave_count"], actual=actual_count))

        # --- read ---
        if "read" in expect:
            hosts = resolve_hosts(expect, port_map)
            stdout, stderr, rc = run_cli(cli, "read", hosts)
            if rc != 0:
                all_checks.append(Check("cli.read", False,
                                        detail=f"exit code {rc}", expected=0, actual=rc))
                if verbose:
                    print(f"  stderr: {stderr.strip()}", file=sys.stderr)
            else:
                read_data = json.loads(stdout)
                if isinstance(read_data, dict) and "rows" in read_data:
                    read_data = read_data["rows"]
                all_checks.extend(check_read(read_data, expect["read"]))

        # --- slave_read ---
        if "slave_read" in expect:
            for slave_spec in expect["slave_read"]:
                slave_host = slave_spec["host"]
                if slave_host in port_map:
                    slave_hosts = [("127.0.0.1", port_map[slave_host])]
                    stdout, stderr, rc = run_cli(cli, "read", slave_hosts)
                    if rc == 0:
                        read_data = json.loads(stdout)
                        if isinstance(read_data, dict) and "rows" in read_data:
                            read_data = read_data["rows"]
                        for reg_name, exp_val in slave_spec.get("values", {}).items():
                            checks = check_read(read_data, {reg_name: exp_val})
                            for c in checks:
                                c.name = f"slave[{slave_host}].{c.name}"
                            all_checks.extend(checks)

        return all(c.passed for c in all_checks), all_checks

    finally:
        call_log = stop_simulator(proc)

        # Check modbus_calls if expected
        if "modbus_calls" in expect:
            modbus_checks = check_modbus_calls(call_log, expect["modbus_calls"])
            all_checks.extend(modbus_checks)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def find_scenarios(scenarios_dir: Path, tags: set[str] | None) -> list[Path]:
    """Find all scenario YAML files, optionally filtered by tags."""
    files: list[Path] = []
    for f in sorted(scenarios_dir.rglob("*.yaml")):
        if f.parent.name == "fixtures":
            continue
        if tags:
            scenario = yaml.safe_load(f.read_text())
            scenario_tags = set(scenario.get("tags", []))
            if not (tags & scenario_tags):
                continue
        files.append(f)
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description="Sungrowlib conformance test runner")
    parser.add_argument("--scenarios", required=True, help="Path to scenarios directory")
    parser.add_argument("--cli", required=True, help="Path to sungrowlib CLI binary")
    parser.add_argument("--tags", default=None, help="Comma-separated tag filter")
    parser.add_argument("--fixtures-dir", default=None, help="Override fixtures directory")
    parser.add_argument("--base-port", type=int, default=50200, help="Base simulator port")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    args = parser.parse_args()

    scenarios_dir = Path(args.scenarios)
    fixtures_dir = Path(args.fixtures_dir) if args.fixtures_dir else scenarios_dir.parent / "fixtures"
    tags = set(args.tags.split(",")) if args.tags else None

    scenario_files = find_scenarios(scenarios_dir, tags)
    if not scenario_files:
        print("No scenarios found.", file=sys.stderr)
        sys.exit(1)

    total_pass = 0
    total_fail = 0
    failed_scenarios: list[str] = []

    for i, sf in enumerate(scenario_files):
        scenario = yaml.safe_load(sf.read_text())
        name = scenario.get("name", sf.stem)
        port_offset = i * 10  # Each scenario gets its own port range

        try:
            passed, checks = run_scenario(
                scenario, sf, args.cli, fixtures_dir,
                args.base_port + port_offset, args.verbose,
            )
        except Exception as e:
            passed = False
            checks = [Check("runner", False, detail=str(e))]

        n_passed = sum(1 for c in checks if c.passed)
        n_total = len(checks)

        if passed:
            print(f"  \033[32m✓\033[0m {name} ({n_passed}/{n_total} checks)")
            total_pass += 1
        else:
            print(f"  \033[31m✗\033[0m {name} ({n_passed}/{n_total} checks)")
            total_fail += 1
            failed_scenarios.append(name)
            for c in checks:
                if not c.passed:
                    print(f"    FAIL: {c}")

        if args.verbose:
            for c in checks:
                print(f"    {'✓' if c.passed else '✗'} {c}")

    print()
    total = total_pass + total_fail
    if total_fail == 0:
        print(f"\033[32mAll {total} scenarios passed.\033[0m")
    else:
        print(f"\033[31m{total_fail}/{total} scenarios failed:\033[0m")
        for name in failed_scenarios:
            print(f"  - {name}")

    sys.exit(0 if total_fail == 0 else 1)


if __name__ == "__main__":
    main()
