# 08 — Agent Loop

`CMP-runner` owns one bounded model turn at a time; the durable controller described by `ARCH/25` owns run continuation. This document is the LLD for the turn/step engine: the canonical cycle, turn-attempt lifecycle, input admission, bounded response-batch assembly/admission, scheduling, interruption, overflow recovery, decline paths, completion, and per-step accounting/events.

**Implementation status:** the current runner implements a bounded single-turn loop, not
the durable task/run controller described by `ARCH/25`. A turn's `completed` event is
never evidence that the task or run is complete; only the independent verifier and
controller can derive those states (`DEC-029`).

## Purpose

- Drive bounded model turns for quick interactive coding as well as managed long-horizon work (`ARCH/01-VISION.md`; `REQ-LOOP-001`, `REQ-HORIZON-001`).
- Accept steering and queued input while a turn is active without losing either (`REQ-LOOP-002`).
- Execute independent tool calls concurrently and honor explicit ordering barriers (`REQ-LOOP-003`).
- Terminate every turn in exactly one durable terminal state (`REQ-LOOP-004`).
- Interrupt promptly and leave partial work inspectable rather than discarding it (`REQ-LOOP-005`).
- Persist events incrementally so no committed step is lost to a crash (`REQ-LOOP-006`).
- End turns truthfully; the durable controller, not the turn runner or a plain non-tool finish, decides whether the task/run is complete.

## Responsibilities

**Owns**

- The canonical cycle `INPUT → ADMISSION → PLAN → MODEL STEP → SCHEDULER → EXECUTE → OBSERVE → UPDATE → CONTINUATION`.
- The turn, step and turn-attempt state machines; the step counter and step limit.
- Input admission and promotion ordering at turn/step boundaries.
- Model-step assembly orchestration (calls `CMP-context` and `CMP-provider`; owns no assembly or transport logic itself).
- Bounded response assembly and batch admission before tool scheduling; parallel-safe partitioning, ordering barriers, and settlement after admission.
- Continuation decisions: continue, compact, re-plan, or terminate.
- The single terminal state per turn and its reason.
- Turn-end classification and revision-bound evidence references; the durable completion gate and task-graph transitions belong to `CMP-orch`.
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
| in | `CMP-acp`, `CMP-headless`, `CMP-tui`, `CMP-control-api` | `prompt(thread_id, input)` · `steer(thread_id, input)` · `interrupt(thread_id)` · `cancel(run_id)` | `thread_id` is HorizonCode's durable conversation identity; ACP/provider session IDs are external bindings. Surfaces are thin clients of one control interface (`REQ-PROTO-005`). |
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
| **Loop invocation** | One bounded invocation of the step engine plus its compaction/overflow-recovery wrapper; returns `{ needsContinuation, step }`. This is transient loop control, not the durable managed `Attempt` entity in `CMP-orch`. | internal |

### Turn terminal state

`completed | failed | interrupted | declined` — exactly one per turn (`REQ-LOOP-004`). Every terminal state carries a reason; a `step` may additionally be `partial` when the step limit is hit mid-task, which is resumable rather than terminal failure.

### Loop phase state

| Phase | Inputs consulted | Outputs |
|---|---|---|
| INPUT | prompts, queued input, steers | admitted input rows |
| ADMISSION | guard decision, budget, step limit | admitted/denied step; promotion |
| PLAN | task graph, todo, goal | plan/task-graph update |
| MODEL STEP | route, context, tools | streamed display events + complete bounded response |
| SCHEDULER | admitted complete tool batch | parallel groups + barriers |
| EXECUTE | grouped calls | governed effects |
| OBSERVE | settlements | model-content + UI-detail results |
| UPDATE | results, usage | log events, task graph, cost |
| CONTINUATION | controller disposition, budget | continue · compact · yield · terminate turn |

### Completion contract

