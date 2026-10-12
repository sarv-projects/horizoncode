# 11. Canonical lifecycle and transition contracts

Status: normative current-only state machines. Historical Rust Thread/Turn/ProviderAttempt lifecycle is archived and is not part of V1 authority.

## 11.1 Transition protocol

Every Rust-owned aggregate transition carries:
- stable aggregate ID and aggregate type;
- expected version/revision;
- owner/process epoch where relevant;
- idempotency/correlation key;
- actor/origin and authorized scope;
- timestamp for observation only, never ordering authority;
- reason/error code on non-success paths.

Version mismatch, unknown state, unknown effect class or stale epoch fails closed.

Direct HorizonCode Session/message continuation stays inside the owning OpenCode-derived Core. Provider-specific continuation state stays behind the selected provider transport seam; Rust may observe bounded source IDs/cursors but does not re-own either lifecycle.

## 11.2 Goal and SpecVersion

Goal:
DRAFT -> REVIEWABLE -> ACTIVE -> PAUSED -> COMPLETED
with terminal alternatives CANCELLED or ARCHIVED.

Rules:
- DRAFT/REVIEWABLE makes no tool effect.
- ACTIVE requires an accepted immutable SpecVersion.
- changing objective/scope/criteria creates a new SpecVersion.
- an active Run remains pinned to its accepted SpecVersion until explicitly superseded/cancelled.

SpecVersion:
PROPOSED -> ACCEPTED or REJECTED.
ACCEPTED is immutable.

## 11.3 Run

Run:
PREPARING -> RUNNING
RUNNING <-> PAUSED
RUNNING -> VERIFYING -> SUCCEEDED | FAILED | NEEDS_YOU
PREPARING/RUNNING/PAUSED/VERIFYING -> CANCELLING -> CANCELLED
unexpected persistence/execution uncertainty -> RECONCILING -> RUNNING | PAUSED | NEEDS_YOU | FAILED.

Rules:
- Session idle/closed does not finish a Run.
- worker/process exit does not finish a Run.
- SUCCEEDED requires current verifier evidence against final integrated revision.
- cancellation fences new work immediately; already admitted effects settle/reconcile separately.

## 11.4 Task and Attempt

Task:
PROPOSED -> READY -> RUNNING -> VERIFYING -> PASSED | FAILED | BLOCKED | CANCELLED.

Attempt:
QUEUED -> ADMITTED -> EXECUTING -> SETTLING -> SUCCEEDED | FAILED | UNKNOWN | CANCELLED.

Rules:
- only dependency-satisfied Tasks become READY;
- a worker result is evidence, never Task PASS;
- UNKNOWN effect/execution state blocks automatic non-idempotent retry;
- retry creates a new Attempt identity and preserves earlier evidence/receipts;
- exhausted attempts produce FAILED or NEEDS_YOU according to policy, never infinite retry.

## 11.5 WorkerExecution and delegation

WorkerExecution:
RESERVED -> STARTING -> READY -> BUSY -> IDLE -> RELEASED
with FAILED, LOST, QUARANTINED and CANCELLED paths.

Child delegation:
PREPARED -> STARTING -> RUNNING -> RETURNED | FAILED | CANCELLED | UNKNOWN.

Rules:
- child context/capabilities are an explicit subset/grant;
- child cannot authorize parent effects;
- worktree/resource leases are independent from model/session identity;
- dirty/unsettled workspace is quarantined, not force-deleted.

## 11.6 ToolBatchControl

ToolBatchControl is Rust control metadata tied to one complete provider response for the owning Session. It is not a message transcript.

States:
COLLECTING -> VALIDATED -> ADMITTED -> EXECUTING -> SETTLING -> SETTLED
or REJECTED, CANCELLED, UNKNOWN_RECONCILIATION.

Rules:
- no effectful member executes before the complete batch validates and is admitted;
- each call references the owning backend's mapped Session/message/call IDs and immutable argument/schema digests;
- conversational tool result Part remains OpenCode-owned;
- Rust records only authorization/control/result-correlation facts;
- UNKNOWN cannot be converted to success by model text.

## 11.7 EffectIntent, approval, lease and receipt

EffectIntent:
PROPOSED -> PREPARED -> AUTHORIZED -> LEASED -> EXECUTING -> OBSERVED -> SETTLED.

Alternative states:
DENIED, EXPIRED, CANCELLED, FAILED, UNKNOWN.

Approval:
PENDING -> APPROVED | DENIED | EXPIRED | SUPERSEDED.

One-use lease:
ISSUED -> CLAIMED -> CONSUMED
or EXPIRED/REVOKED.

Rules:
- PREPARED intent binds canonical target, args digest, workspace/source revision, policy epoch and budget;
- lease cannot be reused or widened;
- target observation and settlement are distinct;
- exactly-once is claimed only when the real target provides compatible idempotency.

