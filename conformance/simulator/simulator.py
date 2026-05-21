#!/usr/bin/env python3
"""
Minimal Modbus TCP simulator for sungrowlib conformance tests.

No external dependencies beyond pyyaml. Implements only FC 0x03 (Read Holding)
and FC 0x04 (Read Input) — enough to simulate a Sungrow inverter.

Usage:
    python simulator.py --scenario scenario.yaml [--base-port 50200] [--fixtures-dir fixtures/]
"""

import argparse
import asyncio
import json
import signal
import struct
import sys
from pathlib import Path
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Register data helpers
# ---------------------------------------------------------------------------

def encode_utf8(text: str) -> list[int]:
    raw = text.encode("ascii")
    words = []
    for i in range(0, len(raw), 2):
        hi = raw[i]
        lo = raw[i + 1] if i + 1 < len(raw) else 0
        words.append((hi << 8) | lo)
    return words


def expand_registers(data: dict) -> dict[int, int]:
    result: dict[int, int] = {}
    if not data:
        return result
    for addr_key, val in data.items():
        addr = int(addr_key)
        if isinstance(val, dict) and "utf8" in val:
            for i, word in enumerate(encode_utf8(val["utf8"])):
                result[addr + i] = word
        elif isinstance(val, list):
            for i, word in enumerate(val):
                result[addr + i] = int(word)
        else:
            result[addr] = int(val)
    return result


def load_fixture(fixture_name: str, fixtures_dir: Path) -> dict:
    path = fixtures_dir / f"{fixture_name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Fixture not found: {path}")
    return yaml.safe_load(path.read_text())


def resolve_inverter(inv: dict, fixtures_dir: Path) -> dict:
    if "fixture" not in inv:
        return inv
    fixture = load_fixture(inv["fixture"], fixtures_dir)
    merged = dict(inv)
    for reg_type in ("input", "holding"):
        base = dict(fixture.get(reg_type, {}))
        override = inv.get(reg_type, {})
        base.update(override)
        merged[reg_type] = base
    if "serial" in fixture:
        merged.setdefault("input", {}).setdefault(4990, {"utf8": fixture["serial"]})
    if "model_code" in fixture:
        merged.setdefault("input", {}).setdefault(5000, fixture["model_code"])
    if "slave_id" not in merged and "slave_id" in fixture:
        merged["slave_id"] = fixture["slave_id"]
    return merged


# ---------------------------------------------------------------------------
# Fault matching
# ---------------------------------------------------------------------------

def check_faults(faults: list[dict], sungrow_addr: int, count: int) -> int | None:
    """Return Modbus exception code if any fault matches, else None."""
    for fault in faults:
        f_start, f_end = fault["range"]
        # Fault triggers if any requested register falls in the fault range
        req_end = sungrow_addr + count - 1
        if sungrow_addr <= f_end and req_end >= f_start:
            # single_only: only trigger for single-register reads (count == 1)
            if fault.get("single_only") and count != 1:
                continue
            error_name = fault.get("error", "illegal_data_address")
            return {
                "illegal_data_address": 0x02,
                "illegal_data_value": 0x03,
                "slave_device_failure": 0x04,
            }.get(error_name, 0x02)
    return None


# ---------------------------------------------------------------------------
# Modbus TCP protocol handler
# ---------------------------------------------------------------------------

