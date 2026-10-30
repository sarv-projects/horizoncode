---
name: context-recovery
description: Use when session context is under pressure or was compacted: inspect usage, recommend trim, prune, compact, or clear actions, and list what to reload afterward without fabricating history.
---

# Context Recovery (builtin.context-recovery)

Inspect session context pressure and recommend the right operation — trim, prune,
compact, or clear — then define exactly what to reload afterward. After any
compaction, in-flight state is rebuilt from files and tool output, never from
assumed memory. This applies in a direct session and at managed-run resume points.

## When to use

- The session is long, tool outputs are large, or responses slow from context load.
- A compaction just happened and work must resume without losing state.
- The agent cannot recall earlier decisions and must re-anchor honestly.
- A fresh session must resume from a handoff file instead of transcript memory.

## Workflow

1. Inspect pressure: use the context ledger, activity view, or available context
   tools to get current usage and the largest consumers (file reads, tool output,
   pasted logs, subagent returns).
2. Classify what is recoverable from disk versus what exists only in the
   transcript: file contents and git state are recoverable; decisions and TODOs
   may not be.
3. Capture a pre-operation digest while it is still available: active goal or
   task, branch and dirty state, running background jobs, in-flight todos, open
   questions, and the exact next action. Keep it under 15 lines.
4. Recommend one operation with rationale: trim (drop old tool output), prune
   (remove stale files from context), compact (summarize and continue), or clear
   (fresh session, resume from files). Prefer the least destructive option that
   relieves the pressure.
5. Define the reload set for after the operation: rules file, handoff digest,
   active plan or ledger, the two or three files being edited, and any failing
   test output.
6. Execute the recommended operation only if the user or the lane asks for it;
   this skill diagnoses by default.
7. After the operation, verify the reload: re-read the digest, re-check git
   status and the job list, and confirm each reloaded claim against a file or
   command output.
8. Re-anchor: restate what is known from verification, what is UNKNOWN, and the
   next concrete action. Never restate forgotten details as recalled facts.

## Output contract

- Pressure summary: usage level and the top context consumers with sizes.
- Recoverability: what can be rebuilt from disk versus what only lived in transcript.
- Recommendation: trim, prune, compact, or clear, each with cost and rationale.
- Digest: the under-15-line pre-operation handoff block.
- Reload set: the exact files, commands, and outputs to read afterward.
- Post-operation checks: the commands that prove the reload is real.

## Honesty rules

- Never fabricate recalled history; anything not re-verified is UNKNOWN.
- The digest must contain only facts visible now (files, git, jobs), not guesses.
- Do not delete user data or files as part of a context operation.
- Recommendations are advisory: the operation runs only when the user or lane asks.
- After compaction, re-check status claims against source before relying on them.