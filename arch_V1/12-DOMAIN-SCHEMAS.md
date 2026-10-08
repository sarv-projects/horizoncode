# 12. Canonical domain schemas

This document fills the canonical domain-record schema gaps in `02-DOMAIN.md`. Types
are logical v1 contracts: Rust owns durable domain records; OpenCode TypeScript owns
provider/UI-native types and maps them through the generated boundary. Boundary
message schemas and module interfaces are defined by their owning contracts in §§13–14
and reference these domain records without redefining their state. Implementation
must materialize versioned machine-readable contracts under each owning boundary
before generation; generated copies are never edited as a second source of truth. IDs
are globally unique, immutable, never reused, and carry no authority by themselves.

## 12.1 Shared primitives

```ts
type Id<K extends string> = string & { readonly __kind: K }
type ProjectId = Id<"ProjectId">
type RepositoryId = Id<"RepositoryId">
type RepositoryMemberId = Id<"RepositoryMemberId">
type ThreadId = Id<"ThreadId">
type InputId = Id<"InputId">
type TurnId = Id<"TurnId">
type ModelAttemptId = Id<"ModelAttemptId">
type ProviderReconciliationId = Id<"ProviderReconciliationId">
type MessageId = Id<"MessageId">
type PartId = Id<"PartId">
type GoalId = Id<"GoalId">
type SpecVersionId = Id<"SpecVersionId">
type RunId = Id<"RunId">
type TaskId = Id<"TaskId">
type AttemptId = Id<"AttemptId">
type WorkerExecutionId = Id<"WorkerExecutionId">
type ExecutionId = Id<"ExecutionId">
type LaunchId = Id<"LaunchId">
type DispatchId = Id<"DispatchId">
type WorkspaceId = Id<"WorkspaceId">
type WorkspaceLeaseId = Id<"WorkspaceLeaseId">
type EffectId = Id<"EffectId">
type ApprovalChallengeId = Id<"ApprovalChallengeId">
type ApprovalGrantId = Id<"ApprovalGrantId">
type NeedsYouId = Id<"NeedsYouId">
type ScenarioId = Id<"ScenarioId">
type EvidenceId = Id<"EvidenceId">
type ProofPackId = Id<"ProofPackId">
type AgentProfileId = Id<"AgentProfileId">
type PluginId = Id<"PluginId">
type ToolId = Id<"ToolId">
type ToolCallId = Id<"ToolCallId">
type ToolBatchId = Id<"ToolBatchId">
type ActionInvocationId = Id<"ActionInvocationId">
type SystemOperationId = Id<"SystemOperationId">
type ContextEpochId = Id<"ContextEpochId">
type ContextPacketId = Id<"ContextPacketId">
type CompactionId = Id<"CompactionId">
type ProviderRouteSnapshotId = Id<"ProviderRouteSnapshotId">
type UsageObservationId = Id<"UsageObservationId">
type BudgetId = Id<"BudgetId">
type ReservationId = Id<"ReservationId">
type BudgetSettlementId = Id<"BudgetSettlementId">
type RepoGenerationId = Id<"RepoGenerationId">
type MemoryId = Id<"MemoryId">
type MemoryCandidateId = Id<"MemoryCandidateId">
type MemoryQueryId = Id<"MemoryQueryId">
type MemoryExtractionId = Id<"MemoryExtractionId">
type MemoryConsolidationId = Id<"MemoryConsolidationId">
type HookId = Id<"HookId">
type ArtifactId = Id<"ArtifactId">
type AuditId = Id<"AuditId">
type CheckpointId = Id<"CheckpointId">
type VerificationPermitId = Id<"VerificationPermitId">
type RewindPlanId = Id<"RewindPlanId">
type EventId = Id<"EventId">
type DeliveryId = Id<"DeliveryId">
type CorrelationId = Id<"CorrelationId">
type CompositionGenerationId = Id<"CompositionGenerationId">
type UInt64Decimal = string // canonical unsigned base-10, no sign/leading zero except "0"
type Digest = `blake3:${string}` // exactly 64 lowercase hexadecimal characters after prefix
type Timestamp = string // RFC 3339 UTC, millisecond precision
type Cursor = { ownerKind: string; ownerId: string; seq: UInt64Decimal; eventDigest: Digest }
type ActorRef = { kind: "user" | "system" | "host" | "worker" | "plugin" | "provider"; id: string }
type ProfileRevisionRef = { profileId: AgentProfileId; revision: number; definitionDigest: Digest }
type ProviderRef = { providerId: string; modelId?: string }
type SecretRef = Id<"SecretRef">
type CapabilityLeaseId = Id<"CapabilityLeaseId">
type SecretUseLeaseId = Id<"SecretUseLeaseId">
type JsonSchemaRef = { schemaId: string; version: string; digest: Digest }
type PrincipalRef = { principalId: string; kind: "user" | "service" | "worker"; authenticationDigest: Digest }
type RootRef = { rootId: Id<"RootRef">; canonicalIdentityDigest: Digest }
type WorkspaceBindingRef = { workspaceId: WorkspaceId; leaseId: WorkspaceLeaseId; fenceEpoch: UInt64Decimal; revisionDigest: Digest }
type RepoGenerationRef = RepoGenerationId
type MemoryGenerationRef = { scopeId: string; generation: UInt64Decimal; headDigest: Digest }
type RepositoryMemberRef = RepositoryMemberId
type ExecutionLocationRef = { kind: "local" | "windows" | "wsl" | "container" | "remote"; id: string; policyDigest: Digest }
type ModelSelection =
  | { mode: "fixed"; providerId: string; modelId: string }
  | { mode: "inherit_parent" }
  | { mode: "peer_managed"; peerId: string }
type ReasoningSelection = { mode: "fixed"; level: string } | { mode: "inherit" }
type AgentLimits = { maxConcurrent: number; maxAttempts: number; maxTurns?: number; wallTimeMs: number; inputTokens?: number; outputTokens?: number; toolCalls?: number }
type ServiceId = Id<"ServiceId">
type ActionId = Id<"ActionId">
type RouteId = Id<"RouteId">
type ContextSourceKey = string
type GuaranteeLevel = "enforced" | "capability_limited" | "best_effort" | "none" | "unknown"
type EffectState = "PREPARED" | "DISPATCHED" | "SETTLED_SUCCESS" | "SETTLED_FAILURE" | "UNKNOWN" | "RECONCILED_PRESENT" | "RECONCILED_ABSENT"
type ApprovalState = "CREATED" | "PRESENTED" | "ACCEPTED" | "DENIED" | "EXPIRED" | "INVALIDATED"
type CapabilityLeaseState = "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED"
type ThreadVisibility = "ACTIVE" | "ARCHIVED"
type InputState = "ADMITTED" | "PROMOTED" | "CANCELLED"
type TurnState = "PENDING" | "PREPARING" | "PROVIDER_RUNNING" | "WAITING_TOOLS" | "WAITING_USER" | "INTERRUPTING" | "INTERRUPTED" | "COMPLETED" | "FAILED" | "UNKNOWN"
type ProviderAttemptState = "PREPARING" | "REQUESTING" | "STREAMING" | "COMPLETE" | "CANCELLED" | "FAILED_PRE_CONTENT" | "FAILED_POST_CONTENT" | "TRUNCATED" | "UNKNOWN_ACCEPTANCE"
type GoalState = "DRAFT" | "PREPARING" | "REVIEW" | "READY" | "ACTIVE" | "CANCELLED" | "SUPERSEDED"
type SpecVersionState = "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED"
type RunState = "DISCOVERING" | "SPECIFYING" | "READY" | "EXECUTING" | "WAITING" | "PAUSED" | "RECOVERING" | "INTEGRATING" | "VERIFYING" | "AWAITING_ACCEPTANCE" | "CANCELLING" | "COMPLETED" | "CANCELLED" | "STOPPED"
type TaskState = "BLOCKED" | "READY" | "CLAIMED" | "RUNNING" | "WAITING" | "VERIFYING" | "PASSED" | "NEEDS_REVIEW" | "FAILED" | "CANCEL_REQUESTED" | "CANCELLED" | "SUPERSEDED"
type AttemptState = "PREPARED" | "ACTIVE" | "SETTLING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCEL_REQUESTED" | "CANCELLED"
type WorkerExecutionState = "PREPARED" | "LAUNCHING" | "RUNNING" | "SETTLING" | "FINISHED" | "FAILED" | "UNKNOWN" | "CANCEL_REQUESTED" | "CANCELLED"
type ToolResultStatus = "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "CANCELLED"
type RevisionRef = {
  repositoryId: RepositoryId
  vcsKind: "git" | "none"
  commitId?: string
  treeDigest: Digest
  workspaceManifestDigest: Digest
}
type RevisionSet = { members: RevisionRef[]; digest: Digest } // sorted by RepositoryId
type EventPayloadMetadataV1 = {
  schemaVersion: number
  eventId: EventId
  actorRef: ActorRef
  causationId?: EventId
  correlationId?: CorrelationId
  payloadDigest: Digest // BLAKE3 of canonical family-payload bytes; excludes this metadata
}
type AggregateTransitionV1 = {
  aggregateId: string
  expectedVersion: UInt64Decimal
  fromState: string
  toState: string
  causeIds: string[]
  guardEvidenceRefs: ArtifactRef[]
}
type ArtifactRef = {
  artifactId: ArtifactId
  digest: Digest
  byteLength: UInt64Decimal
  mediaType: string
  classification: "public" | "workspace" | "sensitive"
}
type ResourceClaim = {
  canonicalId: string
  kind: "path" | "repository" | "process-tree" | "network-origin" | "mcp-server" | "external-object" | "unknown"
  access: "read" | "write" | "execute" | "network" | "mutate" | "exclusive"
  revision?: Digest
}
type EffectOriginV1 =
  | { kind: "direct_turn"; threadId: ThreadId; turnId: TurnId }
  | { kind: "managed_attempt"; runId: RunId; taskId: TaskId; attemptId: AttemptId }
  | { kind: "managed_run"; runId: RunId; taskId?: TaskId }
  | { kind: "user_action"; invocationId: ActionInvocationId; deliveryId: DeliveryId }
  | { kind: "system_operation"; operationId: SystemOperationId }
```

Branded IDs serialize as opaque strings. `UInt64Decimal` serializes as a canonical
base-10 string at JSON/public boundaries so JavaScript cannot round a Rust `u64`;
the physical event log retains its native `u64` field. The lifecycle unions for
`EffectState` and `ApprovalState` mirror the closed values in §11; §11 owns their
transition meaning.

Every `number` field is a finite, non-negative safe integer unless its field contract
explicitly permits a fraction (for example uncertainty or percentage); decoders reject
NaN, infinity, negative values where prohibited, and values above `Number.MAX_SAFE_INTEGER`.
Use `UInt64Decimal` for Rust `u64` counters, byte totals, and fence/owner epochs at JSON
boundaries.
`ExecutionId` identifies one locally supervised process/execution; it is distinct from
`WorkerExecutionId`, the adapter execution identity used by managed WorkerExecution or
Thread-owned DirectDelegation. A direct-turn shell or
MCP child therefore does not require a fabricated managed Attempt.
For `AggregateTransitionV1`, creation uses `fromState: "ABSENT"` and
`expectedVersion: "0"`; every later event names the exact prior state/version. A
multi-aggregate operation has one transition receipt per aggregate, never one shared
version or implied cross-stream transaction.

Digest-bearing persisted payloads use the existing event-log canonical encoding:
fixed physical field order and recursively sorted JSON object keys. Typed set-like
arrays have stable declared ordering and no duplicate members; ordered arrays preserve
their semantic order. Strings are hashed as stored UTF-8 with no implicit Unicode
normalization. Any future normalization or canonical encoding change is a versioned
schema/migration decision. `Digest` identifies bytes/metadata; it is not a signature
or proof of trust.

