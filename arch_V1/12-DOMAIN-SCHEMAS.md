# 12. Canonical schema registry and ownership

Status: normative schema ownership. This chapter intentionally does not duplicate OpenCode conversational schemas.

## 12.1 Schema law

- HorizonCode direct Session/Input/Message/Part types remain derived from the pinned OpenCode schema; provider-specific continuation stays behind the selected transport and is represented only through canonical turn/model snapshots where required.
- Horizon schemas contain only managed control, authorization, derived context/index/UI, extension and artifact records.
- Cross-process contracts are versioned and size-bounded.
- One machine schema or generated source owns each wire shape; Markdown examples never become a second schema.
- Unknown enum/version/effect class fails closed.
- IDs are opaque; do not derive Rust aggregate IDs by transforming OpenCode IDs.

## 12.2 Shared primitives

All new contracts should reuse:
- StableId: non-empty opaque string with type-specific prefix when useful;
- Revision: monotonic aggregate revision;
- DecimalU64: canonical unsigned 64-bit decimal string (`0` or nonzero digit followed by digits; no sign, whitespace, or leading zeroes);
- SourceDigest: SHA-256 or stronger digest over exact source bytes/canonical serialization;
- TimestampObservation: informational wall-clock timestamp;
- OwnerEpoch: process/service ownership generation;
- ScopeRef: project/workspace/path/network/account scope;
- CapabilityId: canonical ID from 33;
- EffectClass: READ_ONLY, CONTROL or EFFECT;
- ErrorV1: stable code, message, retryability, details ref, source/service generation.

## 12.3 SessionLinkV1

SessionLink is correlation only.

Required logical fields:
- sessionId;
- sourceStoreId/sourceInstanceId;
- sourceCursor and sourceEpoch;
- latestObservedMessage/part refs when needed;
- sourceDigest/redaction profile;
- owner/process epoch;
- protocol version.

For the HorizonCode Core-backed Session source, `sourceStoreId` is a generated immutable ID
persisted by the Core Session database owner; `sourceInstanceId` is a generated immutable ID on
the matching durable `project_directory` owner row. `sourceEpoch` is a positive per-Session
lineage generation initialized to 1 and incremented transactionally only when the canonical
Session source is explicitly reset or replaced. Appends and process restarts do not increment it.
These values are looked up from trusted durable rows and are never derived from paths, timestamps,
caller metadata or process identity. The cursor is the exact acknowledged Rust SessionProjection
cursor (BLAKE3 event digest), not Core EventV2's SHA-256 cursor. Missing or ambiguous identity,
generation, or cursor makes managed start unavailable. `sourceDigest` is a canonical SHA-256 digest
of the bounded projection metadata; transcript content is not copied into SessionLink.

For the Core projection, compute `sourceDigest` as SHA-256 over the domain bytes
`horizoncode.session-link.source.v1\0`, followed by each UTF-8 field in this fixed order, each
prefixed by its unsigned 64-bit big-endian byte length: session ID, source store ID, source
instance ID, cursor owner kind, cursor owner ID, cursor sequence, cursor event digest, decimal
source epoch, latest observed message ID, latest observed part ID, redaction profile, decimal
protocol version, Goal ID, project ID, workspace ID. A null observed message/part is encoded as a
zero-length field; all other fields must be nonempty. This binding digest contains identifiers
and cursor metadata only, never message or part contents.

It never stores prompt/answer content as canonical Rust conversation data.

## 12.4 Managed control records

GoalV1:
- goalId, objective, project/workspace refs, createdBy;
- activeSpecVersionId;
- status and revision.

SpecVersionV1:
- specVersionId, goalId, parentVersionId optional;
- immutable objective/scope/constraints/acceptance criteria;
- explicit sorted, unique `capabilityScope: CapabilityId[]`, included in proposal digest and reviewer projection; absent/empty means no managed effects;
- budget/time/resource policy;
- source/reference digests;
- acceptedBy/acceptedAt when accepted.

RunV1:
- runId, goalId, specVersionId, sessionLink optional;
- trusted `startedAtMs` derived from the durable `planned_run_started` OwnerLog envelope `time_ms`; not supplied by Core/request, and absent on legacy/non-started Runs;
- status/revision;
- finalRevision optional;
- stop/recovery reason;
- budgets and usage refs.

TaskV1:
- taskId/runId;
- immutable `agentProfileRevision: ProfileRevisionRef` selected before dispatch; authenticated `managed_add_task` supplies `profileSelection: { profileId, revision }` with canonical decimal revision plus the strict digest-free `profileDefinition`. HostKernel verifies the selection matches the definition, computes its digest and persists the complete ref. Attempt-admission input cannot replace it;
- internal `profileOwnerBinding: ProfileOwnerBindingV1`, minted by HostKernel from typed ServerAuth identity (`user` with domain-separated principal digest, or explicit `builtin`); no raw identity or body-supplied owner is stored;
- dependencies;
- scope/workspace lease request;
- explicit `requiredCapabilities: CapabilityId[]`, a sorted unique subset of the accepted SpecVersion `capabilityScope`;
- acceptance criteria subset;
- status/revision.

AttemptV1:
- attemptId/taskId;
- agent profile/harness/model snapshot refs;
- workspace/resource lease refs;
- status;
- started/ended observation times;
- returned evidence refs and failure classification.

## 12.5 Tool/effect records

ToolBatchControlV1:
- batchId;
- Session/message/provider-response refs;
- provider response digest;
- pinned tool-registry generation;
- ordered call descriptors: callId, capabilityId, schema digest, args digest, effect class;
- admission decision/policy epoch;
- status/revision;
- EffectIntent/receipt refs.

EffectIntentV1:
- effectId;
- capability/action ID;
- canonical target and arguments digest;
- source/workspace precondition;
- actor/origin;
- allowed scope;
- budget/cost/network declaration;
- policy epoch;
- idempotency/reconciliation data;
- state.

ExecutionLeaseV1:
- leaseId/effectId;
- exact scope/action digest;
- owner epoch;
- issued/expiry;
- one-use claim/consume state.

EffectReceiptV1:
- effectId/leaseId;
- actual target observation;
- result class SUCCEEDED/FAILED/UNKNOWN;
- external idempotency/operation ref when available;
- before/after revision refs;
- bounded logs/artifact/evidence refs.

