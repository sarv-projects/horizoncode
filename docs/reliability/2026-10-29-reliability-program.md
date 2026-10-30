# Making HorizonCode reliable — measured diagnosis and a ranked program

Date: 2026-10-29. Every claim below is tied to a run we performed today or to a
file:line in this repo.

## 1. What actually failed, by budget

| run | task | tool calls | failures | success |
| --- | --- | --- | --- | --- |
| fullstack (30 min, autonomous) | meterbase HTTP service | 165 | 41 | 75 % |
| retrykit (3.8 min) | stdlib package | 19 | 10 | 47 % |
| auditlog #1 (4.9 min) | stdlib CLI | 31 | 8 | 74 % |
| auditlog #2 (6.0 min) | stdlib CLI | 35 | 6 | 83 % |

The failures are not one phenomenon. They split cleanly into three classes, and
the fix for each is a different kind of work:

| class | what it is | measured instances | share of failures |
| --- | --- | --- | --- |
| **A. Mechanical** | the tool surface refuses work the model legitimately asked for | 41/165, 10/19, 8/31, 6/35 | ~90 % |
| **B. Coverage** | a requirement in the brief is never attempted | 1 of 14, twice | ~5 % |
| **C. Honesty** | the closing report misstates what was done | 2 (auditlog ×2) + 1 (fullstack) | ~5 % |

**Any reliability program that starts with B or C is optimising the tail.** Class
A is where the budget goes. In the retrykit run the model made 19 calls and 10 of
them were spent discovering that a directory did not exist or that an opaque
error had occurred — that is the entire difference between a 4-minute run and a
2-minute run.

### Class A, precisely

| id | symptom | count today |
| --- | --- | --- |
| A1 | `write` denied with `path_unavailable_or_unsafe` when the parent directory does not exist. Reproduced in every run, on the first write into a fresh arena. | 9 |
| A2 | `bash` fails with the bare tag `Pty.InvalidInputError` — no reason, no hint. Two triggers observed: arguments with only `{command}` (no `cwd`), and otherwise well-formed calls. | 6 |
| A3 | multi-call `edit` batch denied with `edit … guarded operation set or lease changed`; single edits never fail. Four fix agents attempted this today; it still reproduces. | 28 |

A1's root cause: `effect_host.rs:11894` turns any `inspect()` error into
`PlanOutcome::Denied("path_unavailable_or_unsafe")`, and `inspect()` →
`open_parent()` fails with `ENOENT` when the parent is missing. A2's root cause:
`pty.rs:220` defines `InvalidInputError` with a `reason`, `validateTerminalRunInput`
(`pty.ts:1538`) and `prepareToolBatch` (`pty.ts:1109`) raise with real reasons, and
only the tag reaches the model. A3's root cause is architectural: the message
names a "guarded operation set", but the batch admits per-call leases, so a second
call in the batch invalidates the first.

## 2. What HorizonCode already has (cross-analysis: do not rebuild)

This is the important part. **The design we would propose already exists in this
repo, and is switched off.**

