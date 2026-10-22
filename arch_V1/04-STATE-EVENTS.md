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

**Normative V1 wave event (DEC-V1-30):** new managed ToolBatch waves append
`attempt_effect_wave_bound` after approval and before any one-use lease is consumable. The
versioned payload binds live Run/Task/Attempt, HostKernel batch ID, wave index, registered
Session/Location, authenticated source-scope digest and ordered 1–32 edges
`{callIndex,callId,effectId,capabilityId,argumentsDigest,intentDigest}`. The owner recomputes
the domain-separated wave digest. `argumentsDigest` covers canonical tool arguments;
`intentDigest` covers the complete immutable EffectIntent and must equal the Guard-retained
intent digest. No arguments, secrets or caller-supplied identity are stored. All edges bind at
one OwnerLog revision; HostKernel refreshes the Attempt scope and revalidates it before minting
per-effect leases. Exact retries return the original append result; changed retries conflict.
The legacy `attempt_effects_bound` remains replay-compatible but cannot authorize a new guarded
wave. Direct Sessions continue to use DirectTurnJournal.

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
- request-bound `session.context_ledger` projection emitted after provider parameter normalization and before send;
- tool progress;
- UI typing/hover/selection;
- render frames;
- model loading progress;
- transient browser/desktop observations;
- diagnostics progress;
- analytics samples.

Ephemeral delivery can be coalesced/dropped according to UI policy. Durable owner transitions/receipts cannot.
`session.context_ledger` carries the strict `ContextLedgerV2` plus its digest and is keyed by the exact Session request ID and source generation. It contains only bounded model-visible provenance, never raw provider parameters, prompt text, credentials or authority. It is derived in memory for the current request, is not a second transcript or ledger store, and may be dropped. The live TUI can show the most recent request ledger; a reconnect may restore it only from the active request's bounded projection, otherwise it reports the context view unavailable until a new request produces one. A missing ledger event never changes dispatch, permissions, or durable owner state.

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
credential data. After first-use search consent, the captured route plan starts with the
default-enabled free anonymous built-in cascade; BYO authenticated routes must be explicitly
enabled/configured by the user, and grounded-model search is separate and explicit-only.
Per-route auth 401/403/407 failures remain visible and can advance only to the next such enabled route;
other non-rate-limit
4xx terminates with a surfaced reason. Replay after a gap re-reads the current request
snapshot or returns a typed unavailable result; it never re-dispatches a search request.

The route plan is trusted broker/config state pinned before dispatch, never a provider or route
selection supplied by model arguments. Each route attempt projection reports its own provenance
and bounded error class; it omits raw query text and credentials.

## 4.15 Managed provider request dispatch lifecycle (V1, 2026-10-21)

ContextSelection admission/advance pins request provenance but is not permission to send a
provider request. ManagedControl retains each request through `managed_provider_request_prepared`,
`managed_provider_request_dispatching`, and exactly one terminal
`managed_provider_request_settled` or `managed_provider_request_unknown` event. Each event is
bound to the live Attempt, owner epoch, child Session, request ID/sequence, ContextSelection
digest, selected provider/model/harness/route revision, and BLAKE3 of the exact normalized
provider input. The immutable route projection also retains route ID and opaque
credential-lease, consent, Guard-challenge and capability-lease references; it never stores
credential bytes, arbitrary URLs or headers. Prepare replay must match all pins and grants no
send authority. Begin is
one-use and persists DISPATCHING before network I/O; only its fresh response carries the opaque
send authorization. Settlement follows durable child assistant-entry commit and binds its ID,
response digest and bounded usage provenance. A restart or ambiguous response while
DISPATCHING becomes UNKNOWN and is never resent automatically.

Current HostKernel RPC decoders validate these operation envelopes, but route resolution and
the Guarded ExecutionHost provider transport are not yet available. All four operations
therefore return `UNAVAILABLE` without appending provider lifecycle events; begin returns a
null send authorization. The reducer/event contracts are not evidence that a provider request
was sent.

## 4.16 Direct-session grant and CodeMode projections (V1)

The selected `DirectSessionPermissionModeV1` is projected from authenticated
HostKernel state to Core/TUI with source generation and monotonic sequence. It
contains sandbox mode, approval policy, effective source, revision and digest;
it contains no caller-supplied principal or credential. Attach/reconnect obtains
a fresh snapshot. A mode change advances the revision and fences any pending
prepared effect whose policy digest was resolved under the previous mode.
The projection is UI/config state, not a lease or dispatch authorization. Its
schema is `contracts-v2/direct-session-permission-mode-v1.schema.json`.

Grant creation and revocation are persisted by the canonical Rust Guard authority and
projected to Core/TUI as `DirectSessionGrantChangedV1` with event ID, source generation,
monotonic sequence, opaque grant ID/digest, bounded scope summary, expiry and active/revoked/
stale status. Invalidation can be projected with a bounded reason code. The projection contains
no caller-selected principal or credential. It is refreshed from the owner on attach,
reconnect and every effect admission; a stale UI projection cannot authorize. Revocation,
expiry, Session replacement, principal/epoch change, workspace-root change, policy-digest/backend
or guarantee change fences later dispatch before a lease is issued. An approval
event names the exact normalized action/resource or complete ToolBatch that crossed scope.

