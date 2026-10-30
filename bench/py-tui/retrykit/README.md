# retrykit

Retry a zero-argument callable with a bounded number of attempts and
exponential backoff. Standard library only — no dependencies.

## Installation

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

- `fn` — zero-argument callable. Its result is returned unchanged on
  success.
- `attempts` — maximum TOTAL number of calls, including the initial
  call. Must be a positive integer (booleans rejected).
- `initial_delay`, `max_delay` — backoff bounds in seconds. Must be
  finite, non-negative numbers (booleans rejected).
- `retry_on` — non-empty tuple of `Exception` subclasses. Only matching
  exceptions are retried; everything else propagates immediately.
- `sleep` — callable invoked with one delay argument after a failed
  attempt. Inject a fake in tests so no real delay ever occurs.

## Behavior

1. Call `fn`. On success, return its result unchanged.
2. On an exception matching `retry_on`, if another attempt remains,
   sleep for `min(initial_delay * 2 ** (i - 1), max_delay)` where `i`
   is the failed attempt number (starting at 1), then retry.
3. On the final permitted attempt, re-raise the original exception
   unchanged. No sleep happens after the final attempt.
4. Exceptions not matching `retry_on` propagate immediately with no
   retries and no sleep.

## Examples

**Retry a flaky network call:**

```python
from retrykit import retry_call

def fetch():
    ...

response = retry_call(fetch, attempts=5, initial_delay=0.5, max_delay=8.0)
```

**Retry only specific errors, fail fast on others:**

```python
retry_call(
    lambda: risky(),
    attempts=3,
    retry_on=(ConnectionError, TimeoutError),
)
```

**Inject sleep for tests:**

```python
sleeps = []
retry_call(fn, attempts=3, sleep=sleeps.append)
assert sleeps == [0.1, 0.2]  # no real waiting
```

## Testing

```bash
python3 -m unittest discover -s tests -v
```