## 11.8 Evidence and verification

Evidence:
COLLECTED -> VALIDATED -> ACCEPTED | REJECTED | STALE.

Verification:
PENDING -> RUNNING -> PASS | FAIL | NEEDS_YOU.

Evidence binds:
- criterion/spec version;
- final source/repository revision;
- producer/tool/test identity;
- relevant logs/artifacts/receipts;
- freshness/source digest.

A stale result never proves completion.

## 11.9 Context and RepoIntel lifecycle

ContextView:
CURRENT -> REBUILDING -> CURRENT; old generations become STALE.

Context operations:
- trim: deterministic removal from model-visible packet;
- prune: propose/remove low-value references from the active view;
- compact: create a bounded summary/reference while preserving source history;
- clear: clear active view only unless a separate explicit deletion action is invoked.

RepoIndexGeneration:
BUILDING -> READY -> STALE | FAILED.
Only READY generations answer authoritative indexed queries; results report source/generation/confidence.

## 11.10 LanguageServiceBroker

Language service instance:
DISCOVERED -> STARTING -> READY -> DEGRADED -> RESTARTING -> READY
or STOPPED/FAILED.

Editor-owned instances are observed, not restarted by model queries. Horizon-supervised process mutations are effects.

Every diagnostic/symbol/code-action snapshot includes workspace, document version and service generation. Stale mutation edits are rejected.

## 11.11 DebugAdapterBroker

Debug session:
CREATED -> STARTING -> STOPPED_AT_BREAKPOINT | RUNNING
RUNNING <-> STOPPED_AT_BREAKPOINT
-> TERMINATING -> TERMINATED
with FAILED/LOST.

Attach, process launch, breakpoint mutation, continue/step and evaluate follow capability/effect policy. Variable/stack reads are scoped read-only observations. Debugger Eval is never an unrestricted host escape.

## 11.12 Persistent REPL

REPL worker:
CREATED -> STARTING -> READY -> BUSY -> READY
-> STOPPING -> STOPPED
with FAILED/EXPIRED/QUARANTINED.

A REPL has:
- language/runtime version;
- workspace and environment scope;
- memory/CPU/wall-time limits;
- explicit network/filesystem profile;
- generation/epoch;
- mediated callback capability set.

Tool callbacks re-enter the canonical action/Guard path; the REPL does not inherit ambient authority.

## 11.13 Browser and desktop

Browser tab observation generation:
CREATED -> READY -> OBSERVED(generation N) -> MUTATED -> OBSERVED(generation N+1)
with DETACHED/FAILED.

Desktop observation generation:
CAPTURED(generation N) -> action admitted -> action executed -> CAPTURED(generation N+1).

Any DOM/AX/window reference is valid only for its observation generation and owner. Stale action refs are denied/re-observed.

## 11.14 Web search

Search request:
VALIDATED -> ROUTED -> RUNNING -> COMPLETE | FAILED | CANCELLED.

A fallback route requires explicit policy and cannot change billing/auth class silently. Results include provider/source provenance and retrieval time; grounded-model search is distinct from direct search.

## 11.15 Automation

Automation definition:
DRAFT -> ENABLED <-> DISABLED -> DELETED.

Run occurrence:
SCHEDULED -> CLAIMED -> RUNNING -> SUCCEEDED | FAILED | SKIPPED | NEEDS_YOU.

Overlap/missed/retry behavior is deterministic and versioned. Scheduled execution never bypasses target action authorization.

## 11.16 Artifact/render lifecycle

Source artifact:
STAGED -> PERSISTED_FULL | PERSISTED_SAMPLE | FAILED.

Figure render:
OPEN -> RENDERING -> READY
with source revision/theme/geometry generations; FAILED falls back to source.

A terminal image placement is ephemeral UI state, not durable artifact identity.

## 11.17 Completion and stop law

Managed success requires all:
- accepted current SpecVersion;
- no required Task blocked/failed/pending;
- all admitted effects settled or explicitly reconciled;
- final revision known;
- every acceptance criterion has fresh accepted evidence;
- verifier says PASS.

Stop/pause when:
- user requests it;
- permission/secret/payment/platform decision is required;
- budget exhausted;
- repeated failures exceed bounded policy;
- effect outcome is UNKNOWN and unsafe to retry;
- objective is already satisfied.

## 11.18 Required transition tests

For each state machine:
- valid transition;
- invalid prior state;
- stale expected version;
- duplicate idempotency key;
- crash between durable prepare and execution;
- cancellation race;
- restart/replay;
- unknown enum/version;
- actor/scope denial.

No lifecycle implementation may invent a second conversational Session owner.
