/**
 * Browser-safe Horizon repository-intelligence v1 wire contracts. RepoIntelService,
 * source/revision acquisition and authorization remain outside Schema. The pure
 * document-text digest helper at the end is shared so Core can validate HostKernel
 * response content against the exact UTF-8 bytes.
 *
 * RevisionSetV1 members are sorted by RepositoryId, but the architecture does not define
 * a collation for opaque IDs. Ordering remains owner-validated; this schema enforces that
 * each repository appears at most once.
 */

import { Schema } from "effect"
import { blake3 } from "@noble/hashes/blake3.js"
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
export const MAX_STRUCTURE_CURSOR_BYTES = 4_096
// LSP's JSON frame is 1 MiB. Sixfold escaping plus envelope overhead for this
// UTF-8 source cap stays within that frame when didOpen/didChange embeds text.
export const MAX_REPO_DOCUMENT_BYTES = 131_072
export const MAX_REPO_DISCOVERY_ENTRIES = 512
export const MAX_REPO_DISCOVERY_BYTES = 262_144
export const MAX_REPO_DISCOVERY_DEPTH = 16

const BoundedIdentifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
/** Opaque reference minted by HostKernel for one authenticated immutable overlay lease. */
export const RepoOverlayRefV1 = Schema.String.check(Schema.isPattern(/^ovl_[A-Za-z0-9_-]{16,128}$/))
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoOverlayRefV1" })
export type RepoOverlayRefV1 = typeof RepoOverlayRefV1.Type
/** Opaque continuation lease minted and resolved only by HostKernel. */
export const RepoStructureCursorLeaseRefV1 = Schema.String.annotate({
  identifier: "Horizon.RepoIntelligenceV1.RepoStructureCursorLeaseRefV1",
}).check(Schema.isNonEmpty()).check(Schema.isMaxLength(MAX_STRUCTURE_CURSOR_BYTES))
  .check(Schema.isPattern(/^repo_cur_[A-Za-z0-9_-]{16,128}$/))
  .pipe(Schema.brand("Horizon.RepoIntelligenceV1.RepoStructureCursorLeaseRefV1"))
export type RepoStructureCursorLeaseRefV1 = typeof RepoStructureCursorLeaseRefV1.Type
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
const RepoDocumentPathRef = RelativePathRef.check(
  Schema.makeFilter((value) => (value === "." ? "document path must name a file" : undefined)),
)
const RepoDiscoverySizeBytes = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)).check(
  Schema.makeFilter((value) => {
    try {
      return BigInt(value) <= 18_446_744_073_709_551_615n ? undefined : "discovery file size exceeds u64"
    } catch {
      return "discovery file size is not a canonical u64 decimal"
    }
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

/** Read-only RepoIntel evidence carried with an explicit files.patch request.
 * HostKernel resolves the live query lease and revalidates every field before Guard. */
export interface RepoIntelPatchFenceV1 extends Schema.Schema.Type<typeof RepoIntelPatchFenceV1> {}
export const RepoIntelPatchFenceV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  queryID: BoundedIdentifier,
  sourceGeneration: Composition.Digest,
  sourceRevision: Composition.Digest,
  workspaceBinding: Composition.Digest,
  sourceRefs: Schema.Array(Schema.Struct({
    pathRef: RepoDocumentPathRef,
    fileDigest: optional(Composition.Digest),
    expectedAbsent: optional(Schema.Literal(true)),
  }).check(Schema.makeFilter((ref) =>
    (ref.fileDigest !== undefined) !== (ref.expectedAbsent === true)
      ? undefined
      : "RepoIntel source ref must name existing content or an expected-absent destination",
  ))).check(Schema.isMinLength(1)).check(Schema.isMaxLength(64)),
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoIntelPatchFenceV1" })
  .check(Schema.makeFilter((fence) => {
    const paths = new Set(fence.sourceRefs.map((ref) => ref.pathRef))
    return paths.size === fence.sourceRefs.length ? undefined : "RepoIntel source paths must be unique"
  }))

export interface RepoStructureQueryV1 extends Schema.Schema.Type<typeof RepoStructureQueryV1> {}
export const RepoStructureQueryV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("query"),
  queryId: BoundedIdentifier,
  rootRef: RelativePathRef,
  /** Required for a first page; omitted only when HostKernel resolves a cursor lease. */
  sourceGeneration: optional(Composition.Digest),
  /** Host-issued opaque lease reference only; never overlay bytes or authority. */
  overlayRef: optional(RepoOverlayRefV1),
  selector: Schema.Struct({
    symbols: Schema.optional(Schema.Array(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(1_024))).check(Schema.isMaxLength(100))),
    nodeRefs: Schema.optional(Schema.Array(RepoNodeRefV1).check(Schema.isMaxLength(100))),
    includeCallers: Schema.optional(Schema.Boolean),
  }).check(Schema.makeFilter((selector) =>
    (selector.symbols?.length ?? 0) + (selector.nodeRefs?.length ?? 0) <= MAX_STRUCTURE_NODES
      ? undefined
      : "structure selector exceeds the combined symbol and node reference limit",
  )),
  cursor: optional(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(MAX_STRUCTURE_CURSOR_BYTES))),
  maxNodes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_NODES })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_BYTES })),
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STRUCTURE_DEPTH })),
  deadline: Composition.Timestamp,
})
  .annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoStructureQueryV1" })
  .check(
    Schema.makeFilter((query) => {
      if ((query.cursor === undefined) !== (query.sourceGeneration !== undefined)) {
        return "first-page queries require sourceGeneration; continuation queries must rely on the HostKernel cursor lease"
      }
      const hasSelector =
        (query.selector.symbols?.length ?? 0) > 0 ||
        (query.selector.nodeRefs?.length ?? 0) > 0 ||
        query.selector.includeCallers === true
      return hasSelector ? undefined : "structure query must include a non-empty selector"
    }),
  )

