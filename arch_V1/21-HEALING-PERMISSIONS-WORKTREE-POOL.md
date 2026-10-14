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
4. Allocate clean compatible warm workspace or make one bounded worktree; bind path canonical root, base revision, OS executable profile and expiry. Do not delete/reuse untracked or dirty worktree.
5. Return opaque reservation/lease and exact allowed resources to worker; launch via §14 ExecutionHost only after Guard. On expiry/stale epoch, reject and recover receipt state before a new worker begins.
6. Advance through `RELEASE_PENDING → RELEASED` and release capacity only after observing actual process-tree exit, artifact/log flush and effect reconciliation. Unlaunched `RESERVED` work may `EXPIRED` after proof of no dispatch; any launched uncertain process/effect becomes `QUARANTINED` and retains its conservative budget until reconciliation, never FREE. Watchdog may notify of lost worker but cannot bypass the settlement proof.

**Worker reuse:** read-only headless task reuses compatible authenticated Core/provider connection without spawning another full TUI or new canonical transcript. For effectful worker pool, identical user, workspace generation, provider/model/harness snapshot, sandbox/network/filesystem profile, secret/env generation, lease-owner epoch and zero active tool calls are required. Reuse also requires successful reset of tool-local state and file descriptors; otherwise terminate **owned** worker and create a new one. Session ID by itself is not a reuse key.

**File conflict manager:** advisory indexed `FileTouch` events should derive from successful read/write observation, Session, Attempt, source digest and workspace file generation. Detect overlapping writes and notify. Enforcement uses current target file descriptor, inode/reparse target identity, exact content digest and workspace fencing at dispatch. If mismatch, deny stale write with typed conflict, provide latest diff/rebase options, retain original Attempt evidence. Two read-only workers can overlap safely; a shell/tool with unknown write set reserves conservative exclusive write scope.

**Cancel/pressure correctness:** an explicit Run pause prevents new admission but does not claim external effects cancelled; cancel fences Run/Attempt/worker, then interrupts the exact owned process group/Job Object, waits bounded settlement, marks UNKNOWN on uncertain target effect and quarantines workspace. OS memory pressure stops *new* admits and sheds disposable caches first. Retry requires known idempotent target or reconciler evidence proving absence, and creates a new Attempt for a genuine new execution. A user editing the same file during a lease invalidates preconditions and may force task replan, never overwrite by “self-heal”.

**Completion algorithm:** each Task independent verifier checks criterion subset and actual repository/source revision; downstream tasks can only unblock after PASS and dependency revision match. Integration applies guarded merge/patch operations under workspace lease, then final revision fingerprint, criterion evidence and independent Run verifier; any source mutation after verification invalidates prior PASS/final acceptance.

**Recovery cases:** stale lease owner, clock shift (use monotonic deadlines within process, durable expiry plus owner epoch on restart), PID reuse, provider timeout after tool execution, duplicate RPC, Git worktree path renamed, disk full after PREPARE, unowned process, task cycle introduced concurrently and verifier race all block/reconcile deterministically. Never release a dirty worktree merely because a Session tab is closed.