For `EventPayloadMetadataV1.payloadDigest`, the exact value is
`"blake3:" + lowercase_hex(BLAKE3(canonical family-payload bytes))`. The family
payload includes its required `AggregateTransitionV1` when applicable. It excludes all
`EventPayloadMetadataV1` fields, including `payloadDigest`, so the digest is not
self-referential. The physical `event_digest` remains the existing event-chain
commitment over the canonical physical event body, including bounded `data` and
`payloadDigest`; as the digest output, its own field is excluded from that body.

## 12.2 Project, repository and revision models

```ts
type ProjectV1 = {
  schemaVersion: 1
  projectId: ProjectId
  displayName: string
  repositoryMemberIds: RepositoryMemberId[] // stable insertion order; not a VCS order
  configRevision: number
  createdAt: Timestamp
  archivedAt?: Timestamp
}

type RepositoryMemberV1 = {
  schemaVersion: 1
  repositoryMemberId: RepositoryMemberId
  projectId: ProjectId
  repositoryId: RepositoryId
  canonicalRootRef: RootRef // never an unchecked caller path
  vcsKind: "git" | "none"
  defaultBranch?: string
  state: "ACTIVE" | "DETACHED" | "MISSING" | "READ_ONLY" | "QUARANTINED"
  createdAt: Timestamp
}

type RepositoryV1 = {
  repositoryId: RepositoryId
  identityKind: "git-common-dir" | "canonical-directory"
  identityDigest: Digest
  detectedRemoteRefs: string[] // metadata only; never trusted for network authorization
  caseSensitivity: "sensitive" | "insensitive" | "unknown"
  createdAt: Timestamp
}

type RevisionSetV1 = RevisionSet

type WorkspaceV1 = {
  workspaceId: WorkspaceId
  projectId: ProjectId
  repositoryMemberIds: RepositoryMemberId[]
  rootRefs: RootRef[]
  baseRevisionSet: RevisionSetV1
  currentRevisionSet: RevisionSetV1
  lifecycle: "ALLOCATING" | "PREPARING" | "READY" | "LEASED" | "INTEGRATING" | "CONFLICTED" | "RELEASING" | "RELEASED" | "QUARANTINED" | "UNKNOWN"
  contentState: "CLEAN" | "DIRTY" | "UNKNOWN"
  activeLeaseId?: WorkspaceLeaseId
  ownerRunId?: RunId
  createdAt: Timestamp
}

type WorkspaceLeaseV1 = {
  leaseId: WorkspaceLeaseId
  workspaceId: WorkspaceId
  principal: PrincipalRef
  owner: { kind: "thread" | "run" | "task" | "attempt" | "worker"; id: string }
  scopeDigest: Digest
  expectedRevisionSet: RevisionSetV1
  fenceEpoch: UInt64Decimal
  expiresAt: Timestamp
  state: "REQUESTED" | "ACTIVE" | "RENEWING" | "FENCED" | "EXPIRED" | "RELEASED" | "CANCELLED" | "UNKNOWN"
}
```

Workspace, lease, and project revisions use the closed lifecycle states in §11.
`WorkspaceBindingRef` is a capability reference, not a replacement for the canonical
workspace or lease record.

`ProjectId`, `RepositoryId`, and `RepositoryMemberId` are distinct. A project may
contain multiple repositories; a repository can be bound to multiple projects. Each
Run, workspace and Evidence names the exact member IDs and revision set used.
`vcsKind=none` still has a content tree digest, but has no synthetic Git commit.

## 12.3 Thread inputs, turns, messages and parts

```ts
type ThreadV1 = {
  schemaVersion: 1; threadId: ThreadId; projectId: ProjectId
  parentThreadId?: ThreadId
  relationship: "ROOT" | "FORK" | "WORKER" | "REVIEW" | "SIDE_QUESTION" | "VERIFIER"
  attachedRunId?: RunId; attachedTaskId?: TaskId; attachedAttemptId?: AttemptId
  title: string; visibility: ThreadVisibility; activeContextEpochId: ContextEpochId
  selectedProfileRevision: ProfileRevisionRef; selectedModel?: ModelSelection
  createdAt: Timestamp; archivedAt?: Timestamp
}
type LegacySessionAliasV1 = {
  sourceStoreId: string; legacySessionId: string; threadId: ThreadId
  importedSnapshotDigest: Digest; importedAt: Timestamp
}
type LegacyImportOriginV1 = {
  schemaVersion: 1; sourceStoreId: string; legacySessionId: string
  sourceSnapshot: ArtifactRef; sourceRecordId: string; sourceRecordDigest: Digest
  provenance: "historical_unmediated"; importedAt: Timestamp
}
type LegacyTurnImportV1 = {
  schemaVersion: 1; origin: LegacyImportOriginV1; threadId: ThreadId; turnId: TurnId
  state: "UNKNOWN" // immutable initialization payload only
  historicalPayloadRef: ArtifactRef
  threadImportAdmissionReceipt: Cursor // thread/legacy_import_started, not completion
  providerAttemptIds: ModelAttemptId[]; uncertainEffectIds: EffectId[]
}
type HistoricalTurnRecordV1 = {
  kind: "historical"; schemaVersion: 1; origin: LegacyImportOriginV1
  threadId: ThreadId; turnId: TurnId; importPayloadRef: ArtifactRef
  providerAttemptIds: ModelAttemptId[]; uncertainEffectIds: EffectId[]
} & (
  | { state: "UNKNOWN"; reconciliationReceiptRef?: ArtifactRef; reconciliationCursor?: Cursor }
  | { state: "FAILED" | "INTERRUPTED" | "COMPLETED"; reconciliationReceiptRef: ArtifactRef; reconciliationCursor: Cursor }
)
type CanonicalTurnRecordV1 = TurnV1 | HistoricalTurnRecordV1
type LegacyUncertainOperationImportV1 = {
  schemaVersion: 1; origin: LegacyImportOriginV1; threadId: ThreadId; turnId: TurnId
  historicalPayloadRef: ArtifactRef
  operation:
    | { kind: "provider"; modelAttemptId: ModelAttemptId; state: "UNKNOWN_ACCEPTANCE" }
    | { kind: "effect"; effectId: EffectId; state: "UNKNOWN"; ownerKind: EffectIntentV1["ownerKind"] }
  threadImportReceipt: Cursor // prior thread/legacy_import_started source/alias receipt
  turnImportReceipt: Cursor // prior turn/legacy_imported historical initialization
}
type HistoricalProviderAttemptRecordV1 = {
  kind: "historical"; schemaVersion: 1; modelAttemptId: ModelAttemptId
  threadId: ThreadId; turnId: TurnId; origin: LegacyImportOriginV1
  importPayloadRef: ArtifactRef; state: "UNKNOWN_ACCEPTANCE" // immutable observed uncertainty
  reconciliation?: { record: ProviderAttemptReconciliationV1; ownerCursor: Cursor; receiptRef: ArtifactRef }
}
type CanonicalProviderAttemptRecordV1 = ProviderAttemptV1 | HistoricalProviderAttemptRecordV1
type HistoricalEffectRecordV1 = {
  kind: "historical"; schemaVersion: 1; effectId: EffectId
  threadId: ThreadId; turnId: TurnId; origin: LegacyImportOriginV1
  importPayloadRef: ArtifactRef
} & (
  | { state: "UNKNOWN"; reconciliationReceiptRef?: ArtifactRef; reconciliationCursor?: Cursor }
  | { state: "RECONCILED_PRESENT" | "RECONCILED_ABSENT"; reconciliationReceiptRef: ArtifactRef; reconciliationCursor: Cursor }
)
type CanonicalEffectRecordV1 = EffectIntentV1 | HistoricalEffectRecordV1
type TurnOperationsReconciledV1 = {
  schemaVersion: 1; threadId: ThreadId; turnId: TurnId
  operationReceipts: Array<{
    operation: { kind: "effect"; effectId: EffectId } | { kind: "process"; executionId: ExecutionId } | { kind: "direct_delegation"; workerExecutionId: WorkerExecutionId }
    ownerCursor: Cursor; receiptRef: ArtifactRef
  }>
  providerReconciliationRefs: ArtifactRef[]
  targetState: "PREPARING" | "WAITING_TOOLS" | "FAILED" | "COMPLETED" | "INTERRUPTED"
}
type ThreadInputV1 = {
  schemaVersion: 1; inputId: InputId; threadId: ThreadId; deliveryId: DeliveryId
  lane: "steer" | "queue"; contentRef: ArtifactRef; admittedSeq: UInt64Decimal
  admittedAt: Timestamp; state: InputState; promotedTurnId?: TurnId
}
type InputAdmissionRequestV1 = {
  threadId: ThreadId; deliveryId: DeliveryId; expectedCursor?: Cursor
  lane: "steer" | "queue"; contentRef: ArtifactRef; contentDigest: Digest
}
type TurnV1 = {
  schemaVersion: 1; turnId: TurnId; threadId: ThreadId; inputIds: InputId[]
  profileRevision: ProfileRevisionRef; contextEpochId: ContextEpochId
  routeSnapshotId: ProviderRouteSnapshotId; toolsetGeneration: UInt64Decimal
  toolsetDigest: Digest; state: TurnState; providerAttemptIds: ModelAttemptId[]
  startedAt: Timestamp; endedAt?: Timestamp
}
type ProviderAttemptV1 = {
  schemaVersion: 1; modelAttemptId: ModelAttemptId; turnId: TurnId
  routeSnapshotId: ProviderRouteSnapshotId; requestDigest: Digest
  outputDigest?: Digest; state: ProviderAttemptState
  finishCause?: string; usageObservationId?: UsageObservationId
  startedAt?: Timestamp; endedAt?: Timestamp
}
type ProviderAttemptReconciliationV1 = {
  reconciliationId: ProviderReconciliationId
  modelAttemptId: ModelAttemptId
  outcome: "NOT_ACCEPTED" | "ACCEPTED_COMPLETE" | "ACCEPTED_CANCELLED" | "UNKNOWN"
  recoveredResponse?: ArtifactRef
  evidenceRefs: ArtifactRef[]
  observedAt: Timestamp
}
```

Conversation history is a sequence of typed messages, not an untyped transcript.
Provider-native request objects are stored only as bounded artifacts when required;
they do not replace the provider-neutral message contract.

`LegacyUncertainOperationImportV1` is the versioned historical initialization payload,
not a live `ProviderAttemptV1`/`EffectIntentV1` requiring unavailable authorization pins.
ThreadService first commits the source alias/Turn and `thread/legacy_import_started`
receipt; the linked
provider import commits to that Thread stream and the linked effect import to the
EffectService stream. Historical payloads preserve available source values explicitly
as unmediated, with unavailable metadata marked missing, not fabricated route/policy,
budget, approval or capability leases. Only the authenticated migration path may
initialize uncertainty; imported entries never authorize dispatch. Reconciliation uses
the existing owners and exact imported identity; any later live operation gets a new
identity and all ordinary live guards. `thread/legacy_session_imported` confirms the
complete manifest of linked owner receipts only after all imported entries validate;
it is not the initial alias receipt or an atomic cross-owner commit. Exact import delivery/source digest replays the
same receipts, while conflicting source bytes refuse.
Initial Thread alias/admission precedes `turn/legacy_imported`, which initializes the
historical Turn UNKNOWN from `LegacyTurnImportV1` without promoted input or fabricated
live route/profile/toolset pins. Provider/effect imports then link both admission and
Turn initialization receipts; final completion follows their receipts.
`CanonicalTurnRecordV1` exposes the historical record distinctly from a live Turn.
Historical closure may become FAILED/INTERRUPTED or COMPLETED only from authoritative
reconciliation plus retained terminal message/result guards. Live continuation requires
a new ordinarily admitted Turn with real pins, never coercing missing historical metadata.
Import payloads remain immutable UNKNOWN observations. Historical canonical owner records
retain their importPayloadRef and separately linked reconciliation facts: terminal
HistoricalTurnRecord/EffectRecord states require receipt artifact and owner cursor.
HistoricalProviderAttemptRecord follows the ordinary immutable ProviderAttempt rule:
its original UNKNOWN_ACCEPTANCE observation is not rewritten; a separately appended
ProviderAttemptReconciliation resolves acceptance and is linked with its receipt/cursor.
All historical canonical variants remain dispatch-forbidden and preserve origin metadata;
no reconciliation fabricates missing live route, grant, reservation or lease pins.

