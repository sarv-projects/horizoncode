/**
 * Browser-safe Horizon memory v1 contracts. This is a direct specialized entrypoint;
 * MemoryService ownership, authorization, retrieval and consolidation behavior stay out
 * of Schema.
 *
 * Shared primitive schemas are the exact canonical values from composition-v1. Their
 * identifiers currently use Horizon.PluginManifestV1.* because that is the existing
 * specialized definition; reusing those values avoids competing schema identities.
 */

import { Schema } from "effect"
import * as Composition from "./composition-v1"
import * as Thread from "./thread-v1"
import { NonNegativeInt, optional } from "./schema"

const id = <const Identifier extends string>(identifier: Identifier) =>
  Schema.String.annotate({ identifier }).check(Schema.isNonEmpty()).pipe(Schema.brand(identifier))

export const MemoryId = id("Horizon.MemoryV1.MemoryId")
export type MemoryId = typeof MemoryId.Type

export const MemoryCandidateId = id("Horizon.MemoryV1.MemoryCandidateId")
export type MemoryCandidateId = typeof MemoryCandidateId.Type

export const MemoryQueryId = id("Horizon.MemoryV1.MemoryQueryId")
export type MemoryQueryId = typeof MemoryQueryId.Type

export const MemoryExtractionId = id("Horizon.MemoryV1.MemoryExtractionId")
export type MemoryExtractionId = typeof MemoryExtractionId.Type

export const MemoryConsolidationId = id("Horizon.MemoryV1.MemoryConsolidationId")
export type MemoryConsolidationId = typeof MemoryConsolidationId.Type

const utf8Encoder = new TextEncoder()

const compareUtf8Bytes = (left: string, right: string) => {
  const leftBytes = utf8Encoder.encode(left)
  const rightBytes = utf8Encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index] - rightBytes[index]
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

const isStrictlyAscendingUtf8Bytes = (values: ReadonlyArray<string>) =>
  values.every((value, index) => index === 0 || compareUtf8Bytes(values[index - 1], value) < 0)

export interface MemoryScopeV1 extends Schema.Schema.Type<typeof MemoryScopeV1> {}
export const MemoryScopeV1 = Schema.Struct({
  kind: Schema.Literals(["user", "project", "profile", "thread", "run"]),
  id: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "Horizon.MemoryV1.MemoryScopeV1" })

