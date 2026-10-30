# auditlog

Dependency-free JSONL audit log summarizer (Python standard library only, Python 3.12+).

## Install

```bash
pip install .
# or, from the source directory:
python3 -m auditlog summarize PATH ...
```

No external dependencies.

## Input schema

Each non-blank line of the input file must be a JSON object with these required fields:

| Field | Type | Constraints |
|-------|------|-------------|
| `seq` | integer | Positive, must not be a JSON boolean |
| `ts` | string | Valid RFC3339 UTC timestamp ending in `Z` (e.g. `2023-01-01T00:00:00Z`) |
| `kind` | string | Non-empty |
| `message` | string | Any string |

Extra fields are accepted but not echoed in the output.

## CLI

```
python -m auditlog summarize PATH [--kind KIND] [--since TIMESTAMP] [--until TIMESTAMP] [--limit N]
```

- `PATH` — JSONL file to read.
- `--kind` — keep only events whose `kind` exactly equals this value.
- `--since` — keep events with `ts >= TIMESTAMP` (inclusive).
- `--until` — keep events with `ts <= TIMESTAMP` (inclusive).
- `--limit N` — return the `N` most recent records by `seq`, displayed in ascending `seq` order.

## Behavior

1. Blank lines are ignored.
2. Malformed JSON or invalid records produce a path-and-line-number diagnostic on stderr and processing continues.
3. Duplicate `seq` values keep the first valid record; later duplicates are reported to stderr.
4. Valid records are sorted by `seq` ascending before filtering.
5. `--since`/`--until` are inclusive; either may be omitted.
6. Invalid timestamp arguments, non-positive `--limit`, and `--since` later than `--until` produce a clear CLI error on stderr with a non-zero exit status.
7. Output is a single JSON object on stdout:

```json
{
  "count": 2,
  "counts_by_kind": {
    "error": 1,
    "info": 1
  },
  "events": [
    { "seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "error", "message": "b" }
  ]
}
```

- `count` — number of records after filters, before limit.
- `counts_by_kind` — counts after filters, before limit, keys sorted.
- `events` — records after the limit, in ascending `seq` order.
8. Output is deterministic: `counts_by_kind` keys are sorted, JSON formatting is stable, and nothing but the JSON result is written to stdout.

## Diagnostics and exit status

| Situation | stderr | stdout | Exit status |
|-----------|--------|--------|-------------|
| Success | empty (or per-record diagnostics) | summary JSON | 0 |
| Invalid CLI argument | clear error message | empty | 2 |
| Missing / unreadable input file | clean error, no traceback | empty | 1 |
| Malformed / invalid individual line | path:line diagnostic | continues | 0 if file readable |

## Testing

```bash
python3 -m unittest discover -s tests -v
```

## Example

Input `log.jsonl`:

```
{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c"}
{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}
not json
{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "error", "message": "b"}
{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "info", "message": "dup"}
```

```bash
python3 -m auditlog summarize log.jsonl --kind info --limit 1
```

Output:

```json
{
  "count": 2,
  "counts_by_kind": {
    "info": 2
  },
  "events": [
    {
      "kind": "info",
      "message": "c",
      "seq": 3,
      "ts": "2023-01-03T00:00:00Z"
    }
  ]
}
```

Diagnostics for line 3 (malformed JSON) and line 5 (duplicate seq 2) go to stderr.
