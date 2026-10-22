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
PREPARING -> PLANNED -> RUNNING
RUNNING <-> PAUSED
RUNNING -> VERIFYING -> SUCCEEDED | FAILED | NEEDS_YOU
PREPARING/PLANNED/RUNNING/PAUSED/VERIFYING -> CANCELLING -> CANCELLED
unexpected persistence/execution uncertainty -> RECONCILING -> RUNNING | PAUSED | NEEDS_YOU | FAILED.

Rules:
- PLANNED contains the accepted SpecVersion and complete pinned Task plan; all Tasks are unready and no scheduler/worker dispatch is permitted. Only authenticated goal.start may transition the exact current plan to RUNNING and atomically ready Tasks whose dependencies are satisfied; downstream Tasks become READY after successful predecessor settlement.
- goal.plan and SpecVersion acceptance do not grant effect authority or start execution.
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

CodeMode is an outer interpreter lifecycle, not a second tool/effect lifecycle. One request moves
through `STARTED -> WAVE_PENDING -> WAVE_SETTLED` for each sequential wave, then `COMPLETED`,
`FAILED`, `CANCELLED` or `UNKNOWN`. Each wave is a complete atomic ToolBatch of 1–32 calls;
the entire script is capped at 64 calls and 64 waves. Direct Session waves use DirectTurnJournal.
Managed waves append `attempt_effect_wave_bound` at one OwnerLog revision after approval and
before leases become consumable. A later wave requires settled receipts and refreshed scope.
UNKNOWN stops the interpreter and cannot be retried by helper restart. The private helper frame
sequence is transport correlation, not a new durable event owner.

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
- wall-time limits plus OS-enforced memory/CPU limits where required; do not treat host admission/monitoring as a hard quota;
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

## 11.19 Headless worker and shared attachment lifecycle (A-V2-30)

The source of truth remains Rust `Run → Task → Attempt` and `WorkerExecution` leases; interactive/headless UI mode does not create a second Task state machine. A ready Task may move to resource-blocked/queued without launching a worker; resource pressure does not count as evidence of a task failure or authorize provider change. An admitted Attempt binds its worker identity, owner epoch, trust/sandbox profile, workspace generation and parent capability subset before launching effects. Its resource reservation is an admission/attribution fact; CPU/memory/process-count/FD are hard limits only when the OS backend enforces them. A profile requiring unsupported enforcement is unavailable before spawn (`DEC-V1-27`).

A proposed shared virtual Session attachment transitions `ATTACHING → AUTHENTICATED → ACTIVE → DRAINING/DETACHED`; revocation or host/kernel restart increments the binding epoch and rejects stale subscriptions, ACKs and effect admissions. On crash/cancel, fence first, then settle or retain UNKNOWN according to actual observable execution; do not let a stale child mark PASS. Peer read/edit collision notifications are advisory and do not mutate Task phase. An independent verifier validates evidence against the final integrated revision before terminal Run success.

## 11.20 Detailed resource/attachment/doctor/cache lifecycle and transitions

These are **new target state machines**; implementing them requires atomic expected-revision/epoch checks and the §12.16 machine contracts. Reuse Rust-managed Task/Attempt/Effect states above, not duplicate those aggregates.

