# 2. Domain model and schemas


> **Authoritative integration amendment, 2026-10-10:** This chapter is read with the v2 decisions in `17-GOVERNANCE-DECISIONS.md` and source-backed integration chapters 19–26. Older designs of a competing Rust canonical Session, automatic model selection or unconstrained agents are superseded **only where explicitly contradicted**. Existing code does not become implemented by this edit.

> **2026-10-11 audit resolution:** Read this chapter with §§28–34. For V1, OpenCode remains canonical for Session/Input/Message/Part/provider continuation. Rust OwnerLog is canonical only for HorizonCode-managed control-plane facts (Goal/Spec/Run/Task/Attempt, ToolBatch control metadata/correlation, effects/approvals/leases, recovery and evidence). Any older wording that makes a Rust Thread store the competing canonical conversational transcript is **superseded**. New agent/context/index/local-model/UI-performance/analytics contracts in §§29–33 are additive normative requirements; they are not claims of current implementation.

## 2026-10-10 OpenCode-first reconciliation
### Canonical aggregate authority (effective v2)
| Aggregate | Write owner | Replication or derived read side |
|---|---|---|
| OpenCode Session, Message, Part, Prompt and provider-native continuation | OpenCode SessionStore / established provider runner | Kernel stores stable foreign keys and correlated telemetry, not a second canonical transcript |
| GoalRevision, Criterion, Run, TaskGraph, Attempt, ExecutionLease | Rust kernel | OpenCode context packet references the immutable accepted snapshot |
| ToolIntent, Approval, Effect and Evidence | Rust authorization/effect/verification services | UI and OpenCode tool response consume signed/validated receipts |
| Workspace lease, test DB/port allocation, worktree state | Rust resource manager | Existing OpenCode Git APIs are constrained backend actions |
| Learned repair recipe and promotion decision | Recovery catalog and validation gate | Model sees only selected, bounded, cited guidance |
**Cutover condition:** existing kernel OwnerLog V2 supports event storage but has no production ThreadService integration. Preserve its test-covered codecs, use it for managed domain log, and refactor only after a dual-write/replay parity spike proves OpenCode Session semantics can be retained safely. Do not drop owner_log or old schema tests.
### Versioned domain additions
```typescript
type SelectedModel = {providerId:string; modelId:string; harnessId:string; pinned:true; sessionId:string};
type ExecutionIdentity = {runId:string;taskId:string;attemptId:string;executionId:string; epoch:number;fence:number; sessionId:string};
type ApprovalMode = 'ask'|'safe_auto'|'yolo_sandbox';
type PoolEntryState = 'provisioning'|'warm_idle'|'leased'|'dirty'|'quarantined'|'reaping'|'removed';
type EffectDisposition = 'requested'|'started'|'applied'|'rejected'|'uncertain'|'compensated';
type GoalAcceptance = {criteriaIds:string[]; integratedRevision:string; verdict:'pass'|'fail'|'inconclusive'; evidenceIds:string[]};
type RetryDisposition = {sameModelOnly:true; retryable:boolean; reason:string; nextAttemptId?:string};
```
### Required integrity
All mutable managed objects have version, actor, event cursor and idempotency key. Child attempts inherit a subset of parent permissions, never exceed it. A provider-supported model switch is a *new user decision* and new attempt; never a silent mid-turn transition. A goal cannot become verified without independent evidence from the final integrated revision.

---

This chapter is the conceptual domain and identity overview. Canonical closed state
sets and guarded transitions are in [`11-LIFECYCLE.md`](11-LIFECYCLE.md); canonical
logical wire record shapes are in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md).
Where an illustrative schema below differs in field detail, those two contracts
control. Persistence maps through the existing event-log seam in
[`04-STATE-EVENTS.md`](04-STATE-EVENTS.md); this chapter does not define a second
serialization or event store.

## 2.1 Current identity and ownership mapping (V1 normative)

