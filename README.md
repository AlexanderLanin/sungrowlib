# sungrowlib

TypeScript library and CLI for communicating with Sungrow solar inverters via Modbus TCP or HTTP/WebSocket (WiNet-S dongle).

## Features

- **Modbus TCP** — direct inverter connection on port 502
- **HTTP/WebSocket** — WiNet-S dongle protocol (port 8082 WebSocket auth + port 80 HTTP reads)
- **311 registers** — full SH/SG series register catalog with model-specific filtering
- **Master/Slave detection** — automatic multi-inverter topology discovery
- **Computed registers** — timestamp synthesis, MPPT power calculation
- **Signal state machine** — resolves zero-value ambiguity in batch queries
- **Retry and throttling** — configurable resilience for both transport types
- **Two-tier reconnect** — transport-level retry within reads + system-level auto-reconnect with exponential backoff
- **Connection state machine** — `idle` → `connecting` → `connected` → `reconnecting` → `disconnected` with callback
- **Typed errors** — `ConnectionError`, `TimeoutError`, `ModbusProtocolError`, `BusyError`, etc.
- **CLI tool** — explore registers, monitor live data, create dumps — no code required

## Installation

```bash
npm install sungrowlib
```

## CLI

The CLI lets you explore your inverter without writing code. After installation, run it via `npx`:

```bash
npx sungrowlib --help
```

Or set your inverter IP once to avoid repeating it:

```bash
export SUNGROW_HOST=192.168.1.100
```

### Commands

#### `catalog` — Browse registers offline

No connection required. Lists available registers with filtering.

```bash
npx sungrowlib catalog                        # all 311 registers
npx sungrowlib catalog --search power         # search by name
npx sungrowlib catalog --level 2              # only level 1-2
npx sungrowlib catalog --type hold            # only holding registers
npx sungrowlib catalog -f json                # JSON output
```

#### `info` — Show inverter info

Connects, detects model/serial/groups/topology, disconnects.

```bash
npx sungrowlib info -H 192.168.1.100
npx sungrowlib info -H 192.168.1.100 -f json
```

Example output:
```
Inverter Info
  Model       SH8.0RT-20
  Serial      A2350415770
  Slave ID    1
  Connection  standalone
  Battery     yes
  Meter       no

Active Groups
  has_battery  yes
  is_master    yes
  mppt2        yes
```

#### `read` — Read registers (one-shot)

```bash
npx sungrowlib read -H 192.168.1.100                                  # all registers
npx sungrowlib read -H 192.168.1.100 --level 3                        # level 1-3
npx sungrowlib read -H 192.168.1.100 -n total_dc_power,battery_soc  # specific registers
npx sungrowlib read -H 192.168.1.100 -l 2 --supported-only            # skip unsupported
npx sungrowlib read -H 192.168.1.100 -f csv                           # CSV output
```

#### `watch` — Monitor registers live

Reads repeatedly and refreshes the display.

```bash
npx sungrowlib watch -H 192.168.1.100                                 # every 5s, level 1-3
npx sungrowlib watch -H 192.168.1.100 -i 10                           # every 10s
npx sungrowlib watch -H 192.168.1.100 -n total_dc_power,battery_soc # specific registers
npx sungrowlib watch -H 192.168.1.100 -c 5                            # stop after 5 reads
npx sungrowlib watch -H 192.168.1.100 --append                        # don't clear screen
```

Press `Ctrl+C` to stop.

#### `dump` — Export raw data as JSON

Outputs a full register dump to stdout. Pipe to a file for sharing or debugging.

```bash
npx sungrowlib dump -H 192.168.1.100 > dump.json
npx sungrowlib dump -H 192.168.1.100 --include-values > full-dump.json
npx sungrowlib dump -H 192.168.1.100 -l 3 | jq '.rawWords | length'
```

### Global options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--host <ip>` | `-H` | `$SUNGROW_HOST` | Inverter IP address |
| `--port <n>` | `-p` | `502` | Modbus TCP port |
| `--slave-id <n>` | `-s` | auto-detect | Modbus slave ID |
| `--format <fmt>` | `-f` | `pretty` | Output: `pretty`, `json`, `csv` |
| `--verbose` | `-v` | | Enable debug logging |
| `--help` | `-h` | | Show help |

