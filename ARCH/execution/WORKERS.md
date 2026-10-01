# Workers

## Purpose and ownership

CMP-agent-directory owns role/profile definitions; WorkerFabric owns adapter execution and generated foreign configuration; CMP-execution-host owns physical process mechanics; CMP-orch owns durable lifecycle and retry eligibility.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `NativeLaunchReceipt` | `launch_id`, `execution_id`, `thread_id`, `turn_id?`, `model_attempt_id?`, optional `run_id`, `task_id`, `attempt_id`, `workspace_id`, `owner_epoch`, `pid_or_platform_handle_ref?`, `state: PREPARED | SPAWNED | EXITED | UNKNOWN`, `exit_status?`, `created_at`, `updated_at`. Minimal Horizon-owned launch receipt for a native local process; live process tracking uses an OS-observable handle and a drop-released in-process slot/fence where the host permits it. Do not persist peer capability/usage/cursor fields on this common path. A crash between durable prepare and process receipt may still be `UNKNOWN` and must reconcile before relaunch; this design does not claim that all native uncertainty disappears. |
| `ExternalExecutionBinding` | `execution_id`, `attempt_id`, `adapter_kind`, `adapter_build_digest`, `capability_snapshot_id`, `external_execution_ref?`, `external_session_id?`, `event_cursor?`, `usage_observation_ids[]`, `state: ACTIVE | TERMINAL | UNKNOWN`, `last_observed_at?`, `reconciliation_ref?`. Persist only for external executions whose liveness, resume, usage, or completion cannot be observed from a local OS process handle. Unknown stays explicit; adapter capability negotiation controls which fields are meaningful. |
| `ExternalAttempt` | `attempt_id`, `peer_identity`, `adapter_kind`, `adapter_build_digest`, `peer_software_version?`, `peer_version_status: OBSERVED | UNKNOWN`, `protocol_version`, `capabilities_digest`, `external_session_id?`, `event_cursor?`, `event_source_identity?`, `event_auth_context_digest?`, `last_event_id?`, `last_event_seq?`, `resume_mode`, `opaque_children`, `workspace_id`, `scope_digest`, `cancel_state`, `last_heartbeat`, `usage_provenance`. Auth/source/version fields are controller-derived observations, never values trusted from a peer payload. `UNKNOWN` peer version is retained honestly; reconnect must renegotiate required capabilities and may not reuse stale claims. Never infer unsupported fields. |
| `DispatchOutbox` | `outbox_id`, `source_event_id`, `run_id`, `task_id`, `attempt_id`, `execution_id`, `launch_id`, `workspace_id`, `owner_epoch`, `idempotency_key`, `state: PENDING | CLAIMED | ACKNOWLEDGED | UNKNOWN | CANCELLED`, `claim_owner_token?`, `claim_epoch?`, `lease_until?`, `worker_receipt_ref?`, `created_at`, `updated_at`. Created only from committed `GoalActivated`/eligible task-claim events; unique on `(source_event_id, task_id, attempt_id, execution_id, launch_id)` and `idempotency_key`. Redelivery reuses the same attempt ID. A CLAIMED lease may be reacquired only by a higher fencing epoch after exact-launch reconciliation; lease expiry alone never returns it to PENDING. If the supervisor cannot establish whether launch occurred, state stays `UNKNOWN` and no replacement attempt launches until process/workspace reconciliation completes. |