| Identity | Canonical owner | Contract |
|---|---|---|
| OpenCode SessionId/InputId/MessageId/PartId and conversation Turn | OpenCode Core Session/EventV2 | One canonical conversation/continuation history and original tool call/result parts |
| SessionLink and source cursor | Rust read-only correlation/managed bridge | Foreign refs, digests and bounded redacted metadata only; no second text transcript |
| GoalId/SpecVersionId/RunId/TaskId/AttemptId/WorkerExecutionId | Rust managed RunController | Durable objectives, DAG, worker lifecycle and acceptance state |
| ToolBatchId | Rust ToolBatchControl for admission and result-control metadata | Pins whole completed OpenCode response, schema/toolset/profile digest, call identities and authorization/settlement references; OpenCode retains conversational tool messages |
| EffectId/ApprovalChallengeId/CapabilityLeaseId | Rust Guard/EffectService/ExecutionHost | One-use lease, no side effect before PREPARED, UNKNOWN until reconciled |
| Workspace and resource lease/revision | Rust resource owner | Fenced workspace, process, port, test DB and integration effects |
| EvidenceId/verification receipt | VerificationService and RunController | Binds accepted final revision, environment and criteria |
| AgentProfileId + revision, skill/tool stable ID | Governed registries | Immutable profile/manifest generations; policies only narrow authority |
| Provider/model/harness selection | Explicit pinned OpenCode route plus governed policy snapshot | No hidden provider/cost fallbacks; exact revisions retained |
| UI/index/context state | Derived read models | Never another owner of Session, Run or Guard |

Global IDs are immutable correlation identifiers, not capabilities. Cross-owner references cannot be SQL foreign-key assumptions. Runtime uses §25 bridge and §37 interfaces.

## 2.2 Direct Session and managed Run are distinct

A direct interactive Session is created/promoted/persisted by OpenCode. Horizon may record bounded ToolBatchControl and EffectIntent facts for its mutating tool operations WITHOUT creating a Rust Thread, Turn or canonical message aggregate. Ordinary pair coding does not fabricate a Goal/Run/Task just to log one tool. A managed Goal/Run pins its own criteria, Task/Attempt/Worker bindings and SessionLinks to one or more OpenCode Sessions. Provider turn completion does not imply Task PASS. Replaying a Session update never fabricates a managed effect receipt.

Legacy ThreadV1/TurnV1 Rust-canonical design was superseded and preserved in the §36 provenance archive. Section 12's legacy logical Thread schemas are non-operative historical input; new implementation must not instantiate those as production conversation truth. The only Rust-owned tool-batch facts are metadata and authorization transitions, not copied conversation parts.

## 2.3 Managed-work records

The following are logical schemas; serialization must be versioned by their owner.

```rust
struct GoalV1 {
    goal_id: GoalId,
    project_id: ProjectId,
    original_request_ref: ArtifactRef,
    active_spec_version_id: Option<SpecVersionId>,
    created_at: Timestamp,
}

struct SpecVersionV1 {
    spec_version_id: SpecVersionId,
    goal_id: GoalId,
    version: u32,
    parent_id: Option<SpecVersionId>,
    objective: String,
    requirements: Vec<Requirement>,
    assumptions: Vec<Assumption>,
    exclusions: Vec<Exclusion>,
    scope: ScopeContract,
    invariants: Vec<Invariant>,
    interfaces: Vec<InterfaceContract>,
    acceptance: Vec<AcceptanceScenario>,
    negative_cases: Vec<AcceptanceScenario>,
    verification_plan: VerificationPlan,
    digest: Digest,
    approval_ref: Option<ApprovalRef>,
}

struct RunV1 {
    run_id: RunId,
    goal_id: GoalId,
    original_request_ref: ArtifactRef,
    project_id: ProjectId,
    control_thread_id: ThreadId,
    repository_members: Vec<RepositoryMemberRef>,
    approved_spec_digest: Digest,
    policy_digest: Digest,
    config_digest: Digest,
    route_policy_digest: Digest,
    budget_id: BudgetId,
    owner_epoch: u64,
    state: RunState,
    state_reason: StateReason,
    created_at: Timestamp,
    updated_at: Timestamp,
}

struct TaskV1 {
    task_id: TaskId,
    run_id: RunId,
    spec_digest: Digest,
    dependencies: Vec<TaskId>,
    acceptance_ids: Vec<AcceptanceId>,
    repository_member_ids: Vec<RepositoryMemberId>,
    write_scope_digest: Digest,
    permission_ceiling_digest: Digest,
    budget_id: BudgetId,
    attempt_limit: u32,
    state: TaskState,
}

struct AttemptV1 {
    attempt_id: AttemptId,
    task_id: TaskId,
    strategy_id: StrategyId,
    route_snapshot_ref: ProviderRouteSnapshotRef,
    profile_revision: ProfileRevision,
    workspace_binding_refs: Vec<WorkspaceBindingRef>,
    context_packet_ref: ContextPacketRef,
    execution_limit_ref: ExecutionLimitRef,
    state: AttemptState,
}

struct ProviderAttemptV1 {
    model_attempt_id: ModelAttemptId,
    turn_id: TurnId,
    route_snapshot_id: ProviderRouteSnapshotId,
    request_digest: Digest,
    output_digest: Option<Digest>,
    state: ProviderAttemptState,
    finish_cause: Option<FinishCause>,
    usage_observation_ref: Option<ArtifactRef>,
    started_at: Timestamp,
    ended_at: Option<Timestamp>,
}

struct WorkerExecutionV1 {
    worker_execution_id: WorkerExecutionId,
    execution_id: Option<ExecutionId>,
    attempt_id: AttemptId,
    incarnation: u32,
    thread_id: Option<ThreadId>,
    launch_id: LaunchId,
    adapter_kind: WorkerAdapterKind,
    fence_epoch: u64,
    state: WorkerExecutionState,
    observation_refs: Vec<HostObservationRef>,
    receipt_ref: Option<ArtifactRef>,
}

enum ProviderAttemptState {
    Preparing, Requesting, Streaming, Complete, Cancelled,
    FailedPreContent, FailedPostContent, Truncated, UnknownAcceptance,
}
```

