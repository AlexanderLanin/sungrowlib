#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""Compare the sungrowlib register catalog against external Sungrow register catalogs."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError

import yaml

SOURCES: dict[str, str] = {
    "mkaiser": "https://raw.githubusercontent.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/main/modbus_sungrow.yaml",
    "ha-sungrow": "https://raw.githubusercontent.com/AlexanderLanin/homeassistant-sungrow/main/custom_components/sungrow/core/registers-sungrow.yaml",
    "sungather": "https://raw.githubusercontent.com/bohdan-s/SunGather/main/SunGather/registers-sungrow.yaml",
}

CACHE_DIR = Path("/tmp/sungrow-catalog-cache")


@dataclass
class NormalizedRegister:
    name: str
    address: int  # always 1-based
    type: str  # 'read' or 'hold'
    data_type: str  # U16, S16, U32, S32, UTF-8
    scale: float | None = None
    unit: str | None = None
    source: str = ""


@dataclass
class Difference:
    address: int
    type: str
    ours_name: str
    theirs_name: str
    field: str
    ours_value: str
    theirs_value: str


@dataclass
class ComparisonResult:
    source: str
    ours_count: int
    theirs_count: int
    matched: int
    missing_from_ours: list[NormalizedRegister]
    unique_to_ours: int
    differences: list[Difference]


# -- Fetching ------------------------------------------------------------------

def fetch_source(name: str, url: str, *, use_cache: bool = False) -> str:
    cache_file = CACHE_DIR / f"{name}.yaml"

    if use_cache and cache_file.exists():
        return cache_file.read_text()

    try:
        with urlopen(url, timeout=15) as resp:
            text = resp.read().decode()
    except URLError as e:
        print(f"  warning: failed to fetch {name}: {e}", file=sys.stderr)
        return ""

    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(text)

    return text


# -- Parsers -------------------------------------------------------------------

MKAISER_TYPE_MAP = {
    "uint16": "U16",
    "int16": "S16",
    "uint32": "U32",
    "int32": "S32",
    "string": "UTF-8",
}

MKAISER_INPUT_MAP = {
    "input": "read",
    "holding": "hold",
}


def _yaml_secret_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> str:
    return f"!secret({node.value})"


def _make_mkaiser_loader() -> type[yaml.SafeLoader]:
    loader = type("MkaiserLoader", (yaml.SafeLoader,), {})
    loader.add_constructor("!secret", _yaml_secret_constructor)
    return loader


def parse_mkaiser(text: str) -> list[NormalizedRegister]:
    if not text:
        return []

    data = yaml.load(text, Loader=_make_mkaiser_loader())
    sensors = data.get("modbus", [{}])[0].get("sensors", [])
    result: list[NormalizedRegister] = []

    for s in sensors:
        if "address" not in s or "input_type" not in s:
            continue

        raw_type = s.get("data_type", "uint16")
        data_type = MKAISER_TYPE_MAP.get(raw_type, raw_type.upper())
        reg_type = MKAISER_INPUT_MAP.get(s["input_type"], s["input_type"])

        result.append(NormalizedRegister(
            name=s.get("unique_id", s.get("name", "unknown")),
            address=s["address"] + 1,  # 0-based → 1-based
            type=reg_type,
            data_type=data_type,
            scale=s.get("scale"),
            unit=s.get("unit_of_measurement"),
            source="mkaiser",
        ))

    return result


def parse_ha_sungrow(text: str) -> list[NormalizedRegister]:
    if not text:
        return []

    data = yaml.safe_load(text)
    result: list[NormalizedRegister] = []

    for section, reg_type in [("read", "read"), ("hold", "hold")]:
        for entry in data.get(section, []):
            if "address" not in entry or "data_type" not in entry:
                continue

            raw_dt = entry["data_type"]
            base_dt = raw_dt.split("[")[0] if "[" in str(raw_dt) else str(raw_dt)

            result.append(NormalizedRegister(
                name=entry.get("name", "unknown"),
                address=entry["address"],
                type=reg_type,
                data_type=base_dt,
                scale=entry.get("accuracy") or entry.get("scale"),
                unit=entry.get("unit_of_measurement"),
                source="ha-sungrow",
            ))

    return result


def parse_sungather(text: str) -> list[NormalizedRegister]:
    if not text:
        return []

    data = yaml.safe_load(text)
    result: list[NormalizedRegister] = []

    for block in data.get("registers", []):
        for section, reg_type in [("read", "read"), ("hold", "hold")]:
            entries = block.get(section)
            if not entries or not isinstance(entries, list):
                continue
            for entry in entries:
                if "name" not in entry or "address" not in entry:
                    continue

                raw_dt = str(entry.get("datatype", "U16"))
                base_dt = raw_dt.split("[")[0] if "[" in raw_dt else raw_dt

                result.append(NormalizedRegister(
                    name=entry["name"],
                    address=entry["address"],
                    type=reg_type,
                    data_type=base_dt,
                    scale=entry.get("accuracy"),
                    unit=entry.get("unit"),
                    source="sungather",
                ))

    return result


PARSERS: dict[str, callable] = {
    "mkaiser": parse_mkaiser,
    "ha-sungrow": parse_ha_sungrow,
    "sungather": parse_sungather,
}


# -- Our catalog ---------------------------------------------------------------

