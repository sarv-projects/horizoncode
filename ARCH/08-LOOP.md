# 08 — Agent Loop

`CMP-runner` is the control plane of the HorizonCode binary. This document is the LLD for the turn/step engine: the canonical cycle, the turn-attempt lifecycle, input admission, scheduling and eager tool settling, interruption, overflow recovery, decline paths, the completion contract, and per-step accounting and events.

## Purpose

- Drive a bounded, model-directed loop that a developer can trust for hours-long work (`ARCH/01-VISION.md`; `REQ-LOOP-001`, `REQ-HORIZON-001`).
- Accept steering and queued input while a turn is active without losing either (`REQ-LOOP-002`).
- Execute independent tool calls concurrently and honor explicit ordering barriers (`REQ-LOOP-003`).
- Terminate every turn in exactly one durable terminal state (`REQ-LOOP-004`).
- Interrupt promptly and leave partial work inspectable rather than discarding it (`REQ-LOOP-005`).
- Persist events incrementally so no committed step is lost to a crash (`REQ-LOOP-006`).
- Reach "done" only through a satisfied completion contract, never on a plain non-tool finish.

## Responsibilities

**Owns**

- The canonical cycle `INPUT → ADMISSION → PLAN → MODEL STEP → SCHEDULER → EXECUTE → OBSERVE → UPDATE → CONTINUATION`.
- The turn, step and turn-attempt state machines; the step counter and step limit.
- Input admission and promotion ordering at turn/step boundaries.
- Model-step assembly orchestration (calls `CMP-context` and `CMP-provider`; owns no assembly or transport logic itself).
- Tool scheduling: parallel-safe partitioning, ordering barriers, eager start and settlement.
- Continuation decisions: continue, compact, re-plan, or terminate.
- The single terminal state per turn and its reason.
- The completion contract gate and the running task-graph projection it consults.
- Per-step usage accounting and per-step event emission.

**Never owns**

- Durable session storage, log append, projections (`CMP-session`).
- Context selection, ranking, budgeting or the compaction algorithm (`CMP-context`).
- Tool definitions, schemas, materialization or execution (`CMP-tools`).
- Provider transport framing, retries, quota, cooldown (`CMP-provider`).
- Permission decisions (`CMP-guard`), sandbox confinement (`CMP-sandbox`), audit chain (`CMP-audit`).
- Sub-agent spawn policy and merge (`CMP-orch`) — the loop invokes the orchestrator and consumes receipts as untrusted data.
- Rendering (`CMP-tui`) and protocol framing (`CMP-acp`, `CMP-mcp`).

## Interfaces

| Direction | Counterpart | Surface | Notes |
|---|---|---|---|
| in | `CMP-acp`, `CMP-headless`, `CMP-tui` | `prompt(session, input)` · `steer(session, input)` · `interrupt(session)` · `cancel(run)` | Surfaces are thin clients of one control interface (`REQ-PROTO-005`). |
| out | `CMP-session` | `admit` · `append` · `loadForRunner` · `contextEpoch` · `resume/wake/interrupt` | The runner is the only writer of turn/step/tool/model events. |
| out | `CMP-context` | `assemble(step, budget)` · `compactIfNeeded` · `compactAfterOverflow` | Context decides; the runner requests and acts on the result. |
| out | `CMP-provider` | `resolveRoute(policy)` · `stream(request)` | Route selection and transport retries live here (`REQ-PROV-003`, `REQ-PROV-005`). |
| out | `CMP-tools` | `materialize(permissions)` · `settle(call)` | Materialization is permission-filtered; denied tools are absent (`REQ-TOOL-003`). |
| out | `CMP-guard` / `CMP-sandbox` / `CMP-audit` | authorize → confine → execute → record | Every effect follows one governed path; no loop shortcut. |
| out | `CMP-orch` | `spawn(options)` · `await/receipt` | Receipts are untrusted data, never trusted transcripts (`REQ-ORCH-001`). |

## Data / state model

### Units

| Unit | Meaning | Boundary event |
|---|---|---|
| **Turn** | One admitted batch of user-facing work. Exactly one terminal state. | `turn/start` … `turn/end` |
| **Step** | One provider request, the assistant message it produces, the tool calls it emits, and their settlement. A checkpoint boundary. | `step/start` … `step/end` |
| **Turn attempt** | One invocation of the step engine plus its compaction/overflow-recovery wrapper; returns `{ needsContinuation, step }`. | internal |

### Turn terminal state

`completed | failed | interrupted | declined` — exactly one per turn (`REQ-LOOP-004`). Every terminal state carries a reason; a `step` may additionally be `partial` when the step limit is hit mid-task, which is resumable rather than terminal failure.

### Loop phase state

