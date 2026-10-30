# auditlog

Dependency-free JSONL audit log summarizer for Python 3.12 (standard library
only). Distributed as a single package, run with:

```
python -m auditlog summarize PATH [--kind KIND] [--since TIMESTAMP] [--until TIMESTAMP] [--limit N]
```

## Input format

Each non-blank line of `PATH` must be a JSON object with these required fields:

| Field | Requirement |
|-------|-------------|
| `seq` | Positive integer; booleans (`true`/`false`) are rejected |
| `ts` | RFC3339 UTC timestamp ending in `Z` (e.g. `2023-01-01T00:00:00Z`, fractional seconds allowed) |
| `kind` | Non-empty string |
| `message` | String (empty allowed) |

Example line:

```json
{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "user signed in"}
```

## CLI

```
python -m auditlog summarize PATH [options]
```

Options:

* `--kind KIND` — keep only events whose `kind` exactly equals `KIND`.
* `--since TIMESTAMP` — inclusive start filter (RFC3339 UTC, ending in `Z`).
* `--until TIMESTAMP` — inclusive end filter (RFC3339 UTC, ending in `Z`).
* `--limit N` — return only the `N` most recent records by `seq`, displayed in ascending `seq` order.

## Behavior

1. Blank lines are ignored.
2. Every event is validated. Malformed JSON or invalid records produce a
   `path:line: diagnostic` on **stderr**, and processing continues with the
   next line. Valid records are never held back by bad ones.
3. Duplicate `seq` values keep the first valid record; later duplicates are
   reported to stderr.
4. Valid records are sorted by `seq` ascending.
5. `--kind`, `--since`, and `--until` filters are applied; `--since`/`--until`
   are inclusive.
6. `--limit N` keeps the `N` most recent records by `seq` from the filtered
   results (ascending `seq` order).
7. Invalid timestamp arguments, non-positive `--limit`, and `--since` later
   than `--until` produce a clear CLI error on stderr with a non-zero exit
   status (no traceback).
8. Output is a single JSON object written to **stdout**:

```json
{
  "count": 2,
  "counts_by_kind": {
    "login": 2
  },
  "events": [
    {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "a"}
  ]
}
```

* `count` — number of records after filters, **before** limit.
* `counts_by_kind` — counts after filters, before limit; keys sorted.
* `events` — records after the limit, in ascending `seq` order.

Output is deterministic: sorted `counts_by_kind` keys, stable JSON formatting,
and no normal status messages on stdout.

## Diagnostics and exit behavior

* Per-record problems (malformed JSON, invalid field, duplicate `seq`) are
  written to stderr as `path:line: <message>`; processing continues.
* A missing or unreadable input file fails cleanly with `auditlog: error: cannot read ...` on stderr, no traceback, non-zero exit.
* Invalid CLI arguments (bad timestamps, non-positive limit, `--since` after
  `--until`) fail with `auditlog: error: ...` on stderr, non-zero exit.
* Exit status: `0` on success, non-zero on any error.

## Tests

```
python3 -m unittest discover -s tests
```

## Requirements

Python 3.12 (or later). No third-party dependencies.
