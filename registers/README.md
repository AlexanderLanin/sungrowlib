# Sungrow Register Catalog

Machine-readable JSON database of 311 Modbus registers for Sungrow SH and SG series solar inverters. Originally converted from [homeassistant-sungrow](https://github.com/mkanet/homeassistant-sungrow) and audited against the official Sungrow communication protocols (V1.0.20–V1.1.9).

Use this file directly in any language or tool — no sungrowlib dependency required.

## File

[`registers-sungrow.json`](registers-sungrow.json) — 229 input registers, 82 holding registers.

## Schema

Top-level structure:

```json
{
  "read": [ ... ],   // input registers (FC 0x04)
  "hold": [ ... ]    // holding registers (FC 0x03)
}
```

Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique register name (e.g. `total_dc_power`, `battery_soc`) |
| `address` | number | yes | 1-based Sungrow register address |
| `data_type` | string | yes | `U16`, `S16`, `U32`, `S32`, `UTF-8`, or array form like `U16[96]`, `UTF-8[15]` |
| `level` | number | yes | Detail level 1–5 (see below) |
| `accuracy` | number | | Scale factor (e.g. `0.1` means raw value 231 = 23.1) |
| `scale` | number | | Alias for `accuracy` |
| `unit_of_measurement` | string | | Physical unit: `W`, `kWh`, `V`, `A`, `°C`, `%`, `h`, `VA`, `var`, `Hz`, `Ω`, `MΩ` |
| `description` | string | | Explanation, often referencing official Sungrow protocol docs |
| `group` | string \| string[] | | Feature group(s) this register belongs to |
| `indicator` | string | | If present, this register detects whether the named group is active |
| `models` | string[] | | fnmatch glob patterns — register only applies to matching models |
| `models_exclude` | string[] | | fnmatch glob patterns — register excluded from matching models |
| `decoded` | object | | Map of raw value → human-readable string (e.g. `{"0": "Stop", "32768": "Run"}`) |
| `mask` | number | | Bitmask for boolean extraction (e.g. `1` = bit 0) |
| `unsupported_value` | number \| null \| `"None"` | | Raw value that means "not supported" (e.g. `0xFFFF`) |

### Detail Levels

| Level | Name | What's included |
|-------|------|-----------------|
| 1 | Connection | Model, serial number, firmware |
| 2 | Energy | PV power, battery SOC, grid, consumption |
| 3 | Extended | Temperatures, voltages, currents |
| 4 | Detail | MPPT details, daily/total energy counters |
| 5 | Debug | Alarm codes, internal states, RTC clock |

### Feature Groups

Registers can belong to feature groups. A register with `"group": "has_battery"` should only be read when the inverter has a battery. Groups are detected at connect time by reading indicator registers.

| Group | Indicator Register | Meaning |
|-------|-------------------|---------|
| `has_battery` | `battery_capacity` | Inverter has a battery |
| `has_meter` | `meter_active_power` | Smart meter connected |
| `is_master` | `total_import_energy` | Inverter is master in multi-inverter setup |
| `direct_lan` | `array_insulation_resistance` | Connected via direct LAN (not WiNet dongle) |
| `mppt2`–`mppt12` | `mppt_N_current` | MPPT string N is present (unreliable at night) |

Registers with multiple groups (e.g. `["mppt4", "direct_lan"]`) require **all** listed groups to be active.

### Model Filtering

The `models` and `models_exclude` fields use fnmatch-style glob patterns:

- `SH*RT*` — matches all SH hybrid RT models
- `SG*KTL-M*` — matches SG string inverters with meter

### Decoded Maps

Some registers map raw values to human-readable strings:

```json
{
  "name": "device_type_code",
  "address": 5000,
  "data_type": "U16",
  "decoded": {
    "3602": "SH8.0RT-20",
    "3600": "SH5.0RT-20"
  }
}
```

### Bitmasks

Registers with `mask` extract a boolean from a shared status word:

```json
{
  "name": "state_power_generated_from_pv",
  "address": 13001,
  "data_type": "U16",
  "mask": 1
}
```

Result: `(raw_value & mask) !== 0`

## Modbus Conventions

- Addresses are **1-based** (Sungrow documentation convention)
- PDU address = address - 1
- Word order for 32-bit values: **little-endian** (low word at lower address)
- N/A sentinel values: `0xFFFF` (U16), `0x7FFF` (S16), `0xFFFFFFFF` (U32), `0x7FFFFFFF` (S32)

## Usage Examples

### Python

```python
import json
from pathlib import Path

catalog = json.loads(Path("registers-sungrow.json").read_text())

for reg in catalog["read"]:
    if reg.get("level", 5) <= 2:
        print(f"{reg['name']:40s} @{reg['address']}  {reg.get('unit_of_measurement', '')}")
```

### TypeScript / JavaScript

```typescript
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync('registers-sungrow.json', 'utf-8'));

for (const reg of catalog.read) {
  if ((reg.level ?? 5) <= 2) {
    console.log(`${reg.name.padEnd(40)} @${reg.address}  ${reg.unit_of_measurement ?? ''}`);
  }
}
```

### jq

```bash
# List all level 1-2 registers with units
jq '.read[] | select(.level <= 2) | "\(.name) @\(.address) \(.unit_of_measurement // "")"' registers-sungrow.json

# Count registers by group
jq '[.read[], .hold[]] | group_by(.group) | map({group: .[0].group, count: length})' registers-sungrow.json

# Find all battery-related registers
jq '[.read[], .hold[]] | map(select(.group == "has_battery" or (.group | type == "array" and contains(["has_battery"]))))' registers-sungrow.json
```

## Attribution

Register definitions originally sourced from [homeassistant-sungrow](https://github.com/mkanet/homeassistant-sungrow), then audited and corrected against the official Sungrow Residential Hybrid Inverter Communication Protocol documents (V1.0.20 through V1.1.9).

## License

MIT
