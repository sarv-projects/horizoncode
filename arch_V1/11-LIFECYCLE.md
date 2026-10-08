# 11. Canonical states and transition contracts

**Status:** normative target contract for the OpenCode-based v1 design. These are
owner-validated transitions, not UI-local state. The owning service appends the event
that makes a transition true; kernel-owned canonical aggregates use the Rust event
log, while host composition state is committed through the sealed CompositionService.
Projections never write lifecycle state.

## 11.1 Transition protocol

Every transition command contains the aggregate ID, expected aggregate version or
owner cursor, a stable `delivery_id`, and a typed event payload. The owner performs
these steps in one owner-stream append boundary:

1. authenticate the caller from the connection and derive its principal/scope;
2. decode the event schema and verify all referenced IDs and immutable digests;
3. compare the expected version, current state, guards, authority and owner epoch;
4. append and durably commit the event;
5. return the committed cursor and owner receipt.

If any check fails, append no lifecycle event. Return `INVALID_TRANSITION`,
`STALE_CURSOR`, `REPLAY_CONFLICT`, or the more specific typed error. Repeating the
same `delivery_id` and payload returns the original receipt; reusing it with a
different payload is `REPLAY_CONFLICT`. A duplicate event is not a second transition.

No implicit transition is allowed on timeout, process exit, host disconnect, UI
close, heartbeat loss, model text, or expiration of an unrelated lease. Recovery is
an explicit owner transition backed by observations. `UNKNOWN` remains distinct from
failure and success.

## 11.2 Closed state sets

The following are the complete v1 wire enums. New values require a schema-versioned
change and a client compatibility review; unknown values are not mapped to success.

