"""Command-line interface for auditlog."""

from __future__ import annotations

import argparse
import sys

from .core import FileError, parse_rfc3339_utc, load_events, summarize, render


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auditlog",
        description="Summarize an audit log JSONL file.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    summarize_parser = subparsers.add_parser(
        "summarize", help="Summarize events in a JSONL log file"
    )
    summarize_parser.add_argument("path", help="Path to the JSONL input file")
    summarize_parser.add_argument(
        "--kind", default=None, help="Filter by exact kind value"
    )
    summarize_parser.add_argument(
        "--since", default=None, help="Include events with ts >= this RFC3339 UTC timestamp"
    )
    summarize_parser.add_argument(
        "--until", default=None, help="Include events with ts <= this RFC3339 UTC timestamp"
    )
    summarize_parser.add_argument(
        "--limit", type=int, default=None, help="Return the N most recent records by seq"
    )
    return parser


def _parse_timestamp(value: str | None, flag: str) -> str | None:
    """Validate a CLI timestamp argument. Returns an error message or None."""
    if value is None:
        return None
    if parse_rfc3339_utc(value) is None:
        return f"invalid {flag} timestamp (must be RFC3339 UTC ending in Z): {value!r}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command != "summarize":
        parser.error("unknown command")

    since_err = _parse_timestamp(args.since, "--since")
    until_err = _parse_timestamp(args.until, "--until")
    if since_err:
        print(f"auditlog: {since_err}", file=sys.stderr)
        return 2
    if until_err:
        print(f"auditlog: {until_err}", file=sys.stderr)
        return 2

    since = parse_rfc3339_utc(args.since) if args.since is not None else None
    until = parse_rfc3339_utc(args.until) if args.until is not None else None

    if since is not None and until is not None and since > until:
        print(
            "auditlog: --since must not be later than --until",
            file=sys.stderr,
        )
        return 2

    if args.limit is not None and args.limit <= 0:
        print(
            f"auditlog: --limit must be a positive integer: {args.limit!r}",
            file=sys.stderr,
        )
        return 2

    try:
        records = load_events(args.path)
    except FileError as exc:
        print(f"auditlog: {exc}", file=sys.stderr)
        return 1

    summary = summarize(
        records,
        kind=args.kind,
        since=since,
        until=until,
        limit=args.limit,
    )
    print(render(summary))
    return 0