The durable task graph carries the goal, success conditions, required verification,
and evidence references (`DEC-009`, `ARCH/25`). The runner may read this state to
decide whether to yield or request another bounded turn; it cannot decide that a task
or run is complete. A turn's `completed` terminal state means only that this bounded
turn ended normally. `CMP-orch` derives task/run completion only from current
independent PASS evidence bound to the accepted specification and exact integrated
revision. This keeps the turn terminal contract (`REQ-LOOP-004`) separate from the
task/run completion contract (`REQ-HORIZON-006..010`).

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
11. **Stream and collect.** Run exactly one provider turn and publish bounded display events. Tool-call proposals and partial arguments are provisional only; assemble them under per-response call-count, argument-byte, and retained-response-byte caps. Nothing from this response executes while the stream remains open.
12. **Admit batch.** On the completed response, validate IDs, schemas, sizes, ordering metadata, permissions, workspace fences, and aggregate reservations. A malformed or over-cap response receives one durable rejection outcome and dispatches none of its calls. Do not replay the same rejected batch unchanged.
13. **Settle.** After batch admission, schedule independent calls and honor barriers; join settlements or cancel/reconcile on interruption. Once admitted effects begin, the batch is not transactional: each call has its own effect journal and may settle independently. Handle provider error, overflow, decline, cancellation, and interruption.
14. **Close the step.** Record `step/end` with usage, cost, batch digest/outcome, end snapshot and changed files.
15. **Return.** `{ needsContinuation, step }` to the outer loop/controller.

### INPUT → ADMISSION

Natural-language pause/cancel/stop directives are checked on the control lane before
normal prompt admission. When the directive or target run is ambiguous, the controller
fences new dispatch and asks for clarification; it does not send the ambiguous stop
request to the worker to decide whether to continue (`DEC-042`). Empty assistant output,
an empty tool batch, a heartbeat, or a successful deterministic background process
never creates a continuation by itself.

- Input arrives as a prompt, a queued message, or a steer; each is durably admitted before admission is evaluated. The durable receipt contains delivery ID, payload digest, lane, sequence, admission result, and promotion status. Limits cover payload size, pending count, and age; same ID/same digest is idempotent, while same ID/different digest is a conflict (`REQ-LOOP-007`).
- **Promotion order at a boundary:** preserve original order within each lane. A steer may interrupt only at a safe step boundary; queued prompts advance fairly and cannot starve behind an unlimited stream of steers. Promote at most the configured batch per boundary and persist the cursor. This refines the earlier “drain all steers” wording, which could starve queued user tasks under sustained steering (`REQ-HORIZON-014`).
- Admission checks the guard decision and the session/step budgets. A `deny` ends the turn `declined`; an `ask` parks the turn in a durable awaiting-approval wait and resumes on the recorded decision; an exhausted budget fails closed (`REQ-HORIZON-003`).
- Stop/continue decisions belong to `CMP-orch` and use persistent progress signatures, attempt/failure fingerprints, and batch digests across model changes, compaction, peer replacement, and process restarts. Reopening a session does not reset retry/no-progress counts. A strategy label alone is not new evidence; record the changed evidence or method. The model cannot override a controller pause/stop.
- A forced run performs one bounded attempt even when no input is eligible; force never bypasses budget, policy, pause, or stop state.
- Injected (non-user) context uses the same `next-step` boundary and never interleaves mid-step (`REQ-LOOP-002`).

### PLAN

Lightweight, durable, and bounded: update the task graph and todo from the current goal. HorizonCode has no second workflow engine; deterministic multi-step processes are not modeled here. A plan is advisory state on which CONTINUATION and the completion gate operate.

### MODEL STEP

- Route resolution is `CMP-provider`'s; the loop never names a vendor.
- Context assembly is `CMP-context`'s: stable prefix + dynamic suffix, budgeted before the request (`REQ-CTX-004`).
- Exactly one provider turn is streamed per step attempt. Assistant text/reasoning may be shown provisionally; tool-call proposals are buffered and capped until the provider marks the response complete. Never dispatch a partial response. Persist a bounded response digest, final usage, and batch admission/rejection; individual token deltas remain ephemeral (`REQ-LOOP-006`, `REQ-LOOP-008`). A call/byte cap limits dispatch, not generated-token billing; provider max-output controls and usage reconciliation are separate.

### SCHEDULER

