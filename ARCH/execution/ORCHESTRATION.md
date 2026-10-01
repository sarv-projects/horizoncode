# Orchestration

## Purpose and ownership

CMP-orch owns Run, Task, Attempt, WorkerExecution coordination, admission, resource accounting and completion decisions. CMP-runner owns bounded reasoning turns; CMP-session owns durable framing and Thread streams. Neither the UI nor a peer controls task truth.

## Logical schema and storage ownership

These are logical records. `CMP-session` and `CMP-orch` assign versioned event types and
projection migrations; `CMP-artifact` owns immutable scoped bytes and reference leases
(`ARCH/product/ARTIFACTS.md`). `controller/events/` is the canonical, bounded `SupervisorControlStream`
owned by `CMP-orch`. Under one cross-process admission lock, it sequences
`RunAdmissionIntent/Granted/Settled`, `WorkAdmissionIntent/Granted/Settled`, and
`MaintenanceIntent/Granted/Settled`. It owns only global admission decisions and
fences, never task/run completion truth. Each `runs/<run_id>/events/` stream remains
canonical for its Run, Task, Attempt, and evidence-control truth; per-Thread logs use
the same framing for turns/model messages and link to the run by IDs and causation
(`ARCH/core/SESSION-AND-THREADS.md`). A run admission event references the exact initial per-run stream head;
a work admission event references the Thread/turn or attempt execution. Unresolved
intents block conflicting admission until the referenced stream or failed launch is
reconciled. The maintenance permit event references the update operation and install
identity. Each stream has a monotonic owner-local sequence and digest link; sealed
segment ranges chain to their predecessor. Artifact references and event bytes are
durably committed in their canonical owners before projections advance. A run is
never reconstructed from a worker conversation alone. SQLite is a **rebuildable
projection** over those streams; replay is bounded and streaming, and only committed
events are folded. This is not an atomic transaction across files: admission locks,
stable operation IDs, outboxes, log heads, and reconciliation make uncertainty
explicit. Cross-stream mismatches are incidents, not silently merged. Bytes are
namespace-scoped with digest, size, media type, retention pins, and redaction status;
there is no implicit cross-Run/Thread deduplication. The audit chain is a separate
security record linked by `effect_id`; recovery reconciles it rather than assuming a
cross-file transaction.

Admission protocol under the supervisor lock:

1. Append an idempotent `*AdmissionIntent` with a stable operation ID. While any such
   intent is unresolved, conflicting run/work/maintenance operations fail closed.
2. For activation of a prepared Run, durably commit the activation/reservation result
   and canonical run-stream head (or reconcile the existing draft Run); draft creation
   alone is not run admission. For work admission, durably create the direct-turn/session
   record or worker execution/attempt dispatch record in its canonical owner. Do not
   launch a worker or begin a provider request before this owner record exists.
3. Reconcile that owner record against the intent, then append the matching `Granted`
   event and return its receipt. If the caller disconnects after the grant, retrying
   the same operation ID returns the same result.
4. Hold an active `WorkAdmissionPermit` until its execution is known terminal. A
   timeout, process loss, lease expiry, or missing peer response changes it to
   `UNKNOWN` and continues to block maintenance; only an authoritative observation
   can reconcile it to active or settled.
5. Maintenance first writes an intent that fences new run/work grants, then checks
   all canonical records and active hosts. The initial product contract grants only
   when every Run is terminal and all work permits and effects are settled; otherwise
   it returns `Busy`, settles the failed acquisition, and leaves ordinary admission
   open. It does not pause or migrate active work. The fence is held only after a
   successful grant and remains until helper outcome and the installed digest are
   reconciled; expiry never reopens admission.