```ts
type MessageV1 = {
  schemaVersion: 1
  messageId: MessageId
  threadId: ThreadId
  turnId?: TurnId
  ordinal: UInt64Decimal // dense within Thread owner stream projection
  role: "system" | "user" | "assistant" | "tool"
  author: ActorRef
  parts: MessagePartV1[]
  createdAt: Timestamp
  visibility: "normal" | "internal-control" | "imported-legacy"
  source?: { kind: "provider" | "tool" | "migration" | "operator"; sourceId: string }
}

type MessagePartV1 =
  | { type: "text"; partId: PartId; text: string; trust: "operator" | "model" | "untrusted-data" }
  | { type: "reasoning"; partId: PartId; textRef: ArtifactRef; provider: ProviderRef; retention: "ephemeral" | "retained" }
  | { type: "tool-call"; partId: PartId; toolCallId: ToolCallId; toolId: ToolId; argsRef: ArtifactRef; argsDigest: Digest; batchId: ToolBatchId }
  | { type: "tool-result"; partId: PartId; toolCallId: ToolCallId; status: ToolResultStatus; resultRefs: ArtifactRef[]; effectId?: EffectId; error?: TypedErrorV1 }
  | { type: "attachment"; partId: PartId; artifact: ArtifactRef; filename?: string }
  | { type: "artifact-ref"; partId: PartId; artifact: ArtifactRef; label?: string }
  | { type: "compaction-summary"; partId: PartId; summary: ArtifactRef; sourceRange: { firstEvent: UInt64Decimal; lastEvent: UInt64Decimal }; sourceDigest: Digest; compactionId: CompactionId }
  | { type: "question"; partId: PartId; needsYouId: NeedsYouId }
  | { type: "error"; partId: PartId; error: TypedErrorV1; retryability: RetryClass }
  | { type: "provider-metadata"; partId: PartId; metadata: ArtifactRef; provider: ProviderRef }
```

Rules: imported provider/tool output remains untrusted content; `system` parts may
only be authored by the operator or a sealed prompt composer and may not contain
retrieved raw data. Tool results are not authorization or verification evidence.
Large/binary media is referenced, not inlined. Secret values are never valid
message-part content. A missing imported attachment remains a typed unavailable
reference, not a fabricated empty file.

## 12.4 Context epoch, packet and compaction records

```ts
type ContextPressureStage =
  | "EXACT_DEDUPLICATION" | "SUPERSEDED_OBSERVATION_OMISSION"
  | "TOOL_RESULT_EVICTION" | "STALE_OBSERVATION_PRUNE"
  | "STRUCTURED_EXTRACTION" | "STRUCTURAL_COMPACTION" | "ABSTRACTIVE_COMPACTION"
  | "EMERGENCY_RECOVERY"
type ContextRecoveryPolicyV1 = {
  schemaVersion: 1
  policyDigest: Digest
  maxAttempts: number // positive, finite total recovery bound
  maxAttemptsPerStage: number // positive, finite bound for each stage
  allowAbstractiveCompaction: boolean
}
type CompactionTriggerV1 =
  | { kind: "USER_REQUEST" }
  | { kind: "LONG_HISTORY_THRESHOLD" }
  | { kind: "LOCAL_PREFLIGHT_OVERFLOW" }
  | { kind: "PROVIDER_PROMPT_TOO_LONG"; modelAttemptId: ModelAttemptId }
type ContextEpochV1 = {
  schemaVersion: 1
  epochId: ContextEpochId
  threadId: ThreadId
  parentEpochId?: ContextEpochId
  reason: "THREAD_CREATED" | "COMPACTION" | "WORKSPACE_CHANGED" | "SPEC_CHANGED" | "PROFILE_CHANGED" | "ROUTE_CHANGED" | "POLICY_CHANGED" | "EXPLICIT_RESET"
  baselineDigest: Digest
  sourceHeads: Record<string, Digest>
  repoGenerationRefs: RepoGenerationId[]
  memoryGenerationRefs: MemoryGenerationRef[] // sorted by scopeId, unique scope
  toolsetGeneration: UInt64Decimal
  toolsetDigest: Digest
  profileRevision: ProfileRevisionRef
  routeSnapshotId: ProviderRouteSnapshotId
  policyDigest: Digest
  createdAt: Timestamp
}

type ContextSourceSnapshotV1 = {
  sourceKey: string
  sourceVersion: string
  sourceDigest: Digest
  provenance: string
  trust: "policy" | "operator" | "repository-untrusted" | "tool-untrusted" | "advisory"
  required: boolean
  tokenEstimate?: { value: number; uncertainty: number }
  artifact?: ArtifactRef
}

type ContextPacketV1 = {
  schemaVersion: 1
  contextPacketId: ContextPacketId
  threadId: ThreadId
  turnId: TurnId
  epochId: ContextEpochId
  workspaceRevision: RevisionSetV1
  sourceSnapshots: ContextSourceSnapshotV1[] // deterministic order defined in §15.3
  includedMessageRanges: Array<{ firstEvent: UInt64Decimal; lastEvent: UInt64Decimal; digest: Digest }>
  omittedMessageRanges: Array<{ firstEvent: UInt64Decimal; lastEvent: UInt64Decimal; reason: string; recoverableRef: ArtifactRef }>
  summaryRefs: ArtifactRef[]
  toolsetDigest: Digest
  staticPrefixDigest: Digest
  prefixReuseSource?: {
    sourceThreadId: ThreadId; sourceContextPacketId: ContextPacketId
    prefixDigest: Digest; sourceRangeDigest: Digest
  }
  profileRevision: ProfileRevisionRef
  routeSnapshotId: ProviderRouteSnapshotId
  policyDigest: Digest
  pruningPolicyDigest: Digest
  recoveryPolicyDigest: Digest
  tokenBudget: { inputMax: number; outputReserve: number; estimatorId: string; uncertainty: number }
  estimatedInputTokens: number
  requestDigest: Digest
  createdAt: Timestamp
}

type CompactionRecordV1 = {
  schemaVersion: 1
  compactionId: CompactionId
  threadId: ThreadId
  baseEpochId: ContextEpochId
  sourceCursor: Cursor
  sourceSetDigest: Digest
  recoveryPolicyRef: ArtifactRef // immutable ContextRecoveryPolicyV1 bytes, including policyDigest
  recoveryPolicyDigest: Digest
  compositionGeneration: CompositionGenerationId
  compositionLockDigest: Digest
  resolvedGlobalHookSetRef: ArtifactRef // immutable ordered GlobalHookResolutionV1 set from §13
  trigger: CompactionTriggerV1
  sourceRanges: Array<{ firstEvent: UInt64Decimal; lastEvent: UInt64Decimal; digest: Digest }>
  stage: ContextPressureStage
  attemptOrdinal: number
  strategyDigest: Digest
  previousFailureCode?: string
  failureCode?: string
  method: "EXACT_DEDUPLICATION" | "SUPERSEDED_OBSERVATION_OMISSION" | "TOOL_RESULT_EVICTION" | "STALE_OBSERVATION_PRUNE" | "DETERMINISTIC_TRUNCATION" | "STRUCTURED_EXTRACTION" | "STRUCTURAL_COMPACTION" | "ABSTRACTIVE_SUMMARY" | "EPOCH_COMPACTION" | "EMERGENCY_RECOVERY"
  summaryRef?: ArtifactRef
  modelRouteSnapshotId?: ProviderRouteSnapshotId
  promptDigest?: Digest
  resultDigest?: Digest
  reversible: boolean
  status: "ADMITTED" | "PREVIEWED" | "COMMITTED" | "FAILED" | "ABORTED"
}
// Rebuildable ThreadService projection derived from CompactionRecordV1 history.
type CompactionRecoveryStateV1 = {
  threadId: ThreadId; epochId: ContextEpochId; sourceSetDigest: Digest
  recoveryPolicyDigest: Digest
  stage: ContextPressureStage; nextAttemptOrdinal: number; consecutiveFailures: number
  attemptedStrategyDigests: Digest[] // bounded by the pinned recovery-attempt limit
  lastFailureCode?: string; circuit: "CLOSED" | "OPEN"
}
```

`ContextEpochV1` is the immutable baseline; `ContextPacketV1` is one request-specific
projection. Workspace revision, route/profile/toolset/policy, static prefix and
pruning-policy digests are explicit packet inputs. Provider-managed prompt-cache
behavior is metadata only; this schema does not create a local provider response
cache.

Canonical Thread history is append-only. Compaction produces a derived context
epoch and retained source references; it cannot delete or rewrite message events.
Abstractive summaries are marked lossy and untrusted, keep their prompt/model/source
provenance, and never become system authority. A failure leaves the prior epoch
active. Concurrent input or tool completion forces compaction to rebase at the next
safe boundary or abort; it cannot silently omit events after its source cursor.

`ContextPressureStage` is the fixed, bounded escalation order defined in §15.3.
`sourceSetDigest` binds semantic source content/range digests, relevant source
heads/generations, profile/route/toolset/policy and token budget used for the attempt.
It excludes the Thread bookkeeping cursor, recovery admission/preview/failure/abort,
provider rejection/retry bookkeeping, timestamps and uncommitted recovery outputs.
`sourceCursor` separately pins optimistic concurrency; advancing only bookkeeping
cannot reset the breaker. New input, completed tool content or changed authoritative
source content is a relevant semantic change. `recoveryPolicyRef` retains the exact
immutable `ContextRecoveryPolicyV1`; its ArtifactRef digest authenticates bytes and
`recoveryPolicyDigest` equals the policy's declared canonical policy digest. These
digests pin finite total/per-stage limits and whether abstractive compaction is allowed.
Compaction admission also retains the exact composition generation/lock and resolved
global-hook set, including requiredness, ordering, contribution/contract digests and
optional-unavailable status. Restart uses that immutable resolution, never current
registration; missing/quarantined required dependencies fail the admitted operation
without silently switching hooks or replenishing its allowance.
`CompactionRecoveryStateV1` is a rebuildable view,
not a second Thread owner or independently writable breaker. ThreadService derives it
from committed `CompactionRecordV1` facts; `attemptedStrategyDigests` cannot exceed the
pinned finite recovery budget. A breaker is scoped to the exact epoch/source set and
clears only when that relevant source set changes or a new ContextEpoch is committed.
A successor epoch resets allowance only when its effective semantic context changes;
an epoch ID or bookkeeping-only commit cannot replenish the same semantic source set's
allowance. Relevant source heads here are content/generation heads, not unfiltered owner
log heads containing those excluded events. Admission is committed before extraction/summary work and
consumes an ordinal even when the process crashes before preview; restart derives
remaining limits from all admissions and the retained policy artifact.

## 12.5 Goal, spec, Run, Task, Attempt and worker records

