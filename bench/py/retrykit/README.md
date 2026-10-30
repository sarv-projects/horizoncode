# retrykit

Small, dependency-free retry with exponential backoff. Python standard library only.

## Install

```bash
pip install .
```

## API

```python
from retrykit import retry_call

result = retry_call(
    fn,
    *,
    attempts=3,
    initial_delay=0.1,
    max_delay=2.0,
    retry_on=(Exception,),
    sleep=time.sleep,
)
```

- `fn` — zero-argument callable. Its result is returned unchanged on success.
- `attempts` — maximum TOTAL number of calls, including the first. Positive
  integer; booleans are invalid.
- `initial_delay`, `max_delay` — finite, non-negative real numbers
  (booleans excluded). After failed attempt `i` (starting at 1), sleep for
  `min(initial_delay * 2 ** (i - 1), max_delay)`, but only when another
  attempt will be made. No sleep happens after a success or after the final
  failed attempt.
- `retry_on` — non-empty tuple of `Exception` subclasses. Only matching
  exceptions are retried; everything else propagates immediately.
- `sleep` — injected callable (`time.sleep` by default). Tests can inject a
  recording stub so no real delays ever occur.

On the final failed attempt, the original exception is propagated unchanged
— never wrapped, never masked.

## Examples

Retry a flaky network call, backing off 0.1s, 0.2s, 0.4s, capped at 2s:

```python
from retrykit import retry_call

response = retry_call(fetch, attempts=5, initial_delay=0.1, max_delay=2.0)
```

Retry only specific errors, let everything else escape:

```python
retry_call(
    fn,
    retry_on=(ConnectionError, TimeoutError),
    attempts=2,
)
```

Test without real delays:

```python
from unittest.mock import Mock
from retrykit import retry_call

sleep = Mock()
retry_call(fn, attempts=3, sleep=sleep)
assert sleep.call_count == 2  # one sleep per failed attempt except the last
```

## Behavior contract

| Situation | Behavior |
|---|---|
| `fn` succeeds on attempt `k` | Returns `fn()`'s result; sleeps after each of the `k-1` failures. |
| All `attempts` fail with matching errors | Propagates the last attempt's original exception; sleeps `attempts - 1` times. |
| `fn` raises a non-matching error | Propagates immediately; no retries, no further sleep. |
| Invalid arguments | `TypeError` for wrong types, `ValueError` for bad values, before `fn` is called. |

## Tests

```bash
python3 -m unittest discover -v
```