class ModbusTcpHandler:
    """Handles one TCP connection, serving register data for a single inverter."""

    def __init__(self, inv_id: str, slave_id: int,
                 input_regs: dict[int, int], holding_regs: dict[int, int],
                 faults: list[dict], call_log: list[dict]):
        self.inv_id = inv_id
        self.slave_id = slave_id
        self.input_regs = input_regs
        self.holding_regs = holding_regs
        self.faults = faults
        self.call_log = call_log

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                # MBAP header: transaction_id(2) + protocol_id(2) + length(2) + unit_id(1)
                header = await reader.readexactly(7)
                tx_id, proto_id, length, unit_id = struct.unpack(">HHHB", header)

                # Read PDU (length - 1 bytes, since unit_id is counted in length)
                pdu_data = await reader.readexactly(length - 1)
                fc = pdu_data[0]

                if unit_id != self.slave_id:
                    # Wrong slave ID — no response (Modbus spec: slave ignores)
                    continue

                if fc in (0x03, 0x04):  # Read Holding / Read Input
                    start_addr, count = struct.unpack(">HH", pdu_data[1:5])
                    # start_addr is 0-based Modbus → convert to 1-based Sungrow
                    sungrow_addr = start_addr + 1

                    regs = self.holding_regs if fc == 0x03 else self.input_regs
                    self.call_log.append({
                        "fc": fc, "start": sungrow_addr, "count": count
                    })

                    # Check faults
                    exc_code = check_faults(self.faults, sungrow_addr, count)
                    if exc_code is not None:
                        # Exception response
                        resp_pdu = struct.pack("BB", fc | 0x80, exc_code)
                    else:
                        # Normal response
                        values = []
                        for i in range(count):
                            addr = sungrow_addr + i
                            values.append(regs.get(addr, 0))
                        byte_count = count * 2
                        resp_pdu = struct.pack("BB", fc, byte_count)
                        for v in values:
                            resp_pdu += struct.pack(">H", v & 0xFFFF)

                    # MBAP response header
                    resp_length = len(resp_pdu) + 1  # +1 for unit_id
                    resp_header = struct.pack(">HHHB", tx_id, proto_id, resp_length, unit_id)
                    writer.write(resp_header + resp_pdu)
                    await writer.drain()
                else:
                    # Unsupported function code
                    resp_pdu = struct.pack("BB", fc | 0x80, 0x01)
                    resp_length = len(resp_pdu) + 1
                    resp_header = struct.pack(">HHHB", tx_id, proto_id, resp_length, unit_id)
                    writer.write(resp_header + resp_pdu)
                    await writer.drain()

        except (asyncio.IncompleteReadError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------

async def main() -> None:
    parser = argparse.ArgumentParser(description="Sungrow Modbus TCP simulator")
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--base-port", type=int, default=50200)
    parser.add_argument("--fixtures-dir", default=None)
    parser.add_argument("--call-log", default="/tmp/sungrow-sim-calls.json")
    args = parser.parse_args()

    scenario_path = Path(args.scenario)
    scenario = yaml.safe_load(scenario_path.read_text())
    fixtures_dir = (
        Path(args.fixtures_dir) if args.fixtures_dir
        else scenario_path.parent.parent / "fixtures"
    )

    inverters = scenario.get("inverters", [])
    if not inverters:
        print(json.dumps({"error": "No inverters defined"}), file=sys.stderr)
        sys.exit(1)

    port_map: dict[str, int] = {}
    all_logs: dict[str, list[dict]] = {}
    servers: list[asyncio.Server] = []

    for i, raw_inv in enumerate(inverters):
        inv = resolve_inverter(raw_inv, fixtures_dir)
        inv_id = inv.get("id", f"inv{i}")
        slave_id = inv.get("slave_id", 1)
        port = args.base_port + i

        input_regs = expand_registers(inv.get("input", {}))
        holding_regs = expand_registers(inv.get("holding", {}))
        faults = inv.get("faults", [])
        call_log: list[dict] = []
        all_logs[inv_id] = call_log

        handler = ModbusTcpHandler(inv_id, slave_id, input_regs, holding_regs, faults, call_log)
        server = await asyncio.start_server(handler.handle, "127.0.0.1", port)
        servers.append(server)
        port_map[inv_id] = port

    # Output port mapping for the runner
    print(json.dumps({"ports": port_map}), flush=True)

    # Wait for SIGTERM/SIGINT
    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()

    # Write call log
    call_log_output: dict[str, Any] = {"inverters": {}}
    total = 0
    for inv_id, logs in all_logs.items():
        ir_calls = [c for c in logs if c["fc"] == 4]
        hr_calls = [c for c in logs if c["fc"] == 3]
        call_log_output["inverters"][inv_id] = {
            "calls": logs,
            "total": len(logs),
            "input_calls": len(ir_calls),
            "holding_calls": len(hr_calls),
        }
        total += len(logs)
    call_log_output["total"] = total

    Path(args.call_log).write_text(json.dumps(call_log_output, indent=2))
    print(f"Call log written to {args.call_log}", file=sys.stderr)

    for server in servers:
        server.close()


if __name__ == "__main__":
    asyncio.run(main())
