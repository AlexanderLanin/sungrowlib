# sungrowlib (Python)

Python implementation of sungrowlib. **Work in progress** — the CLI stub exists but no functionality is implemented yet.

## Setup

```bash
cd python
pip install -e ".[dev]"
```

## Tests

```bash
pytest
```

## Conformance

The Python implementation must pass the same [conformance tests](../conformance/README.md) as all other implementations. Currently all conformance scenarios fail with "not implemented".

```bash
python3 ../conformance/runner/run.py --scenarios ../conformance/scenarios/ --cli sungrowlib
```
