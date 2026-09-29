# 16 — Orchestration

Module LLD for `CMP-orch`. Sub-agent delegation, the durable long-horizon task graph, worktree lifecycle, deterministic merge arbitration, and parallel self-hosted team runs with CI feedback.

## Purpose

Run units of work — native workers, external agents, background jobs, and dependencies — under one durable controller, without a second state machine. Delegation is optional: use it only when independence, workspace separation, evidence value, and remaining budget justify its prompt/context replay and integration overhead (`DEC-036`). Every child is a durable Thread or a tracked opaque external attempt; every return is a bounded receipt, never authority; every write is scoped or arbitrated; every budget fails closed. The orchestrator owns *coordination and evidence*, not agent reasoning, capability execution, or the turn loop.

## Responsibilities

**Owned.**
- **Delegation.** Spawn, bound, monitor, cancel, and collect sub-agents. One child Thread per sub-agent with its own context and toolset/persona (`REQ-ORCH-001`).
- **Depth/count guard.** Enforce max depth, max total per tree, max parallel, and per-lane concurrency from configuration; a spawn may narrow these but never widen them (`REQ-ORCH-005`).
- **Permission derivation.** A child's effective authority is the parent's ceiling intersected with the spawn's declared scope; no child ever exceeds its parent.
- **Receipts.** Schema-validated summaries (status, scope, summary, findings, changed files, tests, artifacts, blockers, confidence, usage, partial marker) delivered under a no-authority header. Full transcripts stay in the child's own log.
- **Agent messaging.** Own a bounded, optional Run-scoped mailbox for explicit operator/worker recipients; append message and delivery facts to the existing Run stream and bridge recipients through idempotent `CMP-session` Thread-inbox receipts. The mailbox is not another task graph, thread tree, policy owner, or completion authority (`REQ-HORIZON-031`, `ARCH/32`).
- **Isolation.** Read-only in-process, git worktree, or ACP as per-spawn options; write-capable workers MUST use a fenced worktree or a serialized governed write channel. `inprocess` is never the default for concurrent mutation (`REQ-ORCH-002`).
- **Background jobs.** Fire-and-forget children that do not block the parent turn; completion wakes the parent at a boundary only when it is live and the child was not cancelled.
- **Execution lifecycle.** Persist each process/adapter incarnation as `WorkerExecution` in the run stream. `CMP-execution-host` owns idempotent spawn/observe/terminate mechanics; `CMP-orch` owns the durable execution state, fencing, reconciliation, retry eligibility, and attempt/task truth. A PID or peer handle disappearing is `UNKNOWN` until reconciled; a process exit never means Task `PASSED` (`REQ-HORIZON-028`).
- **System-wide admission sequencer.** Own the durable `SupervisorControlStream` and cross-process admission lock. Run admission, every model-driven worker or direct-turn execution, and executable maintenance are serialized here; each grant is acknowledged only after its control event and canonical Run/Thread record reconcile. This prevents direct turns outside a durable Run from racing an update, and makes one global admission decision authoritative without moving task truth out of per-run streams (`REQ-HORIZON-029`, `ARCH/25`, `DEC-062`).
- **Application maintenance fence.** Before a signed update replaces the executable, atomically close admission for new runs and all new model-driven worker/direct-turn executions, prove that no active or unknown execution/effect remains, and issue a one-use `MaintenancePermit` bound to the update operation, install identity, controller generation, and current binary digest. Keep the permit/fence through replacement and health check or rollback. On controller restart, reconcile the updater and helper before reopening admission; expiry alone cannot release an uncertain fence (`REQ-UPDATE-005`, `ARCH/30`).
- **Durable task graph.** A persisted DAG with dependencies, per-node budgets (tokens, cost, wall-clock, tool-calls), attempts, artifacts, and resumability across compaction and restart (`REQ-HORIZON-002`).
- **Worktree lifecycle.** Create, key, lease, diff, merge, and reap worktrees.
- **Merge arbitration.** Apply clean work, surface conflicts with evidence, deterministic given identical inputs (`REQ-ORCH-003`, `REQ-ORCH-004`).
- **Team orchestration + CI feedback.** Run N workers against a shared backlog, feed CI results back into the graph, and escalate conflicts.

