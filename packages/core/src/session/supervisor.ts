/**
 * Effect-scoped client for the Rust Session supervisor.
 *
 * OpenCode owns Session rows, messages, provider continuation and EventV2. Rust
 * projects Session events and owns authorized ToolBatch effects, durable intents,
 * execution and settlement.
 */

import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createConnection, type Socket } from "node:net"
import { dirname, join } from "node:path"
import { Event as EventSchema, Location as LocationSchema } from "@opencode-ai/schema"
import { EventV2 } from "../event"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Schema, Stream } from "effect"
import type * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "../effect/layer-node"
import { Database } from "../database/database"
import { Global } from "../global"
import { TrustedPrincipalContext, type TrustedPrincipal } from "../trusted-principal"

import { AppProcess } from "../process"

declare const OPENCODE_SESSION_OBSERVER_ASSET: string
declare const OPENCODE_HOST_KERNEL_ASSET: string
declare const OPENCODE_HOST_KERNEL_MANIFEST: string

const PROTOCOL = 1
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_PENDING_BYTES = MAX_FRAME_BYTES * 2 + 8
const MAX_PENDING_MESSAGES = 128
const PAGE_CONTROL_FEATURE = "session.events.page-control.v1"
export const GuardApprovalRequested = EventSchema.define({
  type: "guard.approval.requested",
  schema: {
    approvalID: Schema.String,
    challengeID: Schema.String,
    effectID: Schema.String,
    capabilityID: Schema.String,
    locationID: Schema.String,
    sessionID: Schema.optional(Schema.String),
    inputDigest: Schema.String,
    normalizedTargets: Schema.Array(Schema.Unknown),
    expiresAtUnixMs: Schema.Finite,
    policySummary: Schema.String,
  },
})
export const GuardApprovalResolved = EventSchema.define({
  type: "guard.approval.resolved",
  schema: {
    approvalID: Schema.String,
    decision: Schema.Literals(["allow_once", "deny", "expired"]),
  },
})
const REQUIRED_FEATURES = ["session.events.v1", PAGE_CONTROL_FEATURE] as const
const REQUIRED_HOST_FEATURES = ["effects.v2", "terminal.v1"] as const
const BASE_DIGEST = `blake3:${"0".repeat(64)}`

export type Cursor = {
  readonly ownerKind: string
  readonly ownerId: string
  readonly seq: string
  readonly eventDigest: string
}

export type SessionEvent = {
  readonly kind: "event"
  readonly subscriptionId: string
  readonly cursor: Cursor
  readonly eventType: string
  readonly payload: unknown
}

export type PageEnd = {
  readonly kind: "page_end"
  readonly subscriptionId: string
  readonly through: Cursor
  readonly hasMore: boolean
}

export type ResnapshotRequired = {
  readonly kind: "resnapshot_required"
  readonly subscriptionId: string
  readonly requested: Cursor
  readonly latest: Cursor
}

export type GuardedToolCall = {
  readonly callID: string
  readonly capabilityID: string
  readonly arguments: unknown
}

export type EffectTarget = {
  readonly target: string
  readonly resource: string
  readonly operation: "write" | "delete"
  readonly existed: boolean
  readonly executable?: boolean
}

export type GuardApprovalDetails = {
  readonly capabilityID: string
  readonly locationID: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
}

export type EffectChallenge = {
  readonly challengeID: string
  readonly effectID: string
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly targets?: ReadonlyArray<EffectTarget>
  readonly approval?: GuardApprovalDetails
}

export type PatchOperation = {
  readonly operation: "write" | "delete"
  readonly path: string
  readonly expectedBeforeBase64: string | null
  readonly contentBase64?: string
  readonly executable?: boolean
}

export type PatchReceipt = {
  readonly effectID: string
  readonly receiptDigest: string
  readonly targets: ReadonlyArray<EffectTarget>
}

export type EffectLease = {
  readonly effectID: string
  readonly capabilityLeaseDigest: string
}

export type EffectAdmission =
  | { readonly status: "prepared"; readonly lease: EffectLease }
  | { readonly status: "admitted"; readonly challenge: EffectChallenge }
  | { readonly status: "denied"; readonly reason: string }
