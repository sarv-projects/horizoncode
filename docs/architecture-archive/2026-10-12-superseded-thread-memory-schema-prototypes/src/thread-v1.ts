/**
 * Browser-safe Horizon Thread V1 contracts. ThreadService owns persistence,
 * admission, lifecycle transitions, migration authorization, authorship/trust checks,
 * and event-log commits; this module only defines serializable record shapes. A valid
 * historical or message record grants no migration authority and does not prove content
 * trust or effect settlement.
 */

import { Schema } from "effect"
import * as Composition from "./composition-v1"
import { NonNegativeInt, optional } from "./schema"

const id = <const Identifier extends string>(identifier: Identifier) =>
  Schema.String.annotate({ identifier }).check(Schema.isNonEmpty()).pipe(Schema.brand(identifier))

export const ThreadId = id("Horizon.ThreadV1.ThreadId")
export type ThreadId = typeof ThreadId.Type

export const ProjectId = id("Horizon.ThreadV1.ProjectId")
export type ProjectId = typeof ProjectId.Type

export const InputId = id("Horizon.ThreadV1.InputId")
export type InputId = typeof InputId.Type

export const DeliveryId = id("Horizon.ThreadV1.DeliveryId")
export type DeliveryId = typeof DeliveryId.Type

export const TurnId = id("Horizon.ThreadV1.TurnId")
export type TurnId = typeof TurnId.Type

export const RunId = id("Horizon.ThreadV1.RunId")
export type RunId = typeof RunId.Type

export const TaskId = id("Horizon.ThreadV1.TaskId")
export type TaskId = typeof TaskId.Type

export const AttemptId = id("Horizon.ThreadV1.AttemptId")
export type AttemptId = typeof AttemptId.Type

export const ContextEpochId = id("Horizon.ThreadV1.ContextEpochId")
export type ContextEpochId = typeof ContextEpochId.Type

export const AgentProfileId = id("Horizon.ThreadV1.AgentProfileId")
export type AgentProfileId = typeof AgentProfileId.Type

export const ProviderRouteSnapshotId = id("Horizon.ThreadV1.ProviderRouteSnapshotId")
export type ProviderRouteSnapshotId = typeof ProviderRouteSnapshotId.Type

export const ModelAttemptId = id("Horizon.ThreadV1.ModelAttemptId")
export type ModelAttemptId = typeof ModelAttemptId.Type

export const ProviderReconciliationId = id("Horizon.ThreadV1.ProviderReconciliationId")
export type ProviderReconciliationId = typeof ProviderReconciliationId.Type

export const UsageObservationId = id("Horizon.ThreadV1.UsageObservationId")
export type UsageObservationId = typeof UsageObservationId.Type

export const EffectId = id("Horizon.ThreadV1.EffectId")
export type EffectId = typeof EffectId.Type

export const ExecutionId = id("Horizon.ThreadV1.ExecutionId")
export type ExecutionId = typeof ExecutionId.Type

export const WorkerExecutionId = id("Horizon.ThreadV1.WorkerExecutionId")
export type WorkerExecutionId = typeof WorkerExecutionId.Type

export const MessageId = id("Horizon.ThreadV1.MessageId")
export type MessageId = typeof MessageId.Type

export const PartId = id("Horizon.ThreadV1.PartId")
export type PartId = typeof PartId.Type

export const ToolId = id("Horizon.ThreadV1.ToolId")
export type ToolId = typeof ToolId.Type

export const ToolCallId = id("Horizon.ThreadV1.ToolCallId")
export type ToolCallId = typeof ToolCallId.Type

export const ToolBatchId = id("Horizon.ThreadV1.ToolBatchId")
export type ToolBatchId = typeof ToolBatchId.Type

export const NeedsYouId = id("Horizon.ThreadV1.NeedsYouId")
export type NeedsYouId = typeof NeedsYouId.Type

export const CompactionId = id("Horizon.ThreadV1.CompactionId")
export type CompactionId = typeof CompactionId.Type