- Partition only a fully assembled, admitted batch into parallel-safe groups and ordering barriers. Independent calls run concurrently; a declared barrier is honored (`REQ-LOOP-003`).
- Batch admission is not an atomic transaction across effects. Preflight calls and reserve resources before dispatch; then each effect separately receives a guard decision/ticket, durable prepare record, and terminal receipt. A batch-level defect (invalid encoding/schema, duplicate ID, oversized response, or stale workspace fence) dispatches none. Per-call authorization denial is a typed result for that call; other independently authorized calls may proceed, with partial batch settlement made explicit.
- Modifying calls with overlapping write scope serialize (workspace lease); read-only path-scoped calls may fan out.
- Provider-hosted execution tools (remote code interpreters, remote computer-use, or
  provider-side tool execution) are unsupported in HorizonCode-managed turns. The
  provider adapter must not advertise or enable them; if a provider response contains
  such a call, refuse the complete unstarted response batch with a typed durable
  `REMOTE_EXECUTION_UNSUPPORTED` outcome. Locally settled tools remain subject to the
  normal guard → sandbox → audit path. A future remote-execution feature requires a
  separate reviewed contract for authorization, remote identity, effect receipts,
  cancellation/reconciliation, data egress, and the limits of HorizonCode's local
  confinement/audit claims; a provider's success response alone cannot settle it.

### EXECUTE

- Each local call is authorized by `CMP-guard` and confined by `CMP-sandbox`; effects append to `CMP-audit`.
- A call is recorded durably **before** its side effects begin, so repair can reason about outcome uncertainty.
- Tool output is bounded with a durable artifact ref for the full output; lossy success is forbidden (`REQ-TOOL-004`).

### OBSERVE

- Collect settlements; separate model-visible content from UI-only detail (`REQ-TOOL-004`).
- Record typed outcomes: success, failure, denied, interrupted, or unknown. Do not
  encode unsupported remote execution as a successful settlement.
- Settlements start only after complete-batch admission and are all awaited/reconciled before continuation so the next request sees final results.

### UPDATE

- Append the step's events; update the Task projection and plan; fold usage into
  Thread and managed Run totals with provider-reported/estimated/unknown provenance.
- Persist incrementally so a crash loses no committed step (`REQ-LOOP-006`).

### CONTINUATION

- **Continue** only when the controller authorizes it, the step has settled, and a durable progress signature or newly admitted input justifies another model action.
- **Compact** when the context budget requires it, then rebuild the request (same step).
- **End the bounded turn** normally, or end it with decline/failure/interruption; the caller/controller determines whether another turn is admitted.
- If the step limit is reached, the next attempt is the tool-less wrap-up (below).

### Step limit and last-step forcing

When `step ≥ configured maximum`:

- Tools are **not materialized**; the request carries no tool definitions and `tool choice = none`.
- A synthetic wrap-up instruction is appended so the model produces a text-only answer summarizing completed work, remaining work and next steps.
- Any tool call that still arrives fails unsettled with reason "tools are disabled after the maximum steps".
- An overrun (work not finished) marks the last step `partial` — resumable by the next user input, never a silent stop (`REQ-HORIZON-001`).

### Bounded response batches and tool settling

- No tool call starts while response streaming is open. Once response completion is observed, all call IDs, schemas, argument bytes, and response bytes are validated against hard caps before any dispatch.
- Preflight and reserve all calls as far as local policy allows; persist batch digest/admission. Execute calls in bounded parallel groups, recording each effect independently. A valid but partially denied batch may have successful peer calls; the event/timeline must show this explicitly.
- Continuation waits for **all** settlements or cancellation reconciliation; never start a follow-up model response while admitted calls from the prior response remain unresolved.
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
2. Fence new tool dispatch and mark the turn's cancellation generation so late results
   cannot start a write or be mistaken for current output.
3. Request cancellation of pending/in-flight tools. For owned processes, terminate the
   supervised process tree gracefully, then force-terminate after the configured
   deadline using the platform backend (process group/job object where available).
4. Reconcile every started effect. Calls without a durable result are not silently
   treated as cancelled; unresolved child processes/effects remain `UNKNOWN`, show a
   truthful cancellation-pending state, and fence conflicting follow-up work.
5. If an assistant message is active, mark it interrupted and persist partial content.
6. Emit `turn/end` with reason `interrupted` only after supported cancellation and
   effect reconciliation have reached their recorded terminal/unknown states.