```ts
type GoalV1 = {
  schemaVersion: 1; goalId: GoalId; projectId: ProjectId
  originalRequest: ArtifactRef; activeSpecVersionId?: SpecVersionId
  controlThreadId: ThreadId; state: GoalState; createdAt: Timestamp
}
type SpecVersionV1 = {
  schemaVersion: 1; specVersionId: SpecVersionId; goalId: GoalId
  version: number; parentSpecVersionId?: SpecVersionId
  objective: ArtifactRef; requirements: ArtifactRef; assumptions: ArtifactRef
  exclusions: ArtifactRef; scope: ArtifactRef; taskDag: ArtifactRef
  acceptanceScenarios: AcceptanceScenarioV1[]; verificationPlan: ArtifactRef
  reviewBundleDigest: Digest; state: SpecVersionState; approvalReceipt?: ArtifactRef
  createdAt: Timestamp
}
type RunV1 = {
  schemaVersion: 1; runId: RunId; goalId: GoalId; specVersionId?: SpecVersionId
  projectId: ProjectId; controlThreadId: ThreadId
  repositoryMemberIds: RepositoryMemberId[]; state: RunState
  stateReasonCode?: string; policyDigest: Digest; configDigest: Digest
  routePolicyDigest: Digest; budgetId: BudgetId; ownerEpoch: UInt64Decimal
  createdAt: Timestamp; updatedAt: Timestamp
}
type CompletionPredicateResultV1 = {
  runId: RunId; complete: boolean; evaluatedAt: Timestamp
  ownerCursors: Cursor[]
  clauses: Array<{ clauseId: string; satisfied: boolean; blockerCodes: string[]; evidenceRefs: ArtifactRef[] }>
}
type TaskV1 = {
  schemaVersion: 1; taskId: TaskId; runId: RunId; specVersionId: SpecVersionId
  dependencies: TaskId[]; acceptanceScenarioIds: ScenarioId[]
  repositoryMemberIds: RepositoryMemberId[]; readScopeDigest: Digest
  writeScopeDigest: Digest; profileRevision: ProfileRevisionRef
  budgetId: BudgetId; attemptLimit: number; attemptIds: AttemptId[]
  state: TaskState
}
type AttemptV1 = {
  schemaVersion: 1; attemptId: AttemptId; taskId: TaskId
  strategyDigest: Digest; profileRevision: ProfileRevisionRef
  routeSnapshotId: ProviderRouteSnapshotId; contextPacketId: ContextPacketId
  workspaceBindings: WorkspaceBindingRef[]; budgetReservationId: ReservationId
  workerExecutionIds: WorkerExecutionId[]; state: AttemptState
  executionLimitStateRef: ArtifactRef // latest owner-committed ExecutionLimitStateV1, shared across replacements
  createdAt: Timestamp; endedAt?: Timestamp
}
type WorkerExecutionV1 = {
  schemaVersion: 1; workerExecutionId: WorkerExecutionId; attemptId: AttemptId
  incarnation: number; replacementOf?: WorkerExecutionId
  threadId?: ThreadId; executionId?: ExecutionId; launchId: LaunchId
  adapterId: string; adapterBuildDigest: Digest; ownerEpoch: UInt64Decimal
  binding: WorkerBindingV1; state: WorkerExecutionState
  observationRefs: ArtifactRef[]; launchReceipt?: ArtifactRef
  result?: WorkerResultV1; createdAt: Timestamp; endedAt?: Timestamp
}
```

These records are canonical Rust-owned aggregates; model proposals, host projections
and worker observations cannot write their state. Their state enums and transitions
are closed by §11. Cross-aggregate preparation/approval/activation emits separately
committed owner events linked by IDs and causation; there is no implicit atomic
transaction across Goal, SpecVersion and Run.
`RunV1.specVersionId` is absent only while `DISCOVERING`/`SPECIFYING`; it is pinned to
the approved immutable SpecVersion before the Run enters `READY`.

## 12.6 Provider route, capability, fallback and usage

```ts
type ProviderRouteSnapshotV1 = {
  schemaVersion: 1
  snapshotId: ProviderRouteSnapshotId
  providerId: string
  modelId: string
  protocolId: string
  protocolVersion: string
  adapterBuildDigest: Digest
  endpoint: { origin: string; path: string; queryDigest: Digest }
  modelMetadataDigest: Digest
  capabilityDigest: Digest
  reasoning: { requested?: string; effective?: string; fixed: boolean }
  generationOptionsDigest: Digest
  authMethodId: string
  secretRef?: SecretRef // never secret bytes
  fallbackSnapshotIds: ProviderRouteSnapshotId[] // explicit order only
  fallbackPolicy: "none" | "pre_content_only"
  selectedAt: Timestamp
  digest: Digest
}

type CapabilityStatusV1 = { value: "supported" | "unsupported" | "unknown"; evidenceRef?: ArtifactRef; observedAt?: Timestamp }
type ProviderCapabilitySnapshotV1 = {
  providerId: string; modelId: string; protocolId: string; metadataDigest: Digest
  contextLimit?: number; outputLimit?: number; toolCalling: CapabilityStatusV1
  reasoningEfforts: string[]; mediaTypes: string[]; structuredOutput: CapabilityStatusV1
  providerExecutedTools: CapabilityStatusV1; observedAt: Timestamp; expiresAt?: Timestamp
}

type UsageObservationV1 = {
  usageObservationId: UsageObservationId
  source: "provider-reported" | "adapter-derived" | "estimated" | "external-peer-reported" | "unknown"
  modelAttemptId?: ModelAttemptId
  workerExecutionId?: WorkerExecutionId
  inputTokens?: UInt64Decimal; outputTokens?: UInt64Decimal; cachedInputTokens?: UInt64Decimal
  amountMicros?: UInt64Decimal; currency?: string
  confidence: "reported" | "derived" | "estimated" | "unknown"
  rawReceipt?: ArtifactRef
  observedAt: Timestamp
}
```

Selection precedence is explicit invocation → fixed selected-profile model → fixed
default-subagent setting → permitted parent inheritance when requested by the selected
profile/default setting → main-agent default → `peer_managed` only for a peer that owns
its own model. No price/latency/subscription heuristic changes the selected model or
reasoning. Provider catalog data is advisory until the exact route/protocol/capability
is validated. A fallback must be explicitly configured, pre-content safe,
capability-equivalent for the task, authorized, and budgeted.

`ModelSelection.mode = "inherit_parent"` is valid only for an invocation with a parent.
It resolves to the parent's already-resolved fixed provider/model route and is pinned
as the child's `ProviderRouteSnapshotV1`; the child adapter must support applying that
route and pass its own capability, policy, secret and budget checks. A root/main
invocation without a parent cannot use it. If the parent has no concrete fixed route or
the adapter cannot honor it, the child is ineligible and the caller must ask or remain
local rather than silently choosing another model. `peer_managed` is valid only when
the selected external adapter explicitly delegates model choice to that peer; it is not
a fallback for a missing local route.

UsageService is the canonical owner of append-only usage observations. Provider-
reported, adapter-derived, estimated, external-peer-reported and unknown provenance
remain distinct; estimates never overwrite reports. BudgetService owns limits,
reservations and accounting settlement, and consumes observations by stable ID; it does
not own or duplicate usage facts. Analytics is a rebuildable read model derived from
the owner streams.

## 12.7 Budgets and reservations

```ts
type BudgetLimitV1 = {
  dimension: "provider_calls" | "input_tokens" | "output_tokens" | "wall_time_ms" | "worker_executions" | "parallel_workers" | "tool_calls" | "process_output_bytes" | "network_bytes" | "artifact_bytes" | "estimated_cost_micros"
  limit: UInt64Decimal
  hard: boolean
}
type BudgetV1 = {
  budgetId: BudgetId
  owner: BudgetOwnerV1
  parentBudgetId?: BudgetId
  limits: BudgetLimitV1[]
  policyDigest: Digest
  revision: number
}
type BudgetOwnerV1 =
  | { kind: "direct_thread"; threadId: ThreadId }
  | { kind: "direct_turn"; threadId: ThreadId; turnId: TurnId }
  | { kind: "managed_run"; runId: RunId }
  | { kind: "managed_task"; runId: RunId; taskId: TaskId }
  | { kind: "managed_attempt"; runId: RunId; taskId: TaskId; attemptId: AttemptId }
type BudgetReservationV1 = {
  reservationId: ReservationId
  budgetId: BudgetId
  subjectId: string
  deliveryId: DeliveryId
  reserved: BudgetLimitV1[]
  settled: BudgetLimitV1[]
  state: "RESERVED" | "PARTIALLY_SETTLED" | "SETTLED" | "RELEASED" | "UNKNOWN"
}
type BudgetSettlementV1 = {
  settlementId: BudgetSettlementId
  reservationId: ReservationId
  usageObservationIds: UsageObservationId[]
  settled: BudgetLimitV1[]
  outcome: "PARTIAL" | "FINAL" | "UNKNOWN"
  observedAt: Timestamp
}
```

Reservation is an atomic controller decision before provider, worker or effect
dispatch. For each hard dimension, `spent + active_reserved + requested <= limit` at
all ancestors. Child reservations debit their parent once; settlement releases only
the unused remainder. Observed overrun is recorded as overrun and blocks new work;
it is never clamped to a green balance. Extending a hard limit requires a typed
NeedsYou response bound to the new budget revision. `UNKNOWN` usage retains the
reservation until authoritative reconciliation; a user acknowledgement does not
release possibly spent capacity or convert uncertainty to settlement.
BudgetService validates each discriminated owner against its canonical parent; direct
Turn reservations debit the Thread hierarchy without synthetic Run/Task/Attempt IDs.
Managed and direct budgets use the same admission/settlement owner and implementation.

## 12.8 Tool, batch, resource resolver and result contracts

```ts
type ToolDefinitionV1 = {
  toolId: ToolId
  version: string
  inputSchema: JsonSchemaRef
  outputSchema?: JsonSchemaRef
  description: string
  effectClass: "pure_read" | "workspace_read" | "workspace_write" | "process" | "network" | "external_mutation" | "control"
  resourceResolverId: string
  parallelism: "parallel_safe" | "resource_serialized" | "exclusive"
  approval: "never" | "policy" | "always"
  executorRef: string // sealed owner or isolated adapter reference, never plugin function bytes
  maxArgumentBytes: number
  maxResultBytes: number
  timeoutMs: number
  capabilityRequirements: string[]
}
type ToolInvocationV1 = {
  toolCallId: ToolCallId; toolId: ToolId; schemaDigest: Digest
  argumentArtifact: ArtifactRef; argumentDigest: Digest; ordinal: number
}
type ToolBatchV1 = {
  // Canonical owner is ThreadService; executor reports do not mutate this aggregate.
  toolBatchId: ToolBatchId; threadId: ThreadId; turnId: TurnId
  modelAttemptId: ModelAttemptId; profileRevision: ProfileRevisionRef
  toolsetDigest: Digest; calls: ToolInvocationV1[]; aggregateBytes: number
  state: "COLLECTING" | "ADMITTED" | "SETTLING" | "SETTLED" | "REJECTED" | "SUSPENDED_FOR_INPUT"
}
type ToolResultV1 = {
  toolCallId: ToolCallId; status: "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "CANCELLED"
  structured?: ArtifactRef; content: ArtifactRef[]; effectId?: EffectId
  error?: TypedErrorV1; startedAt?: Timestamp; endedAt?: Timestamp
}
type ReadObservationCacheEntryV1 = {
  cacheId: string
  toolId: ToolId
  toolSchemaDigest: Digest
  toolsetDigest: Digest
  canonicalArgumentsDigest: Digest
  resourceResolutionDigest: Digest
  sourceRevision?: RevisionSetV1
  repoGenerationIds?: RepoGenerationId[]
  readPolicyDigest: Digest
  principalScopeDigest: Digest
  originalObservation: ArtifactRef
  capturedAt: Timestamp
  expiresAt?: Timestamp
}
type ResourceResolutionV1 = {
  claims: ResourceClaim[]; canonicalizedArgumentsDigest: Digest
  workspaceBinding?: WorkspaceBindingRef; beforeRevision?: RevisionSetV1
  resolverVersion: string; resolutionDigest: Digest
}
```