export interface CursorV1 extends Schema.Schema.Type<typeof CursorV1> {}
export const CursorV1 = Schema.Struct({
  ownerKind: Schema.String.check(Schema.isNonEmpty()),
  ownerId: Schema.String.check(Schema.isNonEmpty()),
  seq: Composition.UInt64Decimal,
  eventDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.ThreadV1.CursorV1" })

export interface ProfileRevisionRefV1 extends Schema.Schema.Type<typeof ProfileRevisionRefV1> {}
export const ProfileRevisionRefV1 = Schema.Struct({
  profileId: AgentProfileId,
  revision: NonNegativeInt,
  definitionDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.ThreadV1.ProfileRevisionRefV1" })

export type ModelSelectionV1 = typeof ModelSelectionV1.Type
export const ModelSelectionV1 = Schema.Union(
  [
    Schema.Struct({
      mode: Schema.Literal("fixed"),
      providerId: Schema.String.check(Schema.isNonEmpty()),
      modelId: Schema.String.check(Schema.isNonEmpty()),
    }),
    Schema.Struct({ mode: Schema.Literal("inherit_parent") }),
    Schema.Struct({
      mode: Schema.Literal("peer_managed"),
      peerId: Schema.String.check(Schema.isNonEmpty()),
    }),
  ],
  { mode: "oneOf" },
).annotate({ identifier: "Horizon.ThreadV1.ModelSelectionV1" })

export interface ThreadV1 extends Schema.Schema.Type<typeof ThreadV1> {}
export const ThreadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  projectId: ProjectId,
  parentThreadId: optional(ThreadId),
  relationship: Schema.Literals(["ROOT", "FORK", "WORKER", "REVIEW", "SIDE_QUESTION", "VERIFIER"]),
  attachedRunId: optional(RunId),
  attachedTaskId: optional(TaskId),
  attachedAttemptId: optional(AttemptId),
  title: Schema.String,
  visibility: Schema.Literals(["ACTIVE", "ARCHIVED"]),
  activeContextEpochId: ContextEpochId,
  selectedProfileRevision: ProfileRevisionRefV1,
  selectedModel: optional(ModelSelectionV1),
  createdAt: Composition.Timestamp,
  archivedAt: optional(Composition.Timestamp),
}).annotate({ identifier: "Horizon.ThreadV1.ThreadV1" })

export interface ThreadInputV1 extends Schema.Schema.Type<typeof ThreadInputV1> {}
export const ThreadInputV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  inputId: InputId,
  threadId: ThreadId,
  deliveryId: DeliveryId,
  lane: Schema.Literals(["steer", "queue"]),
  contentRef: Composition.ArtifactRef,
  admittedSeq: Composition.UInt64Decimal,
  admittedAt: Composition.Timestamp,
  state: Schema.Literals(["ADMITTED", "PROMOTED", "CANCELLED"]),
  promotedTurnId: optional(TurnId),
})
  .annotate({ identifier: "Horizon.ThreadV1.ThreadInputV1" })
  .check(
    Schema.makeFilter((input) =>
      (input.state === "PROMOTED") !== (input.promotedTurnId !== undefined)
        ? "promoted thread inputs require a turn ID and other states must omit it"
        : undefined,
    ),
  )

export interface TurnV1 extends Schema.Schema.Type<typeof TurnV1> {}
export const TurnV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  turnId: TurnId,
  threadId: ThreadId,
  inputIds: Schema.Array(InputId),
  profileRevision: ProfileRevisionRefV1,
  contextEpochId: ContextEpochId,
  routeSnapshotId: ProviderRouteSnapshotId,
  toolsetGeneration: Composition.UInt64Decimal,
  toolsetDigest: Composition.Digest,
  state: Schema.Literals([
    "PENDING",
    "PREPARING",
    "PROVIDER_RUNNING",
    "WAITING_TOOLS",
    "WAITING_USER",
    "INTERRUPTING",
    "INTERRUPTED",
    "COMPLETED",
    "FAILED",
    "UNKNOWN",
  ]),
  providerAttemptIds: Schema.Array(ModelAttemptId),
  startedAt: Composition.Timestamp,
  endedAt: optional(Composition.Timestamp),
}).annotate({ identifier: "Horizon.ThreadV1.TurnV1" })

