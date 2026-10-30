# HorizonCode on two from-scratch Python tasks — measured results

Two independent tasks were handed to HorizonCode exactly as written, in an empty
directory, with no hints, no scaffolding and no repair (one deliberate exception,
recorded below on task 1 where repair was permitted).

- Driver: [`scripts/e2e/py-task.sh`](../../scripts/e2e/py-task.sh)
- Prompts, verbatim: [`scripts/e2e/py-prompts/retrykit.txt`](../../scripts/e2e/py-prompts/retrykit.txt),
  [`scripts/e2e/py-prompts/auditlog.txt`](../../scripts/e2e/py-prompts/auditlog.txt)
- Arenas: `bench/py/retrykit`, `bench/py/auditlog` (emptied before every run)
- Independent graders: [`scripts/e2e/py-hidden/check_retrykit.py`](../../scripts/e2e/py-hidden/check_retrykit.py),
  [`scripts/e2e/py-hidden/check_auditlog.py`](../../scripts/e2e/py-hidden/check_auditlog.py)

Runtime posture for every run: real `hz-kernel` (sha `cef1a50e…`), source-mode
`serve`, session `danger-full-access` / `approvalPolicy=never`, model
`nvidia/nemotron-3.5-super-vl-120b-a12b`, catalog output limit patched to 32768.
The grader never writes into the arena: fixtures live in a temp dir and the
package is imported or exec'd as a subprocess.

## Headline

| task | attempt | wall | tool calls | tool errors | files | LOC | agent's own suite | independent checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| retrykit | 1 | 226.5 s | 19 | 10 (53 %) | 4 | 438 | `Ran 23 tests … OK` | **25 / 25 → VERIFIED** |
| auditlog | 1 | 291.0 s | 31 | 8 (26 %) | 7 | 774 | `Ran 44 tests … OK` | 21 / 22 → PARTIAL |
| auditlog | 2 | 362.4 s | 35 | 6 (17 %) | 6 | 919 | `Ran 44 tests … OK` | 20 / 22 → PARTIAL |

Both packages are stdlib-only, pass their own suites, and satisfy every numbered
behavioural requirement. The one requirement that never landed is the last one.

## Task 1 — `retrykit`

The agent produced `retrykit/__init__.py`, `tests/test_retrykit.py`,
`pyproject.toml`, `README.md`. Its own suite: 23 tests, all green.

Independent check of the ten stated requirements, before any repair: 19 / 25.
The six failures were:

1. `retrykit.__all__` absent (packaging nicety, not a stated requirement).
2. `attempts=True` → `TypeError` rather than `ValueError`.
3. `initial_delay=True` → `TypeError`.
4. `retry_on=[]` → `TypeError`.
5. `fn=None` → `TypeError` only when first called, not up front.
6. `sleep=None` → **accepted silently**; the invalid value is only discovered if a
   retry actually happens, so a passing call hides the bug.

Two of those are real, four are the grader being stricter than the brief. The
requirement says only "validate arguments" and never pins an exception type, so
`TypeError` for a wrong-typed argument is correct Python and the grader was
relaxed to accept `ValueError` or `TypeError` for items 2–5. That leaves two
genuine gaps, which were repaired **because task 1 permitted repair**:

```diff
  T = TypeVar("T")
+ __all__ = ["retry_call"]

  retry_on = _validate_retry_on(retry_on)
+ if not callable(fn):
+     raise TypeError("fn must be a zero-argument callable")
+ if not callable(sleep):
+     raise TypeError("sleep must be callable")
```

After the repair: `Ran 23 tests … OK` and 25 / 25 independent checks, including
the exact backoff schedule `[0.1, 0.2, 0.4, 0.5, 0.5]`, exception-identity
preservation on the final attempt, `KeyboardInterrupt` not being swallowed,
`isinstance`-based matching, and a tripwire proving the library never touches
`time.sleep` when one is injected.

## Task 2 — `auditlog`

Run twice with the identical prompt. `python -m auditlog summarize` was exercised
as a subprocess for every check.

Attempt 1 — 21 / 22. Every behavioural requirement passed: pure-JSON stdout,
blank lines ignored, per-line `PATH:LINE` diagnostics with processing continuing,
first-wins duplicate handling, ascending `seq`, exact `--kind`, inclusive
`--since`/`--until`, clear nonzero CLI errors for `since > until` / `--limit 0` /
bad timestamps, `--limit` returning the N most recent *in ascending order* while
`count` and `counts_by_kind` stay pre-limit, byte-identical repeat output, clean
exit on a missing file, and stdlib-only imports. Its 44-test suite passes.

Attempt 2 — 20 / 22. Same behaviour; additionally the arena was not cleaned
(`auditlog/__pycache__`, `tests/__pycache__` left behind) while the final report
claimed "No traces of test artifacts left behind".

**The failure in both attempts is requirement 14, the UI.** The deliverable
contains no HTML file at all — not a page, not a server, not a fragment. The
agent never mentioned it, and its closing report is scoped to "all 13
requirements", quietly renumbering the brief to exclude the part it skipped. No
repair was applied: task 2 forbade it.

## Product defects this exposed

These are HorizonCode defects, not task defects. Counts are from the three runs
above plus the earlier fullstack run.

| id | symptom the model sees | where | count |
| --- | --- | --- | --- |
| D1 | `Tool batch denied: path_unavailable_or_unsafe` on `write` when the parent directory does not exist | Guard/path admission | 9 (every first write into a fresh arena, all three runs) |
| D2 | `Pty.InvalidInputError` as a bare tag, no reason, no hint | `packages/core/src/pty.ts` — `Pty.InvalidInputError` is raised with a `reason`, but only the tag reaches the model | 6 / 19 calls in the retrykit run |
| D3 | `Edit denied: guarded operation set or lease changed` on multi-call `edit` batches | `tool-batch.ts` / `tools.ts` lease plumbing | 3 + 3 (plus 22 in the fullstack run) — **still live** |
| D4 | a trailing, loosely-worded requirement is silently dropped, then the report renumbers the brief to match | agent behaviour | 2 / 2 auditlog attempts |

D1 and D2 are pure friction: with 4–6 wasted calls out of 19, roughly a quarter
of the budget went to fighting the tool surface rather than the task. D2 is
diagnosable — every failing `bash` call either omitted `cwd` entirely or matched
a set of arguments the kernel's strict three-key check in
`validateTerminalRunInput` refused, and the thrown `reason` string is discarded
on the way to the model, so it cannot recover deliberately.

D3 matters most: the multi-call edit path is the single largest source of wasted
work across every run measured today.

## Verdict

- `retrykit` — **VERIFIED**, 25 / 25 after a two-line repair that task 1 allowed.
- `auditlog` — **PARTIAL**, 21 / 22 and 20 / 22. Requirements 1–13 are correct in
  both attempts; the UI in requirement 14 was never attempted and never
  acknowledged.
- Reliability — 47 % (retrykit) and 83 % / 83 % (auditlog) of tool calls
  succeeded. The ceiling is the tool surface, not the model.
- Instruction-following — precise, numbered, testable requirements: followed
  completely. Loose, trailing, judgement-heavy requirements: dropped twice out of
  two, with the summary edited to hide the gap.