| capability | where | state |
| --- | --- | --- |
| 4 native agents (build/plan/general/explore) | `agent/agent.ts:276-401` | wired |
| **10 builtin AgentProfileV2 subagents** — explorer, architect, librarian, looker, **reviewer**, **test-debugger**, system-operator, browser-qa, history-search, **verifier** | `core/src/config/builtin-agent-profiles.ts:108-230` | profiles + selectors shipped and selectable |
| Task/subagent tool, nesting, per-child permission intersection | `tool/task.ts:196`, `agent/subagent-permissions.ts:33` | **advertised but dead** |
| the kill switch | `session/managed-control.ts:86` — `const DIRECT_CHILD_TURN_RPC_ENABLED = false` | every dispatch fails closed |
| 16 sealed skills, auto-exposed as slash commands | `core/src/skill.ts:96-232` | wired |
| todo, compaction, context policy | `tool/todo.ts`, `session/compaction.ts` | wired |
| plan mode | `tool/plan.ts` | partial — `plan_exit` only, CLI-experimental; `plan_enter` is a permission key with no tool |
| Rust `Goal` / `SpecVersion` (objective, criteria, budget, capability_scope) / `Run` / `Task` / `Attempt` / `VerificationEvidenceV1` / `VerdictV1` | `kernel/src/managed_control.rs:279-1522` | authoritative, **unreachable from TS** |
| private confined verifier (837 lines, "no RPC decoder or public constructor") | `kernel/src/managed_verifier.rs` | sealed |
| completion gate on direct turns | `managed-control.ts:8626-8645` — `completeDirectTurn(resultDigest)` | **absent**: the digest is an arbitrary string, no tests, no exit codes |
| verification discipline | `core/src/harness-profile.ts:34-49` | **prompt text only** |
| spec artefact in product code | — | absent (`grep`: no SPEC.md, no acceptance model) |

The `verifier` profile's own description reads: *"produces verification evidence
under a permit; never edits the subject under test … To award PASS on your own
say-so; the model's self-report is not completion evidence."* That is exactly the
mechanism that would have caught both of our honesty failures. It cannot run.

`arch_V1/32` mandates it as **LH-005: "agent says done with remaining TODO →
final verifier rejects completion"**. `arch_V1/46-V1-WIRE-TRACKER.md` **formerly recorded**
226 designed / 4 `code_present` / **0 wired**; that header line was not derivable from the file's rows
(corrected there on 2026-10-29 — counted: 0 Done · 73 Partial · 12 Not done · 1 N/A over 86 rows). The
**0 wired** part stands. Our two failures are that gap observed from the outside.

## 3. Evidence from outside: which mechanisms actually move reliability

Ranked by evidence quality, not by popularity.

