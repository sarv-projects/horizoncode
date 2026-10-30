"""Command-line interface for the auditlog package."""

from __future__ import annotations

import argparse
import json
import sys

from .core import AuditlogError, summarize


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auditlog",
        description="Summarize a JSONL audit log file.",
        epilog=(
            "Examples:\n"
            "  python -m auditlog summarize audit.jsonl\n"
            "  python -m auditlog summarize audit.jsonl --kind login --since 2023-01-01T00:00:00Z\n"
            "  python -m auditlog summarize audit.jsonl --kind login --limit 10\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("summarize", help="summarize an audit log file")
    s.add_argument("path", help="path to the JSONL audit log file")
    s.add_argument(
        "--kind",
        metavar="KIND",
        help="exact kind filter (string match)",
    )
    s.add_argument(
        "--since",
        metavar="TIMESTAMP",
        help="inclusive start filter, RFC3339 UTC ending in Z",
    )
    s.add_argument(
        "--until",
        metavar="TIMESTAMP",
        help="inclusive end filter, RFC3339 UTC ending in Z",
    )
    s.add_argument(
        "--limit",
        metavar="N",
        type=int,
        help="show only the N most recent records by seq",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "summarize":  # pragma: no cover - argparse enforces a subcommand
        parser.error("unknown command")
        return 2
    try:
        result = summarize(
            args.path,
            kind=args.kind,
            since=args.since,
            until=args.until,
            limit=args.limit,
        )
    except AuditlogError as exc:
        print(f"auditlog: error: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:  # invalid --since / --until argument
        print(f"auditlog: error: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
