/**
 * Authenticated, bounded Git reads through the shared HostKernel supervisor.
 * This adapter intentionally does not make the context-free GitV2 API spawn
 * processes; startup/migration callers without a trusted Location stay closed.
 */
import { Effect } from "effect"
import type { Location as LocationSchema } from "@horizoncode/schema"
import type { DirectSessionWorkspaceSnapshotV1 } from "./session/supervisor"
import { TrustedPrincipalContext } from "./trusted-principal"

const DIGEST = /^blake3:[0-9a-f]{64}$/
const MAX_OUTPUT_BYTES = 1_048_576

export type GitReadOperationV1 =
  | { readonly kind: "status"; readonly includeUntracked: boolean }
  | {
      readonly kind: "diff"
      readonly baseOID?: string
      readonly targetOID?: string
      readonly paths: ReadonlyArray<string>
      readonly contextLines: number
    }
  | { readonly kind: "log"; readonly revision: string; readonly limit: number }

export type GitReadResultV1 = {
  readonly operationID: string
  readonly locationID: string
  readonly sessionID: string | null
  readonly workspaceRevision: string
  readonly operationDigest: string
  readonly exitCode: number
  readonly output: Uint8Array
  readonly receiptDigest: string
}

function validOperation(operation: GitReadOperationV1): boolean {
  const oid = (value: string) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
  const path = (value: string) => value.length > 0 && value.length <= 4096 &&
    !value.includes("\\") && !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  switch (operation.kind) {
    case "status":
      return typeof operation.includeUntracked === "boolean"
    case "diff":
      return (operation.baseOID === undefined || oid(operation.baseOID)) &&
        (operation.targetOID === undefined || oid(operation.targetOID)) &&
        Array.isArray(operation.paths) && operation.paths.length <= 64 &&
        operation.paths.every(path) && Number.isInteger(operation.contextLines) &&
        operation.contextLines >= 0 && operation.contextLines <= 100
    case "log":
      return oid(operation.revision) && Number.isInteger(operation.limit) &&
        operation.limit >= 1 && operation.limit <= 100
  }
}

function decodeResult(
  value: Readonly<Record<string, unknown>>,
  locationID: string,
  sessionID: string | null,
  workspaceRevision: string,
): GitReadResultV1 {
  const keys = [
    "status", "operationID", "locationID", "sessionID", "workspaceRevision",
    "operationDigest", "exitCode", "outputBase64", "truncated", "receiptDigest",
  ].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0") ||
    value.status !== "SETTLED" || value.locationID !== locationID ||
    value.sessionID !== sessionID || value.workspaceRevision !== workspaceRevision ||
    typeof value.operationID !== "string" || !/^xexec_[A-Za-z0-9_-]{1,128}$/.test(value.operationID) ||
    typeof value.operationDigest !== "string" || !DIGEST.test(value.operationDigest) ||
    typeof value.receiptDigest !== "string" || !DIGEST.test(value.receiptDigest) ||
    !Number.isInteger(value.exitCode) || (value.exitCode as number) < 0 || (value.exitCode as number) > 255 ||
    typeof value.outputBase64 !== "string" || typeof value.truncated !== "boolean" || value.truncated) {
    throw new Error("HostKernel returned an invalid Git read receipt")
  }
  const output = Buffer.from(value.outputBase64, "base64")
  if (output.byteLength > MAX_OUTPUT_BYTES || output.toString("base64") !== value.outputBase64) {
    throw new Error("HostKernel Git output is malformed or exceeds its bound")
  }
  return {
    operationID: value.operationID,
    locationID,
    sessionID,
    workspaceRevision,
    operationDigest: value.operationDigest,
    exitCode: value.exitCode as number,
    output,
    receiptDigest: value.receiptDigest,
  }
}

/** Perform one fixed Git operation at the exact authenticated workspace revision. */
export const readGit = Effect.fn("GitHostRead.read")(function* (input: {
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly sessionID?: string
  readonly operation: GitReadOperationV1
}) {
  if (!validOperation(input.operation) ||
    (input.sessionID !== undefined && !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID))) {
    return yield* Effect.fail(new Error("Git read request is invalid or outside its bounds"))
  }
  // git-host is re-exported by git.ts, which is also consumed by project.ts.
  // Loading SessionSupervisor statically here creates a cycle through
  // supervisor.ts -> event.ts -> location.ts -> project.ts -> git.ts.
  // Resolve the service tag only when a guarded Git read is actually invoked.
  const { Service: SessionSupervisor } = yield* Effect.promise(() => import("./session/supervisor"))
  const supervisor = yield* SessionSupervisor
  const trusted = yield* TrustedPrincipalContext
  if (trusted.principal.kind !== "server_auth") {
    return yield* Effect.fail(new Error("Guarded Git reads require authenticated ServerAuth"))
  }
  const locationID = yield* supervisor.registerHostLocation(input.locationRef)
  let workspaceRevision: string
  if (input.sessionID) {
    const snapshot: DirectSessionWorkspaceSnapshotV1 = yield* supervisor.directSessionWorkspaceSnapshot({
      sessionID: input.sessionID,
      locationRef: input.locationRef,
    })
    workspaceRevision = snapshot.workspaceRevision
  } else {
    const snapshot = yield* supervisor.requestHostKernel("execution.v1", "workspace_read_snapshot", {
      locationID,
    }, { trustedPrincipal: trusted.principal })
    if (Object.keys(snapshot).toSorted().join("\0") !== [
      "locationID", "workspaceID", "ownerEpoch", "workspaceRevision", "workspaceRootDigest", "observedAtUnixMs",
    ].toSorted().join("\0") || snapshot.locationID !== locationID ||
      typeof snapshot.workspaceID !== "string" || snapshot.workspaceID.length === 0 ||
      typeof snapshot.ownerEpoch !== "string" || !/^[1-9][0-9]{0,19}$/.test(snapshot.ownerEpoch) ||
      typeof snapshot.workspaceRevision !== "string" || !DIGEST.test(snapshot.workspaceRevision) ||
      typeof snapshot.workspaceRootDigest !== "string" || !DIGEST.test(snapshot.workspaceRootDigest) ||
      typeof snapshot.observedAtUnixMs !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(snapshot.observedAtUnixMs)) {
      return yield* Effect.fail(new Error("HostKernel returned an invalid workspace read snapshot"))
    }
    workspaceRevision = snapshot.workspaceRevision
  }
  const response = yield* supervisor.requestHostKernel("execution.v1", "git_read", {
    locationID,
    ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
    expectedWorkspaceRevision: workspaceRevision,
    operation: input.operation,
  }, { trustedPrincipal: trusted.principal, cancelOnInterrupt: true })
  return yield* Effect.try({
    try: () => decodeResult(response, locationID, input.sessionID ?? null, workspaceRevision),
    catch: (cause) => cause instanceof Error ? cause : new Error("HostKernel Git read response is invalid"),
  })
})