### Output formats

- **pretty** (default) — colored terminal output with aligned columns
- **json** — machine-readable JSON, ideal for piping to `jq`
- **csv** — comma-separated, for spreadsheets or further processing

## Library API

### Quick start

```typescript
import { SungrowInverter } from 'sungrowlib';

const inverter = new SungrowInverter({ host: '192.168.1.100' });
const info = await inverter.connect();

console.log(`Model: ${info.model}, Serial: ${info.serialNumber}`);
console.log(`Mode: ${info.connectionMode}, Slaves: ${info.slaveCount}`);

const result = await inverter.read({ maxLevel: 3 });
for (const [name, reg] of result.values) {
  if (reg.supported) {
    console.log(`${name}: ${reg.value} ${reg.unit ?? ''}`);
  }
}

await inverter.disconnect();
```

### `SungrowInverter`

Single-inverter connection over Modbus TCP.

```typescript
new SungrowInverter({
  host: '192.168.1.100',
  port: 502,            // default: 502
  slaveId: 1,           // default: auto-probe [1, 2]
  logger: console.log,  // optional debug logging
  onBlockRead: (trace) => console.log(trace),  // optional per-block trace hook
})
```

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `InverterInfo` | Detect model, groups, master/slave topology |
| `read(options?)` | `ReadResult` | Read registers |
| `readStream(options?)` | `AsyncGenerator<ReadResult>` | Streaming read, yields batches per Modbus block |
| `disconnect()` | `void` | Close connection |

**Read options:**

```typescript
await inverter.read({ names: ['total_dc_power', 'battery_soc'] });  // specific registers
await inverter.read({ maxLevel: 3 });                                  // by level (1-5)
await inverter.read({ names: [...], maxLevel: 3 });                    // union of both
await inverter.read();                                                 // all applicable registers
```

**Properties (after connect):**

| Property | Type | Description |
|----------|------|-------------|
| `info` | `InverterInfo` | Model, serial, topology, features |
| `model` | `string \| null` | Detected model name |
| `activeGroups` | `Record<string, boolean>` | Feature groups (battery, meter, MPPTs) |
| `lastRawWords` | `Record<number, number>` | Raw register values from last read |
| `lastValues` | `RegisterValue[]` | Decoded values from last read |
| `state` | `ConnectionState` | `idle`, `connecting`, `connected`, `reconnecting`, `disconnected` |
| `connected` | `boolean` | Shorthand for `state === 'connected'` |
| `stats` | `ConnectionStats` | Read success/failure/reconnect counters |

### `SungrowSystem`

Multi-inverter wrapper with automatic slave discovery and auto-reconnect.

```typescript
import { SungrowSystem, type ModbusTransaction } from 'sungrowlib';

const transactions: ModbusTransaction[] = [];
const system = new SungrowSystem({
  hosts: ['192.168.1.100'],
  reconnect: { baseDelayMs: 5000, maxDelayMs: 60000 },
  onStateChange: (state, detail) => console.log(`${state}: ${detail}`),
  onBlockRead: (tx) => transactions.push(tx),
});
await system.connect();  // discovers master/slave automatically

const masterResult = await system.read({ maxLevel: 3 });  // ReadResult
if (system.hasSlaves) {
  const slaveResults = await system.readSlaves({ maxLevel: 3 });  // ReadResult[]
}

console.log(system.slaveDetails);  // [{ host, slaveId, model, lastRawWords, lastValues }]
console.log(system.state);         // 'connected'

await system.disconnect();
```

**Reconnect options** (optional — presence enables auto-reconnect):

| Option | Default | Description |
|--------|---------|-------------|
| `baseDelayMs` | `5000` | Base delay between reconnect attempts |
| `maxDelayMs` | `60000` | Maximum delay (exponential backoff cap) |
| `maxAttempts` | `Infinity` | Give up after N attempts (`state` → `disconnected`) |

When a `read()` or `readStream()` throws `ConnectionError`, the system automatically schedules background reconnection. Subsequent `read()` calls during reconnection throw `ConnectionError('Reconnecting')`. Once reconnected, the next `read()` succeeds normally.

For multi-inverter setups, pass all hosts — port is optional (default 502):

