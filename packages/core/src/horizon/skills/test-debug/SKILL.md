---
name: test-debug
description: Use when a test fails and the agent must reproduce, classify, and fix it with a minimal repro, root cause before fix, and failing-to-passing evidence without weakening assertions.
---

# Debug a Failing Test (builtin.test-debug)

Reproduce, classify, and fix a failing test with evidence at every step. The order
is fixed: reproduce, minimize, classify, find root cause, then fix. Assertions are
never weakened and tests are never disabled. In a direct session the agent works
the failure inline; in a managed run the fix is a bounded task with its own evidence.

## When to use

- A test fails locally, in CI, or in a managed run verification step.
- A test is flaky and the flake must be characterized before any fix.
- Unexpected behavior appears even without a named failing test.
- A regression report arrives with a stack trace or a failing assertion.

## Workflow

1. Reproduce exactly: run the failing test with the exact command and capture the
   full output (assertion message, stack, exit code). Do not paraphrase the failure.
2. Minimize: reduce to the smallest failing case — single test file, single case,
   no parallel jobs. Confirm the minimal repro still fails at least 3 of 3 runs.
3. Classify before fixing: test bug (bad expectation), product bug (real defect),
   environment issue (missing service, locale, clock), flake (race, order, timing),
   or dependency drift. State the class and the evidence for it.
4. Find root cause: read the code path from the assertion to the defect; grep for
   the failing symbol; cite the exact file:line and explain the mechanism in one
   paragraph. No fix before the mechanism is understood.
5. Check coverage: if no test exercises the defective path, add one that fails now
   (red) — write it before the fix so the fix is proven, not assumed.
6. Apply the smallest fix at the root cause, not at the assertion site. Prefer the
   owning module over a workaround; route any mutation through the Guard.
7. Verify in layers: rerun the minimal repro (green), then the owning test file,
   then the package suite, then any CI-equivalent command from the repo map.
8. Audit the fix for honesty: no assertion weakened, no skip or todo added, no
   test renamed to hide the failure, no timeout inflated to mask a race.
9. For flakes, quantify: run the test N times (N >= 10 for suspected races) and
   report the pass rate before and after the fix.
10. Report evidence in both directions: the captured failing output before the
    fix, and the captured passing output after, with exact commands.

## Output contract

- Repro: exact command and captured failing output (trimmed, not paraphrased).
- Classification: one of the five classes, with the evidence that decided it.
- Root cause: file:line plus a one-paragraph mechanism explanation.
- Fix: files changed and why the fix sits at the root cause.
- Evidence: before (red) and after (green) outputs, plus suites run and results.
- Residual risk: what the fix does not cover and what to watch.

## Honesty rules

- Never claim a fix without captured passing output from a real run.
- Never weaken assertions, disable tests, add skips, or raise timeouts to pass.
- A flake is not fixed by one passing run; report the measured pass rate.
- Label any unknown cause UNKNOWN and keep the failure open rather than guessing.
- If blocked (missing service, no runner), report PARTIAL with the exact blocker
  and leave the test enabled.