# 21. Reliability, permissions and bounded workspace pool

Status: normative reliability policy.

## 21.1 Healing tiers

L1 deterministic local repair:
- retry safe reads;
- refresh stale file/index/browser refs;
- rebuild derived cache/index;
- restart crashed disposable worker;
- re-run deterministic validation.

L2 selected-provider/runtime infrastructure recovery:
- reconnect/re-auth when allowed;
- same selected model/provider retry under bounded policy;
- wait for rate window according to user policy.

L3 advisory learned patterns:
- suggest known remediation with provenance;
- never self-authorize policy/config changes.

L4 post-V1 adaptive changes:
- sandboxed candidate generation/evaluation only;
- explicit adoption gate.

## 21.2 Retry law

Retry only when:
- failure class is retryable;
- target effect idempotency/reconciliation is understood;
- budget/deadline permits;
- retry cannot widen capability or silently change model/provider/cost.

UNKNOWN non-idempotent effects are reconciled or escalated, not re-executed.

## 21.3 Permission modes

Ask, Safe Auto and YOLO-in-sandbox are user experience policies over the same canonical Guard.

Mode changes are explicit config actions. No mode grants secret access, production authority, unsupported sandbox or hidden paid routing.

## 21.4 Worktree/resource pool

Use a worktree only when isolation benefits exceed integration/cleanup cost.

Pool record:
- workspace/repo/base revision;
- worktree path;
- lease owner/run/task;
- status FREE/LEASED/QUARANTINED;
- dirty/untracked summary;
- owned processes/ports/test DB;
- last verified clean revision.

Rules:
- hard maximum;
- optional small idle warm minimum;
- never delete dirty/user-owned state;
- lease/fence before use;
- release processes/ports first;
- verify clean before returning to FREE;
- quarantine ambiguity;
- no per-subagent automatic worktree explosion.

## 21.5 Parallelism

Parallelize independent work when:
- write sets/resources do not conflict;
- integration order is understood;
- expected speedup exceeds orchestration/model/worktree cost.

Prefer single writer plus read-only reviewers for shared critical files.

## 21.6 Recovery coordinator

For a failed operation:
1. classify deterministic/provider/effect/resource/user-decision failure;
2. inspect current owner state;
3. perform cheapest safe healing tier;
4. revalidate source generation/permissions;
5. retry with same identity only when idempotent;
6. otherwise create new Attempt/worker identity;
7. stop at configured exhaustion and surface NeedsYou.

## 21.7 Completion protection

Healing cannot turn a failed criterion into PASS. Verification remains independent and binds final revision.

## 21.8 Quota/cost protection

Do not spend extra model calls merely to keep workers busy. Cache/reuse deterministic work and stop when objective already satisfied.

Provider/model fallback is never inferred from quota pressure; it must be explicitly configured/authorized.

## 21.9 Acceptance

- crash worker and recover without duplicate effect;
- stale worktree lease fenced;
- dirty worktree quarantined;
- max pool respected under many subagents;
- user changes never cleaned;
- UNKNOWN effect prevents blind retry;
- rate-limit recovery does not switch provider;
- repeated failures terminate at bounded policy;
- no healing path changes security/config without authorization.

## 21.10 Resource-aware worker pooling and cross-session conflict detection

One WorkerExecution/Attempt may use a shared, lightweight headless client connection, but one untrusted shell/build/test/REPL/plugin process must still have an enforced OS isolation boundary. Pool warm, compatible workers only when the workspace, user, trust level, environment/secret scope and policy generation match; otherwise start a fresh isolated worker. Pool ownership and leases are authoritative Rust control facts, **not** inferred from a TUI tab or PID reused after exit.

Before admitting more work, sample process-tree memory/CPU/FDs, user-configured per-run/session concurrency, active builds, disk free/build targets and the cost of integration. Reserve an estimated resource budget (mark unknown separately), account actual usage, and use backpressure: queue ready tasks, report resource-blocked tasks, keep existing work alive, and cancel only owned disposable workers after durable fencing and effect settlement. A read-only analysis worker should not allocate a worktree or full independent app runtime.