`WorkerExecution.state` normally follows `PREPARED → LAUNCHING → RUNNING → SETTLING → FINISHED | FAILED | CANCELLED`; uncertainty at any nonterminal point transitions to `UNKNOWN`. `UNKNOWN` is nonterminal: only a durable reconciliation event backed
by an authoritative host/peer observation may move it to `RUNNING`, `SETTLING`, or a
terminal state. If no source can establish the outcome, it stays `UNKNOWN` and
requires review; elapsed time alone cannot resolve it. `FINISHED` means the process/peer
execution has a terminal receipt; it does not mean the Attempt or Task passed. A
lease expiry or heartbeat timeout marks the execution `UNKNOWN`, not dead. The
supervisor commits a stable launch intent before spawn and reconciles its launch receipt, process/adapter
handle, workspace revision, last durable event, usage observations, and pending
effects after restart. Only a proven terminal process outcome can settle
`FINISHED`/`FAILED`/`CANCELLED`; it cannot settle Attempt success or Task PASS. If the
adapter cannot query/resume the prior execution, the result stays `UNKNOWN`; no
duplicate worker is launched against the same writable workspace until fencing and
effect reconciliation finish. An Attempt can own multiple sequential executions
for infrastructure recovery, but only one may hold its active writer fence at a
time. A relaunch reserves budget and obeys the durable retry/no-progress policy.

External lifecycle hooks, CLI transcript changes, and peer status events are
observations, not controller commands. Before updating a `WorkerExecution`, an
adapter must bind an event to the authenticated adapter/process identity, exact
`launch_id`, workspace, current owner fence, and a monotonic source cursor or stable
event ID where available. Reject duplicate, stale, cross-workspace, or superseded
events; bound payload/rate and retain missing or unauthenticated signals as
`UNKNOWN`. A transcript path is an untrusted file reference: resolve it with
descriptor-based no-follow/open-under-root semantics (or the platform's equivalent
reparse-point-safe handle checks) and revalidate file identity before each read. If a
platform cannot provide the required containment, refuse transcript access rather
than falling back to lexical prefix checks. Only explicitly user-visible content may
enter HorizonCode history/search. None of these observations may transition
Attempt/Task to success or pass evidence.

## Execution host interface

```rust
trait ExecutionHost {
    // Only a committed dispatch-outbox entry plus current workspace fence can launch.
    fn launch(&self, request: LaunchRequest) -> Result<LaunchReceipt, HostError>;
    fn inspect(&self, execution: ExecutionId) -> Result<ExecutionObservation, HostError>;
    fn request_cancel(&self, execution: ExecutionId, cancel_id: CancelId)
                     -> Result<CancelObservation, HostError>;
    fn events(&self, execution: ExecutionId, after: Option<ExecutionCursor>)
             -> Result<EventPage<ExecutionEvent>, HostError>;
}

```

`LaunchRequest` carries `launch_id`, `execution_id`, Thread/turn/model-attempt identity and optional Run/task/attempt IDs, an
optional external adapter Session ID, profile and negotiated-capability digests,
workspace ID/base/fencing epoch, bounded write scope, approved budget reservation,
secret references (never secret values),
and the adapter's requested operation. It carries no operator credential or
controller socket. The host validates the run-store dispatch receipt and current
fence before spawn; it cannot create tasks, approve permissions, change budgets, or
mark evidence. A child receives only a narrow execution capability and cannot read
the controller's state/credential channel.

`LaunchReceipt = LAUNCHED | ALREADY_LAUNCHED | NOT_LAUNCHED | UNKNOWN` with the
stable launch ID, observed process/peer handle, host identity, time, and evidence
reference. `NOT_LAUNCHED` requires authoritative proof that no process/peer action
occurred; timeout, connection loss, process disappearance, or missing telemetry is
`UNKNOWN`. `ExecutionObservation = ACTIVE | FINISHED | FAILED | CANCELLED |
NOT_FOUND_PROVEN | UNKNOWN`; `NOT_FOUND_PROVEN` is valid only when the host/adapter
can establish it for the exact launch ID. A capability snapshot that does not expose
query/resume, cancellation, events, or usage makes those fields unsupported or
unknown, never synthesized. The event page has a durable cursor for committed
events and separately labeled ephemeral progress; an event gap requires replay or a
fresh status snapshot. Cancel receipts report request delivery only; the controller
waits for a terminal observation and effect reconciliation before settling state.

