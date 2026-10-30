"""retrykit: retry a callable with bounded attempts and exponential backoff.

Public API:
    retry_call(fn, *, attempts=3, initial_delay=0.1, max_delay=2.0,
               retry_on=(Exception,), sleep=time.sleep)

The implementation uses only the Python standard library. The ``sleep``
argument is injectable so unit tests never need real delays.
"""

import math
import time
from typing import Any, Callable, Tuple, Type

__all__ = ["retry_call"]
__version__ = "0.1.0"


def _validate_attempts(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("attempts must be a positive integer")
    if value < 1:
        raise ValueError("attempts must be a positive integer")


def _validate_delay(value: Any, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a real number")
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    if value < 0:
        raise ValueError(f"{name} must be non-negative")


def _validate_retry_on(value: Any) -> None:
    if not isinstance(value, tuple):
        raise TypeError("retry_on must be a tuple of Exception subclasses")
    if not value:
        raise ValueError("retry_on must be non-empty")
    for exc in value:
        if not isinstance(exc, type) or not issubclass(exc, Exception):
            raise TypeError(
                "each item in retry_on must be an Exception subclass"
            )


def retry_call(
    fn: Callable[[], Any],
    *,
    attempts: int = 3,
    initial_delay: float = 0.1,
    max_delay: float = 2.0,
    retry_on: Tuple[Type[Exception], ...] = (Exception,),
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """Call ``fn`` (a zero-argument callable) with retries.

    Returns ``fn``'s result unchanged on success.

    ``attempts`` is the maximum TOTAL number of calls, including the
    initial call. Only exceptions matching ``retry_on`` are retried;
    non-matching exceptions propagate immediately. On the final
    permitted attempt the original exception is re-raised unchanged.

    After failed attempt ``i`` (starting at 1), sleeps for
    ``min(initial_delay * 2 ** (i - 1), max_delay)``, but only when
    another attempt will be made. ``sleep`` is injected so tests can
    substitute a recording callable and never wait on real delays.
    """
    _validate_attempts(attempts)
    _validate_delay(initial_delay, "initial_delay")
    _validate_delay(max_delay, "max_delay")
    _validate_retry_on(retry_on)

    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except retry_on:  # retry_on is a tuple of exception classes
            if attempt == attempts:
                raise  # propagate the original exception unchanged
            delay = min(initial_delay * 2 ** (attempt - 1), max_delay)
            sleep(delay)