Run state names and guarded transitions in adopted v1 follow the canonical state
vocabulary in [`11-LIFECYCLE.md`](11-LIFECYCLE.md); this package is self-contained and
historical design inputs do not define implementation behavior. The key rule
is `worker finished != task passed`; only the kernel RunController accepts current
verifier evidence for the integrated subject. A Thread may attach to Run/Task/Attempt;
it never becomes one of those objects.

## 2.4 Effect and evidence records

```rust
struct EffectIntentV1 {
    effect_id: EffectId,
    owner: EffectOwnerRef,       // direct Thread, managed Run/Attempt, user action, or system operation
    origin: EffectOriginV1,
    action: ActionId,
    resource_digest: Digest,
    argument_digest: Digest,
    policy_digest: Digest,
    workspace_binding_ref: Option<WorkspaceBindingRef>,
    approval_challenge_ref: Option<ApprovalChallengeRef>,
    idempotency_key: Option<IdempotencyKey>,
    state: EffectState,
}

struct EffectReceiptV1 {
    effect_id: EffectId,
    outcome: EffectOutcome,      // completed | denied | failed | unknown
    output_artifact_refs: Vec<ArtifactRef>,
    before_revision: Option<RevisionRef>,
    after_revision: Option<RevisionRef>,
    host_observation_ref: Option<HostObservationRef>,
    reconciliation_ref: Option<ReconciliationRef>,
}

struct EvidenceV1 {
    evidence_id: EvidenceId,
    run_id: RunId,
    task_id: TaskId,
    attempt_id: AttemptId,
    verifier_profile_revision: ProfileRevisionRef,
    spec_digest: Digest,
    integrated_revisions: Vec<RevisionRef>,
    workspace_manifest_digests: Vec<Digest>,
    environment_digest: Digest,
    toolchain_digest: Digest,
    scenario_version_digest: Digest,
    scenario_results: Vec<ScenarioResult>,
    verdict: EvidenceVerdict,   // PASS | FAIL | INSUFFICIENT_EVIDENCE
    limitations: Vec<Limitation>,
    artifact_refs: Vec<ArtifactRef>,
}
```

`STALE` is a later state of previously produced evidence when its subject no longer
matches; it is not a final correctness verdict. A process exit is only a host
observation. Audit records link by `effect_id` and never own the Thread/Run effect
lifecycle.

## 2.5 Host-to-kernel wire records

The following names are a conceptual sketch only. The normative protocol version,
frame encoding, handshake, bounds, typed errors, retry/idempotency, subscriptions and
transport security are defined in [`13-COMPOSITION-IPC.md`](13-COMPOSITION-IPC.md);
do not implement these sketch records as a parallel protocol.

```text
KernelHelloV1 {
  protocol_major, protocol_minor, opencode_build_digest,
  controller_build_digest, instance_nonce, supported_features[]
}

KernelRequestV1 {
  request_id, delivery_id?, method, schema_version,
  deadline_budget_ms, payload_digest, payload
}

KernelResponseV1 {
  request_id, outcome: RESULT | TYPED_ERROR,
  result?, typed_error?, owner_receipt?, owner_cursor?
}

```

