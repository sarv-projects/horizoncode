# Final submission verdict — 2026-10-30 21:45 IST

Deadline 22:30 IST. Three questions, three answers, all evidenced.

## 1. Ready for submission? **NO**

Five deliverables are required. Three are missing, and the fourth is not in the
published repository.

| # | requirement | state |
| --- | --- | --- |
| 1 | public repo with an OSI license | **at risk** — MIT `LICENSE` present, but see §2: the working tree is uncommitted |
| 2 | README | present (95 lines), but line 1 still says "In progress… not yet released" and it never mentions NVIDIA or Nebius |
| 3 | working demo URL | **absent** — no URL anywhere in the repo |
| 4 | ≤3 min video | **absent** — no video link anywhere |
| 5 | feedback section | **absent** — no section about feedback on the event or the tools |

## 2. Will it run end to end now? **YES — but not from the published repo**

Measured today, in this tree:

| evidence | result |
| --- | --- |
| `py-task.sh retrykit`, **16:12 UTC — this tree, 10 minutes ago** | **completed**, 11 tool calls, **0 tool errors**, 5 files / 400 LOC, its own suite `Ran 15 tests … OK`, independent grader **24 / 25** (sole finding: leftover `__pycache__`) |
| `py-task.sh retrykit`, 14:49 UTC | completed, 323.6 s, 7 tool calls, 0 tool errors, 4 files / 475 LOC, suite `Ran 24 tests … OK` |
| `packages/horizoncode/bin/horizoncode --version` | `local` |
| `packages/horizoncode/bin/horizoncode --help` | 60 lines on stdout (the stderr help bug is fixed) |
| earlier today, auditlog via the real TUI | 22/22 on the independent grader |
| slash commands, full sweep of 101 | 84 work, 5 error, 12 slow |

Dead lanes confirmed in the same tree: subagent dispatch is still
`DIRECT_CHILD_TURN_RPC_ENABLED = false` (`packages/horizoncode/src/session/managed-control.ts:86`),
so the ten builtin subagent profiles remain unreachable.

**The catch, and it is the whole ballgame:** `git log -1` is `29fd33a89`, from
*before* the `packages/opencode` → `packages/horizoncode` rename and before every
fix above. A judge who clones the repository gets none of this. What was tested is
not what would be submitted.

## 3. Clean tree? **NO**

```
2171 changed paths = 1075 modified + 1035 deleted + 61 untracked
  packages/ 2081 · scripts/ 38 · kernel/ 15 · reports/ 8
```

Not scratch noise: `.tmp/` and `node_modules/` are gitignored and contribute zero.
99 % of it is two mechanical events — the bulk deletion of `packages/opencode/**`
and the mass edits that came with the rename. `kernel/` (15) and `arch_V1/` (2)
are nearly clean.

## The three things that matter in the next 40 minutes

1. **Commit and push.** Without this, every measurement above is unpublished:
   `git add -A && git commit -m "rename opencode->horizoncode; reliability fixes"` then push.
   Everything else is decoration on an empty shelf.
2. **Append a feedback section to `README.md`.** It is a text edit, it is required,
   and it is the cheapest missing deliverable.
3. **Demo URL.** A hosted demo cannot be stood up honestly in 40 minutes. The
   defensible substitute is the strongest single piece of evidence already on disk —
   `bench/fullstack/meterbase-verified-20261029151801` (2,428 lines, 20/20 held-back
   acceptance tests) plus the run reports — linked from the README as the demo
   artefact, with the exact reproduction command.

A video cannot be produced from here. If none exists, say so in the submission
rather than letting it be discovered.

## Honest summary line

The agent works, and it works measurably better than it did 24 hours ago
(zero-error runs, TUI lane verified, 84/101 slash commands). The **submission** is
not ready: the code that works is not committed, and three of five required
deliverables do not exist.
