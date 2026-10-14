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
