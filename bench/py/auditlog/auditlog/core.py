"""Core logic for auditlog: loading, validating, filtering, and summarizing JSONL event logs.

Only the Python standard library is used.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


REQUIRED_FIELDS = ("seq", "ts", "kind", "message")
OUTPUT_FIELDS = ("seq", "ts", "kind", "message")


class FileError(Exception):
    """Raised when the input file cannot be read."""


def _diagnostic(path: str, line_no: int, detail: str) -> None:
    """Write a path-and-line-number diagnostic to stderr."""
    print(f"auditlog: {path} line {line_no}: {detail}", file=sys.stderr)


def parse_rfc3339_utc(value: Any) -> datetime | None:
    """Parse an RFC3339 UTC timestamp that must end with ``Z``.

    Returns an aware UTC ``datetime``, or ``None`` if the value is invalid.
    Booleans and non-strings are rejected.
    """
    if isinstance(value, bool) or not isinstance(value, str):
        return None
    if not value.endswith("Z"):
        return None
    try:
        dt = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc)


def validate_event(obj: Any, path: str, line_no: int) -> dict[str, Any] | None:
    """Validate a single parsed JSON event.

    Returns a record dict (with an internal ``_dt`` key) on success, or
    ``None`` after writing a diagnostic to stderr.
    """
    if not isinstance(obj, dict):
        _diagnostic(path, line_no, "record is not a JSON object")
        return None

    for field in REQUIRED_FIELDS:
        if field not in obj:
            _diagnostic(path, line_no, f"missing required field: {field}")
            return None

    seq = obj["seq"]
    if isinstance(seq, bool) or not isinstance(seq, int) or seq <= 0:
        _diagnostic(path, line_no, f"invalid seq (must be a positive integer): {seq!r}")
        return None

    dt = parse_rfc3339_utc(obj["ts"])
    if dt is None:
        _diagnostic(path, line_no, f"invalid ts (must be RFC3339 UTC ending in Z): {obj['ts']!r}")
        return None

    kind = obj["kind"]
    if not isinstance(kind, str) or kind == "":
        _diagnostic(path, line_no, f"invalid kind (must be a non-empty string): {kind!r}")
        return None

    message = obj["message"]
    if not isinstance(message, str):
        _diagnostic(path, line_no, f"invalid message (must be a string): {message!r}")
        return None

    return {"seq": seq, "ts": obj["ts"], "kind": kind, "message": message, "_dt": dt}


def load_events(path: str) -> list[dict[str, Any]]:
    """Read and validate every event in a JSONL file.

    Blank lines are ignored. Malformed JSON and invalid records are
    reported to stderr with path and line number; processing continues.
    Duplicate seq values keep the first valid record; later duplicates are
    reported to stderr and skipped.

    Returns valid records sorted by seq ascending. Raises FileError if the
    file is missing or unreadable.
    """
    records: list[dict[str, Any]] = []
    seen_seqs: set[int] = set()

    try:
        handle = open(path, "r", encoding="utf-8")
    except FileNotFoundError:
        raise FileError(f"input file not found: {path}")
    except IsADirectoryError:
        raise FileError(f"input path is a directory: {path}")
    except PermissionError:
        raise FileError(f"permission denied reading input file: {path}")
    except OSError as exc:
        raise FileError(f"cannot read input file {path}: {exc}")

    with handle:
        for line_no, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                _diagnostic(path, line_no, f"malformed JSON: {exc}")
                continue
            record = validate_event(obj, path, line_no)
            if record is None:
                continue
            if record["seq"] in seen_seqs:
                _diagnostic(path, line_no, f"duplicate seq {record['seq']}; keeping first occurrence")
                continue
            seen_seqs.add(record["seq"])
            records.append(record)

    records.sort(key=lambda record: record["seq"])
    return records


def filter_records(
    records: list[dict[str, Any]],
    kind: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return records matching the optional kind/since/until filters.

    Filters are inclusive on both ends. Input order (seq ascending) is
    preserved.
    """
    result: list[dict[str, Any]] = []
    for record in records:
        if kind is not None and record["kind"] != kind:
            continue
        dt = record["_dt"]
        if since is not None and dt < since:
            continue
        if until is not None and dt > until:
            continue
        result.append(record)
    return result


def summarize(
    records: list[dict[str, Any]],
    kind: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Produce the deterministic summary dict for CLI output."""
    ordered = sorted(records, key=lambda record: record["seq"])
    filtered = filter_records(ordered, kind=kind, since=since, until=until)

    counts_by_kind: dict[str, int] = {}
    for record in filtered:
        counts_by_kind[record["kind"]] = counts_by_kind.get(record["kind"], 0) + 1

    if limit is not None:
        events = filtered[-limit:] if 0 < limit < len(filtered) else list(filtered)
    else:
        events = list(filtered)

    return {
        "count": len(filtered),
        "counts_by_kind": dict(sorted(counts_by_kind.items())),
        "events": [
            {field: record[field] for field in OUTPUT_FIELDS} for record in events
        ],
    }


def render(summary: dict[str, Any]) -> str:
    """Render a summary as stable, deterministic JSON."""
    return json.dumps(summary, sort_keys=True, indent=2)