export interface ProviderAttemptV1 extends Schema.Schema.Type<typeof ProviderAttemptV1> {}
export const ProviderAttemptV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  modelAttemptId: ModelAttemptId,
  turnId: TurnId,
  routeSnapshotId: ProviderRouteSnapshotId,
  requestDigest: Composition.Digest,
  outputDigest: optional(Composition.Digest),
  state: Schema.Literals([
    "PREPARING",
    "REQUESTING",
    "STREAMING",
    "COMPLETE",
    "CANCELLED",
    "FAILED_PRE_CONTENT",
    "FAILED_POST_CONTENT",
    "TRUNCATED",
    "UNKNOWN_ACCEPTANCE",
  ]),
  finishCause: optional(Schema.String),
  usageObservationId: optional(UsageObservationId),
  startedAt: optional(Composition.Timestamp),
  endedAt: optional(Composition.Timestamp),
}).annotate({ identifier: "Horizon.ThreadV1.ProviderAttemptV1" })

export interface ProviderAttemptReconciliationV1 extends Schema.Schema.Type<typeof ProviderAttemptReconciliationV1> {}
export const ProviderAttemptReconciliationV1 = Schema.Struct({
  reconciliationId: ProviderReconciliationId,
  modelAttemptId: ModelAttemptId,
  outcome: Schema.Literals(["NOT_ACCEPTED", "ACCEPTED_COMPLETE", "ACCEPTED_CANCELLED", "UNKNOWN"]),
  recoveredResponse: optional(Composition.ArtifactRef),
  evidenceRefs: Schema.Array(Composition.ArtifactRef),
  observedAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.ThreadV1.ProviderAttemptReconciliationV1" })

export interface LegacySessionAliasV1 extends Schema.Schema.Type<typeof LegacySessionAliasV1> {}
export const LegacySessionAliasV1 = Schema.Struct({
  sourceStoreId: Schema.String.check(Schema.isNonEmpty()),
  legacySessionId: Schema.String.check(Schema.isNonEmpty()),
  threadId: ThreadId,
  importedSnapshotDigest: Composition.Digest,
  importedAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.ThreadV1.LegacySessionAliasV1" })

export interface LegacyImportOriginV1 extends Schema.Schema.Type<typeof LegacyImportOriginV1> {}
export const LegacyImportOriginV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceStoreId: Schema.String.check(Schema.isNonEmpty()),
  legacySessionId: Schema.String.check(Schema.isNonEmpty()),
  sourceSnapshot: Composition.ArtifactRef,
  sourceRecordId: Schema.String.check(Schema.isNonEmpty()),
  sourceRecordDigest: Composition.Digest,
  provenance: Schema.Literal("historical_unmediated"),
  importedAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.ThreadV1.LegacyImportOriginV1" })

const isThreadCursorFor = (cursor: CursorV1, threadId: ThreadId) =>
  cursor.ownerKind === "thread" && cursor.ownerId === threadId

const isStrictlyIncreasingUInt64Decimal = (before: Composition.UInt64Decimal, after: Composition.UInt64Decimal) =>
  before.length < after.length || (before.length === after.length && before < after)

export interface LegacyTurnImportV1 extends Schema.Schema.Type<typeof LegacyTurnImportV1> {}
export const LegacyTurnImportV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  origin: LegacyImportOriginV1,
  threadId: ThreadId,
  turnId: TurnId,
  state: Schema.Literal("UNKNOWN"),
  historicalPayloadRef: Composition.ArtifactRef,
  threadImportAdmissionReceipt: CursorV1,
  providerAttemptIds: Schema.Array(ModelAttemptId),
  uncertainEffectIds: Schema.Array(EffectId),
})
  .annotate({ identifier: "Horizon.ThreadV1.LegacyTurnImportV1" })
  .check(
    Schema.makeFilter((record) =>
      isThreadCursorFor(record.threadImportAdmissionReceipt, record.threadId)
        ? undefined
        : "legacy turn import admission receipt must belong to its Thread stream",
    ),
  )

export interface HistoricalTurnRecordV1 extends Schema.Schema.Type<typeof HistoricalTurnRecordV1> {}
export const HistoricalTurnRecordV1 = Schema.Struct({
  kind: Schema.Literal("historical"),
  schemaVersion: Schema.Literal(1),
  origin: LegacyImportOriginV1,
  threadId: ThreadId,
  turnId: TurnId,
  importPayloadRef: Composition.ArtifactRef,
  providerAttemptIds: Schema.Array(ModelAttemptId),
  uncertainEffectIds: Schema.Array(EffectId),
  state: Schema.Literals(["UNKNOWN", "FAILED", "INTERRUPTED", "COMPLETED"]),
  reconciliationReceiptRef: optional(Composition.ArtifactRef),
  reconciliationCursor: optional(CursorV1),
})
  .annotate({ identifier: "Horizon.ThreadV1.HistoricalTurnRecordV1" })
  .check(
    Schema.makeFilter((record) => {
      const hasReceipt = record.reconciliationReceiptRef !== undefined
      const hasCursor = record.reconciliationCursor !== undefined
      const terminal = record.state !== "UNKNOWN"
      if (hasReceipt !== hasCursor || terminal !== hasReceipt) {
        return "historical terminal turns require both reconciliation links and UNKNOWN turns must omit both"
      }
      if (record.reconciliationCursor && !isThreadCursorFor(record.reconciliationCursor, record.threadId)) {
        return "historical turn reconciliation cursor must belong to its Thread stream"
      }
      return undefined
    }),
  )

export type CanonicalTurnRecordV1 = typeof CanonicalTurnRecordV1.Type
export const CanonicalTurnRecordV1 = Schema.Union([TurnV1, HistoricalTurnRecordV1]).annotate({
  identifier: "Horizon.ThreadV1.CanonicalTurnRecordV1",
})

export const LegacyUncertainOperationV1 = Schema.Union(
  [
    Schema.Struct({
      kind: Schema.Literal("provider"),
      modelAttemptId: ModelAttemptId,
      state: Schema.Literal("UNKNOWN_ACCEPTANCE"),
    }),
    Schema.Struct({
      kind: Schema.Literal("effect"),
      effectId: EffectId,
      state: Schema.Literal("UNKNOWN"),
      ownerKind: Schema.Literals([
        "filesystem",
        "process",
        "git",
        "network",
        "mcp",
        "connector",
        "plugin",
        "external-agent",
        "other",
      ]),
    }),
  ],
  { mode: "oneOf" },
).annotate({ identifier: "Horizon.ThreadV1.LegacyUncertainOperationV1" })

export interface LegacyUncertainOperationImportV1 extends Schema.Schema.Type<typeof LegacyUncertainOperationImportV1> {}
export const LegacyUncertainOperationImportV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  origin: LegacyImportOriginV1,
  threadId: ThreadId,
  turnId: TurnId,
  historicalPayloadRef: Composition.ArtifactRef,
  operation: LegacyUncertainOperationV1,
  threadImportReceipt: CursorV1,
  turnImportReceipt: CursorV1,
})
  .annotate({ identifier: "Horizon.ThreadV1.LegacyUncertainOperationImportV1" })
  .check(
    Schema.makeFilter((record) => {
      if (
        !isThreadCursorFor(record.threadImportReceipt, record.threadId) ||
        !isThreadCursorFor(record.turnImportReceipt, record.threadId)
      ) {
        return "legacy uncertain-operation receipts must belong to their Thread stream"
      }
      return isStrictlyIncreasingUInt64Decimal(record.threadImportReceipt.seq, record.turnImportReceipt.seq)
        ? undefined
        : "legacy uncertain-operation Thread import receipt must precede Turn import receipt"
    }),
  )

