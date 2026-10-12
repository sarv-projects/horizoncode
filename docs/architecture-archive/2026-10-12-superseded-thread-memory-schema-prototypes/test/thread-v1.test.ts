import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as Memory from "../src/memory-v1"
import * as Thread from "../src/thread-v1"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

const artifact = {
  artifactId: "artifact.thread-content",
  digest,
  byteLength: "32",
  mediaType: "text/plain",
  classification: "workspace",
} as const

const cursor = {
  ownerKind: "thread",
  ownerId: "thread.one",
  seq: "7",
  eventDigest: digest,
} as const

const profileRevision = {
  profileId: "profile.one",
  revision: 2,
  definitionDigest: digest,
} as const

const origin = {
  schemaVersion: 1,
  sourceStoreId: "legacy.store",
  legacySessionId: "session.old",
  sourceSnapshot: artifact,
  sourceRecordId: "turn.old",
  sourceRecordDigest: digest,
  provenance: "historical_unmediated",
  importedAt: "2026-10-09T12:35:45.123Z",
} as const

const turnImport = {
  schemaVersion: 1,
  origin,
  threadId: "thread.one",
  turnId: "turn.old",
  state: "UNKNOWN",
  historicalPayloadRef: artifact,
  threadImportAdmissionReceipt: cursor,
  providerAttemptIds: ["attempt.old"],
  uncertainEffectIds: ["effect.old"],
} as const

const historicalTurn = {
  kind: "historical",
  schemaVersion: 1,
  origin,
  threadId: "thread.one",
  turnId: "turn.old",
  importPayloadRef: artifact,
  providerAttemptIds: ["attempt.old"],
  uncertainEffectIds: ["effect.old"],
  state: "UNKNOWN",
} as const

const uncertainProviderImport = {
  schemaVersion: 1,
  origin,
  threadId: "thread.one",
  turnId: "turn.old",
  historicalPayloadRef: artifact,
  operation: { kind: "provider", modelAttemptId: "attempt.old", state: "UNKNOWN_ACCEPTANCE" },
  threadImportReceipt: cursor,
  turnImportReceipt: { ...cursor, seq: "8" },
} as const

const historicalAttempt = {
  kind: "historical",
  schemaVersion: 1,
  modelAttemptId: "attempt.old",
  threadId: "thread.one",
  turnId: "turn.old",
  origin,
  importPayloadRef: artifact,
  state: "UNKNOWN_ACCEPTANCE",
  reconciliation: {
    record: {
      reconciliationId: "reconciliation.old",
      modelAttemptId: "attempt.old",
      outcome: "ACCEPTED_COMPLETE",
      recoveredResponse: artifact,
      evidenceRefs: [artifact],
      observedAt: "2026-10-09T12:34:45.123Z",
    },
    ownerCursor: { ...cursor, seq: "9" },
    receiptRef: artifact,
  },
} as const

const typedError = {
  code: "THREAD_TEST",
  category: "unavailable",
  message: "A bounded test error",
  retryClass: "NEVER",
  subjectIds: [],
} as const

const roundTrip = (schema: Schema.Codec<unknown, unknown, never, never>, input: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema)(input)
  expect(Schema.encodeSync(schema)(decoded)).toEqual(input)
}

const fieldType = (schema: Schema.Top, name: string) => {
  const ast = schema.ast
  if (ast._tag !== "Objects") return undefined
  return ast.propertySignatures.find((field) => field.name === name)?.type
}