| Aggregate | Closed states | Canonical owner |
|---|---|---|
| Thread visibility | `ACTIVE`, `ARCHIVED` | ThreadService |
| Thread input | `ADMITTED`, `PROMOTED`, `CANCELLED` | ThreadService |
| Turn | `PENDING`, `PREPARING`, `PROVIDER_RUNNING`, `WAITING_TOOLS`, `WAITING_USER`, `INTERRUPTING`, `INTERRUPTED`, `COMPLETED`, `FAILED`, `UNKNOWN` | ThreadService |
| ProviderAttempt | `PREPARING`, `REQUESTING`, `STREAMING`, `COMPLETE`, `CANCELLED`, `FAILED_PRE_CONTENT`, `FAILED_POST_CONTENT`, `TRUNCATED`, `UNKNOWN_ACCEPTANCE` | ThreadService records; host reports observations |
| Goal | `DRAFT`, `PREPARING`, `REVIEW`, `READY`, `ACTIVE`, `CANCELLED`, `SUPERSEDED` | RunController |
| SpecVersion | `DRAFT`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `SUPERSEDED` | RunController |
| Run | `DISCOVERING`, `SPECIFYING`, `READY`, `EXECUTING`, `WAITING`, `PAUSED`, `RECOVERING`, `INTEGRATING`, `VERIFYING`, `AWAITING_ACCEPTANCE`, `CANCELLING`, `COMPLETED`, `CANCELLED`, `STOPPED` | RunController |
| Task | `BLOCKED`, `READY`, `CLAIMED`, `RUNNING`, `WAITING`, `VERIFYING`, `PASSED`, `NEEDS_REVIEW`, `FAILED`, `CANCEL_REQUESTED`, `CANCELLED`, `SUPERSEDED` | RunController |
| Attempt | `PREPARED`, `ACTIVE`, `SETTLING`, `SUCCEEDED`, `FAILED`, `UNKNOWN`, `CANCEL_REQUESTED`, `CANCELLED` | RunController |
| WorkerExecution | `PREPARED`, `LAUNCHING`, `RUNNING`, `SETTLING`, `FINISHED`, `FAILED`, `UNKNOWN`, `CANCEL_REQUESTED`, `CANCELLED` | RunController records; ExecutionHost/adapter reports observations |
| Workspace lifecycle | `ALLOCATING`, `PREPARING`, `READY`, `LEASED`, `INTEGRATING`, `CONFLICTED`, `RELEASING`, `RELEASED`, `QUARANTINED`, `UNKNOWN` | WorkspaceService |
| Workspace content state (orthogonal) | `CLEAN`, `DIRTY`, `UNKNOWN` | WorkspaceService observation |
| WorkspaceLease | `REQUESTED`, `ACTIVE`, `RENEWING`, `FENCED`, `EXPIRED`, `RELEASED`, `CANCELLED`, `UNKNOWN` | WorkspaceService |
| EffectIntent | `PREPARED`, `DISPATCHED`, `SETTLED_SUCCESS`, `SETTLED_FAILURE`, `UNKNOWN`, `RECONCILED_PRESENT`, `RECONCILED_ABSENT` | EffectService |
| CapabilityLease | `ISSUED`, `CONSUMED`, `EXPIRED`, `REVOKED` | Guard |
| ToolBatch | `COLLECTING`, `ADMITTED`, `SETTLING`, `SETTLED`, `REJECTED`, `SUSPENDED_FOR_INPUT` | ThreadService owns and commits every transition in the Thread stream |
| Tool post-hook barrier (ToolBatch subrecord keyed by call ID) | `WAITING_HOOKS`, `PERMITTED`, `BLOCKED` | ThreadService; same ToolBatch owner/version, no callback event stream |
| BudgetReservation | `RESERVED`, `PARTIALLY_SETTLED`, `SETTLED`, `RELEASED`, `UNKNOWN` | BudgetService |
| ApprovalChallenge | `CREATED`, `PRESENTED`, `ACCEPTED`, `DENIED`, `EXPIRED`, `INVALIDATED` | Guard |
| SecretUseLease | `ISSUED`, `CONSUMED`, `EXPIRED`, `REVOKED` | SecretBroker |
| Secret record metadata | `AVAILABLE`, `EXPIRED`, `REVOKED`, `MISSING` | SecretBroker; raw values stay in the OS credential store |
| Evidence | `PRODUCED_PASS`, `PRODUCED_FAIL`, `INSUFFICIENT`, `STALE` | VerificationService produces; RunController accepts/invalidate-links |
| VerificationPermit | `ISSUED`, `CONSUMED`, `EXPIRED`, `REVOKED` | VerificationService |
| NeedsYou | `OPEN`, `ANSWERED`, `CANCELLED`, `EXPIRED`, `SUPERSEDED` | Domain owner that raised it; unified projection only |
| Plugin generation | `STAGED`, `VALIDATED`, `ENABLED`, `ACTIVATING`, `READY`, `DRAINING`, `DISABLED`, `FAILED`, `QUARANTINED`, `REMOVED` | CompositionService commits canonical lifecycle; host PluginRuntime reports activation/health observations |
| RepoGeneration | `BUILDING`, `CURRENT`, `PARTIAL`, `STALE`, `FAILED`, `RETIRED` | RepoIntelService |
| CompactionRecord | `ADMITTED`, `PREVIEWED`, `COMMITTED`, `FAILED`, `ABORTED` | ThreadService |
| DirectDelegation | `PREPARED`, `LAUNCHING`, `RUNNING`, `SETTLING`, `FINISHED`, `FAILED`, `UNKNOWN`, `CANCEL_REQUESTED`, `CANCELLED` | ThreadService; same WorkerAdapter/ExecutionHost observation seam |
| RewindPlan | `PREVIEWED`, `APPROVED`, `APPLYING`, `APPLIED`, `CONFLICTED`, `UNKNOWN`, `ABORTED` | WorkspaceService |
| MemoryRecord | `ACTIVE`, `SUPERSEDED`, `TOMBSTONED` | MemoryService |
| MemoryExtraction | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` | MemoryService |
| MemoryCandidate | `PROPOSED`, `ACCEPTED`, `REJECTED`, `EXPIRED` | MemoryService |
| MemoryConsolidation | `QUEUED`, `ORIENTING`, `GATHERING`, `CONSOLIDATING`, `PRUNING`, `COMPLETED`, `FAILED`, `CANCELLED` | MemoryService |
| Composition generation | `CANDIDATE`, `ACTIVATING`, `READY`, `CURRENT`, `DRAINING`, `FAILED`, `QUARANTINED`, `RETIRED` | CompositionService |

`EffectIntent` has no `DENIED` state: a denial is a Guard decision made before an
intent is prepared. A prepared intent is never erased. `Evidence.STALE` is a
freshness classification, not a negative test verdict. `WorkerExecution.FINISHED`
does not transition a Task to `PASSED`.

## 11.3 Thread and provider transitions

| From | Event | Guards | To | Invalid behavior |
|---|---|---|---|---|
| absent | `thread/created` | Project exists; unique ID | `ACTIVE` | `CONFLICT` |
| `ACTIVE` | `thread/legacy_import_started` | Authenticated importer; immutable source snapshot/alias and exact legacy origin validated; ordered historical Turn identity links committed without inferred live authority | `ACTIVE` | Conflicting source digest refuses; exact retry returns same import receipt |
| `ACTIVE` | `thread/legacy_session_imported` | Prior import-started receipt and complete manifest of linked owner operation/message/attachment receipts validate against source counts/digests | `ACTIVE` | Partial saga remains unexposed as complete; no atomic multi-owner claim |
| absent | `thread/forked` | Parent Thread is readable; selected history ranges and relationship are pinned | `ACTIVE` | `STALE_CURSOR` |
| `ACTIVE` | `thread/renamed` | Authorized display-metadata update; no active aggregate mutation conflicts | `ACTIVE` | `STALE_CURSOR` |
| `ACTIVE` | `thread/archived` | No active mutation is being committed | `ARCHIVED` | `INVALID_TRANSITION` |
| `ARCHIVED` | `thread/unarchived` | Caller authorized | `ACTIVE` | `INVALID_TRANSITION` |
| absent | `input/admitted` | Thread active; delivery ID/body digest bounded and unique | `ADMITTED` | `REPLAY_CONFLICT` |
| `ADMITTED` | `input/promoted` | Input is oldest eligible queue item or eligible steer at safe boundary | `PROMOTED` | `INPUT_NOT_ELIGIBLE` |
| `ADMITTED` | `input/cancelled` | Not already promoted | `CANCELLED` | `TOO_LATE` |
| absent | `turn/started` | At least one promoted input; unique Turn ID; pinned context/profile/route | `PENDING` | `INVALID_TRANSITION` |
| absent historical Turn | `turn/legacy_imported` | Authenticated importer; LegacyTurnImportV1 source snapshot and prior thread/legacy_import_started admission receipt validate; historical metadata remains unmediated/unavailable rather than live pins | `UNKNOWN` | No promoted input, live dispatch or fabricated grants implied |
| `PENDING` | `turn/preparation_started` | Context and route snapshot pinned | `PREPARING` | `INVALID_TRANSITION` |
| `PREPARING` | `turn/provider_started` | ProviderAttempt is separately committed as `REQUESTING`; budget/profile/route/toolset digests match | `PROVIDER_RUNNING` | `BUDGET_EXCEEDED` or `STALE_GENERATION` |
| `PROVIDER_RUNNING` | `tool_batch/admitted` | Complete provider response; entire batch validated and admitted | `WAITING_TOOLS` | Reject batch; execute zero unstarted calls |
| `PROVIDER_RUNNING` | `turn/tool_batch_rejected` | ToolBatch rejection is separately committed; zero calls dispatched; bounded rejection committed; pinned route/tool protocol permits rejection continuation and budget permits another request | `PREPARING` | Otherwise use `turn/failed`; do not drop or rewrite provider calls |
| `WAITING_TOOLS` | `turn/waiting_user` | Durable question/approval barrier blocks the next required call; ToolBatch suspension is separately committed | `WAITING_USER` | Keep dependent calls unstarted |
| `WAITING_USER` | `turn/tools_resumed` | Every barrier is resolved; ToolBatch resume and all bindings are separately committed/revalidated | `WAITING_TOOLS` | Keep Turn waiting |
| `PROVIDER_RUNNING` | `turn/waiting_user` | Durable question or approval barrier exists | `WAITING_USER` | `INVALID_TRANSITION` |
| `WAITING_TOOLS` | `turn/tools_settled` | ToolBatch is separately committed `SETTLED`; each call has result or explicit `UNKNOWN`; ordering preserved | `PREPARING` | Keep Turn open; do not fabricate a result |
| `WAITING_USER` | `turn/question_answered` | Linked Thread-owner question resolution is committed at current cursor; no suspended batch | `PREPARING` | `CHALLENGE_STALE` |
| `PROVIDER_RUNNING` | `turn/completed` | Provider terminal observed; all required tool batches settled; assistant message committed | `COMPLETED` | `TURN_NOT_SETTLED` |
| `PENDING`/`PREPARING`/`PROVIDER_RUNNING`/`WAITING_TOOLS`/`WAITING_USER` | `turn/failed` | Turn outcome is known and no effect/launch remains uncertain; UsageService owns observations and BudgetService owns resulting reservation uncertainty | `FAILED` | Keep `UNKNOWN` if provider acceptance or an effect/launch outcome is unresolved |
| `PENDING`/`PREPARING`/`PROVIDER_RUNNING`/`WAITING_TOOLS`/`WAITING_USER` | `turn/cancel_requested` | Target names this Turn, not an ambiguous Thread | `INTERRUPTING` | `INVALID_TRANSITION` |
| `INTERRUPTING` | `turn/interrupted` | Every provider attempt/effect/launch is settled or authoritatively cancelled; no unresolved operation remains | `INTERRUPTED` | Remain `INTERRUPTING`/`UNKNOWN` |
| `INTERRUPTING` | `turn/unknown` | A required provider/effect outcome cannot be determined | `UNKNOWN` | No replay |
| `PROVIDER_RUNNING` | `turn/provider_failed_pre_content` | Latest ProviderAttempt is separately `FAILED_PRE_CONTENT`; no visible content or uncertain acceptance | `PREPARING` or `FAILED` | Retry only under pinned fallback policy |
| `PROVIDER_RUNNING` | `turn/provider_failed_post_content` | Latest ProviderAttempt is separately terminal; partial output is committed as incomplete | `FAILED` | Never silently switch provider |
| `PROVIDER_RUNNING` | `turn/provider_truncated` | ProviderAttempt truncation is separately committed; incomplete envelope and partial content are recorded | `FAILED` | Never treat stream close as completion |
| `PROVIDER_RUNNING` | `turn/provider_unknown` | ProviderAttempt is separately `UNKNOWN_ACCEPTANCE` | `UNKNOWN` | No resend |
| `PENDING`/`PREPARING`/`PROVIDER_RUNNING`/`WAITING_TOOLS`/`WAITING_USER` | `turn/unknown` | A required outcome may have happened but cannot be observed | `UNKNOWN` | No automatic replay |
| `UNKNOWN` | `turn/provider_reconciled` | Linked ProviderAttempt reconciliation proves non-acceptance, recovers a complete response/batch, or proves cancellation; no effect/launch remains uncertain; historical variants permit only terminal closure, never live continuation with missing pins | `PREPARING`, `WAITING_TOOLS`, `FAILED`, `COMPLETED`, or `INTERRUPTED` | If evidence is incomplete, remain `UNKNOWN` |
| `UNKNOWN` | `turn/operations_reconciled` | `TurnOperationsReconciledV1` links authoritative EffectService and supervisor/process or direct-delegation owner receipts for every uncertain operation; provider acceptance is known; ordered results and required messages are committed | `PREPARING`, `WAITING_TOOLS`, `FAILED`, `COMPLETED`, or `INTERRUPTED` | Incomplete or status-only evidence keeps `UNKNOWN`; never resend by inference |

`steer` inputs are promoted at the next safe provider-turn boundary while the Turn
continues. `queue` promotes FIFO only when the current continuation would otherwise
become idle, one item at a time. A promotion batch of steers consumes one boundary.
The durable admission receipt does not imply that the model has seen the input.

Provider fallback is legal only before visible content, tool proposal, or uncertain
provider acceptance, and only when the exact fallback chain, capability set, fixed
reasoning level, policy and remaining budget were pinned in the route snapshot. A
failure after content creates a separate incomplete ProviderAttempt; it is not
concatenated into a fabricated continuous assistant response.

ProviderAttempt has its own state machine; the Turn state does not substitute for it:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `provider_attempt/prepared` | Turn is `PREPARING`; route/profile/toolset and budget reservation are pinned | `PREPARING` |
| `PREPARING` | `provider_attempt/started` | Request dispatch is admitted; all pins still match | `REQUESTING` |
| `REQUESTING` | `provider_attempt/content_started` | First content or complete tool-call proposal observed | `STREAMING` |
| `REQUESTING` | `provider_attempt/completed` | Authoritative clean terminal response with no prior content | `COMPLETE` |
| `STREAMING` | `provider_attempt/completed` | Authoritative terminal response; complete tool batch is separately admitted or no batch exists | `COMPLETE` |
| `PREPARING`/`REQUESTING` | `provider_attempt/failed_pre_content` | Authoritative failure; no visible content/tool proposal; provider acceptance outcome is known | `FAILED_PRE_CONTENT` |
| `STREAMING` | `provider_attempt/failed_post_content` | Partial output is durably recorded as incomplete | `FAILED_POST_CONTENT` |
| `PREPARING`/`REQUESTING`/`STREAMING` | `provider_attempt/cancelled` | Cancellation outcome is authoritative | `CANCELLED` |
| `REQUESTING`/`STREAMING` | `provider_attempt/truncated` | Response ended without a valid complete terminal envelope | `TRUNCATED` |
| `REQUESTING`/`STREAMING` | `provider_attempt/unknown_acceptance` | Request may have been accepted but terminal outcome cannot be proven | `UNKNOWN_ACCEPTANCE` |
| absent historical operation | `provider_attempt/legacy_unknown_imported` | Authenticated importer; exact versioned LegacyUncertainOperationImport provider variant and prior Thread import receipt; source snapshot/alias verified; no live dispatch/grants implied | `UNKNOWN_ACCEPTANCE` |

Terminal ProviderAttempt states are immutable observations. A retry/fallback always
allocates a new `ModelAttemptId`; it never rewrites the previous attempt.
If a provider later supplies authoritative status/result evidence for an
`UNKNOWN_ACCEPTANCE`, append `ProviderAttemptReconciliationV1` linked to the immutable
attempt. Only that receipt can support `turn/provider_reconciled`; ambiguous, partial,
or status-only evidence leaves the Turn `UNKNOWN`. Confirmed non-acceptance permits a
policy-checked new ProviderAttempt, never replay of the old request identity.
For `ACCEPTED_COMPLETE`, the recovered response is validated and durably committed
before the Turn moves to `WAITING_TOOLS` (with a separately admitted batch) or
`COMPLETED` (with a committed final assistant message). `ACCEPTED_CANCELLED` moves to
`INTERRUPTED` only after all effects are settled and no launch remains uncertain.
For `turn/operations_reconciled`, ThreadService selects the target from linked
authoritative outcomes and original cancellation intent: cancelled work becomes
`INTERRUPTED`, known terminal failure becomes `FAILED`, and `COMPLETED` requires the
ordinary terminal message/tool settlement guards. Safe continuation uses `PREPARING`
or `WAITING_TOOLS` only without pending cancellation and with normal pinned admission
checks. A process reconciliation receipt does not settle its external effects.

ToolBatch admission and settlement are separate from provider streaming:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `tool_batch/collecting` | Provider response is complete; call IDs/order and pinned toolset recorded | `COLLECTING` |
| `COLLECTING` | `tool_batch/admitted` | Every schema/resource/budget check passes for the entire batch | `ADMITTED` |
| `COLLECTING` | `tool_batch/rejected` | Any malformed call or aggregate bound violation; zero unstarted calls dispatched | `REJECTED` |
| `ADMITTED` | `tool_batch/settling` | Execution begins only after required per-call EffectIntent PREPARED | `SETTLING` |
| `ADMITTED`/`SETTLING` | `tool_batch/suspended_for_input` | A durable question/approval barrier blocks dependent work | `SUSPENDED_FOR_INPUT` |
| `SUSPENDED_FOR_INPUT` | `tool_batch/resumed` | Exact barrier answered; all bindings revalidated | `SETTLING` |
| `SETTLING` | `tool_batch/settled` | Every call has ordered result or explicit UNKNOWN | `SETTLED` |

A `REJECTED` batch commits the validation failure and dispatches zero calls. The host
returns a bounded batch-level rejection to the provider continuation only when the
pinned route/tool protocol supports that response; otherwise it fails the Turn. It
never silently drops or rewrites an invalid call.

ToolExecutionCoordinator is an executor/orchestrator, not a ToolBatch state owner. It
executes an admitted batch and submits bounded incremental `ToolCallObservationV1`
observations through §13's `ToolCallAcknowledgementV1` Interface to ThreadService.
The owner validates call ID/ordinal, settlement links and
duplicate delivery, commits `tool/result_committed`, and returns its cursor before
`after_tool`/`tool_failure` runs. Required post-hook completion (or an explicit typed
failure blocking dependent work) precedes dependent calls; independent calls may settle
out of order, but model-visible results retain provider order. A final bounded ordered
report covers every call and references the already committed result cursors; it cannot
overwrite acknowledged results. ThreadService alone commits `SETTLING`, suspension/resumption,
and `SETTLED`/`REJECTED` transitions after validating the report; executor code cannot
append ToolBatch events or maintain a second canonical ToolBatch store.

ThreadService initializes each post-hook barrier as `WAITING_HOOKS` alongside its
`tool/result_committed` fact (or by a linked `tool/post_hook_barrier_updated` append
immediately before hook invocation). The record uses §13's sole
`ToolCallAcknowledgementV1` basis: exact resultCursor, observation/call/batch identity,
pinned hookSetDigest, bounded receipt/error refs and dependentDispatch state. Barrier
commands compare the current ToolBatch aggregate version and expected prior barrier
state; `AggregateTransitionV1` identifies that owning ToolBatch, whose main lifecycle
state is unchanged by the subrecord update. These are owner bookkeeping events, not
durable hook callback names.

| Barrier from | Event | Guards | Barrier to |
|---|---|---|---|
| absent | `tool/post_hook_barrier_updated` | Exact resultCursor committed; pinned post-hook set and expected ToolBatch version validate; before any hook invocation/dependent dispatch | `WAITING_HOOKS` |
| `WAITING_HOOKS` | `tool/post_hook_barrier_updated` | Required hooks completed or exact pinned set has none; bounded authenticated receipts match resultCursor/hookSetDigest; no unresolved hook effect; expected prior barrier/version current | `PERMITTED` |
| `WAITING_HOOKS` | `tool/post_hook_barrier_updated` | Known terminal hook failure with typed diagnostic/receipts; all hook effects authoritatively reconciled; expected prior barrier/version current | `BLOCKED` |
| `WAITING_HOOKS` | `tool/post_hook_barrier_updated` | Hook/effect outcome uncertain; exact linked reconciliation/NeedsYou refs retained at current version; no dependent dispatch | `WAITING_HOOKS` |

Only committed `PERMITTED` permits dependent dispatch. `BLOCKED` causes bounded typed
results for unstarted dependents without overwriting settled outcomes. Uncertain hook
effects remain `WAITING_HOOKS` with precise NeedsYou/reconciliation; timeout or mere
failure observation cannot commit a false terminal barrier. Restart reconstructs the
barrier and reconciles existing hook operations before deciding completion; it never
reruns uncertain effects or substitutes the current hook generation.

Compaction is a derived, non-destructive operation:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `compaction/admitted` | Current source cursor and semantic source set, exact recoveryPolicyRef/digest, compositionGeneration/lock digest and immutable resolvedGlobalHookSetRef, stage, unique strategy and bounded attempt ordinal pinned; admission consumes total/per-stage allowance before extraction/summary work | `ADMITTED` |
| `ADMITTED` | `compaction/previewed` | Derived output/source coverage validates; admission pins still match | `PREVIEWED` |
| `PREVIEWED` | `compaction/committed` | Output validates; source cursor is current or safely rebased; original history retained | `COMMITTED` |
| `ADMITTED`/`PREVIEWED` | `compaction/failed` | Extraction, summary, validation or composition failed, including restart reconciliation of interrupted pre-preview work; prior epoch remains active | `FAILED` |
| `ADMITTED`/`PREVIEWED` | `compaction/aborted` | Source changed or caller abandoned work; no uncertain provider/effect operation is replayed | `ABORTED` |

Recovery counts every admitted ordinal, including failed, aborted and crash-interrupted
work; preview is not the admission boundary. Restart reconciles unfinished admissions
against their linked operations before a new strategy is admitted. Recovery bookkeeping
and provider rejection records advance concurrency cursors but do not change the semantic
source set or replenish allowance. Global compaction hooks are activated only through
`CompositionLockV1.globalHookBindings` in §13, never by contribution registration alone.

## 11.4 Goal, spec, Run and Task transitions

### Goal and SpecVersion

| Aggregate/from | Event | Guards | To |
|---|---|---|---|
| Goal absent | `goal/drafted` | Exact user request retained as source artifact | Goal `DRAFT` |
| Goal `DRAFT` | `goal/preparation_started` | Read-only preparation profile and tools only | Goal `PREPARING` |
| Goal `PREPARING` | `goal/preparation_completed` | Planner output schema-valid; candidate spec, DAG and resource/verification scopes linked | Goal `REVIEW` |
| Goal `PREPARING` | `goal/clarification_required` | Durable NeedsYou question created | Goal `PREPARING` |
| SpecVersion absent | `spec/drafted` | Candidate is immutable, linked to Goal and preserves its parent version if revised | SpecVersion `DRAFT` |
| SpecVersion `DRAFT` | `spec/review_opened` | Immutable version and review-bundle digest committed | SpecVersion `IN_REVIEW` |
| SpecVersion `IN_REVIEW` | `spec/approved` | User confirmed exact displayed review-bundle digest; approval receipt committed | SpecVersion `APPROVED` |
| SpecVersion `IN_REVIEW` | `spec/rejected` | User rejection and reason recorded against exact digest | SpecVersion `REJECTED` |
| SpecVersion `DRAFT`/`IN_REVIEW`/`APPROVED` | `spec/superseded` | Explicit successor exists and has a distinct digest | SpecVersion `SUPERSEDED` |
| Goal `REVIEW` | `goal/spec_approved` | Referenced SpecVersion is `APPROVED`; mandatory budgets are reserved and current | Goal `READY` |
| Goal `READY` | `goal/activated` | Approval, policy, budgets, workspace plan and dependency DAG still current | Goal `ACTIVE` |
| nonterminal Goal | `goal/cancelled` | No irreversible effect is implied; child Run cleanup begins | Goal `CANCELLED` |
| prior Goal | `goal/superseded` | Explicit successor exists; old Goal remains addressable | Goal `SUPERSEDED` |

The Planner is a model Turn in the selected main AgentProfile, using a read-only
preparation loadout. It may propose Goal/Spec/Task candidates, but only RunController
validates and commits them. The planner cannot grant permissions, reserve budget,
activate the Run, or create an accepted Task directly.

Goal, SpecVersion and Run are separate aggregates even when one user command advances
more than one. Preparation, approval and activation are owner-coordinated sagas: each
aggregate transition has its own event/receipt and causal reference; no UI or caller
may treat the group as an atomic multi-aggregate commit. Recovery resumes from the
committed aggregate receipts, not from an inferred combined state.

### Run

| From | Event | Guards | To |
|---|---|---|---|
| absent | `run/discovering` | Goal and control Thread exist; initial owner cursor allocated | `DISCOVERING` |
| `DISCOVERING` | `run/specification_started` | Goal exists; bounded preparation is admitted | `SPECIFYING` |
| `SPECIFYING` | `run/specification_approved` | Referenced SpecVersion approval and required reservations are committed | `READY` |
| `READY` | `run/activated` | Approved spec, valid DAG, budget and policy snapshots | `EXECUTING` |
| `EXECUTING` | `run/waiting` | No eligible dispatch, unresolved NeedsYou, quota wait, or external dependency | `WAITING` |
| `WAITING` | `run/resumed` | Cause resolved; recovery checks pass | `EXECUTING` |
| `EXECUTING` | `run/paused` | Stop new claims; in-flight work may settle | `PAUSED` |
| `PAUSED` | `run/resumed` | No unresolved unsafe effect/launch; fresh owner epoch/fences | `EXECUTING` |
| `DISCOVERING`/`SPECIFYING`/`READY`/`EXECUTING`/`WAITING`/`PAUSED`/`INTEGRATING`/`VERIFYING`/`AWAITING_ACCEPTANCE`/`CANCELLING` | `run/recovery_started` | New supervisor owner epoch; old writers fenced; durable pre-recovery state captured | `RECOVERING` |
| `RECOVERING` | `run/recovery_settled` | All safe state reconstructed; UNKNOWN items remain visible | Recorded safe prior nonterminal state or `WAITING` |
| `EXECUTING` | `run/integration_started` | Required Tasks have execution results; integration order deterministic | `INTEGRATING` |
| `INTEGRATING` | `run/integration_settled` | All required repository outcomes settled or explicit conflict | `VERIFYING` or `WAITING` |
| `VERIFYING` | `run/next_wave_started` | RunController validates current prerequisite Evidence and PASSED dependencies against the active approved spec/integrated subject; eligible remaining Tasks exist, including READY Tasks admitted by verification_failed_retryable; budgets, fences and policy are current; no required unresolved effect/launch blocks dispatch | `EXECUTING` |
| `VERIFYING` | `run/acceptance_ready` | All required evidence is current; if human acceptance is required, enter acceptance wait; otherwise CompletionPredicate is true | `AWAITING_ACCEPTANCE` or `COMPLETED` |
| `AWAITING_ACCEPTANCE` | `run/accepted` | User accepted the exact final report digest; CompletionPredicate is now true | `COMPLETED` |
| `AWAITING_ACCEPTANCE` | `run/acceptance_rejected` | Exact reason recorded; create revised spec or NeedsYou | `WAITING` |
| nonterminal | `run/cancel_requested` | Run-level fence installed before acknowledgement | `CANCELLING` |
| `CANCELLING` | `run/cancelled` | No in-scope process or effect remains unresolved | `CANCELLED` |
| `CANCELLING` | `run/stopped` | Hard stop completed as far as observable; unknown effects retained | `STOPPED` |

There is deliberately no generic `FAILED → retry` transition. A new approach is a
new Attempt under the same Task if the active spec permits it and limits remain.
An unresolved launch/effect keeps the Run in `RECOVERING`, `WAITING` or `CANCELLING`;
it cannot be coerced into a terminal success/failure label.

### Task

| From | Event | Guards | To |
|---|---|---|---|
| absent | `task/created` | Same Run/spec; dependency graph acyclic; scope and acceptance IDs valid | `BLOCKED` or `READY` |
| `BLOCKED` | `task/dependencies_satisfied` | Every required dependency is currently `PASSED` | `READY` |
| `READY` | `task/claimed` | Run dispatch enabled; limits/capacity/workspace claim available | `CLAIMED` |
| `CLAIMED` | `task/attempt_started` | A separately committed Attempt is `ACTIVE`; strategy/profile/workspace/route/budget pins still match | `RUNNING` |
| `RUNNING` | `task/waiting` | A blocking reason/NeedsYou is linked | `WAITING` |
| `WAITING` | `task/resumed` | Blocking reason resolved and owner snapshots revalidated | `RUNNING` or `READY` |
| `RUNNING` | `task/verification_started` | Run is `VERIFYING`; producer result/effects settled; exact integrated subject and permit committed | `VERIFYING` |
| `VERIFYING` | `task/passed` | Current independent Evidence covers all mandatory scenarios | `PASSED` |
| `VERIFYING` | `task/needs_review` | Evidence insufficient, conflict, or policy requires human judgement | `NEEDS_REVIEW` |
| `VERIFYING` | `task/failed` | Current independent failed Evidence covers a required scenario; no permitted retry remains; owned verifier/process/effect outcomes are known and settled | `FAILED` |
| `VERIFYING` | `task/verification_failed_retryable` | Current independent failed Evidence for the exact subject/spec/policy is linked; retry policy permits a distinct bounded strategy with remaining attempts and budget; all owned verifier/process/effect outcomes settled; prerequisite Evidence and dependencies still current | `READY` |
| `PASSED` | `task/evidence_stale` | RunController observes committed stale Evidence and re-evaluates active spec/dependency links | `READY` or `SUPERSEDED` |
| `RUNNING` | `task/attempt_failed_retryable` | Current Attempt is terminal `FAILED`; retry policy, remaining attempts, budget and distinct strategy permit retry | `READY` |
| `RUNNING` | `task/execution_failed` | Current Attempt is terminal `FAILED`; no retry is permitted/remains; all owned process/effect outcomes are known and settled | `FAILED` |
| `NEEDS_REVIEW` | `task/reopened` | Human decision or bounded new strategy recorded | `READY` |
| nonterminal | `task/cancel_requested` | Task-level fence installed; independent Tasks untouched | `CANCEL_REQUESTED` |
| `CANCEL_REQUESTED` | `task/cancelled` | Every in-scope execution/effect is authoritatively settled/cancelled; no uncertain outcome remains | `CANCELLED` |
| nonterminal | `task/superseded` | Approved successor spec; old work fenced and linked | `SUPERSEDED` |

Dependents of a cancelled, failed or superseded Task become `BLOCKED` with the exact
dependency cause. Independent Tasks do not inherit cancellation. A failed Attempt may
return a Task to `READY` only when retry policy, remaining attempts, budget and a
distinct bounded strategy permit it.
Failed verification follows `task/verification_failed_retryable` only under those
guards; it is not insufficient Evidence or a fabricated NEEDS_REVIEW workaround.
RunController then returns the verification wave to EXECUTING through
`run/next_wave_started` when that READY retry Task is eligible. It allocates a new
Attempt with fresh execution limits while preserving failed Evidence/history and
aggregate Task/Run limits; stale Evidence or any unknown operation cannot admit retry.

## 11.5 Attempt, WorkerExecution and workspace transitions

| Aggregate/from | Event and guards | To | Owner |
|---|---|---|---|
| Attempt absent | `attempt/prepared`: strategy digest, pinned profile, context, workspace, budget and fence recorded | `PREPARED` | RunController |
| Attempt `PREPARED` | `attempt/activated`: Task remains claimed; WorkerExecution dispatch is permitted | `ACTIVE` | RunController |
| Attempt `ACTIVE`/`SETTLING` | `attempt/execution_limits_updated`: current limit-state artifact and linked response/tool/usage receipts validate; counters monotonic; profile/hook pins unchanged; commit before next admission | Same state | RunController |
| Attempt `ACTIVE` | `attempt/settling`: all WorkerExecutions terminal or explicitly uncertain | `SETTLING` | RunController |
| Attempt `SETTLING` | `attempt/succeeded`: strategy protocol completed; no unresolved required effect | `SUCCEEDED` | RunController |
| Attempt `SETTLING` | `attempt/failed`: strategy failure and all owned execution/effect outcomes are known; no unresolved operation remains | `FAILED` | RunController |
| `PREPARED`/`ACTIVE`/`SETTLING` | `attempt/unknown`: execution/effect acceptance cannot be established | `UNKNOWN` | RunController |
| Attempt `UNKNOWN` | `attempt/reconciled`: authoritative observations establish all owned worker/effect outcomes | `SETTLING` | RunController |
| `PREPARED`/`ACTIVE`/`SETTLING`/`UNKNOWN` | `attempt/cancel_requested`: fence and signal requested | `CANCEL_REQUESTED` | RunController |
| Attempt `CANCEL_REQUESTED` | `attempt/cancelled`: all owned workers/effects authoritatively settled/cancelled; no uncertain outcome remains | `CANCELLED` | RunController |
| WorkerExecution absent | `worker/dispatch_planned`: stable outbox key and incarnation allocated | `PREPARED` | RunController |
| WorkerExecution `PREPARED` | `worker/launching`: exact adapter/backend and fence passed to ExecutionHost | `LAUNCHING` | RunController |
| WorkerExecution `LAUNCHING` | `worker/started`: authenticated launch receipt observed | `RUNNING` | RunController |
| WorkerExecution `LAUNCHING` | `worker/unknown`: launch may have occurred without receipt | `UNKNOWN` | RunController |
| WorkerExecution `RUNNING` | `worker/settling`: exit/result observed; workspace diff captured | `SETTLING` | RunController |
| WorkerExecution `SETTLING` | `worker/finished` / `worker/failed`: adapter observation validated | `FINISHED` / `FAILED` | RunController |
| `PREPARED`/`LAUNCHING`/`RUNNING`/`SETTLING`/`UNKNOWN` | `worker/cancel_requested`: cancellation supported or process termination attempted | `CANCEL_REQUESTED` | RunController |
| WorkerExecution `CANCEL_REQUESTED` | `worker/cancelled`: termination/reconciliation is authoritative | `CANCELLED` | RunController |
| WorkerExecution uncertain states | `worker/reconciled`: authoritative process/peer receipt resolves outcome | `FINISHED`, `FAILED`, or `CANCELLED` | RunController |

A blocking `before_finish` hook does not commit `worker/finished` or transition
WorkerExecution to `FINISHED`. For a native or mediated worker with a continuing loop,
it returns bounded feedback and WorkerExecution remains `RUNNING` while applicable
limits permit another turn. The hook cannot transition a Task to `PASSED` or create
accepted Evidence. If the hook blocks but no turn remains, the execution follows the
limit-exhaustion path below.

When continuing would exceed `maxTurns` or another per-worker hard `AgentLimit` (wall
time, token or tool-call limit), no further provider turn is admitted. The existing
`worker/settling` transition records a typed `AGENT_LIMIT_EXCEEDED` result with the
exhausted dimension; the validated terminal transition is `worker/failed` to `FAILED`.
RunController may instead apply the owning Task/Run policy by raising NeedsYou or
authorizing another permitted Attempt. Admission-scoped `maxConcurrent` and `maxAttempts`
limits prevent dispatch or another Attempt; they do not synthesize a WorkerExecution
terminal event. A new Attempt starts a new profile-limit counter but does not reset
aggregate Task/Run limits. Resuming or recovering the same WorkerExecution preserves
its counter and pinned hook set. Attempt-scoped `executionLimitStateRef` pins the
persisted `ExecutionLimitStateV1` artifact across process replacements; counter advances
are committed owner facts before another provider request. These rules add no WorkerExecution states.

Task, Attempt and WorkerExecution are separate aggregates. Start/dispatch therefore
commits `task/claimed`, `attempt/prepared`, `attempt/activated`, `task/attempt_started`
and worker outbox/launch observations as separately versioned, causally linked owner
events. ExecutionHost launch is refused until the required receipts and fences are
current; a partial sequence is recovered from those receipts, never inferred as an
atomic transition.

An Attempt retry/resume that launches another process creates a new
`WorkerExecutionId`, sets `replacementOf` to the prior execution and increments
`incarnation`; it does not silently create a new Attempt. The replacement retains the
Attempt's execution-limit lineage/counters and pinned hook set, not a fresh allowance.
A new Attempt gets fresh execution limits while aggregate Task/Run caps remain unchanged.
If the prior incarnation might still write, the shared workspace remains
fenced and no replacement writer starts.

### Direct native delegation

`DirectDelegationV1` is a Thread-owned aggregate identified by `delegationRootId`
(the original WorkerExecutionId),
not a managed WorkerExecution/Task/Attempt/Run. The same adapter, profile registry,
ExecutionHost, Guard, budget and workspace owners are reused; ThreadService alone
commits the following lifecycle to the parent Thread stream:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `direct_delegation/prepared` | Parent Turn and child Thread linked; native profile eligible; DirectWorkerBinding and DirectTaskPackage pins, budget, limits and scope current | `PREPARED` |
| `PREPARED` | `direct_delegation/launching` | Stable dispatch identity and current owner epoch/fence; normal authorized effect launch | `LAUNCHING` |
| `LAUNCHING` | `direct_delegation/started` | Authenticated exact launch receipt committed | `RUNNING` |
| `LAUNCHING`/`RUNNING`/`SETTLING` | `direct_delegation/unknown` | Launch/provider/effect may have occurred without authoritative outcome | `UNKNOWN` |
| `RUNNING` | `direct_delegation/settling` | Bounded direct result observed; child operations settled or explicitly uncertain | `SETTLING` |
| `RUNNING` | `direct_delegation/execution_limits_updated` | Current limit-state artifact/response receipts validate; monotonic counters, unchanged profile/hook pins; commit before another request | `RUNNING` |
| `SETTLING` | `direct_delegation/replacement_prepared` | Prior incarnation/owned effects are authoritatively settled and writer fenced; continuation is policy-permitted with remaining root-scoped limits; fresh WorkerExecutionId/replacementOf/incarnation and dispatch/launch identities pinned | `PREPARED` |
| `SETTLING` | `direct_delegation/finished` / `direct_delegation/failed` | Typed direct result validated; no owned uncertain process/effect remains | `FINISHED` / `FAILED` |
| `PREPARED`/`LAUNCHING`/`RUNNING`/`SETTLING`/`UNKNOWN` | `direct_delegation/cancel_requested` | Exact execution fenced; scoped cancellation requested | `CANCEL_REQUESTED` |
| `CANCEL_REQUESTED` | `direct_delegation/cancelled` | All owned operations authoritatively settled/cancelled | `CANCELLED` |
| `UNKNOWN` | `direct_delegation/reconciled` | Linked process/provider/effect receipts establish every owned outcome | `SETTLING` |

Native `before_finish`, post-tool acknowledgement and AgentLimit rules apply unchanged;
direct limit state is Thread-owned under stable delegationRootId and retained across
reconciliation/replacement, never replenished by recovery. DispatchId and LaunchId are
preallocated at preparation, not proof that launch occurred; each incarnation retains
its own identity/receipts in the root aggregate. Direct results bind root and current
execution and cannot contain Task PASS or accepted Evidence.

Workspace lifecycle and content cleanliness are separate dimensions; a workspace may
be `LEASED` and `DIRTY` at the same time. Workspace creation is
`ALLOCATING → PREPARING → READY`. A lease is `REQUESTED → ACTIVE`; renewal increments
no fence; release, expiry, reclaim, owner takeover, or reconciliation increments the
fence epoch before another writer may start. Every write binds
`{workspace_id, fence_epoch, expected_revision}`. A mismatch returns `STALE_FENCE`
before mutation. `DIRTY` is an observation of bytes, not a lease/lifecycle state.
Content observations are owner facts (`workspace/content_observed`) carrying revision
and manifest digests; they update `CLEAN`/`DIRTY`/`UNKNOWN` without advancing the
workspace lifecycle.

| Workspace from | Event | Guards | To |
|---|---|---|---|
| absent | `workspace/created` | Project/repository bindings and root identities validated | `ALLOCATING` |
| `ALLOCATING` | `workspace/preparation_started` | Exclusive creation reservation acquired | `PREPARING` |
| `PREPARING` | `workspace/ready` | Base revision and directory identity verified | `READY` |
| `READY` | `workspace/lease_acquire_observed` | Separate WorkspaceLease `ACTIVE` receipt/fence is committed | `LEASED` |
| `LEASED` | `workspace/lease_release_observed` | Separate WorkspaceLease `RELEASED` receipt committed; revision/dirty manifest observed | `READY` |
| `LEASED` | `workspace/integration_started` | Exact base revision and integration plan pinned; active exclusive integration lease/fence current; producer writers settled/fenced | `INTEGRATING` |
| `INTEGRATING` | `workspace/integration_succeeded` | Before/after revisions and changed paths captured; lease is released/fenced | `RELEASING` |
| `INTEGRATING` | `workspace/integration_conflicted` | Conflicting paths and observed revisions captured | `CONFLICTED` |
| `CONFLICTED` | `workspace/conflict_resolved` | Exact previewed resolution committed; new revision observed | `READY` |
| `READY`/`CONFLICTED` | `workspace/release_started` | No active writer; cleanup is admitted under current fence | `RELEASING` |
| `RELEASING` | `workspace/released` | Root identity, final revision and cleanup receipt verified; no active lease/effect | `RELEASED` |
| active | `workspace/reconciliation_required` | Owner cannot establish writer/bytes/lease outcome | `UNKNOWN` |
| `UNKNOWN` | `workspace/reconciled` | Old writers/effects settled or fenced; new revision and fence established | `READY` |
| any releasable state | `workspace/quarantined` | Cleanup or identity proof failed | `QUARANTINED` |

| Lease from | Event | Guards | To |
|---|---|---|---|
| absent | `workspace_lease/requested` | Authenticated owner, exact scope and expected revision validated | `REQUESTED` |
| `REQUESTED` | `workspace_lease/acquired` | Exact workspace/revision available; owner and expiry recorded | `ACTIVE` |
| `REQUESTED` | `workspace_lease/cancelled` | Acquisition was not committed and no writer was admitted | `CANCELLED` |
| `ACTIVE` | `workspace_lease/renewal_started` | Lease is current; renewal request is bounded and owner-authenticated | `RENEWING` |
| `RENEWING` | `workspace_lease/renewed` | Current owner epoch and lease token valid; no fence change | `ACTIVE` |
| `ACTIVE`/`RENEWING` | `workspace_lease/released` | Writer stopped; final revision observed; fence epoch increments before reuse | `RELEASED` |
| `ACTIVE`/`RENEWING` | `workspace_lease/fenced` | Owner takeover, scoped cancellation, conflict or maintenance fence committed first | `FENCED` |
| `ACTIVE`/`RENEWING` | `workspace_lease/expired` | Deadline passed; fence epoch increments before reuse | `EXPIRED` |
| `FENCED`/`EXPIRED` | `workspace_lease/reconciled` | Old writer/effects settled or retained as UNKNOWN; new fence established | `RELEASED` or `UNKNOWN` |
| `UNKNOWN` | `workspace_lease/reconciled` | Writer and lease outcome authoritatively established; fence advanced before reuse | `RELEASED` or `EXPIRED` |

Workspace and WorkspaceLease have separate aggregate versions even though
WorkspaceService owns both. Lease acquire/release and workspace lifecycle changes are
causally linked owner events/receipts; the workspace remains unavailable for reuse
until the lease receipt and fence update are committed. Between the lease event and
the corresponding Workspace lifecycle observation, WorkspaceService checks the
canonical active lease/fence directly and rejects competing acquisition or reuse; it
does not trust a lagging `READY` projection. No command implies a multi-aggregate
atomic commit.

Integration first acquires/observes the exclusive lease (`READY → LEASED`), then is
`LEASED → INTEGRATING → RELEASING → RELEASED` on success, or
`INTEGRATING → CONFLICTED`; conflict is never auto-resolved by completion-order merge. `UNKNOWN`
workspace state is held from reuse until owner reconciliation. A failed cleanup is
`QUARANTINED`, not `RELEASED`.

## 11.6 Effect, approval, evidence, NeedsYou and plugin transitions

### EffectIntent and approval

| From | Event | Guards | To |
|---|---|---|---|
| absent | `effect/prepared` | Guard ALLOW or valid approval; exact resource/args/policy digests; budget reservation; execution plan ready | `PREPARED` |
| `PREPARED` | `effect/dispatched` | Single-use capability lease; expected workspace fence/revision still current | `DISPATCHED` |
| `PREPARED` | `effect/settled_failure` | Authoritative proof no effect began or deterministic operation failure | `SETTLED_FAILURE` |
| `DISPATCHED` | `effect/settled_success` | Target receipt/observation confirms applied outcome | `SETTLED_SUCCESS` |
| `DISPATCHED` | `effect/settled_failure` | Target proves no mutation or completed failure semantics | `SETTLED_FAILURE` |
| `PREPARED`/`DISPATCHED` | `effect/unknown` | Dispatch or result may have occurred without authoritative receipt | `UNKNOWN` |
| `UNKNOWN` | `effect/reconciled_present` | Target-specific evidence proves the requested effect is present | `RECONCILED_PRESENT` |
| `UNKNOWN` | `effect/reconciled_absent` | Target-specific evidence proves no effect occurred | `RECONCILED_ABSENT` |
| absent historical operation | `effect/legacy_unknown_imported` | Authenticated importer; exact versioned LegacyUncertainOperationImport effect variant and linked Thread import receipt; source provenance preserved as historical_unmediated; no fabricated grants or live dispatch | `UNKNOWN` |

Retry after `RECONCILED_ABSENT` uses a new EffectId linked to the old intent. A
target-provided idempotency contract may permit same-target replay, but that contract
and key are pinned in the intent. No timeout alone means absence.
Historical import initialization uses only the dedicated versioned payload in §12.3,
not live `effect/prepared` or `provider_attempt/prepared` with invented authorization
pins. ThreadService links each imported operation/alias and EffectService owns imported
effect uncertainty; live guards are unchanged. Imported uncertainty is reconciled by
existing owners before any independently authorized new operation is admitted.

| From | Event | Guards | To |
|---|---|---|---|
| absent | `capability/lease_issued` | Exact PREPARED EffectIntent and current Guard ALLOW/approval; all subject/resource/fence bindings match | `ISSUED` |
| `ISSUED` | `capability/lease_consumed` | ExecutionHost validates the lease immediately before the one operation | `CONSUMED` |
| `ISSUED` | `capability/lease_expired` | Lease deadline passed before use | `EXPIRED` |
| `ISSUED` | `capability/lease_revoked` | Guard/policy/fence/subject binding changed | `REVOKED` |

ApprovalChallenge is created only for `ASK`, binds the effect/action, resource set,
canonical displayed-content digest, policy digest, resource-state digest, principal,
scope and expiry. It can be presented repeatedly but accepted/denied once. Policy,
resource, profile, Run or effect-digest change invalidates it; acceptance never
silently broadens beyond the displayed scope. A concurrent accept/deny is a compare-
and-swap; the first committed resolution wins and later resolutions return
`CHALLENGE_ALREADY_RESOLVED`.

| From | Event | Guards | To |
|---|---|---|---|
| absent | `approval/challenge_created` | Guard decision is `ASK`; exact subject and displayed digest persisted | `CREATED` |
| `CREATED` | `approval/challenge_presented` | Current subject/policy/resource bindings still match | `PRESENTED` |
| `PRESENTED` | `approval/accepted` | Allowed response; exact current binding; grant committed atomically | `ACCEPTED` |
| `PRESENTED` | `approval/denied` | Denial targets exact challenge | `DENIED` |
| `CREATED`/`PRESENTED` | `approval/expired` | Challenge deadline passed | `EXPIRED` |
| `CREATED`/`PRESENTED` | `approval/invalidated` | Any bound subject, policy, resource, profile, Run or effect digest changed | `INVALIDATED` |

### Evidence and NeedsYou

| From | Event | Guards | To |
|---|---|---|---|
| absent | `verification/permit_issued` | Integrated subject, approved spec, exact scenario set, read-only backend guarantees and budget validated | `ISSUED` |
| `ISSUED` | `verification/permit_consumed` | Exact WorkerExecution/subject/profile/environment matches; commit consumption before launch | `CONSUMED` |
| `ISSUED` | `verification/permit_expired` | Deadline elapsed before consumption | `EXPIRED` |
| `ISSUED` | `verification/permit_revoked` | Bound subject, policy, profile, toolchain or environment changed before launch | `REVOKED` |

Evidence is created by a verifier execution only. `PRODUCED_PASS`, `PRODUCED_FAIL`
and `INSUFFICIENT` are immutable verdict records. A later `STALE` event links the
prior record and names the changed subject field; it never rewrites the verdict.
RunController alone may attach current Evidence to a Task and transition it to
`PASSED`.

| From | Event | Guards | To |
|---|---|---|---|
| absent | `verification/evidence_produced` | Verifier execution/permit and immutable scenario observations are valid | `PRODUCED_PASS`, `PRODUCED_FAIL`, or `INSUFFICIENT` according to verdict |
| produced state | `verification/evidence_stale` | Bound subject, spec, policy, environment, toolchain or scenario version changed | `STALE` |

VerificationPermit is bound to one exact integrated subject and one verifier
WorkerExecution. `ISSUED → CONSUMED` is committed before launch; expiry or any change
to subject, policy, profile or environment revokes an unconsumed permit. A consumed
permit is never reissued after uncertain launch; the existing WorkerExecution must be
reconciled first.

NeedsYou is a typed projection over one owning challenge/event: `PERMISSION`, `QUESTION`,
`GOAL_REVIEW`, `CLARIFICATION`, `AUTH`, `PROVIDER_QUOTA`, `CAPABILITY_GAP`,
`BUDGET_EXTENSION`, `WORKSPACE_CONFLICT`, `EXTERNAL_WORKER`, `PLUGIN_FAILURE`, or
`RECOVERY_CHOICE`. Every item has a summary, affected IDs, consequence-of-no-response,
allowed typed responses, expiry policy, and source owner/cursor. Resolving the projection
must commit the owning domain's event first; the projection cannot resolve a challenge
by itself. `NeedsYouV1` is not an independent aggregate or event stream: its state is
derived from the owner event (for example `approval/challenge_created`,
`question/opened`, `goal/clarification_required`, or `workspace/integration_conflicted`)
and the matching owner resolution event (for example `question/answered`). The Turn
records a separate `turn/question_answered` transition after the Thread-owner answer
receipt. The following table specifies projection-state mapping, not
generic `needs_you/*` event discriminators.

| From | Event | Guards | To |
|---|---|---|---|
| absent | Owner challenge/open event | Owning event committed; owner cursor and response schema pinned | `OPEN` |
| `OPEN` | Owner resolution event | Response validates and owner accepts it at expected cursor | `ANSWERED` |
| `OPEN` | Owner cancellation event | Owning operation safely cancelled or superseded by explicit control | `CANCELLED` |
| `OPEN` | Owner expiry event | Expiry reached; owning domain records consequence | `EXPIRED` |
| `OPEN` | Owner supersession event | New challenge replaces it; old item remains addressable | `SUPERSEDED` |

### Checkpoint rewind and memory

Checkpoint records are immutable snapshots; creating one appends `checkpoint/created`
only after owner cursors, repository revisions and pinned artifacts are verified.
Rewind plans use these guarded transitions:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `rewind/previewed` | Checkpoint exists; current/target digests and owned paths are computed | `PREVIEWED` |
| `PREVIEWED` | `rewind/approved` | User approves exact plan digest; current state still matches preview | `APPROVED` |
| `PREVIEWED`/`APPROVED` | `rewind/aborted` | No restore dispatch remains in flight | `ABORTED` |
| `APPROVED` | `rewind/applying` | Guard, workspace lease/fence and durable EffectIntent are current | `APPLYING` |
| `APPLYING` | `rewind/applied` | Restore receipt and new revision are observed; affected Evidence is stale | `APPLIED` |
| `APPLYING` | `rewind/conflicted` | Owned-path drift or deterministic conflict is observed | `CONFLICTED` |
| `APPLYING` | `rewind/unknown` | Restore may have changed bytes but receipt is missing | `UNKNOWN` |
| `UNKNOWN` | `rewind/reconciled` | Exact restore outcome and resulting revision are authoritatively observed | `APPLIED` or `CONFLICTED` |

Memory records are advisory; their lifecycle is owned by MemoryService:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `memory/created` | Scope, provenance, content digest and retention class validated | `ACTIVE` |
| absent | `memory/candidate_accepted` | User-reviewed candidate, policy and target scope validate; same owner commit links candidate and new MemoryRecord by stable IDs | `ACTIVE` |
| `ACTIVE` | `memory/superseded` | Authorized explicit replacement links the old record; model-derived consolidation supersession occurs only inside the exact reviewed `memory/candidate_accepted` append after fresh source-generation/content checks | `SUPERSEDED` |
| `ACTIVE`/`SUPERSEDED` | `memory/tombstoned` | Authorized scope deletion committed; replicas receive tombstone | `TOMBSTONED` |

Extraction and consolidation are bounded MemoryService-owned jobs; their indexes are
rebuildable projections, not additional authorities:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `memory/extraction_queued` | Explicit scoped extraction policy is enabled; completed source range, cursor, extractor and policy digests are pinned; duplicate key is reconciled | `QUEUED` |
| `QUEUED` | `memory/extraction_started` | Low-priority capacity admitted; source Thread range and policy remain current | `RUNNING` |
| `RUNNING` | `memory/extraction_completed` | Candidate proposals validate against the pinned source range and schema | `COMPLETED` |
| `QUEUED`/`RUNNING` | `memory/extraction_failed` | Typed failure recorded; no partial candidate is accepted | `FAILED` |
| `QUEUED`/`RUNNING` | `memory/extraction_cancelled` | Cancellation, policy disable or higher-priority pressure observed at a safe boundary | `CANCELLED` |
| absent | `memory/candidate_proposed` | Source provenance, proposed scope, policy and retention are recorded | `PROPOSED` |
| `PROPOSED` | `memory/candidate_accepted` | MemoryService validates authorization, provenance, sensitivity, scope and fresh source generations/digests; user review receipt binds exact candidate digest/target scope/replacement set; candidate acceptance, new MemoryRecord and accepted supersession links commit in one owner append | `ACCEPTED` |
| `PROPOSED` | `memory/candidate_rejected` | Authorized owner decision records rejection reason | `REJECTED` |
| `PROPOSED` | `memory/candidate_expired` | Candidate retention/decision deadline elapsed | `EXPIRED` |
| absent | `memory/consolidation_queued` | One scope and source generation pinned; bounded strategy and input set validated | `QUEUED` |
| `QUEUED` | `memory/consolidation_orienting` | Low-priority capacity admitted; scope generation remains current | `ORIENTING` |
| `ORIENTING` | `memory/consolidation_gathering` | Bounded input selection and provenance checks complete | `GATHERING` |
| `GATHERING` | `memory/consolidation_consolidating` | Inputs remain pinned; candidates only, no canonical record rewrite | `CONSOLIDATING` |
| `CONSOLIDATING` | `memory/consolidation_pruning` | Proposed supersession links and candidate provenance validate | `PRUNING` |
| `PRUNING` | `memory/consolidation_completed` | Candidate proposals and proposed supersession only committed; source records/tombstones preserved pending exact reviewed acceptance | `COMPLETED` |
| nonterminal | `memory/consolidation_failed` | Typed failure recorded; no source record is silently deleted or rewritten | `FAILED` |
| nonterminal | `memory/consolidation_cancelled` | Cancellation, stale generation or higher-priority pressure observed safely | `CANCELLED` |

Search queries are read-only and bounded. They filter by current principal and profile
memory policy before ranking; a bounded authorized transcript-range fallback is
permitted only after structured memory results. Stale or contradicted records remain
advisory and are marked stale/superseded, never elevated over current repository or
effect observations.

### Plugin generation

Normal lifecycle: `STAGED → VALIDATED → ENABLED → ACTIVATING → READY → DRAINING →
DISABLED`; install may fail to `FAILED`; emergency revocation moves to `QUARANTINED`;
removal is allowed only after disable/drain or an explicit retained recovery record.
`READY → DRAINING` rejects new leases but honors existing generation pins. A
quarantine revokes new capability leases immediately; active users enter explicit
failure/recovery paths. Generation pinning includes plugin digest, service graph
digest, tool schema digest and profile revision. CompositionService owns the durable
manifest, lock and generation lifecycle; host PluginRuntime owns executable activation,
disposal and health probes, and reports those observations as transition evidence.

The composition pointer and all generation/plugin lifecycle entries are subrecords of
one `CompositionStateV1` aggregate and one CompositionService stream. Generation status
rows below are not separate aggregates. This makes publish (new generation becomes
`CURRENT`, prior current becomes `DRAINING`, active pointer advances) one compare-and-
append transition rather than an atomicity claim across stores.

| From | Event | Guards | To |
|---|---|---|---|
| absent | `composition/candidate_committed` | Candidate lock, capability approvals, config and monotonic generation validate | `CANDIDATE` |
| `CANDIDATE` | `composition/activation_started` | Host runtime acknowledges exact lock digest; required services remain sealed/current | `ACTIVATING` |
| `ACTIVATING` | `composition/ready` | Every required provider activation/health receipt matches the candidate lock | `READY` |
| `READY` | `composition/published` | Expected current pointer matches; new `CURRENT` and prior `DRAINING` statuses plus pointer update commit in this single CompositionState event | `CURRENT` |
| `CANDIDATE`/`ACTIVATING`/`READY` | `composition/failed` | Failure receipt recorded; prior current generation remains unchanged | `FAILED` |
| `DRAINING`/`QUARANTINED` | `composition/retired` | Every generation pin/lease is released; registrations disposed or termination is authoritatively reconciled | `RETIRED` |
| any non-retired generation | `composition/quarantined` | Emergency revocation is committed before host cleanup | `QUARANTINED` |

`composition/published` is the only operation that changes the current-generation
pointer. Emergency quarantine blocks new leases immediately even if host process
termination is still being reconciled; it does not claim existing work is stopped.

| From | Event | Guards | To |
|---|---|---|---|
| absent | `plugin/staged` | Exact bytes, provenance and package digest recorded | `STAGED` |
| `STAGED` | `plugin/validated` | Manifest, schema, compatibility and requested capabilities pass | `VALIDATED` |
| `VALIDATED` | `plugin/enabled` | Explicit scope/config decision recorded | `ENABLED` |
| `ENABLED` | `plugin/activation_started` | Composition lock and dependencies are current | `ACTIVATING` |
| `ACTIVATING` | `plugin/ready` | All registrations activate and health probes pass | `READY` |
| `ACTIVATING` | `plugin/failed` | Activation failed; partial registrations disposed in reverse order | `FAILED` |
| `STAGED`/`VALIDATED` | `plugin/failed` | Package/schema/provenance/capability validation failed; nothing enabled | `FAILED` |
| `READY` | `plugin/draining` | New leases rejected; existing generation pins retained | `DRAINING` |
| `DRAINING` | `plugin/disabled` | In-flight leases drained or recorded for explicit recovery | `DISABLED` |
| any non-removed | `plugin/quarantined` | CompositionService commits emergency revocation; host runtime stops new activation and reports in-flight users | `QUARANTINED` |
| `DISABLED`/`FAILED`/`QUARANTINED` | `plugin/removed` | No active registration; recovery/provenance records retained | `REMOVED` |

`RepoGeneration` transitions are committed by RepoIntelService:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `repo_generation/build_started` | Repository/revision/read policy/parser set pinned | `BUILDING` |
| `BUILDING` | `repo_generation/current` | Required parser set and revision snapshot complete | `CURRENT` |
| `BUILDING` | `repo_generation/partial` | Optional parser missing; diagnostics and omissions recorded | `PARTIAL` |
| `CURRENT`/`PARTIAL` | `repo_generation/stale` | Relevant source revision or read policy changed | `STALE` |
| `BUILDING` | `repo_generation/failed` | Build failed; diagnostics committed; prior current generation unchanged | `FAILED` |
| `CURRENT`/`PARTIAL`/`STALE`/`FAILED` | `repo_generation/retired` | No pinned ContextPacket/query requires the generation | `RETIRED` |

Budget reservations transition under BudgetService:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `budget/reserved` | Atomic hierarchical hard-limit check succeeds | `RESERVED` |
| `RESERVED` | `budget/partially_settled` | Proven usage settles; unused remainder remains reserved | `PARTIALLY_SETTLED` |
| `RESERVED`/`PARTIALLY_SETTLED` | `budget/settled` | Final usage reconciled; only proven-unused remainder released | `SETTLED` |
| `RESERVED` | `budget/released` | Dispatch/use proven not to have occurred | `RELEASED` |
| `RESERVED`/`PARTIALLY_SETTLED` | `budget/unknown` | Usage may have occurred; retain reserved capacity pending reconciliation | `UNKNOWN` |
| `UNKNOWN` | `budget/reconciled` | Authoritative usage evidence settles actual usage and releases only proven-unused capacity | `SETTLED` |

UsageService owns the immutable UsageObservation facts and their provenance. BudgetService
consumes those observations by ID, records settlement decisions in its own stream, and
retains reservations for unobserved or uncertain usage; it never edits or duplicates a
UsageObservation. Analytics derives totals from these owner streams.

An `UNKNOWN` reservation retains capacity until authoritative reconciliation. It never
reopens capacity by timeout or an unmodeled operator override.

Secret use is an independent broker-owned lease, not a capability grant:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `secret_use/lease_issued` | Secret is available; exact provider/recipient/route/destination/operation and one-use request are authorized | `ISSUED` |
| `ISSUED` | `secret_use/lease_consumed` | Broker commits single-use consumption before delivering the authorized request | `CONSUMED` |
| `ISSUED` | `secret_use/lease_expired` | Deadline passes before use | `EXPIRED` |
| `ISSUED` | `secret_use/lease_revoked` | Secret rotation/revocation or bound request identity changes | `REVOKED` |

Secret record lifecycle stores metadata and secure-store receipts only; event payloads
never contain credential bytes:

| From | Event | Guards | To |
|---|---|---|---|
| absent | `secret/created` | Protected input handle consumed; OS credential-store write verified | `AVAILABLE` |
| `AVAILABLE`/`EXPIRED` | `secret/rotated` | New protected value committed and version advanced; outstanding unused leases revoked | `AVAILABLE` |
| `AVAILABLE` | `secret/expired` | Expiry verified by broker metadata/store | `EXPIRED` |
| `AVAILABLE`/`EXPIRED`/`MISSING` | `secret/revoked` | Authorized deletion/revocation receipt committed; unused leases revoked | `REVOKED` |
| `AVAILABLE`/`EXPIRED` | `secret/missing` | Credential store authoritatively reports value absent | `MISSING` |
| `MISSING` | `secret/restored` | New protected value written and verified as a new version | `AVAILABLE` |

## 11.7 Run completion predicate and spec revision

`RunController.evaluateCompletion(runId) → CompletionPredicateResultV1`; `complete` is
`true` only if all conditions hold:

1. the active SpecVersion is approved and matches every required Evidence digest;
2. every mandatory Task is `PASSED` with non-stale Evidence for the exact integrated
   `RevisionSet`, scenario, policy, environment and toolchain;
3. all required repository integrations are settled and deterministic;
4. no required EffectIntent, WorkerExecution, workspace lease, reservation or audit
   receipt is `UNKNOWN`, in-flight, or unreconciled;
5. all declared user acceptance steps are satisfied; and
6. no blocking NeedsYou, conflict or policy restriction remains.

On false, return the failed predicate clauses and keep the Run nonterminal. Progress
percentages, a worker message, green check UI, or successful process exit are not
inputs to this predicate.

An approved SpecVersion N+1 pauses new dispatch immediately. Existing work may settle
but cannot be integrated as satisfying N+1. The controller computes the affected
Task closure from changed requirement/scope/acceptance/interface digests and
dependency edges. It fences/cancels affected writers, reconciles effects, marks
affected Evidence stale, and supersedes affected Tasks. An unaffected Task is reused
only when equivalence of its full input contract, dependencies, scope and verifier
subject is proven. If uncertainty remains, invalidate rather than reuse. Activation
of N+1 requires its own exact review digest and budget/policy checks.

## 11.8 Canonical event payload registry

Every event family has one schema owner. Section 02 provides owner-local domain-record
sketches; section 12 defines the normalized wire schemas it covers. A Rust sketch is
not by itself a serialization contract. The transition tables here define individual
state-changing event names; the payload registry groups their record basis as follows:

Each physical event row's bounded `data` uses `EventPayloadMetadataV1` from §12 plus
one family payload. Every state-changing payload includes `AggregateTransitionV1`
(aggregate ID, expected version, from/to states, cause IDs and guard evidence); the
event discriminator itself is the physical row's `kind`. This table identifies the
canonical record basis and additional binding, not undeclared standalone type names.
`EventPayloadMetadataV1.payloadDigest` covers only the canonical family-payload bytes,
not the metadata object; §4.2 defines the exact digest rule.

| Event family | Canonical record basis / additional required binding |
|---|---|
| Thread lifecycle | `ThreadV1`, `LegacySessionAliasV1`, `LegacyImportOriginV1`; immutable identity/relationship and versioned import source snapshot/record digests |
| Input lifecycle | `ThreadInputV1`; content artifact digest, lane, stable delivery ID and promotion Turn ID |
| Turn lifecycle | `CanonicalTurnRecordV1` (`TurnV1` or `HistoricalTurnRecordV1`), immutable `LegacyTurnImportV1`, `TurnOperationsReconciledV1`; explicit historical UNKNOWN initialization links import admission, not completion; historical terminal states require separately linked reconciliation receipt/cursor without fabricated live pins; all ProviderAttempt IDs and outcome/cancellation guards |
| Provider attempt | `CanonicalProviderAttemptRecordV1`, `ProviderAttemptReconciliationV1`, immutable `LegacyUncertainOperationImportV1` and `UsageObservationV1`; route/request/output digests, finish cause and usage provenance; HistoricalProviderAttemptRecordV1 retains original UNKNOWN_ACCEPTANCE and separately linked reconciliation receipt/cursor |
| Message/part | `MessageV1` / `MessagePartV1`; stable message/part ordering, content tag and artifact refs |
| Context/compaction | `ContextEpochV1`, `ContextPacketV1`, `CompactionRecordV1`; admission ordinal/stage/strategy, recoveryPolicyRef/digest, exact compositionGeneration/lock/resolvedGlobalHookSetRef, semantic sourceSetDigest separate from concurrency sourceCursor, parent/source heads, ranges and original-content refs |
| Checkpoint/rewind | `CheckpointV1`, `RewindPlanV1`, `DirtyFileRestoreManifestV1`; exact owner cursors/revisions, retained preimages/kind/existence/mode and owned-path manifest, approval digest and restore receipt |
| Tool batch | `ToolBatchV1`, `ToolInvocationV1`, `ResourceResolutionV1`, `ToolResultV1` and §13's sole `ToolCallObservationV1`/`ToolCallAcknowledgementV1` Interface; toolset digest, ordered call IDs, committed per-call cursors, post-hook completion/failure links and final report coverage |
| Tool post-hook barrier | §13's `ToolCallAcknowledgementV1` basis with `AggregateTransitionV1` for the owning ToolBatch version, expected prior barrier state, exact resultCursor/observation/call IDs, pinned hookSetDigest and bounded authenticated hook/effect receipts; `tool/post_hook_barrier_updated` is committed by ThreadService only |
| Goal/spec | `GoalV1`, `SpecVersionV1`; request/spec/review-bundle digests and user approval receipt |
| Run/Task/Attempt | `RunV1`, `TaskV1`, `AttemptV1`; exact aggregate version, transition guard evidence and cause IDs; next-wave prerequisite Evidence/eligible Task set (including READY verification retry); verification_failed_retryable current failed Evidence/subject, distinct strategy/retry policy and remaining attempt/budget receipts; execution_failed terminal Attempt/no-retry/no-uncertainty proof; Attempt executionLimitStateRef updates |
| Worker execution | `WorkerExecutionV1`, `WorkerBindingV1`, `WorkerAdapterObservationV1`, `ExecutionLimitStateV1`; outbox/dispatch ID, incarnation/replacementOf, shared limit-state lineage, launch nonce, exact fence and typed result error |
| Direct delegation | `DirectDelegationV1`, `DirectWorkerBindingV1`, `DirectTaskPackageV1`, `DirectWorkerResultV1`; Thread/Turn/child links, stable delegationRootId, current WorkerExecutionId/replacementOf/incarnation and dispatch identity, root-owned limit state and ordinary admission receipts; no managed identity fabricated |
| Workspace | `WorkspaceV1`, `WorkspaceLeaseV1` and `RevisionSetV1`; repository/member, revision/fence and before/after digests |
| Effect | `CanonicalEffectRecordV1`, `EffectSettlementV1`, immutable `LegacyUncertainOperationImportV1`; action/resource/argument/policy/approval digests and target-specific evidence refs; HistoricalEffectRecordV1 requires separately linked receipt/cursor for reconciled states without invented live authorization pins |
| Capability lease | `CapabilityLeaseV1`; principal, effect, exact action/resource/policy, workspace fence, budget, backend and executable generation |
| Secret-use lease | `SecretUseRequestV1`, `SecretUseLeaseV1`; exact secret reference, recipient, provider route, destination, operation, one-use limit and expiry; never secret bytes |
| Secret record | `SecretMetadataV1`, `SecretRevocationReceiptV1`; version/status and secure-store receipt only; never secret bytes |
| Approval | `ApprovalChallengeV1`, `ApprovalGrantV1`; displayed, policy, resource and subject digests, expiry and resolution receipt |
| Verification | `VerificationPermitV1`, `EvidenceV1`, `ProofPackV1`; exact subject/permit, policy and complete current workspace-manifest binding, verifier identity, scenario results and limitations |
| Budget/usage | `BudgetV1`, `BudgetReservationV1`, `UsageObservationV1`; dimension, amount/unit, provenance and estimate/reported distinction |
| NeedsYou | `NeedsYouV1`; typed reason, owner cursor, allowed response schema and response digest |
| Plugin/config | `PluginManifestV1`, `HookContributionV1`, `CompositionLockV1`, `PluginGenerationV1`; package/graph/config/contribution digests, globalHookBindings (sole declaration in §13), actor, capability approvals and activation observations; existing SettingsModule config revision/receipt path uses §12.16, no second config stream |
| Composition state | `CompositionStateV1`, `CompositionGenerationV1`; current/candidate pointers, generation states and host activation receipts |
| Memory/repository/artifact | `MemoryRecordV1`, `MemoryCandidateV1`, `MemoryExtractionV1`, `MemoryConsolidationV1`, `RepoGenerationV1`, `ArtifactMetadataV1`; provenance and generation/ref digests; exact review/replacement set and freshly checked supersession sources in one acceptance append |

Payloads are bounded; bodies over the event limit are immutable `ArtifactRef`s with
length, MIME type, digest and access classification. Unknown event major versions
refuse replay before state mutation. The event log is not an RPC envelope; physical
durability is defined in section 18 and by the existing `horizoncode-eventlog` seam.

## 11.9 Required transition fixtures

Each row in the tables has a positive transition test, a wrong-state test, a stale
cursor test, a duplicate-delivery test, and a crash/replay fixture where the event
crosses an external boundary. The critical negative fixtures are: malformed tool
batch dispatches zero unstarted effects; stale workspace fence mutates zero bytes;
worker completion cannot set `PASSED`; spec revision stales only proven-affected
Evidence; acceptance challenge resolves once; cancellation with unknown effects does
not become `CANCELLED`; projection rebuild yields identical current state; and a
newer unsupported schema is refused before replay.

Additional required payload/replay fixtures for these contracts:

- `run/next_wave_started` dispatches eligible remaining Tasks only with current prerequisite
  Evidence; stale spec/manifest/policy, unresolved required effects or empty eligible set refuse.
- `task/verification_failed_retryable` accepts current failed independent Evidence with a
  distinct bounded strategy, remaining attempts/budget and settled verifier/effect outcomes;
  the eligible READY retry returns the Run VERIFYING wave to EXECUTING and creates a new
  Attempt. No-retry failure takes `task/failed`; unknown operation, stale Evidence,
  exhausted attempt/budget or unchanged disallowed strategy refuse READY/new dispatch.
- `task/execution_failed` accepts known exhausted failure, never uncertain launch/effect;
  retryable failure takes the existing retry route, and pending cancellation stays pending
  until authoritative settlement for both Task and Attempt.
- Rejected-batch continuation uses a supported pinned protocol and bounded committed
  rejection, otherwise fails the Turn; both variants dispatch zero calls.
- Incremental result delivery, duplicate/conflicting acknowledgement, out-of-order
  independent settlement, crash after commit/before hook and required post-hook failure
  preserve ordered final results and block only dependent unstarted calls. Hook completion
  receipts are linked owner bookkeeping, not callback events or a second hook stream.
  Barrier initialization/result commit replay is exact; stale batch version/prior barrier,
  mismatched resultCursor/hook set and uncertain hook effects cannot become PERMITTED or
  falsely terminal BLOCKED; restart retains WAITING_HOOKS until authoritative reconciliation.
- `turn/operations_reconciled` checks every linked effect/process/delegation receipt;
  process absence alone never settles external effects; partial receipts or unresolved
  provider acceptance keep UNKNOWN; cancellation intent cannot become normal continuation.
- Compaction crashes before/after admission and before preview consume bounded allowance;
  restart reconstructs policy from retained artifact; admission/failure/rejection cursor
  churn cannot reset sourceSetDigest/circuit; real semantic source change is distinguished;
  restart retains exact global-hook resolution including optional unavailable entries,
  and missing/quarantined required hook generations fail without current-generation substitution.
- Direct delegation covers launch ambiguity, cancellation, recovery/limits and typed
  direct result dispatch through the same adapter without any managed IDs; managed
  replacement uses new execution identity and persists Attempt counters/hook pins;
  a new Attempt resets only execution limits, not aggregate budgets/attempt caps.
- Permit policy/manifest drift refuses consumption or accepted current Evidence; checkpoint
  restore covers absent/empty/deleted/dirty files, missing preimages, modes, symlink/reparse
  escape, drift and exact path subset preservation with zero unrelated byte changes.
- Consolidation completion leaves proposed supersession unaccepted; stale source/review
  digest refuses acceptance; replacement creation and all accepted supersessions replay
  as the same single MemoryService append, never automatic model acceptance.
- Legacy provider/effect unknown import preserves historical-unmediated provenance,
  missing authorization metadata and owner links, resumes after partial import, refuses
  conflicting snapshot/record digests and cannot dispatch using import receipts. Historical
  Turn UNKNOWN initialization requires no promoted input/live pins; initial alias admission,
  Turn initialization, owner operation imports and final manifest receipts are acyclic.
  Historical Turn/effect reconciled terminal projections retain immutable initialization
  payloads and require authoritative receipt/cursor; historical provider acceptance uses
  a separately linked reconciliation record without rewriting original UNKNOWN_ACCEPTANCE.
- §12.16 settings fixtures exercise legacy mappings, all four application boundaries,
  scope/descriptor/lock validation and exact revision replay; no unrelated settings or
  DefaultSubagentSettings redesign is permitted.
