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

Every unsigned 64-bit counter or budget crossing JSON uses `DecimalU64`, never a JSON number
or JavaScript `number`. This includes token/byte/cost-micro counters, revisions, sequences,
cursors and owner epochs. JSON numeric fields are allowed only for schema versions or values
with a fixed bound that is explicitly below JavaScript's exact-integer limit; a current small
limit does not redefine a general counter as a number.

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

Every direct effect artifact is scoped to the authenticated direct Session and its producer
request/tool call/effect receipt; every managed artifact is scoped to its Rust-owned Attempt.
`SourceArtifactV1{lane: "direct"}` requires `sessionId`, `producerRequestId`,
`producerToolCallId`, `effectId`, and `effectReceiptRef`, and forbids `attemptId` and
`evidenceRefs`. `SourceArtifactV1{lane: "managed"}` requires `attemptId` and `evidenceRefs`
(which may be empty), and forbids `sessionId`, `producerRequestId`, and
`producerToolCallId`. A managed Attempt cannot resolve, read, or cite a direct artifact ID or
its content. If managed work needs the same bytes, an authorized producer running inside that
Attempt must create a new managed `SourceArtifactV1` with its own `attemptId` and
`evidenceRefs`; cross-lane promotion or capture of a direct artifact is forbidden. See §12.10
and the strict machine schema.

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

WebSearchRequestV1 is model intent only and binds:
- normalized query and optional domain filters;
- bounded result count;
- optional bounded deadline and host cancellation correlation.

Domain filters are query-narrowing intent, not destination authorization. HostKernel validates
their syntax/count/byte bounds and exact equality with Guard-approved arguments; V1 defines no
independent domain allowlist.

Provider, route class, account, auth source, cost policy, endpoint, retries and budget are trusted
HostKernel route-plan facts. The model request cannot select or override them. See §37.5 and
`contracts-v2/web-search-request-v1.schema.json`.

`contracts-v2/web-search-result-v1.schema.json` is the strict successful result
projection: bounded result items plus provider/route, cost/auth source, freshness,
aggregate measured latency, truncation truth, and up to 20 sanitized ordered route
attempts (with at most 20 attempts in one cascade). A route outcome `empty` is valid
only for a completed HTTP 2xx whose recognized provider result array contains zero
rows; it is terminal for that route and advances to the next enabled route without
retrying the same route. Every known route outcome carries its exact durable route
receipt reference; an `unknown` outcome carries no route receipt because dispatch
cannot be claimed settled. `contracts-v2/web-search-failure-v1.schema.json` carries typed
not-dispatched, failed, exhausted, cancelled, UNKNOWN, or completed-result-unavailable outcomes with
the same bounded per-route status/auth/cost and opaque receipt provenance. Neither
projection may include credential bytes, raw provider bodies, query copies in
route state, or unsanitized provider exceptions. The production runtime validates
the same TypeScript schema before exposing tool metadata.

`not_dispatched` is only a rejection before a trusted route plan or route attempt
exists. Cancellation after route-plan admission is `cancelled`, carries the exact
HostKernel plan digest and any settled route receipts, and remains distinct from
both exhaustion and UNKNOWN.

For BYO transport, a durable per-route `NOT_DISPATCHED` receipt is valid only when the
trusted in-process transport proves no request bytes left the process. It has null HTTP
status, retry delay, result count and body digest, zero body bytes, and
`responseComplete=false`; it permits at most one retry on that same enabled route.
HTTP 408/425/5xx may be retried once only after their exact response receipt is durable.
Any outcome after possible send without a complete response receipt remains `UNKNOWN`
and cannot be retried. See `search-secret-attempt-receipt-v1.schema.json`.

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

SourceArtifactV1 is a strict tagged union. Shared immutable fields are `artifactId`,
`artifactGeneration` (canonical `DecimalU64`), `ownerRef`, `sourceRevision`, `sha256`,
`mime`, `byteCount`, `fidelity` (`full`/`head_tail_sample`/`failed`), `droppedByteCount`,
`redactionState`, `retentionClass`, and `producerCapabilityId`. The `lane: direct`
variant requires `sessionId`, `producerRequestId`, `producerToolCallId`, `effectId`, and
`effectReceiptRef`; it forbids `attemptId` and `evidenceRefs`, and `ownerRef` must equal the
authenticated Session owner. The `lane: managed` variant requires `attemptId` and bounded
`evidenceRefs` (which may be empty); it forbids `sessionId` and producer request/tool-call
fields, and `ownerRef` must resolve to the Rust-owned Attempt owner. An artifact alone never
proves criterion evidence or verification. Direct artifact refs cannot resolve managed
refs; managed Attempts cannot read direct artifact references or content. A managed producer
must independently create a new managed artifact under its live Attempt if equivalent content
is needed. Cross-lane promotion or capture is forbidden, and managed evidence refs cannot
widen direct Session scope. The canonical machine
schema is `contracts-v2/source-artifact-v1.schema.json`.

FigureBlockV1 logical fields:
- figureId/messagePartId;
- source revision/digest;
- kind SVG/MERMAID/CHART;
- renderer version;
- theme/geometry epoch;
- status;
- source artifact ref and accessible fallback.

RuntimeObservationV1 owns measured/estimated/unknown telemetry.

AutomationV2 owns schedule/config definition. Its immutable action binding includes the
canonical capability ID, action version and implementation digest, canonical-registry
`actionSchemaDigest`, and one fixed user-authored `actionInputJSON` object. The JSON is canonical,
at most 16 KiB, at most 2,048 nodes and depth 16, and uses safe integers. Its BLAKE3 digest is
domain-separated over the exact UTF-8 payload bytes and is pinned with the schema digest in the
definition version and Guard EffectIntent. The canonical registry validates the exact payload
before definition save and again before dispatch; caller-provided schemas are not authority, and
secret inputs require schema-approved opaque references. Legacy definitions without both pins
remain inspectable but are never invocable. Each occurrence remains a Guarded action execution.

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

Core persists the exact validated `SubagentDeliveryV1` alongside the child Session before prompt dispatch. Direct delivery sequence advances from the prior validated child envelope; it is bound to the admitted DirectAttempt's current owner epoch, exact profile revision/digest, and effective permission digest. Managed delivery is built from the pinned Rust handoff and one-use consume receipt. Resume/recovery rejects malformed or mismatched prior delivery metadata and never reconstructs a consumed managed prompt from caller fields.

An authenticated `PLAN_ONLY` response carries one strict Rust-derived Task pin per durable
planned Task: Goal/Run and final Run revision, accepted Spec ID/digest, exact profile
ID/revision/definition digest, `acceptedScopeDigest` from
`AcceptedTaskCapabilityScopeFactsV1.digest()`, and `profilePermissionCeilingDigest` from
the validated profile. These are plan-review facts only. `acceptedScopeDigest` is not the
Attempt-bound `permissionScopeDigest`; the latter is minted only after authenticated
Attempt admission and includes the live owner epoch and Guard policy binding. A plan
response cannot create an Attempt, authorize effects, or enable `goal.start` by itself.