The dispatch/recovery transaction is:

1. In one run-stream commit, write `WorkerExecution(PREPARED)` and one outbox row
   keyed by `(source_event_id, task_id)` and `launch_id`; reserve the attempt's
   execution count and resources.
2. `CMP-execution-host` claims that outbox row under a lease carrying a unique
   owner token and monotonic fencing epoch, validates the current
   workspace fence and capability snapshot, then launches once. Repeated requests
   with the same `launch_id` return the prior durable receipt; if a crash leaves the
   host unable to prove whether spawn occurred, it reports `UNKNOWN` and must not
   spawn a second worker under that ID until host/process reconciliation resolves it.
3. The run controller commits `LAUNCHED` receipt and the new state, then consumes
   ordered execution events. If the host returns or recovery observes `UNKNOWN`, it
   persists that state and does not create a replacement writer.
4. After controller restart, reconcile the outbox, host process table/adapter query,
   workspace diff, durable cursor, usage and prepared effects. Resume the same
   execution only when the negotiated capability supports it; otherwise settle or
   keep `UNKNOWN` and require review before retry.

An expired claim is not permission to launch again. Recovery first compares the
claim's owner token/epoch with the current owner, then asks the execution host to
reconcile the exact `launch_id`. A claim may return to dispatchable `PENDING` only with
an authoritative `NOT_LAUNCHED` receipt proving no process/peer action occurred; a
missing receipt, timeout, host restart, or possible side effect becomes `UNKNOWN`.
If spawn happened but the receipt/event publication was interrupted, recovery adopts
the existing process/peer handle and republishes the same receipt under the same
launch ID. This closes the claim-before-launch and launch-before-publication crash
windows without turning a retry into a second writer. A lease timeout alone proves
neither that the old owner stopped nor that spawn did not happen; fencing rejects
stale-owner writes, while OS/adapter reconciliation settles execution reality.

## Delegation contracts

**SubagentOptions / SubagentRef.** `worker` resolves to an `AgentProfile` in
`ARCH/product/COMMANDS-AND-SETTINGS.md`; a role is a selection policy that yields a profile or native role adapter,
not an arbitrary executable path. The resolved profile revision and capability
snapshot are pinned to the canonical `Attempt` as an immutable worker-binding
snapshot; they do not create a second attempt aggregate.

```
SubagentOptions {
  worker: role|profile_id,
  task: { objective, prompt?, success_conditions? },
  context: { fork: none|bounded|full, refs[], memory_policy?: none|relevant_shared|shared_and_profile },
  tools?: loadout_ref,
  model?: ModelRef|inherit|peer_managed, # accepted only if adapter can apply/report it
  isolation: readonly_inprocess|workspace_provider|external_adapter, # write isolation is explicit
  limits?: { max_steps?, max_tokens?, max_spend{amount,currency}?, wall_time_ms?,
             max_tool_calls?, max_worker_executions?, max_output_bytes?, max_disk_bytes?, max_children?,
             max_depth?, max_concurrent? },
  delivery: { await?: bounded(ms)|none, wake?: bool = true, surface?: parent|ui }
}
SubagentRef { agent_id, nickname?, thread_ref, work_id, status, parent_turn_id }

ContextPacketV1: see the canonical schema and selection rules in
[`CMP-context`](../core/CONTEXT.md#sub-agent-and-worktree-sharding).
```

