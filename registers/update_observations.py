#!/usr/bin/env python3
"""
Update registers-sungrow.json with observations collected from dump files.

Reads all *.json files in the dumps/ directory and populates the `observations`
field on each matching register. Idempotent — re-run after adding new dumps:

    python3 registers/update_observations.py
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent

# Register names whose values are collected into the `versions` dict
# rather than the `values` list of an observation.
VERSION_REGISTER_NAMES = {
    "firmware_version_1",
    "firmware_version_2",
    "firmware_version_3",
    "firmware_version_4_battery",
    "protocol_version",
    "arm_software_version",
    "dsp_software_version",
    "inverter_firmware_version",
    "communication_module_firmware_version",
    "battery_firmware_version",
}


def extract_versions(values: list[dict]) -> dict:
    return {
        v["name"]: v["value"]
        for v in values
        if v["name"] in VERSION_REGISTER_NAMES
        and isinstance(v.get("value"), (str, int, float))
    }


def group_key(model: str, versions: dict) -> tuple:
    return (model, tuple(sorted(versions.items())))


def is_scalar_observation_value(entry: dict) -> bool:
    """True if the decoded value is a plain scalar suitable for the values list."""
    if isinstance(entry.get("raw"), list):
        return False
    val = entry.get("value")
    return isinstance(val, (int, float, str)) and not isinstance(val, bool)


def accumulate_values(
    values: list[dict],
    context: str,
    active_groups: dict,
    versions: dict,
    model: str,
    result: dict,
) -> None:
    key = group_key(model, versions)
    if key not in result:
        result[key] = {
            "model": model,
            "versions": versions,
            "active_groups": set(),
            "registers": defaultdict(lambda: {"supported": set(), "values": set(), "connection_modes": set()}),
        }

    grp = result[key]
    grp["active_groups"].update(k for k, v in active_groups.items() if v)

    for entry in values:
        name = entry["name"]
        if name in VERSION_REGISTER_NAMES:
            continue

        reg = grp["registers"][name]
        reg["connection_modes"].add(context)
        supported = entry.get("supported", "unknown")
        reg["supported"].add(supported)

        if supported == "yes" and is_scalar_observation_value(entry):
            reg["values"].add(entry["value"])


def build_observations(dumps: list[dict]) -> dict[str, list[dict]]:
    accumulated: dict[tuple, dict] = {}

    for dump in dumps:
        master_model = dump["model"]
        master_versions = extract_versions(dump.get("values", []))
        active_groups = dump.get("activeGroups", {})

        accumulate_values(
            dump.get("values", []),
            context="master",
            active_groups=active_groups,
            versions=master_versions,
            model=master_model,
            result=accumulated,
        )

        for slave in dump.get("slaveDetails", []):
            slave_model = slave.get("model", master_model)
            slave_values = slave.get("values", [])
            # When slave model matches master, use master's complete versions
            # (master has battery/system firmware that slaves don't report).
            if slave_model == master_model:
                slave_versions = master_versions
            else:
                slave_versions = extract_versions(slave_values) or master_versions

            accumulate_values(
                slave_values,
                context="slave",
                active_groups=active_groups,
                versions=slave_versions,
                model=slave_model,
                result=accumulated,
            )

    observations_by_name: dict[str, list[dict]] = defaultdict(list)

    # Sort groups for stable output
    for key in sorted(accumulated):
        grp = accumulated[key]

        base = {
            "model": grp["model"],
            "versions": grp["versions"],
            "active_groups": sorted(grp["active_groups"]),
        }

        for reg_name, reg_data in grp["registers"].items():
            obs = dict(base)

            modes = reg_data["connection_modes"]
            if "master" in modes and "slave" in modes:
                obs["connection_mode"] = "both"
            elif "master" in modes:
                obs["connection_mode"] = "master"
            else:
                obs["connection_mode"] = "slave"

            supported_set = reg_data["supported"]
            if "yes" in supported_set:
                obs["supported"] = True
            elif "unknown" in supported_set:
                obs["supported"] = "unknown"
            else:
                obs["supported"] = False

            if reg_data["values"]:
                try:
                    obs["values"] = sorted(reg_data["values"])
                except TypeError:
                    obs["values"] = sorted(reg_data["values"], key=str)

            observations_by_name[reg_name].append(obs)

    return dict(observations_by_name)


def apply_observations(catalog: dict, observations: dict[str, list[dict]]) -> tuple[dict, int, int]:
    updated = cleared = 0
    for section in ("read", "hold"):
        for reg in catalog[section]:
            name = reg["name"]
            if name in observations:
                reg["observations"] = observations[name]
                updated += 1
            elif "observations" in reg:
                del reg["observations"]
                cleared += 1
    return catalog, updated, cleared


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dumps",
        default=str(REPO_ROOT / "dumps"),
        help="Directory containing dump JSON files (default: %(default)s)",
    )
    parser.add_argument(
        "--registers",
        default=str(REPO_ROOT / "registers" / "registers-sungrow.json"),
        help="Path to registers JSON file (default: %(default)s)",
    )
    args = parser.parse_args()

    dumps_dir = Path(args.dumps)
    registers_file = Path(args.registers)

    dump_files = sorted(dumps_dir.glob("*.json"))
    if not dump_files:
        print(f"No dump files found in {dumps_dir}")
        return

    dumps = [json.loads(f.read_text()) for f in dump_files]
    print(f"Loaded {len(dumps)} dump(s): {[f.name for f in dump_files]}")

    observations = build_observations(dumps)
    print(f"Built observations for {len(observations)} registers")

    catalog = json.loads(registers_file.read_text())
    catalog, updated, cleared = apply_observations(catalog, observations)

    registers_file.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {registers_file}: {updated} registers updated, {cleared} stale observations cleared")


if __name__ == "__main__":
    main()
