# Sungrowlib Conformance Tests

Language-agnostic test suite that validates any sungrowlib implementation against a set of YAML scenarios. Tests run the lib's CLI against a Modbus TCP simulator and compare JSON output to expected values.

## Architecture

```
YAML Scenario ──► Python Runner
                    ├── starts Modbus TCP Simulator (Python, asyncio)
                    ├── runs lib CLI (any language) with --format json
                    └── compares JSON output to YAML expectations
```

Each scenario defines:
- **Simulated inverter registers** (input + holding) with optional fixture references
- **Expected results**: info fields, active groups, decoded register values, Modbus call efficiency

## Requirements

- Python 3.12+ with `pyyaml`
- A built sungrowlib CLI (any language, must support `--format json`)

```bash
# Setup
python3 -m venv /tmp/sungrow-conformance-venv
/tmp/sungrow-conformance-venv/bin/pip install pyyaml

# Build TS CLI
npm run build
```

## Running

```bash
# All scenarios
/tmp/sungrow-conformance-venv/bin/python conformance/runner/run.py \
  --scenarios conformance/scenarios/ \
  --cli "node dist/cli/main.js" \
  --verbose

# Filter by tags
/tmp/sungrow-conformance-venv/bin/python conformance/runner/run.py \
  --scenarios conformance/scenarios/ \
  --cli "node dist/cli/main.js" \
  --tags detect,read

# Other language implementation
/tmp/sungrow-conformance-venv/bin/python conformance/runner/run.py \
  --scenarios conformance/scenarios/ \
  --cli ./target/release/sungrowlib
```

## Directory Structure

```
conformance/
  fixtures/                      # Reusable register sets from real inverter dumps
    sh8rt20-master-daytime.yaml
    sh8rt20-master-night.yaml
    sh8rt20-slave-daytime.yaml
    sh8rt20-standalone.yaml
  scenarios/                     # Test scenarios
    detect/                      # Model detection, topology, groups
    read/                        # Register decoding, computed values, efficiency
    system/                      # Multi-inverter (master/slave) topology
    error/                       # Fault injection, graceful degradation
  simulator/                     # Modbus TCP simulator (asyncio, no pymodbus)
  runner/                        # Test orchestrator
```

## Scenarios (17)

| Scenario | Tags | What it tests |
|----------|------|---------------|
| **detect/** | | |
| sh8rt20-master | detect, battery | Master detection, all groups, battery + meter |
| sh8rt20-slave | detect | Slave detection, no battery/meter |
| sh8rt20-standalone | detect | Standalone mode (M/S register = 0x55) |
| slave-id-probing | detect | Slave ID auto-probe (ID 1 fails, ID 2 responds) |
| **read/** | | |
| full-master-battery | read, decode | Full decode: S16, U32 LE, scale, computed registers |
| slave-read-registers | read, slave | Slave-specific registers, MPPT power |
| night-reading | read, groups | Night: MPPT current = 0, group detection |
| computed-timestamp | read, computed | 6 RTC holding registers → timestamp string |
| computed-mppt-power | read, computed | V × I for MPPT 1-4 |
| model-override-s16 | read, decode | SH8.0RT-20: load/export S32 → S16 override |
| unsupported-sentinels | read, decode | 0xFFFF / 0x7FFF → absent (unsupported) |
| block-coalescing | read, efficiency | Block combining, max Modbus calls, no single reads |
| **system/** | | |
| master-slave-pair | system | Master + slave discovery, read + slave_read |
| slave-first-in-hosts | system | Slave listed first in hosts → master still found |
| multiple-masters-error | system, error | Error when two hosts are both master |
| unreachable-host-skip | system, error | Unreachable host skipped, rest works |
| **error/** | | |
| unsupported-register-block | error | Modbus exception on one block, other blocks OK |

## YAML Scenario Format

### Register data

```yaml
inverters:
  - id: master
    slave_id: 1
    fixture: sh8rt20-master-daytime    # load base registers from fixture
    input:                             # override/add registers
      13008: 402                       # U16 decimal
      5000: 0xE12                      # U16 hex
      13003: [255, 0]                  # U32 LE (two words)
      4990: { utf8: "A2350415770" }    # String → packed into 16-bit words
    holding:
      33500: 0xAA
    faults:                            # Modbus error injection
      - range: [5011, 5020]
        error: illegal_data_address
```

### Expectations

```yaml
expect:
  info:
    model: "SH8.0RT-20"
    connection_mode: master
    has_battery: true

  active_groups:
    has_battery: true
    is_master: true

  read:
    load_power: { value: 402, unit: W }                  # exact match
    total_pv_generation: { approx: 15788.9, tolerance: 1.0 }  # approximate
    timestamp: { matches: "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}" }  # regex
    mppt_1_power: absent                                 # must not appear
    battery_soc: any                                     # exists, value ignored
    meter_active_power: { supported: false }             # unsupported flag

  modbus_calls:
    total_calls: { max: 50 }
    input_calls: { max: 35 }
    no_single_reads: [13008, 13010]    # must be read in blocks, not individually

  system:
    has_slaves: true
    slave_count: 1
    error: "multiple masters"          # expected error message (stderr)
```

## CLI Contract

Any conforming implementation must support these commands with `--format json`:

| Command | Output | Used by |
|---------|--------|---------|
| `info -H host:port` | `{ model, serialNumber, connectionMode, hasBattery, hasMeter, activeGroups, ... }` | detect, system scenarios |
| `read -H host:port` | `[{ name, address, type, level, value, unit, supported }, ...]` | read scenarios |
| `info -H host1:port -H host2:port` | Same as info + `slaveDetails: [{ host, slaveId, model }]` | system scenarios |
| `read -H host1:port -H host2:port` | Master register values | system read scenarios |

Multi-host (2+ `-H` flags) triggers system mode with automatic master/slave detection.

## Simulator

Custom Modbus TCP server using Python `asyncio` (no pymodbus dependency). Supports:
- FC 0x03 (Read Holding) and FC 0x04 (Read Input)
- Per-inverter TCP ports (base port + offset)
- Fault injection (Modbus exception responses for address ranges)
- Call logging (written to JSON on exit for efficiency assertions)
- Fixture loading with `utf8` and array expansion

## Adding a New Scenario

1. Create a YAML file in the appropriate `scenarios/` subdirectory
2. Define inverter registers (inline or via fixture reference)
3. Define expectations in the `expect:` section
4. Run the test suite to validate

## Implementing in a New Language

1. Implement the CLI with `info`, `read` commands and `--format json` output
2. Run the conformance suite against your CLI:
   ```bash
   python conformance/runner/run.py \
     --scenarios conformance/scenarios/ \
     --cli ./your-cli-binary
   ```
3. All 17 scenarios / 148 checks should pass
