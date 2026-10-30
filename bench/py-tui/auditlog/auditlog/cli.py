"""Command-line interface for auditlog.

Usage:
    python -m auditlog summarize PATH [--kind KIND] [--since TS] [--until TS] [--limit N]
"""

from __future__ import annotations

import argparse
import sys
from typing import Any, Sequence

from . import core
from .core import AuditlogError, parse_rfc3339_utc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auditlog",
        description="Summarize a JSONL audit log file.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    summarize = subparsers.add_parser(
        "summarize", help="Summarize events in a JSONL audit log."
    )
    summarize.add_argument("path", help="Path to the JSONL audit log file.")
    summarize.add_argument("--kind", metavar="KIND", help="Filter by exact kind (case-sensitive).")
    summarize.add_argument(
        "--since",
        metavar="TIMESTAMP",
        help="Include events at or after this RFC3339 UTC timestamp (ending in Z).",
    )
    summarize.add_argument(
        "--until",
        metavar="TIMESTAMP",
        help="Include events at or before this RFC3339 UTC timestamp (ending in Z).",
    )
    summarize.add_argument(
        "--limit",
        metavar="N",
        type=int,
        help="Return at most N most recent events by seq, shown in ascending seq order.",
    )

    tui = subparsers.add_parser(
        "tui", help="Browse a JSONL audit log in a terminal interface (curses)."
    )
    tui.add_argument("path", help="Path to the JSONL audit log file.")
    tui.add_argument("--kind", metavar="KIND", help="Filter by exact kind (case-sensitive).")
    tui.add_argument(
        "--since",
        metavar="TIMESTAMP",
        help="Include events at or after this RFC3339 UTC timestamp (ending in Z).",
    )
    tui.add_argument(
        "--until",
        metavar="TIMESTAMP",
        help="Include events at or before this RFC3339 UTC timestamp (ending in Z).",
    )

    return parser


def _fail(message: str) -> int:
    """Print a clear error to stderr and return a nonzero exit code."""
    print("auditlog: error: %s" % message, file=sys.stderr)
    return 1


def _validate_timestamp(label: str, value: str | None) -> Any | None:
    """Parse a CLI timestamp argument, returning None if absent.

    Returns a datetime or raises SystemExit-style failure via the caller.
    """
    if value is None:
        return None
    try:
        return parse_rfc3339_utc(value)
    except ValueError:
        raise AuditlogError(
            "invalid %s timestamp %r: must be RFC3339 UTC ending in Z "
            "(for example 2023-01-01T00:00:00Z)" % (label, value)
        )


def run_summarize(args: Any) -> int:
    since = _validate_timestamp("--since", args.since)
    until = _validate_timestamp("--until", args.until)

    if since is not None and until is not None and since > until:  # requirement 7
        return _fail("--since (%s) is later than --until (%s)" % (args.since, args.until))

    if args.limit is not None and args.limit <= 0:  # requirement 7
        return _fail("--limit must be a positive integer, got %r" % (args.limit,))

    try:
        events, diagnostics = core.read_events(args.path)  # requirement 11
    except AuditlogError as exc:
        return _fail(str(exc))

    core.write_diagnostics(diagnostics)  # requirements 2-3: stderr only

    filtered = core.filter_events(events, args.kind, since, until)
    summary = core.build_summary(filtered, args.limit)

    # requirement 10: stdout carries only the JSON, nothing else.
    print(core.render_summary(summary))
    return 0


def run_tui(args: Any) -> int:
    from . import ui

    return ui.run_tui(
        args.path,
        kind=args.kind,
        since=args.since,
        until=args.until,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "summarize":
        try:
            return run_summarize(args)
        except AuditlogError as exc:
            return _fail(str(exc))
    if args.command == "tui":
        try:
            return run_tui(args)
        except AuditlogError as exc:
            return _fail(str(exc))
    return _fail("unknown command %r" % (args.command,))
