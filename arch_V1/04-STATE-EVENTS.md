# 4. State, events, persistence and recovery

Status: normative current V1 event ownership.

## 4.1 Source streams

OpenCode event/session stores are canonical for:
- Session/Input/Message/Part;
- provider turn/continuation;
- conversational tool-call/result parts.

Rust OwnerLog is canonical only for:
- Goal/SpecVersion/Run/Task/Attempt;
- ToolBatchControl;
- EffectIntent/lease/receipt;
- resource/worktree leases;
- Evidence/Verification;
- automation control;
- other explicitly Rust-owned records.

Derived UI/index/analytics queues are rebuildable and non-authoritative.

## 4.2 Durable event envelope

**Implemented OwnerLogV2 physical record** (source: `kernel/src/owner_log.rs`, `PhysicalRecordV2`): `format_version: 2`, `seq`, `time_ms`, `kind`, `data`, `previous_digest`, `event_digest`. The committed **owner head**, rather than each physical record, binds owner kind/ID, owner generation, durability profile and committed cursor/digest. The versioned `data` object contains `schemaVersion: 1`, `payload`, and paired optional `deliveryId` / `commandDigest`. Existing committed digests are BLAKE3-derived. Source/event binding, owner epoch, aggregate revision and correlation are **logical/integration requirements** and are not free-standing columns on `PhysicalRecordV2`. The physical schema must not be guessed from this list.

**Not an implemented wire schema:** `arch_V1/contracts-v2/managed-event.schema.json` remains a **DESIGN-ONLY legacy logical-envelope prototype**. Its PascalCase `eventType` values and `schemaVersion: 2` cannot encode the real Rust snake_case `kind` + versioned `data` format. Neither this file nor `control-api.openapi.json` may be used for runtime code generation until the exact OwnerLog adapter/migration and cross-language fixtures are accepted. The existing code enforces record integrity, sequence/cursor and idempotent committed delivery at its own boundary; public managed APIs still need reviewed schemas/handlers.

For future managed event APIs require event ID/type/version, aggregate type/ID/revision, owner epoch, idempotency/correlation, payload, source digests and observation time **as logical projections**, with verified mapping to persisted records. Only emit a public projection after source-bound authorization and version negotiation.

## 4.3 Managed event families

**Design inventory below, not a statement that every event is implemented.** The current `ManagedCommand::event` / `decode` path in `kernel/src/managed_control.rs` implements a limited snake_case command/event subset. Full worker, effect, approval, automation and verifier events need their respective owner registration and tests; do not assume the event names below are accepted by the active Rust decoder.

Goal/spec:
goal_created, spec_proposed, spec_accepted, goal_paused/resumed/completed/cancelled. `spec_proposed`/`spec_accepted` bind the immutable `capabilityScope` and spec digest; reviewer projection exposes the exact canonical IDs.

Run/task/attempt:
run_started/paused/resumed/cancelling/cancelled/verifying/succeeded/failed/needs_you;
task_proposed/ready/running/verifying/passed/failed/blocked/cancelled. `task_proposed` carries `requiredCapabilities`, validated as a subset of the accepted SpecVersion scope before append, and an immutable `agentProfileRevision` selected before dispatch. Authenticated Core ingress supplies its strict canonical digest-free profile definition; HostKernel computes and persists the digest. Attempt admission must resolve the exact Task-pinned profile ID/revision/digest; request-supplied profile changes or digests are rejected before OwnerLog mutation.
attempt_admitted/executing/settling/succeeded/failed/unknown/cancelled.

For the accepted `goal.start` flow, the Rust `planned_run_started` event's physical OwnerLog
envelope `time_ms` is the trusted `Run.startedAtMs` projection. It is minted on first commit and
reconstructed from the same envelope on replay; no RPC field supplies or extends it. Admission
computes remaining Run duration from that value and the accepted SpecVersion budget. A legacy Run
without this timestamp cannot authorize a duration-bounded managed child lease.

Tool/effect:
tool_batch_validated/admitted/rejected/executing/settling/settled/unknown;
effect_prepared/authorized/leased/observed/settled/failed/unknown;
approval_requested/approved/denied/expired;
lease_claimed/consumed/expired/revoked.