**Not owned.** The turn loop and model step (`CMP-runner`); child reasoning (`CMP-runner` per Thread); credential/policy rules (`CMP-guard`); the durable Thread log itself (`CMP-session`, historic component name); provider transports (`CMP-provider`); the audit chain (`CMP-audit`).

## Interfaces

**Depends on.**
- `CMP-session` — durable child Threads, checkpoints, replay.
- `CMP-execution-host` — host process lifecycle and reconciled launch/exit receipts; it cannot change run/task/attempt states.
- `CMP-runner` — one run per child Thread; parent/child cancellation tokens.
- `CMP-guard` — permission derivation and approval routing for child asks.
- `CMP-context` — per-child context assembly; explicit `ContextPacket` and `fork` policy (none/bounded/full); bounded forks name exact visible source references and never copy the rendered parent prompt implicitly.
- `CMP-provider` — model selection per child role.
- `CMP-acp` — transport for ACP-isolated children (`REQ-PROTO-004`).
- `CMP-sandbox` — path-scoped worktree writes.
- `CMP-tools` — child tool scope = parent ceiling ∩ loadout ∩ agent rules.
- `CMP-audit` — receipts, merges, and cross-boundary effects.

**Exposes to.** `CMP-runner` (spawn/await/cancel), `CMP-acp` client mode (its children are orchestrated here), `CMP-tui` (task graph and background-job views), `CMP-headless` (CI runs).

**Public surface (sketch).**

```
spawn(SubagentOptions) -> SubagentRef          # returns immediately
await(ref, bounded_ms|none) -> Receipt
cancel(ref) / close(ref)
post_message(auth, request) -> MessageReceipt
list_messages(auth, run_id, filter, cursor) -> MessagePage
message_status(auth, delivery_id) -> MessageDeliveryStatus
acknowledge_message(auth, message_id) -> AckReceipt # explicit, optional; not proof of understanding
admission.admit_run(operation_id, start_intent) -> RunAdmissionReceipt
graph.add(node, deps[]) -> NodeId
graph.ready() -> [NodeId]
merge(worktree_ref) -> MergeResult
work.acquire(operation_id, kind, run_id?, thread_id, turn_id?, execution_id, attempt_id?) -> WorkPermit | Busy(reason)
work.settle(permit, COMPLETED | INTERRUPTED | FAILED, terminal_receipt) -> Receipt
work.reconcile(permit, host_or_session_observation) -> ACTIVE | SETTLED | UNKNOWN
maintenance.acquire(operation_id, install_id, binary_digest, operator_action_ref) -> MaintenancePermit | Busy(reason)
maintenance.settle(permit, UPDATED | ROLLED_BACK | ABORTED_RECONCILED) -> Receipt
```

`admission.admit_run` and `work.acquire` use the same cross-process sequencer and
stable operation-ID idempotency. `work.acquire` first writes the control intent and
canonical Thread-turn or attempt-execution record, then its grant; providers and
execution hosts reject dispatch without the granted receipt. `work.settle` is allowed
only after a terminal process/peer receipt and effect reconciliation. A timeout or
disconnect is not a terminal outcome; `work.reconcile` keeps the permit `UNKNOWN`
until an authoritative observation arrives. The lock is held only while committing
these bounded transitions, while the durable permit blocks maintenance for the
execution's full lifetime.

## Data / state model

**SubagentOptions / SubagentRef.** `worker` resolves to an `AgentProfile` in
`ARCH/27`; a role is a selection policy that yields a profile or native role adapter,
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
  isolation: readonly_inprocess|worktree|acp, # write isolation is explicit
  limits?: { max_steps?, max_tokens?, max_spend{amount,currency}?, wall_time_ms?,
             max_tool_calls?, max_worker_executions?, max_output_bytes?, max_disk_bytes?, max_children?,
             max_depth?, max_concurrent? },
  delivery: { await?: bounded(ms)|none, wake?: bool = true, surface?: parent|ui }
}
SubagentRef { agent_id, nickname?, thread_ref, work_id, status, parent_turn_id }