Conversational tool call/result content remains in OpenCode.

## 12.6 Evidence/verification

EvidenceV1:
- evidenceId;
- criterion/specVersion/run/task;
- source/tool/test identity;
- bound repository/source revision;
- result summary;
- artifact/log/receipt refs;
- freshness/source digest;
- validation state.

VerificationV1:
- verificationId;
- subject run/task/spec version;
- verifier identity/profile;
- evidence set digest;
- outcome PASS/FAIL/NEEDS_YOU;
- reasons and missing criteria.

## 12.7 Context and RepoIntel

ContextLedgerV2 machine schema is the canonical model-visible context projection contract.

Context entries need:
- source kind/ref;
- source revision/digest;
- protection/priority;
- token estimate with measured/estimated/unknown provenance;
- visibility scope;
- generated summary lineage where applicable.

Symbol/index records require workspace/repository revision, index generation, language/parser source, stable range/ref and confidence. Derived indexes never become source authority.

## 12.8 Provider/model/harness and extensions

AgentProfileV2 and HarnessProfileV1 are machine-schema contracts in contracts-v2.

Provider/model state is projected from existing OpenCode/Horizon provider registry and must include:
- provider/account/model IDs;
- auth source/status without secret bytes;
- declared/observed capabilities;
- context/output limits;
- pricing class/value with source/freshness or unknown;
- availability/failure reason;
- harness compatibility.

SkillManifestV2, HookBindingV2 and McpServerProfileV2 machine schemas own extension registration. Plugin/skill/MCP registration never grants effect authority.

## 12.9 Browser/desktop/web-search/debug/REPL boundaries

BrowserActionV1 is an existing machine schema and must bind owner/tab, observation generation, action, target ref/coordinates, args and effect authorization correlation.

DesktopActionV1 must bind:
- OS/backend;
- display/window/process target;
- capture/AX generation;
- exact action;
- coordinates/ref/input;
- effect correlation;
- post-action observation ref.

WebSearchRequestV1 must bind:
- normalized query and filters;
- provider route class direct-search or grounded-model;
- account/auth ref;
- cost policy;
- timeout/result bounds;
- requested provenance/citation requirements.

DebugSessionActionV1 must bind:
- adapter/session/process/workspace generation;
- operation;
- breakpoint/frame/thread/variable refs;
- expression only for guarded evaluate;
- effect correlation for launch/attach/mutation/evaluate.

The private HostProcessRefV1 is minted and resolved only by HostKernel after a Guarded supervised launch. Its logical shape is `{executionID, generation: DecimalU64, ownerEpoch: DecimalU64, kind, profileID, profileRevision: DecimalU64, profileDigest, executableDigest}`; it contains no PID or executable path. The profile and executable digests are HostKernel-observed immutable launch facts, not caller claims. Every attach/control request separately carries the authenticated Session/Location context, the current workspace revision digest, P4's DAP session-generation pin, and the Attempt/effect scope where managed. HostKernel resolves principal/Session/Location/Attempt from authenticated owners and verifies process kind, execution generation, owner epoch, profile pin, executable digest and RUNNING state. The process generation, owner epoch, DAP session generation and workspace revision have distinct meanings and cannot substitute for each other. A caller-supplied process ID, PID, source generation or ref never creates process authority.

`ExecutionProtocolDispatchReceiptV1` is the private success ACK for a guarded LSP/DAP
`protocol_op` or `protocol_reply`. Its strict machine schema binds the exact HostProcessRef,
positive canonical outbound request sequence, separate process IO sequence, canonical typed
operation digest, durable dispatch-receipt digest, and `DISPATCHED` status. It records an
already completed framed write and never substitutes for live authenticated scope or Guard
authority.

ReplSessionActionV1 must bind:
- REPL session/generation/language/runtime;
- code/input digest and limits;
- filesystem/network/tool-callback capabilities;
- effect correlation for host mutation/tool callback.

These shapes are added as machine schemas before implementation is marked WIRED.

## 12.10 UI, streaming and artifacts

UiStreamEventV2 is the machine contract for bounded derived UI events.

SourceArtifactV1 logical fields:
- artifactId;
- owner/scope;
- SHA-256;
- MIME/kind;
- byte count;
- fidelity FULL/HEAD_TAIL_SAMPLE/FAILED;
- source revision;
- retention/security metadata.

FigureBlockV1 logical fields:
- figureId/messagePartId;
- source revision/digest;
- kind SVG/MERMAID/CHART;
- renderer version;
- theme/geometry epoch;
- status;
- source artifact ref and accessible fallback.

RuntimeObservationV1 owns measured/estimated/unknown telemetry.

AutomationV2 owns schedule/config definition. Each occurrence remains a Guarded action execution.

## 12.11 Plan handoff and delegation

PlanHandoffV1 is canonical structured Plan-to-Build handoff.

SubagentDeliveryV1 is the canonical bounded child delivery envelope for both delegation
lanes and carries a required `lane` discriminator (`direct_session` or `managed_attempt`).
The direct authority branch binds trusted Core parent/child Session IDs, the selected
Core Config-owned `AgentProfileV2` revision/digest, effective permission-scope digest and direct owner epoch;
it contains no managed Attempt claim. The managed branch binds the exact
`DelegationBindingV1` digest, Goal/Run/Task/Attempt IDs and Rust owner epoch. The required
`authorityDigest` is `blake3:` plus lowercase hex of BLAKE3 over the canonical MessagePack
array `[` `"SubagentDeliveryV1.authority"` `, lane, parentExecutionId, childExecutionId,
ownerEpoch, authority]`. This array supplies the domain tag, lane separation, delivery
lineage and exact validated authority branch without ambiguous concatenation. It is
recomputed by the canonical owner and never accepted
as caller-supplied authorization. `ownerEpoch` must equal the current epoch of that lane's
canonical owner. The direct branch's Session IDs must resolve from its parent/child execution
IDs through Core's authenticated owner records; the managed branch's execution IDs, epoch and
Goal/Run/Task/Attempt IDs must agree with the referenced `DelegationBindingV1`. All unsigned
64-bit counters use canonical `DecimalU64`.