The OS-backed lock serializes only each bounded state transition, not an entire model
turn. The durable permit/fence prevents new admissions while an already-granted work
permit represents active work. No read of the SQLite projection can replace a locked
replay/validation of the committed control head. A corrupt/newer-schema head or
unsupported locking/durability backend refuses new work and updates with a typed
recovery/unsupported result.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `SupervisorControlEvent` | `{control_seq, event_id, kind: enum(RUN_ADMISSION_INTENT, RUN_ADMISSION_GRANTED, RUN_ADMISSION_SETTLED, WORK_ADMISSION_INTENT, WORK_ADMISSION_GRANTED, WORK_ADMISSION_SETTLED, MAINTENANCE_INTENT, MAINTENANCE_GRANTED, MAINTENANCE_SETTLED), operation_id, permit_id?, outcome?, run_id?, run_stream_head?, thread_id?, turn_id?, execution_id?, attempt_id?, update_operation_id?, install_id?, base_binary_digest?, owner_epoch, actor_ref?, causation_id?, payload_digest}`. Append under one cross-process admission lock before acknowledging the control decision. The stream sequences competing run/work/maintenance admissions; per-run streams still own run/task/attempt truth. Pending/unknown operations block conflicting admissions until reconciled. |
| `WorkAdmissionPermit` | `{permit_id, operation_id, kind: enum(DIRECT_TURN, WORKER_EXECUTION), run_id?, thread_id, turn_id?, execution_id, attempt_id?, canonical_owner_ref, grant_control_seq, owner_epoch, state: enum(ACTIVE, UNKNOWN, SETTLED), outcome?, observation_ref?, created_at, settled_at?}`. A permit is a reference to a committed grant, not a transferable authority token. It remains open across disconnects and timeouts; `UNKNOWN` blocks maintenance until a reconciled host/session receipt proves terminal settlement. |
| `OperatorControlSession` | `control_session_id`, `principal_ref`, `principal_kind: USER_OPERATOR | WORKER | PEER | PLUGIN | SYSTEM`, `surface`, `connection_ref`, `authentication: IN_PROCESS_TRUSTED_UI | LOCAL_PEER_CREDENTIALS | VERIFIED_CONNECTOR | NONE`, `authenticated_subject?`, `ingress_policy_digest?`, `scopes[]`, `capability_hash?`, `issued_at`, `expires_at`, `revoked_at?`. The controller derives principal and authentication context from the authenticated ingress; request fields cannot supply or upgrade them. `NONE` can support non-privileged interaction but never operator approval. ACP connection/session binding prevents cross-connection replay; by itself it does not authenticate a user. Operator control capability is short-lived, scope-bound, held only by trusted TUI/CLI/approved ACP connector processes, and never enters model/tool context or child environments. |
| `MutationCapability` (ephemeral) | `capability_id`, `principal_ref`, `control_session_id`, `principal_kind`, `scope`, `run_id`, `owner_epoch`, `expected_seq`, `delivery_id`, `expires_at`, `nonce`, `authn_context_digest`, `mac`. Constructed/validated only by `CMP-orch` ingress; sealed in-process type, never stored in plaintext, prompt, environment, config, or child IPC. A retry with the same delivery ID/payload is idempotent; a reused ID with changed payload conflicts. Durable events retain only capability ID/hash and authn-context digest. |
| `ControlIntent` | `control_id`, `delivery_id`, `run_id?`, `target_kind?: RUN | TASK | ATTEMPT`, `target_id?`, `input_digest`, `source_surface`, `principal_ref`, `classification: CONTROL | NORMAL | AMBIGUOUS`, `requested_action: PAUSE | RESUME | CANCEL | STOP?`, `confidence_class`, `fence_seq?`, `decision_ref?`, `created_at`. A recognized control is committed to the priority lane before any model continuation. A cancel intent is executable only after its target kind and ID resolve to the same run under controller lookup; ambiguous/missing/foreign targets create a pause fence and clarification request, never a guessed broad cancellation. |
| `RequestLane` | `lane_id`, `class`, `capacity`, `queue_limit`, `request_deadline`, `active_count`, `expired_count`, `last_progress_seq`. Interactive cancel/permission/control are isolated from catalog/history and bulk event streams. |
| `EventCursor` | `run_id`, `client_id`, `last_acked_seq`, `snapshot_seq`, `gap_state`, `expires_at`. Client events replay from durable sequence; a retention gap requires a fresh snapshot, never silent continuity. |
| Shared event-log metadata | `LogSegmentSealV1` and `CommittedLogHeadV1` field shapes are owned by [the event contract](../contracts/EVENTS.md). CMP-orch owns only the Run/control stream instances and their commit/replay behavior. |

### Interface contracts and transaction boundaries