export type EffectReceipt = {
  readonly effectID: string
  readonly receiptDigest: string
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export type GuardApprovalDecision = "allow_once" | "deny"
export type GuardApprovalRequest = {
  readonly approvalID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: string
  readonly locationID: string
  readonly sessionID?: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
}
type PendingGuardApproval = {
  readonly request: GuardApprovalRequest
  readonly principal?: TrustedPrincipal
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly decision: Deferred.Deferred<GuardApprovalDecision, SessionSupervisorError>
}

export type HostKernelEvent = {
  readonly terminalID: string
  readonly generation: number
  readonly sequence: number
  readonly byteCursor: number
  readonly kind: string
  readonly payload: unknown
  readonly cursor: Cursor
  readonly eventType: string
}
export type ServerMessage = SessionEvent | PageEnd | ResnapshotRequired

export type OpenOptions = {
  /** Absolute path to the pinned `session_supervisor` binary. */
  readonly binary: string
  /** Existing OpenCode EventV2 database; Rust opens it read-only. */
  readonly source: string
  /** Private per-Session directory; this service creates it when absent. */
  readonly stateDirectory: string
  readonly sessionID: string
  readonly hostBuildDigest: string
  readonly startupTimeoutMs?: number
  /** Canonical root that bounds Rust-owned effects for this Session. */
  readonly workspaceRoot?: string
}

export type SessionSupervisorManifest =
  | {
      readonly schemaVersion: 1
      readonly status: "available"
      readonly binaryName: "session_supervisor"
      readonly target: string
      readonly sha256: string
    }
  | {
      readonly schemaVersion: 1
      readonly status: "unavailable"
      readonly target: string
      readonly reason: string
    }

export type HostKernelManifest =
  | {
      readonly schemaVersion: 1
      readonly status: "available"
      readonly binaryName: "hz-kernel"
      readonly target: string
      readonly sha256: string
    }
  | {
      readonly schemaVersion: 1
      readonly status: "unavailable"
      readonly target: string
      readonly reason: string
    }

export interface RuntimeConfigOptions {
  readonly assetPath?: string
  readonly manifestJSON?: string
  readonly installRoot: string
  readonly stateRoot: string
  readonly hostKernelAssetPath?: string
  readonly hostKernelManifestJSON?: string
  readonly hostKernelInstallRoot?: string
  readonly hostKernelStateRoot?: string
}

export type SessionSupervisorStart =
  | { readonly status: "available"; readonly client: SessionSupervisorClient }
  | { readonly status: "unavailable"; readonly reason: string }

export class RuntimeConfig extends Context.Service<RuntimeConfig, RuntimeConfigOptions>()(
  "@opencode/SessionSupervisorRuntime",
) {}

export class SessionSupervisorError extends Schema.TaggedErrorClass<SessionSupervisorError>()(
  "SessionSupervisorError",
  {
    stage: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Session supervisor ${this.stage} failed: ${this.reason}`
  }
}

export interface SessionSupervisorClient {
  readonly subscriptionId: string
  readonly resumeCursor: () => Promise<Cursor>
  readonly subscribe: (after?: Cursor) => Promise<void>
  readonly receive: () => Promise<ServerMessage>
  readonly ack: (event: SessionEvent) => Promise<void>
  readonly unsubscribe: () => Promise<void>
  readonly stop: () => Promise<void>
}

export interface Interface {
  /**
   * Acquire a child and authenticated channel in the caller's Effect scope. Scope close
   * sends Unsubscribe, closes the socket, and waits for the child before force termination.
   */
  readonly open: (options: OpenOptions) => Effect.Effect<SessionSupervisorClient, SessionSupervisorError, Scope.Scope>
  /** Resolve the bundled observer, install it privately and start one Session-owned process. */
  readonly openForSession: (
    sessionID: string,
    source: string,
    workspaceRoot?: string,
  ) => Effect.Effect<SessionSupervisorStart, SessionSupervisorError, Scope.Scope>
  readonly registerHostLocation: (locationRef: typeof LocationSchema.Ref.Type) => Effect.Effect<string, SessionSupervisorError>
  readonly prepareUserEffect: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly sessionID?: string
    readonly capabilityID: "terminal.start" | "terminal.run"
    readonly arguments: Readonly<Record<string, unknown>>
  }) => Effect.Effect<EffectLease & { readonly locationID: string }, SessionSupervisorError, TrustedPrincipalContext>
  readonly replyGuardApproval: (input: {
    readonly approvalID: string
    readonly decision: GuardApprovalDecision
  }) => Effect.Effect<void, SessionSupervisorError, TrustedPrincipalContext>
  readonly prepareToolBatch: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly batchID: string
    readonly turnContextDigest: string
    readonly calls: ReadonlyArray<GuardedToolCall>
  }) => Effect.Effect<EffectAdmission, SessionSupervisorError>
  readonly executeWrite: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly lease: EffectLease
    readonly content: string
  }) => Effect.Effect<EffectReceipt, SessionSupervisorError>
  readonly executePatch: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly lease: EffectLease
    readonly operations: ReadonlyArray<PatchOperation>
  }) => Effect.Effect<PatchReceipt, SessionSupervisorError>
  readonly runPatch: (input: {
    readonly sessionID: string
    readonly workspaceRoot: string
    readonly turnContextDigest: string
    readonly operations: ReadonlyArray<PatchOperation>
  }) => Effect.Effect<PatchReceipt, SessionSupervisorError>
  /** Host-only authenticated RPC; never routes through a Session projection worker. */
  readonly requestHostKernel: (
    serviceID: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError>
  readonly hostOwnerEpoch: () => Effect.Effect<number, SessionSupervisorError>
  /** Subscribe to terminal events over the host connection with bounded backpressure. */
  readonly subscribeHostKernelEvents: (input: {
    readonly terminalID: string
    readonly generation: number
    readonly after: Cursor
    readonly capacity?: number
  }) => Stream.Stream<HostKernelEvent, SessionSupervisorError>
  /** Keep one observer alive for the active provider turn and recover transport restarts. */
  readonly watchSession: (
    sessionID: string,
    source: string,
    workspaceRoot: string,
    turnComplete: Ref.Ref<boolean>,
    ready: Deferred.Deferred<void, SessionSupervisorError>,
  ) => Effect.Effect<void, SessionSupervisorError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSupervisor") {}

function fail(stage: string, reason: string) {
  return new SessionSupervisorError({ stage, reason })
}

// Nested scopes from one backend share a lease; a second backend fails closed.
export type ExecutionOwnerKind = "core-v2" | "opencode-v1"
const activeExecutionOwners = new Map<string, { kind: ExecutionOwnerKind; count: number }>()
export const acquireExecutionOwner = Effect.fn("SessionSupervisor.acquireExecutionOwner")(function* (
  sessionID: string,
  kind: ExecutionOwnerKind,
) {
  yield* Effect.acquireRelease(
    Effect.suspend(() => {
      const current = activeExecutionOwners.get(sessionID)
      if (current && current.kind !== kind) {
        return Effect.fail(fail("ownership", "another execution already owns this Session"))
      }
      if (current) current.count += 1
      else activeExecutionOwners.set(sessionID, { kind, count: 1 })
      return Effect.void
    }),
    () =>
      Effect.sync(() => {
        const current = activeExecutionOwners.get(sessionID)
        if (!current || current.kind !== kind) return
        if (current.count > 1) current.count -= 1
        else activeExecutionOwners.delete(sessionID)
      }),
  )
})

function parseManifest(input: string): SessionSupervisorManifest {
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(input))
  } catch {
    throw fail("manifest", "embedded observer manifest is malformed")
  }
  if (value.schemaVersion !== 1 || typeof value.status !== "string" || typeof value.target !== "string") {
    throw fail("manifest", "embedded observer manifest has an unsupported shape")
  }
  if (value.status === "unavailable") {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      throw fail("manifest", "unavailable observer manifest must include a reason")
    }
    return {
      schemaVersion: 1,
      status: "unavailable",
      target: value.target,
      reason: value.reason,
    }
  }
  if (
    value.status !== "available" ||
    value.binaryName !== "session_supervisor" ||
    !/^linux-(x64|arm64)-gnu$/.test(value.target) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw fail("manifest", "available observer manifest is invalid")
  }
  return {
    schemaVersion: 1,
    status: "available",
    binaryName: "session_supervisor",
    target: value.target,
    sha256: value.sha256,
  }
}

function parseHostKernelManifest(input: string): HostKernelManifest {
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(input))
  } catch {
    throw fail("manifest", "embedded host-kernel manifest is malformed")
  }
  if (value.schemaVersion !== 1 || typeof value.status !== "string" || typeof value.target !== "string") {
    throw fail("manifest", "embedded host-kernel manifest has an unsupported shape")
  }
  if (value.status === "unavailable") {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      throw fail("manifest", "unavailable host-kernel manifest must include a reason")
    }
    return { schemaVersion: 1, status: "unavailable", target: value.target, reason: value.reason }
  }
  if (
    value.status !== "available" ||
    value.binaryName !== "hz-kernel" ||
    !/^linux-(x64|arm64)-gnu$/.test(value.target) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw fail("manifest", "available host-kernel manifest is invalid")
  }
  return {
    schemaVersion: 1,
    status: "available",
    binaryName: "hz-kernel",
    target: value.target,
    sha256: value.sha256,
  }
}

function ensurePrivateDirectory(path: string, stage: string) {
  if (!path.startsWith("/")) throw fail(stage, "directory path must be absolute")
  const parentPath = dirname(path)
  try {
    const parent = lstatSync(parentPath)
    if (
      realpathSync(parentPath) !== parentPath ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.getuid && parent.uid !== process.getuid()) ||
      (parent.mode & 0o022) !== 0
    ) {
      throw fail(stage, "directory parent is not owned and protected")
    }
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
    }
    const stat = lstatSync(path)
    if (
      realpathSync(path) !== path ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    ) {
      throw fail(stage, "directory must be owner-only and non-symlinked")
    }
  } catch (error) {
    if (error instanceof SessionSupervisorError) throw error
    throw fail(stage, "directory is unavailable or unsafe")
  }
  return path
}

function sessionStateDirectory(stateRoot: string, sessionID: string) {
  const root = ensurePrivateDirectory(stateRoot, "state")
  return ensurePrivateDirectory(
    join(root, `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`),
    "state",
  )
}

function resetSessionObserverMetadata(stateRoot: string, sessionID: string) {
  const stateDirectory = sessionStateDirectory(stateRoot, sessionID)
  const files = [
    "session-projection.sqlite",
    "session-projection.sqlite-wal",
    "session-projection.sqlite-shm",
    "session-projection.sqlite-journal",
    `session-${sessionID}.cursor`,
  ]
  for (const name of files) {
    const filePath = join(stateDirectory, name)
    try {
      const stat = lstatSync(filePath)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 ||
        realpathSync(filePath) !== filePath
      ) {
        throw fail("resnapshot", "observer metadata is not a private regular file")
      }
      unlinkSync(filePath)
    } catch (error) {
      if (error instanceof SessionSupervisorError) throw error
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw fail("resnapshot", "observer metadata could not be safely reset")
      }
    }
  }
  const directory = openSync(stateDirectory, "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

async function installBundledBinary(
  assetPath: string,
  expectedDigest: string,
  installRoot: string,
  binaryName = "session_supervisor",
): Promise<string> {
  const bytes = await Bun.file(assetPath).bytes()
  const actualDigest = createHash("sha256").update(bytes).digest("hex")
  if (actualDigest !== expectedDigest) throw fail("pin", "embedded observer does not match its SHA-256 manifest")

  ensurePrivateDirectory(installRoot, "install")
  const target = join(installRoot, `${binaryName}-${expectedDigest}`)
  const verify = () => {
    const stat = lstatSync(target)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 ||
      (stat.mode & 0o100) === 0 ||
      stat.size !== bytes.length ||
      realpathSync(target) !== target ||
      createHash("sha256").update(readFileSync(target)).digest("hex") !== expectedDigest
    ) {
      throw fail("install", "installed observer is not the pinned owner-only executable")
    }
    return target
  }
  if (existsSync(target)) return verify()

  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    const descriptor = openSync(temporary, "wx", 0o700)
    try {
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    try {
      linkSync(temporary, target)
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
    }
  } catch (error) {
    if (error instanceof SessionSupervisorError) throw error
    throw fail("install", "could not atomically install the pinned observer")
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
  return verify()
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail("protocol", "message must be a map")
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string, maxBytes = 256): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0 || Buffer.byteLength(field, "utf8") > maxBytes) {
    throw fail("protocol", `invalid ${key}`)
  }
  return field
}

function parseCapabilityLease(value: Record<string, unknown>): EffectLease {
  const effectID = stringField(value, "effectID")
  const capabilityLeaseDigest = stringField(value, "capabilityLeaseDigest")
  if (!/^blake3:[0-9a-f]{64}$/.test(capabilityLeaseDigest)) {
    throw fail("protocol", "host returned an invalid capability lease digest")
  }
  return { effectID, capabilityLeaseDigest }
}
function parseEffectTargets(value: unknown, requireExecutableMode = false): EffectTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw fail("protocol", "invalid effect target set")
  }
  const paths = new Set<string>()
  return value.map((item) => {
    const target = record(item)
    if (
      ("executable" in target && typeof target.executable !== "boolean") ||
      (target.operation === "delete" && "executable" in target)
    ) {
      throw fail("protocol", "invalid effect target executable mode")
    }
    const parsed = {
      target: stringField(target, "target", 4096),
      resource: stringField(target, "resource", 4096),
      operation: target.operation,
      existed: target.existed,
      ...(typeof target.executable === "boolean" ? { executable: target.executable } : {}),
    }
    if (
      (requireExecutableMode && parsed.operation === "write" && typeof parsed.executable !== "boolean") ||
      paths.has(parsed.target) ||
      (parsed.operation !== "write" && parsed.operation !== "delete") ||
      typeof parsed.existed !== "boolean"
    ) {
      throw fail("protocol", "invalid effect target")
    }
    paths.add(parsed.target)
    return parsed as EffectTarget
  })
}
function canonicalBase64Length(value: string) {
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value) throw fail("effect", "files.patch contains non-canonical base64")
  return decoded.byteLength
}

function validatePatchOperations(value: unknown): asserts value is ReadonlyArray<PatchOperation> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw fail("effect", "files.patch operation count is invalid")
  }
  const paths = new Set<string>()
  let totalBytes = 0
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw fail("effect", "files.patch operation is invalid")
    }
    const operation = raw as Record<string, unknown>
    if (
      Object.keys(operation).some(
        (key) => !["operation", "path", "expectedBeforeBase64", "contentBase64", "executable"].includes(key),
      ) ||
      (operation.operation !== "write" && operation.operation !== "delete") ||
      typeof operation.path !== "string" ||
      operation.path.length === 0 ||
      !("expectedBeforeBase64" in operation) ||
      (operation.expectedBeforeBase64 !== null && typeof operation.expectedBeforeBase64 !== "string")
    ) {
      throw fail("effect", "files.patch operation fields are invalid")
    }
    if (paths.has(operation.path)) throw fail("effect", "files.patch paths must be unique")
    paths.add(operation.path)
    if (operation.expectedBeforeBase64 !== null) {
      const length = canonicalBase64Length(operation.expectedBeforeBase64 as string)
      if (length > 2 * 1024 * 1024) throw fail("effect", "files.patch preimage exceeds the per-file limit")
      totalBytes += length
    }
    if (operation.operation === "write") {
      if (
        typeof operation.contentBase64 !== "string" ||
        (operation.executable !== undefined && typeof operation.executable !== "boolean")
      ) {
        throw fail("effect", "files.patch write fields are invalid")
      }
      const length = canonicalBase64Length(operation.contentBase64)
      if (length > 2 * 1024 * 1024) throw fail("effect", "files.patch postimage exceeds the per-file limit")
      totalBytes += length
    } else if (operation.expectedBeforeBase64 === null || "contentBase64" in operation || "executable" in operation) {
      throw fail("effect", "files.patch delete fields are invalid")
    }
    if (totalBytes > 4 * 1024 * 1024) throw fail("effect", "files.patch bytes exceed the total limit")
  }
}

function cursor(value: unknown): Cursor {
  const item = record(value)
  const ownerKind = stringField(item, "ownerKind")
  const ownerId = stringField(item, "ownerId")
  const seq = stringField(item, "seq")
  const eventDigest = stringField(item, "eventDigest")
  if (!/^(0|[1-9][0-9]*)$/.test(seq) || !/^blake3:[0-9a-f]{64}$/.test(eventDigest)) {
    throw fail("protocol", "invalid cursor encoding")
  }
  return { ownerKind, ownerId, seq, eventDigest }
}

function sameCursor(left: Cursor, right: Cursor) {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.seq === right.seq &&
    left.eventDigest === right.eventDigest
  )
}

function baseCursor(sessionID: string): Cursor {
  return {
    ownerKind: "session",
    ownerId: sessionID,
    seq: "0",
    eventDigest: BASE_DIGEST,
  }
}

function readCheckpoint(path: string, sessionID: string): Cursor {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return baseCursor(sessionID)
    }
    throw fail("checkpoint", "cannot inspect the acknowledged cursor")
  }
  const uid = process.getuid?.()
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 2048
  ) {
    throw fail("checkpoint", "acknowledged cursor file is unsafe")
  }
  try {
    const decoded = cursor(JSON.parse(readFileSync(path, "utf8")))
    if (decoded.ownerKind !== "session" || decoded.ownerId !== sessionID) {
      throw fail("checkpoint", "acknowledged cursor belongs to another Session")
    }
    return decoded
  } catch (error) {
    throw error instanceof SessionSupervisorError ? error : fail("checkpoint", "acknowledged cursor is malformed")
  }
}

function writeCheckpoint(path: string, value: Cursor) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 })
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    try {
      unlinkSync(temporary)
    } catch {}
    throw fail("checkpoint", "could not persist acknowledged cursor")
  }
}

type DecodedRpcResponse =
  | { readonly requestID: string; readonly outcome: "ok"; readonly body: Record<string, unknown> }
  | { readonly requestID: string; readonly outcome: "error"; readonly message: string }

function decodeRpcResponse(input: unknown): DecodedRpcResponse {
  const response = record(input)
  if (response.kind !== "response" || response.protocol !== PROTOCOL)
    throw fail("protocol", "incompatible RPC response")
  const requestID = stringField(response, "requestId")
  if (response.outcome === "error") {
    const error = record(response.error)
    return { requestID, outcome: "error", message: stringField(error, "message") }
  }
  if (response.outcome !== "ok") throw fail("protocol", "RPC response has an invalid outcome")
  return { requestID, outcome: "ok", body: record(response.body) }
}
type PendingRpc = {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: SessionSupervisorError) => void
  readonly timer: NodeJS.Timeout
}

function decodeServerMessage(input: unknown): ServerMessage {
  const message = record(input)
  const kind = stringField(message, "kind")
  if (kind === "event") {
    if (message.protocol !== PROTOCOL) throw fail("protocol", "incompatible event protocol")
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      cursor: cursor(message.cursor),
      eventType: stringField(message, "eventType"),
      payload: message.payload,
    }
  }
  if (kind === "page_end") {
    if (typeof message.hasMore !== "boolean") throw fail("protocol", "invalid page boundary")
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      through: cursor(message.through),
      hasMore: message.hasMore,
    }
  }
  if (kind === "resnapshot_required") {
    const requested = cursor(message.requested)
    const latest = cursor(message.latest)
    if (requested.ownerKind !== latest.ownerKind || requested.ownerId !== latest.ownerId) {
      throw fail("protocol", "resnapshot cursors do not share an owner")
    }
    return {
      kind,
      subscriptionId: stringField(message, "subscriptionId"),
      requested,
      latest,
    }
  }
  throw fail("protocol", "unexpected server message")
}

class MessageChannel {
  #socket: Socket
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #messages: Array<{ value: unknown; bytes: number }> = []
  #messageBytes = 0
  #waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  #closed: Error | undefined

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on("data", (chunk: Buffer) => this.#onData(chunk))
    socket.on("error", (error) => this.#close(fail("transport", error.message)))
    socket.on("end", () => this.#close(fail("transport", "peer closed the channel")))
    socket.on("close", () => this.#close(fail("transport", "channel closed")))
  }

  async send(value: Record<string, unknown>) {
    if (this.#closed) throw this.#closed
    const payload = Buffer.from(pack(value))
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
      throw fail("transport", "outgoing frame exceeds the protocol limit")
    }
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, (error) => (error ? reject(fail("transport", error.message)) : resolve()))
    })
  }

  async receive() {
    if (this.#messages.length > 0) {
      const message = this.#messages.shift()!
      this.#messageBytes -= message.bytes
      return message.value
    }
    if (this.#closed) throw this.#closed
    const value = await new Promise<unknown>((resolve, reject) => this.#waiters.push({ resolve, reject }))
    return value
  }

  end() {
    this.#socket.end()
  }
  isClosed() {
    return this.#closed !== undefined
  }

  destroy() {
    this.#socket.destroy()
  }

  #onData(chunk: Buffer) {
    if (this.#closed) return
    if (this.#buffer.length + chunk.length > MAX_PENDING_BYTES) {
      this.#close(fail("transport", "peer exceeded the bounded receive window"))
      this.#socket.destroy()
      return
    }
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.#close(fail("transport", "incoming frame exceeds the protocol limit"))
        this.#socket.destroy()
        return
      }
      if (this.#buffer.length < length + 4) return
      const payload = this.#buffer.subarray(4, length + 4)
      this.#buffer = this.#buffer.subarray(length + 4)
      let value: unknown
      try {
        value = unpack(payload)
      } catch {
        this.#close(fail("protocol", "invalid MessagePack payload"))
        this.#socket.destroy()
        return
      }
      const waiter = this.#waiters.shift()
      if (waiter) waiter.resolve(value)
      else {
        if (this.#messages.length >= MAX_PENDING_MESSAGES || this.#messageBytes + length > MAX_PENDING_BYTES) {
          this.#close(fail("transport", "peer exceeded the bounded message queue"))
          this.#socket.destroy()
          return
        }
        this.#messages.push({ value, bytes: length })
        this.#messageBytes += length
      }
    }
  }

  #close(error: Error) {
    if (this.#closed) return
    this.#closed = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

function validateStateDirectory(path: string) {
  if (!path.startsWith("/")) throw fail("configuration", "state directory must be absolute")
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    canonical = realpathSync(path)
  }
  if (canonical !== path) throw fail("configuration", "state directory must be canonical")
  const stat = lstatSync(path)
  const uid = process.getuid?.()
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw fail("configuration", "state directory must be owner-only and non-symlinked")
  }
  return canonical
}

function validateSocketPath(path: string) {
  if (Buffer.byteLength(path, "utf8") >= 108) throw fail("configuration", "Unix socket path is too long")
  if (existsSync(path)) throw fail("configuration", "refusing to replace an existing socket path")
}

function waitForSocket(path: string, child: ChildProcessHandle, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  return new Promise<void>((resolve, reject) => {
    const inspect = async () => {
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"))
      if (Date.now() >= deadline) return reject(fail("startup", "timed out waiting for the supervisor socket"))
      try {
        const stat = lstatSync(path)
        if (
          !stat.isSocket() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid())
        ) {
          return reject(fail("authentication", "supervisor socket permissions or owner are invalid"))
        }
        return resolve()
      } catch {
        const running = await Effect.runPromise(child.isRunning).catch(() => false)
        if (!running) return reject(fail("startup", "supervisor exited before binding its socket"))
        setTimeout(inspect, 20)
      }
    }
    inspect()
  })
}

function connectSocket(path: string, signal: AbortSignal, timeoutMs: number) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => finish(fail("startup", "timed out connecting to supervisor")), timeoutMs)
    const abort = () => finish(fail("startup", "supervisor startup was cancelled"))
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      socket.removeListener("connect", connected)
      socket.removeListener("error", failed)
      if (error) {
        socket.destroy()
        reject(error)
      } else resolve(socket)
    }
    const connected = () => finish()
    const failed = (error: Error) => finish(fail("transport", error.message))
    signal.addEventListener("abort", abort, { once: true })
    socket.once("connect", connected)
    socket.once("error", failed)
  })
}

function validateHelloResult(
  input: unknown,
  nonce: string,
  incarnation: string,
  requiredFeatures: ReadonlyArray<string>,
): number {
  const message = record(input)
  if (message.kind !== "hello_result" || message.protocol !== PROTOCOL) {
    throw fail("handshake", "kernel returned an incompatible Hello result")
  }
  if (message.supervisorNonce !== nonce || message.processIncarnation !== incarnation) {
    throw fail("handshake", "kernel Hello result did not bind to this child and host incarnation")
  }
  const enabledFeatures = message.enabledFeatures
  if (!Array.isArray(enabledFeatures) || !requiredFeatures.every((feature) => enabledFeatures.includes(feature))) {
    throw fail("handshake", "kernel did not negotiate required features")
  }
  if (!Number.isSafeInteger(message.ownerEpoch) || (message.ownerEpoch as number) < 1) {
    throw fail("handshake", "kernel returned an invalid durable owner epoch")
  }
  return message.ownerEpoch as number
}

function readOwnerEpoch(path: string): number {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0
    throw fail("owner-epoch", "cannot inspect the persisted owner epoch")
  }
  const uid = process.getuid?.()
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 32 ||
    realpathSync(path) !== path
  ) {
    throw fail("owner-epoch", "persisted owner epoch is unsafe")
  }
  const value = readFileSync(path, "utf8")
  if (!/^[1-9][0-9]*\n$/.test(value)) throw fail("owner-epoch", "persisted owner epoch is malformed")
  const epoch = Number(value.slice(0, -1))
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw fail("owner-epoch", "persisted owner epoch is malformed")
  return epoch
}

function writeOwnerEpoch(path: string, epoch: number) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${epoch}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    try {
      unlinkSync(temporary)
    } catch {}
    throw fail("owner-epoch", "could not persist the host owner epoch")
  }
}

function startupStatus(input: unknown): "starting" | "ready" | "failed" {
  const message = record(input)
  if (message.kind !== "startup_status" || message.protocol !== PROTOCOL) {
    throw fail("startup", "expected a typed startup status")
  }
  if (message.state === "STARTING") return "starting"
  if (message.state === "READY") return "ready"
  if (message.state === "FAILED") return "failed"
  throw fail("startup", "kernel returned an unknown startup state")
}

async function establishChannel(
  options: OpenOptions,
  child: ChildProcessHandle,
  signal: AbortSignal,
  nonce: string,
  incarnation: string,
  socketPath: string,
): Promise<SessionSupervisorClient> {
  const stateDirectory = validateStateDirectory(options.stateDirectory)
  const source = realpathSync(options.source)
  const binary = realpathSync(options.binary)
  if (!/^blake3:[0-9a-f]{64}$/.test(options.hostBuildDigest)) {
    throw fail("configuration", "host build digest must be a canonical BLAKE3 digest")
  }
  if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(options.sessionID)) {
    throw fail("configuration", "Session ID is invalid")
  }
  const hostInstanceId = randomUUID()
  const hostExecutable = realpathSync(process.execPath)
  const timeoutMs = options.startupTimeoutMs ?? 10_000
  await waitForSocket(socketPath, child, signal, timeoutMs)
  const socket = await connectSocket(socketPath, signal, timeoutMs)
  const channel = new MessageChannel(socket)
  await channel.send({
    kind: "hello",
    minProtocol: PROTOCOL,
    maxProtocol: PROTOCOL,
    hostBuildDigest: options.hostBuildDigest,
    hostInstanceId,
    processIncarnation: incarnation,
    supervisorNonce: nonce,
    requiredFeatures: [...REQUIRED_FEATURES],
    optionalFeatures: [],
  })
  const reply = record(await channel.receive())
  if (reply.kind === "hello_rejected") throw fail("handshake", "kernel rejected protocol or required features")
  validateHelloResult(reply, nonce, incarnation, REQUIRED_FEATURES)
  for (let count = 0; count < 16; count++) {
    const status = startupStatus(await channel.receive())
    if (status === "ready") break
    if (status === "failed") throw fail("startup", "kernel failed before READY")
    if (count === 15) throw fail("startup", "kernel did not reach READY")
  }

  const checkpointPath = join(stateDirectory, `session-${options.sessionID}.cursor`)
  return new SessionSupervisorClientImpl(channel, child, options.sessionID, checkpointPath)
}

async function establishHostChannel(
  binary: string,
  stateDirectory: string,
  child: ChildProcessHandle,
  hostBuildDigest: string,
  nonce: string,
  incarnation: string,
  socketPath: string,
): Promise<HostKernelClientImpl> {
  const canonicalState = validateStateDirectory(stateDirectory)
  const canonicalBinary = realpathSync(binary)
  if (!/^blake3:[0-9a-f]{64}$/.test(hostBuildDigest)) {
    throw fail("configuration", "host build digest must be canonical")
  }
  const signal = new AbortController().signal
  const timeoutMs = 10_000
  await waitForSocket(socketPath, child, signal, timeoutMs)
  const socket = await connectSocket(socketPath, signal, timeoutMs)
  const channel = new MessageChannel(socket)
  await channel.send({
    kind: "hello",
    minProtocol: PROTOCOL,
    maxProtocol: PROTOCOL,
    hostBuildDigest,
    hostInstanceId: randomUUID(),
    processIncarnation: incarnation,
    supervisorNonce: nonce,
    requiredFeatures: [...REQUIRED_HOST_FEATURES],
    optionalFeatures: [],
  })
  const reply = record(await channel.receive())
  if (reply.kind === "hello_rejected") throw fail("handshake", "host kernel rejected protocol or required features")
  const ownerEpoch = validateHelloResult(reply, nonce, incarnation, REQUIRED_HOST_FEATURES)
  const epochPath = join(stateDirectory, "owner-epoch")
  const previousEpoch = readOwnerEpoch(epochPath)
  if (ownerEpoch <= previousEpoch) throw fail("owner-epoch", "host kernel owner epoch did not advance")
  writeOwnerEpoch(epochPath, ownerEpoch)
  for (let count = 0; count < 16; count++) {
    const status = startupStatus(await channel.receive())
    if (status === "ready") break
    if (status === "failed") throw fail("startup", "host kernel failed before READY")
    if (count === 15) throw fail("startup", "host kernel did not reach READY")
  }
  if (canonicalState !== stateDirectory || !canonicalBinary.startsWith("/")) {
    throw fail("configuration", "host-kernel paths are not canonical")
  }
  return new HostKernelClientImpl(channel, child, ownerEpoch)
}

function openHostKernel(input: {
  readonly binary: string
  readonly stateDirectory: string
  readonly hostBuildDigest: string
  readonly appProcess: AppProcess.Interface
}): Effect.Effect<HostKernelClientImpl, SessionSupervisorError, Scope.Scope> {
  return Effect.gen(function* () {
    const stateDirectory = yield* Effect.try({
      try: () => ensurePrivateDirectory(input.stateDirectory, "host-state"),
      catch: (error) =>
        error instanceof SessionSupervisorError ? error : fail("host-state", "host state path is unsafe"),
    })
    const nonce = randomUUID()
    const incarnation = randomUUID()
    const socketPath = join(stateDirectory, `host-${nonce.slice(0, 16)}.sock`)
    yield* Effect.try({
      try: () => validateSocketPath(socketPath),
      catch: (error) =>
        error instanceof SessionSupervisorError ? error : fail("configuration", "host socket path is unsafe"),
    })
    const args = [
      `--state-dir=${stateDirectory}`,
      `--socket=${socketPath}`,
      `--host-exe=${realpathSync(globalThis.process.execPath)}`,
      `--nonce=${nonce}`,
      `--incarnation=${incarnation}`,
    ]
    const child = yield* input.appProcess
      .spawn(
        ChildProcess.make(input.binary, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: false,
        }),
      )
      .pipe(Effect.mapError((error) => fail("spawn", error.message)))
    const client = yield* Effect.tryPromise({
      try: () => establishHostChannel(input.binary, stateDirectory, child, input.hostBuildDigest, nonce, incarnation, socketPath),
      catch: (error) =>
        error instanceof SessionSupervisorError ? error : fail("startup", "host-kernel handshake failed"),
    }).pipe(Effect.tapError(() => child.kill().pipe(Effect.ignore)))
    yield* Effect.addFinalizer(() => Effect.promise(() => client.stop()))
    return client
  })
}

class SessionSupervisorClientImpl implements SessionSupervisorClient {
  readonly subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`
  #channel: MessageChannel
  #child: ChildProcessHandle
  #sessionID: string
  #checkpointPath: string
  #subscribed = false
  #lastCursor: Cursor | undefined
  #lastDelivered: Cursor | undefined
  #pending: SessionEvent[] = []
  #closed = false
  #stopPromise: Promise<void> | undefined

  constructor(channel: MessageChannel, child: ChildProcessHandle, sessionID: string, checkpointPath: string) {
    this.#channel = channel
    this.#child = child
    this.#sessionID = sessionID
    this.#checkpointPath = checkpointPath
  }

  async resumeCursor() {
    return readCheckpoint(this.#checkpointPath, this.#sessionID)
  }

  async subscribe(after?: Cursor) {
    if (this.#closed || this.#pending.length > 0) throw fail("subscription", "cannot start a page with pending ACKs")
    const checkpoint = await this.resumeCursor()
    if (after && existsSync(this.#checkpointPath) && !sameCursor(after, checkpoint)) {
      throw fail("subscription", "requested cursor differs from the durable acknowledged cursor")
    }
    after ??= checkpoint
    if (after.ownerKind !== "session" || after.ownerId !== this.#sessionID) {
      throw fail("subscription", "cursor is outside the configured Session")
    }
    if (this.#lastCursor && !sameCursor(after, this.#lastCursor)) {
      throw fail("subscription", "resume cursor differs from the last acknowledged cursor")
    }
    await this.#channel.send({
      kind: "subscribe",
      subscriptionId: this.subscriptionId,
      ownerKind: "session",
      ownerId: this.#sessionID,
      after,
    })
    this.#lastCursor ??= after
    this.#lastDelivered = after
    this.#subscribed = true
  }

  async receive(): Promise<ServerMessage> {
    if (!this.#subscribed || this.#closed) throw fail("subscription", "no active subscription")
    while (true) {
      let value: unknown
      try {
        value = await this.#channel.receive()
      } catch (error) {
        this.#closed = true
        throw error
      }
      const message = decodeServerMessage(value)
      if (message.subscriptionId !== this.subscriptionId)
        throw fail("protocol", "message belongs to another subscription")
      if (message.kind === "event") {
        if (message.cursor.ownerKind !== "session" || message.cursor.ownerId !== this.#sessionID) {
          throw fail("protocol", "event is outside the configured Session")
        }
        if (this.#pending.length >= 64) throw fail("backpressure", "server exceeded the 64-event delivery window")
        const prior = this.#lastDelivered ?? this.#lastCursor
        if (!prior || BigInt(message.cursor.seq) !== BigInt(prior.seq) + 1n) {
          throw fail("protocol", "event cursor is not the exact next sequence")
        }
        this.#lastDelivered = message.cursor
        this.#pending.push(message)
        return message
      }
      if (message.kind === "page_end") {
        if (this.#pending.length > 0 || !this.#lastCursor || !sameCursor(message.through, this.#lastCursor)) {
          throw fail("protocol", "page ended before contiguous acknowledgments")
        }
        writeCheckpoint(this.#checkpointPath, message.through)
        return message
      }
      this.#closed = true
      return message
    }
  }

  async ack(event: SessionEvent) {
    const first = this.#pending[0]
    if (!first || !sameCursor(first.cursor, event.cursor) || event.subscriptionId !== this.subscriptionId) {
      throw fail("ack", "ACK must match the oldest delivered event for this subscription")
    }
    await this.#channel.send({ kind: "ack", subscriptionId: this.subscriptionId, through: event.cursor })
    this.#pending.shift()
    this.#lastCursor = event.cursor
  }

  async unsubscribe() {
    if (this.#closed || this.#channel.isClosed()) {
      this.#closed = true
      await this.#waitForChildExit()
      return
    }
    if (this.#subscribed && this.#pending.length > 0)
      throw fail("shutdown", "cannot unsubscribe with unacknowledged events")
    if (this.#subscribed) {
      await this.#channel.send({ kind: "unsubscribe", subscriptionId: this.subscriptionId })
    }
    this.#closed = true
    this.#channel.end()
    await this.#waitForChildExit()
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopPromise = (this.#closed ? this.#waitForChildExit() : this.unsubscribe()).catch(async () => {
      this.#channel.destroy()
      await this.#terminateChild()
    })
    return this.#stopPromise
  }

  async #waitForChildExit() {
    const exit = Effect.runPromise(this.#child.exitCode).then(
      () => true,
      () => true,
    )
    const exited = await Promise.race([exit, new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))])
    if (exited) return
    await this.#terminateChild()
  }

  async #terminateChild() {
    await Effect.runPromise(this.#child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_500 })).catch(() => undefined)
    const exited = await Promise.race([
      Effect.runPromise(this.#child.exitCode).then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ])
    if (!exited) await Effect.runPromise(this.#child.kill({ killSignal: "SIGKILL" })).catch(() => undefined)
  }
}

type HostEventSubscription = {
  readonly subscriptionID: string
  readonly ack: (through: Cursor) => Promise<void>
  readonly unsubscribe: () => Promise<void>
}

class HostKernelClientImpl {
  #channel: MessageChannel
  #child: ChildProcessHandle
  #pendingRequests = new Map<string, PendingRpc>()
  #expiredRequestIDs: string[] = []
  #subscriptions = new Map<string, (event: SessionEvent) => Promise<void>>()
  #closed = false
  #pump: Promise<void>
  #stopPromise: Promise<void> | undefined
  readonly ownerEpoch: number

  constructor(channel: MessageChannel, child: ChildProcessHandle, ownerEpoch: number) {
    this.#channel = channel
    this.#child = child
    this.ownerEpoch = ownerEpoch
    this.#pump = this.#receive()
    void this.#pump.catch(() => undefined)
  }

  async request(serviceID: string, operation: string, body: Readonly<Record<string, unknown>>) {
    if (this.#closed) throw fail("effect", "host kernel channel is closed")
    if (!serviceID || serviceID.length > 128 || !operation || operation.length > 128)
      throw fail("effect", "RPC service or operation is invalid")
    if (this.#pendingRequests.size >= 16) throw fail("effect", "too many pending host requests")
    const requestID = `req_${randomUUID().replaceAll("-", "")}`
    let resolve!: (value: Record<string, unknown>) => void
    let reject!: (error: SessionSupervisorError) => void
    const response = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    void response.catch(() => undefined)
    const timer = setTimeout(() => {
      this.#pendingRequests.delete(requestID)
      this.#expiredRequestIDs.push(requestID)
      if (this.#expiredRequestIDs.length > 64) this.#expiredRequestIDs.shift()
      reject(fail("effect", "host kernel request timed out"))
    }, 30_000)
    this.#pendingRequests.set(requestID, { resolve, reject, timer })
    try {
      await this.#channel.send({
        protocol: PROTOCOL,
        kind: "request",
        requestId: requestID,
        serviceId: serviceID,
        operation,
        deadlineUnixMs: BigInt(Date.now() + 30_000),
        traceId: randomUUID(),
        body,
      })
    } catch {
      clearTimeout(timer)
      this.#pendingRequests.delete(requestID)
      reject(fail("transport", "could not send host kernel request"))
    }
    return response
  }

  async subscribe(
    terminalID: string,
    generation: number,
    after: Cursor,
    onEvent: (event: SessionEvent) => Promise<void>,
  ): Promise<HostEventSubscription> {
    if (this.#closed) throw fail("transport", "host kernel channel is closed")
    if (
      !/^pty_[a-zA-Z0-9_-]{1,128}$/.test(terminalID) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      after.ownerKind !== "terminal" ||
      after.ownerId !== terminalID
    ) {
      throw fail("subscription", "terminal subscription owner or cursor is invalid")
    }
    const subscriptionID = `sub_${randomUUID().replaceAll("-", "")}`
    this.#subscriptions.set(subscriptionID, onEvent)
    try {
      await this.#channel.send({
        kind: "subscribe",
        subscriptionId: subscriptionID,
        ownerKind: "terminal",
        ownerId: terminalID,
        after,
      })
    } catch {
      this.#subscriptions.delete(subscriptionID)
      throw fail("transport", "could not subscribe to host terminal events")
    }
    return {
      subscriptionID,
      ack: async (through) => {
        if (through.ownerKind !== "terminal" || through.ownerId !== terminalID)
          throw fail("ack", "terminal ACK cursor has the wrong owner")
        await this.#channel.send({ kind: "ack", subscriptionId: subscriptionID, through })
      },
      unsubscribe: async () => {
        if (!this.#subscriptions.delete(subscriptionID)) return
        await this.#channel.send({ kind: "unsubscribe", subscriptionId: subscriptionID })
      },
    }
  }

  async #receive() {
    try {
      while (!this.#closed) {
        const raw = record(await this.#channel.receive())
        if (raw.kind === "response") {
          const response = decodeRpcResponse(raw)
          const pending = this.#pendingRequests.get(response.requestID)
          if (!pending) {
            const expired = this.#expiredRequestIDs.indexOf(response.requestID)
            if (expired >= 0) {
              this.#expiredRequestIDs.splice(expired, 1)
              continue
            }
            throw fail("protocol", "host response has no matching RPC request")
          }
          clearTimeout(pending.timer)
          this.#pendingRequests.delete(response.requestID)
          if (response.outcome === "error") pending.reject(fail("effect", response.message))
          else pending.resolve(response.body)
          continue
        }
        const event = decodeServerMessage(raw)
        if (event.kind !== "event") throw fail("protocol", "unexpected host kernel control message")
        const subscriber = this.#subscriptions.get(event.subscriptionId)
        if (!subscriber) throw fail("protocol", "host event belongs to an unknown subscription")
        await subscriber(event)
      }
    } catch (error) {
      this.#closed = true
      const failure = error instanceof SessionSupervisorError ? error : fail("transport", "host kernel channel closed")
      for (const pending of this.#pendingRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(failure)
      }
      this.#pendingRequests.clear()
      this.#subscriptions.clear()
      throw failure
    }
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopPromise = (async () => {
      this.#closed = true
      for (const pending of this.#pendingRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(fail("transport", "host kernel stopped"))
      }
      this.#pendingRequests.clear()
      this.#subscriptions.clear()
      this.#channel.end()
      const exited = await Promise.race([
        Effect.runPromise(this.#child.exitCode).then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
      ])
      if (!exited) {
        await Effect.runPromise(this.#child.kill({ killSignal: "SIGTERM", forceKillAfter: 1_500 })).catch(() => undefined)
        const terminated = await Promise.race([
          Effect.runPromise(this.#child.exitCode).then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
        ])
        if (!terminated) await Effect.runPromise(this.#child.kill({ killSignal: "SIGKILL" })).catch(() => undefined)
      }
    })()
    return this.#stopPromise
  }
}

function consumeClient(
  client: SessionSupervisorClient,
  turnComplete: Ref.Ref<boolean>,
  ready?: Deferred.Deferred<void, SessionSupervisorError>,
): Effect.Effect<void, SessionSupervisorError> {
  return Effect.gen(function* () {
    let completedPass = false
    let notifiedReady = false
    while (true) {
      yield* Effect.tryPromise({
        try: () => client.subscribe(),
        catch: (error) =>
          error instanceof SessionSupervisorError
            ? error
            : fail("subscription", "could not subscribe to Session events"),
      })
      if (ready && !notifiedReady) {
        yield* Deferred.succeed(ready, undefined)
        notifiedReady = true
      }
      let pageComplete = false
      let hasMore = false
      while (!pageComplete) {
        const message = yield* Effect.tryPromise({
          try: () => client.receive(),
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("transport", "could not receive Session events"),
        })
        if (message.kind === "event") {
          yield* Effect.tryPromise({
            try: () => client.ack(message),
            catch: (error) =>
              error instanceof SessionSupervisorError ? error : fail("ack", "could not acknowledge Session event"),
          })
          continue
        }
        if (message.kind === "resnapshot_required") {
          return yield* Effect.fail(
            fail(
              "resnapshot",
              `acknowledged cursor ${message.requested.seq} is no longer retained; latest is ${message.latest.seq}`,
            ),
          )
        }
        pageComplete = true
        hasMore = message.hasMore
      }
      if (hasMore) continue
      if (yield* Ref.get(turnComplete)) {
        if (completedPass) return
        completedPass = true
        continue
      }
      completedPass = false
      yield* Effect.sleep("250 millis")
    }
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const events = yield* EventV2.Service
    const runtime = yield* RuntimeConfig
    const pendingApprovals = new Map<string, PendingGuardApproval>()
    const closedApprovals = new Map<string, number>()
    const activeWatchers = new Set<string>()
    const hostDigestCache = new Map<string, Effect.Effect<string, SessionSupervisorError>>()
    const getHostBuildDigest = (binary: string) =>
      Effect.gen(function* () {
        let cached = hostDigestCache.get(binary)
        if (!cached) {
          cached = yield* Effect.cached(
            Effect.gen(function* () {
              const hostExecutable = yield* Effect.try({
                try: () => realpathSync(globalThis.process.execPath),
                catch: () => fail("host-digest", "host executable path is unavailable"),
              })
              const output = yield* appProcess
                .run(
                  ChildProcess.make(binary, [`--digest-host-executable=${hostExecutable}`], {
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                    extendEnv: false,
                  }),
                  { timeout: "15 seconds", maxOutputBytes: 128, maxErrorBytes: 1024 },
                )
                .pipe(Effect.mapError((error) => fail("host-digest", error.message)))
              const result = yield* AppProcess.requireSuccess(output).pipe(
                Effect.mapError((error) => fail("host-digest", error.message)),
              )
              const digest = result.stdout.toString("utf8").trim()
              if (!/^blake3:[0-9a-f]{64}$/.test(digest)) {
                return yield* Effect.fail(fail("host-digest", "observer returned a non-canonical BLAKE3 digest"))
              }
              return digest
            }),
          )
          hostDigestCache.set(binary, cached)
        }
        return yield* cached
      })
    let hostKernelClient: HostKernelClientImpl | undefined
    if (runtime.hostKernelManifestJSON) {
      const manifest = yield* Effect.try({
        try: () => parseHostKernelManifest(runtime.hostKernelManifestJSON!),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("manifest", "cannot read host-kernel manifest"),
      })
      if (manifest.status === "available") {
        const target = `linux-${process.arch}-gnu`
        if (process.platform === "linux" && manifest.target === target) {
          if (!runtime.hostKernelAssetPath || !runtime.hostKernelInstallRoot || !runtime.hostKernelStateRoot) {
            return yield* Effect.fail(fail("manifest", "available host-kernel manifest is missing its asset or state paths"))
          }
          const binary = yield* Effect.tryPromise({
            try: () =>
              installBundledBinary(
                runtime.hostKernelAssetPath!,
                manifest.sha256,
                runtime.hostKernelInstallRoot!,
                "hz-kernel",
              ),
            catch: (error) =>
              error instanceof SessionSupervisorError ? error : fail("install", "embedded host kernel is unavailable"),
          })
          const hostBuildDigest = yield* getHostBuildDigest(binary)
          hostKernelClient = yield* openHostKernel({
            binary,
            stateDirectory: runtime.hostKernelStateRoot,
            hostBuildDigest,
            appProcess,
          })
        }
      }
    }
    const open = Effect.fn("SessionSupervisor.open")(function* (options: OpenOptions) {
      if (!options.binary.startsWith("/") || !options.source.startsWith("/")) {
        return yield* Effect.fail(fail("configuration", "binary and source paths must be absolute"))
      }
      if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(options.sessionID)) {
        return yield* Effect.fail(fail("configuration", "Session ID is invalid"))
      }
      const stateDirectory = options.stateDirectory
      if (!stateDirectory.startsWith("/")) {
        return yield* Effect.fail(fail("configuration", "state directory must be absolute"))
      }
      try {
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      } catch {
        return yield* Effect.fail(fail("configuration", "cannot create supervisor state directory"))
      }
      let binary: string
      let workspaceRoot: string | undefined
      try {
        binary = realpathSync(options.binary)
        realpathSync(options.source)
        if (options.workspaceRoot !== undefined) {
          if (!options.workspaceRoot.startsWith("/"))
            return yield* Effect.fail(fail("configuration", "workspace root must be absolute"))
          workspaceRoot = realpathSync(options.workspaceRoot)
          const rootStat = lstatSync(workspaceRoot)
          if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
            return yield* Effect.fail(fail("configuration", "workspace root is not a canonical directory"))
        }
      } catch {
        return yield* Effect.fail(fail("configuration", "binary, source, or workspace root is unavailable"))
      }
      try {
        validateStateDirectory(stateDirectory)
      } catch (error) {
        return yield* Effect.fail(
          error instanceof SessionSupervisorError ? error : fail("configuration", "state path is unsafe"),
        )
      }
      const nonce = randomUUID()
      const incarnation = randomUUID()
      const socketPath = join(stateDirectory, `s-${nonce.slice(0, 16)}.sock`)
      try {
        validateSocketPath(socketPath)
      } catch (error) {
        return yield* Effect.fail(
          error instanceof SessionSupervisorError ? error : fail("configuration", "socket path is unsafe"),
        )
      }
      const args = [
        `--source=${realpathSync(options.source)}`,
        `--state-dir=${stateDirectory}`,
        `--socket=${socketPath}`,
        `--host-exe=${realpathSync(globalThis.process.execPath)}`,
        `--session=${options.sessionID}`,
        `--nonce=${nonce}`,
        `--incarnation=${incarnation}`,
      ]
      if (workspaceRoot) args.push(`--workspace-root=${workspaceRoot}`)
      const child = yield* appProcess
        .spawn(
          ChildProcess.make(binary, args, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: false,
          }),
        )
        .pipe(Effect.mapError((error) => fail("spawn", error.message)))
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => establishChannel(options, child, signal, nonce, incarnation, socketPath),
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("startup", "host handshake failed"),
        }).pipe(Effect.tapError(() => child.kill().pipe(Effect.ignore))),
        (value) => Effect.promise(() => value.stop()),
      )
      return client
    })
    const openForSession = Effect.fn("SessionSupervisor.openForSession")(function* (
      sessionID: string,
      source: string,
      workspaceRoot?: string,
    ) {
      if (!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(sessionID)) {
        return yield* Effect.fail(fail("configuration", "Session ID is invalid"))
      }
      if (source === ":memory:") {
        return {
          status: "unavailable" as const,
          reason: "in-memory EventV2 databases cannot be observed by the Rust sidecar",
        }
      }
      if (!source.startsWith("/")) {
        return yield* Effect.fail(fail("configuration", "OpenCode source path must be absolute"))
      }
      if (!runtime.manifestJSON) {
        return {
          status: "unavailable" as const,
          reason: "this host build has no pinned Session observer manifest",
        }
      }
      const manifest = yield* Effect.try({
        try: () => parseManifest(runtime.manifestJSON!),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("manifest", "cannot read observer manifest"),
      })
      if (manifest.status === "unavailable") return { status: "unavailable" as const, reason: manifest.reason }
      const target = `linux-${process.arch}-gnu`
      if (process.platform !== "linux" || manifest.target !== target) {
        return {
          status: "unavailable" as const,
          reason: `pinned observer target ${manifest.target} does not match runtime ${process.platform}-${process.arch}`,
        }
      }
      if (!runtime.assetPath) {
        return yield* Effect.fail(fail("manifest", "available observer manifest has no embedded executable"))
      }
      const binary = yield* Effect.tryPromise({
        try: () => installBundledBinary(runtime.assetPath!, manifest.sha256, runtime.installRoot),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("install", "embedded observer is unavailable"),
      })
      const stateDirectory = yield* Effect.try({
        try: () => sessionStateDirectory(runtime.stateRoot, sessionID),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("state", "Session state path is unsafe"),
      })
      const hostBuildDigest = yield* getHostBuildDigest(binary)
      const client = yield* open({ binary, source, stateDirectory, sessionID, hostBuildDigest, workspaceRoot })
      return { status: "available" as const, client }
    })
    const requestHostKernel = Effect.fn("SessionSupervisor.requestHostKernel")(function* (
      serviceID: string,
      operation: string,
      body: Readonly<Record<string, unknown>>,
    ) {
      if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
      return yield* Effect.tryPromise({
        try: () => hostKernelClient!.request(serviceID, operation, body),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("host-kernel", "host kernel request failed"),
      })
    })
    const hostOwnerEpoch = Effect.fn("SessionSupervisor.hostOwnerEpoch")(function* () {
      if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
      return hostKernelClient.ownerEpoch
    })
    const subscribeHostKernelEvents = (input: {
      readonly terminalID: string
      readonly generation: number
      readonly after: Cursor
      readonly capacity?: number
    }): Stream.Stream<HostKernelEvent, SessionSupervisorError> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
          const capacity = input.capacity ?? 64
          if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
            return yield* Effect.fail(fail("backpressure", "terminal event capacity must be between 1 and 128"))
          }
          const queue = yield* Queue.dropping<HostKernelEvent, SessionSupervisorError>(capacity)
          const subscription = yield* Effect.tryPromise({
            try: () =>
              hostKernelClient!.subscribe(input.terminalID, input.generation, input.after, async (event) => {
                try {
                  const payload = record(event.payload)
                  const parsed = {
                    terminalID: stringField(payload, "terminalID"),
                    generation: payload.generation,
                    sequence: payload.sequence,
                    byteCursor: payload.byteCursor,
                    kind: stringField(payload, "kind"),
                    payload: payload.payload,
                    cursor: event.cursor,
                    eventType: event.eventType,
                  }
                  if (
                    parsed.terminalID !== input.terminalID ||
                    parsed.generation !== input.generation ||
                    !Number.isSafeInteger(parsed.sequence) ||
                    (parsed.sequence as number) < 1 ||
                    !Number.isSafeInteger(parsed.byteCursor) ||
                    (parsed.byteCursor as number) < 0 ||
                    event.cursor.ownerKind !== "terminal" ||
                    event.cursor.ownerId !== input.terminalID ||
                    event.cursor.seq !== String(parsed.sequence) ||
                    !/^blake3:[0-9a-f]{64}$/.test(event.cursor.eventDigest)
                  ) {
                    throw fail("protocol", "host returned an invalid terminal event")
                  }
                  const accepted = await Effect.runPromise(Queue.offer(queue, parsed as HostKernelEvent))
                  if (!accepted) {
                    await Effect.runPromise(
                      Queue.fail(queue, fail("backpressure", "terminal event stream exceeded its bounded capacity")),
                    )
                  }
                } catch (error) {
                  await Effect.runPromise(
                    Queue.fail(
                      queue,
                      error instanceof SessionSupervisorError ? error : fail("protocol", "invalid terminal event"),
                    ),
                  ).catch(() => undefined)
                }
              }),
            catch: (error) =>
              error instanceof SessionSupervisorError ? error : fail("subscription", "cannot subscribe to terminal events"),
          })
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise({
              try: () => subscription.unsubscribe(),
              catch: () => fail("subscription", "could not unsubscribe from terminal events"),
            }).pipe(
              Effect.andThen(Queue.shutdown(queue)),
              Effect.asVoid,
            ),
          )
          return Stream.fromQueue(queue).pipe(
            Stream.tap((event) =>
              Effect.tryPromise({
                try: () => subscription.ack(event.cursor),
                catch: (error) =>
                  error instanceof SessionSupervisorError ? error : fail("ack", "could not acknowledge terminal event"),
              }),
            ),
          )
        }),
      )
    const replyGuardApproval = Effect.fn("SessionSupervisor.replyGuardApproval")(function* (input: {
      readonly approvalID: string
      readonly decision: GuardApprovalDecision
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (input.decision !== "allow_once" && input.decision !== "deny") {
        return yield* Effect.fail(fail("approval-invalid", "Guard approval decision is invalid"))
      }
      const pending = pendingApprovals.get(input.approvalID)
      if (!pending) {
        return yield* Effect.fail(
          fail(
            closedApprovals.has(input.approvalID) ? "approval-conflict" : "approval-not-found",
            closedApprovals.has(input.approvalID) ? "Guard approval is no longer active" : "Guard approval was not found",
          ),
        )
      }
      const expected = pending.principal
      const actual = trusted.principal
      const validPrincipal =
        actual.kind === "host_os" ||
        (actual.kind === "server_auth" && actual.subject.length > 0)
      const samePrincipal =
        expected === undefined ||
        (expected.kind === actual.kind &&
          (expected.kind === "host_os" || (actual.kind === "server_auth" && expected.subject === actual.subject)))
      if (!validPrincipal || !samePrincipal) {
        return yield* Effect.fail(fail("approval-not-found", "Guard approval was not found"))
      }
      if (Date.now() >= pending.request.expiresAtUnixMs) {
        pendingApprovals.delete(input.approvalID)
        closedApprovals.set(input.approvalID, Date.now())
        yield* Deferred.fail(pending.decision, fail("approval-conflict", "Guard approval expired"))
        yield* events.publish(GuardApprovalResolved, {
          approvalID: input.approvalID,
          decision: "expired",
        })
        return yield* Effect.fail(fail("approval-conflict", "Guard approval expired"))
      }
      pendingApprovals.delete(input.approvalID)
      closedApprovals.set(input.approvalID, Date.now())
      yield* Deferred.succeed(pending.decision, input.decision)
      yield* events.publish(GuardApprovalResolved, {
        approvalID: input.approvalID,
        decision: input.decision,
      })
    })
    const registeredLocations = new Map<string, string>()
    const locationBySession = new Map<string, string>()
    const registerHostLocation = Effect.fn("SessionSupervisor.registerHostLocation")(function* (
      locationRef: typeof LocationSchema.Ref.Type,
    ) {
      if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
      if (
        typeof locationRef.directory !== "string" ||
        locationRef.directory.length === 0 ||
        Buffer.byteLength(locationRef.directory, "utf8") > 4096
      ) {
        return yield* Effect.fail(fail("location", "Location root is invalid"))
      }
      const key = `${locationRef.directory}\0${locationRef.workspaceID ?? ""}`
      const registered = registeredLocations.get(key)
      if (registered) return registered
      const response = yield* requestHostKernel("effects.v2", "register_location", {
        canonicalRoot: locationRef.directory,
        ...(locationRef.workspaceID === undefined ? {} : { workspaceID: locationRef.workspaceID }),
      })
      if (
        response.status !== "registered" ||
        typeof response.locationID !== "string" ||
        !/^loc_[0-9a-f]{64}$/.test(response.locationID)
      ) {
        return yield* Effect.fail(fail("location", "host rejected Location registration"))
      }
      registeredLocations.set(key, response.locationID)
      return response.locationID
    })
    const awaitGuardApproval = Effect.fn("SessionSupervisor.awaitGuardApproval")(function* (
      request: GuardApprovalRequest,
      principal: TrustedPrincipal | undefined,
      locationRef: typeof LocationSchema.Ref.Type,
    ) {
      if (pendingApprovals.has(request.approvalID)) {
        return yield* Effect.fail(fail("approval-conflict", "Guard approval ID is already active"))
      }
      const decision = yield* Deferred.make<GuardApprovalDecision, SessionSupervisorError>()
      const pending: PendingGuardApproval = { request, ...(principal ? { principal } : {}), locationRef, decision }
      pendingApprovals.set(request.approvalID, pending)
      const timeoutMs = request.expiresAtUnixMs - Date.now()
      if (timeoutMs <= 0 || timeoutMs > 5 * 60 * 1000) {
        pendingApprovals.delete(request.approvalID)
        closedApprovals.set(request.approvalID, Date.now())
        return yield* Effect.fail(fail("approval-conflict", "Guard challenge expiry is invalid"))
      }
      const timer = setTimeout(() => {
        if (pendingApprovals.get(request.approvalID) !== pending) return
        pendingApprovals.delete(request.approvalID)
        closedApprovals.set(request.approvalID, Date.now())
        const error = fail("approval-conflict", "Guard approval expired")
        void Effect.runPromise(Deferred.fail(decision, error)).catch(() => undefined)
        void Effect.runPromise(
          events.publish(
            GuardApprovalResolved,
            { approvalID: request.approvalID, decision: "expired" },
            { location: locationRef },
          ),
        ).catch(() => undefined)
      }, timeoutMs)
      yield* events.publish(GuardApprovalRequested, request, { location: locationRef })
      return yield* Deferred.await(decision).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearTimeout(timer)
            if (pendingApprovals.get(request.approvalID) === pending) pendingApprovals.delete(request.approvalID)
          }),
        ),
      )
    })
    const prepareUserEffect = Effect.fn("SessionSupervisor.prepareUserEffect")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly sessionID?: string
      readonly capabilityID: "terminal.start" | "terminal.run"
      readonly arguments: Readonly<Record<string, unknown>>
    }) {
      const trusted = yield* TrustedPrincipalContext
      const locationID = yield* registerHostLocation(input.locationRef)
      const response = yield* requestHostKernel("effects.v2", "prepare_user_effect", {
        locationID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        userActionID: `action_${randomUUID().replaceAll("-", "")}`,
        capabilityID: input.capabilityID,
        arguments: input.arguments,
      })
      if (response.status === "prepared") {
        const lease = yield* Effect.try({
          try: () => parseCapabilityLease(response),
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid capability lease"),
        })
        return { ...lease, locationID }
      }
      if (response.status === "denied") return yield* Effect.fail(fail("authorization", "Guard denied the user action"))
      if (response.status !== "needs_approval") {
        return yield* Effect.fail(fail("protocol", "host returned an invalid user-effect admission"))
      }
      const challenge = yield* Effect.try({
        try: () => {
          const challengeID = stringField(response, "challengeID")
          const effectID = stringField(response, "effectID")
          const capabilityID = stringField(response, "capabilityID")
          const responseLocationID = stringField(response, "locationID")
          const inputDigest = stringField(response, "inputDigest")
          const expiresAtUnixMs = response.expiresAtUnixMs
          const normalizedTargets = response.normalizedTargets
          const policySummary = stringField(response, "policySummary", 1024)
          if (
            capabilityID !== input.capabilityID ||
            responseLocationID !== locationID ||
            !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
            !Number.isSafeInteger(expiresAtUnixMs) ||
            (expiresAtUnixMs as number) <= Date.now() ||
            (expiresAtUnixMs as number) > Date.now() + 5 * 60 * 1000 ||
            !Array.isArray(normalizedTargets) ||
            normalizedTargets.length === 0 ||
            normalizedTargets.length > 64
          ) {
            throw fail("protocol", "host returned an invalid approval challenge")
          }
          return {
            approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
            challengeID,
            effectID,
            capabilityID,
            locationID,
            ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
            inputDigest,
            normalizedTargets,
            expiresAtUnixMs: expiresAtUnixMs as number,
            policySummary,
          }
        },
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid approval challenge"),
      })
      const decision = yield* awaitGuardApproval(challenge, trusted.principal, input.locationRef)
      const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: challenge.challengeID,
        decision,
      })
      if (decision !== "allow_once") return yield* Effect.fail(fail("authorization", "Guard approval was denied"))
      if (resolved.status !== "approved") {
        return yield* Effect.fail(fail("authorization", "host rejected Guard approval"))
      }
      const lease = yield* parseCapabilityLease(resolved)
      if (lease.effectID !== challenge.effectID) {
        return yield* Effect.fail(fail("protocol", "approval lease does not match its challenge"))
      }
      return { ...lease, locationID }
    })
    const prepareToolBatch = Effect.fn("SessionSupervisor.prepareToolBatch")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly batchID: string
      readonly turnContextDigest: string
      readonly calls: ReadonlyArray<GuardedToolCall>
    }) {
      for (const call of input.calls) {
        if (call.capabilityID !== "files.patch") continue
        yield* Effect.try({
          try: () => {
            const args = record(call.arguments)
            if (Object.keys(args).length !== 1 || !("operations" in args)) {
              throw fail("effect", "files.patch arguments are invalid")
            }
            validatePatchOperations(args.operations)
          },
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("effect", "files.patch arguments are invalid"),
        })
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      locationBySession.set(input.sessionID, locationID)
      const response = yield* requestHostKernel("effects.v2", "prepare_tool_batch", {
        sessionID: input.sessionID,
        locationID,
        batchID: input.batchID,
        turnContextDigest: input.turnContextDigest,
        calls: input.calls.map((call) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          arguments: call.arguments,
        })),
      })
      if (response.status === "denied") {
        const reason = response.reason
        return {
          status: "denied" as const,
          reason:
            typeof reason === "string" && Buffer.byteLength(reason, "utf8") <= 512
              ? reason
              : "Guard denied the complete tool batch",
        }
      }
      if (response.status === "prepared") {
        const lease = yield* Effect.try({
          try: () => {
            const effectID = stringField(response, "effectID")
            const capabilityLeaseDigest = stringField(response, "capabilityLeaseDigest")
            if (!/^blake3:[0-9a-f]{64}$/.test(capabilityLeaseDigest)) {
              throw fail("protocol", "host returned an invalid capability lease digest")
            }
            return { effectID, capabilityLeaseDigest }
          },
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid Guard lease"),
        })
        return { status: "prepared" as const, lease }
      }
      if (response.status !== "needs_approval") {
        return yield* Effect.fail(fail("protocol", "Rust returned an invalid effect challenge"))
      }
      const challenge = yield* Effect.try({
        try: () => {
          const targets = Array.isArray(response.targets)
            ? parseEffectTargets(
                response.targets,
                input.calls.some((call) => call.capabilityID === "files.patch"),
              )
            : typeof response.existed === "boolean"
              ? [
                  {
                    target: stringField(response, "target", 4096),
                    resource: stringField(response, "resource", 4096),
                    operation: "write" as const,
                    existed: response.existed,
                  },
                ]
              : []
          const capabilityID = stringField(response, "capabilityID")
          const challengeLocationID = stringField(response, "locationID")
          const inputDigest = stringField(response, "inputDigest")
          const expiresAtUnixMs = response.expiresAtUnixMs
          const normalizedTargets = response.normalizedTargets
          const policySummary = stringField(response, "policySummary", 1024)
          if (
            targets.length === 0 ||
            challengeLocationID !== locationID ||
            !input.calls.some((call) => call.capabilityID === capabilityID) ||
            !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
            !Number.isSafeInteger(expiresAtUnixMs) ||
            (expiresAtUnixMs as number) <= Date.now() ||
            (expiresAtUnixMs as number) > Date.now() + 5 * 60 * 1000 ||
            !Array.isArray(normalizedTargets) ||
            normalizedTargets.length === 0 ||
            normalizedTargets.length > 64
          ) {
            throw fail("protocol", "Rust returned incomplete Guard approval metadata")
          }
          return {
            challengeID: stringField(response, "challengeID"),
            effectID: stringField(response, "effectID"),
            target: targets[0]!.target,
            resource: targets[0]!.resource,
            existed: targets[0]!.existed,
            targets,
            approval: {
              capabilityID,
              locationID,
              inputDigest,
              normalizedTargets,
              expiresAtUnixMs: expiresAtUnixMs as number,
              policySummary,
            },
          }
        },
        catch: (error) =>
          error instanceof SessionSupervisorError
            ? error
            : fail("protocol", "Rust returned an invalid effect challenge"),
      })
      const details = challenge.approval!
      const request: GuardApprovalRequest = {
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        capabilityID: details.capabilityID,
        locationID: details.locationID,
        sessionID: input.sessionID,
        inputDigest: details.inputDigest,
        normalizedTargets: details.normalizedTargets,
        expiresAtUnixMs: details.expiresAtUnixMs,
        policySummary: details.policySummary,
      }
      const decision = yield* awaitGuardApproval(request, undefined, input.locationRef)
      const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: challenge.challengeID,
        decision,
      })
      if (decision !== "allow_once") {
        return { status: "denied" as const, reason: "Guard approval was denied" }
      }
      if (resolved.status !== "approved") {
        return yield* Effect.fail(fail("authorization", "host rejected Guard approval"))
      }
      const lease = yield* parseCapabilityLease(resolved)
      if (lease.effectID !== challenge.effectID) {
        return yield* Effect.fail(fail("protocol", "approval lease does not match its challenge"))
      }
      return { status: "prepared" as const, lease }
    })
    const executeWrite = Effect.fn("SessionSupervisor.executeWrite")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly lease: EffectLease
      readonly content: string
    }) {
      const locationID = yield* registerHostLocation(input.locationRef)
      if (!/^blake3:[0-9a-f]{64}$/.test(input.lease.capabilityLeaseDigest)) {
        return yield* Effect.fail(fail("authorization", "capability lease is invalid"))
      }
      const response = yield* requestHostKernel("effects.v2", "execute_write", {
        sessionID: input.sessionID,
        locationID,
        effectID: input.lease.effectID,
        capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
        content: input.content,
      })
      if (response.status !== "settled" || typeof response.existed !== "boolean") {
        return yield* Effect.fail(fail("protocol", "Rust returned an invalid write receipt"))
      }
      const receipt = yield* Effect.try({
        try: () => {
          const receiptDigest = stringField(response, "receiptDigest")
          if (!/^blake3:[0-9a-f]{64}$/.test(receiptDigest)) {
            throw fail("protocol", "Rust returned a non-canonical effect receipt digest")
          }
          const effectID = stringField(response, "effectID")
          if (effectID !== input.lease.effectID) throw fail("protocol", "Rust write receipt has the wrong effect")
          return {
            effectID,
            receiptDigest,
            target: stringField(response, "target", 4096),
            resource: stringField(response, "resource", 4096),
            existed: response.existed as boolean,
          }
        },
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "Rust returned an invalid write receipt"),
      })
      return receipt
    })
    const executePatch = Effect.fn("SessionSupervisor.executePatch")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly lease: EffectLease
      readonly operations: ReadonlyArray<PatchOperation>
    }) {
      yield* Effect.try({
        try: () => validatePatchOperations(input.operations),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("effect", "files.patch operations are invalid"),
      })
      const locationID = yield* registerHostLocation(input.locationRef)
      if (!/^blake3:[0-9a-f]{64}$/.test(input.lease.capabilityLeaseDigest)) {
        return yield* Effect.fail(fail("authorization", "capability lease is invalid"))
      }
      const response = yield* requestHostKernel("effects.v2", "execute_patch", {
        sessionID: input.sessionID,
        locationID,
        effectID: input.lease.effectID,
        capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
        operations: input.operations,
      })
      if (response.status !== "settled") {
        return yield* Effect.fail(fail("protocol", "Rust returned an invalid patch receipt"))
      }
      const receipt = yield* Effect.try({
        try: () => {
          const receiptDigest = stringField(response, "receiptDigest")
          if (!/^blake3:[0-9a-f]{64}$/.test(receiptDigest)) {
            throw fail("protocol", "Rust returned a non-canonical patch receipt digest")
          }
          const effectID = stringField(response, "effectID")
          if (effectID !== input.lease.effectID) throw fail("protocol", "Rust patch receipt has the wrong effect")
          return { effectID, receiptDigest, targets: parseEffectTargets(response.targets, true) }
        },
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "Rust returned an invalid patch receipt"),
      })
      return receipt
    })
    const runPatch = Effect.fn("SessionSupervisor.runPatch")(function* (input: {
      readonly sessionID: string
      readonly workspaceRoot: string
      readonly turnContextDigest: string
      readonly operations: ReadonlyArray<PatchOperation>
    }) {
      yield* Effect.try({
        try: () => validatePatchOperations(input.operations),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("effect", "files.patch operations are invalid"),
      })
      if (!input.workspaceRoot || !input.turnContextDigest) {
        return yield* Effect.fail(fail("configuration", "files.patch requires trusted Location and turn context"))
      }
      const locationRef = { directory: input.workspaceRoot }
      const admission = yield* prepareToolBatch({
        sessionID: input.sessionID,
        locationRef,
        batchID: `batch_${randomUUID().replaceAll("-", "")}`,
        turnContextDigest: input.turnContextDigest,
        calls: [
          {
            callID: `call_${randomUUID().replaceAll("-", "")}`,
            capabilityID: "files.patch",
            arguments: { operations: input.operations },
          },
        ],
      })
      if (admission.status === "denied") return yield* Effect.fail(fail("authorization", admission.reason))
      if (admission.status !== "prepared") {
        return yield* Effect.fail(fail("protocol", "Guard did not return a one-use patch lease"))
      }
      const receipt = yield* executePatch({
        sessionID: input.sessionID,
        locationRef,
        lease: admission.lease,
        operations: input.operations,
      })
      const remaining = new Map(input.operations.map((operation) => [operation.path, operation]))
      if (receipt.targets.length !== input.operations.length || remaining.size !== input.operations.length) {
        return yield* Effect.fail(fail("protocol", "Rust patch receipt does not match operations"))
      }
      for (const target of receipt.targets) {
        const operation = remaining.get(target.target)
        if (!operation || operation.operation !== target.operation) {
          return yield* Effect.fail(fail("protocol", "Rust patch receipt does not match operations"))
        }
        if (operation.operation === "write" && operation.executable !== undefined && target.executable !== operation.executable) {
          return yield* Effect.fail(fail("protocol", "Rust patch receipt does not match executable state"))
        }
        remaining.delete(target.target)
      }
      if (remaining.size > 0) return yield* Effect.fail(fail("protocol", "Rust patch receipt is incomplete"))
      return receipt
    })
    const watchSessionLoop = Effect.fn("SessionSupervisor.watchSession.loop")(function* (
      sessionID: string,
      source: string,
      workspaceRoot: string,
      turnComplete: Ref.Ref<boolean>,
      ready: Deferred.Deferred<void, SessionSupervisorError>,
    ) {
      let completedTurnRestarts = 0
      let resnapshotAttempts = 0
      while (true) {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const started = yield* openForSession(sessionID, source, workspaceRoot)
            if (started.status === "unavailable") {
              yield* Deferred.succeed(ready, undefined)
              return started
            }
            yield* Deferred.succeed(ready, undefined)
            yield* consumeClient(started.client, turnComplete)
            return { status: "caught-up" as const }
          }),
        ).pipe(Effect.catch((error) => Effect.succeed({ status: "failed" as const, error })))
        yield* Deferred.succeed(ready, undefined)
        if (outcome.status === "unavailable") {
          yield* Effect.logWarning("Session observer unavailable", { sessionID, reason: outcome.reason })
          return
        }
        if (outcome.status === "caught-up") return
        if (outcome.error.stage === "resnapshot") {
          if (resnapshotAttempts > 0) {
            yield* Effect.logWarning("Session observer stopped after repeated retention gaps", {
              sessionID,
              reason: outcome.error.reason,
            })
            return
          }
          resnapshotAttempts++
          const reset = yield* Effect.try({
            try: () => resetSessionObserverMetadata(runtime.stateRoot, sessionID),
            catch: (error) =>
              error instanceof SessionSupervisorError
                ? error
                : fail("resnapshot", "could not securely reset observer metadata"),
          }).pipe(
            Effect.map(() => ({ status: "reset" as const })),
            Effect.catch((error) => Effect.succeed({ status: "failed" as const, error })),
          )
          if (reset.status === "failed") {
            yield* Effect.logWarning("Session observer could not safely resnapshot", {
              sessionID,
              reason: reset.error.reason,
            })
            return
          }
          yield* Effect.logWarning("Session observer rebuilding its read-only projection", {
            sessionID,
            reason: outcome.error.reason,
          })
          continue
        }
        const turnFinished = yield* Ref.get(turnComplete)
        const retryable = outcome.error.stage === "startup" || outcome.error.stage === "transport"
        if (retryable) {
          if (turnFinished) {
            if (outcome.error.stage === "startup" || completedTurnRestarts > 0) {
              yield* Effect.logWarning("Session observer stopped after turn completion", {
                sessionID,
                stage: outcome.error.stage,
                reason: outcome.error.reason,
              })
              return
            }
            completedTurnRestarts++
          }
          yield* Effect.logWarning("Session observer restarting after transport failure", {
            sessionID,
            stage: outcome.error.stage,
            reason: outcome.error.reason,
          })
          yield* Effect.sleep("1 second")
          continue
        }
        yield* Effect.logWarning("Session observer stopped", {
          sessionID,
          stage: outcome.error.stage,
          reason: outcome.error.reason,
        })
        return
      }
    })
    const watchSession = Effect.fn("SessionSupervisor.watchSession")(function* (
      sessionID: string,
      source: string,
      workspaceRoot: string,
      turnComplete: Ref.Ref<boolean>,
      ready: Deferred.Deferred<void, SessionSupervisorError>,
    ) {
      if (activeWatchers.has(sessionID)) {
        const error = fail("ownership", "another Rust observer already owns this Session")
        yield* Deferred.fail(ready, error)
        return yield* Effect.fail(error)
      }
      activeWatchers.add(sessionID)
      return yield* Effect.ensuring(
        watchSessionLoop(sessionID, source, workspaceRoot, turnComplete, ready),
        Effect.sync(() => activeWatchers.delete(sessionID)),
      )
    })
    return Service.of({
      open,
      openForSession,
      registerHostLocation,
      prepareUserEffect,
      replyGuardApproval,
      prepareToolBatch,
      executeWrite,
      executePatch,
      runPatch,
      requestHostKernel,
      hostOwnerEpoch,
      subscribeHostKernelEvents,
      watchSession,
    })
  }),
)
const runtimeConfigLayer = Layer.succeed(
  RuntimeConfig,
  RuntimeConfig.of({
    assetPath: typeof OPENCODE_SESSION_OBSERVER_ASSET === "undefined" ? undefined : OPENCODE_SESSION_OBSERVER_ASSET,
    manifestJSON:
      typeof OPENCODE_SESSION_OBSERVER_MANIFEST === "undefined" ? undefined : OPENCODE_SESSION_OBSERVER_MANIFEST,
    installRoot: join(Global.Path.bin, "session-observer"),
    stateRoot: join(Global.Path.state, "session-observer"),
    hostKernelAssetPath: typeof OPENCODE_HOST_KERNEL_ASSET === "undefined" ? undefined : OPENCODE_HOST_KERNEL_ASSET,
    hostKernelManifestJSON:
      typeof OPENCODE_HOST_KERNEL_MANIFEST === "undefined" ? undefined : OPENCODE_HOST_KERNEL_MANIFEST,
    hostKernelInstallRoot: join(Global.Path.bin, "hz-kernel"),
    hostKernelStateRoot: join(Global.Path.state, "hz-kernel"),
  }),
)

export const runtimeConfigNode = LayerNode.make({
  service: RuntimeConfig,
  layer: runtimeConfigLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AppProcess.node, runtimeConfigNode],
})

export const SessionSupervisor = { Service, RuntimeConfig, runtimeConfigNode, node, acquireExecutionOwner }