export interface RepoStructureCoverageV1 extends Schema.Schema.Type<typeof RepoStructureCoverageV1> {}
export const RepoStructureCoverageV1 = Schema.Struct({
    files: Composition.UInt64Decimal,
    nodes: Composition.UInt64Decimal,
    bytes: Composition.UInt64Decimal,
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
      if (page.status === "STALE" && page.freshness !== "stale") {
        return "STALE status must use stale freshness"
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
      if (page.sourceKind === "none" && page.status !== "UNAVAILABLE") {
        return "pages without a source must be unavailable"
      }
      if (page.fallback !== undefined && page.fallback.sourceKind !== page.sourceKind) {
        return "fallback source kind must match the page source kind"
      }
      if (page.nodes.some((node) => node.sourceGeneration !== page.sourceGeneration)) {
        return "every node reference must match the page generation"
      }
      if (page.nodes.some((node) => node.sourceRevision !== page.sourceRevision)) {
        return "every node reference must match the page source revision"
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
    files: Composition.UInt64Decimal,
    bytes: Composition.UInt64Decimal,
  }),
  expiresAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoGenerationPinV1" })

/** Bounded authenticated inventory/manifest-candidate discovery. The caller body
 * carries limits only; principal, Session, Location, Guard scope and epoch are
 * supplied by the HostKernel envelope and included in the response pins. */
export interface RepoDiscoveryRequestV1 extends Schema.Schema.Type<typeof RepoDiscoveryRequestV1> {}
export const RepoDiscoveryRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("discover"),
  requestId: BoundedIdentifier,
  rootRef: RelativePathRef,
  mode: Schema.Literals(["tree", "manifests"]),
  maxEntries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_ENTRIES })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_BYTES })),
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_DEPTH })),
  deadline: Composition.Timestamp,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoDiscoveryRequestV1" })

const RepoDiscoveryEntryV1 = Schema.Struct({
  pathRef: RelativePathRef,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_REPO_DISCOVERY_DEPTH })),
  sizeBytes: RepoDiscoverySizeBytes,
  manifestKind: optional(Schema.Literals([
    "package_json", "tsconfig_json", "cargo_toml", "pyproject_toml", "requirements_txt",
    "go_mod", "pom_xml", "gradle", "csproj", "sln", "composer_json", "gemfile",
    "package_swift", "makefile", "dockerfile",
  ])),
  languageHint: optional(Schema.Literals([
    "typescript", "javascript", "python", "rust", "go", "java", "csharp", "c", "cpp",
    "kotlin", "swift", "ruby", "php", "scala", "shell",
  ])),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoDiscoveryEntryV1" })