```rust
trait RunController {
    fn submit_intent(&self, auth: MutationContext, request: OriginalRequest) -> Result<RunId, ControlError>;
    fn set_goal_draft(&self, auth: MutationContext, request: OriginalRequest) -> Result<GoalDraftReceipt, ControlError>;
    fn prepare_goal(&self, auth: MutationContext, request: GoalPreparationRequest) -> Result<PreparationId, ControlError>;
    fn clarify_goal(&self, auth: MutationContext, answer: ClarificationInput) -> Result<ClarificationReceipt, ControlError>;
    fn open_goal_start_review(&self, auth: MutationContext, request: GoalReviewRequest) -> Result<GoalApprovalChallenge, ControlError>;
    fn confirm_goal_start(&self, auth: MutationContext, response: GoalConfirmation) -> Result<GoalStartResult, ControlError>;
    fn request_pause(&self, auth: MutationContext, run: RunId) -> Result<ControlReceipt, ControlError>;
    fn request_resume(&self, auth: MutationContext, run: RunId) -> Result<ControlReceipt, ControlError>;
    fn stop_now(&self, auth: MutationContext, run: RunId) -> Result<ControlReceipt, ControlError>;
    fn request_cancel(&self, auth: MutationContext, target: CancelTarget, delivery_id: DeliveryId) -> Result<CancelReceipt, ControlError>;
    fn goal_start_status(&self, auth: ReadContext, run: RunId, goal: GoalId) -> Result<Option<GoalStartIntent>, ControlError>;
    fn clear_goal_pointer(&self, auth: MutationContext, expected_revision: u64) -> Result<(), ControlError>;
    fn admit_input(&self, auth: MutationContext, input: InputEnvelope) -> Result<InputReceipt, ControlError>;
    fn post_agent_message(&self, auth: MutationContext, request: AgentMessageRequest) -> Result<MessageReceipt, ControlError>;
    fn list_agent_messages(&self, auth: ReadContext, run: RunId, filter: MessageFilter,
                           cursor: Option<EventSeq>) -> Result<MessagePage, ControlError>;
    fn agent_message_status(&self, auth: ReadContext, delivery_id: DeliveryId)
                           -> Result<MessageDeliveryStatus, ControlError>;
    fn acknowledge_agent_message(&self, auth: MutationContext, message_id: MessageId)
                                -> Result<AckReceipt, ControlError>;
    fn approve_spec(&self, auth: MutationContext, expected_parent: Digest, spec: SpecDraft)
                    -> Result<SpecDigest, ControlError>;
    fn claim_ready(&self, auth: MutationContext) -> Result<Option<Claim>, ControlError>;
    fn record_attempt(&self, auth: MutationContext, claim: Claim, event: AttemptEvent)
                      -> Result<AttemptState, ControlError>;
    fn submit_evidence(&self, auth: MutationContext, task: TaskId, evidence: EvidenceDraft)
                       -> Result<TaskState, ControlError>;
    fn route_permission(&self, auth: MutationContext, request: ChildPermissionRequest)
                        -> Result<PermissionBridgeId, ControlError>;
    fn attach(&self, auth: ReadContext, run: RunId,
              cursor: Option<EventSeq>) -> Result<SnapshotAndReplay, ControlError>;
    fn recover(&self, auth: MutationContext)
               -> Result<RecoveryPlan, ControlError>;
}

```

`claim_ready` derives the worker profile/identity from the authenticated
`MutationContext`; callers do not submit a `WorkerIdentity` or concurrency
`Capacity`. Capacity is computed by the scheduler from host limits, run/task
reservations, active leases, and policy. If a transport supplies a worker label,
the ingress validates it against the authenticated principal and allowed profile
set before invoking this interface. `attach` is always authenticated and
membership-scoped at ingress, even when the underlying replay reader is a pure
read function. A `VerificationPermit` is minted and consumed by the controller;
worker/evaluator callers cannot construct or reuse a generic budget reservation
to bypass verification class or task/spec binding.

