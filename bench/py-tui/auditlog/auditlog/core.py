"""Core logic for auditlog: parse, validate, filter, and summarize JSONL logs.

Only the Python standard library is used.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

UTC = timezone.utc

# Strict RFC3339 UTC shape: YYYY-MM-DDTHH:MM:SS with optional fractional
# seconds, always terminating in a literal Z (zero UTC offset).
_RFC3339_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class AuditlogError(Exception):
    """Fatal, user-facing error reported on stderr with a clean exit code."""


class InvalidRecord(ValueError):
    """A single malformed or invalid JSONL record."""


def parse_rfc3339_utc(value: Any) -> datetime:
    """Parse ``value`` as a strict RFC3339 UTC timestamp ending in ``Z``.

    Returns an aware datetime in UTC. Raises :class:`ValueError` unless the
    value is a string, ends with ``Z``, matches the RFC3339 shape, and
    represents a real date/time with a zero offset.
    """
    if not isinstance(value, str) or not _RFC3339_UTC_RE.match(value):
        raise ValueError(f"not an RFC3339 UTC timestamp ending in Z: {value!r}")
    try:
        # fromisoformat understands a numeric offset; swap the trailing Z.
        dt = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"invalid RFC3339 timestamp: {value!r}") from exc
    if dt.tzinfo is None or dt.utcoffset() != timedelta(0):
        raise ValueError(f"timestamp is not UTC (zero offset required): {value!r}")
    return dt


def validate_event(obj: Any) -> None:
    """Validate a parsed JSON object as an audit event.

    Raises :class:`InvalidRecord` with a descriptive message unless the object
    has the required fields: seq (positive int, booleans excluded), ts
    (RFC3339 UTC), kind (non-empty string), message (string).
    """
    if not isinstance(obj, dict):
        raise InvalidRecord("record is not a JSON object")

    if "seq" not in obj:
        raise InvalidRecord("missing required field: seq")
    seq = obj["seq"]
    if type(seq) is not int or seq <= 0:
        raise InvalidRecord(
            "seq must be a positive integer (booleans excluded), got %r" % (seq,)
        )

    if "ts" not in obj:
        raise InvalidRecord("missing required field: ts")
    try:
        parse_rfc3339_utc(obj["ts"])
    except ValueError as exc:
        raise InvalidRecord("ts must be an RFC3339 UTC timestamp ending in Z: %s" % exc) from exc

    if "kind" not in obj:
        raise InvalidRecord("missing required field: kind")
    kind = obj["kind"]
    if not isinstance(kind, str) or kind == "":
        raise InvalidRecord("kind must be a non-empty string, got %r" % (kind,))

    if "message" not in obj:
        raise InvalidRecord("missing required field: message")
    if not isinstance(obj["message"], str):
        raise InvalidRecord("message must be a string, got %r" % (obj["message"],))


def read_events(path: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Read, validate, and de-duplicate the events in ``path``.

    Blank lines are ignored. Malformed JSON and invalid records produce a
    path-and-line-number diagnostic (collected, not raised) and processing
    continues. Duplicate seq values keep the first valid record and produce a
    diagnostic for each later occurrence.

    Returns ``(events, diagnostics)`` where ``events`` is sorted by seq
    ascending and ``diagnostics`` are human-readable stderr messages.
    Raises :class:`AuditlogError` if the file cannot be read.
    """
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError as exc:
        detail = exc.strerror or str(exc)
        raise AuditlogError("cannot read input file %s: %s" % (path, detail)) from exc

    seen_seqs: dict[int, int] = {}
    events: list[dict[str, Any]] = []
    diagnostics: list[str] = []

    for line_no, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line:
            continue  # requirement 1: ignore blank lines

        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            diagnostics.append("%s:%d: malformed JSON: %s" % (path, line_no, exc))
            continue

        try:
            validate_event(obj)
        except InvalidRecord as exc:
            diagnostics.append("%s:%d: invalid record: %s" % (path, line_no, exc))
            continue

        seq = obj["seq"]
        if seq in seen_seqs:
            diagnostics.append(
                "%s:%d: duplicate seq %d (first seen at line %d); "
                "keeping first record" % (path, line_no, seq, seen_seqs[seq])
            )
            continue
        seen_seqs[seq] = line_no
        events.append(obj)

    events.sort(key=lambda event: event["seq"])  # requirement 4
    return events, diagnostics


def filter_events(
    events: list[dict[str, Any]],
    kind: str | None,
    since: datetime | None,
    until: datetime | None,
) -> list[dict[str, Any]]:
    """Apply --kind / --since / --until filters (both inclusive)."""
    result: list[dict[str, Any]] = []
    for event in events:
        if kind is not None and event["kind"] != kind:  # requirement 5
            continue
        ts = parse_rfc3339_utc(event["ts"])
        if since is not None and ts < since:  # requirement 6 (inclusive)
            continue
        if until is not None and ts > until:  # requirement 6 (inclusive)
            continue
        result.append(event)
    return result


def build_summary(
    events: list[dict[str, Any]], limit: int | None
) -> dict[str, Any]:
    """Build the deterministic output object.

    ``count`` and ``counts_by_kind`` reflect the filtered results before the
    limit; ``events`` reflects the results after the limit (requirements 8-9).
    """
    counts: dict[str, int] = {}
    for event in events:
        counts[event["kind"]] = counts.get(event["kind"], 0) + 1
    counts_by_kind = {key: counts[key] for key in sorted(counts)}  # requirement 10

    if limit is not None:
        displayed = events[-limit:]  # N most recent by seq, still ascending
    else:
        displayed = list(events)

    return {
        "count": len(events),
        "counts_by_kind": counts_by_kind,
        "events": displayed,
    }


def render_summary(summary: dict[str, Any]) -> str:
    """Render a summary as stable, deterministic JSON (requirement 10)."""
    return json.dumps(summary, sort_keys=True, indent=2)


def write_diagnostics(diagnostics: list[str]) -> None:
    """Write diagnostics to stderr, never to stdout (requirement 10)."""
    for diagnostic in diagnostics:
        print(diagnostic, file=sys.stderr)