Neither rendered Markdown nor child chat is a second source of Task/Run authority.
The same `AgentProfileV2` authority applies to direct Core Session children. Core resolves
the exact trusted revision before dispatch; a legacy `Agent` name can identify a profile only
through an explicit stable selector mapping and cannot replace the profile revision/digest or
supply authority from request data. The resolved profile must drive the child runtime
selection and permission derivation, not merely decorate the delivery envelope.

The Core Config source for these selectors is the explicit `agent_profile_selectors` list in
global user-owned `opencode.json`/`.jsonc`; project config cannot define or override it. Each
`{ selector, profileId, revision }` binds to one exact immutable profile revision. Duplicate
declarations (including identical entries), conflicting selectors, and unavailable, disabled,
or wrong-owner targets fail closed. Profile display names and legacy Agent names are not
implicit selectors. Revision changes do not silently retarget a selector; resume requires the
Session's pinned revision to remain the resolved target.

## 12.12 Public/private APIs

Public Session/API stays OpenCode-derived.

Horizon managed control APIs are additive and versioned. The existing contracts-v2/control-api.openapi.json is a design skeleton until handlers/types/tests demonstrate runtime support.

Private host/kernel IPC uses the 13 protocol, not public HTTP schemas.

## 12.13 Machine contract inventory

Current contracts-v2 includes:
- agent-profile-v2
- harness-profile-v1
- context-ledger-v2
- runtime-observation-v1
- plan-handoff-v1
- skill-manifest-v2
- hook-binding-v2
- mcp-server-profile-v2
- automation-v2
- ui-stream-event-v2
- browser-action-v1
- language-service-snapshot-v1
- subagent-delivery-v1
- capability registry/aliases
- managed event/control API/additive SQL prototypes (**not** generated runtime contracts; see physical OwnerLog mismatch below).

Additional machine boundary schemas now present:
- session-link-v1.schema.json;
- tool-batch-control-v1.schema.json;
- effect-boundary-v1.schema.json;
- desktop-action-v1.schema.json;
- web-search-request-v1.schema.json and web-search-result-v1.schema.json;
- debug-session-action-v1.schema.json;
- repl-session-action-v1.schema.json;
- source-artifact-v1.schema.json;
- figure-block-v1.schema.json;
- question-v2 (TypeScript schema owner `packages/schema/src/question.ts`; session/control events `question.v2.*` consumed by the TUI data route).

**Managed-event prototype incompatibility:** `contracts-v2/managed-event.schema.json` is deliberately flagged `x-horizon-runtime-wire: false` because its PascalCase `eventType` / schemaVersion 2 logical envelope is **not** the existing `kernel/src/owner_log.rs` physical format nor the current `kernel/src/managed_control.rs` snake_case event decoder. Do not feed it into a persistence writer, public SDK or generator. Future adoption requires a versioned physical/projection mapping, schema regeneration, strict negative/roundtrip fixtures, migration rules and a cross-language test against the real committed log. `control-api.openapi.json` remains a design skeleton as stated in §12.12.

Schema presence means DESIGNED only. Generated TypeScript/Rust bindings, real adapters and integration tests are still required before WIRED/VERIFIED status.

## 12.14 Compatibility

Historical ThreadV1/TurnV1/ProviderAttempt/CompactionRecord-as-Rust-conversation schemas are archived provenance only. Do not generate or persist them as V1 canonical conversation data.

Any existing code type with those names is treated as legacy/prototype until explicitly mapped to the current owner model and acceptance tests.

## 12.15 Proposed resource diagnostics and session-attachment schema mapping (A-V2-30)

Before any resource, provider-doctor, file-touch or shared-kernel endpoint is WIRED, define versioned single-owner typed schemas for `ResourceSampleV1`, `ProviderDoctorRequest/ResultV1`, `FileTouchV1` and any `VirtualSessionAttachmentV1` in `contracts-v2`, with generated TypeScript/Rust conformance tests. §37.16 contains **illustrative interfaces**, not machine-enforced schemas and not new authority.

Fields must include logical owner/epoch and measurement source; PSS/RSS/private-bytes are different metric IDs with platform/provenance (measured/estimated/unknown), optional value when unavailable and bounded history. File activity uses canonical workspace+revision, access kind, session/Attempt, time/TTL but **not** a new write permission. Provider Doctor records tier, selected endpoint/model, deadline/spend consent reference and bounded redacted outcomes. Virtual attachment binds an authenticated ingress channel and existing SessionLink/lease generation; clients cannot self-declare principal/Guard grants. Reject unsupported versions/unknown effect class and cross-session ownership confusion. These schemas must reuse existing `ActionDescriptor`, error code registry and §33 IDs.

## 12.16 Machine-contract completion rules for A-V2-30

**One schema for each wire shape.** The following is a REQUIRED design schema inventory with logical field types and version/adoption process. Before CODE_PRESENT → WIRED, add to the existing `arch_V1/contracts-v2/` generator/test pipeline, do not invent separate packages or hand-written incompatible TS/Rust wire DTOs. §37.17–18 may show interface pseudotypes; the machine-generated schema is authoritative once added.