export interface HistoricalProviderAttemptReconciliationV1
  extends Schema.Schema.Type<typeof HistoricalProviderAttemptReconciliationV1> {}
export const HistoricalProviderAttemptReconciliationV1 = Schema.Struct({
  record: ProviderAttemptReconciliationV1,
  ownerCursor: CursorV1,
  receiptRef: Composition.ArtifactRef,
}).annotate({ identifier: "Horizon.ThreadV1.HistoricalProviderAttemptReconciliationV1" })

export interface HistoricalProviderAttemptRecordV1
  extends Schema.Schema.Type<typeof HistoricalProviderAttemptRecordV1> {}
export const HistoricalProviderAttemptRecordV1 = Schema.Struct({
  kind: Schema.Literal("historical"),
  schemaVersion: Schema.Literal(1),
  modelAttemptId: ModelAttemptId,
  threadId: ThreadId,
  turnId: TurnId,
  origin: LegacyImportOriginV1,
  importPayloadRef: Composition.ArtifactRef,
  state: Schema.Literal("UNKNOWN_ACCEPTANCE"),
  reconciliation: optional(HistoricalProviderAttemptReconciliationV1),
})
  .annotate({ identifier: "Horizon.ThreadV1.HistoricalProviderAttemptRecordV1" })
  .check(
    Schema.makeFilter((record) => {
      if (!record.reconciliation) return undefined
      if (record.reconciliation.record.modelAttemptId !== record.modelAttemptId) {
        return "historical provider reconciliation must identify the immutable imported attempt"
      }
      return isThreadCursorFor(record.reconciliation.ownerCursor, record.threadId)
        ? undefined
        : "historical provider reconciliation cursor must belong to its Thread stream"
    }),
  )