Maintain a bounded **advisory** file-touch index keyed by canonical path/workspace generation and session/attempt, retaining read/write type, source revision, time, optional line range and TTL. When another worker edits a touched file, emit source-grounded warning/rebase/revalidation; **enforcement** still uses the authoritative workspace lease, exact file digest/revision preconditions and Guard/ExecutionHost. Do not turn a mere read overlap into a false write conflict. Expire/orphan cleanup removes only derived entries; protect user-owned/dirty worktrees, preserve evidence and treat ambiguous stale targets as blocked.

Required negative tests: two competing editors (same file), read-only peers, user edit during a leased Attempt, symlink/rename/alternate case path, stale session epoch, forced process exit, LSP-internal file changes, build output contention, 20 concurrent headless sessions, memory pressure, cancellation/restart/UNKNOWN, lease cleanup and no foreign-process termination. Use §32.32 IDs for release evidence.

## 21.11 Resource-aware scheduling, worker leasing and conflict repair algorithm

**Single scheduling authority:** Rust managed control (Run/Task/Attempt) and Rust resource owner. A TS Core task provider/CLI/worker is a client; never introduce a second writable task scheduler or OwnerLog.

For each Run maintain a DAG `G=(Tasks,dependsOn)` with accepted SpecVersion and exact workspace binding. On every durable task transition compute `ready = {t | t.phase is eligible, all predecessor Tasks are independently PASSED with matching spec/revision, no blocking UNKNOWN effect, no stale parent revision}`. Cycle check on each edge insertion by DFS/topological sort; reject self-edge, missing/out-of-Run dependency, limit overflow and revision mismatch **before** persisting. Store dependencies, verifier links and cancellation fences in the Rust-owned log, not an SDK mutable map.

**Candidate ranking** (not a separate authority): prioritize user-visible unblock + critical path of independently ready DAG; tie-break oldest admitted and bounded fairness; subtract expected model tokens/cost, worker startup, available RAM/CPU/FD, workspace collision and projected integration cost. A rank orders eligible work but cannot create permissions or bypass a blocking criterion. Default concurrency configurable and bounded by §18.18 measured/reserved capacity; unknown per-task resource estimate gets conservative cap rather than zero.

**AcquireResourceLease(expectedTaskVersion):**
1. Read current owner revision+SpecVersion+run pause/cancel state+peer workspace leases+OS capacity.
2. Check task dependencies and outstanding UNKNOWN effects; same Run Task must have at most one active Attempt unless an explicit speculative-read fork uses separate Attempt IDs and cannot emit writes.
3. Reserve capacity **atomically** with workspace/worktree lease and one Attempt admission identity. Advance the sole `ResourceReservation` enum from `PROPOSED` to `RESERVED` (then `CLAIMED` on authenticated launch) under §11.20; do not introduce `ACTIVE` as an alternate state. Durable owner log append wins before any process spawn; idempotent replay returns same reservation, changed request ID returns CONFLICT.
4. Allocate clean compatible warm workspace or make one bounded worktree; bind path canonical root, base revision, OS executable profile and expiry. The worktree's base revision locator and the HostKernel's measured workspace content revision are separate pinned facts: validate and digest each independently, never require their textual values to match or use one as the other's substitute. Do not delete/reuse untracked or dirty worktree.
5. Return opaque reservation/lease and exact allowed resources to worker; launch via §14 ExecutionHost only after Guard. On expiry/stale epoch, reject and recover receipt state before a new worker begins.
6. Advance through `RELEASE_PENDING → RELEASED` and release capacity only after observing actual process-tree exit, artifact/log flush and effect reconciliation. Unlaunched `RESERVED` work may `EXPIRED` after proof of no dispatch; any launched uncertain process/effect becomes `QUARANTINED` and retains its conservative budget until reconciliation, never FREE. Watchdog may notify of lost worker but cannot bypass the settlement proof.

