"""Core logic for the auditlog package.

Dependency-free summarization of JSONL audit logs. This module returns plain
data structures and raises :class:`AuditlogError` for terminal failures; all
per-record diagnostics are written to stderr by :func:`read_events`.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
_REQUIRED_FIELDS = ("seq", "ts", "kind", "message")


class AuditlogError(Exception):
    """Terminal failure reported to the user without a traceback."""


@dataclass(frozen=True)
class Event:
    seq: int
    ts: str
    kind: str
    message: str
    ts_dt: datetime


def parse_timestamp(value: str) -> datetime:
    """Parse a RFC3339 UTC timestamp; the string must end in ``Z``."""
    if not isinstance(value, str) or not _TIMESTAMP_RE.match(value):
        raise ValueError(f"invalid RFC3339 UTC timestamp: {value!r}")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"invalid RFC3339 UTC timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"invalid RFC3339 UTC timestamp: {value!r}")
    return parsed.astimezone(timezone.utc)


def validate_record(obj: Any) -> tuple[str | None, Event | None]:
    """Validate one decoded JSON object, returning (error, event)."""
    if not isinstance(obj, dict):
        return "record is not a JSON object", None
    for field in _REQUIRED_FIELDS:
        if field not in obj:
            return f"missing required field {field!r}", None
    seq = obj["seq"]
    if isinstance(seq, bool) or not isinstance(seq, int) or seq <= 0:
        return "seq must be a positive integer (booleans excluded)", None
    ts = obj["ts"]
    if not isinstance(ts, str):
        return "ts must be a string", None
    try:
        ts_dt = parse_timestamp(ts)
    except ValueError as exc:
        return str(exc), None
    kind = obj["kind"]
    if not isinstance(kind, str) or kind == "":
        return "kind must be a non-empty string", None
    message = obj["message"]
    if not isinstance(message, str):
        return "message must be a string", None
    return None, Event(seq, ts, kind, message, ts_dt)


def read_events(path: str) -> list[Event]:
    """Read and validate a JSONL file, deduplicating by seq (first wins).

    Per-record diagnostics (malformed JSON, invalid records, duplicate seq)
    are written to stderr with path and line number; processing continues.
    """
    seen: set[int] = set()
    events: list[Event] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for lineno, line in enumerate(handle, start=1):
                if not line.strip():
                    continue  # ignore blank lines
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"{path}:{lineno}: invalid JSON: {exc}", file=sys.stderr)
                    continue
                error, event = validate_record(obj)
                if error is not None:
                    print(f"{path}:{lineno}: invalid record: {error}", file=sys.stderr)
                    continue
                if event.seq in seen:
                    print(
                        f"{path}:{lineno}: duplicate seq {event.seq}; "
                        "keeping first occurrence",
                        file=sys.stderr,
                    )
                    continue
                seen.add(event.seq)
                events.append(event)
    except (OSError, UnicodeDecodeError) as exc:
        raise AuditlogError(f"cannot read {path}: {exc}") from exc
    events.sort(key=lambda event: event.seq)
    return events


def filter_events(
    events: list[Event],
    kind: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[Event]:
    """Apply kind (exact) and inclusive since/until timestamp filters."""
    result: list[Event] = []
    for event in events:
        if kind is not None and event.kind != kind:
            continue
        if since is not None and event.ts_dt < since:
            continue
        if until is not None and event.ts_dt > until:
            continue
        result.append(event)
    return result


def summarize(
    path: str,
    kind: str | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int | None = None,
) -> dict:
    """Summarize an audit log file into a deterministic result dict."""
    since_dt = parse_timestamp(since) if since is not None else None
    until_dt = parse_timestamp(until) if until is not None else None
    if since_dt is not None and until_dt is not None and since_dt > until_dt:
        raise AuditlogError("--since must not be later than --until")
    if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0):
        raise AuditlogError(f"--limit must be a positive integer, got {limit!r}")
    events = read_events(path)
    filtered = filter_events(events, kind=kind, since=since_dt, until=until_dt)
    counts_by_kind: dict[str, int] = {}
    for event in filtered:
        counts_by_kind[event.kind] = counts_by_kind.get(event.kind, 0) + 1
    displayed = filtered[-limit:] if limit is not None else filtered
    return {
        "count": len(filtered),
        "counts_by_kind": dict(sorted(counts_by_kind.items())),
        "events": [
            {"seq": e.seq, "ts": e.ts, "kind": e.kind, "message": e.message}
            for e in displayed
        ],
    }