ContextPacket {
  packet_id, dispatch_id, packet_digest, run_id, task_id, attempt_id, thread_id,
  context_epoch_id, project_id, context_scope_digest,
  approved_task_contract_ref, spec_digest, selected_source_refs[],
  instruction_refs[], skill_refs[], memory_refs[],
  permission_snapshot_digest, workspace_revision, byte/token_budget,
  omitted_context[], created_seq
}
```

`CMP-context` builds each packet independently from the child's task and pinned
workspace, not by copying the parent's rendered prompt. `fork=none` is the default.
The optional spawn-level memory policy only narrows the AgentProfile policy and the
user/managed ceiling; it cannot enable memory on its own.
`bounded` may carry only explicitly referenced, committed, user-visible history within
the task budget and effective memory policy. `full` is a native-only, same-trust
boundary exception requiring explicit user authorization; external adapters cannot
receive an implicit full transcript. Agent profile memory is off by default. When
enabled, only accepted, current, relevant records from the profile's authorized
user/project namespace may be added, and each exact revision/digest is recorded in the
child ContextEpoch. Parent/sibling memory and transcript are not implicitly inherited.
The child can only submit new memory candidates through `CMP-memory`; it cannot write
accepted records directly. External adapters default to no memory injection unless
user/managed policy and negotiated data-egress capability both allow the specific
loadout. UI/usage reports show which source classes were included, excluded or stale;
provider-reported input usage is attributed to each actual child dispatch, so fan-out
cost is not hidden or counted as shared once.

**Receipt** — `{status, scope, summary, findings[], changed_files[], tests[], artifacts[], blockers[], confidence, usage, will_wake, partial}`. Receipts are untrusted data: scanned for instruction-shaped content and size-capped, with a full-log artifact ref when larger.

**Isolation modes.**

| Mode | Cost | Use | Write scope |
|---|---|---|---|
| `readonly_inprocess` | lowest | read-only analysis when the live context is useful | no writes; shared workspace is read-only |
| `worktree` | medium | concurrent writers, risky refactors | isolated checkout, merged later |
| `acp` | highest | external peer agent as subordinate | peer-managed; receipt only |

Tool scope for any child is `parent ceiling ∩ loadout ∩ agent rules`; limits may only narrow.
The run controller atomically reserves the parent's resource ceilings before any child
launch and rolls up observed usage by stable attempt/provider response IDs. A profile
can enforce only the limits its adapter exposes. Opaque ACP/CLI peers may have unknown
internal model, token, cost, quota, nested-child, or cancellation state; those fields
stay `unknown` and an enforceable hard provider-spend policy refuses an unmetered route.
Warnings and hard caps are distinct settings (`ARCH/27`); a muted notification never
changes scheduler behavior.

**Budget vocabulary.** Each node carries ceilings for `tokens`, `cost`, `wall_ms`, and `tool_calls`, plus `reserved` and `spent`. The controller atomically reserves the attempt, mandatory verification, and recovery allowance against the run and node ceilings before dispatch, then reconciles actual and unknown usage. Concurrent node reservations cannot oversubscribe the parent; exhaustion fails closed and records the term (`ARCH/25`).


**TaskNode** — `{id, run_id, spec_digest, kind, deps[], acceptance_ids[], state, budgets{tokens,cost,wall_ms,tool_calls}, reserved, spent, attempt_ids[], artifacts[], owner, workspace_id?, evidence_refs[]}`. Task, attempt, turn, and run use distinct state machines (`ARCH/25`). Worker completion moves a task to `VERIFYING`; only current independent `PASS` evidence moves it to `PASSED`.

**Worktree record** — `{id, path, base_ref, head_ref, branch, lease_owner, lease_expiry, fence_epoch, status}`. A stale lease is reaped only after external writes are reconciled; every write and settlement checks the fence epoch.

**MergeResult** — `{applied[], conflicts[]{path, base, ours, theirs, evidence_ref}, method, deterministic_key}`. Conflicts carry evidence, never a silent overwrite.

## Lifecycle & flows

1. **Spawn.** Validate against depth/count/concurrency bounds → derive permission ceiling → build and persist the bounded `ContextPacket` and its digest → reserve packet and dispatch budget → create the child Thread → return `SubagentRef` immediately. A child cannot start before packet provenance, project identity, workspace revision, and policy snapshot are pinned. The stable dispatch ID makes a retried spawn return the same packet/receipt instead of injecting duplicate context; an intentional refresh creates a new ContextEpoch. Spawn is never coupled to child completion unless a bounded `await` is requested.
   Before spawning, estimate prompt/context replay, expected wall-time, verification and merge cost. If the task is not independent or its projected overhead exceeds its budget/value, run sequentially or decline delegation (`REQ-ORCH-006`).
2. **Run.** The child runs an ordinary turn loop with its own context and tools. A background child emits typed progress; it does not steal parent focus.
3. **Completion.** Two modes: a bounded foreground wait (park the parent on the child) or a queue-only wake at a turn boundary. Wake is suppressed unless the parent is live and the child was not cancelled. A bounded wait that overruns its budget auto-backgrounds rather than freezing the parent.
4. **Cancellation.** Parent cancel cascades to descendants; session teardown cancels without rebuffering; a cancelled child never wakes the parent.
5. **Receipt intake.** Validate the receipt against schema; allow at most one bounded correction retry, then a raw-text fallback with a typed note. Roll usage up to the parent.
6. **Worktree flow.** Create an isolated checkout at the base ref → grant a write lease → run → compute a diff → merge.
7. **Merge arbitration.** Order candidates by a stable topological order then task ID from pinned base revisions; completion timing is not an input. Apply clean patches; on conflict, stop that branch and record evidence. Reverify the combined integration revision.
8. **Task graph.** Nodes become ready only when every dependency has current independent `PASS` evidence bound to the approved spec and tested revision. The graph persists and resumes after compaction or restart; a resumed node reuses an effect or result only after reconciliation.
9. **Team run + CI.** Fan out a backlog within concurrency bounds; feed CI results back as node evidence; clean work applies, conflicts surface.
10. **Peer coordination.** Check sender capability and recipient membership, reserve bounded event/inbox resources, append one Run message event and idempotent per-recipient outbox IDs, then admit references to eligible Thread inboxes. Promote only at a safe provider-turn boundary. Never wake or restart paused/terminal workers; a message never changes Task state. Full schema and recovery semantics are in `ARCH/32`.

**Scheduling & concurrency.**
- Independent nodes dispatch in parallel up to `max_parallel`; dependent nodes wait on a settle barrier.
- `max_live_children` and workspace leases bound the full child lifecycle and remain
  held until the child is closed or reconciled. `max_running` is a separate execution
  semaphore: it is released when a child enters a durable `WAITING` state (permission,
  clarification, or external dependency) and reacquired on resume. Thus parked children
  consume a bounded pending-child allowance, not active execution capacity; reaching
  either limit queues or rejects admission according to the configured policy.
- Admission is queue-on-limit by default with an explicit fail-fast opt-in.
- The parent does non-overlapping work while children run; it never blocks on a background child.
- Cancellation is cooperative and token-based and cascades to descendants; a cancelled child is terminal and never wakes the parent.

### Application replacement fence

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


## Failure modes

| Failure | Behavior |
|---|---|
| Child fails/blocks | Receipt with blockers; parent re-plans or escalates |
| Child cancelled | Terminal, never wakes; slot released on close |
| Depth/count exceeded | Spawn rejected typed; no silent truncation |
| Permission exceeds parent ceiling | Spawn rejected typed; child scope narrowed only |
| Overlapping writes | Write lease serializes; conflict routed through merge arbitration |
| Worktree creation fails | Fall back to in-process only if the task is read-only; otherwise fail typed |
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
| Local agent executable changes after profile approval | Refuse launch and quarantine until the canonical path/digest is re-probed and trust is re-reviewed (`ARCH/27`) |
| Background work continuously consumes slots | Fair lane reservations; interactive steer/cancel/approval have bounded dispatch latency (`REQ-HORIZON-014`) |
| Message targets a foreign, stale, paused, or unsupported recipient | Reject before append or return an explicit delivery state; never leak content across Runs or auto-wake an agent (`ARCH/32`) |
| Message store/inbox boundary crashes or retries | Reconcile by stable message/delivery ID and payload digest; never duplicate a canonical post or provider input (`ARCH/32`) |
| CI red | Result fed back as evidence; worker re-plans or escalates |

## Configuration

- `orch.max_depth`, `orch.max_parallel`, `orch.max_total_per_tree`, `orch.per_lane_defaults`.
- `orch.default_isolation` (`readonly_inprocess`), `orch.wake_default`, fairness quotas and maximum wait age.
- `orch.limits.{max_worker_tokens, max_session_spend{amount,currency}, wall_time_ms, max_tool_calls, max_output_bytes, max_disk_bytes, max_children, max_depth, max_concurrent}` (Core-owned ceilings; spawns narrow only).
- Agent profile model-control, source/trust state, and per-attempt usage capability are specified in `ARCH/27`; a profile is not itself a budget or a verified task.
- Warning thresholds are user-configurable per budget/resource in `ARCH/27`; warning delivery is best-effort, but dispatch ceilings are controller-enforced.
- `orch.receipt.max_bytes`, `orch.receipt.correction_retries` (≤1).
- `worktree.root`, `worktree.lease_seconds`, `worktree.reap_interval`.
- `merge.strategy`, `merge.conflict_policy` (surface, never auto-discard).
- `ci.command[]`, `ci.timeout_ms`, `ci.retry`.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-ORCH-001` | Sub-agents run in isolated sessions and return receipts, not transcripts |
| `REQ-ORCH-002` | Filesystem isolation via git worktrees as an explicit per-spawn option |
| `REQ-ORCH-003` | Non-overlapping write scopes enforced by leases, or an explicit merge step |
| `REQ-ORCH-004` | Merge arbitration is deterministic given identical inputs |
| `REQ-ORCH-005` | Depth and count bounded by configuration |
| `REQ-ORCH-006` | Delegation is optional and bounded by evidence value, isolation, and resource cost |
| `REQ-ORCH-007..009` | Profile lifecycle, capability-aware model selection, and sourced per-agent usage/limits are defined in `ARCH/27` and enforced at dispatch |
| `REQ-HORIZON-001` | A session (and its graph) resumes after an arbitrary gap without task-state loss |
| `REQ-HORIZON-002` | Durable task graph survives compaction and restart |
| `REQ-HORIZON-003` | Token/cost/wall budgets enforceable per node and session; fail closed |
| `REQ-HORIZON-004` | Waiting/queued states are distinct from working states in the graph projection |
| `REQ-SESS-003` | Checkpoint and rewind operate on child and parent session boundaries |
| `REQ-LOOP-004` | Every node run terminates in exactly one terminal state |
| `REQ-GUARD-001` | Permission derivation produces ordered, deterministic child rules |
| `REQ-GUARD-002` | A child's unmatched action still fails closed |
| `REQ-AUDIT-001` | Cross-boundary effects, receipts, and merges append to the audit log |
| `REQ-TOOL-003` | A child's denied tools are absent from its materialized tool set |

## Open questions

1. **`fork` default per role.** The default context fork policy (none/bounded/full) for coder, researcher, and reviewer roles is unresolved.
2. **Review queue.** Whether a human review queue for child receipts ships in v1 or is deferred.
3. **Worktree storage ceiling.** The cap on concurrent worktrees and the disk-pressure reaping policy.
4. **Cross-host team runs.** Whether "self-hosted team" is single-machine only in v1 or includes remote sandboxes behind one interface.
5. **Receipt trust scanning.** The exact instruction-shaped-pattern detector and whether flagged findings are dropped or only annotated.
6. **Graph visualization.** Which projection (TUI panel versus headless NDJSON) is authoritative for the task graph.