export type CanonicalProviderAttemptRecordV1 = typeof CanonicalProviderAttemptRecordV1.Type
export const CanonicalProviderAttemptRecordV1 = Schema.Union([
  ProviderAttemptV1,
  HistoricalProviderAttemptRecordV1,
]).annotate({ identifier: "Horizon.ThreadV1.CanonicalProviderAttemptRecordV1" })

const TurnOperationReceiptOperationV1 = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal("effect"), effectId: EffectId }),
    Schema.Struct({ kind: Schema.Literal("process"), executionId: ExecutionId }),
    Schema.Struct({ kind: Schema.Literal("direct_delegation"), workerExecutionId: WorkerExecutionId }),
  ],
  { mode: "oneOf" },
)

const TurnOperationReceiptV1 = Schema.Struct({
  operation: TurnOperationReceiptOperationV1,
  ownerCursor: CursorV1,
  receiptRef: Composition.ArtifactRef,
})

export interface TurnOperationsReconciledV1 extends Schema.Schema.Type<typeof TurnOperationsReconciledV1> {}
export const TurnOperationsReconciledV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threadId: ThreadId,
  turnId: TurnId,
  operationReceipts: Schema.Array(TurnOperationReceiptV1),
  providerReconciliationRefs: Schema.Array(Composition.ArtifactRef),
  targetState: Schema.Literals(["PREPARING", "WAITING_TOOLS", "FAILED", "COMPLETED", "INTERRUPTED"]),
}).annotate({ identifier: "Horizon.ThreadV1.TurnOperationsReconciledV1" })

export interface ProviderRefV1 extends Schema.Schema.Type<typeof ProviderRefV1> {}
export const ProviderRefV1 = Schema.Struct({
  providerId: Schema.String,
  modelId: optional(Schema.String),
}).annotate({ identifier: "Horizon.ThreadV1.ProviderRefV1" })

const MessageSourceV1 = Schema.Struct({
  kind: Schema.Literals(["provider", "tool", "migration", "operator"]),
  sourceId: Schema.String,
})

const MessagePartIdV1 = { partId: PartId }

const TextMessagePartV1 = Schema.Struct({
  type: Schema.Literal("text"),
  ...MessagePartIdV1,
  text: Schema.String,
  trust: Schema.Literals(["operator", "model", "untrusted-data"]),
})

const ReasoningMessagePartV1 = Schema.Struct({
  type: Schema.Literal("reasoning"),
  ...MessagePartIdV1,
  textRef: Composition.ArtifactRef,
  provider: ProviderRefV1,
  retention: Schema.Literals(["ephemeral", "retained"]),
})