def load_ours() -> list[NormalizedRegister]:
    catalog_path = Path(__file__).parent / "registers-sungrow.json"
    data = json.loads(catalog_path.read_text())
    result: list[NormalizedRegister] = []

    for section, reg_type in [("read", "read"), ("hold", "hold")]:
        for entry in data.get(section, []):
            if "address" not in entry:
                continue

            raw_dt = entry.get("data_type", "U16")
            base_dt = raw_dt.split("[")[0] if "[" in str(raw_dt) else str(raw_dt)

            result.append(NormalizedRegister(
                name=entry["name"],
                address=entry["address"],
                type=reg_type,
                data_type=base_dt,
                scale=entry.get("accuracy") or entry.get("scale"),
                unit=entry.get("unit_of_measurement"),
                source="sungrowlib",
            ))

    return result


# -- Comparison ----------------------------------------------------------------

def compare(ours: list[NormalizedRegister], theirs: list[NormalizedRegister], source: str) -> ComparisonResult:
    ours_by_key = {(r.address, r.type): r for r in ours}
    theirs_by_key = {(r.address, r.type): r for r in theirs}

    matched = 0
    differences: list[Difference] = []
    missing_from_ours: list[NormalizedRegister] = []

    for key, their_reg in sorted(theirs_by_key.items()):
        our_reg = ours_by_key.get(key)
        if our_reg is None:
            missing_from_ours.append(their_reg)
            continue

        matched += 1

        if our_reg.data_type != their_reg.data_type:
            differences.append(Difference(
                address=key[0], type=key[1],
                ours_name=our_reg.name, theirs_name=their_reg.name,
                field="data_type", ours_value=our_reg.data_type, theirs_value=their_reg.data_type,
            ))

        if our_reg.scale != their_reg.scale and not (our_reg.scale is None and their_reg.scale is None):
            differences.append(Difference(
                address=key[0], type=key[1],
                ours_name=our_reg.name, theirs_name=their_reg.name,
                field="scale", ours_value=str(our_reg.scale), theirs_value=str(their_reg.scale),
            ))

        if our_reg.unit != their_reg.unit and not (our_reg.unit is None and their_reg.unit is None):
            differences.append(Difference(
                address=key[0], type=key[1],
                ours_name=our_reg.name, theirs_name=their_reg.name,
                field="unit", ours_value=str(our_reg.unit), theirs_value=str(their_reg.unit),
            ))

    unique_to_ours = sum(1 for key in ours_by_key if key not in theirs_by_key)

    return ComparisonResult(
        source=source,
        ours_count=len(ours),
        theirs_count=len(theirs),
        matched=matched,
        missing_from_ours=missing_from_ours,
        unique_to_ours=unique_to_ours,
        differences=differences,
    )


# -- Output --------------------------------------------------------------------

def print_report(results: list[ComparisonResult]) -> None:
    print("=" * 78)
    print("  Sungrow Register Catalog Comparison")
    print("=" * 78)

    # Summary table
    print(f"\n{'Source':<15} {'Registers':>10} {'Matched':>10} {'Missing':>10} {'Unique':>10}")
    print("-" * 55)
    for r in results:
        print(f"{'sungrowlib':<15} {r.ours_count:>10}")
        break
    for r in results:
        print(f"{r.source:<15} {r.theirs_count:>10} {r.matched:>10} {len(r.missing_from_ours):>10} {r.unique_to_ours:>10}")

    # Missing from ours (most actionable)
    for r in results:
        if not r.missing_from_ours:
            continue
        print(f"\n{'─' * 78}")
        print(f"  Missing from sungrowlib (found in {r.source}): {len(r.missing_from_ours)}")
        print(f"{'─' * 78}")
        for reg in sorted(r.missing_from_ours, key=lambda x: (x.type, x.address)):
            parts = [f"  {reg.type:4s} @{reg.address:<6d} {reg.name:<40s} {reg.data_type}"]
            if reg.scale is not None:
                parts.append(f" ×{reg.scale}")
            if reg.unit:
                parts.append(f" [{reg.unit}]")
            print("".join(parts))

    # Metadata differences
    for r in results:
        if not r.differences:
            continue
        print(f"\n{'─' * 78}")
        print(f"  Metadata differences with {r.source}: {len(r.differences)}")
        print(f"{'─' * 78}")
        for d in sorted(r.differences, key=lambda x: (x.type, x.address, x.field)):
            print(f"  {d.type:4s} @{d.address:<6d} {d.ours_name:<30s} {d.field}: {d.ours_value} → {d.theirs_value} ({d.theirs_name})")


def print_json(results: list[ComparisonResult]) -> None:
    output = []
    for r in results:
        output.append({
            "source": r.source,
            "ours_count": r.ours_count,
            "theirs_count": r.theirs_count,
            "matched": r.matched,
            "unique_to_ours": r.unique_to_ours,
            "missing_from_ours": [asdict(reg) for reg in r.missing_from_ours],
            "differences": [asdict(d) for d in r.differences],
        })
    json.dump(output, sys.stdout, indent=2)
    print()


# -- Main ----------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Compare sungrowlib register catalog against external catalogs")
    parser.add_argument("--source", choices=list(SOURCES.keys()), help="Compare against a specific source only")
    parser.add_argument("--format", choices=["pretty", "json"], default="pretty")
    parser.add_argument("--cache", action="store_true", help="Cache fetched catalogs in /tmp")
    args = parser.parse_args()

    sources = {args.source: SOURCES[args.source]} if args.source else SOURCES
    ours = load_ours()

    results: list[ComparisonResult] = []
    for name, url in sources.items():
        if args.format == "pretty":
            print(f"Fetching {name}...", file=sys.stderr)
        text = fetch_source(name, url, use_cache=args.cache)
        if not text:
            continue
        theirs = PARSERS[name](text)
        results.append(compare(ours, theirs, name))

    if args.format == "json":
        print_json(results)
    else:
        print_report(results)


if __name__ == "__main__":
    main()
