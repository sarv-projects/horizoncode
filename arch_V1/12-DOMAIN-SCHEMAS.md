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
- managed event/control API/additive SQL prototypes.

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

Schema presence means DESIGNED only. Generated TypeScript/Rust bindings, real adapters and integration tests are still required before WIRED/VERIFIED status.

## 12.14 Compatibility

Historical ThreadV1/TurnV1/ProviderAttempt/CompactionRecord-as-Rust-conversation schemas are archived provenance only. Do not generate or persist them as V1 canonical conversation data.

Any existing code type with those names is treated as legacy/prototype until explicitly mapped to the current owner model and acceptance tests.