const ToolCallMessagePartV1 = Schema.Struct({
  type: Schema.Literal("tool-call"),
  ...MessagePartIdV1,
  toolCallId: ToolCallId,
  toolId: ToolId,
  argsRef: Composition.ArtifactRef,
  argsDigest: Composition.Digest,
  batchId: ToolBatchId,
})

const ToolResultMessagePartV1 = Schema.Struct({
  type: Schema.Literal("tool-result"),
  ...MessagePartIdV1,
  toolCallId: ToolCallId,
  status: Schema.Literals(["SUCCEEDED", "FAILED", "DENIED", "UNKNOWN", "CANCELLED"]),
  resultRefs: Schema.Array(Composition.ArtifactRef),
  effectId: optional(EffectId),
  error: optional(Composition.TypedErrorV1),
})

const AttachmentMessagePartV1 = Schema.Struct({
  type: Schema.Literal("attachment"),
  ...MessagePartIdV1,
  artifact: Composition.ArtifactRef,
  filename: optional(Schema.String),
})

const ArtifactReferenceMessagePartV1 = Schema.Struct({
  type: Schema.Literal("artifact-ref"),
  ...MessagePartIdV1,
  artifact: Composition.ArtifactRef,
  label: optional(Schema.String),
})

const CompactionSummaryMessagePartV1 = Schema.Struct({
  type: Schema.Literal("compaction-summary"),
  ...MessagePartIdV1,
  summary: Composition.ArtifactRef,
  sourceRange: Schema.Struct({
    firstEvent: Composition.UInt64Decimal,
    lastEvent: Composition.UInt64Decimal,
  }),
  sourceDigest: Composition.Digest,
  compactionId: CompactionId,
})

const QuestionMessagePartV1 = Schema.Struct({
  type: Schema.Literal("question"),
  ...MessagePartIdV1,
  needsYouId: NeedsYouId,
})

const ErrorMessagePartV1 = Schema.Struct({
  type: Schema.Literal("error"),
  ...MessagePartIdV1,
  error: Composition.TypedErrorV1,
  retryability: Composition.RetryClassV1,
})

const ProviderMetadataMessagePartV1 = Schema.Struct({
  type: Schema.Literal("provider-metadata"),
  ...MessagePartIdV1,
  metadata: Composition.ArtifactRef,
  provider: ProviderRefV1,
})

export type MessagePartV1 = typeof MessagePartV1.Type
export const MessagePartV1 = Schema.Union(
  [
    TextMessagePartV1,
    ReasoningMessagePartV1,
    ToolCallMessagePartV1,
    ToolResultMessagePartV1,
    AttachmentMessagePartV1,
    ArtifactReferenceMessagePartV1,
    CompactionSummaryMessagePartV1,
    QuestionMessagePartV1,
    ErrorMessagePartV1,
    ProviderMetadataMessagePartV1,
  ],
  { mode: "oneOf" },
).annotate({ identifier: "Horizon.ThreadV1.MessagePartV1" })

export interface MessageV1 extends Schema.Schema.Type<typeof MessageV1> {}
export const MessageV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageId: MessageId,
  threadId: ThreadId,
  turnId: optional(TurnId),
  ordinal: Composition.UInt64Decimal,
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  author: Composition.ActorRefV1,
  parts: Schema.Array(MessagePartV1),
  createdAt: Composition.Timestamp,
  visibility: Schema.Literals(["normal", "internal-control", "imported-legacy"]),
  source: optional(MessageSourceV1),
}).annotate({ identifier: "Horizon.ThreadV1.MessageV1" })

export interface InputAdmissionRequestV1 extends Schema.Schema.Type<typeof InputAdmissionRequestV1> {}
export const InputAdmissionRequestV1 = Schema.Struct({
  threadId: ThreadId,
  deliveryId: DeliveryId,
  expectedCursor: optional(CursorV1),
  lane: Schema.Literals(["steer", "queue"]),
  contentRef: Composition.ArtifactRef,
  contentDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.ThreadV1.InputAdmissionRequestV1" })
