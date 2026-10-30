"""Unit tests for retrykit.retry_call."""

from __future__ import annotations

import math
import unittest
from unittest.mock import Mock

from retrykit import retry_call


class RecordingSleep:
    """Callable sleep stub that records every delay it is asked to sleep."""

    def __init__(self):
        self.calls = []

    def __call__(self, delay):
        self.calls.append(delay)


class SuccessTests(unittest.TestCase):
    def test_returns_result_unchanged_on_first_attempt(self):
        sleep = RecordingSleep()
        result = retry_call(lambda: 42, sleep=sleep)
        self.assertEqual(result, 42)
        self.assertEqual(sleep.calls, [])

    def test_returns_result_after_retries(self):
        sleep = RecordingSleep()
        state = {"calls": 0}

        def flaky():
            state["calls"] += 1
            if state["calls"] < 3:
                raise ValueError("not yet")
            return "ok"

        result = retry_call(flaky, attempts=5, sleep=sleep)
        self.assertEqual(result, "ok")
        self.assertEqual(state["calls"], 3)
        self.assertEqual(sleep.calls, [0.1, 0.2])

    def test_defaults(self):
        sleep = RecordingSleep()
        state = {"calls": 0}

        def flaky():
            state["calls"] += 1
            if state["calls"] < 3:
                raise OSError("retry me")
            return "done"

        result = retry_call(flaky, sleep=sleep)
        self.assertEqual(result, "done")
        self.assertEqual(state["calls"], 3)
        self.assertEqual(sleep.calls, [0.1, 0.2])


class FailureTests(unittest.TestCase):
    def test_propagates_original_exception_when_all_attempts_fail(self):
        sleep = RecordingSleep()
        exc = ConnectionError("boom")

        def always_fails():
            raise exc

        with self.assertRaises(ConnectionError) as ctx:
            retry_call(always_fails, attempts=3, sleep=sleep)

        self.assertIs(ctx.exception, exc)
        self.assertEqual(sleep.calls, [0.1, 0.2])  # no sleep after final attempt

    def test_one_attempt_sleeps_never(self):
        sleep = RecordingSleep()
        exc = ValueError("nope")

        def always_fails():
            raise exc

        with self.assertRaises(ValueError):
            retry_call(always_fails, attempts=1, sleep=sleep)

        self.assertEqual(sleep.calls, [])

    def test_non_matching_exception_propagates_immediately(self):
        sleep = RecordingSleep()
        exc = TypeError("wrong kind")
        calls = 0

        def fn():
            nonlocal calls
            calls += 1
            raise exc

        with self.assertRaises(TypeError) as ctx:
            retry_call(fn, attempts=5, retry_on=(ValueError,), sleep=sleep)

        self.assertIs(ctx.exception, exc)
        self.assertEqual(calls, 1)
        self.assertEqual(sleep.calls, [])

    def test_retry_on_matches_subclasses(self):
        sleep = RecordingSleep()

        class MyError(ValueError):
            pass

        state = {"calls": 0}

        def fn():
            state["calls"] += 1
            if state["calls"] < 2:
                raise MyError("subclass")
            return "ok"

        self.assertEqual(retry_call(fn, attempts=3, retry_on=(ValueError,), sleep=sleep), "ok")
        self.assertEqual(sleep.calls, [0.1])

    def test_max_delay_caps_backoff(self):
        sleep = RecordingSleep()
        excs = [OSError("a"), OSError("b"), OSError("c"), OSError("d")]

        def fn():
            raise excs.pop()

        with self.assertRaises(OSError):
            retry_call(fn, attempts=4, initial_delay=1.0, max_delay=1.5, sleep=sleep)

        self.assertEqual(sleep.calls, [1.0, 1.5, 1.5])


class ValidationTests(unittest.TestCase):
    def _attempts_invalid(self, value, kind):
        with self.assertRaises(kind):
            retry_call(lambda: None, attempts=value)

    def test_attempts_must_be_positive_integer(self):
        for bad, kind in (
            (0, ValueError),
            (-1, ValueError),
            (True, TypeError),
            (False, TypeError),
            (2.5, TypeError),
            ("3", TypeError),
            (None, TypeError),
        ):
            with self.subTest(value=bad):
                self._attempts_invalid(bad, kind)

    def test_delays_must_be_real_non_negative_finite_numbers(self):
        bad_values = (
            -0.1,          # negative
            float("nan"),  # not finite
            float("inf"),  # not finite
            float("-inf"), # not finite
            True,          # boolean excluded
            False,         # boolean excluded
            "0.1",         # not a number
            None,          # not a number
        )
        for bad in bad_values:
            with self.subTest(value=bad):
                with self.assertRaises((TypeError, ValueError)):
                    retry_call(lambda: None, initial_delay=bad)
                with self.assertRaises((TypeError, ValueError)):
                    retry_call(lambda: None, max_delay=bad)

    def test_retry_on_validation(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: None, retry_on=[ValueError])
        with self.assertRaises(ValueError):
            retry_call(lambda: None, retry_on=())
        with self.assertRaises(TypeError):
            retry_call(lambda: None, retry_on=(ValueError, 5))
        with self.assertRaises(TypeError):
            retry_call(lambda: None, retry_on=(BaseException,))

    def test_sleep_must_be_callable(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: None, sleep="not callable")

    def test_validation_happens_before_fn_is_called(self):
        called = False

        def fn():
            nonlocal called
            called = True

        with self.assertRaises(ValueError):
            retry_call(fn, attempts=0)
        self.assertFalse(called)


class BackoffTests(unittest.TestCase):
    def test_backoff_sequence(self):
        sleep = RecordingSleep()
        excs = [ValueError("x")] * 5

        def fn():
            raise excs.pop()

        with self.assertRaises(ValueError):
            retry_call(
                fn,
                attempts=5,
                initial_delay=0.5,
                max_delay=10.0,
                sleep=sleep,
            )

        self.assertEqual(sleep.calls, [0.5, 1.0, 2.0, 4.0])

    def test_sleep_is_injected_not_time_sleep(self):
        sleep = Mock()
        with self.assertRaises(ValueError):
            retry_call(lambda: (_ for _ in ()).throw(ValueError("x")), attempts=2, sleep=sleep)
        sleep.assert_called_once_with(0.1)


if __name__ == "__main__":
    unittest.main()
