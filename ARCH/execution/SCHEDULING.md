# Scheduling

## Purpose and ownership

One CMP-orch controller admits managed work; CMP-runner schedules tools within an admitted bounded response using the same policy/resource/effect owners. Tools do not create a replacement task scheduler.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `ToolBatch` | `batch_id`, `thread_id`, `turn_id`, `model_attempt_id`, optional `run_id`, `task_id`, `attempt_id`, `provider_response_id?`, `response_digest`, `calls[{call_ordinal, call_id, effect_id?, settlement_class?}]`, `call_count`, `argument_bytes`, `retained_response_bytes`, `limits_digest`, `state`, `rejection_reason?`, `usage_observation_id?`. `state = COLLECTING | ADMITTED | SUSPENDED_FOR_INPUT | REJECTED | SETTLING | SETTLED`; no call dispatch before `ADMITTED`. Over-cap/malformed/duplicate-ID response is rejected whole. If one valid question call is mixed with siblings, persist `SUSPENDED_FOR_INPUT`, dispatch no siblings, then settle suppressed calls with `not_run_question_boundary` after the answer. More than one question call or any malformed question rejects the whole unstarted batch. Safe non-question calls may finish concurrently only where no question/control boundary is present; model-visible results are projected in `call_ordinal` order while canonical owner events retain actual completion order (`ARCH/core/TOOLS.md`). |
| `AttemptProgress` | `attempt_id`, `revision`, `items[]`, `source_tool_call_id`, `event_seq`, `updated_at`. A bounded, controller-validated projection of `todowrite` updates for worker continuity only; it cannot change task/run status, acceptance criteria, budget, permission, or evidence and never substitutes for verifier evidence. |
| `ProgressSignature` | `signature_id`, `run_id`, `task_id?`, `spec_digest`, `task_graph_digest`, `workspace_digest`, `evidence_digest`, `external_cursor_digest`, `failure_fingerprint?`, `strategy_digest`, `batch_digest?`, `result_class`, `created_at`. Semantic digest excludes timestamps, IDs, strategy labels, raw external cursors, changing batch labels, model prose, heartbeats, repeated reads, and call count; repeated signatures increment a durable no-progress counter. |
| `WaitCondition` | `wait_id`, `run_id`, `task_id?`, `kind: TIMER | USER | APPROVAL | EXTERNAL_EVENT | RESOURCE`, `due_at?`, `source_ref?`, `source_cursor?`, `deadline?`, `state: ARMED | FIRED | EXPIRED | CANCELLED`, `wake_event_id?`, `poll_policy_ref?`. No model inference while only waiting; external polling is a separately authorized/budgeted task. |

At each dispatch boundary, the controller: (1) checks approved spec and graph acyclicity; (2) selects `READY` tasks by stable priority, fair-lane quota, age, and task ID; (3) checks permission and capability requirements; (4) atomically reserves expected attempt cost **plus** mandatory verification and recovery reserve against HorizonCode-owned task/run ceilings and any separately negotiated, enforceable adapter ceiling; (5) claims a fenced workspace; (6) launches a bounded attempt. Provider-account observations from `REQ-PROV-014` are advisory and are not part of this reservation set. Real provider usage is reconciled to the reservation after every response, including failed/fallback responses. Estimated, included-plan, unknown, and actual costs remain distinct and carry currency. Unknown pricing or unavailable currency conversion under a monetary cap blocks dispatch or requires a separately approved token-only policy. A zero-dollar subscription label does not prove zero quota impact. User cancel and permission responses receive reserved service capacity.

Response admission is a separate loop gate: fully collect one bounded provider response, enforce call-count/argument-byte/retained-byte limits, validate the full batch, and persist `ToolBatch=ADMITTED` before scheduling. Over-cap or malformed output receives `REJECTED` and dispatches zero calls. Record provider-reported generation usage even when the tool batch is rejected; this gate cannot undo or prevent tokens already generated. Once an admitted call begins, reconcile each effect separately; do not pretend multi-tool execution is atomic.

For scheduled waits, persist `WaitCondition` and release the worker. A timer or external event creates an idempotent, sequence-stamped wake after checking the condition and current policy/budget again. No model call, heartbeat prompt, or busy poll runs during the idle interval. User pause has priority over event wake and fences dispatch; cancellation is terminal after in-flight effects are reconciled. External polling uses explicit cadence, permissions, budget, timeout, and stop condition.

Empty assistant output, an empty tool batch, a heartbeat, or a successful deterministic
background job is not progress and cannot independently trigger another model turn.
The scheduler waits on the process/job completion event or a declared external
condition; it does not ask a model to poll a healthy deterministic job. An empty
provider finish may be retried only when the provider adapter classifies it as
transient and a bounded, evidence-changing strategy exists; otherwise report the
empty-turn result and pause.

