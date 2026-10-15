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

It never stores prompt/answer content as canonical Rust conversation data.

## 12.4 Managed control records

GoalV1:
- goalId, objective, project/workspace refs, createdBy;
- activeSpecVersionId;
- status and revision.

SpecVersionV1:
- specVersionId, goalId, parentVersionId optional;
- immutable objective/scope/constraints/acceptance criteria;
- budget/time/resource policy;
- source/reference digests;
- acceptedBy/acceptedAt when accepted.

RunV1:
- runId, goalId, specVersionId, sessionLink optional;
- status/revision;
- finalRevision optional;
- stop/recovery reason;
- budgets and usage refs.

TaskV1:
- taskId/runId;
- dependencies;
- scope/workspace lease request;
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

SubagentDeliveryV1 is canonical bounded child delivery envelope.

Neither rendered Markdown nor child chat is a second source of Task/Run authority.

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
- figure-block-v1.schema.json.

**Managed-event prototype incompatibility:** `contracts-v2/managed-event.schema.json` is deliberately flagged `x-horizon-runtime-wire: false` because its PascalCase `eventType` / schemaVersion 2 logical envelope is **not** the existing `kernel/src/owner_log.rs` physical format nor the current `kernel/src/managed_control.rs` snake_case event decoder. Do not feed it into a persistence writer, public SDK or generator. Future adoption requires a versioned physical/projection mapping, schema regeneration, strict negative/roundtrip fixtures, migration rules and a cross-language test against the real committed log. `control-api.openapi.json` remains a design skeleton as stated in §12.12.

Schema presence means DESIGNED only. Generated TypeScript/Rust bindings, real adapters and integration tests are still required before WIRED/VERIFIED status.

## 12.14 Compatibility

Historical ThreadV1/TurnV1/ProviderAttempt/CompactionRecord-as-Rust-conversation schemas are archived provenance only. Do not generate or persist them as V1 canonical conversation data.

Any existing code type with those names is treated as legacy/prototype until explicitly mapped to the current owner model and acceptance tests.

## 12.15 Proposed resource diagnostics and session-attachment schema mapping (A-V2-30)

Before any resource, provider-doctor, file-touch or shared-kernel endpoint is WIRED, define versioned single-owner typed schemas for `ResourceSampleV1`, `ProviderDoctorRequest/ResultV1`, `FileTouchV1` and any `VirtualSessionAttachmentV1` in `contracts-v2`, with generated TypeScript/Rust conformance tests. §37.15 contains **illustrative interfaces**, not machine-enforced schemas and not new authority.

Fields must include logical owner/epoch and measurement source; PSS/RSS/private-bytes are different metric IDs with platform/provenance (measured/estimated/unknown), optional value when unavailable and bounded history. File activity uses canonical workspace+revision, access kind, session/Attempt, time/TTL but **not** a new write permission. Provider Doctor records tier, selected endpoint/model, deadline/spend consent reference and bounded redacted outcomes. Virtual attachment binds an authenticated ingress channel and existing SessionLink/lease generation; clients cannot self-declare principal/Guard grants. Reject unsupported versions/unknown effect class and cross-session ownership confusion. These schemas must reuse existing `ActionDescriptor`, error code registry and §33 IDs.

## 12.16 Machine-contract completion rules for A-V2-30

**One schema for each wire shape.** The following is a REQUIRED design schema inventory with logical field types and version/adoption process. Before CODE_PRESENT → WIRED, add to the existing `arch_V1/contracts-v2/` generator/test pipeline, do not invent separate packages or hand-written incompatible TS/Rust wire DTOs. §37.16–17 may show interface pseudotypes; the machine-generated schema is authoritative once added.

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

**Cross-contract enum/authorization rule:** The illustrative §18.18 reservation type and §11.20 transition table must generate from **one** `resource-reservation-v1` enum; `ACTIVE`, `SOFT` and `HARD` are not alternate wire encodings. Derived pressure states are `NORMAL`, `SOFT_PRESSURE`, `HARD_PRESSURE`, `RECOVERING`. FileTouch ingestion/listing is bound to an authenticated host/Session scope even though its records are advisory. §37's typed service interfaces are not an excuse to accept a client-supplied owner epoch or WorkerBudget as authorization. Include generated Rust/TypeScript invalid-transition, lost-process, cross-principal and cancelled-owner fixtures before wiring.

**Wire canonicalization:** `schemaVersion: 1` integer, bounded UTF-8 identifiers, explicit optional vs null rules, decimal nonnegative strings for unsigned 64-bit counters, opaque source/project references rather than raw filesystem paths, byte lengths measured in UTF-8/encoded frame sizes, strict additional-properties checks at ingress, and one digest algorithm-prefix convention from the current code. Use existing `ErrorV1`/`TypedErrorV1` stable enumerants and mapping: never introduce `IDEMPOTENCY_CONFLICT`, `RESOURCE_BLOCKED` or `RECONCILING_UNKNOWN` as a persisted Blocker/code without first adding them to the canonical machine registry and proving backward-compatible decoding; functional examples may describe these only as semantic classes. Idempotent conflicting delivery is existing `CONFLICT` until a formal schema migration says otherwise.

**Contract publication protocol:** (1) add machine schema + shared fixture to `contracts-v2`; (2) generate Rust and TypeScript with pinned generator; (3) implement exact decoder/encoder with limits and reject unknown variants; (4) maintain one canonical capability ID and alias mapping in §33/catalog machine registry; (5) update private IPC feature negotiation/API spec for actual operation; (6) run cross-language valid-invalid/golden-message tests including 2^53+1 counters, wrong epoch and unsupported OS; (7) update exact source-path map, acceptance ID, HANDOFF status. A proposal in Markdown cannot substitute for these implementation steps.

**Ownership/cross-boundary invariants:** no resource observation or file-touch record becomes an ExecutionLease; no TaskDelivery payload may approve its own PASS; a provider Doctor read does not grant credential use; no virtual attachment changes canonical OpenCode Session ownership; derived UI/resource caches may be deleted without affecting durable Rust OwnerLog. Native Windows/macOS feature negotiation must truthfully report unavailable guarantees.
