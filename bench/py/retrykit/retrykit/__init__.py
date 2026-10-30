"""retrykit: small, dependency-free retry with exponential backoff."""

from __future__ import annotations

import math
import time

__all__ = ["retry_call"]

__version__ = "1.0.0"


def retry_call(
    fn,
    *,
    attempts=3,
    initial_delay=0.1,
    max_delay=2.0,
    retry_on=(Exception,),
    sleep=time.sleep,
):
    """Call zero-argument ``fn``, retrying with exponential backoff.

    ``attempts`` is the maximum TOTAL number of calls, including the initial
    call. After failed attempt ``i`` (starting at 1), ``sleep`` is invoked
    once with ``min(initial_delay * 2 ** (i - 1), max_delay)``, but only
    when another attempt will be made.

    Only exceptions matching ``retry_on`` are retried; non-matching
    exceptions propagate immediately. When the final permitted attempt
    fails, its original exception is propagated unchanged (never wrapped).

    ``sleep`` is injected so unit tests never need real delays.
    """
    _validate_arguments(attempts, initial_delay, max_delay, retry_on, sleep)

    last_exception = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except retry_on as exc:
            last_exception = exc
            if attempt == attempts:
                raise
            delay = min(initial_delay * 2 ** (attempt - 1), max_delay)
            sleep(delay)
    # Unreachable: attempts >= 1, and the final attempt always returns or raises.
    raise last_exception  # pragma: no cover


def _is_real_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_arguments(attempts, initial_delay, max_delay, retry_on, sleep):
    if isinstance(attempts, bool) or not isinstance(attempts, int):
        raise TypeError("attempts must be an integer")
    if attempts < 1:
        raise ValueError("attempts must be a positive integer")

    for name, value in (("initial_delay", initial_delay), ("max_delay", max_delay)):
        if not _is_real_number(value):
            raise TypeError(f"{name} must be a real number")
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        if value < 0:
            raise ValueError(f"{name} must be non-negative")

    if not isinstance(retry_on, tuple):
        raise TypeError("retry_on must be a tuple of Exception subclasses")
    if not retry_on:
        raise ValueError("retry_on must be non-empty")
    for exc in retry_on:
        if not isinstance(exc, type) or not issubclass(exc, Exception):
            raise TypeError("retry_on must contain only Exception subclasses")

    if not callable(sleep):
        raise TypeError("sleep must be callable")