| Schema target (new; not currently generated) | Required identity/binding fields | Limits and required negative validation |
|---|---|---|
| `resource-sample-v1.schema.json` | schemaVersion, sampleId, metric ID/unit, optional decimal integer value, quality, OS/method, observed time, process start fingerprint, logical owner scope | no float for bytes/CPU nanoseconds, unknown has no numeric value, unknown metric version fails, bounded array count |
| `resource-policy-v1.schema.json` | profile revision, hard/soft dimensions, source/precedence, per-workspace/Run owner, enforcement strength, hysteresis and consent | reject overflow/negative values, hard lower than soft, OS guarantee stronger than capability, widening through child |
| `resource-reservation-v1.schema.json` | reservationId, existing Rust Attempt/WorkerExecution/lease ref, owner epoch, limits, expiry, optional process-start identity and exactly the seven §11.20 states (`PROPOSED`, `RESERVED`, `CLAIMED`, `RELEASE_PENDING`, `QUARANTINED`, `RELEASED`, `EXPIRED`) | reject `ACTIVE` or `UNKNOWN` as reservation states, stale epoch, duplicate claim, expiry after launch, over-release before process/effect settlement, unsigned overflow and reuse of an already released lease; no new WorkerExecution owner |
| `virtual-session-attachment-v1.schema.json` | attachmentId, authenticated host binding ref, canonical source store/session, workspace policy revision, source cursor/epoch, bounded queue and subscribed capability set | forbidden self-asserted principal, foreign Session/cursor, oversize ACK, epoch replay |
| `provider-doctor-v1.schema.json` | provider/account/model/harness snapshot refs, requested tier, network request limit, deadline, optional full spend consent, probe observations with redacted error/code | offline forbids network/cost, full requires approval/lease, no raw secret bytes and no hidden fallback |
| `file-touch-v1.schema.json` | authenticated producer/owner epoch, scoped workspace/pathRef, source generation/revision, Session/Attempt, READ/WRITE, optional line range, event timestamp/TTL | no authorization boolean, forged Session/owner epoch, path traversal/reparse, foreign workspace, oversized index, stale generation |
| `headless-worker-request-v1.schema.json` | Task/Attempt IDs (from existing Rust aggregate), accepted SpecVersion digest, parent scope, worker budget and provider selection, source revision, capability subset | foreign Run, cap escalation, policy epoch mismatch, lease missing |
| `task-delivery-v1.schema.json` | reuse existing `SubagentDeliveryV1` / PlanHandoffV1 where compatible; otherwise additive projection with immutable criterion IDs, typed artifact refs, child identity and source digest | duplicate/late child cannot PASS; no second agent-owned Task state |
| `render-diagnostics-v1.schema.json` | existing `UiStreamEventV2` metadata with paint reason, dirty region/epoch and queue lost-count; tool-tail bounds/fidelity | no durable event type invented for paint, secret/ANSI injection, UI queue overflow |
| `repo-intelligence-query-v1.schema.json` | existing RepoIntel capability ID; authenticated principal/Session/Attempt and workspace/read-policy binding; existing RepoGeneration/base revision; owner-issued optional overlay snapshot ref+digest; deadline; result exact workspace/revision plus source provenance/coverage/freshness | reject caller-asserted principal/workspace/revision, foreign overlay, generation or digest mismatch, changed read scope, stale write evidence, oversized query/result, and unknown error/fallback code; query grants no process or write authority |

**Cross-contract enum/authorization rule:** The illustrative §18.18 reservation type and §11.20 transition table must generate from **one** `resource-reservation-v1` enum; `ACTIVE`, `SOFT` and `HARD` are not alternate wire encodings. Derived pressure states are `NORMAL`, `SOFT_PRESSURE`, `HARD_PRESSURE`, `RECOVERING`. FileTouch ingestion/listing is bound to an authenticated host/Session scope even though its records are advisory. §37's typed service interfaces are not an excuse to accept a client-supplied owner epoch or WorkerBudget as authorization. Include generated Rust/TypeScript invalid-transition, lost-process, cross-principal and cancelled-owner fixtures before wiring.

The RepoIntel query schema is a target contract, not a present wire API. `IntelligenceModeV1` is a setting in the existing config owner and projected through `FeatureExposureV1`, not a new registry or grant. LSP query pins are ephemeral broker bookkeeping, not effect/resource leases. Any process start or mutation remains on existing Guard/ExecutionHost and Rust resource-lease paths. Do not place overlay contents in an unbounded query frame; reference an authenticated immutable overlay snapshot. Generate the query schema and transport fixture before wiring a cross-process query adapter.

**Wire canonicalization:** `schemaVersion: 1` integer, bounded UTF-8 identifiers, explicit optional vs null rules, decimal nonnegative strings for unsigned 64-bit counters, opaque source/project references rather than raw filesystem paths, byte lengths measured in UTF-8/encoded frame sizes, strict additional-properties checks at ingress, and one digest algorithm-prefix convention from the current code. Use existing `ErrorV1`/`TypedErrorV1` stable enumerants and mapping: never introduce `IDEMPOTENCY_CONFLICT`, `RESOURCE_BLOCKED` or `RECONCILING_UNKNOWN` as a persisted Blocker/code without first adding them to the canonical machine registry and proving backward-compatible decoding; functional examples may describe these only as semantic classes. Idempotent conflicting delivery is existing `CONFLICT` until a formal schema migration says otherwise.

**Contract publication protocol:** (1) add machine schema + shared fixture to `contracts-v2`; (2) generate Rust and TypeScript with pinned generator; (3) implement exact decoder/encoder with limits and reject unknown variants; (4) maintain one canonical capability ID and alias mapping in §33/catalog machine registry; (5) update private IPC feature negotiation/API spec for actual operation; (6) run cross-language valid-invalid/golden-message tests including 2^53+1 counters, wrong epoch and unsupported OS; (7) update exact source-path map, acceptance ID, HANDOFF status. A proposal in Markdown cannot substitute for these implementation steps.

**Ownership/cross-boundary invariants:** no resource observation or file-touch record becomes an ExecutionLease; no TaskDelivery payload may approve its own PASS; a provider Doctor read does not grant credential use; no virtual attachment changes canonical OpenCode Session ownership; derived UI/resource caches may be deleted without affecting durable Rust OwnerLog. Native Windows/macOS feature negotiation must truthfully report unavailable guarantees.

## 12.17 SecretBroker credential records

These records contain credential references and authorization metadata only.
Raw credential bytes are absent. Trusted principal/service identity is derived
from authenticated connection state and is not accepted from these request
bodies. `secureInputHandle` is an ephemeral, one-use native input-channel
reference; it is not a credential value and is never persisted.

```ts
type SecretRef = StableId & { readonly __brand: "SecretRef" }
type SecretUseLeaseId = StableId & { readonly __brand: "SecretUseLeaseId" }
type SecretOperationDigest = SourceDigest & { readonly __brand: "SecretOperationDigest" }

type SecretStatusV1 = "AVAILABLE" | "NEEDS_AUTH" | "REVOKED" | "UNAVAILABLE"
type SecretUseLeaseStateV1 = "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED"

type SecretMetadataV1 = {
  schemaVersion: 1
  secretRef: SecretRef
  providerId: string
  label?: string
  status: SecretStatusV1
  version: Revision
  createdAt: TimestampObservation
  updatedAt: TimestampObservation
}

type SecretPutRequestV1 = {
  schemaVersion: 1
  providerId: string
  secureInputHandle: string
  label?: string
  idempotencyKey: string
  secretRef?: SecretRef
  expectedVersion?: Revision
}

type SecretUseRequestV1 = {
  schemaVersion: 1
  secretRef: SecretRef
  providerId: string
  operationDigest: SecretOperationDigest
  destination: string
  purpose: "PROVIDER_REQUEST" | "MCP_OPERATION"
  runRef?: StableId
  profileRef?: StableId
  expiresAt: TimestampObservation
  maxRequests: 1
}

type SecretUseLeaseV1 = {
  schemaVersion: 1
  leaseId: SecretUseLeaseId
  secretRef: SecretRef
  secretVersion: Revision
  requesterRef: StableId
  runRef?: StableId
  profileRef?: StableId
  providerId: string
  operationDigest: SecretOperationDigest
  destination: string
  purpose: "PROVIDER_REQUEST" | "MCP_OPERATION"
  state: SecretUseLeaseStateV1
  issuedAt: TimestampObservation
  expiresAt: TimestampObservation
  maxRequests: 1
}

type SecretRevocationReceiptV1 = {
  schemaVersion: 1
  secretRef: SecretRef
  revokedVersion: Revision
  revokedAt: TimestampObservation
  receiptId: StableId
}
```