export interface RepoDiscoveryPageV1 extends Schema.Schema.Type<typeof RepoDiscoveryPageV1> {}
export const RepoDiscoveryPageV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageType: Schema.Literal("discovery"),
  requestId: BoundedIdentifier,
  status: Schema.Literals(["CURRENT", "PARTIAL", "UNAVAILABLE"]),
  freshness: Schema.Literals(["current", "unknown"]),
  completeness: Schema.Literals(["complete", "partial", "unavailable"]),
  unavailableReason: optional(Schema.Literals(["read_unavailable", "deadline_exceeded", "workspace_changed"])),
  partialReason: optional(Schema.Literals(["entry_limit", "byte_limit", "depth_limit"])),
  authority: Schema.Struct({
    principalBinding: Composition.Digest,
    sessionID: BoundedIdentifier,
    locationID: BoundedIdentifier,
    ownerEpoch: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/)),
    workspaceBinding: Composition.Digest,
    sourceRevision: Composition.Digest,
    readPolicyDigest: Composition.Digest,
    rootRef: RelativePathRef,
    mode: Schema.Literals(["tree", "manifests"]),
    maxEntries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_ENTRIES })),
    maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_BYTES })),
    maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DISCOVERY_DEPTH })),
  }),
  coverage: Schema.Struct({
    entries: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_REPO_DISCOVERY_ENTRIES })),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_REPO_DISCOVERY_BYTES })),
    depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_REPO_DISCOVERY_DEPTH })),
  }),
  entries: Schema.Array(RepoDiscoveryEntryV1).check(Schema.isMaxLength(MAX_REPO_DISCOVERY_ENTRIES)),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoDiscoveryPageV1" })
  .check(Schema.makeFilter((page) => {
    if (page.coverage.entries !== page.entries.length) return "discovery entry coverage must match returned entries"
    if (page.status === "CURRENT" && (page.completeness !== "complete" || page.partialReason !== undefined || page.unavailableReason !== undefined)) return "current discovery must be complete"
    if (page.status === "PARTIAL" && (page.completeness !== "partial" || page.partialReason === undefined || page.unavailableReason !== undefined)) return "partial discovery requires a partial reason"
    if (page.status === "UNAVAILABLE" && (page.completeness !== "unavailable" || page.freshness !== "unknown" || page.entries.length !== 0 || page.unavailableReason === undefined)) return "unavailable discovery must have no entries and a typed reason"
    return undefined
  }))

/** Authenticated HostKernel read for editor document synchronization. The body
 * contains no identity or workspace authority; Core supplies those out of band. */
export interface RepoDocumentReadRequestV1 extends Schema.Schema.Type<typeof RepoDocumentReadRequestV1> {}
export const RepoDocumentReadRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pathRef: RepoDocumentPathRef,
  /** Selects the authenticated revision domain. Discovery inventory revisions
   * include no-follow symlink metadata; workspace revisions retain the stricter
   * mutation/checkpoint digest. The host never infers or downgrades this mode. */
  revisionKind: Schema.Literals(["workspace", "discovery_observation"]),
  expectedWorkspaceRevision: Composition.Digest,
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_REPO_DOCUMENT_BYTES })),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoDocumentReadRequestV1" })

export interface RepoDocumentReadResponseV1 extends Schema.Schema.Type<typeof RepoDocumentReadResponseV1> {}
export const RepoDocumentReadResponseV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("OK"),
  pathRef: RepoDocumentPathRef,
  revisionKind: Schema.Literals(["workspace", "discovery_observation"]),
  // The request is byte-bounded by MAX_REPO_DOCUMENT_BYTES and Core rechecks the
  // UTF-8 byte length. This character ceiling also rejects obviously oversized
  // hostile responses before they can flow into an LSP frame.
  text: Schema.String.check(Schema.isMaxLength(MAX_REPO_DOCUMENT_BYTES)),
  contentDigest: Composition.Digest,
  observedWorkspaceRevision: Composition.Digest,
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoDocumentReadResponseV1" })

/** Digest algorithm used by HostKernel for the exact UTF-8 document bytes. */
export const repoDocumentContentDigest = (text: string): Composition.Digest => {
  const digest = blake3(new TextEncoder().encode(text))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return Composition.Digest.make(`blake3:${hex}`)
}

/** Must match Guard::location_principal_binding for response-pin comparison. */
export const repoDiscoveryPrincipalBinding = (subject: string): string => {
  const encoder = new TextEncoder()
  const subjectBytes = encoder.encode(subject)
  const prefix = encoder.encode("horizoncode.location-owner-binding.v1\0")
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(subjectBytes.byteLength), false)
  const digest = blake3(new Uint8Array([...prefix, ...length, ...subjectBytes]))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `blake3:${hex}`
}
