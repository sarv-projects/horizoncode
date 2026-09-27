# 16 — Orchestration

Module LLD for `CMP-orch`. Sub-agent delegation, the durable long-horizon task graph, worktree lifecycle, deterministic merge arbitration, and parallel self-hosted team runs with CI feedback.

## Purpose

Run units of work — native workers, external agents, background jobs, and dependencies — under one durable controller, without a second state machine. Delegation is optional: use it only when independence, workspace separation, evidence value, and remaining budget justify its prompt/context replay and integration overhead (`DEC-036`). Every child is a normal durable session or a tracked opaque external attempt; every return is a bounded receipt, never authority; every write is scoped or arbitrated; every budget fails closed. The orchestrator owns *coordination and evidence*, not agent reasoning, capability execution, or the turn loop.

## Responsibilities

**Owned.**
- **Delegation.** Spawn, bound, monitor, cancel, and collect sub-agents. One child session per sub-agent with its own context and toolset/persona (`REQ-ORCH-001`).
- **Depth/count guard.** Enforce max depth, max total per tree, max parallel, and per-lane concurrency from configuration; a spawn may narrow these but never widen them (`REQ-ORCH-005`).
- **Permission derivation.** A child's effective authority is the parent's ceiling intersected with the spawn's declared scope; no child ever exceeds its parent.
- **Receipts.** Schema-validated summaries (status, scope, summary, findings, changed files, tests, artifacts, blockers, confidence, usage, partial marker) delivered under a no-authority header. Full transcripts stay in the child's own log.
- **Isolation.** Read-only in-process, git worktree, or ACP as per-spawn options; write-capable workers MUST use a fenced worktree or a serialized governed write channel. `inprocess` is never the default for concurrent mutation (`REQ-ORCH-002`).
- **Background jobs.** Fire-and-forget children that do not block the parent turn; completion wakes the parent at a boundary only when it is live and the child was not cancelled.
- **Durable task graph.** A persisted DAG with dependencies, per-node budgets (tokens, cost, wall-clock, tool-calls), attempts, artifacts, and resumability across compaction and restart (`REQ-HORIZON-002`).
- **Worktree lifecycle.** Create, key, lease, diff, merge, and reap worktrees.
- **Merge arbitration.** Apply clean work, surface conflicts with evidence, deterministic given identical inputs (`REQ-ORCH-003`, `REQ-ORCH-004`).
- **Team orchestration + CI feedback.** Run N workers against a shared backlog, feed CI results back into the graph, and escalate conflicts.

**Not owned.** The turn loop and model step (`CMP-runner`); child reasoning (`CMP-runner` per session); credential/policy rules (`CMP-guard`); the durable session log itself (`CMP-session`); provider transports (`CMP-provider`); the audit chain (`CMP-audit`).

## Interfaces

