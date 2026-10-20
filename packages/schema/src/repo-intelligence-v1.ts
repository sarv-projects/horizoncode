/**
 * Browser-safe Horizon repository-intelligence v1 wire contracts. RepoIntelService,
 * source/revision acquisition, authorization and digest computation remain outside
 * Schema.
 *
 * RevisionSetV1 members are sorted by RepositoryId, but the architecture does not define
 * a collation for opaque IDs. Ordering remains owner-validated; this schema enforces that
 * each repository appears at most once.
 */

import { Schema } from "effect"
import * as Composition from "./composition-v1"
import { optional } from "./schema"

const id = <const Identifier extends string>(identifier: Identifier) =>
  Schema.String.annotate({ identifier }).check(Schema.isNonEmpty()).pipe(Schema.brand(identifier))

export const RepositoryId = id("Horizon.RepoIntelligenceV1.RepositoryId")
export type RepositoryId = typeof RepositoryId.Type

export const RepoGenerationId = id("Horizon.RepoIntelligenceV1.RepoGenerationId")
export type RepoGenerationId = typeof RepoGenerationId.Type

export const WorkspaceId = id("Horizon.RepoIntelligenceV1.WorkspaceId")
export type WorkspaceId = typeof WorkspaceId.Type

export interface RevisionRefV1 extends Schema.Schema.Type<typeof RevisionRefV1> {}
export const RevisionRefV1 = Schema.Struct({
  repositoryId: RepositoryId,
  vcsKind: Schema.Literals(["git", "none"]),
  commitId: optional(Schema.String),
  treeDigest: Composition.Digest,
  workspaceManifestDigest: Composition.Digest,
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RevisionRefV1" })
  .check(
    Schema.makeFilter((revision) =>
      revision.vcsKind === "none" && revision.commitId !== undefined
        ? "no-VCS revisions must not include commit IDs"
        : undefined,
    ),
  )

export interface RevisionSetV1 extends Schema.Schema.Type<typeof RevisionSetV1> {}
export const RevisionSetV1 = Schema.Struct({
  members: Schema.Array(RevisionRefV1),
  digest: Composition.Digest,
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RevisionSetV1" })
  .check(
    Schema.makeFilter((revisionSet) => {
      const repositoryIds = new Set(revisionSet.members.map((member) => member.repositoryId))
      return repositoryIds.size === revisionSet.members.length
        ? undefined
        : "revision-set repository IDs must be unique"
    }),
  )

export interface RepoGenerationV1 extends Schema.Schema.Type<typeof RepoGenerationV1> {}
export const RepoGenerationV1 = Schema.Struct({
  generationId: RepoGenerationId,
  repositoryId: RepositoryId,
  workspaceId: optional(WorkspaceId),
  baseGenerationId: optional(RepoGenerationId),
  revision: RevisionSetV1,
  readPolicyDigest: Composition.Digest,
  parserSetDigest: Composition.Digest,
  status: Schema.Literals(["BUILDING", "CURRENT", "PARTIAL", "STALE", "FAILED", "RETIRED"]),
  createdAt: Composition.Timestamp,
  diagnostics: Schema.Array(Composition.ArtifactRef),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoGenerationV1" })

export interface RepoQueryV1 extends Schema.Schema.Type<typeof RepoQueryV1> {}
export const RepoQueryV1 = Schema.Struct({
  queryId: Schema.String.check(Schema.isNonEmpty()),
  generationIds: Schema.Array(RepoGenerationId),
  overlayRefs: Schema.Array(Composition.ArtifactRef),
  operation: Schema.Literals(["text", "symbol", "references", "impact", "expand"]),
  query: Composition.ArtifactRef,
  maxResults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoQueryV1" })

export interface RepoQueryResultV1 extends Schema.Schema.Type<typeof RepoQueryResultV1> {}
export const RepoQueryResultV1 = Schema.Struct({
  queryId: Schema.String.check(Schema.isNonEmpty()),
  status: Schema.Literals(["CURRENT", "STALE", "PARTIAL", "UNAVAILABLE"]),
  generationIds: Schema.Array(RepoGenerationId),
  results: Schema.Array(Composition.ArtifactRef),
  nextCursor: optional(Schema.String),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoQueryResultV1" })

const MAX_STRUCTURE_NODES = 100
const MAX_STRUCTURE_BYTES = 262_144
const MAX_STRUCTURE_DEPTH = 16
const MAX_STRUCTURE_FILE_BYTES = 1_048_576
const MAX_STRUCTURE_CURSOR_BYTES = 4_096

const BoundedIdentifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
/** Opaque reference minted by HostKernel for one authenticated immutable overlay lease. */
export const RepoOverlayRefV1 = Schema.String.check(Schema.isPattern(/^ovl_[A-Za-z0-9_-]{16,128}$/))
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoOverlayRefV1" })
export type RepoOverlayRefV1 = typeof RepoOverlayRefV1.Type
const RelativePathRef = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(4_096))
  .check(
    Schema.makeFilter((value) => {
      if (value === ".") return undefined
      if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
        return "path reference must be a normalized relative path"
      }
      const segments = value.split("/")
      return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ? "path reference must not contain empty, dot, or parent segments"
        : undefined
    }),
  )
const StructureByteOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(MAX_STRUCTURE_FILE_BYTES),
)
const StructureByteRange = Schema.Struct({ start: StructureByteOffset, end: StructureByteOffset })
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.StructureByteRange" })
  .check(Schema.makeFilter((range) => (range.end > range.start ? undefined : "byte range must be non-empty")))

export interface RepoNodeRefV1 extends Schema.Schema.Type<typeof RepoNodeRefV1> {}
export const RepoNodeRefV1 = Schema.Struct({
  workspaceBinding: BoundedIdentifier,
  sourceGeneration: Composition.Digest,
  sourceRevision: Composition.Digest,
  overlayDigest: optional(Composition.Digest),
  pathRef: RelativePathRef,
  fileDigest: Composition.Digest,
  nodeId: BoundedIdentifier,
  nodeKind: BoundedIdentifier,
  symbol: Schema.String.check(Schema.isMaxLength(1_024)),
  byteRange: StructureByteRange,
  parserId: BoundedIdentifier,
  parserVersion: BoundedIdentifier,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoNodeRefV1" })

export interface RepoStructureQueryV1 extends Schema.Schema.Type<typeof RepoStructureQueryV1> {}
export const RepoStructureQueryV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("query"),
  queryId: BoundedIdentifier,
  rootRef: RelativePathRef,
  sourceGeneration: Composition.Digest,
  /** Host-issued opaque lease reference only; never overlay bytes or authority. */
  overlayRef: optional(RepoOverlayRefV1),
  selector: Schema.Struct({
    symbols: Schema.optional(Schema.Array(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(1_024))).check(Schema.isMaxLength(100))),
    nodeRefs: Schema.optional(Schema.Array(RepoNodeRefV1).check(Schema.isMaxLength(100))),
    includeCallers: Schema.optional(Schema.Boolean),
  }),
  cursor: optional(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(MAX_STRUCTURE_CURSOR_BYTES))),
  maxNodes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_NODES })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_BYTES })),
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_DEPTH })),
  deadline: Composition.Timestamp,
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoStructureQueryV1" })
  .check(
    Schema.makeFilter((query) => {
      const hasSelector =
        (query.selector.symbols?.length ?? 0) > 0 ||
        (query.selector.nodeRefs?.length ?? 0) > 0 ||
        query.selector.includeCallers === true
      return hasSelector ? undefined : "structure query must include a non-empty selector"
    }),
  )