export interface MemoryGenerationRefV1 extends Schema.Schema.Type<typeof MemoryGenerationRefV1> {}
export const MemoryGenerationRefV1 = Schema.Struct({
  scopeId: Schema.String.check(Schema.isNonEmpty()),
  generation: Composition.UInt64Decimal,
  headDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.MemoryV1.MemoryGenerationRefV1" })

export interface ThreadRangeRefV1 extends Schema.Schema.Type<typeof ThreadRangeRefV1> {}
export const ThreadRangeRefV1 = Schema.Struct({
  threadId: Thread.ThreadId,
  firstEvent: Composition.UInt64Decimal,
  lastEvent: Composition.UInt64Decimal,
  digest: Composition.Digest,
})
  .annotate({ identifier: "Horizon.MemoryV1.ThreadRangeRefV1" })
  .check(
    Schema.makeFilter((range) =>
      BigInt(range.firstEvent) <= BigInt(range.lastEvent) ? undefined : "thread range must be in ascending event order",
    ),
  )

export interface MemoryRecordV1 extends Schema.Schema.Type<typeof MemoryRecordV1> {}
export const MemoryRecordV1 = Schema.Struct({
  memoryId: MemoryId,
  scope: MemoryScopeV1,
  content: Composition.ArtifactRef,
  origin: Schema.Literals(["user_explicit", "operator_approved", "derived_observation"]),
  sourceRefs: Schema.Array(Composition.ArtifactRef),
  confidence: Schema.Literals(["high", "medium", "low"]),
  generation: NonNegativeInt,
  acceptedCandidateId: optional(MemoryCandidateId),
  createdAt: Composition.Timestamp,
  expiresAt: optional(Composition.Timestamp),
  supersedesMemoryIds: optional(Schema.Array(MemoryId)),
  tombstonedAt: optional(Composition.Timestamp),
  status: Schema.Literals(["ACTIVE", "SUPERSEDED", "TOMBSTONED"]),
})
  .annotate({ identifier: "Horizon.MemoryV1.MemoryRecordV1" })
  .check(
    Schema.makeFilter((record) => {
      if ((record.status === "TOMBSTONED") !== (record.tombstonedAt !== undefined)) {
        return "tombstoned memory records require a tombstone timestamp and other states must omit it"
      }
      if (record.origin === "operator_approved" && record.acceptedCandidateId === undefined) {
        return "operator-approved memory records require their accepted candidate ID"
      }
      if (record.supersedesMemoryIds !== undefined && !isStrictlyAscendingUtf8Bytes(record.supersedesMemoryIds)) {
        return "accepted superseded memory IDs must be strictly ascending by UTF-8 bytes"
      }
      return undefined
    }),
  )

export interface MemoryExtractionPolicyV1 extends Schema.Schema.Type<typeof MemoryExtractionPolicyV1> {}
export const MemoryExtractionPolicyV1 = Schema.Struct({
  policyDigest: Composition.Digest,
  enabled: Schema.Boolean,
  permittedTargetScopes: Schema.Array(MemoryScopeV1),
  maxCandidatesPerRange: NonNegativeInt,
  retentionClass: Schema.String,
  requireUserReview: Schema.Literal(true),
}).annotate({ identifier: "Horizon.MemoryV1.MemoryExtractionPolicyV1" })

export interface MemoryIndexEntryV1 extends Schema.Schema.Type<typeof MemoryIndexEntryV1> {}
export const MemoryIndexEntryV1 = Schema.Struct({
  memoryId: MemoryId,
  scope: MemoryScopeV1,
  title: Schema.String,
  retrievalHint: Schema.String,
  contentDigest: Composition.Digest,
  recordGeneration: NonNegativeInt,
  indexGeneration: Composition.UInt64Decimal,
  freshness: Schema.Literals(["CURRENT", "STALE", "EXPIRED"]),
}).annotate({ identifier: "Horizon.MemoryV1.MemoryIndexEntryV1" })

export interface MemoryQueryV1 extends Schema.Schema.Type<typeof MemoryQueryV1> {}
export const MemoryQueryV1 = Schema.Struct({
  queryId: MemoryQueryId,
  permittedScopes: Schema.Array(MemoryScopeV1),
  query: Composition.ArtifactRef,
  memoryGenerationRefs: Schema.Array(MemoryGenerationRefV1),
  principalScopeDigest: Composition.Digest,
  maxResults: NonNegativeInt,
  maxContentBytes: Composition.UInt64Decimal,
  maxTokenEstimate: NonNegativeInt,
  includeTranscriptFallback: Schema.Boolean,
})
  .annotate({ identifier: "Horizon.MemoryV1.MemoryQueryV1" })
  .check(
    Schema.makeFilter((query) => {
      // MemoryGenerationRefV1 carries only a scope ID; this is a consistency check, not authorization.
      const permittedScopeIds = new Set(query.permittedScopes.map((scope) => scope.id))
      return query.memoryGenerationRefs.every((reference) => permittedScopeIds.has(reference.scopeId))
        ? undefined
        : "memory generation references must belong to a permitted scope ID"
    }),
  )

export interface MemoryQueryResultV1 extends Schema.Schema.Type<typeof MemoryQueryResultV1> {}
export const MemoryQueryResultV1 = Schema.Struct({
  queryId: MemoryQueryId,
  status: Schema.Literals(["CURRENT", "PARTIAL", "STALE", "UNAVAILABLE"]),
  matches: Schema.Array(
    Schema.Struct({
      memoryId: MemoryId,
      contentRef: Composition.ArtifactRef,
      freshness: Schema.Literals(["CURRENT", "STALE", "EXPIRED"]),
      rank: NonNegativeInt,
      provenance: Schema.Array(Composition.ArtifactRef),
    }),
  ),
  fallbackThreadRanges: optional(Schema.Array(ThreadRangeRefV1)),
  nextCursor: optional(Schema.String),
}).annotate({ identifier: "Horizon.MemoryV1.MemoryQueryResultV1" })

export interface MemoryCandidateV1 extends Schema.Schema.Type<typeof MemoryCandidateV1> {}
export const MemoryCandidateV1 = Schema.Struct({
  candidateId: MemoryCandidateId,
  proposedScope: MemoryScopeV1,
  content: Composition.ArtifactRef,
  sourceRefs: Schema.Array(Composition.ArtifactRef),
  sourceRange: optional(ThreadRangeRefV1),
  confidence: Schema.Literals(["high", "medium", "low"]),
  proposedSupersedes: Schema.Array(MemoryId),
  sourceGenerationRefs: Schema.Array(MemoryGenerationRefV1),
  supersessionSources: Schema.Array(
    Schema.Struct({
      memoryId: MemoryId,
      generation: NonNegativeInt,
      contentDigest: Composition.Digest,
    }),
  ),
  policyDigest: Composition.Digest,
  state: Schema.Literals(["PROPOSED", "ACCEPTED", "REJECTED", "EXPIRED"]),
  acceptedMemoryId: optional(MemoryId),
  reviewReceipt: optional(Composition.ArtifactRef),
  candidateDigest: Composition.Digest,
  createdAt: Composition.Timestamp,
})
  .annotate({ identifier: "Horizon.MemoryV1.MemoryCandidateV1" })
  .check(
    Schema.makeFilter((candidate) =>
      candidate.state === "ACCEPTED" &&
      (candidate.acceptedMemoryId === undefined || candidate.reviewReceipt === undefined)
        ? "accepted memory candidates require a linked memory record and review receipt"
        : undefined,
    ),
  )

export interface MemoryExtractionV1 extends Schema.Schema.Type<typeof MemoryExtractionV1> {}
export const MemoryExtractionV1 = Schema.Struct({
  extractionId: MemoryExtractionId,
  threadId: Thread.ThreadId,
  sourceCursor: Thread.CursorV1,
  sourceRange: ThreadRangeRefV1,
  extractorDigest: Composition.Digest,
  policyDigest: Composition.Digest,
  candidateIds: Schema.Array(MemoryCandidateId),
  state: Schema.Literals(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  failure: optional(Composition.TypedErrorV1),
  createdAt: Composition.Timestamp,
  updatedAt: Composition.Timestamp,
})
  .annotate({ identifier: "Horizon.MemoryV1.MemoryExtractionV1" })
  .check(
    Schema.makeFilter((extraction) => {
      if (extraction.state === "FAILED" && extraction.failure === undefined) {
        return "failed memory extractions require a typed failure"
      }
      if (extraction.sourceRange.threadId !== extraction.threadId) {
        return "memory extraction source range must belong to its thread"
      }
      if (extraction.sourceCursor.ownerKind !== "thread" || extraction.sourceCursor.ownerId !== extraction.threadId) {
        return "memory extraction source cursor must identify its thread owner"
      }
      return undefined
    }),
  )

export interface MemoryConsolidationV1 extends Schema.Schema.Type<typeof MemoryConsolidationV1> {}
export const MemoryConsolidationV1 = Schema.Struct({
  consolidationId: MemoryConsolidationId,
  scope: MemoryScopeV1,
  sourceGeneration: MemoryGenerationRefV1,
  inputMemoryIds: Schema.Array(MemoryId),
  strategyDigest: Composition.Digest,
  state: Schema.Literals([
    "QUEUED",
    "ORIENTING",
    "GATHERING",
    "CONSOLIDATING",
    "PRUNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]),
  candidateIds: Schema.Array(MemoryCandidateId),
  failure: optional(Composition.TypedErrorV1),
  createdAt: Composition.Timestamp,
  updatedAt: Composition.Timestamp,
})
  .annotate({ identifier: "Horizon.MemoryV1.MemoryConsolidationV1" })
  .check(
    Schema.makeFilter((consolidation) => {
      if (consolidation.state === "FAILED" && consolidation.failure === undefined) {
        return "failed memory consolidations require a typed failure"
      }
      if (consolidation.sourceGeneration.scopeId !== consolidation.scope.id) {
        return "memory consolidation source generation must match its scope"
      }
      return undefined
    }),
  )