describe("Horizon Thread v1 contracts", () => {
  test("round trips canonical Thread, input, cursor, and admission request shapes", () => {
    const thread = {
      schemaVersion: 1,
      threadId: "thread.one",
      projectId: "project.one",
      relationship: "ROOT",
      title: "Review current changes",
      visibility: "ACTIVE",
      activeContextEpochId: "epoch.one",
      selectedProfileRevision: profileRevision,
      selectedModel: { mode: "fixed", providerId: "provider.one", modelId: "model.one" },
      createdAt: "2026-10-09T12:30:45.123Z",
    } as const

    const input = {
      schemaVersion: 1,
      inputId: "input.one",
      threadId: "thread.one",
      deliveryId: "delivery.one",
      lane: "queue",
      contentRef: artifact,
      admittedSeq: "8",
      admittedAt: "2026-10-09T12:31:45.123Z",
      state: "PROMOTED",
      promotedTurnId: "turn.one",
    } as const

    const admission = {
      threadId: "thread.one",
      deliveryId: "delivery.two",
      expectedCursor: cursor,
      lane: "steer",
      contentRef: artifact,
      contentDigest: digest,
    } as const

    const turn = {
      schemaVersion: 1,
      turnId: "turn.one",
      threadId: "thread.one",
      inputIds: ["input.one"],
      profileRevision,
      contextEpochId: "epoch.one",
      routeSnapshotId: "route.one",
      toolsetGeneration: "2",
      toolsetDigest: digest,
      state: "PROVIDER_RUNNING",
      providerAttemptIds: ["attempt.one"],
      startedAt: "2026-10-09T12:32:45.123Z",
    } as const

    const providerAttempt = {
      schemaVersion: 1,
      modelAttemptId: "attempt.one",
      turnId: "turn.one",
      routeSnapshotId: "route.one",
      requestDigest: digest,
      state: "COMPLETE",
      outputDigest: digest,
      finishCause: "stop",
      usageObservationId: "usage.one",
      startedAt: "2026-10-09T12:32:45.123Z",
      endedAt: "2026-10-09T12:33:45.123Z",
    } as const

    const reconciliation = {
      reconciliationId: "reconciliation.one",
      modelAttemptId: "attempt.one",
      outcome: "ACCEPTED_COMPLETE",
      recoveredResponse: artifact,
      evidenceRefs: [artifact],
      observedAt: "2026-10-09T12:34:45.123Z",
    } as const

    const alias = {
      sourceStoreId: "legacy.store",
      legacySessionId: "session.old",
      threadId: "thread.one",
      importedSnapshotDigest: digest,
      importedAt: "2026-10-09T12:35:45.123Z",
    } as const

    const uncertainEffectImport = {
      ...uncertainProviderImport,
      operation: { kind: "effect", effectId: "effect.old", state: "UNKNOWN", ownerKind: "process" },
    } as const

    const operationsReconciled = {
      schemaVersion: 1,
      threadId: "thread.one",
      turnId: "turn.old",
      operationReceipts: [
        { operation: { kind: "effect", effectId: "effect.old" }, ownerCursor: cursor, receiptRef: artifact },
        {
          operation: { kind: "process", executionId: "execution.one" },
          ownerCursor: cursor,
          receiptRef: artifact,
        },
        {
          operation: { kind: "direct_delegation", workerExecutionId: "worker-execution.one" },
          ownerCursor: cursor,
          receiptRef: artifact,
        },
      ],
      providerReconciliationRefs: [artifact],
      targetState: "INTERRUPTED",
    } as const

    const messageParts = [
      { type: "text", partId: "part.text", text: "Hello", trust: "operator" },
      {
        type: "reasoning",
        partId: "part.reasoning",
        textRef: artifact,
        provider: { providerId: "provider.one", modelId: "model.one" },
        retention: "retained",
      },
      {
        type: "tool-call",
        partId: "part.tool-call",
        toolCallId: "tool-call.one",
        toolId: "tool.one",
        argsRef: artifact,
        argsDigest: digest,
        batchId: "batch.one",
      },
      {
        type: "tool-result",
        partId: "part.tool-result",
        toolCallId: "tool-call.one",
        status: "UNKNOWN",
        resultRefs: [artifact],
        error: typedError,
      },
      { type: "attachment", partId: "part.attachment", artifact, filename: "notes.txt" },
      { type: "artifact-ref", partId: "part.artifact-ref", artifact, label: "source" },
      {
        type: "compaction-summary",
        partId: "part.compaction",
        summary: artifact,
        sourceRange: { firstEvent: "1", lastEvent: "7" },
        sourceDigest: digest,
        compactionId: "compaction.one",
      },
      { type: "question", partId: "part.question", needsYouId: "needs-you.one" },
      { type: "error", partId: "part.error", error: typedError, retryability: "NEVER" },
      {
        type: "provider-metadata",
        partId: "part.metadata",
        metadata: artifact,
        provider: { providerId: "provider.one" },
      },
    ] as const

    const message = {
      schemaVersion: 1,
      messageId: "message.one",
      threadId: "thread.one",
      turnId: "turn.one",
      ordinal: "10",
      role: "assistant",
      author: { kind: "provider", id: "provider.one" },
      parts: messageParts,
      createdAt: "2026-10-09T12:36:45.123Z",
      visibility: "normal",
      source: { kind: "provider", sourceId: "provider-response.one" },
    } as const

    roundTrip(Thread.CursorV1, cursor)
    roundTrip(Thread.ProfileRevisionRefV1, profileRevision)
    roundTrip(Thread.ModelSelectionV1, thread.selectedModel)
    roundTrip(Thread.ThreadV1, thread)
    roundTrip(Thread.ThreadInputV1, input)
    roundTrip(Thread.InputAdmissionRequestV1, admission)
    roundTrip(Thread.TurnV1, turn)
    roundTrip(Thread.CanonicalTurnRecordV1, turn)
    roundTrip(Thread.ProviderAttemptV1, providerAttempt)
    roundTrip(Thread.CanonicalProviderAttemptRecordV1, providerAttempt)
    roundTrip(Thread.ProviderAttemptReconciliationV1, reconciliation)
    roundTrip(Thread.LegacySessionAliasV1, alias)
    roundTrip(Thread.LegacyImportOriginV1, origin)
    roundTrip(Thread.LegacyTurnImportV1, turnImport)
    roundTrip(Thread.HistoricalTurnRecordV1, historicalTurn)
    roundTrip(Thread.CanonicalTurnRecordV1, historicalTurn)
    roundTrip(Thread.LegacyUncertainOperationImportV1, uncertainProviderImport)
    roundTrip(Thread.LegacyUncertainOperationImportV1, uncertainEffectImport)
    roundTrip(Thread.HistoricalProviderAttemptRecordV1, historicalAttempt)
    roundTrip(Thread.CanonicalProviderAttemptRecordV1, historicalAttempt)
    roundTrip(Thread.TurnOperationsReconciledV1, operationsReconciled)
    messageParts.forEach((part) => roundTrip(Thread.MessagePartV1, part))
    roundTrip(Thread.MessageV1, message)

    expect(Schema.decodeUnknownSync(Thread.ModelSelectionV1)({ mode: "inherit_parent" })).toEqual({
      mode: "inherit_parent",
    })
    expect(Schema.decodeUnknownSync(Thread.ModelSelectionV1)({ mode: "peer_managed", peerId: "peer.one" })).toEqual({
      mode: "peer_managed",
      peerId: "peer.one",
    })
  })

  test("omits undefined optional fields when encoding", () => {
    const decodedThread = Schema.decodeUnknownSync(Thread.ThreadV1)({
      schemaVersion: 1,
      threadId: "thread.one",
      projectId: "project.one",
      relationship: "ROOT",
      title: "Thread",
      visibility: "ACTIVE",
      activeContextEpochId: "epoch.one",
      selectedProfileRevision: profileRevision,
      createdAt: "2026-10-09T12:30:45.123Z",
    })
    const encodedThread = Schema.encodeUnknownSync(Thread.ThreadV1)({
      ...decodedThread,
      parentThreadId: undefined,
      selectedModel: undefined,
      archivedAt: undefined,
    })
    expect(encodedThread).not.toHaveProperty("parentThreadId")
    expect(encodedThread).not.toHaveProperty("selectedModel")
    expect(encodedThread).not.toHaveProperty("archivedAt")

    const decodedAdmission = Schema.decodeUnknownSync(Thread.InputAdmissionRequestV1)({
      threadId: "thread.one",
      deliveryId: "delivery.one",
      lane: "queue",
      contentRef: artifact,
      contentDigest: digest,
    })
    const encodedAdmission = Schema.encodeUnknownSync(Thread.InputAdmissionRequestV1)({
      ...decodedAdmission,
      expectedCursor: undefined,
    })
    expect(encodedAdmission).not.toHaveProperty("expectedCursor")

    const decodedAttempt = Schema.decodeUnknownSync(Thread.ProviderAttemptV1)({
      schemaVersion: 1,
      modelAttemptId: "attempt.one",
      turnId: "turn.one",
      routeSnapshotId: "route.one",
      requestDigest: digest,
      state: "REQUESTING",
    })
    const encodedAttempt = Schema.encodeUnknownSync(Thread.ProviderAttemptV1)({
      ...decodedAttempt,
      outputDigest: undefined,
      finishCause: undefined,
      usageObservationId: undefined,
      startedAt: undefined,
      endedAt: undefined,
    })
    expect(encodedAttempt).not.toHaveProperty("outputDigest")
    expect(encodedAttempt).not.toHaveProperty("finishCause")
    expect(encodedAttempt).not.toHaveProperty("usageObservationId")
    expect(encodedAttempt).not.toHaveProperty("startedAt")
    expect(encodedAttempt).not.toHaveProperty("endedAt")

    const decodedMessage = Schema.decodeUnknownSync(Thread.MessageV1)({
      schemaVersion: 1,
      messageId: "message.one",
      threadId: "thread.one",
      ordinal: "10",
      role: "assistant",
      author: { kind: "host", id: "host.one" },
      parts: [],
      createdAt: "2026-10-09T12:36:45.123Z",
      visibility: "normal",
    })
    const encodedMessage = Schema.encodeUnknownSync(Thread.MessageV1)({
      ...decodedMessage,
      turnId: undefined,
      source: undefined,
    })
    expect(encodedMessage).not.toHaveProperty("turnId")
    expect(encodedMessage).not.toHaveProperty("source")

    const decodedAttachment = Schema.decodeUnknownSync(Thread.MessagePartV1)({
      type: "attachment",
      partId: "part.attachment",
      artifact,
    })
    const encodedAttachment = Schema.encodeUnknownSync(Thread.MessagePartV1)({
      ...decodedAttachment,
      filename: undefined,
    })
    expect(encodedAttachment).not.toHaveProperty("filename")

    const decodedHistoricalAttempt = Schema.decodeUnknownSync(Thread.HistoricalProviderAttemptRecordV1)({
      kind: "historical",
      schemaVersion: 1,
      modelAttemptId: "attempt.old",
      threadId: "thread.one",
      turnId: "turn.old",
      origin,
      importPayloadRef: artifact,
      state: "UNKNOWN_ACCEPTANCE",
    })
    const encodedHistoricalAttempt = Schema.encodeUnknownSync(Thread.HistoricalProviderAttemptRecordV1)({
      ...decodedHistoricalAttempt,
      reconciliation: undefined,
    })
    expect(encodedHistoricalAttempt).not.toHaveProperty("reconciliation")
  })

  test("orders legacy uncertain-operation import receipts with exact UInt64Decimal comparison", () => {
    roundTrip(Thread.LegacyUncertainOperationImportV1, {
      ...uncertainProviderImport,
      threadImportReceipt: { ...cursor, seq: "9007199254740992" },
      turnImportReceipt: { ...cursor, seq: "9007199254740993" },
    })

    expect(() =>
      Schema.decodeUnknownSync(Thread.LegacyUncertainOperationImportV1)({
        ...uncertainProviderImport,
        threadImportReceipt: { ...cursor, seq: "9007199254740993" },
        turnImportReceipt: { ...cursor, seq: "9007199254740993" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.LegacyUncertainOperationImportV1)({
        ...uncertainProviderImport,
        threadImportReceipt: { ...cursor, seq: "9007199254740993" },
        turnImportReceipt: { ...cursor, seq: "9007199254740992" },
      }),
    ).toThrow()
  })

  test("binds historical provider reconciliation cursors to the enclosing Thread stream", () => {
    roundTrip(Thread.HistoricalProviderAttemptRecordV1, historicalAttempt)

    expect(() =>
      Schema.decodeUnknownSync(Thread.HistoricalProviderAttemptRecordV1)({
        ...historicalAttempt,
        reconciliation: {
          ...historicalAttempt.reconciliation,
          ownerCursor: { ...historicalAttempt.reconciliation.ownerCursor, ownerKind: "provider_attempt" },
        },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.HistoricalProviderAttemptRecordV1)({
        ...historicalAttempt,
        reconciliation: {
          ...historicalAttempt.reconciliation,
          ownerCursor: { ...historicalAttempt.reconciliation.ownerCursor, ownerId: "thread.other" },
        },
      }),
    ).toThrow()
  })

  test("enforces state links, numeric IDs, and the canonical shared Cursor/ThreadId schemas", () => {
    const schemas = [
      Thread.ThreadId,
      Thread.ProjectId,
      Thread.InputId,
      Thread.DeliveryId,
      Thread.TurnId,
      Thread.RunId,
      Thread.TaskId,
      Thread.AttemptId,
      Thread.ContextEpochId,
      Thread.AgentProfileId,
      Thread.ProviderRouteSnapshotId,
      Thread.ModelAttemptId,
      Thread.ProviderReconciliationId,
      Thread.UsageObservationId,
      Thread.EffectId,
      Thread.ExecutionId,
      Thread.WorkerExecutionId,
      Thread.MessageId,
      Thread.PartId,
      Thread.ToolId,
      Thread.ToolCallId,
      Thread.ToolBatchId,
      Thread.NeedsYouId,
      Thread.CompactionId,
      Thread.CursorV1,
      Thread.ProfileRevisionRefV1,
      Thread.ModelSelectionV1,
      Thread.ThreadV1,
      Thread.ThreadInputV1,
      Thread.TurnV1,
      Thread.ProviderAttemptV1,
      Thread.ProviderAttemptReconciliationV1,
      Thread.LegacySessionAliasV1,
      Thread.LegacyImportOriginV1,
      Thread.LegacyTurnImportV1,
      Thread.HistoricalTurnRecordV1,
      Thread.CanonicalTurnRecordV1,
      Thread.LegacyUncertainOperationV1,
      Thread.LegacyUncertainOperationImportV1,
      Thread.HistoricalProviderAttemptReconciliationV1,
      Thread.HistoricalProviderAttemptRecordV1,
      Thread.CanonicalProviderAttemptRecordV1,
      Thread.TurnOperationsReconciledV1,
      Thread.ProviderRefV1,
      Thread.MessagePartV1,
      Thread.MessageV1,
      Thread.InputAdmissionRequestV1,
    ]
    const identifiers = schemas.map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers).toEqual([
      "Horizon.ThreadV1.ThreadId",
      "Horizon.ThreadV1.ProjectId",
      "Horizon.ThreadV1.InputId",
      "Horizon.ThreadV1.DeliveryId",
      "Horizon.ThreadV1.TurnId",
      "Horizon.ThreadV1.RunId",
      "Horizon.ThreadV1.TaskId",
      "Horizon.ThreadV1.AttemptId",
      "Horizon.ThreadV1.ContextEpochId",
      "Horizon.ThreadV1.AgentProfileId",
      "Horizon.ThreadV1.ProviderRouteSnapshotId",
      "Horizon.ThreadV1.ModelAttemptId",
      "Horizon.ThreadV1.ProviderReconciliationId",
      "Horizon.ThreadV1.UsageObservationId",
      "Horizon.ThreadV1.EffectId",
      "Horizon.ThreadV1.ExecutionId",
      "Horizon.ThreadV1.WorkerExecutionId",
      "Horizon.ThreadV1.MessageId",
      "Horizon.ThreadV1.PartId",
      "Horizon.ThreadV1.ToolId",
      "Horizon.ThreadV1.ToolCallId",
      "Horizon.ThreadV1.ToolBatchId",
      "Horizon.ThreadV1.NeedsYouId",
      "Horizon.ThreadV1.CompactionId",
      "Horizon.ThreadV1.CursorV1",
      "Horizon.ThreadV1.ProfileRevisionRefV1",
      "Horizon.ThreadV1.ModelSelectionV1",
      "Horizon.ThreadV1.ThreadV1",
      "Horizon.ThreadV1.ThreadInputV1",
      "Horizon.ThreadV1.TurnV1",
      "Horizon.ThreadV1.ProviderAttemptV1",
      "Horizon.ThreadV1.ProviderAttemptReconciliationV1",
      "Horizon.ThreadV1.LegacySessionAliasV1",
      "Horizon.ThreadV1.LegacyImportOriginV1",
      "Horizon.ThreadV1.LegacyTurnImportV1",
      "Horizon.ThreadV1.HistoricalTurnRecordV1",
      "Horizon.ThreadV1.CanonicalTurnRecordV1",
      "Horizon.ThreadV1.LegacyUncertainOperationV1",
      "Horizon.ThreadV1.LegacyUncertainOperationImportV1",
      "Horizon.ThreadV1.HistoricalProviderAttemptReconciliationV1",
      "Horizon.ThreadV1.HistoricalProviderAttemptRecordV1",
      "Horizon.ThreadV1.CanonicalProviderAttemptRecordV1",
      "Horizon.ThreadV1.TurnOperationsReconciledV1",
      "Horizon.ThreadV1.ProviderRefV1",
      "Horizon.ThreadV1.MessagePartV1",
      "Horizon.ThreadV1.MessageV1",
      "Horizon.ThreadV1.InputAdmissionRequestV1",
    ])
    expect(new Set(identifiers).size).toBe(identifiers.length)
    expect(fieldType(Memory.ThreadRangeRefV1, "threadId")).toBe(Thread.ThreadId.ast)
    expect(fieldType(Memory.MemoryExtractionV1, "sourceCursor")).toBe(Thread.CursorV1.ast)
    expect(fieldType(Composition.TypedErrorV1, "retryClass")).toBe(Composition.RetryClassV1.ast)
    expect(fieldType(Thread.MessageV1, "author")).toBe(Composition.ActorRefV1.ast)

    expect(String(Schema.decodeUnknownSync(Thread.ThreadId)("opaque thread / ID"))).toBe("opaque thread / ID")
    expect(() => Schema.decodeUnknownSync(Thread.ThreadId)("")).toThrow()
    expect(() => Schema.decodeUnknownSync(Thread.ProfileRevisionRefV1)({ ...profileRevision, revision: -1 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.ThreadV1)({
        schemaVersion: 2,
        threadId: "thread.one",
        projectId: "project.one",
        relationship: "ROOT",
        title: "Thread",
        visibility: "ARCHIVED",
        activeContextEpochId: "epoch.one",
        selectedProfileRevision: profileRevision,
        createdAt: "2026-10-09T12:30:45.123Z",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.ThreadInputV1)({
        schemaVersion: 1,
        inputId: "input.one",
        threadId: "thread.one",
        deliveryId: "delivery.one",
        lane: "queue",
        contentRef: artifact,
        admittedSeq: "8",
        admittedAt: "2026-10-09T12:31:45.123Z",
        state: "PROMOTED",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.ThreadInputV1)({
        schemaVersion: 1,
        inputId: "input.one",
        threadId: "thread.one",
        deliveryId: "delivery.one",
        lane: "queue",
        contentRef: artifact,
        admittedSeq: "8",
        admittedAt: "2026-10-09T12:31:45.123Z",
        state: "CANCELLED",
        promotedTurnId: "turn.one",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.TurnV1)({
        schemaVersion: 1,
        turnId: "turn.one",
        threadId: "thread.one",
        inputIds: [],
        profileRevision,
        contextEpochId: "epoch.one",
        routeSnapshotId: "route.one",
        toolsetGeneration: "2",
        toolsetDigest: digest,
        state: "DONE",
        providerAttemptIds: [],
        startedAt: "2026-10-09T12:32:45.123Z",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.ProviderAttemptReconciliationV1)({
        reconciliationId: "reconciliation.one",
        modelAttemptId: "attempt.one",
        outcome: "SUCCESS",
        evidenceRefs: [],
        observedAt: "2026-10-09T12:34:45.123Z",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.LegacyTurnImportV1)({
        ...turnImport,
        threadImportAdmissionReceipt: { ...cursor, ownerId: "thread.other" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.HistoricalTurnRecordV1)({
        ...historicalTurn,
        state: "COMPLETED",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.HistoricalTurnRecordV1)({
        ...historicalTurn,
        state: "FAILED",
        reconciliationReceiptRef: artifact,
        reconciliationCursor: { ...cursor, ownerId: "thread.other" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.LegacyUncertainOperationImportV1)({
        ...uncertainProviderImport,
        turnImportReceipt: { ...cursor, ownerKind: "effect" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.HistoricalProviderAttemptRecordV1)({
        ...historicalAttempt,
        reconciliation: {
          ...historicalAttempt.reconciliation,
          record: { ...historicalAttempt.reconciliation.record, modelAttemptId: "attempt.other" },
        },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.MessagePartV1)({
        type: "tool-result",
        partId: "part.invalid",
        toolCallId: "tool-call.one",
        status: "SUCCESS",
        resultRefs: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Thread.MessageV1)({
        schemaVersion: 1,
        messageId: "message.one",
        threadId: "thread.one",
        ordinal: "10",
        role: "unknown",
        author: { kind: "provider", id: "provider.one" },
        parts: [],
        createdAt: "2026-10-09T12:36:45.123Z",
        visibility: "normal",
      }),
    ).toThrow()
  })
})