export interface RepoStructureCoverageV1 extends Schema.Schema.Type<typeof RepoStructureCoverageV1> {}
export const RepoStructureCoverageV1 = Schema.Struct({
  files: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_096 })),
  nodes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoStructureCoverageV1" })

export interface RepoStructureFallbackV1 extends Schema.Schema.Type<typeof RepoStructureFallbackV1> {}
export const RepoStructureFallbackV1 = Schema.Struct({
  reason: Schema.Literals([
    "parser_unsupported",
    "parse_partial",
    "lsp_unavailable",
    "resource_refused",
    "generation_stale",
    "overlay_unavailable",
    "index_corrupt",
    "scope_mismatch",
    "deadline_exceeded",
  ]),
  sourceKind: Schema.Literals(["symbol_index", "parser", "lexical", "lsp", "none"]),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoStructureFallbackV1" })

export interface RepoStructurePageV1 extends Schema.Schema.Type<typeof RepoStructurePageV1> {}
export const RepoStructurePageV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("page"),
  queryId: BoundedIdentifier,
  workspaceBinding: BoundedIdentifier,
  sourceGeneration: Composition.Digest,
  sourceRevision: Composition.Digest,
  overlayDigest: optional(Composition.Digest),
  sourceKind: Schema.Literals(["symbol_index", "parser", "lexical", "lsp", "none", "unknown"]),
  parserId: optional(BoundedIdentifier),
  parserVersion: optional(BoundedIdentifier),
  status: Schema.Literals(["CURRENT", "STALE", "PARTIAL", "UNAVAILABLE"]),
  freshness: Schema.Literals(["current", "stale", "unknown"]),
  completeness: Schema.Literals(["complete", "partial", "unavailable"]),
  coverage: RepoStructureCoverageV1,
  nodes: Schema.Array(RepoNodeRefV1).check(Schema.isMaxLength(MAX_STRUCTURE_NODES)),
  fallback: optional(RepoStructureFallbackV1),
  nextCursor: optional(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(MAX_STRUCTURE_CURSOR_BYTES))),
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoStructurePageV1" })
  .check(
    Schema.makeFilter((page) => {
      if (page.freshness === "stale" && page.status !== "STALE") {
        return "stale freshness must use STALE status"
      }
      if (page.completeness === "unavailable" && page.status !== "UNAVAILABLE") {
        return "unavailable completeness must use UNAVAILABLE status"
      }
      if (page.status === "UNAVAILABLE" && (page.sourceKind !== "none" || page.freshness !== "unknown")) {
        return "unavailable pages must have no source and unknown freshness"
      }
      if (page.status === "UNAVAILABLE" && page.nodes.length !== 0) {
        return "unavailable pages must not contain node references"
      }
      if (page.nodes.some((node) => node.sourceGeneration !== page.sourceGeneration)) {
        return "every node reference must match the page generation"
      }
      if (page.nodes.some((node) => node.workspaceBinding !== page.workspaceBinding)) {
        return "every node reference must match the page workspace binding"
      }
      if (page.overlayDigest === undefined && page.nodes.some((node) => node.overlayDigest !== undefined)) {
        return "node overlay provenance requires a page overlay digest"
      }
      if (page.overlayDigest !== undefined && page.nodes.some((node) => node.overlayDigest !== page.overlayDigest)) {
        return "every node overlay digest must match the page overlay digest"
      }
      return undefined
    }),
  )

export interface RepoGenerationRequestV1 extends Schema.Schema.Type<typeof RepoGenerationRequestV1> {}
export const RepoGenerationRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("ensure_generation"),
  requestId: BoundedIdentifier,
  rootRef: RelativePathRef,
  maxFiles: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_096 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 67_108_864 })),
  maxFileBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_FILE_BYTES })),
  deadline: Composition.Timestamp,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoGenerationRequestV1" })

export interface RepoGenerationPinV1 extends Schema.Schema.Type<typeof RepoGenerationPinV1> {}
export const RepoGenerationPinV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("generation"),
  requestId: BoundedIdentifier,
  workspaceBinding: BoundedIdentifier,
  sourceGeneration: Composition.Digest,
  sourceRevision: Composition.Digest,
  sourceKind: Schema.Literals(["symbol_index", "parser", "lexical", "lsp", "none", "unknown"]),
  coverage: Schema.Struct({
    files: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_096 })),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 67_108_864 })),
  }),
  expiresAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoGenerationPinV1" })
