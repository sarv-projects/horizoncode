---
name: commit-pr
description: Use when preparing a bounded commit or PR: review the scoped diff, write a conventional message, attach test evidence, and avoid drive-by changes; never commit unless asked.
---

# Prepare a Commit or PR (builtin.commit-pr)

Prepare a bounded commit or pull request from the current work: verify the diff is
scoped to the task, write a conventional message, and attach real test evidence.
Drive-by changes are flagged, not smuggled. Nothing is committed or pushed unless
the user explicitly asked for it in this session.

## When to use

- Implementation is complete and a commit or PR must be prepared.
- A branch needs a summary of changes and evidence before review.
- A diff may contain unrelated edits that must be split out.
- A managed run finished a task and the handoff needs a commit message draft.

## Workflow

1. Enumerate changes: `git status`, `git diff`, `git diff --staged`, plus the
   untracked file list; record the exact scope as a file list. Flag anything
   ambiguous to the user before drafting so scope does not drift silently.
2. Scope audit: for each changed file, state which task requirement it serves.
   Flag any file that does not belong; propose splitting it out or reverting it.
3. Re-run the relevant tests now and capture the output; test evidence in the
   message must come from the exact tree for this commit, not an earlier run.
4. Draft a conventional commit message: `type(scope): imperative summary`, then a
   body with the why, the mechanism, and the verification commands with results.
5. Bound the diff: check for debug prints, commented-out code, generated files,
   lockfile churn unrelated to the change, and accidental formatting sweeps.
6. If the user asked to commit: stage the audited file list explicitly (never
   blind `git add -A`), then commit through the normal admission path. If they
   did not ask, stage nothing and present the draft only.
7. If a PR is requested: draft the title, body (summary, verification, risk,
   follow-ups), and the base branch; list reviewers only if the repo names them.
   Attach the evidence summary from step 3 so the reviewer sees real output.
8. Report exactly what was done: files staged, whether a commit was created, and
   the next command the user can run.

## Output contract

- Change list: files with the requirement each serves, plus flagged drive-bys.
- Test evidence: commands run and captured results from the current tree.
- Commit message: the full conventional message, ready to paste.
- PR draft: title, body sections, and base branch, when requested.
- Risk and follow-ups: known gaps and what a reviewer should scrutinize first.
- Action status: explicit statement of whether anything was staged, committed,
  or pushed.

## Honesty rules

- Never commit, tag, or push unless the user asked in this session; drafts only otherwise.
- Test evidence is captured output from this tree; never reuse or fabricate results.
- Flag every drive-by change; do not hide unrelated edits inside the summary.
- Mark unrun verification UNKNOWN and say so in the message body.
- Report PARTIAL when tests could not run, with the exact blocker named.