| Phase | Inputs consulted | Outputs |
|---|---|---|
| INPUT | prompts, queued input, steers | admitted input rows |
| ADMISSION | guard decision, budget, step limit | admitted/denied step; promotion |
| PLAN | task graph, todo, goal | plan/task-graph update |
| MODEL STEP | route, context, tools | streamed assistant turn |
| SCHEDULER | streamed tool calls | parallel groups + barriers |
| EXECUTE | grouped calls | governed effects |
| OBSERVE | settlements | model-content + UI-detail results |
| UPDATE | results, usage | log events, task graph, cost |
| CONTINUATION | completion contract, budget | continue · compact · terminate |

### Completion contract

Carried in the durable task graph (`DEC-009`): `goal`, `success_conditions[]`, `verification[]`. It survives compaction and restart. The loop reads it during CONTINUATION; it is the sole basis for `completed`.

## Lifecycle & flows

### Turn attempt lifecycle

1. **Preconditions.** Load the session; if its workspace/agent binding no longer matches the live binding, interrupt rather than run against a stale world.
2. **Agent select.** Resolve the bound agent profile and its model/mode/permission snapshot.
3. **Context epoch.** Initialize or prepare the epoch (`CMP-session`); obtain `baseline_seq`.
4. **Promotion.** If this attempt follows a wake, promote input (below). A promoted steer resets `step = 1`.
5. **Route.** Resolve the model route through `CMP-provider` policy.
6. **History.** Load runner-visible entries from `baseline_seq`.
7. **Step budget.** Compute `isLastStep` from the configured maximum; materialize tools only when not the last step.
8. **Request.** Build the request: system parts, translated history, tool definitions, tool choice, session-affinity headers.
9. **Pre-step compaction.** Ask `CMP-context` whether compaction is needed; if it compacted, transition to a continuation that rebuilds the request at the same step.
10. **Snapshot.** Capture the start file-tree snapshot.
11. **Stream.** Run exactly one provider turn. Publish events incrementally. On the first un-executed tool call, mark `needsContinuation` and eagerly start its settlement.
12. **Settle.** Join all tool settlements (or cancel on interruption); handle provider error, overflow, decline and interruption.
13. **Close the step.** Record `step/end` with usage, cost, end snapshot and changed files.
14. **Return.** `{ needsContinuation, step }` to the outer loop.

### INPUT → ADMISSION

- Input arrives as a prompt, a queued message, or a steer; each is durably admitted before admission is evaluated.
- **Promotion order at a boundary:** drain **all** un-promoted steers admitted up to the current log sequence, then promote **exactly one** queued turn. Steers consume the next step; a queued turn opens a fresh turn.
- Admission checks the guard decision and the session/step budgets. A `deny` ends the turn `declined`; an `ask` parks the turn in a durable awaiting-approval wait and resumes on the recorded decision; an exhausted budget fails closed (`REQ-HORIZON-003`).
- A forced run performs one attempt even when no input is eligible.
- Injected (non-user) context uses the same `next-step` boundary and never interleaves mid-step (`REQ-LOOP-002`).

### PLAN

Lightweight, durable, and bounded: update the task graph and todo from the current goal. HorizonCode has no second workflow engine; deterministic multi-step processes are not modeled here. A plan is advisory state on which CONTINUATION and the completion gate operate.

### MODEL STEP

- Route resolution is `CMP-provider`'s; the loop never names a vendor.
- Context assembly is `CMP-context`'s: stable prefix + dynamic suffix, budgeted before the request (`REQ-CTX-004`).
- Exactly one provider turn is streamed per step attempt. Assistant text, reasoning, tool-call proposals, provider errors and usage are published incrementally; token deltas are ephemeral and not persisted individually (`REQ-LOOP-006`).

### SCHEDULER

- Partition streamed tool calls into parallel-safe groups and explicit ordering barriers. Independent calls run concurrently; a declared barrier is honored (`REQ-LOOP-003`).
- Modifying calls with overlapping write scope serialize (workspace lease); read-only path-scoped calls may fan out.
- Provider-executed tool calls are recorded but not locally settled.

### EXECUTE

- Each local call is authorized by `CMP-guard` and confined by `CMP-sandbox`; effects append to `CMP-audit`.
- A call is recorded durably **before** its side effects begin, so repair can reason about outcome uncertainty.
- Tool output is bounded with a durable artifact ref for the full output; lossy success is forbidden (`REQ-TOOL-004`).

### OBSERVE

- Collect settlements; separate model-visible content from UI-only detail (`REQ-TOOL-004`).
- Record typed outcomes: success, failure, or provider-executed.
- Settlements are eagerly started and all awaited before continuation so the next request sees complete results.

