#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""Compare the sungrowlib register catalog against external Sungrow register catalogs.

With --update: enrich registers-sungrow.json by adding source attribution and
missing metadata from external catalogs on perfect matches (address + type + data_type).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Callable
from urllib.request import urlopen
from urllib.error import URLError

import yaml  # pyright: ignore[reportMissingModuleSource]

SOURCES: dict[str, str] = {
    "mkaiser": "https://raw.githubusercontent.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/main/modbus_sungrow.yaml",
    "sungather": "https://raw.githubusercontent.com/bohdan-s/SunGather/main/SunGather/registers-sungrow.yaml",
}

REGISTRY_NAMES: dict[str, str] = {
    "mkaiser": "mkaiser",
    "sungather": "SunGather",
}

CACHE_DIR = Path("/tmp/sungrow-catalog-cache")
CATALOG_PATH = Path(__file__).parent / "registers-sungrow.json"

# -- ANSI colors (disabled when not writing to a terminal) ---------------------

_USE_COLOR = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


def _bold(t: str) -> str: return _c("1", t)
def _dim(t: str) -> str:  return _c("2", t)
def _red(t: str) -> str:  return _c("31", t)
def _green(t: str) -> str: return _c("32", t)
def _yellow(t: str) -> str: return _c("33", t)
def _cyan(t: str) -> str:  return _c("36", t)


# -- Dataclasses ---------------------------------------------------------------

@dataclass
class ExtraFields:
    decoded: dict[str, str] | None = None
    unsupported_value: int | None = None
    models: list[str] | None = None
    models_exclude: list[str] | None = None
    group: str | list[str] | None = None
    mask: int | None = None


@dataclass
class NormalizedRegister:
    name: str
    address: int  # always 1-based
    type: str  # 'read' or 'hold'
    data_type: str  # U16, S16, U32, S32, UTF-8
    scale: float | None = None
    unit: str | None = None
    source: str = ""
    source_line: int | None = None
    extra: ExtraFields = field(default_factory=ExtraFields)


@dataclass
class Difference:
    address: int
    type: str
    ours_name: str
    theirs_name: str
    field: str
    ours_value: str
    theirs_value: str
    source_line: int | None = None


@dataclass
class ComparisonResult:
    source: str
    ours_count: int
    theirs_count: int
    matched: int
    missing_from_ours: list[NormalizedRegister]
    unique_to_ours: int
    differences: list[Difference]


# -- GitHub URL helpers --------------------------------------------------------

def _raw_to_github_file_url(raw_url: str) -> str:
    """Convert a raw.githubusercontent.com URL to the GitHub blob viewer URL."""
    url = raw_url.replace("raw.githubusercontent.com/", "github.com/", 1)
    # ['https:', '', 'github.com', owner, repo, branch, *path]
    parts = url.split("/")
    parts.insert(5, "blob")
    return "/".join(parts)


def _github_line_url(source: str, line: int) -> str:
    return f"{_raw_to_github_file_url(SOURCES[source])}#L{line}"


def _reg_github_url(reg: NormalizedRegister) -> str | None:
    if reg.source not in SOURCES or reg.source_line is None:
        return None
    return _github_line_url(reg.source, reg.source_line)


def _diff_github_url(diff: Difference, source: str) -> str | None:
    if source not in SOURCES or diff.source_line is None:
        return None
    return _github_line_url(source, diff.source_line)


# -- YAML node helpers (for line-number extraction via yaml.compose) -----------

def _node_get(node: Any, key: str) -> Any:
    if not isinstance(node, yaml.MappingNode):
        return None
    for k, v in node.value:
        if isinstance(k, yaml.ScalarNode) and k.value == key:
            return v
    return None


def _node_scalar(node: Any, key: str) -> str | None:
    child = _node_get(node, key)
    return child.value if isinstance(child, yaml.ScalarNode) else None


def _node_seq(node: Any) -> list[Any]:
    return node.value if isinstance(node, yaml.SequenceNode) else []


# -- Fetching ------------------------------------------------------------------

def fetch_source(name: str, url: str, *, use_cache: bool = False) -> str:
    cache_file = CACHE_DIR / f"{name}.yaml"

    if use_cache and cache_file.exists():
        return cache_file.read_text()

    try:
        with urlopen(url, timeout=15) as resp:
            raw: bytes = resp.read()
        text = raw.decode()
    except URLError as e:
        print(f"  warning: failed to fetch {name}: {e}", file=sys.stderr)
        return ""

    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _ = cache_file.write_text(text)

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