**Worker reuse:** read-only headless task reuses compatible authenticated Core/provider connection without spawning another full TUI or new canonical transcript. For effectful worker pool, identical user, workspace generation, provider/model/harness snapshot, sandbox/network/filesystem profile, secret/env generation, lease-owner epoch and zero active tool calls are required. Reuse also requires successful reset of tool-local state and file descriptors; otherwise terminate **owned** worker and create a new one. Session ID by itself is not a reuse key.

**File conflict manager:** advisory indexed `FileTouch` events should derive from successful read/write observation, Session, Attempt, source digest and workspace file generation. Detect overlapping writes and notify. Enforcement uses current target file descriptor, inode/reparse target identity, exact content digest and workspace fencing at dispatch. If mismatch, deny stale write with typed conflict, provide latest diff/rebase options, retain original Attempt evidence. Two read-only workers can overlap safely; a shell/tool with unknown write set reserves conservative exclusive write scope.

**Cancel/pressure correctness:** an explicit Run pause prevents new admission but does not claim external effects cancelled; cancel fences Run/Attempt/worker, then interrupts the exact owned process group/Job Object, waits bounded settlement, marks UNKNOWN on uncertain target effect and quarantines workspace. OS memory pressure stops *new* admits and sheds disposable caches first. Retry requires known idempotent target or reconciler evidence proving absence, and creates a new Attempt for a genuine new execution. A user editing the same file during a lease invalidates preconditions and may force task replan, never overwrite by “self-heal”.

**Completion algorithm:** each Task independent verifier checks criterion subset and actual repository/source revision; downstream tasks can only unblock after PASS and dependency revision match. Integration applies guarded merge/patch operations under workspace lease, then final revision fingerprint, criterion evidence and independent Run verifier; any source mutation after verification invalidates prior PASS/final acceptance.

**Recovery cases:** stale lease owner, clock shift (use monotonic deadlines within process, durable expiry plus owner epoch on restart), PID reuse, provider timeout after tool execution, duplicate RPC, Git worktree path renamed, disk full after PREPARE, unowned process, task cycle introduced concurrently and verifier race all block/reconcile deterministically. Never release a dirty worktree merely because a Session tab is closed.


### V1 managed-admission constraints (2026-10-19)

V1 admission reserves one `ActiveWorkers` unit per Attempt and enforces both the configured WorkerPool live-worker ceiling and the accepted SpecVersion `maxWorkers`. This is bounded admission/accounting, not an OS-enforced CPU/memory/disk/FD quota. Those measurements support backpressure and monitoring; explicit memory/disk guarantees remain unavailable until an OS backend enforces them. Derive the Attempt deadline from the pinned AgentProfileV2 wall time when present, otherwise the accepted SpecVersion run-duration budget, capped at 24 hours and at the remaining Run duration persisted from authenticated `goal.start`. Expiry never substitutes for the no-dispatch or terminal receipt required to release a reservation.

Select a managed worktree only from P8's durable registrations after the guarded lifecycle has proved it clean, current and bound to the authenticated Goal workspace. The registration's base-revision locator and HostKernel's measured workspace-content digest are independent pins. Do not synthesize a worktree identity from the Goal path or accept one from a caller.

### 21.12 Guarded managed worktree lifecycle and tombstones

Before a Task Attempt exists, lifecycle ownership comes from P8's opaque
`WorktreeRootOwnerV1`, resolved from the authenticated root-coordinator proof for an
explicitly started Run and its SessionLink. This is lineage and lifecycle scope only; it
does not grant a child execution or filesystem effect. P1 independently evaluates Guard,
approval, one-use effect lease, confined ExecutionHost execution, and the settled receipt.
P8 allocates operation/worktree IDs and relative paths, persists an opaque
`WorktreeLifecycleOperationPinV1`, and retains exact replay identity. P1 resolves canonical
argv and filesystem paths only from that pin and trusted Location state.