## Tool invocation classification

Scheduling is per invocation. Classify data dependencies, filesystem/process/network effects, workspace ownership and resource conflicts. Independently scoped calls may overlap; conflicting mutations serialize. A safe tool name alone is insufficient. Unknown classification is exclusive. The full bounded response must be admitted before any sibling runs; malformed, over-cap or duplicate-ID batches dispatch nothing. A question boundary suspends siblings and preserves exact-origin durable answer flow.

The scheduler uses a bounded rolling pool within explicitly independent call groups,
exclusive barriers, and model-order observation slots. Settle each effect durably as
it finishes; ordered model observations must not delay effect/audit receipts. Whole
response admission remains mandatory before any execution (REQ-LOOP-008). Snapshot
schemas/identity never widen midbatch. Recheck live revocations and runtime availability
before dispatch; a narrowed concurrency mode inserts a barrier. Unknown mode is
exclusive. Cancellation stops replenishment, cancels/drains started calls with finite
deadlines, and records skipped/cancelled/unknown separately; never fabricates successful
results. Guard/audit/storage failure fences effect dispatch rather than becoming a
routine recoverable tool error. Recoverable tool errors remain structured observations.

Cache keys bind workspace/revision/dirty digest, policy, config, schema generation,
route/tokenizer and source versions. Persistent caches are rebuildable and incomplete
entries are never current truth. Filesystem events coalesce invalidations; overflow
forces rescan with stale status. Optional startup jobs run in a bounded pool and cannot
starve input/cancel/approval. Stable prompts order reusable identity/instructions/tool
contracts and project rules before volatile runtime tail. Security-required content
is never relocated or omitted merely to improve cache hits. Provider in-history system
updates/incremental tools require explicit negotiated support and equivalence tests;
unsupported routes rebuild a fresh epoch. Preserve mandatory provider continuation
fields privately; never expose hidden reasoning through UI/export.

Code Mode is optional and evaluation-gated, not automatic for every multi-tool request.
Programs run in a bounded isolated runtime without ambient filesystem/network/process
access. Every nested call uses the same registry, Guard, budget, sandbox and effect
path; caps cover total nested calls, concurrency, output, memory, execution and wall
time. Outstanding calls reconcile on timeout/cancel; retry does not replay settled
effects. A warm prefix and fewer model calls are measured possibilities, not universal
provider cache or speed guarantees. Persistent PTYs retain supervised scoped process
state, recheck authority per command and cannot survive revocation as a bypass.

## Delegation capacity and fairness

**Scheduling & concurrency.**
- Independent nodes dispatch in parallel up to `max_parallel`; dependent nodes wait on a settle barrier.
- `max_live_children` and workspace leases bound the full child lifecycle and remain
  held until the child is closed or reconciled. `max_running` is a separate execution
  semaphore: it is released only when the corresponding execution has settled or is safely parked without active effects after a durable wait; it is reacquired on resume. Thus parked children
  consume a bounded pending-child allowance, not active execution capacity; reaching
  either limit queues or rejects admission according to the configured policy.
- Admission is queue-on-limit by default with an explicit fail-fast opt-in.
- The parent does non-overlapping work while children run; it never blocks on a background child.
- Cancellation is cooperative and target-scoped; Run cancellation fences owned dispatch, task cancellation leaves dependents blocked without cascading. Native ephemeral children may share their parent execution token. Terminal cancellation follows effect reconciliation, and a cancelled child never wakes the parent.

## Strategy rounds

Ralph-inspired iteration is an optional versioned strategy under RunController:
each fresh worker receives immutable objective, bounded previous report and a fenced
workspace snapshot. Persist rounds, spend, elapsed time and ProgressSignature across
restarts. Report continue/candidate_complete/blocked; budget exhaustion and worker
failure are distinct. Candidate completion dispatches revision-bound independent
verification, never PASS from evidence strings. Child depth is persisted monotonically
and cannot reset on resume. Stop/cancel flows reconcile every round's effects before
another launch. Workflow templates cannot install a replacement controller or accept
hot policy widening. The shared performance and Code Mode contracts apply.

## Resource bounds and acceptance

Independent groups replenish available slots without waiting for a full batch. Original invocation order governs model-visible observation; actual completion order governs durable effect settlement. Bound groups, pending/active children, nested calls, event/output bytes and cancellation drain deadlines. Test dynamic narrowing, revocation, exclusive barriers, out-of-order completion, starvation, late completion and unknown outcomes. Numerical interaction targets live only in [Performance](../contracts/PERFORMANCE.md).