`VerifiedSubject` contains `repo_id`, exact commit plus dirty-tree digest or an
immutable snapshot, `spec_digest`, scenario versions, environment digest and toolchain
versions. A verifier cannot return `PASS` without evidence artifact digests. A
`ControlError` distinguishes `Conflict`, `StaleFence`, `InvalidTransition`,
`DependencyCycle`, `BudgetExceeded`, `UnknownEffect`, `UnsupportedCapability`,
`ExpiredCapability`, `ReplayConflict`, `WrongPrincipal`, `ScopeDenied`, `StorageCorrupt`,
and `PolicyDenied`; callers must not coerce them to a generic retry.
`MutationContext` is an opaque, non-serializable in-process value created only by the
trusted ingress/controller after authentication. It binds the run ID, owner epoch,
expected aggregate sequence, principal reference/kind, authorized scope, control
session, authentication-context digest, expiry, and a one-use request nonce. At an
IPC boundary the server derives identity from OS peer credentials or a verified
connector and validates a short-lived MACed capability; raw caller fields cannot
construct the context. The capability is never given to a worker or serialized into
model context. Persist only the capability ID/hash and auth-context digest in the
audit event, never the bearer secret. `USER_OPERATOR` contexts require non-`NONE`
authentication plus the scope for that specific operation. Worker claims, verifier
contexts, and recovery contexts use distinct scopes and cannot be cast to an operator.
Every mutating method rejects an out-of-date sequence/epoch or wrong scope before any
effect; recovery acquires ownership and increments the epoch before dispatch.
`claim_ready` returns a bounded claim with attempt ID, workspace fence, spec digest,
deadline, permission ceiling and budget reservation; the worker cannot enlarge it.

No controller method accepts a caller-supplied `UserActor`, principal enum, trust
flag, approval boolean, or authentication result. `confirm_goal_start` accepts only
a response to an unexpired challenge on the same authenticated operator
control-session/connection, validates the displayed review bundle digest against the
persisted challenge, and derives the approver from `MutationContext`. On acceptance,
the controller records a one-use `GoalApprovalReceipt` and `GoalStartIntent`, reserves
all required budgets with stable idempotency keys, then appends the activation commit
event before dispatch; the client does not submit an actor or a receipt of its own. A
decline/cancel/failed preflight creates no dispatch and invalidates the
challenge/receipt. `set_goal_draft` has no planner
capability; `prepare_goal` reserves the planning allowance before read-only
discovery/inference; `clarify_goal` records user input and invalidates stale proposals
but requires a new explicit prepare for inference; and `clear_goal_pointer` requires
the expected pointer revision. Method authorization is checked centrally for every call:

| Operation group | Required principal/scope | Additional invariant |
|---|---|---|
| Goal status read | authenticated `USER_OPERATOR` with `goal:read` | Read-only projection/event cursor; worker/peer/plugin contexts cannot inspect approval or start-intent records |
| Intent, goal draft, clarification, spec approval, review opening/confirmation, pointer clear | authenticated `USER_OPERATOR` with the exact operation scope | Current trusted control session; request actor is derived, never supplied |
| Run/task/attempt cancellation | authenticated `USER_OPERATOR` with exact `run:cancel`/`task:cancel`/`attempt:cancel` scope for the resolved target | Controller resolves globally unique IDs, verifies task/attempt ancestry and run membership, then applies only the typed target semantics; a start-intent/activation race is handled only for a run target |
| Goal preparation | authenticated `USER_OPERATOR` with `goal:prepare` | Reserve planning budget before pinned, read-only discovery; no write/peer capability |
| Goal start | authenticated `USER_OPERATOR` with `goal:start` | Consume one current, one-shot receipt; durable reservations and activation commit must precede dispatch |
| Task claim and schedule | controller scheduler context | Dependencies, run budget, and workspace fence are rechecked |
| Attempt updates | worker claim context | Claim's attempt/scope/epoch only; cannot self-settle `PASSED` |
| Evidence submission | verifier context | Exact subject revision/spec/scenarios; evidence digest required |
| Recovery | recovery-controller context | Acquire new owner epoch; cannot mint user approval or clear consumed budgets |