| # | mechanism | evidence | cost | verdict |
| --- | --- | --- | --- | --- |
| 1 | **Tool-surface hardening** (strict schemas, auto-create parents, typed actionable errors) | Anthropic: a tool-testing agent that rewrote tool descriptions cut task completion time 40 % ([link](https://www.anthropic.com/engineering/multi-agent-research-system)) | low, one-off | **do first.** Our A1–A3 are worth ~50 % of the failure budget. |
| 2 | **Requirement ledger with immutable IDs**; the agent may only flip a status | Anthropic long-running harness keeps `feature_list.json` (200+ items, all `passes:false`) and notes JSON resists editing better than Markdown ([link](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)); DevAI annotates 365 hierarchical requirements ([link](https://arxiv.org/abs/2410.10934)) | 1–2k tokens | **do.** The only mechanism that makes our class B *impossible* rather than discouraged. Also makes a renumbered brief detectable. |
| 3 | **Out-of-process verification receipts on a Stop gate** | Claude Code `Stop`/`SubagentStop` hooks exit 2 to block completion ([link](https://code.claude.com/docs/en/hooks)); METR: when the grader was visible, o3 rewrote it in 42.9 % of runs on one task family ([link](https://metr.org/blog/2025-06-05-recent-reward-hacking/)) | low, end-of-run | **do.** Fixes class C. "Done" becomes `{claim, command, exit, output_hash}`. |
| 4 | **Executable check per requirement** | Reflexion 91 % vs 80 % pass@1 HumanEval — the gain is from execution feedback, not reflection ([link](https://arxiv.org/abs/2303.11366)) | high | do where cheap; only ~⅓ of requirements are mechanically checkable. |
| 5 | **Architect → editor split** | Aider edit benchmark 79.7 % → 85.0 % ([link](https://aider.chat/2024/09/26/architect.html)) | +1 call | cheap second-order win. |
| 6 | **Fixed pipeline over open autonomy** | Agentless: 32.0 % SWE-bench Lite at $0.70, beating complex agents ([link](https://arxiv.org/abs/2407.01489)) | medium | good for predictable shapes; the kernel is the right home. |
| 7 | **One fresh-context read-only verifier** | Cognition: subagents are safe when scoped to *answering*, unsafe when writing code in parallel ([link](https://cognition.com/blog/dont-build-multi-agents)) | 3–5× tokens on verify only | do, scoped to verification only. |
| 8 | **Spec-driven frameworks** (GitHub Spec Kit, Kiro) | no published reliability measurement from either vendor ([Spec Kit](https://github.com/github/spec-kit), [Kiro](https://kiro.dev/blog/introducing-kiro/)) | very high (4–5 passes) | borrow the artefact shape, not the ceremony. |
| 9 | **Parallel multi-agent fan-out** | Anthropic: +90.2 % on a *research* eval, 15× tokens, and their own caveat that coding has "fewer truly parallelizable tasks" ([link](https://www.anthropic.com/engineering/multi-agent-research-system)) | 15× tokens | zero for coding correctness; latency only. |
| 10 | **Per-domain specialised agents** | Anthropic lists it as future work; no controlled comparison exists | high | **unproven — do not build first.** |

**Do not do:** rubric-only LLM-as-judge gating (the honest version needs an agent
that first gathers repo context — [Agentic Rubrics](https://arxiv.org/abs/2601.04171));
self-critique loops without external feedback ([Huang et al.](https://arxiv.org/abs/2310.01798)
show intrinsic self-correction *degrades* reasoning); more "double-check the
requirements" prompt text — the model already believed it had; wide parallel
subagents for one coherent feature.

## 4. The program

### P0 — Repair the tool surface (highest ROI, no agent changes)

Target: class A. Expected: tool success 47–83 % → ≥95 %, wasted calls −50 %.

- **A2 first (cheapest, TS-only).** Carry `InvalidInputError.reason` into the tool
  result; default a missing `cwd` to the session workspace instead of letting the
  kernel's strict three-key check refuse it. The model can then recover in one
  step instead of four blind retries.
- **A1.** Best fix: `plan_write` treats a missing parent as "did not exist" and
  the write execution creates parents via `mkdirat` walked component-by-component
  off the workspace root fd (never a path string). Fallback if that is too risky
  before the deadline: keep the denial but make the reason name the missing
  directory, and say "create it first". Both are strictly better than today.
- **A3.** Fix it architecturally, not per-call: **one ToolBatch = one Guard
  admission = one lease covering the whole operation set = one receipt.** The
  error string already describes this design; the code does not implement it.
  Per-call leases are the bug. This also removes the mixed read+write batch bug
  fixed earlier.

### P1 — Requirement ledger (targets class B)

1. A `/spec` pass (cheap model, no tools) reads the brief and emits
   `SPEC.json`: `[{id, requirement, check: {kind: "command"|"assert", ...}, status}]`
   plus a human `SPEC.md` rendering. IDs are content-addressed so a renumbered
   brief is detectable.
2. The implementer may only flip `status`, never edit `id`/`requirement`/`check`.
3. The **harness** — not the model — executes every `check` at the end and writes
   the verdicts back.
4. **Completion gate:** a run is `partial` unless every row is `pass` or
   explicitly `dropped` with a reason. Row 14 of the auditlog brief would have
   existed, had no check, and blocked "done".

Expected effect: catches 100 % of dropped requirements. Cost: ~2–4 extra calls
plus one extractor turn.

### P2 — Receipts on a stop gate (targets class C)

- Add `verification` receipts to the direct-turn path: `{criterion, command,
  exit_code, stdout_digest, revision}`. A turn may not be marked `completed` while
  the newest mutation receipt is newer than the newest verification receipt
  ("stale verification" is a timestamp comparison, not a judgement).
- Negative claims ("no artifacts left behind") must be a *scan receipt*, not a
  sentence — a command with an exit code, produced outside the model's process.
- The Rust kernel is the right producer. It already mints effect receipts and
  already owns `VerificationEvidenceV1`; the missing piece is an RPC ingress from
  the direct lane, plus `completeDirectTurn` taking criteria evidence instead of
  an arbitrary `resultDigest`.

### P3 — Revive the agents that already exist (only after P0)

- Delete the `DIRECT_CHILD_TURN_RPC_ENABLED = false` gate once the Guard/recovery
  acceptance it is waiting on is met — the profiles, selectors, nesting and
  permission intersection are all already built.
- Then use exactly three of the ten, each with a *gate*, not a prompt:
  `spec-extractor` (P1 step 1), `verifier` (read-only, P2 producer), `test-author`
  (writes acceptance tests from the ledger before the implementer starts).
- Handoff is a **file** (the ledger), never a message, so it survives compaction
  and both agents read the same authority record.
- Do **not** split a single coherent implementation across agents. Our measured
  failures were sequential single-file work; that is the case where multi-agent
  demonstrably hurts.

### P4 — Plan mode as a real gate

`plan_enter` is a permission key with no tool, and `plan_exit` is CLI-experimental
only. Either finish it (a state machine that denies mutations until approval) or
delete the key. Today it is a promise the product does not keep.

## 5. Ordering, and why

```
A2 → A1 → A3 / ACC-G    (recovers ~50 % of the failure budget, days not weeks)
        ↘ P1 ledger     (makes dropped requirements impossible)
        ↘ P2 receipts   (makes false claims impossible)
              ↘ P3 agents (only once the tools are trustworthy)
```

Agents amplify whatever the tool surface does. Waking up ten subagents on top of a
47 %-success tool surface multiplies the waste by ten. That is the single most
important conclusion of this analysis, and it is why "add specialised agents" is
third, not first.

## 5b. Cross-analysis of the rival corpus (`repo_take/`)

Three findings that change the plan, because they are already-built solutions to
our exact defects.

**1. jcode's done-gate is P2's cheap form.**
`repo_take/.../jcode/crates/jcode-todo-policy/src/followup.rs` is a *pure*
function — `TodoSnapshot` in, `Decision { follow_up, effects }` out. After a turn
ends it fires a gate only when: todos are incomplete, there is an
ownership/delivery gap, confidence is unvalidated, or confidence *spiked*.
`MAX_GATE_ATTEMPTS = 5`, then a circuit-breaker with a stall notice instead of
looping, and fingerprints prevent re-asking the same gap.
Port this as a Rust decision function (Goal/Task state in, "gate turn" out). It
needs no new RPC ingress, no schema change, and cannot conflict with leases or
receipts. Our auditlog run ended with one unexecuted requirement and a green
self-report; a `follow_up` decision on "requirement rows not all resolved" forces
exactly one more turn and the gap closes.

**2. OMP's edit engine is the correct fix for A3.**
`crates/pi-edit` keeps a per-file-version content tag (a hashline), "seen lines"
provenance (an edit may only anchor on lines the model was actually shown), a
no-op loop guard (3 identical no-ops escalate), and staged multi-file apply
through a single host-owned `EditWriter`.
That is structurally identical to our Guard-owned mutation path, which is why it
should be implemented as a Rust edit engine behind `ExecutionHost` rather than in
TypeScript. Every write carries a revision fence; a mismatch becomes a *typed
retry*, not a denied batch. This is the same idea as "one batch, one effect" but
with a proven design and a workable failure mode. It also happens to be the
unimplemented `ACC-G` row: `hashline_edit` exists today only as a feature-exposure
descriptor (`packages/core/src/v1/config/feature-exposure.ts:14,278`).

**3. A correction to the wire-tracker claim.**
`arch_V1/46-V1-WIRE-TRACKER.md`'s header says "226 designed / 4 `code_present` /
0 `wired`", but the table's status column uses `Done` / `Partial` / `Not done`
(0 Done, 76 Partial, 13 Not done) and the word `code_present` appears only in the
header. So "0 wired of 230" is the header's phrasing, not a verifiable column —
we should stop quoting it as a measurement. What *is* verifiable: 0 rows are
`Done`, and spot checks confirm the pattern. `builtin.verifier` is genuinely
code-present (`packages/core/src/session/supervisor.ts`, `kernel/src/managed_verifier.rs`)
but not wired; `hashline_edit` is a descriptor with no implementation;
post-patch LSP diagnostics *do* run (`tool/apply_patch.ts:433-469`). The
correction strengthens the argument rather than weakening it: the pieces are real
files, they are simply not connected.

## 5c. Final deltas from the rival audit

**A1 is a fork divergence, not a missing feature.** Upstream opencode's write path
calls a helper that creates parents — `repo_take/opencode/packages/core/src/filesystem.ts:212`,
`fs.writeWithDirs(target, input.data)`, and it has its own test block
(`repo_take/opencode/packages/core/test/filesystem/filesystem.test.ts:163`). Our
`packages/core/src/filesystem.ts` has no such helper, and the guarded path
(`kernel/src/effect_host.rs:11894` → `inspect` → `open_parent`) fails closed when
the parent is absent. So this is a capability we dropped on the way to
kernel-owned writes, not something upstream also lacks. Restoring it *through*
Guard (plan tolerates a missing parent; the effect creates the chain with
`mkdirat` walked off the workspace root fd) is the honest fix.

**ACC-G/H/J have no wire row at all.** Only ACC-F does (W-P4-05, "Partial — the
`apply_patch.ts` schedule plus `lsp/diagnostic.test.ts`; E2E open"), and we
confirmed that code is real (`tool/apply_patch.ts:433-469`). `hashline_edit` is a
FeatureId descriptor only (`core/src/v1/config/feature-exposure.ts:14,278`).

**Three mechanisms to take verbatim:**

| mechanism | source | why it fits us |
| --- | --- | --- |
| `ConfidenceState >= Validated` ladder gating completion, `WorkflowValidated` for goal delivery | `repo_take/jcode/crates/jcode-todo-policy/src/lib.rs` | makes "model self-report cannot award PASS" mechanical instead of a doc rule; delete TS PASS paths rather than port them |
| `yield` typed terminal handoff — a subagent cannot finish without a schema-validated artefact, retried 3× then "exited without calling yield" | `repo_take/oh-my-pi/packages/coding-agent/src/tools/yield.ts` | the Task lane needs a typed result; keep it a *proposal*, never acceptance — only the kernel settles |
| `seen_lines` provenance + `NOOP_HARD_LIMIT = 3` | `repo_take/oh-my-pi/crates/pi-edit/src/store.rs`, `.../hashline/patcher.rs` | stops edits anchored on lines the model never saw, and stops silent no-op loops |

**One trap.** OMP validates the hashline *before* writing. With our one-use leases
that reintroduces TOCTOU unless the content tag is re-validated *inside* the lease
at commit. Multi-file apply must therefore be one ToolBatch with per-file
receipts, and must not promise cross-file rollback — prior effects stand by
design.

**Explicitly rejected:** prompt-only plan enforcement as a security boundary;
`seen_lines` as authorisation (it is provenance, not permission); completion
probes as evidence; "atomic across files".

## 6. What this means for the hackathon submission

- Fix **A2** and **A1**'s actionable-error fallback: hours, and they remove the
  bulk of the visible failures a judge would see.
- Ship **P1 in its smallest form** if time allows: a `SPEC.json` artefact plus a
  coverage check in the final verification script. Even harness-only, it turns
  "the agent says it did all 14" into a number.
- Leave **A3** and **P2** as documented, measured gaps with reproduction steps
  rather than half-landed fixes. A known-and-reported defect reads better than a
  fourth failed fix attempt.