`CMP-context` builds each packet independently from the child's task and pinned
workspace, not by copying the parent's rendered prompt. `fork=none` is the default.
The optional spawn-level memory policy only narrows the AgentProfile policy and the
user/managed ceiling; it cannot enable memory on its own.
`bounded` may carry only explicitly referenced, committed, user-visible history within
the task budget and effective memory policy. `full` is a native-only, same-trust
boundary exception requiring explicit user authorization; external adapters cannot
receive an implicit full transcript. Agent profile memory is off by default. When
enabled, only policy-eligible, current, relevant records from the profile's authorized
user/project namespace may be added, and each exact revision/digest is recorded in the
child ContextEpoch. Parent/sibling memory and transcript are not implicitly inherited.
Authorized child writes through CMP-memory remain profile-scoped advisory notes; children cannot confirm facts or write global memory. Child memory remains off by default; see ARCH/product/MEMORY.md. External adapters default to no memory injection unless
user/managed policy and negotiated data-egress capability both allow the specific
loadout. UI/usage reports show which source classes were included, excluded or stale;
provider-reported input usage is attributed to each actual child dispatch, so fan-out
cost is not hidden or counted as shared once.

**Receipt** — `{status, scope, summary, findings[], changed_files[], tests[], artifacts[], blockers[], confidence, usage, will_wake, partial}`. Receipts are untrusted data: scanned for instruction-shaped content and size-capped, with a full-log artifact ref when larger.

**Isolation modes.**

| Mode | Cost | Use | Write scope |
|---|---|---|---|
| `readonly_inprocess` | lowest | read-only analysis when the live context is useful | no writes; shared workspace is read-only |
| `workspace_provider` | bounded provider-specific cost | concurrent writers, risky refactors | isolated snapshot, explicitly integrated later |
| `external_adapter` | negotiated cost | external subordinate | exact approved provider binding; never inferred from protocol |

Tool scope for any child is `parent ceiling ∩ loadout ∩ agent rules`; limits may only narrow.
The run controller atomically reserves the parent's resource ceilings before any child
launch and rolls up observed usage by stable attempt/provider response IDs. A profile
can enforce only the limits its adapter exposes. Opaque ACP/CLI peers may have unknown
internal model, token, cost, quota, nested-child, or cancellation state; those fields
stay `unknown` and an enforceable hard provider-spend policy refuses an unmetered route.
Warnings and hard caps are distinct settings (`ARCH/product/COMMANDS-AND-SETTINGS.md`); a muted notification never
changes scheduler behavior.

**Budget vocabulary.** Each node carries ceilings for `tokens`, `cost`, `wall_ms`, and `tool_calls`, plus `reserved` and `spent`. The controller atomically reserves the attempt, mandatory verification, and recovery allowance against the run and node ceilings before dispatch, then reconciles actual and unknown usage. Concurrent node reservations cannot oversubscribe the parent; exhaustion fails closed and records the term (`ARCH/execution/LONG-HORIZON.md`).

## Receipts and execution

A Receipt has status, scope, bounded summary, findings, changed files, tests, artifacts, blockers, confidence, usage, will_wake and partial. It is untrusted data, never authority. Full child transcripts remain in the child Thread. Validate the schema; at most one bounded correction retry is allowed, then retain a bounded raw-text fallback and typed diagnostic. Scan or label instruction-shaped content without treating heuristic scanning as proof of trust.

Fork defaults to none. Bounded forks include only explicitly referenced committed visible history. Full native forks require explicit authorization and the same trust boundary; foreign workers never receive implicit full transcripts. Memory loadouts narrow user/profile policy and pin included revisions in ContextEpoch; memory never grants authority. Unsupported external memory/egress capabilities mean no injection.

WorkerConfigRenderer stages a bounded digest-pinned disposable configuration projection from approved policy and capability snapshots. Unsupported translation refuses launch; secret values are excluded, secret references are scoped. Activation occurs only before an eligible launch. A foreign configuration never becomes policy truth or proof of confinement.

## Failures and cancellation

Timeout, missing telemetry, lease expiry and lost process handles preserve UNKNOWN unless an authoritative exact-launch observation proves the outcome. No second writer starts before old process/effect reconciliation. Cancel delivery is distinct from terminal settlement. A cancelled child never wakes its parent. Background completion wakes only a live eligible parent at a safe boundary. Unsupported model override is rejected or reported peer_managed; unknown usage and nested-child state remain unknown.