P1 first obtains a read-only pending-intent projection for Guard descriptor construction.
Only after Guard/approval and the durable one-use lease does it ask P8 to append
`WorktreeOperationDispatchStarted`, immediately before supervisor invocation. A crash or
lost response after that marker is UNKNOWN and cannot be redispatched; an intent without
that marker remains safely pending. Create registration requires exact settled guarded
Create plus a fresh no-follow Inspect proving current, owned, clean state and no user
changes. Historical registrations without that provenance are not admission-eligible.

Release requires current root ownership, no active worker lease, a clean pre-delete
observation, and a guarded post-delete MISSING receipt. P8 atomically removes the live pool
entry and appends a durable tombstone retaining the exact release receipt and OwnerLog
cursor. Tombstoned worktree IDs remain historical and can never be selected or registered
again. A typed removal receipt binds owner, worktree, release operation/receipt, tombstone,
OwnerLog cursor, pool revision and a canonical digest; exact delivery retries return the
same receipt.

If an intent-only Pending operation belongs to an old owner epoch/process, a fresh
authenticated root proof for the same Goal/Run/principal/root Session/Location/workspace/Spec
lineage may retire it as `NotAdmittedNoDispatch/EXPIRED`. P8 records this terminal result in
its OwnerLog and returns the exact cursor-bound retirement receipt. This is allowed only
while the old operation remains Pending with no receipt or dispatch marker; a changed
lineage or any ambiguous state remains unavailable. The exact operation ID and idempotency
key are never revived. The caller must consume the retirement receipt, choose a new key, and
rerun Guard/approval against the current workspace before another operation is prepared.

V1 Task workers are `LogicalCoreSession` executions: each managed Attempt is a distinct
Core child Session/Attempt adapter inside the already-running authenticated Core process.
P8 does not assign a child PID and must not interpret the shared Core PID as a worker exit.
Worker settlement requires an exact current P8 claim and DelegationBinding, P2's typed
terminal Attempt plus complete bound-effect receipt-chain proof, and P1's current proof that
the Attempt has no callbacks, Guard leases, or owned command processes. ActiveWorkers capacity
is released only after those proofs are revalidated and durably recorded. A worktree becomes
reusable only with the final guarded clean/no-user-change observation; missing, dirty, or
uncertain workspace evidence quarantines its worktree. UNKNOWN or incomplete effects retain
the worker reservation until independent terminal/no-effect reconciliation. Future
process-backed workers must use a distinct execution kind and require exact supervised
process-generation exit evidence before release.

P8 exposes this boundary through the crate-private
`WorkerSettlementProofV1::from_host_kernel` and
`WorkerPoolControl::settle_managed_worker` APIs. The proof binds the immutable admission
pins, claim-event nonce/cursor, DelegationBinding digest, P2 terminal snapshot and effect
chain, authenticated Core/root scope, prompt-quiescence marker, HostKernel quiescence
evidence, and optional final workspace observation. P8 appends a dedicated
`worker_managed_logical_settled` event and returns a stable cursor-bound
`WorkerSettlementReceiptV1`; exact proof replay returns that same receipt, while a different
proof for the Attempt conflicts. Legacy process-exit booleans cannot settle a P8 managed
logical child.

After restart or owner-epoch advance, only a still-QUARANTINED, unbound worker may use
`WorkerReconciliationProofV1` and `reconcile_managed_worker`. The proof additionally binds a
fresh current-epoch authenticated owner/root with the same Goal/Run/Attempt principal,
Session and workspace lineage, plus independent terminal/effect and quiescence evidence.
The reconciliation event releases the ActiveWorkers unit without claiming that the shared
Core process exited. It releases the worktree to the Free pool only when the fresh guarded
observation matches P2's final workspace head and proves clean, owned, no-follow state with
no user changes; all other workspace outcomes remain quarantined. Receipt lookup by Attempt
recovers a committed result after a lost response without dispatch or release authority.