**Source note (2026-10-19):** `ManagedCommand::BindAttemptEffects` now encodes the Rust
OwnerLog event `attempt_effects_bound`: one revision appends the complete bounded, unique set
of effect edges for one live Attempt and records the common edge-local `boundRevision`. This is
CODE_PRESENT source in the reducer, not evidence that HostKernel dispatch/lease ordering is
WIRED or accepted. The effect edges must be bound before lease issuance; a refreshed
HostKernel-issued scope is required after every managed-owner mutation.

Evidence:
evidence_collected/accepted/rejected/stale;
verification_started/passed/failed/needs_you.

Resource:
resource_acquired/released/quarantined;
checkpoint_created/restore_requested/restored/rejected.

Automation:
automation_created/updated/enabled/disabled;
occurrence_scheduled/claimed/completed/failed/skipped.

## 4.4 Session observation events

Rust may persist bounded correlation/projection metadata:
- source Session ID/store/epoch;
- source cursor;
- last completed ACK/page;
- source event type/version/foreign ID/digest;
- redacted projection fields needed by managed control.

It does not persist canonical prompt/answer/Message/Part content as a Rust conversation stream.

## 4.5 Ephemeral events

Examples:
- token/text/thinking deltas;
- tool progress;
- UI typing/hover/selection;
- render frames;
- model loading progress;
- transient browser/desktop observations;
- diagnostics progress;
- analytics samples.

Ephemeral delivery can be coalesced/dropped according to UI policy. Durable owner transitions/receipts cannot.

## 4.6 Outbox and multi-store consistency

Do not pretend to have a distributed transaction across OpenCode, Rust and external targets.

Use:
- source foreign IDs/digests;
- durable PREPARED intent before effect;
- idempotency/operation refs;
- receipts;
- reconciliation.

A conversational tool result can reference a Rust receipt; neither store impersonates the other.

## 4.7 Restart/replay

Recovery sequence:
1. open and validate each canonical store;
2. acquire owner epoch;
3. rebuild derived projections;
4. restore Session observer from last completed ACK;
5. identify PREPARED/EXECUTING unsettled effects;
6. inspect target/idempotency when possible;
7. settle or mark UNKNOWN/NEEDS_YOU;
8. restore valid resource leases or quarantine;
9. resume only safe scheduled/managed work.

## 4.8 Cancellation

Cancellation persists a fence against new admissions first.

Already-started effects:
- if cancellable, request cancellation then observe;
- if not cancellable, wait/reconcile;
- never erase evidence because parent is cancelled.

## 4.9 Retention

Canonical retention/deletion follows 18/privacy decisions. UI queues and derived indexes may use shorter bounded retention.

Artifact/sample/log retention records fidelity and source, never silently truncates while claiming FULL.

## 4.10 Analytics

Analytics consumes owner events/observations. It never changes Run/effect truth.

Metrics record provenance: measured, estimated or unknown.

## 4.11 Required recovery tests

- torn/partial durable append;
- schema/version rejection;
- stale owner epoch;
- duplicate idempotency;
- Session cursor retention gap;
- crash after PREPARE before target effect;
- target executed but receipt lost;
- worker/host/kernel restart;
- UI reconnect;
- derived index rebuild;
- cancellation race.

Any event family that would recreate a Rust canonical conversational Thread is invalid under 17.

## 4.12 Resource observations and shared-kernel restart semantics (A-V2-30)

Resource samples, render queue deltas, file-touch warnings and Provider Doctor progress are bounded projections/events; they may be coalesced/dropped under backpressure and must not be replayed as canonical write/evidence history. In contrast, policy revision, virtual Session attachment/owner epoch, WorkerExecution/Attempt lease, cancellation generation, effect PREPARED/UNKNOWN/SETTLED and independent Verification remain fenced/durable in their established owners. A task cannot become PASS from a paint/event-counters stream.

A shared-kernel crash fences all old host/kernel attachment epochs and active leases before reconnect; each backend-owned Session observes from an authenticated source cursor and the Rust owner log replays managed/effect state. Any effect that may have reached its target before disconnect is UNKNOWN until reconciled; never issue a fresh idempotency key and repeat a non-idempotent operation merely because no response was received. Reader and worker faults should be isolated where their process boundary permits. Resource attribution is rebuilt from owner process generations and leases, not stale PIDs.