`ackState` advances to `acknowledged` only after the child prompt has returned and Core has durably persisted that transition. A resumed direct delivery with no acknowledgment is ambiguous and fails closed rather than replaying its prompt. Managed completion recovery requires both the returned-child marker and the acknowledged envelope; a durable consume without those exact projections remains UNKNOWN and is never dispatched again.

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

For the direct Core child-session lane, the public strict `AgentMessageV1.RequestV1`
contract for the existing `agents.message` capability carries only child Session selection, bounded content,
an idempotency key, and `deliveryMode: "queued" | "follow_up"`. Core maps public
`queued` to the private HostKernel enum `queue`. Parent/child lineage, owner epoch,
immutable profile and permission-scope pins, payload digest, mailbox sequence,
and the exact `directAttemptID` for both modes are trusted Core-derived pins.
Direct-lane follow-up also requires a distinct, HostKernel-minted one-use fresh-turn proof
bound to the next serialized turn sequence; an ordinary reusable DirectAttempt
scope is insufficient. Guard result, one-use permit
and durable receipt are
derived or returned by trusted owners, never accepted from request data. A queued
message persists without waking the runner. Follow-up requests exactly one fresh
serialized turn at the next safe input boundary and is denied if a child request is
active. UTF-8 payload is capped at 16 KiB and pending messages at 32 per child,
subject to HostKernel capacity admission. The prepare/commit/inspect RPCs and Core
durable inbox-to-child-runtime adapter are source-present, but the operation stays
fail-closed until their authenticated recovery and child-runtime acceptance passes;
direct-lane follow-up stays unavailable until the one-use fresh-turn issuer is present. Managed
follow-up remains governed by the separate managed inbox/prompt callback contract in §3.21. It must
reuse the existing inbox and may not introduce a second transcript, mailbox store,
or event bus. Core records the
latest exact DirectAttempt ID on the child Session beside the immutable profile
pin, allowing HostKernel OwnerLog lookup without an ambiguous child-session scan;
queued mode matches that durable Attempt but does not claim active-turn proof.

The authenticated `GET /session/{parentSessionId}/subagents` route returns the
bounded `SubagentStatusV1.ListV1` projection for the direct Core lane. It is a
read-only projection of linked Core Sessions explicitly tagged
`SubagentDeliveryV1.lane = direct_session`, their immutable profile/delivery
metadata, SessionStatus, exact HostKernel DirectAttempt snapshots, and the
authenticated aggregate count of Core inbox rows still reserving pending mailbox
capacity; managed
Attempt children are excluded. A missing
or mismatched Attempt is `unknown`. It exposes no transcript body and grants no
message, turn, cancellation or effect authority. The route verifies the same
authenticated parent owner chain used by question controls. It caps the page at
64 children and reports truncation; larger graphs are not silently represented
as complete.

Direct Core child admission also applies a fixed aggregate limit of 64 child
Sessions per parent, independent of profile selection. A selected
AgentProfileV2's `maxTotalChildren` and active-child limits remain stricter
per-profile ceilings. Core's Session query is an early denial only. HostKernel
serializes and rechecks the same bound against durable DirectAttempt parent
lineage before admission, counts terminal child Sessions toward the lifetime
aggregate, excludes abandoned pre-admission reservations, and does not
double-count an exact Attempt retry. This is source-present and remains
unverified until the Rust regression/acceptance suite runs.

`GET /session/{parentSessionId}/subagents/{childSessionId}/wait?timeoutMs=...`
waits at most 30 seconds for the exact owner's child Attempt to become terminal
or UNKNOWN, to report observed activity, or to time out. It re-resolves the
authenticated parent owner/workspace scope and exact child Attempt on every
observation. It returns one bounded
`ChildV1` projection and `terminal | activity | timeout`; a timeout never
cancels the child. The route re-resolves authenticated parent lineage and the
exact HostKernel DirectAttempt on each observation and returns no transcript
body or caller-supplied authority pins.

## 12.13 Machine contract inventory

Current contracts-v2 includes:
- `agent-message-v1.schema.json` and `packages/schema/src/agent-message-v1.ts` — strict public request, trusted authority-pin projection, durable receipt, and bounded child-status projection for direct child messages.
- `packages/schema/src/subagent-status-v1.ts` — bounded read-only direct-child status projection consumed by the owner-checked Core route and TUI; it does not implement message or turn delivery.
- `packages/core/src/v1/config/repo-intelligence.ts` and `ConfigV1.Info.repo_intelligence.profile` — the three-mode Config-owned RepoIntel setting, typed requested/requestedValue/effective/source/lock/reason projection, and optimistic-concurrency update input. The setting changes analysis depth only and cannot authorize or start work.
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
- `external-editor-profile-v1.schema.json` — user-owned external editor profile, user-action launch request and process/result projection; profile reference is not launch authority;
- session-link-v1.schema.json;
- managed-run-plan-response-v1.schema.json — strict authenticated PLAN_ONLY per-Task profile and accepted-scope pins. `acceptedScopeDigest` and `profilePermissionCeilingDigest` are plan provenance only; the Attempt-bound `permissionScopeDigest` is minted after authenticated Attempt admission;
- tool-batch-control-v1.schema.json;
- effect-boundary-v1.schema.json;
- desktop-action-v1.schema.json;
- web-search-request-v1.schema.json, web-search-result-v1.schema.json, and
  web-search-failure-v1.schema.json;
- debug-session-action-v1.schema.json;
- repl-session-action-v1.schema.json;
- source-artifact-v1.schema.json;
- figure-block-v1.schema.json;
- question-v2 (TypeScript schema owner `packages/schema/src/question.ts`; session/control events `question.v2.*` consumed by the TUI data route).
- A-V2-30 wire targets from §12.16: `resource-sample-v1.schema.json`,
  `resource-policy-v1.schema.json`, `resource-reservation-v1.schema.json`,
  `virtual-session-attachment-v1.schema.json`, `provider-doctor-v1.schema.json`,
  `file-touch-v1.schema.json`, `headless-worker-request-v1.schema.json`,
  `render-diagnostics-v1.schema.json`; task delivery reuses `subagent-delivery-v1.schema.json`
  and `plan-handoff-v1.schema.json` where compatible.

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
For the V1 first-party provider transport, HostKernel derives
`requesterRef = "principal_" + hex(BLAKE3("horizoncode/secret-requester/v1\0" ||
UTF8(authenticatedPrincipalID)))`; the domain-separated digest is stable across
restart and is never derived from Session IDs or request fields. Managed provider
use sets `runRef` to the exact authenticated Run ID and requires `profileRef` for
the Task-pinned AgentProfileV2. `profileRef` is
`"profile_" + hex(BLAKE3("horizoncode/agent-profile-ref/v1\0" || canonicalMessagePack({
profileId, revision, profileDigest })))`. Direct provider use also requires the
trusted current AgentProfileV2 pin; if no authenticated profile pin is available,
BYO credential authorization is unavailable. Only the opaque derived references,
fixed provider operation digest/destination/purpose, and bounded expiry reach the
in-process SecretBroker authorization call; secret bytes and the issued lease never
cross RPC.
The broker durably commits `ISSUED → CONSUMED` before one request, rechecks
version/revocation immediately before use, and never reuses a consumed lease.