**Depends on.**
- `CMP-session` — durable child sessions, checkpoints, replay.
- `CMP-runner` — one run per child session; parent/child cancellation tokens.
- `CMP-guard` — permission derivation and approval routing for child asks.
- `CMP-context` — per-child context assembly; `fork` policy (none/bounded/full) with a bounded inherited snapshot, never the parent transcript.
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
graph.add(node, deps[]) -> NodeId
graph.ready() -> [NodeId]
merge(worktree_ref) -> MergeResult
```

## Data / state model

**SubagentOptions / SubagentRef.**

```
SubagentOptions {
  worker: role|profile,
  task: { objective, prompt?, success_conditions? },
  context: { fork: none|bounded|full, refs[] },
  tools?: loadout_ref,
  model?: ModelRef|inherit,
  isolation: readonly_inprocess|worktree|acp, # write isolation is explicit
  limits?: { max_steps?, max_tokens?, max_spend?, wall_time_ms? },
  delivery: { await?: bounded(ms)|none, wake?: bool = true, surface?: parent|ui }
}
SubagentRef { agent_id, nickname?, session_ref, work_id, status, parent_turn_id }
```

**Receipt** — `{status, scope, summary, findings[], changed_files[], tests[], artifacts[], blockers[], confidence, usage, will_wake, partial}`. Receipts are untrusted data: scanned for instruction-shaped content and size-capped, with a full-log artifact ref when larger.

**Isolation modes.**

| Mode | Cost | Use | Write scope |
|---|---|---|---|
| `readonly_inprocess` | lowest | read-only analysis when the live context is useful | no writes; shared workspace is read-only |
| `worktree` | medium | concurrent writers, risky refactors | isolated checkout, merged later |
| `acp` | highest | external peer agent as subordinate | peer-managed; receipt only |

Tool scope for any child is `parent ceiling ∩ loadout ∩ agent rules`; limits may only narrow.

**Budget vocabulary.** Each node carries ceilings for `tokens`, `cost`, `wall_ms`, and `tool_calls`, plus `reserved` and `spent`. The controller atomically reserves the attempt, mandatory verification, and recovery allowance against the run and node ceilings before dispatch, then reconciles actual and unknown usage. Concurrent node reservations cannot oversubscribe the parent; exhaustion fails closed and records the term (`ARCH/25`).


**TaskNode** — `{id, run_id, spec_digest, kind, deps[], acceptance_ids[], state, budgets{tokens,cost,wall_ms,tool_calls}, reserved, spent, attempt_ids[], artifacts[], owner, workspace_id?, evidence_refs[]}`. Task, attempt, turn, and run use distinct state machines (`ARCH/25`). Worker completion moves a task to `VERIFYING`; only current independent `PASS` evidence moves it to `PASSED`.

**Worktree record** — `{id, path, base_ref, head_ref, branch, lease_owner, lease_expiry, fence_epoch, status}`. A stale lease is reaped only after external writes are reconciled; every write and settlement checks the fence epoch.

**MergeResult** — `{applied[], conflicts[]{path, base, ours, theirs, evidence_ref}, method, deterministic_key}`. Conflicts carry evidence, never a silent overwrite.

## Lifecycle & flows

1. **Spawn.** Validate against depth/count/concurrency bounds → derive permission ceiling → create the child session → return `SubagentRef` immediately. Spawn is never coupled to child completion unless a bounded `await` is requested.
   Before spawning, estimate prompt/context replay, expected wall-time, verification and merge cost. If the task is not independent or its projected overhead exceeds its budget/value, run sequentially or decline delegation (`REQ-ORCH-006`).
2. **Run.** The child runs an ordinary turn loop with its own context and tools. A background child emits typed progress; it does not steal parent focus.
3. **Completion.** Two modes: a bounded foreground wait (park the parent on the child) or a queue-only wake at a turn boundary. Wake is suppressed unless the parent is live and the child was not cancelled. A bounded wait that overruns its budget auto-backgrounds rather than freezing the parent.
4. **Cancellation.** Parent cancel cascades to descendants; session teardown cancels without rebuffering; a cancelled child never wakes the parent.
5. **Receipt intake.** Validate the receipt against schema; allow at most one bounded correction retry, then a raw-text fallback with a typed note. Roll usage up to the parent.
6. **Worktree flow.** Create an isolated checkout at the base ref → grant a write lease → run → compute a diff → merge.
7. **Merge arbitration.** Order candidates by a stable topological order then task ID from pinned base revisions; completion timing is not an input. Apply clean patches; on conflict, stop that branch and record evidence. Reverify the combined integration revision.
8. **Task graph.** Nodes become ready only when every dependency has current independent `PASS` evidence bound to the approved spec and tested revision. The graph persists and resumes after compaction or restart; a resumed node reuses an effect or result only after reconciliation.
9. **Team run + CI.** Fan out a backlog within concurrency bounds; feed CI results back as node evidence; clean work applies, conflicts surface.

**Scheduling & concurrency.**
- Independent nodes dispatch in parallel up to `max_parallel`; dependent nodes wait on a settle barrier.
- Slots are held until a child is closed, not merely until it finishes, so a waiting child cannot starve admission.
- A waiting child (guard ask, question, bounded wait) parks without holding a running slot.
- Admission is queue-on-limit by default with an explicit fail-fast opt-in.
- The parent does non-overlapping work while children run; it never blocks on a background child.
- Cancellation is cooperative and token-based and cascades to descendants; a cancelled child is terminal and never wakes the parent.


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
| Duplicate receipt delivery | At-most-once per parent incarnation |
| Child asks permission with no connected/authorized UI | Route to a durable root request with deadline; deny/cancel and settle on expiry (`REQ-HORIZON-012`) |
| External worker reports success with hidden child work/usage | Record opaque child state and unknown usage; never infer pass or zero cost (`REQ-HORIZON-009`) |
| Background work continuously consumes slots | Fair lane reservations; interactive steer/cancel/approval have bounded dispatch latency (`REQ-HORIZON-014`) |
| CI red | Result fed back as evidence; worker re-plans or escalates |

## Configuration

- `orch.max_depth`, `orch.max_parallel`, `orch.max_total_per_tree`, `orch.per_lane_defaults`.
- `orch.default_isolation` (`readonly_inprocess`), `orch.wake_default`, fairness quotas and maximum wait age.
- `orch.limits.{max_worker_tokens, max_session_spend, wall_time_ms}` (Core-owned ceilings; spawns narrow only).
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