Direct `codemode.execute` enablement is the distinct Guard-owned `CodeModeEnablementV1` record in
`contracts-v2/codemode-enablement-v1.schema.json`, bound to authenticated principal, Session and
owner epoch, fixed selector and resolved helper digest, exact resource-profile ID/digest,
backend/guarantee and policy digests, expiry and revocation generation. It is not a
DirectSessionGrant and cannot authorize nested tools. Core/TUI may project the canonical
enablement's opaque identity/digest, Session/source generation, expiry and active/revoked/stale
state; this is derived UI state, not a new OwnerLog kind, event bus or authorization input.
Managed exposure is projected from accepted SpecVersion and Task-pinned AgentProfileV2 authority
plus the live Attempt, never from a direct enablement. Both are refreshed from canonical owner
state on attach/reconnect and checked before every helper launch. Session replacement/close,
revocation, or selector/profile/backend drift fences the next direct launch. The helper launch still
settles through its normal EffectIntent/lease/receipt; nested effects retain their own ToolBatch,
DirectSessionGrant/approval, lease and receipt records.

CodeMode `execute` streams redacted call lifecycle and bounded output under the outer direct
turn or managed Attempt correlation. Each nested effect's PREPARED, approval, DISPATCHING,
SETTLED or UNKNOWN facts remain the canonical ToolBatch/effect records; UI activity is derived
and carries owner/source generation and sequence fences. After reconnect, Core resnapshots
the outer call and exact nested receipts; a gap never causes script or effect replay. One shared 64-call/30-second/64-KiB source/output/1-MiB argument budget is represented by the
authenticated outer execution and cannot reset at a wave boundary. The stdio helper protocol itself
is private and non-authoritative; every call event correlates to the Core-owned ToolBatch and its
Rust receipt. Helper exit or a terminal frame cannot stand in for effect settlement. Schema authority is §12.21 and service/flow
authority is §§3.23/37.24.

Direct artifact availability is projected from the Core Session tool-call/result part and the
single canonical ArtifactStore record. The strict lane variants are defined by
`contracts-v2/source-artifact-v1.schema.json`; direct requires `sessionId`, `producerRequestId`,
`producerToolCallId`, `effectId` and settled `effectReceiptRef`, while managed requires `attemptId`
and `evidenceRefs` and forbids direct-lane fields. The immutable `SourceArtifactV1` ref carries `lane: "direct"`
and binds the authenticated Session, producer request/tool-call IDs, effect ID and settled effect
receipt. Search/range notifications are derived and may be coalesced; they never create artifact
ownership or durable evidence. Reconnect rereads the exact Session result and reauthorizes the ref
against ArtifactStore; if its receipt, generation, digest or retention record cannot be resolved,
the UI reports unavailable/stale/failed rather than retrying the producer effect. Managed artifact
and evidence references remain Rust-owner projections; a direct ref is never promoted or attached
as managed evidence, and managed refs never widen direct Session scope. There is no new Artifact OwnerLog event,
and direct artifacts never imply managed verification or PASS.
### Direct grants and immutable command-profile events

Direct grant issuance/revocation lives in the existing Guard/EffectHost append-only
authority journal. Each issued grant digest includes the exact
`WorkspaceCommandProfileV1` refs `{profileId, revision, profileDigest, action}` for
build/test scope. Profile edits are new immutable Core Config revisions; they do not
rewrite an issued grant. A dispatch resolves and compares the live profile, binary
identity, workspace root, policy and backend guarantee set before creating the ordinary
EffectIntent/lease. Revocation is monotonic and checked before every dispatch. The
journal event projections remain metadata-only; they contain no command body, argv,
environment values, credential, output or secret.

### Managed DAG events (DEC-V1-31)

Managed DAG events use the existing Run/Task/Attempt OwnerLog and one authoritative graph
revision. A graph proposal is validated for cycle, bounds, capability/profile ceilings,
workspace and write conflicts before commit. Task readiness and terminal outcomes are
derived from durable per-Task verifier/receipt events. Run aggregate success is derived
only when all required Tasks pass at their exact current workspace revisions, all effect
receipts settle, and no cancellation or UNKNOWN remains. Parent/child Core Session events
are projections and do not replace Rust Task transitions. This describes final V1 target;
multi-Task dispatch stays gated pending implementation and acceptance.

## 4.17 External editor lifecycle projection (V1, DEC-V1-33)

External editor UI activity is a derived Session projection over canonical Guard/EffectHost
intent, HostKernel process state, execution receipt and resulting `files.patch`; it is not
a second process/event authority. `ExternalEditorChangedV1` contains only event/source
generation, sequence, Session ID, opaque launch ID, target kind, bounded target label,
profile ID/revision/digest, lifecycle status (`starting`, `running`, `completed`,
`cancelled`, `conflict`, `unavailable`, `unknown`), and optional typed reason. It never
contains prompt text, file contents, executable path, argv, environment, or raw principal.
Reconnect obtains fresh process status and current file revision; a stream gap cannot
relaunch the editor. Successful workspace edit emits ordinary file-change/patch events
after Guard settlement. UNKNOWN remains reconciliation-only.

