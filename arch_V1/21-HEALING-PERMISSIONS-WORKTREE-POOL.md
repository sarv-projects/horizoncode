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
