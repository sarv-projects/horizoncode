#!/usr/bin/env python3
"""Independent acceptance check for the `retrykit` deliverable.

Read-only: it imports the package the agent produced and exercises the public
contract from the task statement. It never writes into the arena.

    python3 scripts/e2e/py-hidden/check_retrykit.py bench/py/retrykit
"""
from __future__ import annotations

import ast
import inspect
import math
import os
import sys
import time
import traceback

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print("CHECK %-42s %s %s" % (name, "PASS" if ok else "FAIL", detail))


def check(name: str):
    """Run the decorated check immediately and record its verdict."""

    def deco(fn):
        try:
            fn()
        except AssertionError as exc:
            record(name, False, str(exc)[:300])
        except Exception as exc:  # noqa: BLE001
            record(name, False, "%s: %s" % (type(exc).__name__, exc))
        else:
            record(name, True)
        return fn

    return deco


def expect_value_error(fn, label):
    """A bad argument must be rejected up front. The task does not pin the
    exception type, so either ValueError or TypeError is accepted."""
    try:
        fn()
    except (ValueError, TypeError):
        return
    except Exception as exc:  # noqa: BLE001
        raise AssertionError("%s raised %s, expected ValueError or TypeError" % (label, type(exc).__name__))
    raise AssertionError("%s did not raise" % label)


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, delay):
        self.calls.append(delay)


def import_retrykit(arena: str):
    """Locate retrykit anywhere in the arena and import it."""
    candidates = []
    for base, dirs, files in os.walk(arena):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv", "node_modules")]
        for d in list(dirs):
            if os.path.isfile(os.path.join(base, d, "__init__.py")) and d == "retrykit":
                candidates.append(base)
    if not candidates:
        raise SystemExit("FATAL no retrykit/__init__.py found under %s" % arena)
    candidates.sort(key=lambda p: (len(p.split(os.sep)), p))
    sys.path.insert(0, candidates[0])
    import retrykit  # noqa: PLC0415

    return retrykit, candidates[0]


