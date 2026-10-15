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
goal_created, spec_proposed, spec_accepted, goal_paused/resumed/completed/cancelled.

Run/task/attempt:
run_started/paused/resumed/cancelling/cancelled/verifying/succeeded/failed/needs_you;
task_proposed/ready/running/verifying/passed/failed/blocked/cancelled;
attempt_admitted/executing/settling/succeeded/failed/unknown/cancelled.

Tool/effect:
tool_batch_validated/admitted/rejected/executing/settling/settled/unknown;
effect_prepared/authorized/leased/observed/settled/failed/unknown;
approval_requested/approved/denied/expired;
lease_claimed/consumed/expired/revoked.

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