**Projection migration order.** Add `operator_control_session`, `run`, `run_goal`, `goal_preparation`, `goal_approval_challenge`, `goal_approval_receipt`, `goal_start_intent`, `active_goal_pointer`, `spec_version`, `execution_plan`, `intent_item`, `task`,
`task_dependency`, `attempt`, `attempt_progress`, `cancel_request`, `external_attempt`, `input_receipt`, `permission_bridge`,
`request_lane`, `event_cursor`, `session_log_head`, `session_log_segment`,
`run_log_head`, `run_log_segment`, `event_storage_reservation`,
`physical_storage_reserve`, `workspace`, `lease`,
`budget`, `reservation`, `dispatch_outbox`, `effect_intent`, `evidence`, `decision`,
`artifact_ref`, and `delivery`
tables with foreign keys, unique IDs, current-state check constraints, and indexes,
including the unique cancel-delivery key and target/run/sequence lookup
on `(run_id,state,priority,task_id)`, `(task_id,attempt_no)`, `(task_id,depends_on)`,
`(workspace_id,fence_epoch)`, and `(effect_id,terminal_kind)`. The event-log schema
version advances first; one migration rebuilds projection tables from the log in a
temporary database, verifies row counts/digests, then swaps the projection atomically.
An interrupted migration leaves the old projection intact and is restartable. Enforce
one pending approval challenge per goal with a partial unique constraint; review-open
idempotency is keyed by `(review_delivery_id, request_digest)` with same-ID/different-
digest rejection; at most one nonterminal start intent exists per goal; confirmation
delivery IDs are unique per run and bind the response digest. Outbox keys and attempt
IDs are unique and stable across scheduler restarts.

**Transition transaction.** Under the run writer lock: validate expected sequence and
fence; check graph/spec/budget invariants; append and `fsync` a versioned transition
event into the bounded active segment; durably advance the committed head; update the
SQLite projection at that sequence; commit; publish a UI update. A step is not
acknowledged before the head is durable. If a crash falls between event append and
head update, preserve the tail as uncommitted and reconcile stable event/effect IDs;
do not fold or truncate it blindly. If the projection leads the head, mark corruption
and refuse dispatch. Audit and external effects are joined by stable IDs and
reconciled after this local transaction; they are never assumed atomic with SQLite.

**Segment rotation and replay.** Before a transition can dispatch a model/tool/effect,
reserve the maximum bounded durable-event bytes its outcome requires and leave the
control/recovery reserve unavailable to ordinary output. If the next event will cross
the segment ceiling, seal and sync the prior segment, publish its immutable seal, open
the next segment, then append. Replay validates segment ranges, digest links, and the
committed head before streaming records in bounded batches into projections. It never
loads the whole run log in memory. Missing/corrupt committed bytes produce
`INSUFFICIENT_EVIDENCE`; active tail/capacity uncertainty keeps the run
`RECONCILING`, `WAITING`, or `STOPPED`, never `COMPLETED`. Event-log quota exhaustion
cannot trigger automatic context/session compaction of canonical records or artifact
deletion. Post-terminal export/archive/retention follows exact owner and evidence
checks in `ARCH/product/ARTIFACTS.md` and an explicit authorized action.

**Cross-stream rule.** The run stream records a `TurnLinked` event with HorizonCode
`thread_id` (and an external session binding only where present), turn ID, start/end
Thread sequence, and digest. If a Thread append succeeds but the run link does not,
recovery finds the orphan by run/attempt ID and appends a repair link after verifying
the Thread bytes. If the run link exists but the Thread range is absent or altered,
the task becomes `NEEDS_REVIEW` and cannot pass. A worker Thread close never changes
run completion by itself.

### Typed controls and read contexts

Read-only goal_start_status, list_agent_messages and agent_message_status consume an
authenticated ReadContext with scope/cursor, not a one-use MutationContext. They do
not reserve spend or mutate lifecycle. The controller invokes its private
`decide_next` scheduler operation with an internal context; it is not a public API.
Only the controller commits that decision. Public owner methods include:

```text
request_pause(MutationContext, RunId) -> ControlReceipt
request_resume(MutationContext, RunId) -> ControlReceipt
stop_now(MutationContext, RunId) -> ControlReceipt
```

These require exact authenticated run scopes, stable delivery IDs and current fences.
Pause/resume/cancel/stop receipts distinguish requested, reconciling and terminal.
Stop_now retains UNKNOWN external effects; neither peer messages nor process exit can
mark PASS. The shared control registry in ARCH/integrations/CONTROL-API.md transports these same methods.