`SecretMetadataV1` and `SecretRevocationReceiptV1` are safe metadata projections;
they never contain store locators, secret bytes or caller-supplied identity.
`SecretPutRequestV1.secureInputHandle` must be consumed once by the trusted
SecretBroker on the same protected native input channel and is removed from
memory after use. A missing, expired, foreign or reused handle fails before
store mutation. `SecretUseRequestV1` is authorized using authenticated caller
context supplied out of band; provider, operation digest, destination, purpose,
version and expiry are checked against that context and current secret metadata.
The returned lease records `requesterRef` from that authenticated context; no
caller may supply or override it. Optional `runRef` and `profileRef` are also
derived from authenticated context and must match any corresponding request
values; the caller cannot widen or substitute either scope.
The broker durably commits `ISSUED → CONSUMED` before one request, rechecks
version/revocation immediately before use, and never reuses a consumed lease.
`SecretPutRequestV1` creates a new reference when both `secretRef` and
`expectedVersion` are omitted. Rotation supplies both: `secretRef` selects
the existing record, and `expectedVersion` is its required current version.
The broker preserves the reference and atomically advances its version; either
field alone, a missing target, or a stale version is rejected without replacing
the stored credential.
Retry requires a new authorization and lease.

`SecretUseLeaseV1` does not contain credential bytes or itself authorize a
general RPC/child-process transfer. DEC-V1-06 selects a one-request in-process
delivery API to the trusted first-party ProviderTransport; code remains unavailable
until durable OS storage, lease validation/consumption and in-process no-leak tests
pass. These records are not an authorization shortcut for Guard, EffectIntent,
provider cost approval or MCP destination policy.

## 12.18 VEO-review contract refinements (A-V2-33; design, schema work required)

These logical field requirements refine existing `SubagentRequestV2`, `SubagentDeliveryV1`, `TaskDeliveryEnvelopeV1`, `EvidenceV1`, RepoIntel query and managed verification records. The canonical new machine-schema home is `arch_V1/contracts-v2/`; the private Rust IPC decoder remains in `kernel/src/protocol.rs`. Caller-controlled request bodies never establish identity, owner epoch, Attempt, workspace, source revision, capability grant or budget. Until the binding is derived from accepted durable state and its live leases are resolved, managed dispatch fails closed before effect preparation.

`DelegationBindingV1`, minted only after Rust Attempt admission:

```ts
type DelegationBindingV1 = {
  schemaVersion: 1; runID: RunId; taskID: TaskId; attemptID: AttemptId;
  parentExecutionID: WorkerExecutionId; childExecutionID: WorkerExecutionId;
  acceptedSpecDigest: SourceDigest; profileID: StableId; profileRevision: DecimalU64;
  profileDigest: SourceDigest; criteriaIDs: StableId[];
  workspaceLeaseID: LeaseId; sourceRevision: SourceDigest;
  capabilityCeilingDigest: SourceDigest; contextSelectionDigest: SourceDigest;
  budgetLeaseID: LeaseId; resourceLeaseIDs: LeaseId[];
  ownerEpoch: DecimalU64; admittedManagedRevision: DecimalU64;
}
```

For usage projection, the first-party V2 Assistant message and `Step.Ended` event carry `UsageProvenance` (owned by `packages/schema/src/session-message.ts`): selected provider/model identity, optional provider request ID, cost metric, and input/output/reasoning/cache token metrics. Each metric is explicitly `provider-reported`, `measured`, `estimated` with a finite nonnegative value, or `unknown` with no value. Token metrics must additionally be safe nonnegative integers; cost remains a finite nonnegative decimal. A reported cost binds to provider response/request identity. Token counts are `provider-reported` when supplied by the selected provider response and never inferred from absent fields. A locally computed cost is `estimated`, never `measured`; it requires all token inputs and all price components, records the exact component prices/source and a SHA-256 digest of the selected price tuple, plus algorithm `per-million-linear-v1`. Until a real billing/receipt measurement source exists, measured cost is unavailable. Missing provider fields or pricing snapshots remain unknown. Legacy scalar columns/events may be replayed for compatibility but are never promoted to measured provenance and must not override an explicit unknown status.

The binding is immutable for the Attempt and minted only from authenticated transport identity plus accepted SpecVersion, registered profile, authorized criterion subset, current workspace/source lease, capability policy, bounded context selection and budget/resource lease owners. `admittedManagedRevision` is the exact owner revision atomically containing the admitted Attempt and binding; it is immutable audit lineage. No request field can populate or override these values. Missing owner state, profile/context identity, or any required lease rejects managed admission; fixtures that previously omitted a binding must be migrated rather than grandfathered into dispatch. Each effect admission checks the request envelope's current `expectedManagedRevision` against durable owner state, and resolves every binding reference against live durable state immediately before preparation and again before dispatch/recovery. The immutable admitted revision is not required to equal later revisions created by receipts/evidence. Revoked/expired leases, mismatched epochs, stale current source, capability changes, duplicate/out-of-scope criteria, or resource lease mismatch reject before dispatch. Cancellation fences new work; restart/reconciliation preserves unresolved effects as UNKNOWN and does not recreate the binding or replay a non-idempotent action. Direct-mode delegation without an Attempt uses existing direct policy and cannot settle managed state.

