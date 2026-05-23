# sungrowlib

Multi-language monorepo for Sungrow inverter communication. Two primary products: the register catalog and the library implementations.

## Structure

- `registers/` — canonical register catalog (`registers-sungrow.json`), standalone product usable from any language
- `conformance/` — language-agnostic test suite (Python runner + Modbus simulator)
- `dumps/` — real-world inverter dumps captured via `sungrowlib dump`; useful as development reference and for community contributions. After adding a new dump, run `python3 registers/update_observations.py` to regenerate the `observations` field in the register catalog.
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

Validates any implementation's CLI against 18 YAML scenarios.
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

`registers/registers-sungrow.json` — 332 registers (230 input, 102 holding). This is a standalone product: the JSON file can be consumed directly by any tool or language. See `registers/README.md` for the schema. Edit this file for register changes; conformance tests validate correctness across all implementations.

Use `jq` for ad-hoc queries on the catalog, not throwaway Python scripts. The data is already JSON.

## Conventions

- Store project knowledge in this file (`CLAUDE.md`), not in private memory or external notes. Everything an AI assistant needs to work on this repo should be in the repo itself.
- Prefer `uv` over `pip` for Python dependency management.
- Use `jq` for JSON queries, Python for structured operations that modify files or parse non-JSON sources.
