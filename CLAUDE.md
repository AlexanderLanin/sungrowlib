# sungrowlib

Multi-language monorepo for Sungrow inverter communication.

## Structure

- `shared/` — canonical register catalog (`registers-sungrow.json`), used by all implementations
- `conformance/` — language-agnostic test suite (Python runner + Modbus simulator)
- `ts/` — TypeScript implementation (library + CLI)
- `python/` — Python implementation (placeholder)

## TypeScript

```bash
cd ts
npm install
npm run check    # type-check
npm test         # 240 unit/integration tests (vitest)
npm run build    # tsc → dist/
```

## Python

```bash
cd python
pip install -e ".[dev]"
pytest
```

## Conformance Tests

Validates any implementation's CLI against 17 YAML scenarios (148 checks).
Requires Python 3.12+ with `pyyaml`.

```bash
# TypeScript
python3 conformance/runner/run.py --scenarios conformance/scenarios/ --cli 'node ts/dist/cli/main.js'

# Python
python3 conformance/runner/run.py --scenarios conformance/scenarios/ --cli sungrowlib
```

## CLI Contract

All implementations must provide a CLI with these commands and `--format json` output:
- `info -H host:port` — inverter info (model, serial, topology, groups)
- `read -H host:port` — decoded register values
- Multi-host: multiple `-H` flags trigger system mode with master/slave detection

## Register Catalog

`shared/registers-sungrow.json` — 311 registers (229 input, 82 holding). Edit this file for register changes; conformance tests validate correctness across all implementations.
