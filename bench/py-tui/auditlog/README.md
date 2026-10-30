# auditlog

A production-quality, dependency-free JSONL audit log summarizer. Built with
only the Python standard library.

```
python -m auditlog summarize PATH [--kind KIND] [--since TIMESTAMP] [--until TIMESTAMP] [--limit N]
```

## Input schema

Each non-blank line of the input file is a JSON object with these required
fields:

| Field | Type | Constraint |
|---|---|---|
| `seq` | integer | Positive, `>= 1`; JSON booleans are rejected |
| `ts` | string | RFC3339 UTC timestamp ending in `Z` (e.g. `2023-01-01T00:00:00Z`) |
| `kind` | string | Non-empty |
| `message` | string | Any string |

Extra fields are preserved in the output.

Example record:

```json
{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "user signed in"}
```

## CLI

```
python -m auditlog summarize PATH [--kind KIND] [--since TIMESTAMP] [--until TIMESTAMP] [--limit N]
```

* `PATH` — path to the JSONL audit log file (required).
* `--kind KIND` — keep only events whose `kind` equals `KIND` exactly.
* `--since TIMESTAMP` — keep events at or after this RFC3339 UTC timestamp (inclusive).
* `--until TIMESTAMP` — keep events at or before this RFC3339 UTC timestamp (inclusive).
* `--limit N` — return the `N` most recent records by `seq` from the filtered
  results, displayed in ascending `seq` order.

## Behavior

1. Blank lines are ignored.
2. Malformed JSON or invalid records produce a path-and-line-number diagnostic
   on stderr, and processing continues with the next line.
3. Duplicate `seq` values keep the first valid record; later duplicates are
   reported on stderr.
4. Valid records are sorted by `seq` ascending before filtering.
5. `--since`/`--until` filters are inclusive on both ends.
6. Invalid timestamp arguments, non-positive `--limit`, and `--since` later
   than `--until` cause a clear CLI error with a nonzero exit status.
7. Output is a single JSON object on stdout:

   ```json
   {
     "count": 3,
     "counts_by_kind": {"login": 2, "logout": 1},
     "events": [
       {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "..."}
     ]
   }
   ```

   `count` and `counts_by_kind` reflect the filtered results **before** the
   limit; `events` reflects the results **after** the limit.
8. Output is deterministic: `counts_by_kind` keys are sorted, JSON formatting
   is stable (`sort_keys`, fixed indentation), and no status messages are ever
   written to stdout.
9. A missing or unreadable input file fails cleanly (stderr message, nonzero
   exit, no traceback). Bad individual records never prevent valid records
   from being summarized.

## Exit status

| Situation | Exit code |
|---|---|
| Success | `0` |
| CLI argument error (bad timestamp, bad limit, since > until) | `2` (argparse) or `1` |
| Missing/unreadable input file | `1` |

## Terminal UI

A lightweight curses-based browser is also available:

```
python -m auditlog tui PATH [--kind KIND] [--since TS] [--until TS]
```

Keys: Up/Down (`j`/`k`) scroll, Space/PageDown page down, PageUp page up,
`g`/`G` jump to start/end, Enter shows the full record, `q` quits.

## Tests

```sh
python -m unittest discover -s tests -v
```

or

```sh
python -m tests.test_auditlog
```

## Packaging

```sh
pip install .
# then
auditlog summarize audit.log
```

## Requirements

Python 3.8+. Standard library only — no third-party dependencies.
