# sungrowlib

Multi-language library and CLI for communicating with Sungrow solar inverters via Modbus TCP or HTTP/WebSocket (WiNet-S dongle).

## Implementations

| Language | Status | Directory |
|----------|--------|-----------|
| [TypeScript](ts/README.md) | Complete | `ts/` |
| [Python](python/README.md) | Placeholder | `python/` |

Both implementations share the same register catalog and must pass the same conformance test suite.

## Repository Structure

```
shared/           Shared data (register catalog: 311 registers)
conformance/      Language-agnostic test suite (17 scenarios, 148 checks)
ts/               TypeScript implementation (library + CLI)
python/           Python implementation (library + CLI)
```

## Register Catalog

`shared/registers-sungrow.json` contains the canonical register definitions for Sungrow SH/SG series inverters. All implementations load this file. Changes to register definitions are made here and validated across all implementations via the conformance suite.

## Conformance Tests

The `conformance/` directory contains a language-agnostic test suite. A Python runner starts a Modbus TCP simulator, invokes the implementation's CLI with `--format json`, and compares output against YAML expectations.

Any conforming implementation must provide a CLI with `info` and `read` commands that accept `-H host:port` and `--format json`. See [conformance/README.md](conformance/README.md) for the full contract.

```bash
# Run against TypeScript
cd ts && npm run build && cd ..
python3 conformance/runner/run.py --scenarios conformance/scenarios/ --cli 'node ts/dist/cli/main.js'

# Run against Python (once implemented)
cd python && pip install -e . && cd ..
python3 conformance/runner/run.py --scenarios conformance/scenarios/ --cli sungrowlib
```

## License

MIT
