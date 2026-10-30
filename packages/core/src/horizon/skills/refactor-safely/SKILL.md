---
name: refactor-safely
description: Use when a behavior-preserving refactor is needed: inventory call sites, plan small verifiable steps, prove behavior with tests before and after, and never mix in feature work.
---

# Refactor Safely (builtin.refactor-safely)

Execute a behavior-preserving refactor with impact analysis first and verification
at every step. Call sites are inventoried before any edit, the baseline is proven
with tests, and each step is small enough to verify alone. Feature work is never
mixed into a refactor diff, and every mutation crosses the same Guard admission.

## When to use

- Code must be restructured with no intended behavior change.
- A module needs renaming, moving, or interface reshaping before feature work.
- Technical debt blocks a feature and the cleanup must be isolated in its own diff.
- A large change needs mechanical steps split from semantic ones.

## Workflow

1. Define the behavior baseline: run the existing tests covering the target area
   and record results. If coverage is missing, add characterization tests first
   and prove they pass before refactoring.
2. Inventory call sites: grep every symbol to be changed across the repo, including
   exports, dynamic references, string-based lookups, and config-driven wiring.
3. Map the public surface: what is exported, which packages consume it, and which
   tests assert on names, serialization, or file layout.
4. Plan ordered steps: each step is one mechanical change (rename, move, extract,
   inline) that leaves the tree green on its own. Order from lowest to highest blast.
5. Execute one step, then immediately run the focused tests for that area. Do not
   batch multiple steps before verification; a red result must localize the fault.
6. Keep the diff mechanical: never combine renames with logic changes, never
   reformat unrelated lines, and never fix drive-by bugs in the same commit.
7. Route each mutation through the Guard; if a step needs a permission the session
   lacks, stop that step and report the blocker instead of working around it.
8. After all steps: run the full related suite, then the repo-wide test and build
   commands from the repo map. Compare against the recorded baseline.
9. Diff audit before finishing: confirm every changed line serves the refactor,
   list any line that does not, and revert drive-by edits.
10. Report the refactor summary with before and after behavior evidence and the
    exact command outputs that prove equivalence.

## Output contract

- Baseline: tests run before, with results.
- Call-site inventory: symbols, counts, and consumer locations.
- Steps: the ordered list with per-step verification results.
- Diff summary: files changed, net line delta, and confirmation of mechanical scope.
- Verification: baseline-versus-final test comparison with exact commands.
- Rollback: how to revert (single commit or a step range).

## Honesty rules

- Behavior preservation is a claim that requires test evidence, not intent.
- If any behavior change is discovered mid-refactor, stop and report it; never
  silently preserve or discard it.
- Never mix feature work into a refactor; a mixed diff is reported, not merged.
- Mark any unverifiable equivalence UNKNOWN rather than claiming parity.
- Report PARTIAL when a step is blocked, naming the exact step and prerequisite.