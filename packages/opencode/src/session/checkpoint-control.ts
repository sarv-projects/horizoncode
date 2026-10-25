/** Authenticated, read-only Core projection of the Rust checkpoint journal. */
import { Effect, Schema } from "effect"
import type { TrustedPrincipal as TrustedPrincipalType } from "@opencode-ai/core/trusted-principal"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"

const SERVICE = "checkpoint.v1"
const ID = /^[A-Za-z0-9._-]{1,256}$/

export class CheckpointControlError extends Schema.TaggedErrorClass<CheckpointControlError>()(
  "CheckpointControlError",
  { operation: Schema.String, code: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Checkpoint control ${this.operation} failed (${this.code}): ${this.reason}`
  }
}

export type CheckpointScope = {
  readonly locationID: string
  readonly sessionID: string
  readonly trustedPrincipal: TrustedPrincipalType
}

function fail(operation: string, code: string, reason: string) {
  return new CheckpointControlError({ operation, code, reason })
}

function identifier(operation: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw fail(operation, "checkpoint_protocol", `${label} is invalid`)
  }
  return value
}

/** Mirror Rust's checkpoint relative-path contract before any preview reaches UI. */
function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function decodeIDs(operation: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned a malformed list")
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "checkpointIDs")) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned an unexpected list shape")
  }
  const checkpointIDs = value.checkpointIDs
  if (!Array.isArray(checkpointIDs) || checkpointIDs.length > 32) {
    throw fail(operation, "checkpoint_protocol", "checkpointIDs exceeds its item bound")
  }
  const result = checkpointIDs.map((item) => identifier(operation, item, "checkpointID"))
  if (new Set(result).size !== result.length) {
    throw fail(operation, "checkpoint_protocol", "checkpointIDs contains duplicates")
  }
  return result
}

const DIGEST = /^blake3:[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/
const MAX_U64 = 0xffff_ffff_ffff_ffffn

export type CheckpointPreviewV1 = {
  readonly checkpointID: string
  readonly checkpointArtifact: { readonly artifactID: string; readonly digest: string; readonly byteLength: string; readonly mediaType: string; readonly classification: "public" | "workspace" | "sensitive" }
  readonly workspaceRevision: string
  readonly workspaceRevisionChanged: boolean
  readonly mode: "FULL" | "SELECTED_PATHS"
  readonly selectedPaths: readonly string[]
  readonly actions: readonly { readonly path: string; readonly expectedBeforeDigest: string | null; readonly target: { readonly kind: "REGULAR_FILE"; readonly digest: string; readonly byteLength: number; readonly executable: boolean; readonly linkCount: 1 } }[]
  readonly conflicts: readonly { readonly path?: string; readonly kind: "WORKSPACE_REVISION_CHANGED" | "DIRTY_PATH" | "UNTRACKED_PATH" | "WORKSPACE_STATUS_UNAVAILABLE" | "UNSAFE_PATH" }[]
  readonly previewDigest: string
}

function decodePreview(operation: string, input: unknown): CheckpointPreviewV1 {
  const value = input as Record<string, unknown>
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).toSorted().join("\0") !== ["checkpointID", "checkpointArtifact", "workspaceRevision", "workspaceRevisionChanged", "mode", "selectedPaths", "actions", "conflicts", "previewDigest"].sort().join("\0")) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned an unexpected preview shape")
  }
  const artifact = value.checkpointArtifact as Record<string, unknown>
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact) ||
      Object.keys(artifact).toSorted().join("\0") !== ["artifactID", "digest", "byteLength", "mediaType", "classification"].sort().join("\0") ||
      typeof artifact.artifactID !== "string" || !ID.test(artifact.artifactID) ||
      typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest) ||
      typeof artifact.byteLength !== "string" || !DECIMAL.test(artifact.byteLength) || BigInt(artifact.byteLength) > MAX_U64 ||
      typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0 || artifact.mediaType.length > 256 ||
      typeof artifact.classification !== "string" || !["public", "workspace", "sensitive"].includes(artifact.classification)) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned invalid checkpoint artifact metadata")
  }
  if (typeof value.workspaceRevision !== "string" || !DIGEST.test(value.workspaceRevision) ||
      typeof value.workspaceRevisionChanged !== "boolean" || !["FULL", "SELECTED_PATHS"].includes(String(value.mode)) ||
      typeof value.previewDigest !== "string" || !DIGEST.test(value.previewDigest) ||
      !Array.isArray(value.selectedPaths) || value.selectedPaths.length > 2_048 ||
      !Array.isArray(value.actions) || value.actions.length > 2_048 ||
      !Array.isArray(value.conflicts) || value.conflicts.length > 2_048) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned invalid bounded preview metadata")
  }
  const selectedPaths = value.selectedPaths.map((path) => {
    if (!safeRelativePath(path)) throw fail(operation, "checkpoint_protocol", "HostKernel returned an invalid selected path")
    return path
  })
  if (selectedPaths.reduce((total, path) => total + Buffer.byteLength(path, "utf8"), 0) > 4 * 1024 * 1024 ||
      new Set(selectedPaths).size !== selectedPaths.length) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned duplicate or over-limit selected paths")
  }
  const actionPaths = new Set<string>()
  let actionPathBytes = 0
  const requestedPathSet = new Set(selectedPaths)
  const actions = value.actions.map((raw): CheckpointPreviewV1["actions"][number] => {
    const action = raw as Record<string, unknown>
    const target = action?.target as Record<string, unknown>
    if (typeof action !== "object" || action === null || Array.isArray(action) ||
        Object.keys(action).toSorted().join("\0") !== ["path", "expectedBeforeDigest", "target"].sort().join("\0") ||
        !safeRelativePath(action.path) ||
        !(action.expectedBeforeDigest === null || typeof action.expectedBeforeDigest === "string" && DIGEST.test(action.expectedBeforeDigest)) ||
        typeof target !== "object" || target === null || Array.isArray(target) ||
        Object.keys(target).toSorted().join("\0") !== ["kind", "digest", "byteLength", "executable", "linkCount"].sort().join("\0") ||
        target.kind !== "REGULAR_FILE" ||
        typeof target.digest !== "string" || !DIGEST.test(target.digest) ||
        typeof target.byteLength !== "number" || !Number.isSafeInteger(target.byteLength) || target.byteLength < 0 ||
        typeof target.executable !== "boolean" || target.linkCount !== 1) {
      throw fail(operation, "checkpoint_protocol", "HostKernel returned an invalid preview action")
    }
    if (actionPaths.has(action.path) || value.mode === "SELECTED_PATHS" && !requestedPathSet.has(action.path)) {
      throw fail(operation, "checkpoint_protocol", "HostKernel returned duplicate or out-of-scope preview actions")
    }
    actionPaths.add(action.path)
    actionPathBytes += Buffer.byteLength(action.path, "utf8")
    if (actionPathBytes > 4 * 1024 * 1024) {
      throw fail(operation, "checkpoint_protocol", "HostKernel preview action paths exceed their byte bound")
    }
    return { path: action.path, expectedBeforeDigest: typeof action.expectedBeforeDigest === "string" ? action.expectedBeforeDigest : null, target: {
      kind: "REGULAR_FILE" as const, digest: target.digest,
      byteLength: target.byteLength, executable: target.executable, linkCount: 1,
    } }
  })
  const allowedConflicts = ["WORKSPACE_REVISION_CHANGED", "DIRTY_PATH", "UNTRACKED_PATH", "WORKSPACE_STATUS_UNAVAILABLE", "UNSAFE_PATH"]
  let conflictPathBytes = 0
  const conflicts = value.conflicts.map((raw) => {
    const conflict = raw as Record<string, unknown>
    if (typeof conflict !== "object" || conflict === null || Array.isArray(conflict) ||
        Object.keys(conflict).toSorted().join("\0") !== ["path", "kind"].sort().join("\0") ||
        !(conflict.path === null || typeof conflict.path === "string" && conflict.path.length <= 4_096) ||
        !allowedConflicts.includes(String(conflict.kind))) {
      throw fail(operation, "checkpoint_protocol", "HostKernel returned an invalid preview conflict")
    }
    if (typeof conflict.path === "string") {
      conflictPathBytes += Buffer.byteLength(conflict.path, "utf8")
      if (conflictPathBytes > 4 * 1024 * 1024) {
        throw fail(operation, "checkpoint_protocol", "HostKernel preview conflict paths exceed their byte bound")
      }
    }
    return { ...(typeof conflict.path === "string" ? { path: conflict.path } : {}), kind: conflict.kind as CheckpointPreviewV1["conflicts"][number]["kind"] }
  })
  if (value.mode === "FULL" && selectedPaths.length !== 0 || value.mode === "SELECTED_PATHS" && selectedPaths.length === 0 ||
      conflicts.length > 0 && actions.length > 0) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned an inconsistent preview")
  }
  const revisionChangedConflict = conflicts.some((conflict) => conflict.kind === "WORKSPACE_REVISION_CHANGED")
  if (revisionChangedConflict && (!value.workspaceRevisionChanged || value.mode !== "FULL") ||
      value.mode === "FULL" && value.workspaceRevisionChanged && !revisionChangedConflict) {
    throw fail(operation, "checkpoint_protocol", "HostKernel returned inconsistent workspace revision state")
  }
  return {
    checkpointID: identifier(operation, value.checkpointID, "checkpointID"),
    checkpointArtifact: { artifactID: artifact.artifactID as string, digest: artifact.digest as string, byteLength: artifact.byteLength as string, mediaType: artifact.mediaType as string, classification: artifact.classification as CheckpointPreviewV1["checkpointArtifact"]["classification"] },
    workspaceRevision: value.workspaceRevision, workspaceRevisionChanged: value.workspaceRevisionChanged,
    mode: value.mode as "FULL" | "SELECTED_PATHS", selectedPaths, actions, conflicts, previewDigest: value.previewDigest,
  }
}

export const list = Effect.fn("CheckpointControl.list")(function* (scope: CheckpointScope) {
  const operation = "checkpoint.list"
  const locationID = identifier(operation, scope.locationID, "locationID")
  const sessionID = identifier(operation, scope.sessionID, "sessionID")
  const supervisor = yield* SessionSupervisor.Service
  const response = yield* supervisor.requestHostKernel(
    SERVICE,
    operation,
    { locationID, sessionID },
    { trustedPrincipal: scope.trustedPrincipal },
  ).pipe(Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
    Effect.fail(fail(operation, error.hostCode ?? "checkpoint_unavailable", error.reason)),
  ))
  return yield* Effect.try({
    try: () => ({ checkpointIDs: decodeIDs(operation, response) }),
    catch: (error) => error instanceof CheckpointControlError
      ? error
      : fail(operation, "checkpoint_protocol", "HostKernel returned a malformed list"),
  })
})

export const previewRestore = Effect.fn("CheckpointControl.previewRestore")(function* (
  scope: CheckpointScope,
  input: { readonly checkpointID: string; readonly mode: "FULL" | "SELECTED_PATHS"; readonly selectedPaths: readonly string[] },
) {
  const operation = "checkpoint.restore_preview"
  const locationID = identifier(operation, scope.locationID, "locationID")
  const sessionID = identifier(operation, scope.sessionID, "sessionID")
  const checkpointID = identifier(operation, input.checkpointID, "checkpointID")
  if (!Array.isArray(input.selectedPaths) || input.selectedPaths.length > 2_048 ||
      input.selectedPaths.some((path) => !safeRelativePath(path)) ||
      input.selectedPaths.reduce((total, path) => total + Buffer.byteLength(path, "utf8"), 0) > 4 * 1024 * 1024 ||
      new Set(input.selectedPaths).size !== input.selectedPaths.length ||
      input.mode === "FULL" && input.selectedPaths.length !== 0 ||
      input.mode === "SELECTED_PATHS" && input.selectedPaths.length === 0) {
    return yield* Effect.fail(fail(operation, "checkpoint_invalid", "preview selection exceeds its bounds or conflicts with its mode"))
  }
  const supervisor = yield* SessionSupervisor.Service
  const response = yield* supervisor.requestHostKernel(
    SERVICE, operation, { checkpointID, locationID, sessionID, mode: input.mode, selectedPaths: [...input.selectedPaths] },
    { trustedPrincipal: scope.trustedPrincipal },
  ).pipe(Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
    Effect.fail(fail(operation, error.hostCode ?? "checkpoint_unavailable", error.reason)),
  ))
  return yield* Effect.try({
    try: () => {
      const preview = decodePreview(operation, response)
      const requestedPaths = [...input.selectedPaths].toSorted()
      const returnedPaths = [...preview.selectedPaths].toSorted()
      if (preview.checkpointID !== checkpointID || preview.mode !== input.mode ||
          requestedPaths.length !== returnedPaths.length || requestedPaths.some((path, index) => path !== returnedPaths[index])) {
        throw fail(operation, "checkpoint_protocol", "HostKernel preview does not match the requested checkpoint and path selection")
      }
      return preview
    },
    catch: (error) => error instanceof CheckpointControlError ? error : fail(operation, "checkpoint_protocol", "HostKernel returned a malformed preview"),
  })
})