def _yaml_secret_constructor(_loader: Any, node: Any) -> str:
    return f"!secret({node.value})"


def _make_mkaiser_loader() -> type:
    loader = type("MkaiserLoader", (yaml.SafeLoader,), {})
    loader.add_constructor("!secret", _yaml_secret_constructor)
    return loader  # type: ignore[return-value]


def _mkaiser_line_index(text: str, loader_class: type) -> dict[tuple[int, str], int]:
    try:
        doc = yaml.compose(text, Loader=loader_class)
        modbus = _node_seq(_node_get(doc, "modbus"))
        if not modbus:
            return {}
        sensors = _node_seq(_node_get(modbus[0], "sensors"))
        result: dict[tuple[int, str], int] = {}
        for item in sensors:
            addr_str = _node_scalar(item, "address")
            input_type = _node_scalar(item, "input_type")
            if addr_str is None or input_type is None:
                continue
            addr = int(addr_str) + 1  # 0-based → 1-based
            reg_type = MKAISER_INPUT_MAP.get(input_type, input_type)
            result[(addr, reg_type)] = item.start_mark.line + 1
        return result
    except Exception:
        return {}


def parse_mkaiser(text: str) -> list[NormalizedRegister]:
    if not text:
        return []

    loader_class = _make_mkaiser_loader()
    line_index = _mkaiser_line_index(text, loader_class)
    data: dict[str, Any] = yaml.load(text, Loader=loader_class) or {}
    sensors: list[Any] = data.get("modbus", [{}])[0].get("sensors", [])
    result: list[NormalizedRegister] = []

    for s in sensors:
        if "address" not in s or "input_type" not in s:
            continue

        raw_type: str = str(s.get("data_type", "uint16"))
        data_type: str = MKAISER_TYPE_MAP.get(raw_type, raw_type.upper())
        reg_type: str = MKAISER_INPUT_MAP.get(str(s["input_type"]), str(s["input_type"]))
        addr: int = int(s["address"]) + 1  # 0-based → 1-based

        extra = ExtraFields()
        if "nan_value" in s:
            extra.unsupported_value = int(s["nan_value"])

        result.append(NormalizedRegister(
            name=str(s.get("unique_id", s.get("name", "unknown"))),
            address=addr,
            type=reg_type,
            data_type=data_type,
            scale=s.get("scale"),
            unit=s.get("unit_of_measurement"),
            source="mkaiser",
            source_line=line_index.get((addr, reg_type)),
            extra=extra,
        ))

    return result


def _convert_decoded(raw: dict[Any, Any]) -> dict[str, str]:
    return {str(int(str(k), 0)): str(v) for k, v in raw.items()}


def _convert_datarange(datarange: list[dict[Any, Any]]) -> dict[str, str]:
    result = {}
    for item in datarange:
        if "response" in item and "value" in item:
            result[str(int(str(item["response"]), 0))] = str(item["value"])
    return result


def _sungather_line_index(text: str) -> dict[tuple[int, str], int]:
    try:
        doc = yaml.compose(text, Loader=yaml.SafeLoader)
        result: dict[tuple[int, str], int] = {}
        for block in _node_seq(_node_get(doc, "registers")):
            for section, reg_type in [("read", "read"), ("hold", "hold")]:
                for item in _node_seq(_node_get(block, section)):
                    addr_str = _node_scalar(item, "address")
                    if addr_str is None:
                        continue
                    result[(int(addr_str), reg_type)] = item.start_mark.line + 1
        return result
    except Exception:
        return {}


def parse_sungather(text: str) -> list[NormalizedRegister]:
    if not text:
        return []

    line_index = _sungather_line_index(text)
    data: dict[str, Any] = yaml.safe_load(text) or {}
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
                addr: int = int(entry["address"])

                extra = ExtraFields()
                if "datarange" in entry:
                    extra.decoded = _convert_datarange(entry["datarange"])
                if "mask" in entry:
                    extra.mask = entry["mask"]

                result.append(NormalizedRegister(
                    name=str(entry["name"]),
                    address=addr,
                    type=reg_type,
                    data_type=base_dt,
                    scale=entry.get("accuracy"),
                    unit=entry.get("unit"),
                    source="sungather",
                    source_line=line_index.get((addr, reg_type)),
                    extra=extra,
                ))

    return result


