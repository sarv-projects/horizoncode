# 2. Domain model and schemas

This chapter is the conceptual domain and identity overview. Canonical closed state
sets and guarded transitions are in [`11-LIFECYCLE.md`](11-LIFECYCLE.md); canonical
logical wire record shapes are in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md).
Where an illustrative schema below differs in field detail, those two contracts
control. Persistence maps through the existing event-log seam in
[`04-STATE-EVENTS.md`](04-STATE-EVENTS.md); this chapter does not define a second
serialization or event store.

## 2.1 Identity mapping

| Concept | Canonical owner | Constraint |
|---|---|---|
| `ThreadId` | Rust kernel Thread service | Canonical conversation identity and event stream. An OpenCode `SessionId` may be a compatibility ID mapped to this Thread, never a second owner. |
| `InputId` / `TurnId` / `ModelAttemptId` | Rust kernel records; host executes provider operation | Durable admission/turn boundaries; provider stream execution remains in the OpenCode-derived host. None is a managed Task Attempt. |
| `GoalId` / `SpecVersionId` / `RunId` | Rust kernel | Durable user-reviewed objective, immutable approved requirements, and managed execution lifecycle. |
| `TaskId` | Rust kernel | DAG node with dependencies, acceptance criteria, repository/workspace scope, limits and state. A child Thread is not a Task. |
| `AttemptId` | Rust kernel | One strategy for a Task. A retry with a changed strategy gets a new identity and consumes the same parent budget history. |
| `WorkerExecutionId` | Rust kernel | One launch/incarnation that may use a Thread; process/session status is only an observation. |
| `ExecutionId` | Rust ExecutionHost module in `hz-kernel` | One local process operation; a managed WorkerExecution may reference it, while a direct Turn need not fabricate an Attempt. |
| `ToolBatchId` | Rust ThreadService | ToolBatch lifecycle and ordered result links are canonical Thread-stream facts; its executor returns observations only. |
| `UsageObservationId` | Rust UsageService | Append-only usage observation; BudgetService owns policy/reservations/settlement decisions and references observations. |
| `BudgetId` / `ReservationId` / `BudgetSettlementId` | Rust BudgetService | Owns limits, reservations and settlement decisions; each settlement links the UsageObservationIds it accounts for. |
| `WorkspaceId` / lease / revision | Horizon workspace owner | Mutable source identity and fencing epoch; not an Attempt or repository catalog row. |
| `EffectId` | Rust effect owner | One governed operation with durable prepare and terminal result or explicit `UNKNOWN`. Audit stores linked security evidence, not business ownership. |
| `EvidenceId` | Independent verifier produces; RunController accepts | Exact spec, revision set, environment, toolchain and scenario bindings. Worker claims/check receipts do not create Task PASS. |
| `AgentProfileId + revision` | One Horizon profile registry | Shared definition for main/subagent/native/external adapters; OpenCode config may be migrated/adapted but is not a competing profile authority. |
| Provider route | OpenCode `packages/llm` executes; kernel policy snapshots/authorizes | One provider implementation/transport owner in the host. Active Run/Attempt route snapshots are immutable and contain references/digests, never credential bytes. |
| Service/plugin generation | Kernel CompositionService commits; host resolver/runtime executes and reports observations | Stable provider identity and pinned generation; composition does not transfer canonical truth ownership. |

Global IDs are never reused. Unknown or unsupported schema versions refuse before
partial replay. OpenCode's process-local session coordinator is an execution detail,
not durable Turn or WorkerExecution ownership. Host SQLite tables are rebuildable
projections; canonical Thread history is replayable from the kernel event stream.

## 2.2 Thread and direct-turn records

These logical records are canonical kernel facts. The host's OpenCode-derived runtime
uses `ThreadStoreService` and typed kernel RPC to read/append them; it must not write a
parallel transcript database.

```rust
struct ThreadV1 {
    thread_id: ThreadId,
    project_id: ProjectId,
    parent_thread_id: Option<ThreadId>,
    relationship: ThreadRelationship,
    attached_run_id: Option<RunId>,
    attached_task_id: Option<TaskId>,
    attached_attempt_id: Option<AttemptId>,
    title: String,
    active_context_epoch_id: ContextEpochId,
    selected_agent_profile_revision: ProfileRevisionRef,
    selected_model: Option<ModelSelection>,
    created_at: Timestamp,
    archived_at: Option<Timestamp>,
}

enum ThreadRelationship { Root, Fork, Worker, Review, SideQuestion, Verifier }

struct ThreadInputV1 {
    input_id: InputId,
    thread_id: ThreadId,
    delivery_id: DeliveryId,
    lane: InputLane,                 // steer | queue
    content_ref: ArtifactRef,
    admitted_seq: u64,
    admitted_at: Timestamp,
    state: InputState,
    promoted_turn_id: Option<TurnId>,
}

struct TurnV1 {
    turn_id: TurnId,
    thread_id: ThreadId,
    input_ids: Vec<InputId>,
    profile_revision: ProfileRevisionRef,
    context_epoch_id: ContextEpochId,
    route_snapshot_id: ProviderRouteSnapshotId,
    toolset_generation: u64,
    state: TurnState,
    provider_attempt_ids: Vec<ModelAttemptId>,
    started_at: Timestamp,
    ended_at: Option<Timestamp>,
}

struct ContextEpochV1 {
    id: ContextEpochId,
    thread_id: ThreadId,
    parent_epoch_id: Option<ContextEpochId>,
    reason: ContextEpochReason,
    baseline_digest: Digest,
    source_heads: BTreeMap<ContextSourceKey, Digest>,
    repo_generation_refs: Vec<RepoGenerationRef>,
    memory_generation_refs: Vec<MemoryGenerationRef>,
    toolset_digest: Digest,
    profile_revision: ProfileRevisionRef,
    route_snapshot_id: ProviderRouteSnapshotId,
    policy_digest: Digest,
    created_at: Timestamp,
}
```

`Steer` is eligible at the next safe provider-turn boundary. `Queue` remains FIFO until
the current continuation would otherwise become idle. Admission is durable before the
host is woken; admission does not mean the model has seen the input. Provider token
deltas are ephemeral and are not canonical Thread events. A direct Turn can complete
without completing an attached Run.

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