ThreadService owns ToolBatch admission, lifecycle, and committed ordered results in the
Thread event stream. ToolExecutionCoordinator executes admitted calls and returns a
bounded incremental per-call acknowledgements plus a final ordered observation report;
it cannot transition ToolBatch or write a separate
canonical ToolBatch store. A ToolResult is an executor observation until ThreadService
validates and commits its linked result fact.
The sole incremental Interface is `ToolCallObservationV1`/`ToolCallAcknowledgementV1`
in §13; it references these domain results without defining another acknowledgement.
Acknowledgement retry with the same call/delivery/digest returns the committed cursor;
conflicting result bytes refuse. Required post-hook completion/failure is linked to
that cursor before dependent calls proceed; final reports reference these cursors and
cannot recommit or overwrite a result.

The model-visible definition is distinct from the executor. Resolve canonical
resources using the owner-specific resolver before Guard. If resolution is unknown,
fail closed or ask; never substitute a guessed resource. The tool call is frozen at
the pinned schema/generation; post-approval argument rewrite is invalid. Tool
results return in original call order even when independent calls execute in
parallel. Results are untrusted model context, not proof. Observation reuse is limited
to pure reads/query results whose resource, source revision/generation, read-policy,
principal scope and schema/toolset digests still match. Reauthorize the current read;
return the original observation timestamp/provenance as cached. Shell, writes, network,
or external mutations are never cache hits.

## 12.9 Effect, approval, audit and reconciliation records

```ts
type EffectIntentV1 = {
  effectId: EffectId
  origin: EffectOriginV1
  toolCallId?: ToolCallId; actionId: string; ownerKind: "filesystem" | "process" | "git" | "network" | "mcp" | "connector" | "plugin" | "external-agent" | "other"
  resourceResolution: ResourceResolutionV1
  argumentDigest: Digest; displayedContentDigest?: Digest; policyDigest: Digest
  approvalChallengeId?: ApprovalChallengeId; idempotencyKey?: string
  workspaceFenceEpoch?: UInt64Decimal; budgetReservationId?: ReservationId
  executionPlanDigest: Digest; state: EffectState
}
type EffectSettlementV1 = {
  effectId: EffectId; outcome: "present" | "absent" | "partial" | "unknown"
  beforeRevision?: RevisionSetV1; afterRevision?: RevisionSetV1
  outputRefs: ArtifactRef[]; receiptRef?: ArtifactRef
  reconcilerId?: string; evidenceRefs: ArtifactRef[]; observedAt: Timestamp
}
type CapabilityLeaseV1 = {
  leaseId: CapabilityLeaseId; effectId: EffectId
  principal: PrincipalRef; actionId: string
  argumentDigest: Digest; resourceDigest: Digest; policyDigest: Digest
  workspaceBinding?: WorkspaceBindingRef; budgetReservationId?: ReservationId
  backendId: string; executableGenerationDigest: Digest
  issuedAt: Timestamp; expiresAt: Timestamp; state: CapabilityLeaseState
}
type ApprovalChallengeV1 = {
  challengeId: ApprovalChallengeId; effectId: EffectId; subjectDigest: Digest
  principal: PrincipalRef; actionId: string; resources: ResourceClaim[]
  displayedContentDigest: Digest; policyDigest: Digest; resourceStateDigest: Digest
  allowedResponses: Array<"ALLOW_ONCE" | "ALLOW_RUN_SCOPE" | "DENY" | "CANCEL_OPERATION">
  expiry: Timestamp; state: ApprovalState; resolutionReceipt?: ArtifactRef; grantId?: ApprovalGrantId
}
type ApprovalGrantV1 = {
  grantId: ApprovalGrantId
  challengeId: ApprovalChallengeId
  principal: PrincipalRef
  actionId: string
  resourceScopeDigest: Digest
  policyDigest: Digest
  expiresAt: Timestamp
  scope:
    | { kind: "single_use"; effectId: EffectId }
    | { kind: "run_scope"; runId: RunId; taskId?: TaskId; attemptId?: AttemptId }
  remainingUses?: number
  revokedAt?: Timestamp
  createdAt: Timestamp
}
type SecretMetadataV1 = {
  secretRef: SecretRef; version: UInt64Decimal; providerId?: string; authMethodId: string
  displayName: string; createdAt: Timestamp; lastRotatedAt?: Timestamp
  expiresAt?: Timestamp; status: "AVAILABLE" | "EXPIRED" | "REVOKED" | "MISSING"
}
type SecretPutRequestV1 = {
  secretRef?: SecretRef; authMethodId: string; providerId?: string
  displayName: string; secureInputHandle: string; expiresAt?: Timestamp
}
type SecretUseRequestV1 = {
  secretRef: SecretRef; secretVersion: UInt64Decimal
  requestingService: ServiceId; recipientProcessDigest: Digest
  providerId: string; authMethodId: string; routeDigest: Digest
  destinationOrigin: string; operationDigest: Digest; purpose: string
  profileRevision?: ProfileRevisionRef; runId?: RunId
  maxRequests: 1; expiresAt: Timestamp
}
type SecretUseLeaseV1 = {
  leaseId: SecretUseLeaseId; secretRef: SecretRef; secretVersion: UInt64Decimal
  requestDigest: Digest
  recipientProcessDigest: Digest; routeDigest: Digest
  maxRequests: 1; expiresAt: Timestamp
  state: "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED"
}
type SecretRevocationReceiptV1 = {
  secretRef: SecretRef; revokedAt: Timestamp; affectedLeaseIds: SecretUseLeaseId[]
  receiptDigest: Digest
}
type AuditRecordV1 = {
  auditId: AuditId; actorRef: ActorRef; action: string; decision: "ALLOW" | "ASK" | "DENY" | "SETTLED" | "UNKNOWN" | "RECONCILED"
  subjectIds: string[]; policyDigest: Digest; resourceDigest?: Digest; effectId?: EffectId
  previousRecordDigest: Digest; recordDigest: Digest; signatureRef?: ArtifactRef; timestamp: Timestamp
}
```

EffectService owns `EffectIntentV1` and settlement stream. Guard owns approval
challenge/resolution and `ApprovalGrantV1` facts. `ALLOW_ONCE` creates a grant with one
remaining use; `ALLOW_RUN_SCOPE` creates a revocable, expiring grant bound to one Run,
principal, action, resource-scope digest and policy digest. Neither grant overrides a
current deny or survives a binding mismatch. AuditService owns linked security
records only; it does not duplicate Run or Thread event streams. A target-specific reconciler must state
what authoritative observation proves `present` or `absent`; absence of a process,
timeout, empty output, or retry response is insufficient by itself.

## 12.10 Profiles, subagent package and external adapter capability

```ts
type HookEventV1 =
  | "before_start" | "after_start" | "before_tool" | "after_tool" | "tool_failure"
  | "before_finish" | "after_finish" | "on_failure" | "on_idle"
  | "before_compaction" | "after_compaction"
type AgentLifecycleHookEvent = Exclude<HookEventV1, "before_compaction" | "after_compaction">
type AgentHookBindingV1 = {
  event: AgentLifecycleHookEvent
  hookId: HookId
  required: boolean
}
type AgentProfileV1 = {
  profileId: AgentProfileId; revision: number; name: string; description: string
  source: "builtin" | "user" | "project" | "plugin" | "external"
  roles: Array<"main" | "subagent">
  purpose: string; whenToUse: string; whenNotToUse: string
  adapter: { kind: "native" | "acp" | "cli"; adapterId: string; executableDigest?: Digest }
  model: ModelSelection; reasoning: ReasoningSelection
  loadout: { nativeToolIds: ToolId[]; skillIds: string[]; mcpToolRefs: string[] }
  lifecycleHooks: AgentHookBindingV1[]
  invocation: { mode: "manual_only" | "suggest" | "automatic"; categories: string[]; languages: string[]; pathGlobs: string[]; exclusions: string[]; priority: number }
  contextPolicy: "fresh" | "selected_history" | "reviewed_fork"
  memoryPolicy: "none" | "relevant_shared" | "shared_and_profile"
  isolation: "read_only" | "workspace" | "external"
  permissionCeilingDigest: Digest; limits: AgentLimits; enabled: boolean; definitionDigest: Digest
}
type DefaultSubagentSettingsV1 = { enabled: boolean; profileId: "builtin.general"; model: ModelSelection; reasoning: ReasoningSelection }
type AgentCapabilitySnapshotV1 = {
  profileRevision: ProfileRevisionRef; adapterBuildDigest: Digest
  executionMode: "native" | "mediated_acp" | "opaque_acp" | "opaque_cli" | "container" | "remote"
  capabilities: Record<string, CapabilityStatusV1>
  canResume: CapabilityStatusV1; canSteer: CapabilityStatusV1; canReportUsage: CapabilityStatusV1
  workspaceIsolation: GuaranteeLevel; perToolMediation: GuaranteeLevel
  maxParallel: number; observedAt: Timestamp; expiresAt?: Timestamp; provenance: ArtifactRef
}
type WorkerBindingV1 = {
  workerExecutionId: WorkerExecutionId
  attemptId: AttemptId
  incarnation: number
  ownerEpoch: UInt64Decimal
  profileRevision: ProfileRevisionRef
  capabilitySnapshotDigest: Digest
  lifecycleHookSetDigest: Digest
  executionLimitStateRef: ArtifactRef // current Attempt-owned ExecutionLimitStateV1
  taskPackage: TaskPackageV1
  executionLocation: ExecutionLocationRef
  workspaceBindings: WorkspaceBindingRef[]
  budgetReservationId: ReservationId
  compositionGeneration: CompositionGenerationId
  verificationPermitId?: Id<"VerificationPermitId">
}
type DirectWorkerBindingV1 = {
  kind: "direct"
  delegationRootId: WorkerExecutionId // original execution ID; stable DirectDelegation identity
  workerExecutionId: WorkerExecutionId; replacementOf?: WorkerExecutionId
  parentThreadId: ThreadId; parentTurnId: TurnId
  childThreadId: ThreadId; incarnation: number; ownerEpoch: UInt64Decimal
  profileRevision: ProfileRevisionRef; capabilitySnapshotDigest: Digest
  lifecycleHookSetDigest: Digest; executionLimitStateRef: ArtifactRef
  taskPackage: DirectTaskPackageV1
  executionLocation: ExecutionLocationRef; workspaceBindings: WorkspaceBindingRef[]
  budgetReservationId: ReservationId; compositionGeneration: CompositionGenerationId
}
type ExecutionLimitStateV1 = {
  schemaVersion: 1
  owner: { kind: "managed_attempt"; attemptId: AttemptId } | { kind: "direct_delegation"; delegationRootId: WorkerExecutionId }
  profileRevision: ProfileRevisionRef; lifecycleHookSetDigest: Digest; limits: AgentLimits
  completedProviderResponses: UInt64Decimal; inputTokens: UInt64Decimal
  outputTokens: UInt64Decimal; toolCalls: UInt64Decimal; elapsedWallTimeMs: UInt64Decimal
  sourceCursors: Cursor[]; previousStateDigest?: Digest; digest: Digest
}
type DirectDelegationV1 = {
  schemaVersion: 1; delegationRootId: WorkerExecutionId
  workerExecutionId: WorkerExecutionId // current incarnation, initially equals root
  parentThreadId: ThreadId; parentTurnId: TurnId; childThreadId: ThreadId
  binding: DirectWorkerBindingV1; state: WorkerExecutionState
  executionLimitStateRef: ArtifactRef; dispatchId: DispatchId; launchId: LaunchId
  executionId?: ExecutionId; launchReceipt?: ArtifactRef; observationRefs: ArtifactRef[]
  result?: DirectWorkerResultV1; createdAt: Timestamp; endedAt?: Timestamp
  executionHistory: Array<{
    workerExecutionId: WorkerExecutionId; replacementOf?: WorkerExecutionId; incarnation: number
    dispatchId: DispatchId; launchId: LaunchId; executionId?: ExecutionId
    observationRefs: ArtifactRef[]; result?: DirectWorkerResultV1
  }> // bounded retained prior incarnations; not additional lifecycle owners
}
type WorkerAdapterObservationV1 = {
  workerExecutionId: WorkerExecutionId
  sequence: UInt64Decimal
  observation: "launched" | "progress" | "result" | "failed" | "cancelled" | "unknown"
  receipt?: ArtifactRef
  progress?: WorkerProgressV1
  result?: WorkerResultV1 | DirectWorkerResultV1 // result.kind discriminates the owning lifecycle
  error?: TypedErrorV1
  observedAt: Timestamp
}
```

