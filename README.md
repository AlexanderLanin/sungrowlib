# sungrowlib

Two things in one repo:

1. **[Register Catalog](registers/)** — machine-readable JSON database of 311 Sungrow inverter registers (SH/SG series), audited against official Sungrow communication protocols. Usable from any language.

2. **Library + CLI** — multi-language implementations that use the catalog to communicate with Sungrow inverters via Modbus TCP or HTTP/WebSocket (WiNet-S).

## Register Catalog

[`registers/registers-sungrow.json`](registers/registers-sungrow.json) is the canonical register definition file. See the [register catalog README](registers/README.md) for the full schema, field reference, and usage from any language.

## Implementations

| Language | Status | Directory |
|----------|--------|-----------|
| [TypeScript](ts/README.md) | Complete | `ts/` |
| [Python](python/README.md) | Placeholder | `python/` |

Both implementations load the shared register catalog and must pass the same conformance test suite.

## Repository Structure

```
registers/        Register catalog (311 registers, JSON)
conformance/      Language-agnostic test suite (17 scenarios, 148 checks)
ts/               TypeScript implementation (library + CLI)
python/           Python implementation (library + CLI)
```

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
