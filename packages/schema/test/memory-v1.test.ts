import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as Memory from "../src/memory-v1"
import * as Thread from "../src/thread-v1"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

const artifact = Schema.decodeUnknownSync(Composition.ArtifactRef)({
  artifactId: "artifact.memory-content",
  digest,
  byteLength: "128",
  mediaType: "application/json",
  classification: "workspace",
})

const scope = {
  kind: "project",
  id: "project.sample",
} as const

const record = {
  memoryId: "memory.1",
  scope,
  content: artifact,
  origin: "operator_approved",
  sourceRefs: [artifact],
  confidence: "medium",
  generation: 2,
  acceptedCandidateId: "memory-candidate.1",
  createdAt: "2026-10-09T12:30:45.123Z",
  status: "ACTIVE",
} as const

const range = {
  threadId: "thread.sample",
  firstEvent: "0",
  lastEvent: "17",
  digest,
} as const

const generationRef = {
  scopeId: "project.sample",
  generation: "2",
  headDigest: digest,
} as const

const typedError = {
  code: "MEMORY_UNAVAILABLE",
  category: "unavailable",
  message: "Memory service unavailable",
  retryClass: "SAFE_QUERY_RETRY",
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

describe("Horizon memory v1 contracts", () => {
  test("round trips the normative contract shapes and literals", () => {
    const policy = {
      policyDigest: digest,
      enabled: true,
      permittedTargetScopes: [scope],
      maxCandidatesPerRange: 0,
      retentionClass: "standard",
      requireUserReview: true,
    } as const

    const indexEntry = {
      memoryId: "memory.1",
      scope,
      title: "Repository preference",
      retrievalHint: "Use the project formatter",
      contentDigest: digest,
      recordGeneration: 2,
      indexGeneration: "3",
      freshness: "STALE",
    } as const

    const query = {
      queryId: "memory-query.1",
      permittedScopes: [scope],
      query: artifact,
      memoryGenerationRefs: [generationRef],
      principalScopeDigest: digest,
      maxResults: 0,
      maxContentBytes: "18446744073709551615",
      maxTokenEstimate: 0,
      includeTranscriptFallback: true,
    } as const

    const queryResult = {
      queryId: query.queryId,
      status: "PARTIAL",
      matches: [
        {
          memoryId: "memory.1",
          contentRef: artifact,
          freshness: "EXPIRED",
          rank: 1,
          provenance: [artifact],
        },
      ],
      fallbackThreadRanges: [range],
      nextCursor: "cursor.next",
    } as const

    const candidate = {
      candidateId: "memory-candidate.1",
      proposedScope: scope,
      content: artifact,
      sourceRefs: [artifact],
      sourceRange: range,
      confidence: "high",
      proposedSupersedes: ["memory.previous"],
      sourceGenerationRefs: [generationRef],
      supersessionSources: [
        {
          memoryId: "memory.previous",
          generation: 1,
          contentDigest: digest,
        },
      ],
      policyDigest: digest,
      state: "ACCEPTED",
      acceptedMemoryId: "memory.2",
      reviewReceipt: artifact,
      candidateDigest: digest,
      createdAt: "2026-10-09T12:30:45.123Z",
    } as const

    const extraction = {
      extractionId: "memory-extraction.1",
      threadId: "thread.sample",
      sourceCursor: {
        ownerKind: "thread",
        ownerId: "thread.sample",
        seq: "17",
        eventDigest: digest,
      },
      sourceRange: range,
      extractorDigest: digest,
      policyDigest: digest,
      candidateIds: [candidate.candidateId],
      state: "FAILED",
      failure: typedError,
      createdAt: "2026-10-09T12:30:45.123Z",
      updatedAt: "2026-10-09T12:31:45.123Z",
    } as const

    const consolidation = {
      consolidationId: "memory-consolidation.1",
      scope,
      sourceGeneration: generationRef,
      inputMemoryIds: ["memory.1"],
      strategyDigest: digest,
      state: "CONSOLIDATING",
      candidateIds: [candidate.candidateId],
      createdAt: "2026-10-09T12:30:45.123Z",
      updatedAt: "2026-10-09T12:31:45.123Z",
    } as const

    roundTrip(Memory.MemoryScopeV1, scope)
    roundTrip(Memory.MemoryGenerationRefV1, generationRef)
    roundTrip(Memory.ThreadRangeRefV1, range)
    roundTrip(Memory.MemoryRecordV1, record)
    roundTrip(Memory.MemoryExtractionPolicyV1, policy)
    roundTrip(Memory.MemoryIndexEntryV1, indexEntry)
    roundTrip(Memory.MemoryQueryV1, query)
    roundTrip(Memory.MemoryQueryResultV1, queryResult)
    roundTrip(Memory.MemoryCandidateV1, candidate)
    roundTrip(Memory.MemoryExtractionV1, extraction)
    roundTrip(Memory.MemoryConsolidationV1, consolidation)

    const decodeQuery = Schema.decodeUnknownSync(Memory.MemoryQueryV1)
    expect(decodeQuery({ ...query, memoryGenerationRefs: [generationRef] }).memoryGenerationRefs).toHaveLength(1)
    expect(() =>
      decodeQuery({
        ...query,
        memoryGenerationRefs: [{ ...generationRef, scopeId: "project.other" }],
      }),
    ).toThrow()
    expect(() => decodeQuery({ ...query, permittedScopes: [], memoryGenerationRefs: [generationRef] })).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryCandidateV1)({ ...candidate, reviewReceipt: undefined }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryExtractionV1)({ ...extraction, failure: undefined })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryConsolidationV1)({ ...consolidation, state: "FAILED" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryRecordV1)({ ...record, acceptedCandidateId: undefined }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryRecordV1)({ ...record, status: "TOMBSTONED" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryExtractionV1)({
        ...extraction,
        sourceRange: { ...range, threadId: "thread.other" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryExtractionV1)({
        ...extraction,
        sourceCursor: { ...extraction.sourceCursor, ownerKind: "run" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryExtractionV1)({
        ...extraction,
        sourceCursor: { ...extraction.sourceCursor, ownerId: "thread.other" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryConsolidationV1)({
        ...consolidation,
        sourceGeneration: { ...generationRef, scopeId: "project.other" },
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryRecordV1)({ ...record, generation: -1 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryExtractionPolicyV1)({ ...policy, maxCandidatesPerRange: 1.5 }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryQueryV1)({ ...query, maxTokenEstimate: -1 })).toThrow()
  })

  test("validates accepted supersession IDs in strict UTF-8 byte order", () => {
    const decodeRecord = Schema.decodeUnknownSync(Memory.MemoryRecordV1)
    const ordinary = ["memory.a", "memory.z"]
    const unicode = ["memory.\uE000", "memory.\u{10000}"]

    expect(decodeRecord({ ...record, supersedesMemoryIds: ordinary }).supersedesMemoryIds?.map(String)).toEqual(
      ordinary,
    )
    expect(decodeRecord({ ...record, supersedesMemoryIds: unicode }).supersedesMemoryIds?.map(String)).toEqual(unicode)
    expect(decodeRecord({ ...record, supersedesMemoryIds: [] }).supersedesMemoryIds).toEqual([])
    expect(decodeRecord({ ...record, supersedesMemoryIds: ["memory.only"] }).supersedesMemoryIds?.map(String)).toEqual([
      "memory.only",
    ])
    expect(() => decodeRecord({ ...record, supersedesMemoryIds: ["memory.z", "memory.a"] })).toThrow()
    expect(() => decodeRecord({ ...record, supersedesMemoryIds: ["memory.\u{10000}", "memory.\uE000"] })).toThrow()
    expect(() => decodeRecord({ ...record, supersedesMemoryIds: ["memory.same", "memory.same"] })).toThrow()
  })

  test("requires memory result ranks to be nonnegative safe integers", () => {
    const decodeResult = Schema.decodeUnknownSync(Memory.MemoryQueryResultV1)
    const match = {
      memoryId: "memory.1",
      contentRef: artifact,
      freshness: "CURRENT",
      rank: 0,
      provenance: [],
    } as const
    const result = {
      queryId: "memory-query.1",
      status: "CURRENT",
      matches: [match],
    } as const

    expect(decodeResult(result).matches[0].rank).toBe(0)
    expect(decodeResult({ ...result, matches: [{ ...match, rank: Number.MAX_SAFE_INTEGER }] }).matches[0].rank).toBe(
      Number.MAX_SAFE_INTEGER,
    )
    for (const rank of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeResult({ ...result, matches: [{ ...match, rank }] })).toThrow()
    }
  })

  test("does not equate candidate supersession proposals with source snapshots", () => {
    const candidate = Schema.decodeUnknownSync(Memory.MemoryCandidateV1)({
      candidateId: "memory-candidate.proposed",
      proposedScope: scope,
      content: artifact,
      sourceRefs: [artifact],
      confidence: "medium",
      proposedSupersedes: ["memory.proposed"],
      sourceGenerationRefs: [generationRef],
      supersessionSources: [
        {
          memoryId: "memory.observed",
          generation: 3,
          contentDigest: digest,
        },
      ],
      policyDigest: digest,
      state: "PROPOSED",
      candidateDigest: digest,
      createdAt: "2026-10-09T12:30:45.123Z",
    })

    expect(candidate.proposedSupersedes.map(String)).toEqual(["memory.proposed"])
    expect(candidate.supersessionSources.map((source) => String(source.memoryId))).toEqual(["memory.observed"])
  })

  test("omits undefined optional values when encoding", () => {
    const record = {
      memoryId: "memory.1",
      scope,
      content: artifact,
      origin: "user_explicit",
      sourceRefs: [],
      confidence: "low",
      generation: 1,
      createdAt: "2026-10-09T12:30:45.123Z",
      status: "ACTIVE",
    } as const

    const decoded = Schema.decodeUnknownSync(Memory.MemoryRecordV1)(record)
    const encoded = Schema.encodeUnknownSync(Memory.MemoryRecordV1)({
      ...decoded,
      acceptedCandidateId: undefined,
      expiresAt: undefined,
      supersedesMemoryIds: undefined,
      tombstonedAt: undefined,
    })
    expect(encoded).not.toHaveProperty("acceptedCandidateId")
    expect(encoded).not.toHaveProperty("expiresAt")
    expect(encoded).not.toHaveProperty("supersedesMemoryIds")
    expect(encoded).not.toHaveProperty("tombstonedAt")
    expect(Schema.decodeUnknownSync(Memory.MemoryRecordV1)(encoded)).not.toHaveProperty("expiresAt")
  })

  test("uses stable unique domain-qualified identifiers and the canonical shared schema objects", () => {
    const schemas = [
      Memory.MemoryId,
      Memory.MemoryCandidateId,
      Memory.MemoryQueryId,
      Memory.MemoryExtractionId,
      Memory.MemoryConsolidationId,
      Thread.ThreadId,
      Memory.MemoryScopeV1,
      Memory.MemoryGenerationRefV1,
      Memory.ThreadRangeRefV1,
      Memory.MemoryRecordV1,
      Memory.MemoryExtractionPolicyV1,
      Memory.MemoryIndexEntryV1,
      Memory.MemoryQueryV1,
      Memory.MemoryQueryResultV1,
      Memory.MemoryCandidateV1,
      Memory.MemoryExtractionV1,
      Memory.MemoryConsolidationV1,
    ]
    const identifiers = schemas.map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers).toEqual([
      "Horizon.MemoryV1.MemoryId",
      "Horizon.MemoryV1.MemoryCandidateId",
      "Horizon.MemoryV1.MemoryQueryId",
      "Horizon.MemoryV1.MemoryExtractionId",
      "Horizon.MemoryV1.MemoryConsolidationId",
      "Horizon.ThreadV1.ThreadId",
      "Horizon.MemoryV1.MemoryScopeV1",
      "Horizon.MemoryV1.MemoryGenerationRefV1",
      "Horizon.MemoryV1.ThreadRangeRefV1",
      "Horizon.MemoryV1.MemoryRecordV1",
      "Horizon.MemoryV1.MemoryExtractionPolicyV1",
      "Horizon.MemoryV1.MemoryIndexEntryV1",
      "Horizon.MemoryV1.MemoryQueryV1",
      "Horizon.MemoryV1.MemoryQueryResultV1",
      "Horizon.MemoryV1.MemoryCandidateV1",
      "Horizon.MemoryV1.MemoryExtractionV1",
      "Horizon.MemoryV1.MemoryConsolidationV1",
    ])
    expect(new Set(identifiers).size).toBe(identifiers.length)

    expect(fieldType(Memory.MemoryRecordV1, "content")).toBe(Composition.ArtifactRef.ast)
    expect(fieldType(Memory.MemoryRecordV1, "createdAt")).toBe(Composition.Timestamp.ast)
    expect(fieldType(Memory.ThreadRangeRefV1, "firstEvent")).toBe(Composition.UInt64Decimal.ast)
    expect(fieldType(Memory.ThreadRangeRefV1, "digest")).toBe(Composition.Digest.ast)
    expect(fieldType(Memory.ThreadRangeRefV1, "threadId")).toBe(Thread.ThreadId.ast)
    expect(fieldType(Memory.MemoryExtractionV1, "sourceCursor")).toBe(Thread.CursorV1.ast)
  })

  test("preserves literal contracts and does not invent numeric or identifier formats", () => {
    expect(String(Schema.decodeUnknownSync(Memory.MemoryId)("memory id without a prescribed prefix"))).toBe(
      "memory id without a prescribed prefix",
    )
    expect(() => Schema.decodeUnknownSync(Memory.MemoryId)("")).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryScopeV1)({ ...scope, id: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.MemoryScopeV1)({ kind: "organization", id: "org.1" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Memory.ThreadRangeRefV1)({ ...range, firstEvent: "18" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryQueryV1)({
        queryId: "memory-query.1",
        permittedScopes: [scope],
        query: artifact,
        memoryGenerationRefs: [generationRef],
        principalScopeDigest: digest,
        maxResults: 1.5,
        maxContentBytes: "128",
        maxTokenEstimate: 10,
        includeTranscriptFallback: false,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryExtractionPolicyV1)({
        policyDigest: digest,
        enabled: true,
        permittedTargetScopes: [scope],
        maxCandidatesPerRange: 1,
        retentionClass: "standard",
        requireUserReview: false,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryRecordV1)({
        memoryId: "memory.1",
        scope,
        content: artifact,
        origin: "automatic",
        sourceRefs: [],
        confidence: "medium",
        generation: 1,
        createdAt: "2026-10-09T12:30:45.123Z",
        status: "ACTIVE",
      }),
    ).toThrow()
  })
})