`hookId` references a registered Hook contribution resolved from the pinned
`CompositionGeneration`; it is not inline code or a shell-script field. The profile's
`definitionDigest` covers its ordered lifecycle-hook bindings and `AgentLimits`.
`lifecycleHookSetDigest` binds the resolved ordered hook set, contribution/package
digests, event contracts, and compatibility/enforcement status for this worker. Optional
unsupported bindings are represented as unavailable in that pinned resolution; a
required unresolved or incompatible binding prevents dispatch.

```ts
type WorkerPreparedV1 = {
  workerExecutionId: WorkerExecutionId; requestDigest: Digest; expiresAt: Timestamp
}
type WorkerSteerMessageV1 = { messageId: MessageId; body: ArtifactRef; createdAt: Timestamp }
interface WorkerAdapterV1 {
  probe(profileRevision: ProfileRevisionRef): Promise<AgentCapabilitySnapshotV1>
  prepare(binding: WorkerBindingV1 | DirectWorkerBindingV1): Promise<WorkerPreparedV1>
  launch(prepared: WorkerPreparedV1, stableDispatchId: DispatchId): Promise<WorkerAdapterObservationV1>
  observe(workerExecutionId: WorkerExecutionId): Promise<WorkerAdapterObservationV1[]>
  steer(workerExecutionId: WorkerExecutionId, message: WorkerSteerMessageV1): Promise<WorkerAdapterObservationV1>
  requestCancel(workerExecutionId: WorkerExecutionId): Promise<WorkerAdapterObservationV1>
  reconcile(workerExecutionId: WorkerExecutionId): Promise<WorkerAdapterObservationV1>
}
```

`steer` and `requestCancel` may be declared
unsupported in the pinned capability snapshot. Launch is idempotent by stable
dispatch ID; an ambiguous launch returns `UNKNOWN`, not a new execution. Every
observation is bounded, sequence-checked and provenance-bound. The adapter cannot
write Task/Attempt/Run states, approve Effects, or emit accepted Evidence; only
RunController and VerificationService own those transitions.
ThreadService commits direct delegation state/results to the parent Thread stream;
the adapter never writes those owner facts. Managed bindings retain their existing
required Attempt/TaskPackage identities; direct bindings/packages prohibit Run, Task,
Attempt, SpecVersion and verification-permit fields. Only eligible native profiles
are admitted to the direct branch; this adds no adapter interface or profile registry.
`delegationRootId` equals the original WorkerExecutionId and remains the aggregate and
hard-limit owner identity across replacements. A replacement has a fresh
workerExecutionId, `replacementOf`, incremented incarnation and preallocated stable
dispatchId/launchId; ThreadService retains prior identities/receipts in executionHistory.
Bindings/packages pin the current immutable limit-state artifact and validate it against
the canonical root/Attempt state at admission; stale refs cannot restore allowance.
Direct replacement never creates a new root, child Thread or profile/hook budget.

Built-ins: `builtin.general`, `builtin.architect`, `builtin.explorer`,
`builtin.implementer`, `builtin.reviewer`, `builtin.test-debugger`. `builtin.verifier`
and `builtin.recovery` are controller roles, not general task-worker profiles.
Manual-only profiles never auto-launch. Automatic matching must yield exactly one
eligible profile after exclusions, capability, budget, workspace and policy checks;
otherwise use enabled general fallback or ask.

Delegation contracts:

```ts
type TaskPackageV1 = {
  taskId: TaskId; attemptId: AttemptId; objective: string; specDigest: Digest
  inputContract: ArtifactRef; outputContract: ArtifactRef; constraints: ArtifactRef[]
  knownPaths: string[]; symbolRefs: ArtifactRef[]; sourceRevision: RevisionSetV1
  toolsetDigest: Digest; profileRevision: ProfileRevisionRef; acceptanceScenarioIds: ScenarioId[]
  contextPacket: ArtifactRef; budgetReservationId: ReservationId; workspaceBindings: WorkspaceBindingRef[]
  executionLimitStateRef: ArtifactRef
}
type WorkerProgressV1 = { workerExecutionId: WorkerExecutionId; sequence: UInt64Decimal; phase: string; percent?: number; messageRef?: ArtifactRef; observedAt: Timestamp }
type WorkerResultV1 = {
  kind: "managed"
  workerExecutionId: WorkerExecutionId; taskId: TaskId; status: "finished" | "failed" | "unknown" | "cancelled"
  findings: ArtifactRef[]; changedPaths: string[]; candidateRevision?: RevisionSetV1
  evidenceCandidates: ArtifactRef[]; unresolvedQuestions: NeedsYouId[]; limitations: string[]
  outputArtifacts: ArtifactRef[]; usageObservationIds: UsageObservationId[]
  error?: TypedErrorV1
}
type DirectTaskPackageV1 = {
  delegationRootId: WorkerExecutionId; executionLimitStateRef: ArtifactRef
  parentThreadId: ThreadId; parentTurnId: TurnId; childThreadId: ThreadId
  objective: string; inputContract: ArtifactRef; outputContract: ArtifactRef
  constraints: ArtifactRef[]; knownPaths: string[]; symbolRefs: ArtifactRef[]
  sourceRevision: RevisionSetV1; toolsetDigest: Digest; profileRevision: ProfileRevisionRef
  contextPacket: ArtifactRef; budgetReservationId: ReservationId
  workspaceBindings: WorkspaceBindingRef[]
}
type DirectWorkerResultV1 = {
  kind: "direct"; delegationRootId: WorkerExecutionId; workerExecutionId: WorkerExecutionId
  parentThreadId: ThreadId; parentTurnId: TurnId; childThreadId: ThreadId
  status: "finished" | "failed" | "unknown" | "cancelled"
  findings: ArtifactRef[]; changedPaths: string[]; candidateRevision?: RevisionSetV1
  unresolvedQuestions: NeedsYouId[]; limitations: string[]
  outputArtifacts: ArtifactRef[]; usageObservationIds: UsageObservationId[]
  error?: TypedErrorV1
}
type AgentMessageV1 = { messageId: MessageId; runId: RunId; senderThreadId: ThreadId; recipientThreadId: ThreadId; taskId?: TaskId; replyTo?: MessageId; body: ArtifactRef; deliveryState: "PENDING" | "DELIVERED" | "UNDELIVERABLE"; createdAt: Timestamp }
```

The child receives only the TaskPackage plus the selected reviewed history; no full
parent transcript by default. Parent messages are input, not commands to mutate the
child's Task or policy. Child questions use NeedsYou; cancellation is addressed to a
specific WorkerExecution. Handoff includes evidence refs and limitations. Capability
claims are shown as configured, observed and enforced separately.
Known worker failure carries `error: TypedErrorV1`; profile-limit exhaustion uses
`AGENT_LIMIT_EXCEEDED` and the mandatory typed dimension-details artifact. This applies
to managed and direct results/failed observations, never string-parsed control flow.

## 12.11 Acceptance, evidence and proof pack

```ts
type AcceptanceScenarioV1 = {
  scenarioId: ScenarioId; version: number; requirementId: string; title: string
  setup: ArtifactRef; procedure: ArtifactRef; expected: ArtifactRef
  severity: "required" | "recommended" | "informational"
  verifierClass: string; environmentConstraints: ArtifactRef
}
type ScenarioResultV1 = {
  scenarioId: ScenarioId; scenarioVersionDigest: Digest
  verdict: "PASS" | "FAIL" | "NOT_RUN" | "INCONCLUSIVE"
  observationRefs: ArtifactRef[]; limitationRefs: ArtifactRef[]
  startedAt: Timestamp; endedAt: Timestamp
}
type VerifiedSubjectV1 = {
  specDigest: Digest; revisionSet: RevisionSetV1; workspaceManifestDigests: Digest[]
  policyDigest: Digest; environmentDigest: Digest; toolchainDigest: Digest
  verifierProfileRevision: ProfileRevisionRef; verifierExecutionId: WorkerExecutionId
  verificationPermitDigest: Digest
  scenarioSetDigest: Digest; observationWindow: { startedAt: Timestamp; endedAt: Timestamp }
}
type VerificationPermitV1 = {
  permitId: VerificationPermitId
  runId: RunId
  taskId: TaskId
  attemptId: AttemptId
  specDigest: Digest
  subjectRevisionSet: RevisionSetV1
  policyDigest: Digest
  workspaceManifestDigests: Digest[] // sorted by repository/member subject; exact complete current set
  workspaceBindingRefs: WorkspaceBindingRef[] // read-only views only
  scenarioSetDigest: Digest
  verifierProfileRevision: ProfileRevisionRef
  allowedObservationCapabilities: string[]
  deniedCapabilities: string[] // includes writes, integration, policy mutation, and unapproved external effects
  environmentDigest: Digest
  toolchainDigest: Digest
  expiresAt: Timestamp
  singleUse: true
  state: "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED"
  workerExecutionId?: WorkerExecutionId
  permitDigest: Digest
}
type EvidenceV1 = {
  evidenceId: EvidenceId; runId: RunId; taskId: TaskId; attemptId: AttemptId
  subject: VerifiedSubjectV1; scenarios: ScenarioResultV1[]
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE"; limitations: ArtifactRef[]
  proofPackId: ProofPackId; createdAt: Timestamp
}
type ProofPackV1 = {
  proofPackId: ProofPackId; runId: RunId; taskId?: TaskId
  specDigest: Digest; revisionSet: RevisionSetV1; evidenceIds: EvidenceId[]
  effectReceipts: EffectId[]; checkReceipts: ArtifactRef[]; diffRefs: ArtifactRef[]
  limitations: ArtifactRef[]; generatedAt: Timestamp; digest: Digest
}
```

Verifier independence means a distinct WorkerExecution, separate read-only
workspace view, no producer write capability, and no reliance on worker self-report
as the verdict. The verifier receives the approved scenario and a bounded neutral
TaskPackage, not the producer's entire reasoning transcript. Same provider/model may
be used only when policy permits; that is procedural independence, not a claim of
statistical independence. High-risk requirements may mandate a different provider,
independent deterministic check, or human review.
The permit digest covers immutable policy, complete revision/workspace-manifest set,
scenario/profile/environment/toolchain and exact verifier identity. Consumption and
Evidence production revalidate those bindings against current owners; a policy or
manifest mismatch cannot produce current accepted Evidence.

## 12.12 Repository intelligence, memory and artifacts