## 4.13 Delegation, RepoIntel and evidence projections (A-V2-33)

These are logical projections over existing owners, not new OwnerLog kinds or an independent event bus:

| Projection family | Canonical owner | Replay rule | Minimum binding |
|---|---|---|---|
| Spec/reviewer decision | Rust managed control | Durable cursor; reject stale SpecVersion/review assignment | Goal, SpecVersion digest/revision, authenticated reviewer ref |
| Task/Attempt/child lifecycle | Rust managed control | Durable owner sequence and epoch; reconcile after gap/restart | `lane=managed_attempt`, Run, Task, Attempt, accepted spec, profile/capability ceiling, workspace/source revision |
| Effect/evidence settlement | Guard/effect and verification owners | Durable receipt/evidence refs; UNKNOWN remains unresolved until reconciliation | EffectIntent, one-use lease, receipt, artifact digest/fidelity, current revision |
| RepoIntel query result | RepoIntel derived owner | Re-query on stale generation; never replay as mutation authority | workspace, source generation/revision, query digest, coverage and fallback reason |
| Child/UI progress | Core/UiEventMux projection | Ephemeral, bounded, redacted and coalescible | required lane tag; direct binds Core parent/child Session and profile scope, managed binds Rust Task/Attempt; source cursor/generation |
| Provider/resource observations | provider/analytics/resource owners | Preserve provenance/freshness; never alter workflow truth | selected provider/model or resource owner, measured/estimated/unknown quality |

Progress may be summarized after reconnect; durable decisions, receipts, artifacts and verification are re-read from canonical owners. A UI event or compact child summary cannot create PASS. For §12.19 verifier lifecycle, projections may label `verifier_effect_prepared`, `verifier_effect_settled`, `verification_evidence_recorded` and `verification_unknown`; each must point to the existing Attempt, EffectIntent/receipt and Evidence owner records, and UNKNOWN remains unresolved. These labels are projections, not new OwnerLog kinds. Concrete event payload schemas remain owned by §12 and the Rust/TypeScript contract pipeline.

Pre-admission candidate abandonment is a canonical ManagedControl OwnerLog transition, because
the P8 reservation log cannot atomically append to the managed task owner. Its idempotent event
records the exact Task revision, admitted attempt count/generation, old candidate Attempt and pins, P8 tombstone receipt
cursor/event digest, HostKernel epoch/incarnation and delivery ID. Replay either returns the
same generation-advance receipt or conflicts; it never revives the tombstoned reservation.

The projection consumes the canonical owner's existing event stream and cursor. It does not add a second bus or make UI progress durable. A client-visible timeline may project the following semantic changes from those owner records: `review_decided`, `attempt_admitted`, `child_dispatched`, `effect_receipt_settled`, `evidence_attached`, `verification_completed`, `repo_generation_changed`, and `resource_observed`. These names are projection labels, not new OwnerLog kinds or authorization inputs. Durable rows retain owner sequence/epoch and source cursor; replay re-reads owner records after the last acknowledged cursor, emits a gap/resnapshot response when retention is exceeded, and fences events from a replaced owner generation. Ephemeral progress includes correlation and source-generation metadata, is redacted and bounded, and may coalesce without advancing the durable cursor. Unknown receipt or verification outcomes remain explicitly unresolved in every projection.

## 4.14 Web-search route attempt projections (V1, `DEC-V1-26`)

Search progress is a bounded Core/UiEventMux projection of the active broker request; it is
not durable effect evidence and does not form a new event bus. Each route attempt projection
binds request correlation, route ID, configured order index, attempt number, status class,
HTTP status when known, latency observation, bounded retry-after and route auth/cost class.
Never project query text by default, SecretRef/lease identifiers, headers, response bodies or
credential data. Per-route auth 401/403/407 failures remain visible and can advance only to
the next route in the captured explicitly enabled/configured cascade; other non-rate-limit
4xx terminates with a surfaced reason. Replay after a gap re-reads the current request
snapshot or returns a typed unavailable result; it never re-dispatches a search request.