V1 proof ownership is explicit: Core Config owns mutable `AgentProfileV2` definitions/revisions; Core `ContextService` compiles `ContextSelectionV1` from canonical Session/context sources, while `ContextLedgerV2` remains a read-only projection. Core resolves `source=user` profiles only inside the authenticated ServerAuth subject's owned profile namespace. At Task creation, authenticated Core ingress supplies `profileSelection: {profileId, revision}` with a canonical decimal revision plus the strict digest-free canonical definition; HostKernel verifies the selection matches the definition, computes the digest, and persists immutable `ProfileRevisionRef` plus `ProfileOwnerBindingV1` on the Task before dispatch. `ProfileOwnerBindingV1` is either the explicit built-in class or a domain-separated digest of the authenticated subject for a user profile; no raw identity or body-supplied owner is stored. Project/plugin/external trust is unavailable until its trust resolver exists. Attempt admission resolves that exact revision and definition and requires the same bound user owner; it cannot select or replace the Task pin. HostKernel/Rust validates the authenticated principal and exact Task profile pin plus accepted Spec selection, recomputes canonical profile/binding digests, intersects the profile capability IDs with Task/Spec scope and current Guard policy, resolves live workspace/budget/resource leases, then mints the opaque typed proof and atomically stores only immutable per-Attempt refs/digests in the binding. Caller-supplied digests, a profile permission ceiling alone, the ContextLedger projection, or a copied transcript cannot mint authority. Missing/stale/mismatched proofs deny before preparation and leave OwnerLog unchanged.

Managed effect scope is explicit and reviewable: `SpecVersionV1.capabilityScope` is a proposal field covered by the immutable digest and shown to the distinct authenticated reviewer. `TaskV1.requiredCapabilities` must be a canonical-ID subset of that accepted list. Reject aliases, unknown IDs, duplicates, unsorted wire values, widening and over-limit arrays. Do not infer capability IDs from prose, path globs or constraints. The effective ceiling is `Task.requiredCapabilities ∩ accepted SpecVersion.capabilityScope ∩ profile.capabilityCeiling ∩ current Guard policy`; an empty intersection means no effect. This ceiling never substitutes for per-operation Guard decision, current workspace checks or a one-use effect lease.

`contracts-v2/capability-registry-v1.json` is only a design-time canonical-ID/alias seed. It may support syntax/alias validation but never proves runtime availability or grants authority. Dispatch additionally requires the current P1 Guard to resolve an actually registered, implemented capability under current policy; design-only, missing or unsupported IDs remain unavailable.