| Aggregate or derived object | Accepted transitions | Forbidden transitions/side effects |
|---|---|---|
| VirtualSessionAttachment | ATTACHING → AUTHENTICATED → ACTIVE → DRAINING → DETACHED; ACTIVE → LOST on transport failure; LOST → new AUTHENTICATED generation after peer proof | DETACHED/LOST → ACTIVE with old token, foreign cursor/Session attach, effects while unsupported |
| ResourceReservation (Rust lease fact) | PROPOSED → RESERVED → CLAIMED → RELEASE_PENDING → RELEASED; RESERVED → EXPIRED only after proving no worker launch; CLAIMED/RELEASE_PENDING → QUARANTINED when process or target settlement is uncertain; QUARANTINED → RELEASE_PENDING only after reconciliation and observed owned-process termination | RELEASED/EXPIRED → CLAIMED; claiming EXPIRED after a launch; treating UNKNOWN EffectIntent outcome as a reservation enum; freeing capacity while a descendant/effect remains unsettled |
| ResourcePressure (derived control hint) | NORMAL → SOFT_PRESSURE → HARD_PRESSURE → RECOVERING → NORMAL; allow direct NORMAL → HARD_PRESSURE upon OS quota alarm; recover using hysteresis | memory pressure → model/provider change, canonically deleting user data/receipts or killing unowned processes |
| ProviderDoctorRun | VALIDATED → OFFLINE_RESULT; VALIDATED → AUTHORIZED_NETWORK → CATALOG_RESULT; VALIDATED → AWAITING_SPEND_APPROVAL → AUTHORIZED_FULL → PROBING → COMPLETE/FAILED/UNKNOWN | OFFLINE_RESULT with network request, FULL without spend consent, “COMPLETE” after incomplete provider stream |
| FileTouchRecord | OBSERVED → LIVE → STALE/EXPIRED → REMOVED, derived only | OBSERVED → write permit, return stale entry to another workspace |
| CacheEntry | BUILDING → CURRENT → PINNED or EVICTABLE → EVICTED; CURRENT → STALE; pinned stale entry released only after consumer closes | evict canonical transcript, accepted criteria, receipt, live tool result before safe artifactization |
| ToolTailView | EMPTY → STREAMING → COMMITTED/DROPPED or UNKNOWN, derived UI only | commit as second MessagePart, discard real receipt when tail drops |
| Managed Task/Attempt/WorkerExecution | §11.4–11.5 **remain owner**, with resource queue/lease gates inserted before ADMITTED/STARTING | new “shadow Task” or per-Agent scheduler, speculative conflicting effect without lease |

**Reservation state authority:** The states above are the sole §18.18/§12.16 `WorkerResourceReservationV1.status` vocabulary. `PROPOSED` is unadmitted and reserves nothing. `RESERVED` deducts capacity once from the Rust owner ledger before launch; `CLAIMED` means the authenticated worker startup lease was claimed, not that an external effect succeeded. `RELEASE_PENDING` and `QUARANTINED` continue to count measured usage plus conservative outstanding reserve. `EXPIRED` is terminal only for a reservation with proven absence of worker/process/effect dispatch; timeout after launch instead enters `QUARANTINED` until reconciliation. `RELEASED` requires confirmed owned process-tree termination, effect/receipt settlement, evidence retention and an idempotent log transition. `UNKNOWN` is an EffectIntent/measurement outcome, not a reservation state. Release may be retried after reconciliation but may never bypass quarantine. Resource-pressure values use the exact §18.18 names, without `SOFT`/`HARD` aliases on the wire.

**Crash transition procedure:** persist owner epoch and cancellation/lease fence first; stop new dispatch; inspect actual OS process identity + target evidence; classify completed/failed/UNKNOWN; update Rust OwnerLog once with idempotent delivery; reconcile or block uncertain effect; release/quarantine owned resources; resume queue only after peer scope revalidation. If the daemon crashes before append acknowledgement but the record was committed, idempotent replay returns the same outcome. Wall clock alone never determines owner event order.

**Causal ordering:** spec version acceptance precedes Run admission; predecessor trusted PASS precedes dependent READY; reserve workspace/resource and prepare effect precede child launch; Guard approval precedes single-use lease claim; process exit does not imply effect settlement; all effect receipts and final integrated revision evidence precede Run SUCCEEDED. GUI animation, resource graph and file-touch warning are non-durable derived projections and cannot satisfy causal prerequisites.

**Concurrent races to test:** cancel vs lease claim, attachment logout vs ACK, duplicate resource request with different args, expiration vs process still running, source edit vs verification, cache eviction vs pinned active reader, Provider Doctor consent revocation vs upstream billing, worker unknown vs a new Attempt, two clients racing to attach same Session, kernel incarnation change while old worker returns. The expected result for uncertain external mutation is UNKNOWN, never silent retry/success.
### V1 managed DAG release boundary (DEC-V1-31)

The single coding Task/Attempt journey is the required first managed vertical. After it
passes integrated P2 acceptance, V1 also requires bounded multi-Task DAG execution and
aggregate Run settlement. The DAG shares the existing Run/Task/Attempt states: it adds no
parallel lifecycle owner. Each Task independently reaches a verifier-backed terminal
state; dependency readiness is computed from trusted PASS only. Run success is impossible
while any required Task is nonterminal, failed, cancelled, UNKNOWN, or lacks settled
effects and exact-revision verification. Current Rust reducer and Core admission may keep
multi-Task plans unavailable until all transition, replay, conflict, cancellation and
recovery cases pass. See VEO-025 and DEC-V1-31.

