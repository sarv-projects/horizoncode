---
name: worktree-hygiene
description: Use when cleaning up repository state: inventory worktrees, stale locks, background processes, and dirty files, then propose safe cleanup and confirm before any destructive step.
---

# Worktree Hygiene (builtin.worktree-hygiene)

Inventory repository state — worktrees, stale locks, background processes, and
dirty files — and propose safe cleanup. Nothing is deleted without confirmation,
and no user work (uncommitted changes, unpushed commits, stashes) is ever removed
by surprise. Destructive steps cross the Guard and always name their exact target.

## When to use

- Disk or branch clutter is suspected after parallel or interrupted work.
- A managed run left worktrees, leases, or processes behind.
- Git reports an index or repository lock that blocks commands.
- A session wants a clean slate before starting new isolated work.

## Workflow

1. Inventory worktrees: `git worktree list --porcelain` plus a directory listing
   of each worktree root; record branch, HEAD, and dirty state per worktree.
2. Check for unmerged work before any deletion proposal: per worktree run
   `git status --porcelain`, `git log origin/<branch>..HEAD --oneline`, and
   `git stash list`. Any uncommitted or unpushed work marks the item KEEP.
3. Detect stale locks: look for index.lock, packed-refs.lock, and worktree config
   locks; confirm staleness by checking for an owning process before calling any
   lock stale. A lock held by a live process is not stale.
4. List processes and jobs tied to the repo: running dev servers, watchers, test
   runners, and background jobs from the current session. Record PIDs and start
   times; match each to a worktree path where possible.
5. Classify every item: SAFE (removable with no data loss), CONFIRM (needs user
   approval), or KEEP (holds user work). State the evidence for each class.
6. Propose cleanup as exact commands with exact targets: which worktree is pruned,
   which directory is removed, which process is stopped. No blanket glob deletions.
7. Confirm with the user before CONFIRM and KEEP-adjacent steps; destructive steps
   are executed only after explicit approval and through the Guard.
8. Execute approved steps one at a time, re-checking `git worktree list` and disk
   state after each. Stop on any unexpected dirty state.
9. Report the final state: what was removed, what was kept and why, and the
   commands to undo any reversible step.

## Output contract

- Inventory table: item, type (worktree, lock, process, stash), state, class.
- Evidence per item: dirty files, unpushed commits, or lock-owning process.
- Proposed cleanup: exact commands with exact targets and expected effect.
- Confirmation status: which steps are approved, pending, or withheld.
- Execution results: per-step command output and the final repository state.
- Undo notes: how to restore any reversible removal.

## Honesty rules

- Never delete uncommitted or unpushed user work without explicit confirmation.
- A lock is stale only when no owning process holds it; verify before removal.
- Classify from observed state (status, log, process list), never from assumption.
- Mark anything uninspectable KEEP or UNKNOWN rather than SAFE.
- Report PARTIAL when a step was refused or blocked, naming the exact item withheld.