Escape/Ctrl-C are ordinary-turn preemption controls when focus is not inside the
composer/editor child; explicit managed Run controls retain target-specific semantics.
They stop model streaming promptly but do not claim that every OS child can be killed
instantly or that an already committed effect was rolled back.

A declining decision (permission denied or question rejected) halts the loop rather than becoming model-facing tool output; the turn ends `declined`. Cancellation propagates parent → child.

### Provider-overflow single retry

- If the provider reports a context-overflow failure **before** any assistant content has started, run compact-after-overflow once and retry the **same step** through a path that cannot recover a second overflow.
- A second overflow is surfaced as a typed failure; the loop never silently starts a new conversation (`REQ-CTX-004`).
- If content has already started, overflow is handled at the turn level like any post-content provider failure — not retried mid-stream.

### Remaining-context output truncation recovery

This is separate from a request rejected for context overflow. It applies only after a
generation stream ends with typed `FinishRecord.finish = remaining_context_cap`
(`ARCH/11`, `DEC-054`), never to a transport interruption or generic `length` reason.
The provider adapter records cause evidence; it does not retry.

1. Append an incomplete `assistant/attempt` with its `attempt_id`, `logical_step_id`,
   `FinishRecord`, usage, and bounded `partial_ref` when partial output exists. Keep
   this visible and bill/account for it, but exclude it as a completed assistant turn
   from the next model context. The log is append-only.
2. Admit exactly one recovery attempt for that `logical_step_id` only if no tool call
   was dispatched, the route had no provider-executed tools or other hidden side
   effects enabled, no new user/control/cancel input arrived, the task/spec/policy and
   workspace revisions still match, and the controller can reserve compaction, the
   same route/model retry, and required verification inside the existing budgets.
3. Compact the completed conversation prefix; do not summarize the partial attempt as
   fact. Rebuild the provider request from that same logical step and pinned route.
   Re-check all preconditions after compaction immediately before retry dispatch.
4. If a precondition changes, the route becomes unavailable, compaction fails, or the
   retry is itself truncated, return a typed incomplete result with the partial
   artifact and evidence. Do not nudge, switch routes, replay, or auto-retry again.
   A user cancellation always fences the retry.

An explicit requested output cap and an unknown/ambiguous finish cause retain partial
output and usage, show a bounded recovery choice (for example, raise the cap for a
future attempt or split the operation), and do not silently compact or retry. Partial
tool-call JSON is inert until the complete response has been validated and admitted as
a whole batch (`ARCH/10`); provider-managed tool execution makes the response ineligible
for automatic recovery. Per-logical-step depth is persisted across restart and model
session changes; there is no retry-counter reset on a new context window.

### Bounded edit/check feedback

An ordinary Code turn may select a relevant fast project check after a meaningful
edit, such as a formatter check, targeted test, type check, or incremental build. The
command comes from discovered project instructions/config or an explicit user choice,
is displayed before execution when its effect/resource is not already covered by the
effective policy, and runs through the normal tool guard. Do not assume one command
works for every language or platform and do not run a complete suite after each file
write by default.

The runner may return a bounded failure summary plus a recall reference to the model
for repair. Retry count, elapsed time, output bytes, tool count, and any reported
provider cost are charged to the current Turn ceiling. The project check loop has a
finite configured cap and reserves enough budget for a final diff/summary. Each check
result is typed `not_run | passed | failed | cancelled | unknown` and binds command,
working tree digest, exit state, and captured output. A check result is evidence for
that revision only; a later edit invalidates it. The model or hook cannot promote it
to pass.

### Turn completion versus run completion

- `turn/end: completed` means the bounded provider turn ended normally. It does not
  mean the run goal or a task is complete; only `CMP-orch` may transition those after
  current independent verification evidence satisfies the durable completion contract
  (`ARCH/25`, `DEC-029`).
- The runner does not stop the run merely because it read a file, wrote an edit, ran a
  command, finished one subtask, or emitted plausible final prose.
- A turn can end as `declined`, `interrupted`, `failed`, or normally `completed`; a
  run-level blocker, budget exhaustion, user pause, or hard stop is recorded by the
  controller with a separate reason and state.