Native launch receipts include Thread/Turn/model_attempt_id and optional managed IDs. Redelivery preserves execution/launch identity; an intentional new incarnation has a new launch ID/outbox key and consumes a new bounded launch reservation. Native OS process handles do not require synthetic peer schemas.

## Delegated execution flow

1. **Spawn.** Validate against depth/count/concurrency bounds → derive permission ceiling → build and persist the bounded `ContextPacket` and its digest → reserve packet and dispatch budget → create the child Thread → return `SubagentRef` immediately. A child cannot start before packet provenance, project identity, workspace revision, and policy snapshot are pinned. The stable dispatch ID makes a retried spawn return the same packet/receipt instead of injecting duplicate context; an intentional refresh creates a new ContextEpoch. Spawn is never coupled to child completion unless a bounded `await` is requested.
   Before spawning, estimate prompt/context replay, expected wall-time, verification and merge cost. If the task is not independent or its projected overhead exceeds its budget/value, run sequentially or decline delegation (`REQ-ORCH-006`).
2. **Run.** The child runs an ordinary turn loop with its own context and tools. A background child emits typed progress; it does not steal parent focus.
3. **Completion.** Two modes: a bounded foreground wait (park the parent on the child) or a queue-only wake at a turn boundary. Wake is suppressed unless the parent is live and the child was not cancelled. A bounded wait that overruns its budget auto-backgrounds rather than freezing the parent.
4. **Cancellation.** Explicit native ephemeral parent-execution cancel may cancel its owned children; managed Run/task cancellation follows target-scoped ARCH/execution/LONG-HORIZON.md rules. Client detach/view close does not cancel execution. A cancelled child never wakes the parent.
5. **Receipt intake.** Validate the receipt against schema; allow at most one bounded correction retry, then a raw-text fallback with a typed note. Roll usage up to the parent.
6. **Workspace flow.** Create an isolated provider snapshot at the base revision → grant a write lease → run → compute a diff → merge.
7. **Merge arbitration.** Order candidates by a stable topological order then task ID from pinned base revisions; completion timing is not an input. Apply clean patches; on conflict, stop that branch and record evidence. Reverify the combined integration revision.
8. **Task graph.** Nodes become ready only when every dependency has current independent `PASS` evidence bound to the approved spec and tested revision. The graph persists and resumes after compaction or restart; a resumed node reuses an effect or result only after reconciliation.
9. **Team run + CI.** Fan out a backlog within concurrency bounds; feed CI results back as node evidence; clean work applies, conflicts surface.
10. **Peer coordination.** Check sender capability and recipient membership, reserve bounded event/inbox resources, append one Run message event and idempotent per-recipient outbox IDs, then admit references to eligible Thread inboxes. Promote only at a safe provider-turn boundary. Never wake or restart paused/terminal workers; a message never changes Task state. Full schema and recovery semantics are in `ARCH/product/AGENT-MESSAGING.md`.

## Worker adapter port

```text
WorkerAdapter.probe(profile) -> NegotiatedCapabilities
WorkerAdapter.start(dispatch) -> LaunchReceipt
WorkerAdapter.send(execution, input_receipt) -> DeliveryReceipt
WorkerAdapter.observe(execution, cursor) -> ObservationPage
WorkerAdapter.interrupt(execution, request_id) -> DeliveryReceipt
WorkerAdapter.cancel(execution, request_id) -> DeliveryReceipt
WorkerAdapter.resume(execution, binding) -> ResumeReceipt
WorkerAdapter.reconcile(execution, launch_id) -> ExecutionObservation
```

Unsupported operations return typed capability failure. Adapter build/profile revision and negotiated capability digests are pinned before launch. Scope and budget may narrow only. Commands spawn, bounded await, cancel and close return receipt identity immediately; they do not synchronously monopolize operator control. ContextPacket is owned by CMP-context and records exact selected input/instruction/skill/memory source references rather than copying a rendered parent prompt.