There is no canonical `EffectRequestV1` wire record. Effect-capable operations use the
normalized §14 effect pipeline: their domain owner supplies the canonical action and
argument digest, `ResourceResolutionV1`, and `AuthorizationRequestV1` before Guard;
after `ALLOW` or resolved approval, EffectService commits `EffectIntentV1` as
`PREPARED`. Section 13 owns the actual host/kernel transport contract.

The ingress derives principal, authority, active profile, Run binding, workspace
fence, and current policy; those are not trusted request fields. Mutations are
idempotent by `delivery_id` plus payload digest. Reusing an ID with different content
is a typed conflict. Frames, nested payloads, queued bytes, in-flight operations, and
deadlines are bounded; cancellation is a separate operation and cannot imply rollback.

## 2.6 Agent profiles and provider snapshots

- One AgentProfile registry covers main agents, built-in/general/specialist/custom
  subagents, and native/ACP/CLI adapters. Profile revisions are immutable while in
  flight. Before managed dispatch, the kernel stores `ProfileRevisionRef`, effective
  tool/skill/MCP loadout digest, capability snapshot, permission ceiling, and finite
  execution limits. A profile edit affects future launches only.

```ts
type AgentProfileV1 = {
  id: AgentProfileId
  revision: number
  source: "builtin" | "user" | "project" | "plugin" | "external"
  roles: Array<"main" | "subagent">
  adapter: NativeAgentAdapter | ACPAdapter | CLIAdapter
  instructionsRef: ArtifactRef
  model: ModelSelection
  reasoning: ReasoningSelection
  loadout: { nativeTools: string[]; skills: string[]; mcpTools: string[] }
  invocation: { mode: "manual_only" | "suggest" | "automatic"; matchers: ProfileMatcher[] }
  isolation: "readonly" | "workspace" | "external"
  contextPolicy: "fresh" | "selected_history" | "reviewed_fork"
  memoryPolicy: "none" | "relevant_shared" | "shared_and_profile"
  permissionCeiling: PermissionProfile
  limits: AgentLimits
  definitionDigest: Digest
}
```
- `ProviderRouteSnapshotV1` contains provider/model IDs, protocol adapter version,
  endpoint origin/path, selected reasoning/variant, capability and limit digests,
  metadata source/digest, auth-method ID, and a secret reference. It contains no token.
  Route refresh cannot rewrite an active attempt.
- Model choice follows explicit user/profile policy. Pricing is retained for visible
  accounting and budget enforcement, not as permission to silently downgrade or
  change the selected model. Any fallback is explicitly configured and must satisfy
  required capability, policy, egress and budget checks.

Selection precedence is explicit invocation choice, a fixed selected-profile or
default-subagent model, permitted parent inheritance, main-agent default, then
`peer_managed` for an external runtime that owns its model. `inherit_parent` is invalid
for a root/main invocation without a parent; for a child it binds the parent's resolved
fixed route, which the child's adapter must support and independently validate. An
unresolvable/inapplicable inheritance is ineligible, not permission to guess a model.
`peer_managed` is valid only for an adapter whose external peer owns model selection.
There is no automatic price-, subscription-credit-, or latency-based downgrade, and no
silent reasoning-effort reduction. Automatic specialist selection is deterministic and
requires a unique eligible profile; otherwise ask or use the enabled default general
profile.
Effective authority is the intersection of parent, profile, Task and policy ceilings.

## 2.7 Plugin/service schema

This early shape is a vocabulary sketch, not a second manifest. The normative
ServiceDefinition, ServiceOffer, requirements, capability, plugin manifest and
composition lock contracts are in [`13-COMPOSITION-IPC.md`](13-COMPOSITION-IPC.md).

```ts
type ServiceDefinition<T> = {
  id: ServiceId
  version: SemVer
  schemaDigest: Digest
  cardinality: "one" | "many"
  replaceability: "sealed" | "startup_replaceable" | "hot_swappable"
  authority: "canonical" | "derived" | "advisory" | "presentation"
  capabilities: readonly CapabilityDescriptor[]
}

type PluginManifestV1 = {
  apiVersion: 1
  id: PluginId
  version: SemVer
  targets: PluginTarget[]
  trustClass: PluginTrustClass
  provides: ServiceRequirement[]
  requires: ServiceRequirement[]
  optional: ServiceRequirement[]
  contributes: ContributionDescriptor[]
  requestedCapabilities: CapabilityRequest[]
  configSchemaRef?: JsonSchemaRef
  provenance: { source: string; digest: Digest; publisher?: string; signatureRef?: string }
}
```