- Verification is risk-proportional to the changed effect. A task/run completion
  claim without revision-bound verifier evidence is a defect.

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
| Context-window rejection | A typed rejection before content/effects may enter the shared one-recovery-per-logical-step compaction budget only when `compaction.auto=true`, route and revision fences hold, and retry plus verification are reserved (`REQ-CTX-004`). A second failure is terminal. With auto disabled, surface `CONTEXT_TOO_LARGE`; do not compact/retry. |
| Remaining-context output truncation | Preserve the typed incomplete attempt/partial usage. It may enter the same shared one-recovery-per-logical-step budget only with validated route evidence, no possible side effect, unchanged route/revisions, `compaction.auto=true`, and reserved budget (`REQ-CTX-011`, `DEC-054`). A recovery already spent on that logical step prohibits another automatic recovery. |
| Hard pre-send fit rejection | Always enforce the route's usable-context bound. If auto is off, do not dispatch and return `CONTEXT_TOO_LARGE`; if auto is on, allow one compaction/rebuild, recheck, then either dispatch a fitting request or return the typed error. |
| Explicit or unknown output cap | Keep partial response; mark incomplete and offer bounded user-directed recovery; never infer completion or auto-retry (`REQ-CTX-011`). |
| Interrupt mid-step | Stream cancelled, unsettled tools failed, partial work retained, `turn/end` = `interrupted`. |
| Declined permission/question | Loop halts; `turn/end` = `declined`; not turned into model-facing output. |
| Step limit reached | Tool-less wrap-up; overrun marked `partial` and resumable. |
| No progress across N steps | Durable controller compares task/spec/evidence/workspace/event signatures and repeated batch fingerprints. It changes strategy or pauses at a finite ceiling; model text cannot assert progress or override the stop. |
| Tool-call flood / oversized response | Cancel collection, retain bounded diagnostics/usage, reject the entire unstarted batch, and persist its signature so identical output is not replayed. |
| Explicit user pause | Fence future dispatch through the reserved control lane, cancel supported in-flight work, reconcile effects, persist `PAUSED`, and require explicit `/resume`. |
| Future-time / external-event wait | Persist a typed wait condition and sleep without model calls. Timer/event wakes are idempotent; polling is a separately authorized and budgeted task. |
| Budget exhausted | Fail closed: pause or terminate with a typed reason; no silent overrun. |
| Provider restart / stale handle | Epoch bump invalidates handles; the step restarts cleanly rather than replaying provider-bound state. |
| Sub-agent fails/stalls | Receipt with blockers (untrusted data); the parent re-plans or escalates. |
| Crash mid-turn | The Thread store performs only the explicit, byte-preserving recovery flow; committed steps survive and the interrupted tail remains visible until reconciliation. |

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `loop.maxSteps` | bounded (per agent) | Step limit and last-step wrap-up |
| `loop.maxTurnRetries` | small, bounded | Turn-level retries before block/re-plan |
| `loop.maxToolCallsPerResponse` | finite, versioned default | Reject an oversized response before any of its calls execute |
| `loop.maxToolArgumentBytesPerResponse` | finite, versioned default | Aggregate serialized-argument cap per response |
| `loop.maxResponseBytes` | finite, versioned default | Bound retained text/reasoning/tool payload before parsing/persistence |
| `loop.noProgressLimit` | finite; controller-enforced hard maximum | Automatic no-progress pause/stop threshold, durable across restarts |
| `loop.parallelTools` | on | Independent tool calls run concurrently |
| `loop.toolBarriers` | declared per call | Ordering barriers honored by the scheduler |
| `loop.overflowRecovery` | `once` | Single compact-after-overflow retry |
| `loop.maxToolOutput` | ~2000 lines / 50 KiB | Bounded preview plus artifact ref |
| `budget.tokens` / `budget.cost` / `budget.wallClock` | per direct interactive Thread; managed Runs use Run → Task → Attempt → WorkerExecution reservations | Hard maxima enforced atomically at admission; managed Run verification/recovery reserves are protected |

