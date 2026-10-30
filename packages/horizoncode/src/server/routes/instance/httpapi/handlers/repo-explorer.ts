import { randomUUID } from "node:crypto"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import * as RepoIntel from "@horizoncode/schema/repo-intelligence-v1"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { RepoExplorerForbiddenError, RepoExplorerUnavailableError } from "../groups/repo-explorer"

const MAX_ENTRIES = 256
const MAX_BYTES = RepoIntel.MAX_REPO_DISCOVERY_BYTES
const MAX_DOCUMENT_BYTES = RepoIntel.MAX_REPO_DOCUMENT_BYTES

const mapHostError = (error: SessionSupervisorError) => {
  const data = { code: error.hostCode ?? error.stage, reason: error.reason.slice(0, 512) }
  if (error.stage === "authorization" || error.stage === "host-kernel-feature" && error.reason.includes("principal")) {
    return new RepoExplorerForbiddenError({ name: "RepoExplorerForbiddenError", data })
  }
  return new RepoExplorerUnavailableError({ name: "RepoExplorerUnavailableError", data })
}

export const repoExplorerHandlers = HttpApiBuilder.group(InstanceHttpApi, "repoExplorer", (handlers) =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service

    const trustedLocation = Effect.fnUntraced(function* () {
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(principal) || principal.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(new RepoExplorerForbiddenError({
          name: "RepoExplorerForbiddenError",
          data: { code: "authorization", reason: "Explorer requires authenticated ServerAuth" },
        }))
      }
      const instance = yield* InstanceState.context
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      return { principal: principal.value, locationRef }
    })

    const discover = Effect.fn("RepoExplorerHttpApi.discover")(function* (input: {
      sessionID: string
      rootRef: string
      maxDepth: number
    }) {
      const scope = yield* trustedLocation()
      if (!supervisor.discoverRepo) {
        return yield* new RepoExplorerUnavailableError({
          name: "RepoExplorerUnavailableError",
          data: { code: "capability_unavailable", reason: "authenticated HostKernel discovery is unavailable" },
        })
      }
      const request = Schema.decodeUnknownSync(RepoIntel.RepoDiscoveryRequestV1)({
        schemaVersion: 1,
        messageType: "discover",
        requestId: `explorer-${randomUUID()}`,
        rootRef: input.rootRef,
        mode: "tree",
        maxEntries: MAX_ENTRIES,
        maxBytes: MAX_BYTES,
        maxDepth: input.maxDepth,
        deadline: new Date(Date.now() + 15_000).toISOString(),
      })
      return yield* supervisor.discoverRepo({ sessionID: input.sessionID, locationRef: scope.locationRef, request })
        .pipe(Effect.provideService(TrustedPrincipalContext, scope.principal), Effect.mapError(mapHostError))
    })

    const read = Effect.fn("RepoExplorerHttpApi.read")(function* (input: {
      sessionID: string
      pathRef: string
      sourceRevision: string
    }) {
      const scope = yield* trustedLocation()
      if (!supervisor.readRepoDocument) {
        return yield* new RepoExplorerUnavailableError({
          name: "RepoExplorerUnavailableError",
          data: { code: "capability_unavailable", reason: "authenticated HostKernel document reads are unavailable" },
        })
      }
      const request = Schema.decodeUnknownSync(RepoIntel.RepoDocumentReadRequestV1)({
        schemaVersion: 1,
        pathRef: input.pathRef,
        revisionKind: "discovery_observation",
        expectedWorkspaceRevision: input.sourceRevision,
        maxBytes: MAX_DOCUMENT_BYTES,
      })
      return yield* supervisor.readRepoDocument({ sessionID: input.sessionID, locationRef: scope.locationRef, request })
        .pipe(Effect.provideService(TrustedPrincipalContext, scope.principal), Effect.mapError(mapHostError))
    })

    return handlers
      .handle("repoExplorerDiscover", ({ payload }) => discover(payload))
      .handle("repoExplorerRead", ({ payload }) => read(payload))
  }),
)