```ts
type RepoGenerationV1 = {
  generationId: RepoGenerationId; repositoryId: RepositoryId; workspaceId?: WorkspaceId
  baseGenerationId?: RepoGenerationId; revision: RevisionSetV1; readPolicyDigest: Digest
  parserSetDigest: Digest; status: "BUILDING" | "CURRENT" | "PARTIAL" | "STALE" | "FAILED" | "RETIRED"
  createdAt: Timestamp; diagnostics: ArtifactRef[]
}
type RepoQueryV1 = { queryId: string; generationIds: RepoGenerationId[]; overlayRefs: ArtifactRef[]; operation: "text" | "symbol" | "references" | "impact" | "expand"; query: ArtifactRef; maxResults: number }
type RepoQueryResultV1 = { queryId: string; status: "CURRENT" | "STALE" | "PARTIAL" | "UNAVAILABLE"; generationIds: RepoGenerationId[]; results: ArtifactRef[]; nextCursor?: string }
type MemoryRecordV1 = {
  memoryId: MemoryId; scope: MemoryScopeV1
  content: ArtifactRef; origin: "user_explicit" | "operator_approved" | "derived_observation"
  sourceRefs: ArtifactRef[]; confidence: "high" | "medium" | "low"; generation: number
  acceptedCandidateId?: MemoryCandidateId
  createdAt: Timestamp; expiresAt?: Timestamp; supersedesMemoryIds?: MemoryId[]; tombstonedAt?: Timestamp
  status: "ACTIVE" | "SUPERSEDED" | "TOMBSTONED"
}
type MemoryScopeV1 = { kind: "user" | "project" | "profile" | "thread" | "run"; id: string }
type MemoryExtractionPolicyV1 = {
  policyDigest: Digest; enabled: boolean; permittedTargetScopes: MemoryScopeV1[]
  maxCandidatesPerRange: number; retentionClass: string; requireUserReview: true
}
// Search projection only; MemoryRecordV1 remains the canonical record.
type MemoryIndexEntryV1 = {
  memoryId: MemoryId; scope: MemoryScopeV1; title: string; retrievalHint: string
  contentDigest: Digest; recordGeneration: number; indexGeneration: UInt64Decimal
  freshness: "CURRENT" | "STALE" | "EXPIRED"
}
type ThreadRangeRefV1 = {
  threadId: ThreadId; firstEvent: UInt64Decimal; lastEvent: UInt64Decimal; digest: Digest
}
type MemoryQueryV1 = {
  queryId: MemoryQueryId; permittedScopes: MemoryScopeV1[]; query: ArtifactRef
  memoryGenerationRefs: MemoryGenerationRef[]; principalScopeDigest: Digest
  maxResults: number; maxContentBytes: UInt64Decimal; maxTokenEstimate: number
  includeTranscriptFallback: boolean
}
type MemoryQueryResultV1 = {
  queryId: MemoryQueryId; status: "CURRENT" | "PARTIAL" | "STALE" | "UNAVAILABLE"
  matches: Array<{ memoryId: MemoryId; contentRef: ArtifactRef; freshness: "CURRENT" | "STALE" | "EXPIRED"; rank: number; provenance: ArtifactRef[] }>
  fallbackThreadRanges?: ThreadRangeRefV1[]; nextCursor?: string
}
type MemoryCandidateV1 = {
  candidateId: MemoryCandidateId; proposedScope: MemoryScopeV1; content: ArtifactRef
  sourceRefs: ArtifactRef[]; sourceRange?: ThreadRangeRefV1
  confidence: "high" | "medium" | "low"; proposedSupersedes: MemoryId[]
  sourceGenerationRefs: MemoryGenerationRef[]
  supersessionSources: Array<{ memoryId: MemoryId; generation: number; contentDigest: Digest }>
  policyDigest: Digest; state: "PROPOSED" | "ACCEPTED" | "REJECTED" | "EXPIRED"
  acceptedMemoryId?: MemoryId; reviewReceipt?: ArtifactRef
  candidateDigest: Digest
  createdAt: Timestamp
}
type MemoryExtractionV1 = {
  extractionId: MemoryExtractionId; threadId: ThreadId; sourceCursor: Cursor
  sourceRange: ThreadRangeRefV1; extractorDigest: Digest; policyDigest: Digest
  candidateIds: MemoryCandidateId[]
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"
  failure?: TypedErrorV1; createdAt: Timestamp; updatedAt: Timestamp
}
type MemoryConsolidationV1 = {
  consolidationId: MemoryConsolidationId; scope: MemoryScopeV1
  sourceGeneration: MemoryGenerationRef; inputMemoryIds: MemoryId[]; strategyDigest: Digest
  state: "QUEUED" | "ORIENTING" | "GATHERING" | "CONSOLIDATING" | "PRUNING"
    | "COMPLETED" | "FAILED" | "CANCELLED"
  candidateIds: MemoryCandidateId[]
  failure?: TypedErrorV1; createdAt: Timestamp; updatedAt: Timestamp
}
type ArtifactMetadataV1 = {
  artifactId: ArtifactId; digest: Digest; byteLength: UInt64Decimal; mediaType: string
  ownerRefs: string[]; access: "public" | "workspace" | "sensitive"; retentionClass: string
  createdAt: Timestamp; encryption: "none" | "state-key"; redaction: "not-needed" | "applied" | "unknown"
}
```

Repo queries are bounded, revision-pinned observations. Unsaved editor content is a
separate overlay digest and never changes the base generation. Filesystem watchers
are invalidation hints; bytes, Git receipts and effect receipts establish revision.
Index priority is control/cancellation, active query, changed-file overlay, active
Task neighborhood, dirty-workspace reconciliation, initial indexing, optional
semantic/vector enrichment.

Memory is advisory and provenance-bearing. It cannot grant authority, change Guard
policy, rewrite an approved SpecVersion, or substitute for current repository/effect
observations or Evidence. New user input expresses current intent; when it conflicts
with a managed approved SpecVersion it requires the owning clarification/revision flow,
not silent spec mutation. For factual claims, fresh repository bytes and effect receipts
outrank stored memory. A contradicted or expired record is marked stale in the
rebuildable retrieval projection and may be considered by MemoryConsolidation; it is
excluded from model context by default and is never reasoned around as current truth.
Tombstones prevent stale replicas/projections from reviving deleted records. Artifact
bytes are immutable CAS objects; metadata is owner-controlled. Missing, expired or
inaccessible bytes are represented explicitly. Export is an authorized effect; secrets
are never artifacts.

`user_explicit` records come from direct user-authored memory actions;
`operator_approved` records are accepted proposals with a linked candidate whose review
receipt binds the exact candidate digest and target scope; `derived_observation` is
reserved for deterministic, provenance-complete owner observations and is not a way to
auto-promote model-generated extraction.

`MemoryIndexEntryV1` is a rebuildable search projection and cannot become a second
memory store. Every query is scoped by `permittedScopes`, the caller's current authority,
and explicit result/byte/token bounds. Transcript fallback is a bounded search of
authorized Thread ranges and is attempted only after permitted structured memories;
both result kinds retain source provenance and advisory trust. Extraction reads only a
new completed Thread range and is deduplicated by its source cursor/range digest and
extractor digest. It runs only under an explicitly enabled, scoped extraction policy.
The model may propose `MemoryCandidateV1`; only MemoryService can validate, accept,
reject, supersede or tombstone it. Sensitive/secret or provenance-uncertain candidates
are not automatically accepted.

On `memory/candidate_accepted`, the event links `acceptedMemoryId` and
`acceptedCandidateId` and commits the candidate transition plus its new MemoryRecord in
the same MemoryService owner append, together with accepted supersession links after
fresh source-generation/content-digest revalidation. Review binds candidateDigest,
target scope and exact replacement set; stale sources require a new proposal/review,
not automatic model acceptance. Both `acceptedMemoryId` and `reviewReceipt` are
required for an `ACCEPTED` candidate. Exact replay returns the same record; no candidate
is reported accepted without its linked canonical record.
`supersedesMemoryIds` is the exact accepted set (sorted/unique), not the proposed set;
legacy singular `supersedes` migrates to a singleton only after its existing provenance
and acceptance links validate. Missing review is not repaired by fabricating a receipt.

MemoryConsolidation is a low-priority, bounded and interruptible MemoryService job. It
may produce candidates and proposed supersession links only; records remain ACTIVE
until exact reviewed replacement acceptance in the same MemoryService append. It never silently deletes source
records, rewrites provenance or changes policy/spec/evidence. Existing profile memory
policies are retrieval scopes: `none` retrieves no memory; `relevant_shared` retrieves
only permitted shared user/project/Thread/Run scopes; `shared_and_profile` additionally
retrieves the selected profile's own scope. Profile scope is isolated by profile ID.

## 12.13 Typed errors

```ts
type AgentLimitDimensionV1 = "maxConcurrent" | "maxAttempts" | "maxTurns" | "wallTimeMs" | "inputTokens" | "outputTokens" | "toolCalls"
type AgentLimitExceededDetailsV1 = { dimension: AgentLimitDimensionV1; limit: UInt64Decimal; observed: UInt64Decimal }
type RetryClass = "NEVER" | "SAFE_QUERY_RETRY" | "RETRY_AFTER_RECONCILIATION" | "RETRY_AFTER_CONTEXT_RECOVERY" | "USER_ACTION_REQUIRED" | "RETRY_WITH_NEW_ID";
type RetrySuppressionKeyV1 = {
  ownerKind: string; ownerId: string; operationDigest: Digest; failureCode: string
  relevantStateDigest: Digest; strategyDigest: Digest
}
// Rebuildable owner projection from the existing Attempt/operation history.
type RetrySuppressionStateV1 = {
  key: RetrySuppressionKeyV1; consecutiveFailures: number; autoRetryLimit: number
  // Copied from the owning pinned attempt/retry policy; 0 when no finite bound exists.
  // Saturates at autoRetryLimit; suppression never hides the underlying failure.
  status: "COUNTING" | "SUPPRESSED"; suppressionCode?: "RETRY_SUPPRESSED"
  suppressedAt?: Timestamp; lastFailureCursor: Cursor
}
type TypedErrorV1 = {
  code: string; category: "validation" | "conflict" | "authorization" | "capability" | "not_found" | "unavailable" | "deadline" | "uncertain" | "corruption" | "internal"
  message: string; retryClass: RetryClass; retryAfterMs?: number
  ownerCursor?: Cursor; subjectIds: string[]; details?: ArtifactRef
}
```

Canonical codes include: `INVALID_REQUEST`, `SCHEMA_UNSUPPORTED`,
`INVALID_TRANSITION`, `STALE_CURSOR`, `REPLAY_CONFLICT`, `NOT_FOUND`,
`NOT_AUTHORIZED`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `CHALLENGE_STALE`,
`CHALLENGE_ALREADY_RESOLVED`, `CAPABILITY_UNAVAILABLE`, `COMPATIBILITY_UNSUPPORTED`,
`AGENT_LIMIT_EXCEEDED`, `BUDGET_EXCEEDED`, `STALE_FENCE`, `RESOURCE_CONFLICT`,
`DEPENDENCY_BLOCKED`,
`DEADLINE_EXCEEDED`, `CANCELLED`, `UNKNOWN_OUTCOME`,
`RETRY_SUPPRESSED`,
`UNKNOWN_PROVIDER_ACCEPTANCE`, `UNKNOWN_WORKER_LAUNCH`, `UNKNOWN_EFFECT`,
`PROJECTION_CORRUPT`, `EVENT_LOG_CORRUPT`, `DISK_PRESSURE`,
`RESNAPSHOT_REQUIRED`, `NEEDS_AUTH`, `RATE_LIMITED`, `PROMPT_TOO_LONG`,
`CONTEXT_RECOVERY_EXHAUSTED`, `PROVIDER_ERROR`,
`TRANSPORT_INCOMPATIBLE`, and `INTERNAL_ERROR`. Error strings are diagnostic, never
parsed for control flow; callers branch on `code` and `retryClass`. For
`AGENT_LIMIT_EXCEEDED`, the `details` artifact conforms to
`AgentLimitExceededDetailsV1`, making the exhausted profile-limit dimension, configured
cap and observed value explicit. It is distinct from `BUDGET_EXCEEDED`, which is owned
by BudgetService. `PROMPT_TOO_LONG` is emitted only from a structured, terminal
pre-content rejection (or a local preflight that sends no request); it uses
`RETRY_AFTER_CONTEXT_RECOVERY` and never authorizes a resend without a new validated
ContextPacket. `CONTEXT_RECOVERY_EXHAUSTED` is terminal for automatic recovery of the
pinned source set and is surfaced without provider dispatch.