PARSERS: dict[str, Callable[[str], list[NormalizedRegister]]] = {
    "mkaiser": parse_mkaiser,
    "sungather": parse_sungather,
}


# -- Our catalog ---------------------------------------------------------------

def load_ours() -> list[NormalizedRegister]:
    data: dict[str, Any] = json.loads(CATALOG_PATH.read_text())
    result: list[NormalizedRegister] = []

    for section, reg_type in [("read", "read"), ("hold", "hold")]:
        for entry in data.get(section, []):
            if "address" not in entry:
                continue

            raw_dt: str = str(entry.get("data_type", "U16"))
            base_dt = raw_dt.split("[")[0] if "[" in raw_dt else raw_dt

            result.append(NormalizedRegister(
                name=str(entry["name"]),
                address=int(entry["address"]),
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
                source_line=their_reg.source_line,
            ))

        scales_differ = our_reg.scale != their_reg.scale
        scales_equivalent = our_reg.scale is None and their_reg.scale == 1
        if scales_differ and not scales_equivalent:
            differences.append(Difference(
                address=key[0], type=key[1],
                ours_name=our_reg.name, theirs_name=their_reg.name,
                field="scale", ours_value=str(our_reg.scale), theirs_value=str(their_reg.scale),
                source_line=their_reg.source_line,
            ))

        if (our_reg.unit or "").lower() != (their_reg.unit or "").lower() and not (our_reg.unit is None and their_reg.unit is None):
            differences.append(Difference(
                address=key[0], type=key[1],
                ours_name=our_reg.name, theirs_name=their_reg.name,
                field="unit", ours_value=str(our_reg.unit), theirs_value=str(their_reg.unit),
                source_line=their_reg.source_line,
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


# -- Update catalog ------------------------------------------------------------

def update_catalog(all_theirs: dict[str, list[NormalizedRegister]]) -> None:
    data: dict[str, Any] = json.loads(CATALOG_PATH.read_text())

    catalog_index: dict[tuple[int, str], dict[str, Any]] = {}
    for section in ("read", "hold"):
        for entry in data[section]:
            if "address" in entry:
                catalog_index[(entry["address"], section)] = entry

    stats: dict[str, int] = {"other_registries": 0, "decoded": 0, "unsupported_value": 0,
                              "models": 0, "models_unsupported": 0, "group": 0, "mask": 0}

    for source_name, regs in all_theirs.items():
        theirs_by_key = {(r.address, r.type): r for r in regs}

        for key, their_reg in theirs_by_key.items():
            our_entry = catalog_index.get(key)
            if our_entry is None:
                continue

            our_dt: str = str(our_entry.get("data_type", "U16"))
            our_base_dt = our_dt.split("[")[0] if "[" in our_dt else our_dt

            # Build other_registries entry with direct line-anchored link
            link = (
                _github_line_url(source_name, their_reg.source_line)
                if their_reg.source_line is not None
                else _raw_to_github_file_url(SOURCES[source_name])
            )
            other_registries: dict[str, Any] = our_entry.setdefault("other_registries", {})
            if source_name not in other_registries:
                stats["other_registries"] += 1
            registry_entry: dict[str, Any] = {"name": REGISTRY_NAMES[source_name], "link": link}

            # Record known differences as free text
            diffs: list[str] = []
            if our_base_dt != their_reg.data_type:
                diffs.append(f"data_type {their_reg.data_type}")
            our_scale = our_entry.get("accuracy") or our_entry.get("scale")
            if their_reg.scale is not None and their_reg.scale != 1 and their_reg.scale != our_scale:
                diffs.append(f"scale {their_reg.scale}")
            their_unit = their_reg.unit
            our_unit = our_entry.get("unit_of_measurement")
            if their_unit and their_unit.lower() != (our_unit or "").lower():
                diffs.append(f"unit {their_unit}")
            if diffs:
                registry_entry["differences"] = ", ".join(diffs)

            other_registries[source_name] = registry_entry

            # Remove community handle from source (now expressed in other_registries)
            if "source" in our_entry and source_name in our_entry["source"]:
                our_entry["source"].remove(source_name)
                if not our_entry["source"]:
                    del our_entry["source"]

            ex = their_reg.extra

            if ex.decoded and "decoded" not in our_entry:
                our_entry["decoded"] = ex.decoded
                stats["decoded"] += 1

            if ex.unsupported_value is not None and "unsupported_value" not in our_entry:
                our_entry["unsupported_value"] = ex.unsupported_value
                stats["unsupported_value"] += 1

            if ex.models and "models" not in our_entry:
                our_entry["models"] = ex.models
                stats["models"] += 1

            if ex.models_exclude and "models_unsupported" not in our_entry:
                our_entry["models_unsupported"] = ex.models_exclude
                stats["models_unsupported"] += 1

            if ex.group is not None and "group" not in our_entry:
                our_entry["group"] = ex.group
                stats["group"] += 1

            if ex.mask is not None and "mask" not in our_entry:
                our_entry["mask"] = ex.mask
                stats["mask"] += 1

    for section in ("read", "hold"):
        data[section].sort(key=lambda e: (e.get("address") is None, e.get("address", 0)))

    with open(CATALOG_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"\nUpdated {CATALOG_PATH.name}:", file=sys.stderr)
    for k, v in stats.items():
        if v:
            print(f"  {k}: +{v}", file=sys.stderr)


# -- Output: pretty ------------------------------------------------------------

def _pad(text: str, width: int) -> str:
    """Left-justify text to width without counting ANSI escape codes."""
    return text + " " * max(0, width - len(text))


def print_report(results: list[ComparisonResult]) -> None:
    W = 78
    print(_bold(_cyan("═" * W)))
    print(_bold(_cyan("  Sungrow Register Catalog Comparison")))
    print(_bold(_cyan("═" * W)))

    hdr = f"  {'Source':<16} {'Regs':>6}  {'Matched':>8}  {'Missing':>8}  {'Diff':>8}  {'Unique':>8}"
    print()
    print(_dim(hdr))
    print(_dim("  " + "─" * (W - 2)))

    for r in results[:1]:
        print(f"  {_bold(_pad('sungrowlib', 16))} {r.ours_count:>6}")
    for r in results:
        missing_n = len(r.missing_from_ours)
        diff_n    = len(r.differences)
        missing_s = _yellow(f"{missing_n:>8}") if missing_n else _dim(f"{'—':>8}")
        diff_s    = _red(f"{diff_n:>8}") if diff_n else _dim(f"{'—':>8}")
        print(f"  {_cyan(_pad(r.source, 16))} {r.theirs_count:>6}  {_green(f'{r.matched:>8}')}  {missing_s}  {diff_s}  {_dim(f'{r.unique_to_ours:>8}')}")

    for r in results:
        if not r.missing_from_ours:
            continue
        print()
        print("─" * W)
        print(f"  {_yellow('Missing from sungrowlib')}  ·  {_cyan(r.source)}  ({_yellow(str(len(r.missing_from_ours)))})")
        print("─" * W)
        for reg in sorted(r.missing_from_ours, key=lambda x: (x.type, x.address)):
            meta = ""
            if reg.scale is not None:
                meta += f"  ×{reg.scale}"
            if reg.unit:
                meta += f"  [{reg.unit}]"
            print(f"  {_dim(reg.type.ljust(4))}  {_dim('@')}{reg.address:<6d}  {reg.name:<40s}  {reg.data_type}{meta}")

    for r in results:
        if not r.differences:
            continue
        print()
        print("─" * W)
        print(f"  {_red('Differences')}  ·  {_cyan(r.source)}  ({_red(str(len(r.differences)))})")
        print("─" * W)
        for d in sorted(r.differences, key=lambda x: (x.type, x.address, x.field)):
            theirs_note = f"  {_dim('(' + d.theirs_name + ')')}" if d.theirs_name != d.ours_name else ""
            print(f"  {_dim(d.type.ljust(4))}  {_dim('@')}{d.address:<6d}  {d.ours_name:<32s}  {d.field}: {d.ours_value} {_red('→')} {d.theirs_value}{theirs_note}")


# -- Output: markdown ----------------------------------------------------------

def print_markdown(results: list[ComparisonResult]) -> None:
    print("# Sungrow Register Catalog Comparison\n")

    # Summary table
    print("| Source | Registers | Matched | Missing | Unique |")
    print("|--------|----------:|--------:|--------:|-------:|")
    if results:
        print(f"| **sungrowlib** | {results[0].ours_count} | — | — | — |")
    for r in results:
        file_url = _raw_to_github_file_url(SOURCES[r.source])
        print(f"| [{r.source}]({file_url}) | {r.theirs_count} | {r.matched} | {len(r.missing_from_ours)} | {r.unique_to_ours} |")

    for r in results:
        if not r.missing_from_ours and not r.differences:
            continue

        print(f"\n## {r.source}\n")

        if r.missing_from_ours:
            print(f"### Missing from sungrowlib ({len(r.missing_from_ours)})\n")
            print("| Address | Type | Name | Data Type | Scale | Unit |")
            print("|--------:|------|------|-----------|------:|------|")
            for reg in sorted(r.missing_from_ours, key=lambda x: (x.type, x.address)):
                url = _reg_github_url(reg)
                addr_cell = f"[{reg.address}]({url})" if url else str(reg.address)
                scale_cell = str(reg.scale) if reg.scale is not None else ""
                unit_cell = reg.unit or ""
                print(f"| {addr_cell} | {reg.type} | {reg.name} | {reg.data_type} | {scale_cell} | {unit_cell} |")

        if r.differences:
            print(f"\n### Differences ({len(r.differences)})\n")
            print("| Address | Type | Register | Field | Ours | Theirs |")
            print("|--------:|------|----------|-------|------|--------|")
            for d in sorted(r.differences, key=lambda x: (x.type, x.address, x.field)):
                url = _diff_github_url(d, r.source)
                addr_cell = f"[{d.address}]({url})" if url else str(d.address)
                name_cell = d.ours_name if d.ours_name == d.theirs_name else f"{d.ours_name} / {d.theirs_name}"
                print(f"| {addr_cell} | {d.type} | {name_cell} | {d.field} | {d.ours_value} | {d.theirs_value} |")


# -- Output: json --------------------------------------------------------------

def print_json(results: list[ComparisonResult]) -> None:
    output = []
    for r in results:
        missing: list[dict[str, Any]] = []
        for reg in r.missing_from_ours:
            entry = {k: v for k, v in asdict(reg).items() if k not in ("extra", "source_line")}
            url = _reg_github_url(reg)
            if url:
                entry["source_url"] = url
            missing.append(entry)

        diffs: list[dict[str, Any]] = []
        for d in r.differences:
            entry = {k: v for k, v in asdict(d).items() if k != "source_line"}
            url = _diff_github_url(d, r.source)
            if url:
                entry["source_url"] = url
            diffs.append(entry)

        output.append({
            "source": r.source,
            "source_url": _raw_to_github_file_url(SOURCES[r.source]),
            "ours_count": r.ours_count,
            "theirs_count": r.theirs_count,
            "matched": r.matched,
            "unique_to_ours": r.unique_to_ours,
            "missing_from_ours": missing,
            "differences": diffs,
        })
    json.dump(output, sys.stdout, indent=2)
    print()


# -- Main ----------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Compare sungrowlib register catalog against external catalogs")
    parser.add_argument("--source", choices=list(SOURCES.keys()), help="Compare against a specific source only")
    parser.add_argument("--format", choices=["pretty", "markdown", "json"], default="pretty")
    parser.add_argument("--cache", action="store_true", help="Cache fetched catalogs in /tmp")
    parser.add_argument("--update", action="store_true", help="Write source attribution and missing fields into registers-sungrow.json")
    args = parser.parse_args()

    sources = {args.source: SOURCES[args.source]} if args.source else SOURCES
    ours = load_ours()

    results: list[ComparisonResult] = []
    all_theirs: dict[str, list[NormalizedRegister]] = {}
    for name, url in sources.items():
        if args.format == "pretty":
            print(f"Fetching {name}...", file=sys.stderr)
        text = fetch_source(name, url, use_cache=args.cache)
        if not text:
            continue
        theirs = PARSERS[name](text)
        all_theirs[name] = theirs
        results.append(compare(ours, theirs, name))

    if args.format == "json":
        print_json(results)
    elif args.format == "markdown":
        print_markdown(results)
    else:
        print_report(results)

    if args.update:
        update_catalog(all_theirs)


if __name__ == "__main__":
    main()