Configuration is layered (`defaults → user → workspace → agent profile → session`) and the effective model/mode/permission snapshot is persisted with the session (`REQ-SESS-004`). Security ceilings, no-progress ceilings, output limits and budget caps cannot be widened by less trusted layers.

All automatic retry/reconnect branches have a finite controller-owned attempt and
elapsed-time ceiling, exponential backoff with jitter where retryable, and a durable
failure signature. Server `Retry-After` can shorten/defer within the cap but never
raise it. No feature flag, environment variable, build profile, provider response,
peer, or user/workspace setting may turn any retry loop unbounded (`REQ-SEC-013`).
No-progress counters are updated only from controller-validated state/evidence
changes: assistant prose, a plan/reasoning item, heartbeat, activity volume, or a
model's claim of progress cannot reset or satisfy the counter. Codex's pinned
feature-gated connection retry has no attempt ceiling and is expressly not an allowed
HorizonCode option (`research docs/codex.md`).

## Requirements mapping

| Requirement | How this document satisfies it |
|---|---|
| `REQ-LOOP-001` | Bounded step loop with a configurable maximum step count per turn. |
| `REQ-LOOP-002` | Steer and queue inputs admitted and promoted at boundaries without loss. |
| `REQ-LOOP-003` | Scheduler partitions parallel-safe calls and honors ordering barriers. |
| `REQ-LOOP-004` | Exactly one terminal state per turn, and fail-unsettled at every boundary. |
| `REQ-LOOP-005` | Interruption cancels streaming and retains partial work. |
| `REQ-LOOP-006` | Incremental event append before each phase settles. |
| `REQ-LOOP-008` | Whole-response bounded batch assembly and rejection before dispatch; model-generation token usage is charged separately from tool-call caps. |
| `REQ-HORIZON-015` | Durable progress signatures and hard, restart-stable no-progress/retry ceilings govern every automatic continuation. |
| `REQ-HORIZON-016` | Timer and event waits persist and wake without model inference; polling remains a separate bounded action. |
| `REQ-HORIZON-017` / `REQ-UI-016` | User pause fences dispatch and requires explicit resume through a priority control lane. |
| `REQ-TOOL-003` | Tool materialization is permission-filtered; denied tools are absent. |
| `REQ-TOOL-004` | Tool results split model-visible content from UI-only detail. |
| `REQ-CTX-004` | Overflow compacts and retries the same step once. |
| `REQ-PROV-003` | Provider quirks stay in the transport adapter; the loop is vendor-neutral. |
| `REQ-PROV-005` | Routing decisions are policy-driven and observable. |
| `REQ-GUARD-002` | Admission fails closed on an unmatched action. |
| `REQ-AUDIT-001` | Executed effects append to the audit path. |
| `REQ-HORIZON-001` | Turn/step state is resumable after a gap. |
| `REQ-HORIZON-002` | Durable task graph drives continuation and survives compaction. |
| `REQ-HORIZON-003` | Direct Thread ceilings and managed Run hierarchical reservations are enforced and fail closed. |
| `REQ-HORIZON-004` | Waiting states are distinguishable from working states. |
| `REQ-ORCH-001` | Sub-agents return receipts, not transcripts, admitted as typed events. |
| `REQ-SESS-001` | The loop persists through the durable Thread store (`CMP-session`, historic component name). |

## Open questions

1. **Stuck-detector definition.** Whether "no progress" is repeated identical tool calls, unchanged workspace hash, or both; the exact threshold and the escalation primitive are not yet fixed.
2. **Retry policy values.** Maximum strategy changes and repair attempts by execution class remain to be selected and benchmarked; the durable Attempt count and spend do not reset when a new Thread/WorkerExecution is created.
3. **Verification depth in the loop.** Which success conditions require executable verification versus model attestation, and how a failed verification reopens the task graph.
4. **Barrier declaration surface.** Whether ordering barriers are declared by the tool author, the model, or the runtime from write-scope analysis; the reference sources imply but do not settle this.
5. **Partial-marker semantics.** Whether a `partial` step auto-resumes on the next user input or requires explicit confirmation, and how it interacts with budgets.
6. **Pre-step compaction vs post-overflow.** Whether a single compaction policy can serve both the proactive budget check and the reactive overflow path without double-summarizing.
