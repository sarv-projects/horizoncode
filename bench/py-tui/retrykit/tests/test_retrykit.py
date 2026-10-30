"""Comprehensive unittest suite for retrykit.retry_call."""

import math
import unittest

from retrykit import retry_call


def _raiser(exc):
    """Return a zero-argument callable that raises ``exc``."""

    def fn():
        raise exc

    return fn


class SuccessBehaviorTests(unittest.TestCase):
    def test_successful_call_returns_result_unchanged(self):
        sentinel = object()

        def fn():
            return sentinel

        self.assertIs(retry_call(fn), sentinel)

    def test_none_result_returned_unchanged(self):
        self.assertIsNone(retry_call(lambda: None))

    def test_fn_called_once_on_success_no_sleep(self):
        calls = []
        sleeps = []

        def fn():
            calls.append(1)
            return "ok"

        self.assertEqual(retry_call(fn, sleep=sleeps.append), "ok")
        self.assertEqual(calls, [1])
        self.assertEqual(sleeps, [])


class RetryBehaviorTests(unittest.TestCase):
    def test_retries_then_succeeds(self):
        calls = {"n": 0}

        def fn():
            calls["n"] += 1
            if calls["n"] < 3:
                raise ValueError("try again")
            return "ok"

        self.assertEqual(retry_call(fn, attempts=3, sleep=lambda d: None), "ok")
        self.assertEqual(calls["n"], 3)

    def test_exhausts_attempts_raises_original_exception(self):
        original = ValueError("final failure")
        with self.assertRaises(ValueError) as caught:
            retry_call(_raiser(original), attempts=3, sleep=lambda d: None)
        # The propagated exception is the original object, unchanged.
        self.assertIs(caught.exception, original)

    def test_attempts_counts_initial_call(self):
        calls = []

        def fn():
            calls.append(None)
            raise RuntimeError("always")

        with self.assertRaises(RuntimeError):
            retry_call(fn, attempts=4, sleep=lambda d: None)
        self.assertEqual(len(calls), 4)

    def test_attempts_one_single_call_no_sleep_on_failure(self):
        sleeps = []
        with self.assertRaises(ValueError):
            retry_call(_raiser(ValueError("x")), attempts=1, sleep=sleeps.append)
        self.assertEqual(sleeps, [])

    def test_non_matching_exception_propagates_immediately(self):
        calls = []

        def fn():
            calls.append(None)
            raise TypeError("fatal")

        with self.assertRaises(TypeError):
            retry_call(fn, attempts=5, retry_on=(ValueError,), sleep=lambda d: None)
        self.assertEqual(len(calls), 1)  # no retries

    def test_only_matching_exceptions_are_retried(self):
        calls = []

        def fn():
            calls.append(None)
            if len(calls) == 1:
                raise TypeError("fatal")
            if len(calls) == 2:
                raise ValueError("retry me")
            return "done"

        with self.assertRaises(TypeError):
            retry_call(fn, attempts=3, retry_on=(ValueError,), sleep=lambda d: None)
        self.assertEqual(len(calls), 1)

    def test_multiple_retry_on_classes(self):
        calls = {"n": 0}

        def fn():
            calls["n"] += 1
            if calls["n"] == 1:
                raise KeyError("a")
            if calls["n"] == 2:
                raise ValueError("b")
            return "ok"

        self.assertEqual(
            retry_call(fn, attempts=3, retry_on=(KeyError, ValueError),
                       sleep=lambda d: None),
            "ok",
        )
        self.assertEqual(calls["n"], 3)


class BackoffTests(unittest.TestCase):
    def test_exponential_backoff_sequence(self):
        sleeps = []
        with self.assertRaises(ValueError):
            retry_call(
                _raiser(ValueError("x")),
                attempts=5,
                initial_delay=0.1,
                max_delay=2.0,
                sleep=sleeps.append,
            )
        # Sleeps after attempts 1..4; none after the final attempt.
        self.assertEqual(sleeps, [0.1, 0.2, 0.4, 0.8])

    def test_delay_capped_at_max_delay(self):
        sleeps = []
        with self.assertRaises(ValueError):
            retry_call(
                _raiser(ValueError("x")),
                attempts=4,
                initial_delay=1.0,
                max_delay=1.0,
                sleep=sleeps.append,
            )
        self.assertEqual(sleeps, [1.0, 1.0, 1.0])

    def test_delay_capping_with_large_initial_delay(self):
        sleeps = []
        with self.assertRaises(ValueError):
            retry_call(
                _raiser(ValueError("x")),
                attempts=3,
                initial_delay=30.0,
                max_delay=1.5,
                sleep=sleeps.append,
            )
        self.assertEqual(sleeps, [1.5, 1.5])

    def test_zero_delays_sleep_zero(self):
        sleeps = []
        with self.assertRaises(ValueError):
            retry_call(
                _raiser(ValueError("x")),
                attempts=3,
                initial_delay=0.0,
                max_delay=0.0,
                sleep=sleeps.append,
            )
        self.assertEqual(sleeps, [0.0, 0.0])


class ValidationTests(unittest.TestCase):
    def test_attempts_rejects_bool(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, attempts=True)
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, attempts=False)

    def test_attempts_rejects_non_int(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, attempts=3.0)
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, attempts="3")
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, attempts=None)

    def test_attempts_rejects_zero_and_negative(self):
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, attempts=0)
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, attempts=-5)

    def test_delay_rejects_negative(self):
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, initial_delay=-0.1)
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, max_delay=-1.0)

    def test_delay_rejects_non_finite(self):
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, initial_delay=float("nan"))
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, initial_delay=float("inf"))
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, max_delay=float("-inf"))

    def test_delay_rejects_bool_and_non_number(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, initial_delay=True)
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, max_delay="0.5")
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, max_delay=None)

    def test_zero_delays_are_valid(self):
        retry_call(lambda: 1, attempts=1, initial_delay=0, max_delay=0,
                   sleep=lambda d: None)

    def test_retry_on_rejects_empty_tuple(self):
        with self.assertRaises(ValueError):
            retry_call(lambda: 1, retry_on=())

    def test_retry_on_rejects_non_tuple(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=[ValueError])
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=ValueError)
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on="ValueError")

    def test_retry_on_rejects_non_class_items(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=(ValueError, "not a class"))
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=(ValueError, None))

    def test_retry_on_rejects_base_exception_subclasses(self):
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=(BaseException,))
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=(KeyboardInterrupt,))
        with self.assertRaises(TypeError):
            retry_call(lambda: 1, retry_on=(object,))

    def test_retry_on_accepts_exception_subclasses(self):
        retry_call(lambda: 1, retry_on=(ValueError, TypeError, OSError),
                   sleep=lambda d: None)


class InjectionTests(unittest.TestCase):
    def test_custom_sleep_receives_each_delay(self):
        delays = []

        def fn():
            raise ValueError("x")

        with self.assertRaises(ValueError):
            retry_call(fn, attempts=4, initial_delay=0.5, max_delay=10.0,
                       sleep=delays.append)
        self.assertEqual(delays, [0.5, 1.0, 2.0])

    def test_default_sleep_is_time_sleep(self):
        import inspect
        import time

        signature = inspect.signature(retry_call)
        self.assertIs(signature.parameters["sleep"].default, time.sleep)


if __name__ == "__main__":
    unittest.main()