Trusted provider-route projections may request at most 16 configured provider IDs
and receive at most 256 metadata records. They receive only `AVAILABLE`
metadata; no store locator or credential bytes are returned. HorizonCode search
maps only the fixed BYO route IDs (`brave`, `exa`, `youcom`, `tavily`,
`firecrawl`, `parallel`) from the broker-owned `providerId`. The projection
omits a route when its metadata is unavailable, revoked, unsupported, or
ambiguous because multiple references are active. It never selects an account
or creates authorization: a separate P1 Guard decision and one-use lease are
required before transport. A broker lookup failure yields an empty BYO map so
configured keyless search routes remain eligible.
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
  profileDigest: SourceDigest; providerID: ProviderId; modelID: ModelId;
  profileTokenBudget: DecimalU64 | null; criteriaIDs: StableId[];
  workspaceLeaseID: LeaseId; sourceRevision: SourceDigest;
  capabilityCeilingDigest: SourceDigest; contextSelectionDigest: SourceDigest;
  budgetLeaseID: LeaseId; resourceLeaseIDs: LeaseId[];
  ownerEpoch: DecimalU64; admittedManagedRevision: DecimalU64;
}
```

For usage projection, the first-party V2 Assistant message and `Step.Ended` event carry `UsageProvenance` (owned by `packages/schema/src/session-message.ts`): selected provider/model identity, optional provider request ID, cost metric, and input/output/reasoning/cache token metrics. Each metric is explicitly `provider-reported`, `measured`, `estimated` with a finite nonnegative value, or `unknown` with no value. Token counts are canonical `DecimalU64` strings in JSON and are `provider-reported` when supplied by the selected provider response; they are never inferred from absent fields. Cost remains a finite nonnegative decimal in this projection. A reported cost binds to provider response/request identity. A locally computed cost is `estimated`, never `measured`; it requires all token inputs and all price components, records the exact component prices/source and algorithm `per-million-linear-v1`. Its `pricingRevision` is SHA-256 over `horizoncode.managed-pricing.v1\\0` followed by the four price components in input/output/cacheRead/cacheWrite order, each represented as the canonical unsigned integer `price × 10^18` and followed by NUL. Rust recomputes this digest and the estimated micro-dollar total from those prices and token inputs using checked arithmetic and conservative ceiling; Core's floating point display estimate does not set the durable ledger amount. Price components needing more than 18 decimal places are unavailable for managed accounting. Until a real billing/receipt measurement source exists, measured cost is unavailable. Missing provider fields or pricing snapshots remain unknown. Legacy scalar columns/events may be replayed for compatibility but are never promoted to measured provenance and must not override an explicit unknown status.

The binding is immutable for the Attempt and minted only from authenticated transport identity plus accepted SpecVersion, registered profile, authorized criterion subset, current workspace/source lease, capability policy, bounded context selection and budget/resource lease owners. `admittedManagedRevision` is the exact owner revision atomically containing the admitted Attempt and binding; it is immutable audit lineage. No request field can populate or override these values. Missing owner state, profile/context identity, or any required lease rejects managed admission; fixtures that previously omitted a binding must be migrated rather than grandfathered into dispatch. Each effect admission checks the request envelope's current `expectedManagedRevision` against durable owner state, and resolves every binding reference against live durable state immediately before preparation and again before dispatch/recovery. The immutable admitted revision is not required to equal later revisions created by receipts/evidence. Revoked/expired leases, mismatched epochs, stale current source, capability changes, duplicate/out-of-scope criteria, or resource lease mismatch reject before dispatch. Cancellation fences new work; restart/reconciliation preserves unresolved effects as UNKNOWN and does not recreate the binding or replay a non-idempotent action. Direct-mode delegation without an Attempt uses existing direct policy and cannot settle managed state.

V1 proof ownership is explicit: Core Config owns mutable `AgentProfileV2` definitions/revisions; Core `ContextService` compiles `ContextSelectionV1` from canonical Session/context sources, while `ContextLedgerV2` remains a read-only projection. Core resolves `source=user` profiles only inside the authenticated ServerAuth subject's owned profile namespace. At Task creation, authenticated Core ingress supplies `profileSelection: {profileId, revision}` with a canonical decimal revision plus the strict digest-free canonical definition; HostKernel verifies the selection matches the definition, computes the digest, and persists immutable `ProfileRevisionRef` plus `ProfileOwnerBindingV1` on the Task before dispatch. `ProfileOwnerBindingV1` is either the explicit built-in class or a domain-separated digest of the authenticated subject for a user profile; no raw identity or body-supplied owner is stored. Project/plugin/external trust is unavailable until its trust resolver exists. Attempt admission resolves that exact revision and definition and requires the same bound user owner; it cannot select or replace the Task pin. HostKernel/Rust validates the authenticated principal and exact Task profile pin plus accepted Spec selection, recomputes canonical profile/binding digests, intersects the profile capability IDs with Task/Spec scope and current Guard policy, resolves live workspace/budget/resource leases, then mints the opaque typed proof and atomically stores only immutable per-Attempt refs/digests in the binding. Caller-supplied digests, a profile permission ceiling alone, the ContextLedger projection, or a copied transcript cannot mint authority. Missing/stale/mismatched proofs deny before preparation and leave OwnerLog unchanged.

`ContextSelectionV1` is a strict discriminated V1 DTO with `lane: "direct" | "managed"`, `schemaVersion`, child `sessionID`, Core-minted `requestID`, mode, canonical decimal-string Session event-cursor `sourceRevision`, and at most 64 ordered sources. Managed selections additionally require paired `attemptID`/positive decimal-string `requestSequence` (1–1024); direct selections reject both fields. Every selection contains exactly one `provider-input` ref with Core-prompt-compiler authority, `mixed` aggregate trust, `current_request` inclusion, and the Core BLAKE3 digest of the exact normalized provider-visible system/messages/tool definitions. Its `sourceID` equals `requestID`; for direct, its `sourceRevision` equals the Session cursor; for managed, it equals `requestSequence`. Every direct selection also requires exactly one active Core Config `agent-profile` ref (profile revision is a decimal string); this is the profile whose selected provider/model/account/harness and policy pins authorize the direct route. Managed selections require exactly one Rust-verifiable Task, accepted Spec and Task-pinned profile ref. Tool refs contain one `toolset:<harnessID>` manifest with positive decimal-string `harnessRevision`, followed by at most 32 sorted canonical capability IDs and BLAKE3 schema digests. Rust independently recomputes `horizon.toolset.v1` from the manifest harness ID/revision and those exact ordered members; a claimed generation digest cannot stand in for the members.

Ownership differs by lane. For direct work, Core `ContextService` compiles the selection and Core `SessionStore` atomically pins its full DTO/digest, source cursor, selected route and policy revisions, and exact normalized provider-input digest before transport. Core dispatches the same immutable provider-input object whose digest it pinned; direct provider inference does not require a per-request HostKernel bind/advance round trip. For managed work, Core holds the immutable compiled request while HostKernel validates its refs against the live Attempt and OwnerLog, computes the domain-separated canonical MessagePack BLAKE3 over the full ordered DTO, persists the reference-only selection, and returns the exact request ID/sequence/digest receipt. Core dispatches only the same frozen payload after receipt match. Rust persists managed refs and digest, never prompt/transcript text; this reference-only seam cannot inspect provider bytes, so mismatched or mutable Core payload remains undispatched. JSON schema and each lane's decoder reject extra fields, invalid kind/authority pairs, duplicate refs, invalid source provenance, missing provider-input and out-of-bound counters. Every u64 cursor/sequence uses a canonical decimal string; opaque owner-issued revisions remain bounded strings. The inference authorization decision is §17.26; this DTO is integrity/provenance and never grants tool/effect authority.

Managed effect scope is explicit and reviewable: `SpecVersionV1.capabilityScope` is a proposal field covered by the immutable digest and shown to the distinct authenticated reviewer. `TaskV1.requiredCapabilities` must be a canonical-ID subset of that accepted list. Reject aliases, unknown IDs, duplicates, unsorted wire values, widening and over-limit arrays. Do not infer capability IDs from prose, path globs or constraints. The effective ceiling is `Task.requiredCapabilities ∩ accepted SpecVersion.capabilityScope ∩ profile.capabilityCeiling ∩ current Guard policy`; an empty intersection means no effect. This ceiling never substitutes for per-operation Guard decision, current workspace checks or a one-use effect lease.

`contracts-v2/capability-registry-v1.json` is only a design-time canonical-ID/alias seed. It may support syntax/alias validation but never proves runtime availability or grants authority. Dispatch additionally requires the current P1 Guard to resolve an actually registered, implemented capability under current policy; design-only, missing or unsupported IDs remain unavailable.

The schema/fixture owner is `contracts-v2/delegation-binding-v1.schema.json` with a shared golden fixture consumed by the Rust protocol decoder tests. The private IPC representation uses canonical decimal strings for every unsigned 64-bit value (including `profileRevision`, `ownerEpoch`, `admittedManagedRevision`, and the envelope's current `expectedManagedRevision`) so future TypeScript projections preserve values above 2^53; identifiers and digests are bounded strings, arrays are sorted and unique where order is not semantic, and unknown fields are rejected. The binding digest is domain-separated BLAKE3 over the exact canonical MessagePack map after validation; the shared fixture fixes field names, decimal spelling, map ordering and digest bytes. Do not hash a reserialized or partially validated caller map. This binding is the immutable managed scope referenced by the smaller `ManagedAttemptScopeV1` request envelope, which carries the current expected revision and binding digest. The envelope alone never authorizes a managed effect. Neither shape is a public SDK/OpenAPI endpoint.

Managed provider usage is appended through the authenticated private `managed.record_usage` operation before Core requests another model step. For a managed effectful provider ToolBatch, Core first completes bounded batch parsing and validation, then durably accounts the exact provider step before any Guard preparation or effect lease is requested; STOPPED, uncertain, or missing accounting authority withholds the entire effect batch before Guard. The later `step-finish` projection reuses that receipt and must not account the step twice. Core supplies only the exact live `ManagedAttemptScopeV1`, persisted assistant message ID, LLM `step-finish` index, and strict `UsageProvenance`; Rust derives `operationKey = "managed_usage_" + hex(BLAKE3(attemptID || NUL || assistantMessageID || NUL || decimal(stepFinishIndex)))` and `usageDigest = BLAKE3("horizoncode.managed-provider-usage.v1\0" || canonical-json({attemptID,assistantMessageID,stepFinishIndex,usageProvenance}))`. Both values are stored in the OwnerLog and replayed idempotently. The receipt contains ACCOUNTED/STOPPED, the new managed revision/accounting cursor, cumulative token total and conservatively rounded-up integer cost micros, per-metric provenance statuses, pinned provider/model and request identity, effective-ceiling digest and receipt digest. Token usage counts the provider's input plus output totals once; reasoning and cache metrics remain separately recorded provenance because they are components of those totals. The effective token ceiling is `min(accepted SpecVersion.maxTokens, pinned AgentProfileV2.limits.tokenBudget)` for the values present; monetary ceiling comes only from accepted `SpecVersion.maxCostMicros`. Cost is never inferred from caller totals. Rust stops before the next provider dispatch when a ceiling is reached or UNKNOWN/ESTIMATED provenance prevents safe accounting under an applicable ceiling. A `measured` cost is accepted only when HostKernel verifies its provider billing receipt evidence; merely shaped caller data is insufficient.

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
request carries only a relative path, an explicit revision domain, the exact expected
revision for that domain and a byte limit of at most 131,072 UTF-8 bytes. `workspace`
uses the strict workspace revision used by mutation/checkpoint authority;
`discovery_observation` uses the no-follow inventory revision for manifest reads. The
HostKernel never infers or downgrades the selected domain. Principal, Session, Location,
read policy and workspace root are authenticated out of band or HostKernel-derived.
HostKernel enforces current Guard `files.read`, registered Location ownership, no-follow
path traversal, regular-file and UTF-8 checks, cancellation, and exact pre/post revision
in the selected domain. The response returns the normalized relative path, the same
revision domain, text, BLAKE3 content digest and observed revision.

```ts
type RepoDocumentReadRequestV1 = {
  schemaVersion: 1; pathRef: WorkspacePathRef;
  revisionKind: "workspace" | "discovery_observation";
  expectedWorkspaceRevision: SourceRevision; maxBytes: 1..131072;
}
type RepoDocumentReadResponseV1 = {
  schemaVersion: 1; status: "OK"; pathRef: WorkspacePathRef; text: string;
  revisionKind: "workspace" | "discovery_observation";
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

The first managed V1 vertical contains one coding Task and one Attempt. The Attempt remains live/EXECUTING from admission through the coding action and independent verification. When the child prompt returns, Core first persists the durable child Session outcome and Rust records `managed_dispatch_quiesced` while the Attempt is still EXECUTING and the Task is PENDING_VERIFICATION. This marker proves only that the coding callback returned; it does not settle the Attempt or prove acceptance. A separate, separately authorized verifier EffectIntent runs under that exact Attempt. Once typed evidence for the actual current workspace head is durable, P2 advances the Attempt to SETTLING and Task to Verified. A typed settlement-candidate projection is available at that point for P8 to pin the final guarded Inspect. After the exact Inspect receipt is durable, P2 settles the Attempt to Succeeded and publishes the terminal projection; P8 settles the worker only from that terminal projection plus the exact Inspect receipt. The candidate projection and terminal projection are distinct so the Inspect prerequisite does not depend on an already-terminal Attempt. Verification is not a synthetic Task or an exception to Attempt scope.

The final Inspect may observe `CLEAN` or exact `DIRTY_OWNED` at the verifier-pinned final revision, provided the worktree is owned, no-follow inspection succeeds, and no user-owned changes are present. `DIRTY_OWNED` is valid evidence for settlement but never makes the worktree reusable: P8 must return its durable quarantine disposition. `DIRTY_UNATTRIBUTED`, `MISSING`, `UNKNOWN`, a changed revision, or any user-owned change cannot settle success. See JC-RES-021/021.A/B and §37.22.

The initial V1 managed vertical accepts exactly one coding Task per Run, and that Task must
cover the accepted criteria set. This is the prerequisite for expanding to V1's bounded DAG
scope under DEC-V1-31. The canonical Rust reducer and Core plan ingress must keep new
multi-Task admission unavailable until each Task has independent exact-revision evidence,
conflict-safe lease/recovery semantics, and the Run has a durable aggregate settlement
contract; then multi-Task plans are required V1 capability. Historical OwnerLog entries
remain replayable for recovery. The single-Task verifier effect lifecycle in this section
is reused per Task; aggregate settlement is Rust-owned and cannot infer PASS from child text.

`begin_verification` is also the idempotent recovery entry after Core restart. It returns `NEEDS_APPROVAL` only for the exact still-awaiting challenge set, and `RESUME_EXECUTION` for the same authenticated reviewer/owner epoch/spec/final-revision challenge set when Guard approval is durable but no verifier execution identity has been recorded; the latter carries no old challenge lease or approval object. If HostKernel has already durably recorded complete typed evidence for the same SETTLING Attempt and verifier run, it returns `SETTLING` with the original verification-run/set digests, evidence/artifact projection, settlement candidate and trusted `approvalLocation`, without recreating a challenge or dispatching a verifier. A partially dispatched set without complete evidence, UNKNOWN set, mismatched revision, stale epoch, or missing receipt remains unavailable/reconciliation-only. `approvalLocation` is exactly `{locationID, workspaceID, canonicalRoot, workspaceRevision}` from the registered Attempt child Location, with `workspaceRevision` equal to frozen `finalRevision`; Core must not substitute the root Session or a request path.

Every `begin_verification` response uses the strict `VerifierChallengeSetResponseV1` DTO in
`contracts-v2/verifier-challenge-set-response-v1.schema.json`. Its common identity pins are
`schemaVersion` (JSON integer `1`), `goalID`, `runID`, `taskID`, `attemptID`, `ownerEpoch`,
`specID`, `specDigest`, `profileID`, `profileRevision`, `profileDigest`, `finalRevision`,
`evidencePlanDigest`, `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`.
IDs, revisions, and digests are strings; `ownerEpoch` and `profileRevision` are canonical
positive unsigned decimal strings, not JSON numbers. The HostKernel derives every pin from
authenticated OwnerLog, accepted SpecVersion, verifier registry, registered Location, and
current owner fence. Core must compare every pin with persisted admission authority and must
reject unknown fields, missing pins, malformed decimals/digests, or any mismatch. P8 terminal
settlement and recovery receipts must also echo `verificationRunID`, `setIdentityDigest`, and
`challengeSetDigest`; HostKernel strictly compares all three with the unique persisted
ChallengeSet before terminal settlement. No response or receipt lets Core assert verifier
identity or completion.

Each accepted planned Task also pins immutable `title` and `purpose` text used to construct its child prompt. `title` is non-empty and at most 256 UTF-8 bytes; `purpose` is non-empty and at most 8192 UTF-8 bytes. The exact strings are persisted and included in the canonical Task-plan digest. These fields are descriptive input only: they grant no permission, capability, provider/model choice, scope, or review authority. Legacy plans without both fields remain replayable but cannot be newly started or dispatched.

The prompt-return receipt binds the acknowledged SessionProjection `{seq,eventDigest}` as its event proof. The distinct `childSessionStateDigest` is BLAKE3 over domain `horizoncode.managed-child-session-state.v1\0` followed by ordered UTF-8 fields `["1", sessionID, parentSessionID, goalID, runID, taskID, attemptID, ownerEpoch, "RETURNED", outcomeKind, cursorSeq, cursorEventDigest, handoffDigest, consumeReceiptDigest, outputDigest, outputBytes]`; every field is prefixed by its 8-byte unsigned big-endian byte length. `outcomeKind` is exactly `assistant_completed`, `assistant_error`, or `tool_error`. Core derives these fields from the durable child metadata receipt and acknowledged Rust cursor, never by rebuilding transcript text. The completion delivery ID is stable across restart/retry: `managed_dispatch_` plus full lowercase SHA-256 hex over domain `horizoncode.managed-completion-delivery.v1\0` and u64-BE length-prefixed Attempt ID, handoff digest, and consume receipt digest. HostKernel recomputes the child-state digest from authenticated child facts before appending quiescence. Definite provider/tool error returns are quiesced as non-success outcomes; only `assistant_completed` can contribute candidate evidence. A thrown or interrupted prompt without a definite callback return remains ambiguous and cannot be replayed.

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

For new managed ToolBatch waves, append versioned `attempt_effect_wave_bound` after approval and
before any lease becomes consumable (DEC-V1-30). New writes use schemaVersion 2 and bind the live
Run/Task/Attempt, HostKernel batch ID, wave index, registered Session/Location, authenticated
pre-append `sourceScopeDigest`, and ordered 1–32 edges. Each edge carries
`{callIndex,callID,effectID,capabilityID,argumentsDigest,intentDigest,attemptScopeDigest}`;
`attemptScopeDigest` pins the exact post-append Attempt scope used by that effect's lease and
process row, while `sourceScopeDigest` remains the earlier scope that admitted the wave.
`argumentsDigest` hashes canonical arguments; `intentDigest` hashes the complete immutable
EffectIntent, including its capability/resource/risk/policy/scope bindings. The owner recomputes
both and the schemaVersion-2 domain-separated `waveDigest`; no arguments or secrets enter
OwnerLog. After append, HostKernel revalidates the post-append scope before making each one-use
lease consumable. Recovery supplies exact per-effect `(batchID,callIndex,callID,effectID,
attemptScopeDigest)` selectors to EffectHost and accepts only exact terminal receipt rows.
Exact delivery retries return the original result; changed retries conflict. SchemaVersion 1
remains replay-readable without a refreshed scope pin and cannot authorize new waves. The machine
contracts are `contracts-v2/attempt-effect-wave-bound-v1.schema.json` (legacy replay) and
`contracts-v2/attempt-effect-wave-bound-v2.schema.json` (new writes). Legacy
`attempt_effects_bound` remains replay-readable but cannot authorize a new guarded wave. Direct
Sessions continue to use DirectTurnJournal.

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

The HostKernel control sequence is `execution.resolve_launch_profile` with the exact
Core projection plus `locationID`, `sessionID`, `userActionID`, `callID`, and optional
authenticated Attempt scope. That operation returns the canonical Guard approval
challenge and `profileRef`; executable paths and argv are never returned. After the
existing approval/lease flow, `execution.prepare` and `execution.launch` accept only
the `profileRef` alongside effect/challenge/lease and Session/Location/Attempt pins.
HostKernel re-resolves the installation selector and digest at preflight and again
before spawn. The LSP effect ID is the catalog's canonical `language.start`.
The source path is present; it remains unverified until the later P1 checks exercise
challenge approval, stale refs, restart, cancellation, and UNKNOWN.

The strict machine contract is
`contracts-v2/execution-launch-profile-v1.schema.json`; Rust and TypeScript decoders
must share golden fixtures before launch is enabled.

## 12.21 Direct-session grants and CodeMode budget contracts (DEC-V1-28/29)

Direct-session approval posture is the separate `DirectSessionPermissionModeV1`
projection in `contracts-v2/direct-session-permission-mode-v1.schema.json`.
The default and **Ask for approval** preset are `workspace-write` plus
`on-request`; **Full access** is `danger-full-access` plus `never` and requires
an explicit user choice for the current Session. `always` prompts before each
effect, `on-request` prompts only when the selected sandbox boundary is crossed,
and `never` does not prompt for actions inside the selected sandbox. Sandbox
scope and prompt frequency are resolved independently. This mode is separate
from the narrower reusable `DirectSessionGrantV1` below. It is a user policy
input to Rust Guard, not a lease or authorization token; normal authenticated
scope, budgets, intent, one-use lease, ExecutionHost, receipt and UNKNOWN rules
still apply. Full access means there is no HorizonCode filesystem or network
sandbox; it does not claim containment. Managed Attempts do not inherit it.
Provider/search charges retain their separate explicit-cost consent.

`DirectSessionGrantV1` is an authenticated user's persisted choice for bounded direct
Session effects. It is separate from the AgentProfile permission ceiling, a managed
Run grant, and `FreshTurnAuthorizationV1`. Its issuer/principal is resolved from
authenticated host identity, never accepted from a model or request field. The grant
pins its scope kind; authenticated principal; exact Session and owner epoch for session
grants; registered Location/workspace/root digest; allowed canonical capabilities and
normalized action/resource classes; finite per-call and aggregate limits; execution
backend, guarantee-set digest and current policy digest; issue/expiry timestamps; and
revocation state plus canonical grant digest. Profile selection is not grant authority:
each effect also intersects the grant with the current profile ceiling and Guard policy.
`grantDigest` is `BLAKE3("horizoncode.direct-session-grant.v1\\0" ||
encodeCanonicalMessagePackV1(schema-decoded immutable grant claims))`; omit
`grantDigest` and mutable `revocation` from the hashed projection. Grant issue and revoke
are stored in the existing canonical Rust Guard/EffectHost append-only durable authority
journal, distinct from managed Attempt OwnerLog and the sole writer for these grants.
Revocation is a separate monotonic journal transition keyed by grant ID and cannot
rewrite the issued grant. `policyDigest` is a BLAKE3 digest string, not a numeric counter.
Session grants end on Session replacement/close or any principal, owner-epoch, Location,
workspace-root, backend, guarantee-set or policy-digest change. Workspace grants are
explicit user-owned settings with at most a 30-day lifetime and the same workspace pins.
An immutable deny always wins; stale/missing guarantee or any pin mismatch disables the
grant before dispatch. Revoking a grant prevents later dispatch but does not erase or
reverse an already dispatched effect. Its schema is
`contracts-v2/direct-session-grant-v1.schema.json`.
Before approval UI, Core may call the private
`effects.v1/preflight_direct_session_grant_batch` with exactly
`{sessionID, locationID, batchID, challengeIDs}` for the complete ordered challenge set.
The strict `DirectSessionGrantPreflightV1` response is exactly
`{batchID, challengeSetDigest, status}`, where status is `eligible` or
`prompt_required`; the HostKernel-computed challenge-set digest is correlation data only.
It is `BLAKE3("horizoncode.direct-grant-challenge-set.v1\\0" ||
encodeCanonicalMessagePackV1(orderedChallengeIDs))`; Core computes and compares the same
digest from its validated request IDs, while HostKernel independently resolves retained
challenge bindings.
Its request/response schema is
`contracts-v2/direct-session-grant-preflight-v1.schema.json`. This read-only operation
does not authorize or mutate anything. A managed Attempt always returns
`prompt_required`; an error or malformed/mismatched response is also treated as
prompt-required. The subsequent atomic approval-set operation must revalidate the same
complete challenge set and fresh authority before reserving grant use or issuing leases.

For one root direct-Session typed LSP/DAP operation, the analogous read-only
`effects.v1/preflight_direct_session_grant_protocol_effect` accepts exactly
`{sessionID, locationID, challengeID}` and returns exactly
`{challengeID, challengeSetDigest, status}`. `challengeSetDigest` uses the same
`horizoncode.direct-grant-challenge-set.v1\0` domain over the canonical MessagePack
singleton `[challengeID]`. It is candidate correlation only. HostKernel derives and
revalidates the retained typed authorization, live process/generation/owner epoch,
journal sequence, current workspace and grant pins. Only read-only LSP queries and DAP
inspection can be candidates; managed Attempts, callbacks and mutating protocol
operations remain prompt-required. Auto-resolution echoes the exact digest as optional
`grantPreflightDigest` on `resolve_approval`; Rust then revalidates/reserves the grant
before normal Guard approval and one-use lease. Any mismatch or stale candidate returns
to the prompt. Explicit user `allow_once` omits the marker. The strict contract is
`contracts-v2/direct-session-protocol-grant-preflight-v1.schema.json`.

Root direct-Session editor setup may obtain current scope pins through
`execution.v1/direct_session_workspace_snapshot` with exactly
`{sessionID, locationID}`. HostKernel returns those identifiers plus decimal-string
`ownerEpoch`, current `workspaceRevision`, `workspaceRootDigest` and
`observedAtUnixMs`, all derived from authenticated owner and registered Location state.
This read-only snapshot is not authority: every launch and protocol operation must
revalidate current pins and pass Guard, lease and receipt admission. The strict contract
is `contracts-v2/direct-session-workspace-snapshot-v1.schema.json`.

**Trusted workspace command profiles (2026-10-22, DEC-V1-28).** Build/test grant scope is
bound to one or more user-owned immutable `WorkspaceCommandProfileV1` references, each
`{profileId, revision, profileDigest, action}`. `action` is exactly `build` or `test`;
the same profile reference cannot authorize both unless the profile explicitly declares
both actions. The grant contains no command text, shell string, executable path, or argv
from the model. The canonical profile definition is
`contracts-v2/workspace-command-profile-v1.schema.json`; Core Config owns the persisted
definition, while HostKernel validates its authenticated projection and recomputes the
digest before granting. Missing, disabled, mutable, project-supplied, stale, or
unaccepted profiles make that action ineligible for a quiet grant and leave it on the
ordinary Guard approval path. No OS limit is represented as enforced unless the selected
ExecutionHost backend proves it before process start.
Core/TUI receives only the derived `DirectSessionGrantChangedV1` event (opaque grant ID,
digest, nonsecret bounded scope summary, expiry/status, source generation and monotonic
sequence); it never receives issuer identity from a request body. The event shape is
`contracts-v2/direct-session-grant-event-v1.schema.json` and cannot authorize a Guard decision.

`CodeModeExecutionV1` is a request to orchestrate tools already present in the current
authorized tool tree. Its model arguments contain only bounded script/input; authenticated
Session/request/Attempt correlation, enablement, Spec/profile and runtime pins come from the
trusted host and never appear in model arguments. It carries no capability list, executable,
provider, route, credential, workspace path, permission or issuer field. The trusted Core host supplies the current authorized tool definitions
and dispatcher. One run has at most 64 nested calls in complete atomic ToolBatch waves of at most
32; it shares a trusted 30,000 ms monotonic deadline, 65,536 aggregate output bytes, 65,536 UTF-8
source bytes, 524,288 aggregate serialized argument bytes per wave, 1,048,576 script-total
aggregate serialized argument bytes and one cancellation identity. Each call retains
its own effect identity, lease, receipt and possible UNKNOWN outcome. A bounded pure-computation
script may complete with zero nested calls: its result has `waves=[]` and `totalCalls=0`, with no
nested-effect receipt or aggregate nested `receiptDigest`. The outer helper process remains an
ordinary Guarded process effect and retains its normal process-effect receipt. If one or more
nested calls occur, every wave must settle with its exact per-call receipts and the result carries
an aggregate `receiptDigest` over those receipts in wave/call order. Each wave digest is
`BLAKE3("horizoncode.codemode-wave-receipts.v2\\0" || encodeCanonicalMessagePackV1([[waveIndex,
callIndex, callId, status, receiptKind, receiptRef, receiptDigest], ...]))`; the run digest is
`BLAKE3("horizoncode.codemode-receipts.v2\\0" || encodeCanonicalMessagePackV1([[waveIndex,
callIndex, callId, status, receiptKind, receiptRef, receiptDigest], ...]))`, with entries ordered
by ascending wave index then call order. Each execution `wave.callOutcomes[i]` must correspond exactly
to `wave.calls[i]` by count, order and `callId`; each known terminal outcome (`settled`,
`rejected`, or `cancelled`) carries its own `receiptRef` and `receiptDigest`. An `unknown` outcome
carries neither, forces the wave and execution result to `unknown`, and forbids wave/run aggregate
receipt digests. Every non-UNKNOWN terminal wave (including rejected or cancelled outcomes) has
its ordered aggregate receipt digest, and every non-UNKNOWN nonempty execution has its run digest.
A result containing UNKNOWN is never labelled settled or completed; later waves
stop until authoritative reconciliation, and recovery never infers settlement from helper output.
For a zero-call pure computation, both receipt levels remain absent.

The private worker protocol uses newline-terminated JSON frames capped at 2,097,152 UTF-8 bytes
each. The serialized `tools` array in `start` is separately capped at 1,048,576 UTF-8 bytes;
the entire encoded `start` frame must still fit the 2 MiB frame cap. `toolDefinitionsBytes` is a
host-computed count over the canonical JSON serialization of the exact ordered tool array and is
recomputed by the receiver. Serialized arguments are capped at 262,144 bytes per call,
524,288 bytes per wave and 1,048,576 bytes across the script. These caps are independent of
the frame and tool-definition limits. JSON Schema `maxLength` counts characters, so it is only a structural bound:
strict receivers recompute UTF-8 byte counts for source, tool definitions, arguments, outputs and
serialized frames. The existing Rust `CodeModeFrameV1` framed codec is the sole validator for
serialized frame bytes and structural depth/node bounds before helper launch; no second validator
may use different limits. These limits are normative even where implementation wiring remains
unavailable pending §32.41 acceptance.

**Lane enablement.** Direct exposure requires an explicit authenticated user enablement
represented by `CodeModeEnablementV1`, bound to the authenticated principal, Session and owner
epoch, `codemode.execute`, fixed helper selector and resolved helper digest, exact
`CodeModeResourceProfileV1` ID/digest, backend and guarantee digest, current policy digest,
expiry, revocation generation and `enablementDigest`. Principal/session/backend identities are
host-derived, never caller asserted. `enablementDigest` is BLAKE3 over
`horizoncode.codemode-enablement.v1\0` plus canonical MessagePack of immutable direct claims,
excluding the digest and mutable revocation generation. It authorizes only this helper/profile in that Session;
nested effects still need the ordinary direct-session grant or exact `allow_once` approval.
Managed execution does not accept a direct grant: HostKernel requires the accepted SpecVersion's
explicit `codemode.execute` capability, the Task-pinned AgentProfileV2 ceiling, exact fixed
resource-profile ID/digest and live Attempt/owner epoch before launch. Missing, stale or
mismatched lane proof denies before spawn. No enablement token is model input.

Machine contracts are `contracts-v2/codemode-enablement-v1.schema.json`,
`contracts-v2/codemode-execution-v1.schema.json`,
`contracts-v2/codemode-worker-message-v1.schema.json`. The execution schema defines both the
request and result. The worker protocol uses bounded versioned
stdio frames: Core sends `start`, `wave_result` and `cancel`; the helper sends a complete `wave_request` and
`completed` outcome. Sequence numbers and request/call IDs are host-generated and strictly checked.
Core validates a complete wave, calls the existing SessionSupervisor ToolBatch path with the
authenticated direct-turn or managed Attempt scope, and returns results only after exact receipt or
UNKNOWN settlement. The helper cannot choose identity, authority, runtime, paths, environment,
network or budget. The existing interpreter runs only in a short-lived helper process launched and
supervised by the existing Rust ExecutionHost. Its packaged runtime is selected only by the trusted
`horizoncode:codemode:bun` selector; V1 has no runtime fallback. HostKernel applies the fixed,
schema-versioned `CodeModeResourceProfileV1` before the first instruction: cgroup-v2
`memory.max=536870912`, `cpu.max=100000 100000`, `pids.max=64`, and `nofile=256`. Every limit is
mandatory. The profile digest covers its schema version and exact values. If any
required OS limit cannot be applied and verified, CodeMode remains unavailable on that backend.
Waves are sequential: calls issued concurrently by one interpreter scheduling turn are collected
into one atomic ToolBatch (maximum 32); calls depending on an earlier result form a later wave.
There may be up to 64 waves, but no more than 64 calls over the entire script. A wave is not
dispatchable until every call is validated; each later wave waits for prior receipts and fresh
scope validation. The authorized tree may include existing MCP adapters only when those adapters
route through this same Core dispatcher; the helper receives no raw MCP client or direct MCP
transport. Without a
supported packaged runtime and verified OS-enforced containment, CodeMode remains unavailable on
that backend. This adds neither a second interpreter nor supervisor. Expose `codemode.execute` only
after the stdio protocol, Guarded dispatcher, cancellation/reap and receipt recovery are wired;
§32.41 CM-001..CM-012 is integrated release acceptance.

The helper OS profile is `contracts-v2/codemode-resource-profile-v1.schema.json`. HostKernel
selects it from fixed trusted V1 policy; it is not supplied in model input or private helper frames.

Managed ToolBatch wave binding is defined in §12.19. Legacy replay uses
`contracts-v2/attempt-effect-wave-bound-v1.schema.json`; new writes use
`contracts-v2/attempt-effect-wave-bound-v2.schema.json` (see §12.19).

The private helper's `inputSchemaDigest` is BLAKE3 over the existing
`horizon.tool-schema.v1\0` domain plus canonical JSON of the strict schema-decoded
`inputSchema`. `toolSetDigest` is BLAKE3 over
`horizoncode.codemode-toolset.v1\0` plus canonical MessagePack of the strict schema-decoded
`tools` array. Core sorts that array by UTF-8 byte order of `(capabilityId, toolName)` and
includes exactly `toolName`, `capabilityId`, `description`, `inputSchema`, and
`inputSchemaDigest` for each member. Rust recomputes both digests before accepting the start
frame. This digest identifies the exact authorized helper projection; Guard still resolves
each nested capability independently.

The immutable verifier intent and its Guard lease are separate ordered records. Before approval, HostKernel may retain a challenge-bound candidate containing the exact verifier profile/executable/criterion/arguments/current-head facts for reviewer display; this candidate is not an Attempt mutation, lease or dispatch authority. After approval by the authenticated distinct reviewer, atomically bind the exact Attempt edge and immutable intent without a lease digest, refresh `ManagedAttemptScopeV1` to the resulting aggregate OwnerLog revision, revalidate the approval and current managed/workspace fence, and only then issue the one-use lease. Do not append the lease digest to the managed log before dispatch, which would invalidate the revision used to admit the lease. EffectHost owns durable one-use consumption; the HostKernel-authenticated settled receipt durably records the exact lease digest. Revalidate the aggregate revision and workspace head at approval and dispatch; intervening changes expire/fence the authorization and require reconciliation/new authorization, never rebase. The approval principal is the authenticated distinct reviewer; the supervised child identity is the trusted verifier profile principal.

Attempt/Task/Run success is forbidden until every required criterion has current-revision evidence. Verifier failure settles as failure/needs-you according to the accepted contract; process exit or model self-report alone never gives PASS. Crash, cancellation after possible dispatch, lost receipt, stale revision, partial artifact capture or owner-epoch change leaves the effect and Attempt UNKNOWN/reconciliation-only. Recovery may inspect the same persisted identity and receipt/target evidence but never relaunches the verifier automatically. A new execution needs reconciled state and new authorization. P1/P2 own this lifecycle; P7 owns immutable artifact metadata. See §§3.22, 14.3, 37.22 and 32.38.

## 12.22 User-owned external editor profiles (DEC-V1-33)

Core Config owns immutable `ExternalEditorLaunchProfileV1` definitions and revisions.
The profile contains a user-selected executable selector, literal argv tokens, one
target-argument insertion index, a launch mode (`foreground_tty` or `wait`), and a
target class (`prompt_scratch` or `workspace_file`). It contains no shell command,
interpolation syntax, environment values, working-directory override, or model-selected
path. The exact target is selected by the user in the TUI and is passed as one argv token
at the declared index. HostKernel resolves the executable and digest from authenticated
Core Config, derives the registered Location root and current owner/workspace pins, and
mints the process identity. A stale profile, executable digest, target revision, or
permission-mode digest fails before launch.

`profileDigest` is
`BLAKE3("horizoncode.external-editor-profile.v1\\0" || encodeCanonicalMessagePackV1(schema-decoded profile definition))`;
the strict profile definition excludes its ref/digest and mutable runtime state.

`foreground_tty` is for terminal editors: the TUI suspends rendering, the supervised
editor owns the terminal until exit, then the TUI resumes. `wait` is for GUI launchers
configured by the user with an editor-specific wait flag; the supervisor retains and
reconciles that exact process until the user closes the file. A profile that returns
early while handing work to an untracked daemon is rejected for workspace editing.

Prompt editing targets a bounded private scratch file and imports its content only after
the supervised process exits successfully. Workspace editing is restricted to one
user-selected regular file and one pinned base revision. HostKernel copies that file to
a private per-launch scratch directory, and the editor receives only the scratch path.
After a known successful close, Core reads the bounded result, verifies that the current
workspace revision and original file digest still match the pinned preview, then applies
the change through the ordinary Guarded `files.patch` path. The editor cannot mutate the
workspace directly. Under `workspace-write`, HostKernel must verify OS-enforced process
containment before execution; otherwise this mode is unavailable for external workspace
editors on that backend. Under explicit Full access, the user-selected editor runs
without HorizonCode sandboxing and the existing Full access warning applies. In both
modes, the model cannot launch editors or edit targets through this UI action.

Before launch, Core captures a Session-scoped base revision and HostKernel admits
`editor.launch` as the process effect. Its Guarded receipt records process and result
metadata; the later `files.patch` is a distinct Guarded workspace mutation with its own
receipt. An exclusive workspace write fence blocks concurrent agent writes until the
editor closes and patch settlement finishes.
Cancellation, process loss, malformed output, stale workspace revision,
or uncertain launch becomes a typed unavailable/conflict/UNKNOWN result and never retries
a possibly started editor. Scratch files are deleted after successful prompt import,
successful guarded patch, or failed/cancelled completion. UNKNOWN retains only the
private recovery material needed to reconcile that exact execution.

Strict definition/ref/launch-result wire shapes are owned by
`contracts-v2/external-editor-profile-v1.schema.json`; launch and file mutation remain
separate Guarded effects. The profile schema does not itself authorize execution.

