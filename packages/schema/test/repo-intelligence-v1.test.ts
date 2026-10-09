import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as RepoIntel from "../src/repo-intelligence-v1"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)

const artifact = {
  artifactId: "artifact.repo-intelligence",
  digest,
  byteLength: "128",
  mediaType: "application/json",
  classification: "workspace",
} as const

const revision = {
  repositoryId: "repository id without a prefix",
  vcsKind: "git",
  commitId: "commit abc123",
  treeDigest: digest,
  workspaceManifestDigest: digest,
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

const arrayItemType = (schema: Schema.Top, name: string) => {
  const type = fieldType(schema, name)
  if (type?._tag !== "Arrays") return undefined
  return type.rest[0]
}

describe("Horizon repository-intelligence v1 contracts", () => {
  test("round trips all normative record shapes and literals", () => {
    const revisionSet = {
      // Sorting/uniqueness are owner-validated because opaque IDs have no specified collation.
      members: [revision, { ...revision, repositoryId: "another repository" }],
      digest,
    } as const
    const generation = {
      generationId: "generation without a prefix",
      repositoryId: revision.repositoryId,
      workspaceId: "workspace id",
      baseGenerationId: "prior generation",
      revision: revisionSet,
      readPolicyDigest: digest,
      parserSetDigest: digest,
      status: "PARTIAL",
      createdAt: "2026-10-09T12:30:45.123Z",
      diagnostics: [artifact],
    } as const
    const query = {
      queryId: "query id without a prefix",
      generationIds: [generation.generationId],
      overlayRefs: [artifact],
      operation: "references",
      query: artifact,
      maxResults: 0,
    } as const
    const queryResult = {
      queryId: query.queryId,
      status: "UNAVAILABLE",
      generationIds: query.generationIds,
      results: [],
      nextCursor: "opaque cursor",
    } as const

    roundTrip(RepoIntel.RevisionRefV1, revision)
    roundTrip(RepoIntel.RevisionSetV1, revisionSet)
    roundTrip(RepoIntel.RepoGenerationV1, generation)
    roundTrip(RepoIntel.RepoQueryV1, query)
    roundTrip(RepoIntel.RepoQueryResultV1, queryResult)
  })

  test("requires no-VCS revisions to omit commit IDs while keeping Git commit IDs optional", () => {
    const decodeRevision = Schema.decodeUnknownSync(RepoIntel.RevisionRefV1)
    const { commitId: _commitId, ...revisionWithoutCommit } = revision

    expect(decodeRevision({ ...revisionWithoutCommit, vcsKind: "none" })).toMatchObject({ vcsKind: "none" })
    expect(decodeRevision(revisionWithoutCommit).vcsKind).toBe("git")
    expect(() => decodeRevision({ ...revision, vcsKind: "none" })).toThrow(
      "no-VCS revisions must not include commit IDs",
    )
  })

  test("omits undefined optional properties when encoding", () => {
    const encodedRevision = Schema.encodeUnknownSync(RepoIntel.RevisionRefV1)({
      ...revision,
      commitId: undefined,
    })
    expect(encodedRevision).not.toHaveProperty("commitId")

    const revisionSet = { members: [], digest } as const
    const generation = Schema.decodeUnknownSync(RepoIntel.RepoGenerationV1)({
      generationId: "generation",
      repositoryId: "repository",
      revision: revisionSet,
      readPolicyDigest: digest,
      parserSetDigest: digest,
      status: "CURRENT",
      createdAt: "2026-10-09T12:30:45.123Z",
      diagnostics: [],
    })
    const encodedGeneration = Schema.encodeUnknownSync(RepoIntel.RepoGenerationV1)({
      ...generation,
      workspaceId: undefined,
      baseGenerationId: undefined,
    })
    expect(encodedGeneration).not.toHaveProperty("workspaceId")
    expect(encodedGeneration).not.toHaveProperty("baseGenerationId")

    const queryResult = Schema.decodeUnknownSync(RepoIntel.RepoQueryResultV1)({
      queryId: "query",
      status: "CURRENT",
      generationIds: [],
      results: [],
    })
    const encodedQueryResult = Schema.encodeUnknownSync(RepoIntel.RepoQueryResultV1)({
      ...queryResult,
      nextCursor: undefined,
    })
    expect(encodedQueryResult).not.toHaveProperty("nextCursor")
  })

  test("uses stable unique identifiers and the canonical shared schema values", () => {
    const schemas = [
      RepoIntel.RepositoryId,
      RepoIntel.RepoGenerationId,
      RepoIntel.WorkspaceId,
      RepoIntel.RevisionRefV1,
      RepoIntel.RevisionSetV1,
      RepoIntel.RepoGenerationV1,
      RepoIntel.RepoQueryV1,
      RepoIntel.RepoQueryResultV1,
    ]
    const identifiers = schemas.map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers).toEqual([
      "Horizon.RepoIntelligenceV1.RepositoryId",
      "Horizon.RepoIntelligenceV1.RepoGenerationId",
      "Horizon.RepoIntelligenceV1.WorkspaceId",
      "Horizon.RepoIntelligenceV1.RevisionRefV1",
      "Horizon.RepoIntelligenceV1.RevisionSetV1",
      "Horizon.RepoIntelligenceV1.RepoGenerationV1",
      "Horizon.RepoIntelligenceV1.RepoQueryV1",
      "Horizon.RepoIntelligenceV1.RepoQueryResultV1",
    ])
    expect(new Set(identifiers).size).toBe(identifiers.length)

    expect(fieldType(RepoIntel.RevisionRefV1, "treeDigest")).toBe(Composition.Digest.ast)
    expect(fieldType(RepoIntel.RevisionSetV1, "digest")).toBe(Composition.Digest.ast)
    expect(fieldType(RepoIntel.RepoGenerationV1, "revision")).toBe(RepoIntel.RevisionSetV1.ast)
    expect(fieldType(RepoIntel.RepoGenerationV1, "createdAt")).toBe(Composition.Timestamp.ast)
    expect(arrayItemType(RepoIntel.RepoGenerationV1, "diagnostics")).toBe(Composition.ArtifactRef.ast)
    expect(fieldType(RepoIntel.RepoQueryV1, "query")).toBe(Composition.ArtifactRef.ast)
    expect(arrayItemType(RepoIntel.RepoQueryResultV1, "results")).toBe(Composition.ArtifactRef.ast)
  })

  test("enforces closed literals and the architecture's general integer rule only", () => {
    expect(() => Schema.decodeUnknownSync(RepoIntel.RevisionRefV1)({ ...revision, vcsKind: "svn" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RepoIntel.RepoGenerationV1)({
        generationId: "generation",
        repositoryId: "repository",
        revision: { members: [], digest },
        readPolicyDigest: digest,
        parserSetDigest: digest,
        status: "READY",
        createdAt: "2026-10-09T12:30:45.123Z",
        diagnostics: [],
      }),
    ).toThrow()

    const query = {
      queryId: "query",
      generationIds: [],
      overlayRefs: [],
      operation: "text",
      query: artifact,
      maxResults: 0,
    } as const
    const decodeQuery = Schema.decodeUnknownSync(RepoIntel.RepoQueryV1)
    expect(decodeQuery({ ...query, maxResults: Number.MAX_SAFE_INTEGER }).maxResults).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => decodeQuery({ ...query, operation: "search" })).toThrow()
    expect(() => decodeQuery({ ...query, maxResults: -1 })).toThrow()
    expect(() => decodeQuery({ ...query, maxResults: 1.5 })).toThrow()
    expect(() => decodeQuery({ ...query, maxResults: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RepoIntel.RepoQueryResultV1)({
        queryId: "query",
        status: "BUILDING",
        generationIds: [],
        results: [],
      }),
    ).toThrow()
  })

  test("preserves owner-side revision ordering and enforces unique repository membership", () => {
    const opaqueId = "not_prefixed / mixed case / 🚀"
    expect(String(Schema.decodeUnknownSync(RepoIntel.RepositoryId)(opaqueId))).toBe(opaqueId)
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepositoryId)("")).toThrow()

    const decodeRevisionSet = Schema.decodeUnknownSync(RepoIntel.RevisionSetV1)
    expect(
      decodeRevisionSet({
        members: [
          { ...revision, repositoryId: "z" },
          { ...revision, repositoryId: "a" },
        ],
        digest,
      }).members.map((member) => String(member.repositoryId)),
    ).toEqual(["z", "a"])
    expect(() =>
      decodeRevisionSet({
        members: [
          { ...revision, repositoryId: "same" },
          { ...revision, repositoryId: "same" },
        ],
        digest,
      }),
    ).toThrow()
  })
})