### UPDATE

- Append the step's events; update the task graph and todo; fold usage into session totals.
- Persist incrementally so a crash loses no committed step (`REQ-LOOP-006`).

### CONTINUATION

- **Continue** when the step produced local tool calls that need results, or when a steer is pending at the step boundary.
- **Compact** when the context budget requires it, then rebuild the request (same step).
- **Terminate** only per the completion contract (below) or on a decline/failure/interruption.
- If the step limit is reached, the next attempt is the tool-less wrap-up (below).

### Step limit and last-step forcing

When `step ≥ configured maximum`:

- Tools are **not materialized**; the request carries no tool definitions and `tool choice = none`.
- A synthetic wrap-up instruction is appended so the model produces a text-only answer summarizing completed work, remaining work and next steps.
- Any tool call that still arrives fails unsettled with reason "tools are disabled after the maximum steps".
- An overrun (work not finished) marks the last step `partial` — resumable by the next user input, never a silent stop (`REQ-HORIZON-001`).

### Parallel eager tool settling

- The first non-provider-executed tool call sets `needsContinuation` and starts its settlement immediately in a tracked fiber; later calls start as they stream.
- Continuation waits for **all** settlements (join) or for the fiber set to drain (`awaitEmpty`), whichever the scheduler selects for the current mix.
- Failure paths call a fail-unsettled pass so no call is left `pending`/`running` at the boundary (`REQ-LOOP-004`).

### Interruption, cancellation and fail-unsettled

Three verbs, aligned with the delegation contract:

| Verb | Effect |
|---|---|
| `interrupt` | Stop the active step promptly; keep the session resumable; retain partial work inspectable (`REQ-LOOP-005`). |
| `cancel` | Terminate the run; record the reason; no completion re-buffer. |
| `dispose` | Release the environment/resources after a terminal run. |

On interruption:

1. Cancel provider streaming; the assistant turn ends with its partial content retained.
2. Clear pending tool fibers and run fail-unsettled on every call without a durable result.
3. If an assistant message is active, mark it interrupted.
4. Emit `turn/end` with reason `interrupted`.

A declining decision (permission denied or question rejected) halts the loop rather than becoming model-facing tool output; the turn ends `declined`. Cancellation propagates parent → child.

### Provider-overflow single retry

- If the provider reports a context-overflow failure **before** any assistant content has started, run compact-after-overflow once and retry the **same step** through a path that cannot recover a second overflow.
- A second overflow is surfaced as a typed failure; the loop never silently starts a new conversation (`REQ-CTX-004`).
- If content has already started, overflow is handled at the turn level like any post-content provider failure — not retried mid-stream.

### The completion contract (hard to reach)

- Termination with `completed` requires the completion contract to be satisfied: `goal` met, every `success_condition` verified, and `verification[]` executed before "done".
- The loop does **not** stop merely because it read a file, wrote an edit, ran a command, or finished one subtask.
- Genuine blockers that may end a turn without completion: a missing capability, a required user decision, an exhausted budget, or an irrecoverable failure. Each ends with an explicit terminal state and reason.
- Verification is risk-proportional to the changed effect; a claimed completion without recorded verification is a defect.

### Cost and token accounting per step

- `step/end` records input, output, reasoning and cache tokens, cost, the end snapshot and the changed-file set.
- Usage folds into the session and run aggregates and is re-checked against the session budget before each step admission; exhaustion fails closed.
- Accounting records counts and refs only — no prompt or completion content (`REQ-PROV-004`).

### Event emission per step

| Phase | Representative events |
|---|---|
| ADMISSION | `input/promoted` · `turn/start` |
| MODEL STEP | `model/started` · `assistant/message` · `model/done` |
| SCHEDULER / EXECUTE | `tool/call` |
| OBSERVE | `tool/result` |
| UPDATE | `step/end` |
| CONTINUATION | `step/start` · `turn/end` |

Events are appended before the phase's work is considered settled (`REQ-LOOP-006`).

### Long-horizon continuity

- A run resumes from the log and task graph after an arbitrary gap (`REQ-HORIZON-001`).
- The task graph survives compaction and restart (`REQ-HORIZON-002`).
- Budgets are maxima; exhausting a turn budget pauses or fails closed rather than overrunning (`REQ-HORIZON-003`).
- Idle, waiting and working states are distinct and truthful; no decorative progress or fabricated heartbeats (`REQ-HORIZON-004`).
- Sub-agent completion is admitted as a typed event plus a queued prompt only when the parent is live and the child was not cancelled (`REQ-ORCH-001`).

## Failure modes