## Application replacement fence

`CMP-update` may stage an artifact without changing run/work admission. The initial
product contract waits until every Run is terminal and every execution/effect is
settled; it does not pause or migrate an active run. To apply an update,
`CMP-orch` acquires the system-wide admission lock and appends `MaintenanceIntent` to
the canonical `SupervisorControlStream`. That same sequencer arbitrates new run starts
and every model-driven worker/direct-turn execution, so the decision cannot race a
client that bypasses the durable Run API. Before granting, the controller reconciles
all Run, task, worker, direct-turn, external-effect, and recovery state against canonical
Run/Thread streams and active host/peer observations. It refuses a permit if any
execution/effect is active or `UNKNOWN`, a control intent is unresolved, a projection
is stale, or a required recovery reserve is unavailable. A concurrent start or work
dispatch receives typed `maintenance_in_progress` and cannot create unowned work or
consume a run/work reservation.

The permit is recorded in the `SupervisorControlStream` and referenced by the update
operation; it is not a second updater-owned truth. It is one-use and binds the
update operation ID, install identity, controller generation, base binary digest, and
owner fence epoch. The restricted helper revalidates it immediately before swap. A
permit is settled only after the new binary reports the expected version/digest and
passes its bounded health check, after a verified rollback, or after restart recovery
proves that no helper/swap remains in flight. An expired permit or lost process is
not enough to reopen admission. If helper outcome is uncertain, keep admission closed
and enter typed recovery; do not allow a new run to race a possibly partial swap.

## Interfaces and owner boundaries

Workers receive only narrow execution capabilities. Credentials, controller sockets, canonical Run stores and operator channels are excluded from child reach. Worker profile selection belongs to CMP-agent-directory; WorkerFabric translates a validated profile to execution; ExecutionHost performs launch/observe/terminate mechanics.

[Workers](WORKERS.md), [Scheduling](SCHEDULING.md), [Budgets](BUDGETS.md), [Workspaces](WORKSPACES.md), [Effects](EFFECTS.md), [Recovery](RECOVERY.md), [Stopping](STOPPING.md), and [Verification](VERIFICATION.md) define the detailed ports and transitions.

## Global admission and maintenance methods

```text
admission.admit_run(operation_id, start_intent) -> RunAdmissionReceipt
work.acquire(operation_id, kind, run_id?, thread_id, turn_id?, execution_id, attempt_id?) -> WorkPermit | Busy(reason)
work.settle(permit, COMPLETED | INTERRUPTED | FAILED, terminal_receipt) -> Receipt
work.reconcile(permit, host_or_session_observation) -> ACTIVE | SETTLED | UNKNOWN
maintenance.acquire(operation_id, install_id, binary_digest, operator_action_ref) -> MaintenancePermit | Busy(reason)
maintenance.settle(permit, UPDATED | ROLLED_BACK | ABORTED_RECONCILED) -> Receipt
```

Run admission and work acquisition use the same cross-process sequencer and stable operation-ID idempotency. Work acquisition writes the control intent and canonical Thread-turn or attempt-execution record before its grant; providers and execution hosts reject dispatch without the committed grant receipt. Settlement requires a terminal process/peer receipt and reconciled effects. A timeout/disconnect keeps the permit UNKNOWN until authoritative observation. The lock covers bounded transitions; durable permits block executable maintenance for each execution lifetime.

## Admission and execution failure matrix

## Failure modes

