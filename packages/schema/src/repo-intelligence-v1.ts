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
  maxResults: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoQueryV1" })

export interface RepoQueryResultV1 extends Schema.Schema.Type<typeof RepoQueryResultV1> {}
export const RepoQueryResultV1 = Schema.Struct({
  queryId: Schema.String.check(Schema.isNonEmpty()),
  status: Schema.Literals(["CURRENT", "STALE", "PARTIAL", "UNAVAILABLE"]),
  generationIds: Schema.Array(RepoGenerationId),
  results: Schema.Array(Composition.ArtifactRef),
  nextCursor: optional(Schema.String),
}).annotate({ identifier: "Horizon.RepoIntelligenceV1.RepoQueryResultV1" })
