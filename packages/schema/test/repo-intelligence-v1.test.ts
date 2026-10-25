import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as RepoIntel from "../src/repo-intelligence-v1"
import repoStructureFixture from "../../../arch_V1/contracts-v2/fixtures/repo-structure-page-v1.json" with { type: "json" }

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
  test("computes document content digests over exact UTF-8 text", () => {
    expect(RepoIntel.repoDocumentContentDigest("")).toBe(
      Schema.decodeUnknownSync(Composition.Digest)(
        "blake3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
      ),
    )
    expect(RepoIntel.repoDocumentContentDigest("λ\n")).not.toBe(RepoIntel.repoDocumentContentDigest("λ"))
  })

  test("bounds authenticated document reads and requires a file-relative path", () => {
    const request = {
      schemaVersion: 1,
      pathRef: "src/main.ts",
      revisionKind: "workspace",
      expectedWorkspaceRevision: digest,
      maxBytes: 131_072,
    } as const
    const response = {
      schemaVersion: 1,
      status: "OK",
      pathRef: request.pathRef,
      revisionKind: request.revisionKind,
      text: "export {}\n",
      contentDigest: digest,
      observedWorkspaceRevision: digest,
    } as const
    roundTrip(RepoIntel.RepoDocumentReadRequestV1, request)
    roundTrip(RepoIntel.RepoDocumentReadResponseV1, response)
    roundTrip(RepoIntel.RepoDocumentReadRequestV1, { ...request, revisionKind: "discovery_observation" })
    roundTrip(RepoIntel.RepoDocumentReadResponseV1, { ...response, revisionKind: "discovery_observation" })
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDocumentReadRequestV1)({
      ...request,
      pathRef: ".",
    })).toThrow("document path must name a file")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDocumentReadRequestV1)({
      ...request,
      maxBytes: 131_073,
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDocumentReadRequestV1)({
      ...request,
      revisionKind: "best_effort",
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDocumentReadResponseV1)({
      ...response,
      text: "x".repeat(131_073),
    })).toThrow()
  })

  test("pins bounded repository discovery to authenticated owner and source scope", () => {
    const request = {
      schemaVersion: 1,
      messageType: "discover",
      requestId: "repo-discovery-1",
      rootRef: ".",
      mode: "manifests",
      maxEntries: 512,
      maxBytes: 262_144,
      maxDepth: 16,
      deadline: "2026-10-21T12:00:00.000Z",
    } as const
    roundTrip(RepoIntel.RepoDiscoveryRequestV1, request)
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDiscoveryRequestV1)({ ...request, maxEntries: 513 })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDiscoveryRequestV1)({ ...request, rootRef: "../outside" })).toThrow()

    const page = {
      schemaVersion: 1,
      messageType: "discovery",
      requestId: request.requestId,
      status: "PARTIAL",
      freshness: "current",
      completeness: "partial",
      partialReason: "entry_limit",
      authority: {
        principalBinding: digest,
        sessionID: "ses_discovery",
        locationID: "loc_discovery",
        ownerEpoch: "4",
        workspaceBinding: digest,
        sourceRevision: digest,
        readPolicyDigest: digest,
        rootRef: request.rootRef,
        mode: request.mode,
        maxEntries: request.maxEntries,
        maxBytes: request.maxBytes,
        maxDepth: request.maxDepth,
      },
      coverage: { entries: 1, bytes: 72, depth: 1 },
      entries: [{ pathRef: "package.json", kind: "file", depth: 1, sizeBytes: "42", manifestKind: "package_json", languageHint: "javascript" }],
    } as const
    roundTrip(RepoIntel.RepoDiscoveryPageV1, page)
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDiscoveryPageV1)({
      ...page,
      coverage: { ...page.coverage, entries: 0 },
    })).toThrow("discovery entry coverage must match returned entries")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoDiscoveryPageV1)({
      ...page,
      entries: [{ ...page.entries[0], pathRef: "../outside/package.json" }],
    })).toThrow()
  })

  test("keeps RepoIntel patch fences bounded and read-only", () => {
    const fence = {
      schemaVersion: 1,
      queryID: "query-1",
      sourceGeneration: digest,
      sourceRevision: digest,
      workspaceBinding: digest,
      sourceRefs: [
        { pathRef: "src/main.ts", fileDigest: digest },
        { pathRef: "src/new.ts", expectedAbsent: true },
      ],
    } as const
    roundTrip(RepoIntel.RepoIntelPatchFenceV1, fence)
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoIntelPatchFenceV1, { onExcessProperty: "error" })({
      ...fence,
      sourceRefs: [],
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoIntelPatchFenceV1)({
      ...fence,
      sourceRefs: [fence.sourceRefs[0], fence.sourceRefs[0]],
    })).toThrow("RepoIntel source paths must be unique")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoIntelPatchFenceV1)({
      ...fence,
      sourceRefs: [{ pathRef: "src/new.ts" }],
    })).toThrow("RepoIntel source ref must name existing content or an expected-absent destination")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoIntelPatchFenceV1, { onExcessProperty: "error" })({
      ...fence,
      authority: "write",
    })).toThrow()
  })

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
      maxResults: 1,
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
      RepoIntel.RepoNodeRefV1,
      RepoIntel.RepoStructureQueryV1,
      RepoIntel.RepoStructureCoverageV1,
      RepoIntel.RepoStructureFallbackV1,
      RepoIntel.RepoStructurePageV1,
      RepoIntel.RepoGenerationRequestV1,
      RepoIntel.RepoGenerationPinV1,
      RepoIntel.RepoDocumentReadRequestV1,
      RepoIntel.RepoDocumentReadResponseV1,
      RepoIntel.RepoIntelPatchFenceV1,
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
      "Horizon.RepoIntelligenceV1.RepoNodeRefV1",
      "Horizon.RepoIntelligenceV1.RepoStructureQueryV1",
      "Horizon.RepoIntelligenceV1.RepoStructureCoverageV1",
      "Horizon.RepoIntelligenceV1.RepoStructureFallbackV1",
      "Horizon.RepoIntelligenceV1.RepoStructurePageV1",
      "Horizon.RepoIntelligenceV1.RepoGenerationRequestV1",
      "Horizon.RepoIntelligenceV1.RepoGenerationPinV1",
      "Horizon.RepoIntelligenceV1.RepoDocumentReadRequestV1",
      "Horizon.RepoIntelligenceV1.RepoDocumentReadResponseV1",
      "Horizon.RepoIntelligenceV1.RepoIntelPatchFenceV1",
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

  test("enforces closed literals and indexd's bounded result limit", () => {
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
      maxResults: 1,
    } as const
    const decodeQuery = Schema.decodeUnknownSync(RepoIntel.RepoQueryV1)
    expect(decodeQuery({ ...query, maxResults: 1 }).maxResults).toBe(1)
    expect(decodeQuery({ ...query, maxResults: 100 }).maxResults).toBe(100)
    expect(() => decodeQuery({ ...query, maxResults: 0 })).toThrow()
    expect(() => decodeQuery({ ...query, maxResults: 101 })).toThrow()
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

  test("validates generation-bound RepoIntel node refs and bounded structure pages", () => {
    const nodeRef = {
      workspaceBinding: "workspace-binding",
      sourceGeneration: digest,
      sourceRevision: digest,
      pathRef: "src/example.ts",
      fileDigest: digest,
      nodeId: "node-17",
      nodeKind: "function",
      symbol: "example",
      byteRange: { start: 4, end: 42 },
      parserId: "typescript",
      parserVersion: "5.9.0",
    } as const
    const query = {
      schemaVersion: 1,
      messageType: "query",
      queryId: "query-1",
      rootRef: ".",
      sourceGeneration: digest,
      selector: { symbols: ["example"], nodeRefs: [nodeRef], includeCallers: false },
      maxNodes: 40,
      maxBytes: 32_768,
      maxDepth: 8,
      deadline: "2026-10-19T12:30:45.123Z",
    } as const
    const page = {
      schemaVersion: 1,
      messageType: "page",
      queryId: query.queryId,
      workspaceBinding: "workspace-binding",
      sourceGeneration: query.sourceGeneration,
      sourceRevision: digest,
      sourceKind: "parser",
      status: "CURRENT",
      freshness: "current",
      completeness: "complete",
      coverage: { files: "12", nodes: "1", bytes: "32768" },
      nodes: [nodeRef],
      nextCursor: "repo_cur_0123456789abcdef",
    } as const

    roundTrip(RepoIntel.RepoNodeRefV1, nodeRef)
    roundTrip(RepoIntel.RepoStructureQueryV1, query)
    roundTrip(RepoIntel.RepoStructurePageV1, page)
    const decodedWithForgedPrincipal = Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)({
      ...query,
      principal: { id: "forged" },
    })
    expect(decodedWithForgedPrincipal).not.toHaveProperty("principal")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)({ ...query, maxBytes: 32_768 * 32 })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)({
      ...query,
      selector: { symbols: Array.from({ length: 100 }, (_, index) => `symbol-${index}`), nodeRefs: [nodeRef] },
    })).toThrow("structure selector exceeds the combined symbol and node reference limit")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoNodeRefV1)({
      ...nodeRef,
      byteRange: { start: 42, end: 4 },
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      freshness: "current",
      completeness: "unknown-value",
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      nodes: [{ ...nodeRef, sourceRevision: "blake3:" + "0".repeat(64) }],
    })).toThrow("every node reference must match the page source revision")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      status: "STALE",
      freshness: "current",
    })).toThrow("STALE status must use stale freshness")
    expect(Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      coverage: { ...page.coverage, nodes: "2" },
    }).coverage.nodes).toBe("2")

    expect(Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)(repoStructureFixture.query)).toMatchObject({
      queryId: "query-1",
      sourceGeneration: digest,
    })
    expect(Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)(repoStructureFixture.overlayQuery)).toMatchObject({
      overlayRef: "ovl_0123456789abcdef",
    })
    expect(Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)(repoStructureFixture.overlayPage)).toMatchObject({
      overlayDigest: "blake3:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      nodes: [{ overlayDigest: "blake3:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" }],
    })
    const fixturePage = Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)(repoStructureFixture.page)
    expect(fixturePage).toMatchObject({
      sourceKind: "parser",
      completeness: "complete",
    })
    expect(fixturePage.nodes).toHaveLength(1)
    expect(fixturePage.nodes[0]?.pathRef).toBe("src/example.ts")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      coverage: { files: 12, nodes: "1", bytes: "32768" },
    })).toThrow()
    const unavailablePage = Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)(repoStructureFixture.unavailablePage)
    expect(unavailablePage).toMatchObject({
      status: "UNAVAILABLE",
      freshness: "unknown",
      completeness: "unavailable",
      sourceKind: "none",
      fallback: { reason: "parser_unsupported", sourceKind: "none" },
    })
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...repoStructureFixture.unavailablePage,
      sourceKind: "lexical",
    })).toThrow()
  })

  test("binds opaque overlay references to page and node provenance without carrying content", () => {
    const overlayRef = "ovl_0123456789abcdef"
    const overlayDigest = Schema.decodeUnknownSync(Composition.Digest)(
      "blake3:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    )
    const query = {
      schemaVersion: 1,
      messageType: "query",
      queryId: "overlay-query",
      rootRef: ".",
      sourceGeneration: digest,
      overlayRef,
      selector: { symbols: ["example"] },
      maxNodes: 10,
      maxBytes: 16_384,
      maxDepth: 4,
      deadline: "2026-10-19T12:30:45.123Z",
    } as const
    const node = {
      workspaceBinding: "workspace-binding",
      sourceGeneration: digest,
      sourceRevision: digest,
      overlayDigest,
      pathRef: "src/example.ts",
      fileDigest: digest,
      nodeId: "overlay-node",
      nodeKind: "function",
      symbol: "example",
      byteRange: { start: 0, end: 7 },
      parserId: "typescript",
      parserVersion: "5.9.0",
    } as const
    const page = {
      schemaVersion: 1,
      messageType: "page",
      queryId: query.queryId,
      workspaceBinding: "workspace-binding",
      sourceGeneration: digest,
      sourceRevision: digest,
      overlayDigest,
      sourceKind: "parser",
      status: "CURRENT",
      freshness: "current",
      completeness: "complete",
      coverage: { files: "1", nodes: "1", bytes: "7" },
      nodes: [node],
    } as const

    roundTrip(RepoIntel.RepoOverlayRefV1, overlayRef)
    roundTrip(RepoIntel.RepoStructureQueryV1, query)
    roundTrip(RepoIntel.RepoStructurePageV1, page)
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoOverlayRefV1)("not-an-opaque-overlay-ref")).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      overlayDigest: digest,
    })).toThrow("every node overlay digest must match the page overlay digest")
    const { overlayDigest: _nodeOverlayDigest, ...nodeWithoutOverlayDigest } = node
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)({
      ...page,
      nodes: [nodeWithoutOverlayDigest],
    })).toThrow("every node overlay digest must match the page overlay digest")
    const { overlayDigest: _overlayDigest, ...pageWithoutOverlayDigest } = page
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructurePageV1)(pageWithoutOverlayDigest))
      .toThrow("node overlay provenance requires a page overlay digest")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoStructureQueryV1)({
      ...query,
      overlayRef: "../foreign-session",
      overlay: { contents: "untrusted" },
    })).toThrow()
  })

  test("validates authenticated RepoIntel generation acquisition without caller authority", () => {
    const ensure = {
      schemaVersion: 1,
      messageType: "ensure_generation",
      requestId: "request-1",
      rootRef: ".",
      maxFiles: 512,
      maxBytes: 4_194_304,
      maxFileBytes: 262_144,
      deadline: "2026-10-19T12:30:45.123Z",
    } as const
    const pin = {
      schemaVersion: 1,
      messageType: "generation",
      requestId: ensure.requestId,
      workspaceBinding: "workspace-binding",
      sourceGeneration: digest,
      sourceRevision: digest,
      sourceKind: "lexical",
      coverage: { files: "27", bytes: "128000" },
      expiresAt: "2026-10-19T12:35:45.123Z",
    } as const

    roundTrip(RepoIntel.RepoGenerationRequestV1, ensure)
    roundTrip(RepoIntel.RepoGenerationPinV1, pin)
    const decoded = Schema.decodeUnknownSync(RepoIntel.RepoGenerationRequestV1)({
      ...ensure,
      principal: "caller-asserted",
      locationID: "caller-asserted",
      readScope: digest,
    })
    expect(decoded).not.toHaveProperty("principal")
    expect(decoded).not.toHaveProperty("locationID")
    expect(decoded).not.toHaveProperty("readScope")
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoGenerationRequestV1)({ ...ensure, maxFiles: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoGenerationRequestV1)({ ...ensure, maxBytes: 67_108_865 })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoGenerationPinV1)({ ...pin, coverage: { files: -1, bytes: "0" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoGenerationPinV1)({ ...pin, coverage: { files: 27, bytes: "128000" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(RepoIntel.RepoGenerationPinV1)({ ...pin, sourceRevision: "not-a-digest" })).toThrow()
  })
})