def main() -> int:
    arena = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "bench/py/retrykit")
    retrykit, syspath = import_retrykit(arena)
    from retrykit import retry_call  # noqa: PLC0415

    print("INFO arena=%s syspath_added=%s module=%s" % (arena, syspath, retrykit.__file__))

    # ---- requirement 1: public signature -----------------------------------
    @check("r1.signature")
    def _():
        sig = inspect.signature(retry_call)
        names = list(sig.parameters)
        expected = ["fn", "attempts", "initial_delay", "max_delay", "retry_on", "sleep"]
        assert names == expected, "parameter order/names %r != %r" % (names, expected)
        for name in expected[1:]:
            p = sig.parameters[name]
            assert p.kind is inspect.Parameter.KEYWORD_ONLY, "%s is not keyword-only" % name
        assert sig.parameters["attempts"].default == 3, "attempts default %r" % (sig.parameters["attempts"].default,)
        assert float(sig.parameters["initial_delay"].default) == 0.1, "initial_delay default %r" % (sig.parameters["initial_delay"].default,)
        assert float(sig.parameters["max_delay"].default) == 2.0, "max_delay default %r" % (sig.parameters["max_delay"].default,)
        assert sig.parameters["retry_on"].default == (Exception,), "retry_on default %r" % (sig.parameters["retry_on"].default,)
        assert sig.parameters["sleep"].default is time.sleep, "sleep default is not time.sleep"

    @check("r1.all_exports_retry_call")
    def _():
        exported = getattr(retrykit, "__all__", None)
        if exported is None:
            print("INFO retrykit.__all__ is absent (retry_call is still importable)")
            return
        assert "retry_call" in list(exported), "__all__ = %r" % (exported,)

    # ---- requirement 2: result unchanged -----------------------------------
    @check("r2.result_identity")
    def _():
        sentinel = object()
        calls = []

        def fn():
            calls.append(1)
            return sentinel

        got = retry_call(fn, sleep=Recorder())
        assert got is sentinel, "returned a different object"
        assert len(calls) == 1, "called %d times" % len(calls)

    @check("r2.value_passthrough")
    def _():
        for value in (0, "", None, [], {"a": 1}):
            def fn(v=value):
                return v
            assert retry_call(fn, sleep=Recorder()) == value

    # ---- requirement 3: attempts is TOTAL --------------------------------
    @check("r3.attempts_is_total_budget")
    def _():
        for budget in (1, 2, 3, 7):
            calls = []

            def fn():
                calls.append(1)
                raise ValueError("boom")

            try:
                retry_call(fn, attempts=budget, sleep=Recorder())
            except ValueError:
                pass
            else:
                raise AssertionError("attempts=%d did not raise" % budget)
            assert len(calls) == budget, "attempts=%d made %d calls" % (budget, len(calls))

    @check("r3.attempts_rejects_bool_and_junk")
    def _():
        def fn():
            return 1

        for bad in (True, False, 0, -1, 2.0, "3", None, 3.5):
            expect_value_error(lambda b=bad: retry_call(fn, attempts=b, sleep=Recorder()), "attempts=%r" % (bad,))

    # ---- requirement 4: filtering + original exception -------------------
    @check("r4.non_matching_propagates_immediately")
    def _():
        calls = []

        def fn():
            calls.append(1)
            raise KeyError("nope")

        try:
            retry_call(fn, attempts=5, retry_on=(ValueError,), sleep=Recorder())
        except KeyError:
            pass
        else:
            raise AssertionError("KeyError did not propagate")
        assert len(calls) == 1, "made %d calls for a non-matching exception" % len(calls)

    @check("r4.final_exception_identity")
    def _():
        raised = []

        def fn():
            exc = ValueError("final-%d" % len(raised))
            raised.append(exc)
            raise exc

        try:
            retry_call(fn, attempts=4, sleep=Recorder())
        except ValueError as caught:
            assert caught is raised[-1], "propagated exception is not the original object"
            assert str(caught) == "final-3", "propagated str=%r" % str(caught)
        else:
            raise AssertionError("no exception propagated")
        assert len(raised) == 4, "made %d calls" % len(raised)

    @check("r4.isinstance_matching")
    def _():
        calls = []

        def fn():
            calls.append(1)
            raise KeyError("x")

        try:
            retry_call(fn, attempts=3, retry_on=(LookupError,), sleep=Recorder())
        except KeyError:
            pass
        else:
            raise AssertionError("no raise")
        assert len(calls) == 3, "LookupError did not match KeyError (%d calls)" % len(calls)

    @check("r4.base_exceptions_not_swallowed")
    def _():
        calls = []

        def fn():
            calls.append(1)
            raise KeyboardInterrupt()

        try:
            retry_call(fn, attempts=3, sleep=Recorder())
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("KeyboardInterrupt swallowed")
        assert len(calls) == 1, "retried a KeyboardInterrupt"

    @check("r4.success_after_retry_returns_value")
    def _():
        calls = []

        def fn():
            calls.append(1)
            if len(calls) < 3:
                raise ValueError("x")
            return "ok"

        assert retry_call(fn, attempts=5, sleep=Recorder()) == "ok"
        assert len(calls) == 3, "made %d calls" % len(calls)

    # ---- requirement 5: exponential schedule ----------------------------
    @check("r5.backoff_schedule_capped")
    def _():
        rec = Recorder()

        def fn():
            raise ValueError("x")

        try:
            retry_call(fn, attempts=6, initial_delay=0.1, max_delay=0.5, sleep=rec)
        except ValueError:
            pass
        assert rec.calls == [0.1, 0.2, 0.4, 0.5, 0.5], "schedule %r" % (rec.calls,)

    @check("r5.no_sleep_after_final_attempt")
    def _():
        rec = Recorder()

        def fn():
            raise ValueError("x")

        try:
            retry_call(fn, attempts=3, initial_delay=0.01, max_delay=10.0, sleep=rec)
        except ValueError:
            pass
        assert len(rec.calls) == 2, "slept %d times for 3 attempts" % len(rec.calls)

    @check("r5.no_sleep_on_success_or_single_attempt")
    def _():
        rec = Recorder()
        retry_call(lambda: 1, attempts=3, sleep=rec)
        assert rec.calls == [], "slept on immediate success"
        raised = []

        def fn():
            raised.append(1)
            raise ValueError("x")

        try:
            retry_call(fn, attempts=1, sleep=rec)
        except ValueError:
            pass
        assert rec.calls == [], "slept with attempts=1"
        assert len(raised) == 1

    # ---- requirement 6: argument validation -----------------------------
    @check("r6.delay_validation")
    def _():
        def fn():
            return 1

        for kw in ("initial_delay", "max_delay"):
            for bad in (True, False, -0.1, -1, float("inf"), float("-inf"), float("nan"), "1", None):
                expect_value_error(lambda k=kw, b=bad: retry_call(fn, sleep=Recorder(), **{k: b}), "%s=%r" % (kw, bad))

    @check("r6.retry_on_validation")
    def _():
        def fn():
            return 1

        for bad in ((), [], ValueError, (ValueError, "x"), (object(),), (1,), (BaseException,), None, (Exception, Exception)):
            if bad == (Exception, Exception):
                continue  # a redundant but legal tuple
            expect_value_error(lambda b=bad: retry_call(fn, retry_on=b, sleep=Recorder()), "retry_on=%r" % (bad,))

    @check("r6.fn_must_be_callable")
    def _():
        for bad in (None, 1, "fn"):
            expect_value_error(lambda b=bad: retry_call(b, sleep=Recorder()), "fn=%r" % (bad,))

    @check("r6.sleep_must_be_callable")
    def _():
        for bad in (None, 1, "sleep"):
            expect_value_error(lambda b=bad: retry_call(lambda: 1, sleep=b), "sleep=%r" % (bad,))

    @check("r6.zero_delay_allowed")
    def _():
        rec = Recorder()
        calls = []

        def fn():
            calls.append(1)
            raise ValueError("x")

        try:
            retry_call(fn, attempts=3, initial_delay=0, max_delay=0, sleep=rec)
        except ValueError:
            pass
        assert rec.calls == [0, 0], "schedule %r" % (rec.calls,)

    # ---- requirement 7: injectable sleep ---------------------------------
    @check("r7.real_sleep_not_used")
    def _():
        original = time.sleep
        calls = []

        def tripwire(_seconds):
            calls.append(_seconds)

        time.sleep = tripwire
        try:
            def fn():
                raise ValueError("x")

            try:
                retry_call(fn, attempts=3, initial_delay=0.001, sleep=Recorder())
            except ValueError:
                pass
        finally:
            time.sleep = original
        assert calls == [], "the library called time.sleep directly: %r" % (calls,)

    # ---- requirement 8: stdlib only --------------------------------------
    @check("r8.no_third_party_imports")
    def _():
        stdlib = set(sys.stdlib_module_names)
        offenders = []
        for base, dirs, files in os.walk(arena):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv", "node_modules")]
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(base, name)
                tree = ast.parse(open(path, encoding="utf-8", errors="replace").read(), filename=path)
                for node in ast.walk(tree):
                    mods = []
                    if isinstance(node, ast.Import):
                        mods = [a.name.split(".")[0] for a in node.names]
                    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                        mods = [node.module.split(".")[0]]
                    for mod in mods:
                        if mod in stdlib or mod in ("retrykit",):
                            continue
                        offenders.append("%s:%s" % (os.path.relpath(path, arena), mod))
        assert not offenders, "non-stdlib imports: %s" % offenders[:8]

    # ---- requirement 9: packaging + docs ---------------------------------
    @check("r9.readme_documents_behaviour")
    def _():
        readme = None
        for base, _dirs, files in os.walk(arena):
            for name in files:
                if name.lower().startswith("readme"):
                    readme = os.path.join(base, name)
                    break
            if readme:
                break
        assert readme, "no README"
        text = open(readme, encoding="utf-8", errors="replace").read()
        lowered = text.lower()
        assert "retry_call" in text, "README does not show retry_call"
        assert len(text) > 600, "README is %d chars" % len(text)
        assert "attempt" in lowered, "README does not document attempts"
        assert "backoff" in lowered or "exponential" in lowered or "delay" in lowered, "README does not document delays"

    @check("r9.pyproject_present_and_sane")
    def _():
        path = os.path.join(arena, "pyproject.toml")
        assert os.path.isfile(path), "pyproject.toml missing"
        text = open(path, encoding="utf-8", errors="replace").read()
        assert "retrykit" in text, "pyproject does not name the package"
        assert "dependencies" not in text or "dependencies = []" in text or "dependencies=[]" in text, \
            "pyproject declares dependencies: %r" % [l for l in text.splitlines() if "dependencies" in l]

    @check("r9.tests_are_unittest")
    def _():
        found = []
        for base, dirs, files in os.walk(arena):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv")]
            for name in files:
                if name.startswith("test") and name.endswith(".py"):
                    found.append(os.path.join(base, name))
        assert found, "no test modules"
        joined = "".join(open(p, encoding="utf-8", errors="replace").read() for p in found)
        assert "unittest" in joined, "tests do not use unittest"
        assert "TestCase" in joined, "tests do not define TestCase"
        assert "sleep" in joined, "tests do not inject a fake sleep"

    @check("r10.no_junk_left_behind")
    def _():
        junk = []
        for base, dirs, files in os.walk(arena):
            rel = os.path.relpath(base, arena)
            for d in dirs:
                if d in ("__pycache__", ".venv", "venv", "node_modules", "build", "dist", ".pytest_cache", ".mypy_cache"):
                    junk.append(os.path.join(rel, d))
            for name in files:
                if name.endswith((".pyc", ".orig", ".rej", ".bak", ".tmp", ".log")) or name in (".DS_Store",):
                    junk.append(os.path.join(rel, name))
        assert not junk, "leftover junk: %s" % junk[:10]

    # ---- summary ---------------------------------------------------------
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = len(RESULTS) - passed
    print("")
    print("RETRYKIT_CHECKS=%d" % len(RESULTS))
    print("RETRYKIT_PASS=%d" % passed)
    print("RETRYKIT_FAIL=%d" % failed)
    for name, ok, detail in RESULTS:
        if not ok:
            print("RETRYKIT_FINDING %s :: %s" % (name, detail))
    print("RETRYKIT=%s" % ("VERIFIED" if failed == 0 else "PARTIAL"))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("RETRYKIT=HARNESS_ERROR")
        sys.exit(3)
