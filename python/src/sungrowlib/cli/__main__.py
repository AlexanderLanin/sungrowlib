"""Sungrowlib CLI entry point (placeholder)."""

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="sungrowlib", description="Sungrow inverter CLI")
    parser.add_argument("command", choices=["info", "read", "catalog", "watch", "dump"])
    parser.add_argument("-H", "--host", action="append", dest="hosts")
    parser.add_argument("-p", "--port", type=int, default=502)
    parser.add_argument("-s", "--slave-id", type=int)
    parser.add_argument("-f", "--format", default="pretty")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("-l", "--level", type=int)
    parser.add_argument("-n", "--names")
    parser.add_argument("--supported-only", action="store_true")

    args = parser.parse_args()

    print(f"sungrowlib {args.command}: not implemented (Python)", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