Manifest trust, installed/enabled/activated/healthy status, and permission to load a
capability into a particular profile/Run/Turn are separate facts. Skills are inert
content until invoked; workflow definitions are declarative and compile to ordinary
Goal/Spec/Run/Task objects. Plugins cannot write canonical event streams directly.

## 2.8 Legacy Session migration identity

Each imported OpenCode Session maps once to one kernel Thread. The importer allocates a
stable `ThreadId` and records the old `SessionId` as a compatibility alias; it never
reuses a legacy ID as a second write authority. A unique source-store/SessionId pair
makes retries idempotent and preserves old links without constraining the new ID format.
The Thread service owns the alias as an import fact; its lookup index is rebuildable.

```rust
struct LegacySessionAliasV1 {
    source_store_id: SourceStoreId,
    legacy_session_id: LegacySessionId,
    thread_id: ThreadId,
    imported_snapshot_digest: Digest,
    imported_at: Timestamp,
}
```

Preserve source ordering and provenance for messages, tool calls/results, attachments,
and compaction records. Preserve fork relationships when the referenced parent exists;
otherwise import the Thread as a root with an explicit missing-parent provenance record.
Copy available attachment bytes into the artifact store and represent missing bytes as
unavailable references. Retain compaction summaries as imported content and metadata;
do not fabricate omitted history. The source database remains read-only until the
migration acceptance and retention policy permit its removal.

An in-flight provider request at the snapshot cut imports as
`UnknownAcceptance`; it is never automatically resent. A pending legacy tool call or
effect imports as `UNKNOWN` with legacy/unmediated provenance until the target state is
reconciled. Historical tool results are conversation data, not proof that Guard
authorized or verified the effect.

## Pinned implementation references

- [Core Session API and durable prompt admission](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session.ts#L360-L385)
- [Core session input admission/projection](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session/input.ts)
- [LLM message schema](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/llm/src/schema/messages.ts)


## 2.14 2026-10-11 domain extensions

The competitive audit adds several **derived/supporting** domain objects without changing
canonical ownership.

### Agent profile and delegation

`AgentProfileV2` is an immutable versioned configuration aggregate (§29). It is not a
conversation or worker lifecycle owner. A worker pins one profile revision.

`SubagentRequestV2` / `SubagentReplyV2` are typed delegation messages. Managed Task/Attempt
or DirectDelegation remains the lifecycle owner; a subagent cannot create its own canonical
Task PASS state.

### Context view

`ContextPlan`, `ContextEntryV2` and context-view revisions are deterministic projections over:
- canonical OpenCode conversation refs;
- Rust Goal/Task/control refs;
- RepoIntel/source refs;
- selected skill/memory/artifact refs.

They are not a copy of the transcript. Trim/prune/compact/clear alter the provider-facing view,
not the canonical source records.

### Repository intelligence

`RepoGeneration`, `SymbolRecordV2` and `ReferenceEdgeV2` are rebuildable projections tied
to an exact workspace/source revision and read-policy digest. Symbol IDs can be re-resolved
after edits; source files/Git remain canonical.

### Artifact

Artifact identity is content-addressed/version-bound metadata + bytes. A renderer/preview is
derived and can be rebuilt. Artifact presence is not verification unless a criterion explicitly
accepts and VerificationService validates it.

### Analytics

`InferenceObservationV2`, tool/runtime observations and aggregates are measurements. They can
explain performance/cost/reliability but cannot transition Goal/Task/Effect/Evidence state.

### Automation

`AutomationV2` is a durable schedule/action definition. Each trigger produces an
`AutomationRun` identity that invokes a typed ActionDescriptor under ordinary policy/budget
and records its resulting canonical references.

### Maintenance job

A MaintenanceJob is a bounded helper execution for title/summary/query/context-retention-style
work. It has schema, limits and provenance but no child Thread/worktree by default and no
independent authority.

### Mission Control

Mission Control is a UI read model combining canonical owners. It owns no Run/Task/Thread state.

### Ownership summary

```text
OpenCode conversation        -> Session/Input/Message/Part/provider continuation
Rust managed control         -> Goal/Spec/Run/Task/Attempt/delegation/tool-control/effect/evidence
Workspace/Git                -> source truth
ContextLedger/RepoIntel/UI    -> rebuildable/derived projections
Analytics                    -> observations
ArtifactService              -> immutable artifact bytes/metadata
AutomationService            -> schedule definition + run invocation records
```
