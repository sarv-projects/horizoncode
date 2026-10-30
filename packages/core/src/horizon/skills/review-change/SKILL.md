---
name: review-change
description: Use when reviewing a diff or set of changed files for correctness, regressions, and architecture fit, returning prioritized findings with file:line evidence and no edits.
---

# Review a Change (builtin.review-change)

Review a diff or a set of changed files and return prioritized, actionable findings
with file:line references and evidence. This skill is read-only: it never edits
source. Reviews cover correctness first, then regression risk, then architecture
fit, in a direct session as inline feedback or in a managed run as a review task.

## When to use

- A diff, branch, or changed-file list needs review before merge or commit.
- Implementation output from a worker or subagent must be checked before integration.
- The user asks to review this change, asks whether it is safe, or requests a check.
- A release gate requires a review pass with recorded findings.

## Workflow

1. Establish the review target: `git diff`, `git diff --staged`,
   `git diff <base>...HEAD`, or an explicit file list from the user. Record the
   exact command used so the review is reproducible.
2. Read every hunk with surrounding context — never review from the diff alone.
   Open each changed file and read the functions the hunk touches.
3. Check correctness: edge cases, empty and error paths, off-by-one, resource
   cleanup, async ordering, and state mutation. Cite the failing scenario per finding.
4. Check regression risk: grep for callers of changed symbols, including exports,
   config keys, and any consumer in other packages or lanes.
5. Check architecture fit: confirm the change lands in the owning module per the
   repo rules file; flag duplicated authority or a second implementation path.
6. Check tests: are changed behaviors covered, do new tests assert real behavior,
   and is any assertion weakened, skipped, or disabled.
7. Check safety basics relevant to the change: mutation admission through the Guard,
   input validation at boundaries, and no secrets or credentials in the diff.
8. Assign severity per finding: P0 (correctness or data risk), P1 (likely
   regression or contract break), P2 (architecture, maintainability, test gap),
   P3 (nitpick).
9. Write each finding as: severity, file:line, evidence, why it matters, and a
   concrete suggested fix. Sort the list by severity, then by file order.
10. State what was not reviewed (uncovered files, generated code, unrun paths) so
    the reader knows the exact boundary of this review.

## Output contract

- Verdict line: APPROVE, APPROVE-WITH-NITS, or REQUEST-CHANGES, plus one rationale.
- Findings: severity, file:line, evidence, impact, suggested fix — highest first.
- Test gaps: behaviors in the diff with no covering test.
- Not reviewed: files, paths, or behaviors explicitly outside this pass.
- Positives: at most three, and only where they inform future work.

## Honesty rules

- Every finding cites code actually read this session; no findings from memory.
- Do not claim the change works — only that the reviewed evidence supports or
  contradicts specific behavior.
- Label anything unexamined UNKNOWN rather than implying full coverage.
- Style opinions are findings only when they cause bugs, drift, or rule violations.
- If the diff could not be read (binary, too large, missing base), report PARTIAL
  with the reason instead of guessing.