```typescript
const system = new SungrowSystem({
  hosts: ['192.168.1.100', '192.168.1.101:8502'],
});
```

### Register catalog

The built-in catalog contains 311 registers for Sungrow SH/SG series inverters. At connect time, registers are filtered by:

- **Model** — glob patterns (e.g., `SH*RT*`, `SG*KTL*`)
- **Groups** — feature detection via indicator registers (`has_battery`, `has_meter`, `mppt2`–`mppt12`)
- **Level** — detail level 1 (minimal) to 5 (debug/diagnostic)

### Computed registers

After each read, computed registers derive values from raw data:

| Register | Dependencies | Description |
|----------|-------------|-------------|
| `timestamp` | year, month, day, hour, minute, second | Inverter clock as `"YYYY-MM-DD HH:MM:SS"` |
| `alarm_timestamp` | pid_alarm_code + alarm_time_* | Only when alarm active |
| `mppt_1_power` … `mppt_12_power` | voltage × current per MPPT | Power in watts |

### Error handling

```typescript
import {
  SungrowError,             // base class
  ConnectionError,          // TCP refused/reset
  TimeoutError,             // connect or read timeout
  ModbusProtocolError,      // slave failure, gateway no response
  UnsupportedRegisterError, // illegal address (internally handled)
  BusyError,                // WiNet busy (code 301)
  TokenExpiredError,        // WiNet token expired (code 106)
  TooManyRetriesError,      // max retries exhausted
  InvalidResponseError,     // unexpected response format
} from 'sungrowlib';
```

### TypeScript types

```typescript
import type {
  InverterInfo,            // model, serial, connectionMode, hasBattery, ...
  ConnectionMode,          // 'standalone' | 'master' | 'slave'
  ConnectionState,         // 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  ReconnectOptions,        // { baseDelayMs?, maxDelayMs?, maxAttempts? }
  ConnectionStateCallback, // (state, detail?) => void
  RegisterValue,           // name, address, raw, value, unit, supported
  DecodedValue,            // number | string | boolean | number[] | null
  ReadOptions,             // { names?, maxLevel? }
  ReadResult,              // { values: Map<string, RegisterValue>, transactions: ModbusTransaction[] }
  ModbusTransaction,       // host, type, startAddress, length, durationMs, retries, status — via onBlockRead hook
  ExtendedReadResult,      // timestamp, model, activeGroups, values, rawWords
  ConnectionStats,         // connections, readCallsSuccess, reconnects, ...
  Logger,                  // (msg: string, data?: unknown) => void
} from 'sungrowlib';
```

## Building

The library ships as TypeScript source. For the CLI, a build step compiles to JavaScript:

```bash
npm run build    # tsc → dist/
npm run check    # type-check without emitting
npm test         # run all tests (226 unit/integration)
npm run test:conformance  # build + run 17 YAML conformance scenarios
```

## Conformance tests

Language-agnostic test suite under `conformance/` — validates any sungrowlib implementation (TS, Rust, etc.) against the same standard. A Python runner starts a Modbus TCP simulator, invokes the CLI with `--format json`, and compares output against YAML expectations.

17 scenarios, 148 checks covering: model detection, group detection, register decoding (S16/U32/scale/computed), master/slave topology, block coalescing efficiency, error resilience.

Requires Python 3.12+ with `pyyaml`. See `conformance/README.md` for details.

## Project structure

```
src/
  index.ts              — public API exports
  system.ts             — SungrowSystem (multi-inverter, auto-discovery)
  core/                 — types, errors, stats, signal-state
  transport/            — Transport interface, Modbus TCP, HTTP/WebSocket
  registers/            — register catalog, decode, block I/O, computed registers
  inverter/             — SungrowInverter (single-inverter connection)
  cli/                  — CLI tool (catalog, info, read, watch, dump)
conformance/
  fixtures/             — reusable register sets from real inverter dumps
  scenarios/            — 17 YAML test scenarios (detect, read, system, error)
  simulator/            — Modbus TCP simulator (Python asyncio)
  runner/               — test orchestrator (Python)
```

Tests are co-located with source files (`*.test.ts`).

## Requirements

- Node.js >= 18
- Network access to the inverter on port 502 (Modbus TCP) or ports 80/8082 (WiNet-S)

## License

MIT
