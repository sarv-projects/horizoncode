import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as RepoIntel from "@opencode-ai/schema/repo-intelligence-v1"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/experimental/repo-explorer"
const ID = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256), Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/))
const Digest = Schema.String.check(Schema.isPattern(/^blake3:[0-9a-f]{64}$/))
const RelativeRoot = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)).check(
  Schema.makeFilter((value) => {
    if (value === ".") return undefined
    if (value.startsWith("/") || value.includes("\\") || value.includes(":")) return "path must be normalized and relative"
    return value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
      ? "path must not contain empty, dot, or parent segments"
      : undefined
  }),
)

export class RepoExplorerForbiddenError extends Schema.ErrorClass<RepoExplorerForbiddenError>("RepoExplorerForbiddenError")(
  { name: Schema.Literal("RepoExplorerForbiddenError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 403 },
) {}
export class RepoExplorerUnavailableError extends Schema.ErrorClass<RepoExplorerUnavailableError>("RepoExplorerUnavailableError")(
  { name: Schema.Literal("RepoExplorerUnavailableError"), data: Schema.Struct({ code: Schema.String, reason: Schema.String }) },
  { httpApiStatus: 503 },
) {}

const Errors = [RepoExplorerForbiddenError, RepoExplorerUnavailableError] as const
const DiscoverRequest = Schema.Struct({
  sessionID: ID,
  rootRef: RelativeRoot,
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
})
const ReadRequest = Schema.Struct({
  sessionID: ID,
  pathRef: RelativeRoot.check(Schema.makeFilter((value) => value === "." ? "path must name a file" : undefined)),
  sourceRevision: Digest,
})

export const RepoExplorerApi = HttpApi.make("repo-explorer")
  .add(
    HttpApiGroup.make("repoExplorer")
      .add(
        HttpApiEndpoint.post("repoExplorerDiscover", `${root}/discover`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: DiscoverRequest,
          success: described(RepoIntel.RepoDiscoveryPageV1, "Bounded no-follow repository inventory from authenticated HostKernel discovery"),
          error: Errors,
        }),
        HttpApiEndpoint.post("repoExplorerRead", `${root}/read`, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: ReadRequest,
          success: described(RepoIntel.RepoDocumentReadResponseV1, "Bounded exact-revision document text from HostKernel"),
          error: Errors,
        }),
      )
      .annotateMerge(OpenApi.annotations({
        title: "repo-explorer",
        description: "User-invoked, read-only Explorer backed by authenticated HostKernel discovery and exact-revision document reads. Request bodies carry no principal, Location, policy, or filesystem authority.",
      }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