## 12.14 NeedsYou, checkpoint and rewind records

```ts
type NeedsYouV1 = {
  needsYouId: NeedsYouId
  owner: { ownerKind: string; ownerId: string; cursor: Cursor }
  reason: "PERMISSION" | "QUESTION" | "GOAL_REVIEW" | "CLARIFICATION" | "AUTH" | "PROVIDER_QUOTA" | "CAPABILITY_GAP" | "BUDGET_EXTENSION" | "WORKSPACE_CONFLICT" | "EXTERNAL_WORKER" | "PLUGIN_FAILURE" | "RECOVERY_CHOICE"
  affectedIds: string[]
  questionOrSummary: ArtifactRef
  consequenceOfNoResponse: ArtifactRef
  allowedResponses: Array<{ responseId: string; schema: JsonSchemaRef; effect: "query" | "guarded_mutation" | "control" }>
  expiresAt?: Timestamp
  state: "OPEN" | "ANSWERED" | "CANCELLED" | "EXPIRED" | "SUPERSEDED"
  responseDigest?: Digest
  createdAt: Timestamp
}

type CheckpointV1 = {
  checkpointId: CheckpointId
  projectId: ProjectId
  runId?: RunId
  taskId?: TaskId
  directTurnRef?: { threadId: ThreadId; turnId: TurnId }
  workspaceBindingRefs: WorkspaceBindingRef[]
  repositoryRevisions: RevisionSetV1
  dirtyFileManifest: ArtifactRef // DirtyFileRestoreManifestV1, mandatory retained preimages
  ownerCursors: Cursor[] // sorted by owner kind and ID
  profileRevisions: ProfileRevisionRef[]
  contextEpochIds: ContextEpochId[]
  compositionGenerations: CompositionGenerationId[]
  artifactPins: ArtifactRef[]
  externalEffectsExcluded: EffectId[]
  createdAt: Timestamp
  digest: Digest
}
type DirtyFileRestoreEntryV1 = {
  repositoryMemberId: RepositoryMemberId; path: string // canonical root-relative, non-glob
  existed: boolean; fileKind: "absent" | "regular" | "directory" | "symlink"
  mode?: number // platform-supported permissions; no restored privilege bits
  preimageRef?: ArtifactRef // required for regular bytes or symlink target bytes
  preimageDigest?: Digest; observedIdentityDigest: Digest
}
type DirtyFileRestoreManifestV1 = {
  schemaVersion: 1; workspaceId: WorkspaceId; rootIdentityDigests: Digest[]
  entries: DirtyFileRestoreEntryV1[] // sorted by member/path; unique, bounded exact paths
  digest: Digest
}

type RewindPlanV1 = {
  rewindPlanId: RewindPlanId
  checkpointId: CheckpointId
  requestedScope: { kind: "turn" | "files"; paths?: string[] }
  currentRevisionSet: RevisionSetV1
  targetRevisionSet: RevisionSetV1
  restoreManifest: ArtifactRef
  ownedPaths: string[]
  preservedConcurrentPaths: string[]
  conflicts: ArtifactRef[]
  evidenceToStale: EvidenceId[]
  externalEffectsUnaffected: EffectId[]
  requiredApprovalDigest: Digest
  state: "PREVIEWED" | "APPROVED" | "APPLYING" | "APPLIED" | "CONFLICTED" | "UNKNOWN" | "ABORTED"
  planDigest: Digest
}
```

NeedsYou is a durable projection over the owning domain event, not an independent
authority. A response is validated against its listed schema and submitted to that
owner with the expected cursor; UI text cannot resolve it directly.

Checkpoint pins repository/dirty-file state and relevant owner/config/context/plugin
generations, but external effects remain history and cannot be rolled back. Rewind is
always a previewed owner action, bound to exact current and target digests. It restores
only state owned by the checkpoint/run, preserves unrelated concurrent user changes,
and refuses or requests a typed conflict decision when an owned path has drifted.
Applying a rewind creates a new revision and stales affected Evidence; it never resets
canonical event history or claims reversal of an external effect.

For direct-mode checkpoints, `runId` and `taskId` remain absent and `directTurnRef`
identifies the Thread/Turn whose first mutating batch the checkpoint protects. That
checkpoint is captured before the first admitted write, so `/rewind turn` targets the
pre-edit state. A `RewindPlanV1` pins an exact requested scope: `turn` uses that
turn's pre-edit checkpoint and has no paths; `files` requires a nonempty list of
canonical, non-glob paths that are a subset of checkpoint-owned paths. Neither scope
includes external effects.
Every existing regular file has retained CAS preimage bytes (including empty files);
every symlink has retained link-target bytes, never dereferenced target content.
Absent entries have `existed=false`, `fileKind=absent` and no preimage; directories
record existence/mode and explicit child entries, never recursive inferred restoration.
The manifest and every preimage are retention-pinned in `artifactPins` before checkpoint
commit. Digest-only or missing/inaccessible preimages cannot authorize restoration.
Restore revalidates root/path identities, current bytes/kind and lease/fence at the
open boundary, rejects traversal/reparse escapes, never follows a restored symlink,
and refuses unsupported link/mode semantics. Rewind selects only requested owned paths
and preserves unrelated bytes; it cannot restore a whole directory implicitly.

## 12.15 Extension runtime snapshots

```ts
type McpConnectionStateV1 =
  | "DISABLED" | "PENDING" | "CONNECTING" | "NEEDS_AUTH"
  | "NEEDS_CLIENT_REGISTRATION" | "CONNECTED" | "DEGRADED" | "FAILED" | "UNKNOWN"
type McpServerSnapshotV1 = {
  serverId: string; state: McpConnectionStateV1; transport: string
  serverConfigDigest: Digest; protocolVersion?: string
  toolsetGeneration?: UInt64Decimal; capabilitiesDigest?: Digest
  observedAt: Timestamp; expiresAt?: Timestamp; error?: TypedErrorV1
}
```

An MCP snapshot is a timestamped connection/health observation from the MCP adapter,
not a separate authority stream. `CONNECTED` means the observed protocol connection is
usable; it does not grant capability, authorize a tool, or prove a later call succeeded.
`PENDING` means enabled but not yet attempted; `CONNECTING` means an attempt is in
progress; `DEGRADED` means transport is connected but a declared protocol/toolset
requirement is unavailable; `FAILED` is the latest terminal attempt. Snapshots bind the
server configuration digest and toolset generation; stale status cannot rebind an
in-flight call. `UNKNOWN` is used when no fresh observation exists. Error details
contain typed, redacted diagnostics only.

## 12.16 Settings wire records and migration

```ts
type SettingApplyBoundaryV1 = "immediate" | "next_provider_turn" | "next_attempt" | "restart"
type SettingScopeV1 = "defaults" | "user" | "project" | "thread" | "invocation"
type SettingSourceV1 = {
  scope: SettingScopeV1; scopeId?: string; sourceRef?: ArtifactRef
  revision: UInt64Decimal; valueRef: ArtifactRef; valueDigest: Digest
}
type SettingDescriptorV1 = {
  schemaVersion: 1; key: string; ownerModuleId: string; valueSchema: JsonSchemaRef
  defaultValueRef: ArtifactRef; allowedScopes: SettingScopeV1[]
  applyBoundary: SettingApplyBoundaryV1
  mergeStrategy: "replace" | "concat"; securitySensitive: boolean
  descriptorDigest: Digest
}
type EffectiveSettingV1 = {
  schemaVersion: 1; key: string; descriptorDigest: Digest
  requested?: SettingSourceV1; effectiveValueRef: ArtifactRef; effectiveValueDigest: Digest
  source: SettingSourceV1; contributors: SettingSourceV1[]; shadowedSources: SettingSourceV1[]
  lockOwner?: { ownerKind: "policy" | "run"; ownerId: string; digest: Digest }
  validation: { status: "VALID" | "INVALID"; error?: TypedErrorV1 }
  capability: CapabilityStatusV1; applyBoundary: SettingApplyBoundaryV1
  configRevision: UInt64Decimal; effectiveDigest: Digest
}
type SettingApplyRequestV1 = {
  schemaVersion: 1; deliveryId: DeliveryId; key: string; descriptorDigest: Digest
  scope: SettingScopeV1; scopeId?: string; expectedConfigRevision: UInt64Decimal
  operation: { kind: "set"; valueRef: ArtifactRef; valueDigest: Digest } | { kind: "unset" }
}
type SettingApplyReceiptV1 = {
  schemaVersion: 1; deliveryId: DeliveryId; key: string; configRevision: UInt64Decimal
  applyBoundary: SettingApplyBoundaryV1; status: "APPLIED" | "PENDING" | "REJECTED"
  effective: EffectiveSettingV1; pendingValueRef?: ArtifactRef
  error?: TypedErrorV1; receiptDigest: Digest
}
type SettingLegacyMigrationV1 = {
  schemaVersion: 1; sourceSnapshotRef: ArtifactRef; sourceSchemaVersion: number
  sourceDigest: Digest; targetConfigRevision: UInt64Decimal
  entries: Array<{
    key: string; sourceScope: "default" | "global" | "project"
    sourceApplyBoundary: "immediate" | "next_turn"
    targetScope: SettingScopeV1; targetApplyBoundary: SettingApplyBoundaryV1
    sourceValueRef: ArtifactRef; targetValueRef?: ArtifactRef; error?: TypedErrorV1
  }>
  migrationDigest: Digest
}
```

The existing `SettingsModule`/configuration owner resolves and persists these records;
this adds no settings engine, precedence layer or permission owner. Scope IDs are
required for project/Thread/invocation and absent for defaults/user. Defaults are
descriptor-owned, not user-writable. The owner authenticates target scopes and checks
descriptor/schema/digests and expected revision; exact delivery returns the original
receipt. `source` identifies the highest contributing effective scope; `concat` retains
all contributors in precedence order and has no replaced/shadowed contributor. Requested
invalid values remain diagnostic only; security-sensitive validation failure blocks the
affected operation, never silently falls back. Policy locks narrow through Guard and
Run locks preserve snapshots; neither is an ordinary preference scope.

An accepted change records the new configuration revision and exact application receipt
through the existing configuration persistence path. `immediate` affects future reads;
`next_provider_turn`, `next_attempt` and `restart` stay PENDING until their declared safe
boundary. No edit changes in-flight pins. Resolution/effectiveDigest covers descriptor,
ordered sources, locks, validated effective value and apply boundary, not raw secrets or
host filesystem paths. Values use bounded schema-validated artifacts; secret settings
contain SecretRefs only.

The inspected legacy `horizoncode-config/src/settings.rs` maps `default → defaults`,
`global → user`, `project → project`, `immediate → immediate`, and
`next_turn → next_provider_turn`. Missing new scopes/boundaries are not inferred from
legacy strings; exact descriptor semantics determine migration and incompatible keys
are rejected diagnostically. Existing source/shadowed contributors and concat/replace
semantics are retained with authorized reference mapping. The migration stores source
snapshot/digest and per-key mapping outcomes, keeps source read-only, and is idempotent
by source/schema/digest; a changed snapshot refuses replay. Required tests cover every
mapping, invalid/security-sensitive values, source provenance, descriptor changes,
Run locks, pending safe boundaries, crash/replay and unknown legacy enums. The legacy
effective digest is provenance, not the new v1 digest; recompute under this contract.