| Failure | Behavior |
|---|---|
| Model call fails/times out | Transport-owned bounded retry; if unresolved, the turn blocks with a surfaced reason; a user abort vetoes retry. |
| Post-content provider failure | Handled at the turn level; the step is not retried mid-stream. |
| Tool failure | Recovery pipeline: retry (idempotent/read-only), alternate path, or re-plan; typed failure recorded. |
| Context overflow | Compact-after-overflow once, retry the same step; a second overflow escalates (`REQ-CTX-004`). |
| Interrupt mid-step | Stream cancelled, unsettled tools failed, partial work retained, `turn/end` = `interrupted`. |
| Declined permission/question | Loop halts; `turn/end` = `declined`; not turned into model-facing output. |
| Step limit reached | Tool-less wrap-up; overrun marked `partial` and resumable. |
| No progress across N steps | Stuck detector escalates via the guard/question primitive; never an unbounded spin. |
| Budget exhausted | Fail closed: pause or terminate with a typed reason; no silent overrun. |
| Provider restart / stale handle | Epoch bump invalidates handles; the step restarts cleanly rather than replaying provider-bound state. |
| Sub-agent fails/stalls | Receipt with blockers (untrusted data); the parent re-plans or escalates. |
| Crash mid-turn | The session store repairs the open turn deterministically; committed steps survive. |

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `loop.maxSteps` | bounded (per agent) | Step limit and last-step wrap-up |
| `loop.maxTurnRetries` | small, bounded | Turn-level retries before block/re-plan |
| `loop.stuckThreshold` | N steps | No-progress escalation trigger |
| `loop.parallelTools` | on | Independent tool calls run concurrently |
| `loop.toolBarriers` | declared per call | Ordering barriers honored by the scheduler |
| `loop.overflowRecovery` | `once` | Single compact-after-overflow retry |
| `loop.maxToolOutput` | ~2000 lines / 50 KiB | Bounded preview plus artifact ref |
| `budget.tokens` / `budget.cost` / `budget.wallClock` | per session | Hard maxima enforced at admission |

Configuration is layered (`defaults → user → workspace → agent profile → session`) and the effective model/mode/permission snapshot is persisted with the session (`REQ-SESS-004`).

## Requirements mapping

| Requirement | How this document satisfies it |
|---|---|
| `REQ-LOOP-001` | Bounded step loop with a configurable maximum step count per turn. |
| `REQ-LOOP-002` | Steer and queue inputs admitted and promoted at boundaries without loss. |
| `REQ-LOOP-003` | Scheduler partitions parallel-safe calls and honors ordering barriers. |
| `REQ-LOOP-004` | Exactly one terminal state per turn, and fail-unsettled at every boundary. |
| `REQ-LOOP-005` | Interruption cancels streaming and retains partial work. |
| `REQ-LOOP-006` | Incremental event append before each phase settles. |
| `REQ-TOOL-003` | Tool materialization is permission-filtered; denied tools are absent. |
| `REQ-TOOL-004` | Tool results split model-visible content from UI-only detail. |
| `REQ-CTX-004` | Overflow compacts and retries the same step once. |
| `REQ-PROV-003` | Provider quirks stay in the transport adapter; the loop is vendor-neutral. |
| `REQ-PROV-005` | Routing decisions are policy-driven and observable. |
| `REQ-GUARD-002` | Admission fails closed on an unmatched action. |
| `REQ-AUDIT-001` | Executed effects append to the audit path. |
| `REQ-HORIZON-001` | Turn/step state is resumable after a gap. |
| `REQ-HORIZON-002` | Durable task graph drives continuation and survives compaction. |
| `REQ-HORIZON-003` | Token/cost budgets are enforced per session and fail closed. |
| `REQ-HORIZON-004` | Waiting states are distinguishable from working states. |
| `REQ-ORCH-001` | Sub-agents return receipts, not transcripts, admitted as typed events. |
| `REQ-SESS-001` | The loop persists through the durable session store. |

## Open questions

1. **Stuck-detector definition.** Whether "no progress" is repeated identical tool calls, unchanged workspace hash, or both; the exact threshold and the escalation primitive are not yet fixed.
2. **Turn-level retry budget.** How many turn retries and re-plans are allowed before blocking, and whether the budget is per turn or per session.
3. **Verification depth in the loop.** Which success conditions require executable verification versus model attestation, and how a failed verification reopens the task graph.
4. **Barrier declaration surface.** Whether ordering barriers are declared by the tool author, the model, or the runtime from write-scope analysis; the reference sources imply but do not settle this.
5. **Partial-marker semantics.** Whether a `partial` step auto-resumes on the next user input or requires explicit confirmation, and how it interacts with budgets.
6. **Pre-step compaction vs post-overflow.** Whether a single compaction policy can serve both the proactive budget check and the reactive overflow path without double-summarizing.