The schema/fixture owner is `contracts-v2/delegation-binding-v1.schema.json` with a shared golden fixture consumed by the Rust protocol decoder tests. The private IPC representation uses canonical decimal strings for every unsigned 64-bit value (including `profileRevision`, `ownerEpoch`, `admittedManagedRevision`, and the envelope's current `expectedManagedRevision`) so future TypeScript projections preserve values above 2^53; identifiers and digests are bounded strings, arrays are sorted and unique where order is not semantic, and unknown fields are rejected. The binding digest is domain-separated BLAKE3 over the exact canonical MessagePack map after validation; the shared fixture fixes field names, decimal spelling, map ordering and digest bytes. Do not hash a reserialized or partially validated caller map. This binding is the immutable managed scope referenced by the smaller `ManagedAttemptScopeV1` request envelope, which carries the current expected revision and binding digest. The envelope alone never authorizes a managed effect. Neither shape is a public SDK/OpenAPI endpoint.

Pre-admission retries use a durable per-Task candidate generation owned by ManagedControl.
`AbandonPreAdmissionCandidate` is a private HostKernel-only event: it accepts only an opaque P8
receipt for the exact durable `NotAdmittedNoDispatch` tombstone (`EXPIRED` reservation), and binds
the current READY Task revision, generation, candidate Attempt and pins digest, P8 OwnerLog
cursor/event digest, worker-pool revision, reconciliation-proof digest, receipt digest, current
admitted `attempt_count`, HostKernel epoch/process incarnation and delivery ID. The reducer
persists the increment and an exact-replay receipt. P1 derives candidate identity from Task ID
plus persisted `attempt_count` and `candidate_generation`; Attempt admission advances the first
counter while a pre-admission tombstone advances the second. RPC bodies cannot choose it. The identity of a tombstoned candidate never
returns to the reservation pool. This does not add a public Task field or an external API
contract.

`RepoGenerationRequestV1` closes the first-query pinning gap without making Core read
source bytes. It travels over the same authenticated `repo-intel.v1` service and carries
only a relative root selector and bounded collection limits. HostKernel resolves the
authenticated Session/Location and current Guard `files.read` scope, collects snapshots,
and returns a short-lived pin. Core then supplies that returned index digest to
`RepoStructureQueryV1`; workspace source revision and derived index generation are
separate values and are checked independently.

LSP document synchronization uses an additive `repo-intel.v1/read_document` operation
on this same authenticated boundary; Core does not read source bytes directly. The
request carries only a relative path, the exact expected workspace revision and a
bounded byte limit. Principal, Session, Location, read policy and workspace root are
authenticated out of band or HostKernel-derived. HostKernel enforces current Guard
`files.read`, registered Location ownership, no-follow path traversal, regular-file and
UTF-8 checks, cancellation, and exact pre/post workspace revision. The response returns
the normalized relative path, text, BLAKE3 content digest and observed revision.

```ts
type RepoDocumentReadRequestV1 = {
  schemaVersion: 1; pathRef: WorkspacePathRef;
  expectedWorkspaceRevision: SourceRevision; maxBytes: number;
}
type RepoDocumentReadResponseV1 = {
  schemaVersion: 1; status: "OK"; pathRef: WorkspacePathRef; text: string;
  contentDigest: SourceDigest; observedWorkspaceRevision: SourceRevision;
}
```

This is read evidence for LSP synchronization only. It grants no edit authority; code
actions and rename still require canonical Guarded patch admission.

```ts
type RepoGenerationRequestV1 = {
  schemaVersion: 1; messageType: "ensure_generation"; requestId: StableId;
  rootRef: WorkspacePathRef; maxFiles: number; maxBytes: number;
  maxFileBytes: number; deadline: TimestampObservation;
}
type RepoGenerationPinV1 = {
  schemaVersion: 1; messageType: "generation"; requestId: StableId;
  workspaceBinding: WorkspaceBinding; sourceGeneration: SourceGeneration;
  sourceRevision: SourceRevision;
  sourceKind: "symbol_index" | "parser" | "lexical" | "lsp" | "none" | "unknown";
  coverage: { files: number; bytes: number }; expiresAt: TimestampObservation;
}
```

Neither body contains principal, Session, Location, canonical workspace, policy, or
authorization claims; these remain authenticated out of band or HostKernel-derived.
The returned `sourceGeneration` is the digest of the immutable index, while
`sourceRevision` is the independently measured live workspace observation. A query or
cursor whose pin is expired or whose current source/policy no longer matches returns a
typed stale/unavailable result with no nodes. The complete wire contract is
`contracts-v2/repo-intelligence-query-v1.schema.json`.

`RepoNodeRefV1` and `RepoStructureQueryV1` are bounded read contracts:

```ts
type RepoNodeRefV1 = {
  workspaceBinding: WorkspaceBinding; sourceGeneration: SourceGeneration;
  sourceRevision: SourceRevision; overlayDigest?: SourceDigest;
  pathRef: WorkspacePathRef; fileDigest: SourceDigest;
  nodeId: StableId; nodeKind: string; symbol: string;
  byteRange: { start: number; end: number }; parserId: string; parserVersion: string;
}
type RepoStructureQueryV1 = {
  schemaVersion: 1; rootRef: WorkspacePathRef; sourceGeneration: SourceGeneration;
  overlayRef?: RepoOverlayRefV1;
  selector: { symbols?: string[]; nodeRefs?: RepoNodeRefV1[]; includeCallers?: boolean };
  maxNodes: number; maxBytes: number; deadline: TimestampObservation;
}
```

`RepoOverlayRefV1` is an opaque `ovl_[A-Za-z0-9_-]{16,128}` reference minted only by
HostKernel after a genuine Core-owned immutable buffer snapshot is supplied over the
authenticated private channel. It is bound to ServerAuth subject, Session, registered
Location, base source generation/revision, read-policy digest, a host-computed overlay
digest, and a bounded lifetime. It contains no bytes and cannot be selected to claim
ownership. The HostKernel lease is in-memory and restart invalidates it. Current bounds
are 128 changed paths and 8 MiB of replacement bytes. Until a genuine Core buffer
snapshot producer exists, any query carrying `overlayRef` fails with typed
`capability_unavailable` before source collection or query dispatch. A foreign, expired,
or stale base/policy lease fails with `stale_repo_generation` and returns no nodes; it
must never silently fall back to base content. Overlay pages include `overlayDigest`,
and every node reference in that page carries the same digest; base pages omit both.
Cross-field shape constraints are checked by the strict TS and HostKernel decoders.
Overlay references are not exposed as model/tool arguments.

Transport identity and read scopes are authenticated out of band. Enforce configured hard maxima even when the request asks for larger limits. Every result states exact source digest/range, parser and coverage, completeness, freshness and typed fallback/unavailable reason. Node refs expire on generation/revision mismatch and never authorize writes; callers refresh and submit a digest-checked canonical `files.patch`.

Evidence uses existing `EvidenceV1`/`VerificationV1` ownership. Each new evidence kind includes criterion, Attempt/Run, exact source revision, producer/verifier identity, command or query identity, artifact digest, fidelity and measured/estimated/unknown provenance. Verifier output refers to immutable artifacts accepted by ArtifactStore and a freshly observed workspace revision; caller-provided PASS, digest or artifact ref is insufficient. Mutation-campaign detail, cache usage and fitness fields are added only when their owning phase implements the feature and bounds.

For cross-process RepoIntel queries, use the existing `repo-intelligence-query-v1.schema.json` target in this directory and one shared page-response fixture. `RepoNodeRefV1` may be embedded only up to the query byte/node cap; larger answers use an owner-issued cursor bound to authenticated owner, query digest, generation and expiry. Cursor replay after source-generation change returns typed stale status with no partial result that could be mistaken as fresh evidence. The source digest is recomputed by the canonical file/HostKernel path before a patch; parser metadata never grants write authority.

For the first managed Task in a Run, `parentExecutionID` is a HostKernel-minted logical root-coordinator `WorkerExecutionId` bound to the authenticated top-level Core Session that coordinates that Run. It is a durable lineage owner, not a second model/session runtime or spawned worker. HostKernel derives it from the authenticated Core principal, Session/Location, managed OwnerLog and current transport/process incarnation; a body-supplied parent ID is never accepted. The child Attempt's `budgetLeaseID`/`resourceLeaseIDs` remain its own P8 RESERVED leases; root lineage does not pretend those leases belong to a separate process. Account any shared Core process observation once. If the authenticated process incarnation cannot be established, fail admission closed. Nested Tasks use the existing active claimed parent WorkerExecution proof. P8 reserves the child against immutable pre-admission Task/Attempt/profile/context/Spec/workspace pins; after P1 atomically mints and persists the DelegationBinding containing those lease refs, P8 attaches its digest to the RESERVED record before claim/dispatch. No worker is claimed or dispatched across a missing/mismatched binding pin.

## 12.19 V1 single-Attempt verifier effect lifecycle

The first managed V1 vertical contains one coding Task and one Attempt. The Attempt remains live/EXECUTING from admission through the coding action and independent verification; it is settled only after typed verifier evidence is durably appended. Verification is an additional, separately authorized EffectIntent under that exact Attempt, not an exception to Attempt scope and not a synthetic Task.

The canonical managed owner persists an append-only verifier-effect stage bound to `{runID, taskID, attemptID, effectID, criterionID, ownerEpoch, expectedManagedRevision, acceptedSpecDigest, workspaceLeaseID, sourceRevision, verifierProfileRevision, canonicalArgumentsDigest}`. The request envelope carries references and expected revision only; HostKernel resolves every field from authenticated principal, accepted SpecVersion, current Task/Attempt, trusted verifier registry, Guard policy and live workspace/budget/resource leases. The immutable binding alone grants no authority. Each criterion/effect has a distinct bounded edge, PREPARED intent, one-use lease, process identity and receipt; no shared lease or caller-selected executable, argv or verdict is accepted.

The stage advances only on owner-observed facts: `PREPARED` after required approval and atomic Attempt binding but before dispatch; `RUNNING` after HostKernel records the exact execution identity; `SETTLED` with a durable receipt and immutable ArtifactStore references after observed exit; `EVIDENCE_RECORDED` after HostKernel re-observes the actual workspace revision and Rust appends typed criterion evidence. These labels project canonical OwnerLog/effect/artifact records; they are not a new event bus. Each transition is idempotent and revision-fenced. Existing effect and evidence records remain the sources of truth.

`Attempt.workspaceRevision` and `DelegationBinding.sourceRevision` are immutable admission provenance. They are the base of a private live-effect revision chain, not the required `beforeWorkspaceRevision` for every later effect. In deterministic OwnerLog edge order, HostKernel and the managed reducer independently derive the chain head: start at that immutable base; every prior effect must have exactly one `SUCCEEDED` receipt whose `beforeWorkspaceRevision` equals the preceding head and whose `afterWorkspaceRevision` becomes the next head. Immediately before each dispatch HostKernel recomputes the registered workspace and requires it to equal the derived head. V1 serializes mutating effects within the Attempt; batch admission does not authorize parallel workspace writes. The aggregate `expectedManagedRevision` fences the current OwnerLog snapshot, while each edge's `boundRevision` remains its own immutable edge-local revision.

A failed, UNKNOWN, missing, malformed, mismatched or reordered predecessor receipt; cancellation; owner-epoch change; or workspace change outside this receipt chain fences later dispatch. Recovery cannot infer a rebase from caller input: reconcile the same effect identity or require new authorization. Every read-only verifier intent binds the current chain head and its receipt must prove `beforeWorkspaceRevision == afterWorkspaceRevision == head`; evidence is bound to that same revision. These rules are validated by both HostKernel and the canonical managed reducer.

For a model ToolBatch, `attempt_effects_bound` appends the complete bounded, unique effect-ID
set in one OwnerLog event/revision; every new edge records that same resulting `boundRevision`.
HostKernel does not issue a one-use lease from the pre-bind scope. It returns the refreshed
scope at the new revision, recomputes the current workspace chain head, and binds each lease to
that post-bind scope and exact edge/intent. A successful effect receipt may advance both the
OwnerLog revision and workspace chain head; only the correlated HostKernel receipt/reconcile
response may refresh those pins. The batch-bind transition itself preserves workspace head and
advances aggregate revision exactly once. Failure, UNKNOWN, cancellation or lost receipt never
refreshes into a dispatchable scope. See §14.3 and VEO-019/020.

## 12.20 HostKernel-resolved supervised launch profiles

The single ExecutionHost accepts a logical `ExecutionLaunchProfileRefV1`, not
caller-selected process fields. Core Config owns immutable profile definitions and
revisions. For each launch it projects the exact definition through authenticated
Core→HostKernel IPC; HostKernel strictly validates it, recomputes its domain-separated
BLAKE3 profile digest, resolves the configured executable and derives the working
directory from the authenticated registered Location. No second process supervisor or
independent mutable launch registry is introduced.

```ts
type ExecutionLaunchKindV1 = "lsp" | "dap" | "repl";
type ExecutionLaunchProfileDefinitionV1 = {
  schemaVersion: 1; profileId: StableId; revision: DecimalU64;
  kind: ExecutionLaunchKindV1; executableSelector: string;
  argv: string[]; workingDirectoryPolicy: "registered_location_root";
  environmentPolicy: "sanitized_host";
}
type ExecutionLaunchProfileRefV1 = {
  profileId: StableId; revision: DecimalU64; profileDigest: SourceDigest;
}
```

`argv` is an immutable list of literal arguments from the exact Core Config revision;
it has no shell expansion, template/interpolation syntax or per-launch additions. The
executable selector is resolved by HostKernel against the authenticated profile only,
never a path supplied by P4, project configuration, or the current working directory.
The sanitized host environment contains no profile-provided secret values. Enforce
strict field allowlists, canonical decimal revisions, argument count/byte bounds and
NUL/control rejection. HostKernel binds its resolved executable identity/digest and
profile ref to the minted `HostProcessRefV1`, effect receipt and one-use Guard lease.
P4 requests carry only the profile ref and authenticated Session/Location/Attempt,
owner-epoch and workspace-revision scope. Project/plugin/external profile sources stay
unavailable until trust resolution exists. DAP adapter launch does not authorize the
debuggee process requested over DAP; that is a separate Guarded effect. REPL execution
stays unavailable until its required OS resource limits are enforced. Any profile,
executable, Guard, lease or process-state uncertainty denies before spawn or remains
UNKNOWN after possible dispatch; it never starts a replacement process.

The strict machine contract is
`contracts-v2/execution-launch-profile-v1.schema.json`; Rust and TypeScript decoders
must share golden fixtures before launch is enabled.

The immutable verifier intent and its Guard lease are separate ordered records. Before approval, HostKernel may retain a challenge-bound candidate containing the exact verifier profile/executable/criterion/arguments/current-head facts for reviewer display; this candidate is not an Attempt mutation, lease or dispatch authority. After approval by the authenticated distinct reviewer, atomically bind the exact Attempt edge and immutable intent without a lease digest, refresh `ManagedAttemptScopeV1` to the resulting aggregate OwnerLog revision, revalidate the approval and current managed/workspace fence, and only then issue the one-use lease. Do not append the lease digest to the managed log before dispatch, which would invalidate the revision used to admit the lease. EffectHost owns durable one-use consumption; the HostKernel-authenticated settled receipt durably records the exact lease digest. Revalidate the aggregate revision and workspace head at approval and dispatch; intervening changes expire/fence the authorization and require reconciliation/new authorization, never rebase. The approval principal is the authenticated distinct reviewer; the supervised child identity is the trusted verifier profile principal.

Attempt/Task/Run success is forbidden until every required criterion has current-revision evidence. Verifier failure settles as failure/needs-you according to the accepted contract; process exit or model self-report alone never gives PASS. Crash, cancellation after possible dispatch, lost receipt, stale revision, partial artifact capture or owner-epoch change leaves the effect and Attempt UNKNOWN/reconciliation-only. Recovery may inspect the same persisted identity and receipt/target evidence but never relaunches the verifier automatically. A new execution needs reconciled state and new authorization. P1/P2 own this lifecycle; P7 owns immutable artifact metadata. See §§3.22, 14.3, 37.22 and 32.38.