| Failure | Behavior |
|---|---|
| Child fails/blocks | Receipt with blockers; parent re-plans or escalates |
| Child cancelled | Terminal, never wakes; slot released on close |
| Depth/count exceeded | Spawn rejected typed; no silent truncation |
| Permission exceeds parent ceiling | Spawn rejected typed; child scope narrowed only |
| Overlapping writes | Write lease serializes; conflict routed through merge arbitration |
| Workspace creation fails | Fall back to in-process only if the task is read-only; otherwise fail typed |
| Merge conflict | Stop branch; evidence recorded; deterministic; no silent overwrite |
| Budget exhausted | Node fails closed; graph records the exhausted term |
| Crash mid-graph | Resume from the persisted graph; settled nodes reused |
| Update requested while a Run, work permit, or effect is nonterminal/unknown | Do not issue a permit; stage/defer the update and preserve normal run/work admission |
| Run start or direct-turn dispatch races maintenance acquisition | `SupervisorControlStream` arbitration chooses one winner; maintenance blocks new run/work admission with `maintenance_in_progress`, or already admitted work/nonterminal Run makes update acquisition return `Busy` |
| Worker/turn caller disconnects before settle receipt | Keep the permit `UNKNOWN`; reconcile against the canonical Thread/run stream and host/peer before maintenance or a replacement writer is allowed |
| Run/Thread record write fails after admission intent | Do not acknowledge admission; retain the unresolved intent, reconcile the canonical stream/launch receipt, and fail closed for conflicting work or maintenance |
| Supervisor stream is corrupt, newer-schema, or its lock/durability cannot be established | Refuse admission and update activation; surface typed recovery/unsupported-backend state rather than falling back to a stale SQLite count |
| Controller/helper crashes with a maintenance permit | Keep admission fenced until process, binary digests, and swap outcome are reconciled; expiry alone never releases it |
| Duplicate receipt delivery | At-most-once per parent incarnation |
| Child asks permission with no connected/authorized UI | Route to a durable root request with deadline; deny/cancel and settle on expiry (`REQ-HORIZON-012`) |
| External worker reports success with hidden child work/usage | Record opaque child state and unknown usage; never infer pass or zero cost (`REQ-HORIZON-009`) |
| Profile model override not supported by peer | Reject the override or record `peer_managed`; never claim the requested model ran (`REQ-ORCH-008`) |
| Child usage event duplicates parent roll-up | Deduplicate by stable observation ID or report overlapping rows separately (`REQ-ORCH-009`) |
| Local agent executable changes after profile approval | Refuse launch and quarantine until the canonical path/digest is re-probed and trust is re-reviewed (`ARCH/product/COMMANDS-AND-SETTINGS.md`) |
| Background work continuously consumes slots | Fair lane reservations; interactive steer/cancel/approval have bounded dispatch latency (`REQ-HORIZON-014`) |
| Message targets a foreign, stale, paused, or unsupported recipient | Reject before append or return an explicit delivery state; never leak content across Runs or auto-wake an agent (`ARCH/product/AGENT-MESSAGING.md`) |
| Message store/inbox boundary crashes or retries | Reconcile by stable message/delivery ID and payload digest; never duplicate a canonical post or provider input (`ARCH/product/AGENT-MESSAGING.md`) |
| CI red | Result fed back as evidence; worker re-plans or escalates |

## Configuration

- `orch.max_depth`, `orch.max_parallel`, `orch.max_total_per_tree`, `orch.per_lane_defaults`.
- `orch.resources.{processes,open_fds_or_handles,ptys,pipes,watchers}` with a protected supervisor/control reserve and per-child allocation; platform backend reports effective limits and unsupported enforcement.
- `orch.default_isolation` (`readonly_inprocess`), `orch.wake_default`, fairness quotas and maximum wait age.
- `orch.limits.{max_worker_tokens, max_session_spend{amount,currency}, wall_time_ms, max_tool_calls, max_output_bytes, max_disk_bytes, max_children, max_depth, max_concurrent}` (Core-owned ceilings; spawns narrow only).
- Agent profile model-control, source/trust state, and per-attempt usage capability are specified in `ARCH/product/COMMANDS-AND-SETTINGS.md`; a profile is not itself a budget or a verified task.
- Warning thresholds are user-configurable per budget/resource in `ARCH/product/COMMANDS-AND-SETTINGS.md`; warning delivery is best-effort, but dispatch ceilings are controller-enforced.
- `orch.receipt.max_bytes`, `orch.receipt.correction_retries` (≤1).
- `workspace.git.root`, `workspace.lease_seconds`, `workspace.reap_interval`.
- `merge.strategy`, `merge.conflict_policy` (surface, never auto-discard).
- `ci.command[]`, `ci.timeout_ms`, `ci.retry`.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-ORCH-001` | Sub-agents run in isolated sessions and return receipts, not transcripts |
