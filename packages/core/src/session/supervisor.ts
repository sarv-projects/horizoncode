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
import { pack, unpack } from "msgpackr"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1, Event as EventSchema, Location as LocationSchema } from "@opencode-ai/schema"
import {
  RepoGenerationRequestV1,
  RepoGenerationPinV1,
  RepoDiscoveryRequestV1,
  RepoDiscoveryPageV1,
  repoDiscoveryPrincipalBinding,
  RepoStructurePageV1,
  RepoStructureQueryV1,
  RepoDocumentReadRequestV1,
  RepoDocumentReadResponseV1,
  RepoIntelPatchFenceV1,
  repoDocumentContentDigest,
} from "@opencode-ai/schema/repo-intelligence-v1"
import { AbsolutePath } from "../schema"
import { EventV2 } from "../event"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import type * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { makeGlobalNode } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { Database } from "../database/database"
import { Global } from "../global"
import { TrustedPrincipalContext, type TrustedPrincipal } from "../trusted-principal"
import { withRepoIntelOverlayGate } from "./repo-intel-overlay"

import { AppProcess, pinCodeModeHelperRoot, pinSupervisorExecutable, pinSupervisorSource } from "../process"

declare const OPENCODE_SESSION_OBSERVER_ASSET: string
declare const OPENCODE_SESSION_OBSERVER_MANIFEST: string
declare const OPENCODE_HOST_KERNEL_ASSET: string
declare const OPENCODE_HOST_KERNEL_MANIFEST: string
declare const OPENCODE_CODE_MODE_HELPER_ASSET: string
declare const OPENCODE_CODE_MODE_HELPER_MANIFEST: string

const PROTOCOL = 1
const MAX_FRAME_BYTES = 8 * 1024 * 1024
// Mirrors `MAX_IDENTIFIER_BYTES` in kernel/src/protocol.rs.
const MAX_IDENTIFIER_BYTES = 256
const MAX_TOOL_BATCH_CALLS = 32
const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024
const MAX_TOOL_BATCH_ARGUMENT_BYTES = 512 * 1024

function directGrantChallengeSetDigest(challengeIDs: ReadonlyArray<string>): string {
  const domain = new TextEncoder().encode("horizoncode.direct-grant-challenge-set.v1\0")
  const encodedIDs = encodeCanonicalMessagePackV1([...challengeIDs], {
    maxEncodedBytes: MAX_IDENTIFIER_BYTES * MAX_TOOL_BATCH_CALLS + 64,
    maxDepth: 2,
    maxNodes: MAX_TOOL_BATCH_CALLS + 1,
    maxCollectionItems: MAX_TOOL_BATCH_CALLS,
    maxScalarBytes: MAX_IDENTIFIER_BYTES,
  })
  const preimage = new Uint8Array(domain.length + encodedIDs.length)
  preimage.set(domain)
  preimage.set(encodedIDs, domain.length)
  return `blake3:${bytesToHex(blake3(preimage))}`
}

function decodeDirectSessionPermissionMode(value: unknown, expected: {
  sessionID: string
  locationID: string
}): DirectSessionPermissionModeV1 {
  const mode = record(value)
  const keys = [
    "schemaVersion", "sessionId", "ownerEpoch", "locationId", "workspaceId",
    "workspaceRootDigest", "executionBackendId", "policyDigest", "sandboxMode",
    "approvalPolicy", "source", "revision", "digest",
  ].toSorted()
  const canonicalDecimal = (input: unknown, positive: boolean) =>
    typeof input === "string" && (positive ? /^[1-9][0-9]{0,19}$/ : /^(0|[1-9][0-9]{0,19})$/).test(input) &&
    BigInt(input) <= 0xffff_ffff_ffff_ffffn
  if (Object.keys(mode).toSorted().join("\0") !== keys.join("\0") ||
    mode.schemaVersion !== 1 || mode.sessionId !== expected.sessionID || mode.locationId !== expected.locationID ||
    typeof mode.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(mode.sessionId) ||
    !canonicalDecimal(mode.ownerEpoch, true) || !canonicalDecimal(mode.revision, true) ||
    typeof mode.workspaceId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(mode.workspaceId) ||
    typeof mode.executionBackendId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(mode.executionBackendId) ||
    typeof mode.workspaceRootDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(mode.workspaceRootDigest) ||
    typeof mode.policyDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(mode.policyDigest) ||
    (mode.sandboxMode !== "read-only" && mode.sandboxMode !== "workspace-write" && mode.sandboxMode !== "danger-full-access") ||
    (mode.approvalPolicy !== "on-request" && mode.approvalPolicy !== "always" && mode.approvalPolicy !== "never") ||
    (mode.source !== "default" && mode.source !== "user-session" && mode.source !== "user-config") ||
    typeof mode.digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(mode.digest)) {
    throw fail("protocol", "HostKernel direct-session permission mode projection is malformed")
  }
  const { digest, ...claims } = mode
  const domain = new TextEncoder().encode("horizoncode.direct-session-permission-mode.v1\0")
  const encoded = encodeCanonicalMessagePackV1(claims, {
    maxEncodedBytes: 4096,
    maxDepth: 3,
    maxNodes: 32,
    maxCollectionItems: 16,
    maxScalarBytes: 512,
  })
  const preimage = new Uint8Array(domain.length + encoded.length)
  preimage.set(domain)
  preimage.set(encoded, domain.length)
  if (`blake3:${bytesToHex(blake3(preimage))}` !== digest) {
    throw fail("protocol", "HostKernel direct-session permission mode digest is invalid")
  }
  return mode as unknown as DirectSessionPermissionModeV1
}

function compareUtf8(left: string, right: string) {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

/** Validate cross-language discovery semantics not expressible in RepoDiscoveryPageV1. */
export function repoDiscoveryPageMatchesRequest(
  request: typeof RepoDiscoveryRequestV1.Type,
  page: typeof RepoDiscoveryPageV1.Type,
) {
  if (page.entries.length > request.maxEntries ||
    page.coverage.entries !== page.entries.length ||
    page.coverage.bytes > request.maxBytes ||
    page.coverage.depth > request.maxDepth) return false

  const rootPrefix = request.rootRef === "." ? "" : `${request.rootRef}/`
  let previousPath: string | undefined
  let visibleByteMinimum = 0
  for (const entry of page.entries) {
    if (entry.pathRef === "." || (rootPrefix && !entry.pathRef.startsWith(rootPrefix))) return false
    const relativePath = rootPrefix ? entry.pathRef.slice(rootPrefix.length) : entry.pathRef
    const pathDepth = relativePath.split("/").length
    if (pathDepth < 1 || entry.depth !== pathDepth || entry.depth > request.maxDepth || entry.depth > page.coverage.depth) {
      return false
    }
    if (previousPath !== undefined && compareUtf8(previousPath, entry.pathRef) >= 0) return false
    previousPath = entry.pathRef
    visibleByteMinimum += new TextEncoder().encode(entry.pathRef).length + 72

    if (request.mode === "manifests") {
      if (entry.kind !== "file" || entry.manifestKind === undefined) return false
    } else if (entry.kind !== "file" && (entry.manifestKind !== undefined || entry.languageHint !== undefined)) {
      return false
    }
  }
  return visibleByteMinimum <= page.coverage.bytes
}

const MAX_PENDING_BYTES = MAX_FRAME_BYTES * 2 + 8
const MAX_PENDING_MESSAGES = 128
// Replay loss recovers in one retry; a host refusal must not spin forever.
const RESNAPSHOT_ATTEMPT_LIMIT = 4
const PAGE_CONTROL_FEATURE = "session.events.page-control.v1"
/**
 * Optional host feature that advertises complete multi-call ToolBatch challenges: the
 * `prepare_tool_batch` response may carry a per-call `calls[]` array and the host routes
 * `cancel_batch`. Until the host negotiates it, a multi-call batch fails closed in the
 * Core and the single-call path is unchanged. Contract for the Rust owner: advertise
 * exactly this string in the hello `enabledFeatures` when HostKernel/EffectHost multi-call
 * admission, cancellation and receipt wiring is accepted.
 */
export const MULTI_CALL_BATCH_FEATURE = "effects.v2.multi-call"
export const REPO_INTEL_READ_CONTEXT_FEATURE = "repo-intel.read-context-v1"
/** Host-minted RepoIntel continuation leases are optional and independently negotiated. */
export const REPO_INTEL_CURSOR_LEASE_FEATURE = "repo-intel.cursor-lease-v1"
export const ARTIFACT_READ_CONTEXT_FEATURE = "artifact.read-context-v1"
export const WEB_SEARCH_CASCADE_FEATURE = "execution.v1.web-search-cascade"
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
    // HostKernel-minted ordered web.search route authority, included only for
    // search approvals so receipt reconciliation can never trust caller input.
    routePlanDigest: Schema.optional(Schema.String),
    normalizedTargets: Schema.Array(Schema.Unknown),
    expiresAtUnixMs: Schema.Finite,
    policySummary: Schema.String,
    origin: Schema.Literals(["session_batch", "user_action", "managed_run", "managed_root"]),
    source: Schema.Literals(["core.tool_batch", "authenticated.user_action", "host.managed_verifier", "host.managed_provider", "host.managed_worktree"]),
    policyID: Schema.String,
    policyDigest: Schema.String,
    normalizedAction: Schema.String,
    argumentSummary: Schema.Unknown,
    requestedGuarantees: Schema.Array(Schema.String),
    guaranteeAssessment: Schema.Unknown,
    runID: Schema.optional(Schema.String),
    noResponse: Schema.Literal("deny_and_expire"),
    allowEnabled: Schema.Boolean,
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
// The host advertises these only after Guard/ExecutionHost preflight is ready.
// A missing optional feature leaves effectful origins unavailable without making
// the authenticated read-only host channel unhealthy.
const REQUIRED_HOST_FEATURES = [] as const
export const OPTIONAL_HOST_FEATURES = [
  "effects.v2",
  "effects.v2.multi-call",
  REPO_INTEL_READ_CONTEXT_FEATURE,
  REPO_INTEL_CURSOR_LEASE_FEATURE,
  ARTIFACT_READ_CONTEXT_FEATURE,
  WEB_SEARCH_CASCADE_FEATURE,
  "resource-policy.ingress-v1",
] as const
const BASE_DIGEST = `blake3:${"0".repeat(64)}`
/** Source contract only; keep editor protocol approvals unavailable until the
 * integrated HostKernel/OS/P4 acceptance gate has passed. */
const EDITOR_PROTOCOL_GUARD_RUNTIME_READY = false
const REPL_OPERATION_GUARD_RUNTIME_READY = false

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

/** CodeMode binds the exact resolved executor name as well as its normalized arguments. */
export type CodeModeGuardedToolCall = GuardedToolCall & { readonly toolName: string }

/** Exact HostKernel envelope for one authenticated Goal-less child Attempt. */
export type DirectAttemptScopeV1 = {
  readonly attemptID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly ownerEpoch: string
  readonly expectedRevision: string
  readonly locationID: string
  readonly workspaceID: string
  readonly workspaceRevision: string
  readonly capabilityDigest: string
  readonly permissionsDigest: string
  readonly budgetDigest: string
  readonly scopeDigest: string
}

export type DirectAttemptScopeWireV1 = Omit<DirectAttemptScopeV1, "ownerEpoch" | "expectedRevision"> & {
  readonly ownerEpoch: bigint
  readonly expectedRevision: bigint
}

/** HostKernel-minted full-snapshot scope for exactly one serialized child turn. */
export type DirectTurnScopeV1 = {
  readonly directAttempt: DirectAttemptScopeV1
  readonly runnerCycleID: string
  readonly turnSequence: string
  readonly cycleDigest: string
}

export type DirectTurnScopeWireV1 = Omit<DirectTurnScopeV1, "directAttempt" | "turnSequence"> & {
  readonly directAttempt: DirectAttemptScopeWireV1
  readonly turnSequence: bigint
}

export function directTurnScopeToWire(scope: DirectTurnScopeV1): DirectTurnScopeWireV1 {
  const keys = ["directAttempt", "runnerCycleID", "turnSequence", "cycleDigest"]
  if (typeof scope !== "object" || scope === null || Array.isArray(scope) ||
    Object.keys(scope).toSorted().join("\0") !== [...keys].sort().join("\0")) {
    throw fail("protocol", "direct turn scope has an invalid shape")
  }
  if (typeof scope.runnerCycleID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(scope.runnerCycleID) ||
    typeof scope.turnSequence !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(scope.turnSequence) ||
    BigInt(scope.turnSequence) > 0xffff_ffff_ffff_ffffn ||
    typeof scope.cycleDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(scope.cycleDigest)) {
    throw fail("protocol", "direct turn scope pins are invalid")
  }
  return { ...scope, directAttempt: directAttemptScopeToWire(scope.directAttempt), turnSequence: BigInt(scope.turnSequence) }
}

export function directTurnScopeFromWire(value: unknown): DirectTurnScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail("protocol", "host direct turn scope is malformed")
  const raw = value as Record<string, unknown>
  const attempt = directAttemptScopeFromWire(raw.directAttempt)
  const sequence = hostU64String(raw.turnSequence, "direct turn sequence")
  const scope = { directAttempt: attempt, runnerCycleID: raw.runnerCycleID, turnSequence: sequence, cycleDigest: raw.cycleDigest } as DirectTurnScopeV1
  directTurnScopeToWire(scope)
  return scope
}

export function sameDirectTurnScopeCore(left: DirectTurnScopeV1, right: DirectTurnScopeV1): boolean {
  try {
    const a = directTurnScopeToWire(left)
    const b = directTurnScopeToWire(right)
    const attempt = (scope: DirectAttemptScopeWireV1) => JSON.stringify({
      ...scope,
      ownerEpoch: String(scope.ownerEpoch),
      expectedRevision: String(scope.expectedRevision),
    })
    return a.runnerCycleID === b.runnerCycleID && a.turnSequence === b.turnSequence && a.cycleDigest === b.cycleDigest &&
      attempt(a.directAttempt) === attempt(b.directAttempt)
  } catch { return false }
}

export function isNextDirectTurnScopeCore(previous: DirectTurnScopeV1, next: DirectTurnScopeV1): boolean {
  try {
    const a = directTurnScopeToWire(previous), b = directTurnScopeToWire(next)
    if (sameDirectTurnScopeCore(previous, next)) return true
    return a.runnerCycleID === b.runnerCycleID && a.turnSequence === b.turnSequence &&
      a.directAttempt.expectedRevision !== 0xffff_ffff_ffff_ffffn &&
      b.directAttempt.expectedRevision === a.directAttempt.expectedRevision + 1n &&
      a.directAttempt.attemptID === b.directAttempt.attemptID && a.directAttempt.parentSessionID === b.directAttempt.parentSessionID &&
      a.directAttempt.childSessionID === b.directAttempt.childSessionID && a.directAttempt.ownerEpoch === b.directAttempt.ownerEpoch &&
      a.directAttempt.profileID === b.directAttempt.profileID && a.directAttempt.profileRevision === b.directAttempt.profileRevision &&
      a.directAttempt.profileDigest === b.directAttempt.profileDigest && a.directAttempt.permissionsDigest === b.directAttempt.permissionsDigest &&
      a.directAttempt.locationID === b.directAttempt.locationID && a.directAttempt.workspaceID === b.directAttempt.workspaceID &&
      a.directAttempt.workspaceRevision === b.directAttempt.workspaceRevision && a.directAttempt.capabilityDigest === b.directAttempt.capabilityDigest &&
      a.directAttempt.budgetDigest === b.directAttempt.budgetDigest && a.directAttempt.scopeDigest === b.directAttempt.scopeDigest
  } catch { return false }
}

export function isCompletedDirectTurnBatchScopeCore(previous: DirectTurnScopeV1, next: DirectTurnScopeV1): boolean {
  try {
    const a = directTurnScopeToWire(previous), b = directTurnScopeToWire(next)
    if (sameDirectTurnScopeCore(previous, next)) return true
    return a.runnerCycleID === b.runnerCycleID && a.turnSequence === b.turnSequence &&
      b.directAttempt.expectedRevision > a.directAttempt.expectedRevision &&
      a.directAttempt.attemptID === b.directAttempt.attemptID && a.directAttempt.parentSessionID === b.directAttempt.parentSessionID &&
      a.directAttempt.childSessionID === b.directAttempt.childSessionID && a.directAttempt.ownerEpoch === b.directAttempt.ownerEpoch &&
      a.directAttempt.profileID === b.directAttempt.profileID && a.directAttempt.profileRevision === b.directAttempt.profileRevision &&
      a.directAttempt.profileDigest === b.directAttempt.profileDigest && a.directAttempt.permissionsDigest === b.directAttempt.permissionsDigest &&
      a.directAttempt.locationID === b.directAttempt.locationID && a.directAttempt.workspaceID === b.directAttempt.workspaceID &&
      a.directAttempt.capabilityDigest === b.directAttempt.capabilityDigest && a.directAttempt.budgetDigest === b.directAttempt.budgetDigest &&
      a.directAttempt.scopeDigest === b.directAttempt.scopeDigest
  } catch { return false }
}

/** Exact HostKernel-minted scope for one live managed Goal/Run/Task/Attempt. */
export type ManagedWorktreeTargetV1 = {
  readonly worktreeID: string
  readonly worktreeBaseRevision: string
  readonly worktreePoolRevision: string
  readonly locationID: string
  readonly workspaceID: string
  readonly workspaceRef: string
  readonly canonicalRoot: string
  readonly workspaceRevision: string
}

export type ManagedAttemptScopeV1 = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly ownerEpoch: string
  readonly expectedManagedRevision: string
  readonly requestSequence: string
  readonly requestID: string
  readonly contextSelectionDigest: string
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRevision: string
  readonly effectiveMaxTokens: string
  /** Zero is an authenticated stopped-accounting projection and is never dispatchable. */
  readonly remainingTokens: string
  readonly delegationBindingDigest: string
  readonly permissionScopeDigest: string
  readonly worktreeTarget: ManagedWorktreeTargetV1
}

export function managedAttemptScopeToWire(scope: ManagedAttemptScopeV1): ManagedAttemptScopeV1 {
  const keys = [
    "goalID", "runID", "taskID", "attemptID", "ownerEpoch", "expectedManagedRevision",
    "requestSequence", "requestID", "contextSelectionDigest", "locationID", "sessionID", "workspaceRevision", "effectiveMaxTokens", "remainingTokens", "delegationBindingDigest", "permissionScopeDigest", "worktreeTarget",
  ]
  if (
    typeof scope !== "object" || scope === null ||
    Object.keys(scope).toSorted().join("\0") !== [...keys].sort().join("\0")
  ) throw fail("protocol", "managed Attempt scope has an invalid shape")
  for (const name of ["goalID", "runID", "taskID", "attemptID", "locationID", "sessionID"] as const) {
    if (typeof scope[name] !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(scope[name])) {
      throw fail("protocol", `managed Attempt scope ${name} is invalid`)
    }
  }
  for (const name of ["ownerEpoch", "expectedManagedRevision", "effectiveMaxTokens", "remainingTokens"] as const) {
    const value = scope[name]
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn ||
      (name === "effectiveMaxTokens" && BigInt(value) === 0n)) {
      throw fail("protocol", `managed Attempt scope ${name} is invalid`)
    }
  }
  if (typeof scope.requestSequence !== "string" || !/^[1-9][0-9]{0,3}$/.test(scope.requestSequence) || Number(scope.requestSequence) > 1024 ||
    typeof scope.requestID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(scope.requestID) ||
    typeof scope.contextSelectionDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(scope.contextSelectionDigest)) {
    throw fail("protocol", "managed Attempt context-selection pin is invalid")
  }
  if (BigInt(scope.remainingTokens) > BigInt(scope.effectiveMaxTokens)) {
    throw fail("protocol", "managed Attempt remaining tokens exceed the effective ceiling")
  }
  for (const name of ["workspaceRevision", "delegationBindingDigest", "permissionScopeDigest"] as const) {
    if (typeof scope[name] !== "string" || !/^blake3:[0-9a-f]{64}$/.test(scope[name])) {
      throw fail("protocol", `managed Attempt scope ${name} is invalid`)
    }
  }
  const target = scope.worktreeTarget
  const targetKeys = ["worktreeID", "worktreeBaseRevision", "worktreePoolRevision", "locationID", "workspaceID", "workspaceRef", "canonicalRoot", "workspaceRevision"]
  if (typeof target !== "object" || target === null || Array.isArray(target) ||
    Object.keys(target).toSorted().join("\0") !== targetKeys.toSorted().join("\0") ||
    typeof target.worktreeID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(target.worktreeID) ||
    typeof target.worktreeBaseRevision !== "string" || target.worktreeBaseRevision.length < 1 || target.worktreeBaseRevision.length > 256 ||
    typeof target.worktreePoolRevision !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(target.worktreePoolRevision) || BigInt(target.worktreePoolRevision) > 0xffff_ffff_ffff_ffffn ||
    typeof target.locationID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(target.locationID) || target.locationID !== scope.locationID ||
    typeof target.workspaceID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(target.workspaceID) ||
    typeof target.workspaceRef !== "string" || target.workspaceRef.length < 1 || Buffer.byteLength(target.workspaceRef, "utf8") > 2048 ||
    typeof target.canonicalRoot !== "string" || target.canonicalRoot.length < 1 || Buffer.byteLength(target.canonicalRoot, "utf8") > 4096 ||
    typeof target.workspaceRevision !== "string" || !/^(?:sha256:[0-9a-f]{64}|blake3:[0-9a-f]{64})$/.test(target.workspaceRevision)) {
    throw fail("protocol", "managed Attempt worktree target is invalid")
  }
  return { ...scope }
}

export function managedAttemptScopeFromWire(value: unknown): ManagedAttemptScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("protocol", "host managed Attempt scope is malformed")
  }
  return managedAttemptScopeToWire(value as ManagedAttemptScopeV1)
}

function hostU64String(value: unknown, field: string): string {
  let parsed: bigint
  if (typeof value === "bigint") parsed = value
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value)
  else if (typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)) parsed = BigInt(value)
  else throw fail("protocol", `host ${field} is not an unsigned integer`)
  if (parsed > 0xffff_ffff_ffff_ffffn) throw fail("protocol", `host ${field} exceeds u64`)
  return parsed.toString()
}

export function directAttemptScopeFromWire(value: unknown): DirectAttemptScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("protocol", "host direct Attempt scope is malformed")
  }
  const raw = value as Record<string, unknown>
  const scope = {
    ...raw,
    ownerEpoch: hostU64String(raw.ownerEpoch, "direct Attempt ownerEpoch"),
    expectedRevision: hostU64String(raw.expectedRevision, "direct Attempt expectedRevision"),
  } as DirectAttemptScopeV1
  // Validate the complete exact shape through the canonical wire projection,
  // then return the decimal-string Core form the callers retain.
  directAttemptScopeToWire(scope)
  return scope
}

const MANAGED_ATTEMPT_SCOPE_FIELDS = [
  "goalID", "runID", "taskID", "attemptID", "ownerEpoch", "expectedManagedRevision",
  "requestSequence", "requestID", "contextSelectionDigest", "locationID", "sessionID",
  "workspaceRevision", "effectiveMaxTokens", "remainingTokens", "delegationBindingDigest",
  "permissionScopeDigest",
] as const
const MANAGED_WORKTREE_TARGET_FIELDS = [
  "worktreeID", "worktreeBaseRevision", "worktreePoolRevision", "locationID", "workspaceID",
  "workspaceRef", "canonicalRoot", "workspaceRevision",
] as const

/** Exact full-field equality of two Core-form managed Attempt scopes, including the
 * worktree target. Invalid scopes compare as unequal (fail closed). */
export function sameManagedAttemptScopeCore(
  left: ManagedAttemptScopeV1,
  right: ManagedAttemptScopeV1,
): boolean {
  try {
    const a = managedAttemptScopeToWire(left)
    const b = managedAttemptScopeToWire(right)
    return MANAGED_ATTEMPT_SCOPE_FIELDS.every((field) => a[field] === b[field]) &&
      MANAGED_WORKTREE_TARGET_FIELDS.every((field) => a.worktreeTarget[field] === b.worktreeTarget[field])
  } catch {
    return false
  }
}

export function isNextDirectAttemptScopeCore(
  previous: DirectAttemptScopeV1,
  next: DirectAttemptScopeV1,
): boolean {
  const left = directAttemptScopeToWire(previous)
  const right = directAttemptScopeToWire(next)
  return left.attemptID === right.attemptID && left.parentSessionID === right.parentSessionID &&
    left.childSessionID === right.childSessionID && left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision && left.profileDigest === right.profileDigest &&
    left.ownerEpoch === right.ownerEpoch && left.locationID === right.locationID &&
    left.workspaceID === right.workspaceID && left.workspaceRevision === right.workspaceRevision &&
    left.capabilityDigest === right.capabilityDigest && left.permissionsDigest === right.permissionsDigest &&
    left.budgetDigest === right.budgetDigest && left.scopeDigest === right.scopeDigest &&
    right.expectedRevision === left.expectedRevision + 1n
}

export function isReceiptAdvancedDirectAttemptScopeCore(
  previous: DirectAttemptScopeV1,
  next: DirectAttemptScopeV1,
): boolean {
  const left = directAttemptScopeToWire(previous)
  const right = directAttemptScopeToWire(next)
  if (left.expectedRevision === right.expectedRevision && left.workspaceRevision === right.workspaceRevision &&
    JSON.stringify({ ...left, ownerEpoch: String(left.ownerEpoch), expectedRevision: String(left.expectedRevision) }) ===
    JSON.stringify({ ...right, ownerEpoch: String(right.ownerEpoch), expectedRevision: String(right.expectedRevision) })) return true
  return left.attemptID === right.attemptID && left.parentSessionID === right.parentSessionID &&
    left.childSessionID === right.childSessionID && left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision && left.profileDigest === right.profileDigest &&
    left.ownerEpoch === right.ownerEpoch && left.locationID === right.locationID &&
    left.workspaceID === right.workspaceID && left.capabilityDigest === right.capabilityDigest &&
    left.permissionsDigest === right.permissionsDigest && left.budgetDigest === right.budgetDigest &&
    left.scopeDigest === right.scopeDigest && left.workspaceRevision !== right.workspaceRevision &&
    right.expectedRevision > left.expectedRevision
}

export function sameManagedAttemptIdentityCore(
  left: ManagedAttemptScopeV1,
  right: ManagedAttemptScopeV1,
): boolean {
  const a = managedAttemptScopeToWire(left)
  const b = managedAttemptScopeToWire(right)
  return a.goalID === b.goalID && a.runID === b.runID && a.taskID === b.taskID &&
    a.attemptID === b.attemptID && a.ownerEpoch === b.ownerEpoch && a.locationID === b.locationID &&
    a.sessionID === b.sessionID && a.effectiveMaxTokens === b.effectiveMaxTokens &&
    a.delegationBindingDigest === b.delegationBindingDigest &&
    a.permissionScopeDigest === b.permissionScopeDigest &&
    JSON.stringify(a.worktreeTarget) === JSON.stringify(b.worktreeTarget)
}

export function isNextManagedAttemptScopeCore(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptScopeV1,
): boolean {
  return sameManagedAttemptIdentityCore(previous, next) &&
    previous.workspaceRevision === next.workspaceRevision &&
    previous.requestSequence === next.requestSequence && previous.requestID === next.requestID &&
    previous.contextSelectionDigest === next.contextSelectionDigest &&
    previous.remainingTokens === next.remainingTokens &&
    BigInt(next.expectedManagedRevision) === BigInt(previous.expectedManagedRevision) + 1n
}

export function isReceiptAdvancedManagedAttemptScopeCore(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptScopeV1,
): boolean {
  return sameManagedAttemptIdentityCore(previous, next) &&
    previous.requestSequence === next.requestSequence && previous.requestID === next.requestID &&
    previous.contextSelectionDigest === next.contextSelectionDigest &&
    next.remainingTokens === previous.remainingTokens &&
    BigInt(next.expectedManagedRevision) === BigInt(previous.expectedManagedRevision) + 1n
}

/** Only the durable managed-context transition may replace this provider-request pin. */
export function isContextAdvancedManagedAttemptScopeCore(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptScopeV1,
): boolean {
  return sameManagedAttemptIdentityCore(previous, next) &&
    previous.workspaceRevision === next.workspaceRevision &&
    previous.remainingTokens === next.remainingTokens &&
    BigInt(next.requestSequence) === BigInt(previous.requestSequence) + 1n &&
    next.requestID !== previous.requestID && next.contextSelectionDigest !== previous.contextSelectionDigest &&
    BigInt(next.expectedManagedRevision) === BigInt(previous.expectedManagedRevision) + 1n
}

/**
 * The OpenCode managed-control projection uses decimal strings for u64 revisions,
 * but HostKernel's canonical MessagePack envelope requires unsigned integers.
 * Validate and convert at the Core RPC boundary so the wire form matches Rust's
 * strict `DirectAttemptScopeV1::from_value` parser.
 */
export function directAttemptScopeToWire(scope: DirectAttemptScopeV1): DirectAttemptScopeWireV1 {
  const keys = [
    "attemptID",
    "parentSessionID",
    "childSessionID",
    "profileID",
    "profileRevision",
    "profileDigest",
    "ownerEpoch",
    "expectedRevision",
    "locationID",
    "workspaceID",
    "workspaceRevision",
    "capabilityDigest",
    "permissionsDigest",
    "budgetDigest",
    "scopeDigest",
  ]
  if (
    typeof scope !== "object" ||
    scope === null ||
    Object.keys(scope).toSorted().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw fail("protocol", "direct Attempt scope has an invalid shape")
  }
  const identifier = (name: keyof DirectAttemptScopeV1) => {
    const value = scope[name]
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
      throw fail("protocol", `direct Attempt scope ${name} is invalid`)
    }
    return value
  }
  const u64 = (name: "ownerEpoch" | "expectedRevision") => {
    const value = scope[name]
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
      throw fail("protocol", `direct Attempt scope ${name} is invalid`)
    }
    const parsed = BigInt(value)
    if (parsed > 0xffff_ffff_ffff_ffffn) {
      throw fail("protocol", `direct Attempt scope ${name} exceeds u64`)
    }
    return parsed
  }
  const profileRevision = () => {
    const value = scope.profileRevision
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
      throw fail("protocol", "direct Attempt scope profileRevision is invalid")
    }
    if (BigInt(value) > 0xffff_ffff_ffff_ffffn) {
      throw fail("protocol", "direct Attempt scope profileRevision exceeds u64")
    }
    return value
  }
  const digest = (name: "profileDigest" | "workspaceRevision" | "capabilityDigest" | "permissionsDigest" | "budgetDigest" | "scopeDigest", algorithm: "blake3" | "sha256") => {
    const value = scope[name]
    if (typeof value !== "string" || !new RegExp(`^${algorithm}:[0-9a-f]{64}$`).test(value)) {
      throw fail("protocol", `direct Attempt scope ${name} is invalid`)
    }
    return value
  }
  return {
    attemptID: identifier("attemptID"),
    parentSessionID: identifier("parentSessionID"),
    childSessionID: identifier("childSessionID"),
    profileID: identifier("profileID"),
    profileRevision: profileRevision(),
    profileDigest: digest("profileDigest", "blake3"),
    ownerEpoch: u64("ownerEpoch"),
    expectedRevision: u64("expectedRevision"),
    locationID: identifier("locationID"),
    workspaceID: identifier("workspaceID"),
    workspaceRevision: digest("workspaceRevision", "blake3"),
    capabilityDigest: digest("capabilityDigest", "sha256"),
    permissionsDigest: digest("permissionsDigest", "sha256"),
    budgetDigest: digest("budgetDigest", "sha256"),
    scopeDigest: digest("scopeDigest", "sha256"),
  }
}

export type EffectTarget = {
  readonly target: string
  readonly resource: string
  readonly operation: "write" | "delete" | "run"
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
  readonly consent: Omit<
    GuardApprovalRequest,
    "approvalID" | "challengeID" | "effectID" | "capabilityID" | "locationID" | "sessionID" | "inputDigest" | "normalizedTargets" | "expiresAtUnixMs" | "policySummary"
  >
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
  readonly directAttempt?: DirectAttemptScopeV1
  readonly directTurnScope?: DirectTurnScopeV1
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly attemptScopeTransition?: "effect_receipt" | "batch_complete"
}

export type EffectLease = {
  readonly effectID: string
  readonly capabilityLeaseDigest: string
  /** HostKernel-minted scope carried only inside the local call path, never model JSON. */
  readonly directAttempt?: DirectAttemptScopeV1
  readonly managedAttempt?: ManagedAttemptScopeV1
}

export type UserEffectCapabilityID =
  | "terminal.start"
  | "terminal.run"
  | "automations.create"
  | "automations.update"
  | "automations.enable"
  | "automations.disable"

/** Host-issued lease plus the server-generated action identity needed for exact reconciliation. */
export type PreparedUserEffect = EffectLease & {
  readonly locationID: string
  readonly userActionID: string
  readonly capabilityID: UserEffectCapabilityID
  readonly challengeID?: string
  /** Host-authenticated digest of the exact normalized user-action arguments. */
  readonly inputDigest?: string
}

export type PreparedEditorProcessApprovalV1 = EffectLease & {
  readonly locationID: string
  readonly capabilityID: "language.start" | "debug.start"
  readonly challengeID: string
  readonly inputDigest: string
}

/** Immutable subject for one editor-protocol frame. Payload bytes are never
 * carried to the approval UI; HostKernel binds this digest to its retained
 * process generation, scope and protocol sequence before issuing a lease. */
export type EditorProtocolAuthorizationRequestV1 = {
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly capabilityID: string
  readonly sessionID: string
  /** Exact ExecutionProtocolAuthorizationV1 arguments sent to Guard. */
  readonly arguments: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

type EditorProtocolAttemptWireV1 = {
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

/** The returned lease is pinned to every field in the request. */
export type EditorProtocolAuthorizationLeaseV1 = EffectLease & {
  readonly locationID: string
  readonly userActionID: string
  readonly challengeID: string
  readonly inputDigest: string
  readonly capabilityID: string
  readonly arguments: Readonly<Record<string, unknown>>
} & EditorProtocolAttemptWireV1

/** Strict HostKernel Guard subject for one typed interpreter execute/reset.
 * The HostKernel derives the operation digest and issues the sequence-bound
 * one-use lease; Core never creates either value. */
export type ReplOperationAuthorizationRequestV1 = {
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly capabilityID: "repl.execute" | "repl.reset"
  readonly sessionID: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
}

export type ReplOperationAuthorizationLeaseV1 = EffectLease & {
  readonly locationID: string
  readonly userActionID: string
  readonly challengeID: string
  readonly inputDigest: string
  readonly capabilityID: "repl.execute" | "repl.reset"
  readonly arguments: Readonly<Record<string, unknown>>
} & EditorProtocolAttemptWireV1

/**
 * One member of a complete multi-call ToolBatch admission: the member's own durable
 * challenge resolved to its own one-use lease. Only the host may issue these; the Core
 * never manufactures a lease.
 */
export type ToolBatchCallLease = {
  readonly callID: string
  readonly capabilityID: string
  readonly lease?: EffectLease
}

/**
 * The canonical boundary operations the multi-call relay needs. Production binds these to
 * the host kernel (`awaitGuardApproval`, `resolve_approval`, `cancel_batch`); tests bind a
 * stub, so the orchestration is verifiable without a transport.
 */
export type ToolBatchRelayPort = {
  readonly requestApproval: (request: GuardApprovalRequest) => Effect.Effect<GuardApprovalDecision, SessionSupervisorError>
  /**
   * Advisory only: a positive result permits Core to skip the repeat UI prompt,
   * while resolveApprovalSet still revalidates the grant, reserves its budget and
   * issues one-use leases atomically. Failure is always treated as prompt-required.
   */
  readonly preflightDirectGrant?: (request: {
    readonly sessionID: string
    readonly locationID: string
    readonly batchID: string
    readonly challengeIDs: ReadonlyArray<string>
  }) => Effect.Effect<boolean, SessionSupervisorError>
  readonly resolveApprovalSet: (request: {
    readonly sessionID: string
    readonly locationID: string
    readonly batchID: string
    readonly challengeIDs: ReadonlyArray<string>
  }) => Effect.Effect<{
    readonly leases: ReadonlyArray<{ readonly challengeID: string; readonly lease: EffectLease }>
    readonly directAttempt?: DirectAttemptScopeV1
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly nextLeaseRequired?: boolean
  }, SessionSupervisorError>
  readonly leaseNextEffect?: (request: {
    readonly sessionID: string
    readonly locationID: string
    readonly batchID: string
    readonly previousEffectID: string
  }) => Effect.Effect<{
    readonly challengeID: string
    readonly lease: EffectLease
    readonly directAttempt?: DirectAttemptScopeV1
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
  }, SessionSupervisorError>
  readonly cancelBatch: (input: {
    readonly sessionID: string
    readonly batchID: string
  }) => Effect.Effect<void, SessionSupervisorError>
}

export type EffectAdmission =
  | { readonly status: "prepared"; readonly lease: EffectLease; readonly directAttempt?: DirectAttemptScopeV1; readonly directTurnScope?: DirectTurnScopeV1; readonly managedAttempt?: ManagedAttemptScopeV1; readonly attemptScopeTransition?: "batch_bind" }
  | { readonly status: "admitted"; readonly challenge: EffectChallenge }
  /** Mode-approved multi-call batch: HostKernel already issued each exact one-use
   * lease without a user approval round; each member stays bound to its challenge. */
  | {
      readonly status: "admitted_batch"
      readonly calls: ReadonlyArray<{
        readonly callID: string
        readonly capabilityID: string
        readonly challenge: EffectChallenge
        readonly lease: EffectLease
      }>
    }
  | {
      readonly status: "prepared_batch"
      readonly calls: ReadonlyArray<ToolBatchCallLease>
      readonly leaseNext?: (request: { readonly callID: string; readonly previousEffectID: string }) => Effect.Effect<ToolBatchCallLease, SessionSupervisorError>
      readonly directAttempt?: DirectAttemptScopeV1
      readonly directTurnScope?: DirectTurnScopeV1
      readonly managedAttempt?: ManagedAttemptScopeV1
      readonly attemptScopeTransition?: "batch_bind"
    }
  | { readonly status: "denied"; readonly reason: string }
export type EffectReceipt = {
  readonly effectID: string
  readonly receiptDigest: string
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  /** HostKernel-issued receipt-advanced scope for the next Attempt-bound call. */
  readonly directAttempt?: DirectAttemptScopeV1
  /** Present only on the final terminal member of an entire direct turn batch. */
  readonly directTurnScope?: DirectTurnScopeV1
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly attemptScopeTransition?: "effect_receipt" | "batch_complete"
}

export type GuardApprovalDecision = "allow_once" | "deny"
export type GuardApprovalReplyDecisionV1 = GuardApprovalDecision | "grant_session" | "grant_workspace"
export type GuardApprovalRequest = {
  readonly approvalID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: string
  readonly locationID: string
  readonly sessionID?: string
  readonly inputDigest: string
  readonly routePlanDigest?: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: GuardApprovalOriginV1
  readonly source: GuardApprovalSourceV1
  readonly policyID: string
  readonly policyDigest: string
  readonly normalizedAction: string
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly runID?: string
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: boolean
}
export type GuardApprovalOriginV1 = "session_batch" | "user_action" | "managed_run" | "managed_root"
export type GuardApprovalSourceV1 = "core.tool_batch" | "authenticated.user_action" | "host.managed_verifier" | "host.managed_provider" | "host.managed_worktree"
export type GuardArgumentSummaryV1 =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: string }
export type GuardGuaranteeAssessmentV1 =
  | { readonly status: "assessed"; readonly residual: ReadonlyArray<string> }
  | { readonly status: "not_assessed"; readonly residual: null }
export type ManagedVerifierGuardChallengeV1 = {
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "builtin.verifier"
  readonly locationID: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: "managed_run"
  readonly source: "host.managed_verifier"
  readonly policyID: string
  readonly policyDigest: string
  readonly normalizedAction: "builtin.verifier"
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly runID: string
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: false
}

/** Host-authored, non-secret provider inference challenge. Route/request authority is
 * repeated only in the dedicated HostKernel resolution call after the user decides. */
export type ManagedProviderGuardChallengeV1 = {
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "providers.infer"
  readonly locationID: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: "managed_run"
  readonly source: "host.managed_provider"
  readonly policyID: "provider-inference.managed.v1"
  readonly policyDigest: string
  readonly normalizedAction: "providers.infer"
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly runID: string
  readonly sessionID: string
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: boolean
}

export type ManagedProviderApprovalResultV1 = {
  readonly decision: GuardApprovalDecision
  readonly challengeID: string
  readonly effectID: string
  readonly providerRequestID: string
  readonly prepareDigest: string
}

export type DirectSessionGrantProjectionV1 = {
  readonly status: "ACTIVE" | "REVOKED"
  readonly grantID: string
  readonly grantDigest: string
  readonly scopeKind: "session" | "workspace"
  readonly scopeDigest: string
  readonly expiresAtUnixMs: string | null
  readonly revokedAtUnixMs: string | null
}

/** Strict host-authenticated direct-session permission projection (schema v1). */
export type DirectSessionPermissionModeV1 = {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly ownerEpoch: string
  readonly locationId: string
  readonly workspaceId: string
  readonly workspaceRootDigest: string
  readonly executionBackendId: string
  readonly policyDigest: string
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access"
  readonly approvalPolicy: "on-request" | "always" | "never"
  readonly source: "default" | "user-session" | "user-config"
  readonly revision: string
  readonly digest: string
}

/** Host-authenticated direct Session permission scope for provider request pins. */
export type DirectProviderPermissionScopeV1 = {
  readonly sessionID: string
  readonly locationID: string
  readonly ownerEpoch: string
  readonly permissionScopeDigest: string
  readonly policyDigest: string
}
/** One HostKernel-minted, exact managed-root lifecycle approval challenge. */
export type ManagedRootGuardChallengeV1 = {
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "git.worktree.list"
  readonly locationID: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: "managed_root"
  readonly source: "host.managed_worktree"
  readonly policyID: string
  readonly policyDigest: string
  readonly normalizedAction: "git.worktree.list"
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: boolean
}
export type ManagedVerifierApprovalDecisionV1 = {
  readonly challengeID: string
  readonly decision: GuardApprovalDecision
}
export type ManagedVerifierApprovalAbortReasonV1 =
  | "reviewer_denied"
  | "cancelled"
  | "expired"
  | "transport_lost"
export type ManagedVerifierApprovalCollectionV1 =
  | { readonly kind: "decisions"; readonly decisions: ReadonlyArray<ManagedVerifierApprovalDecisionV1> }
  | {
      readonly kind: "abort"
      readonly reason: ManagedVerifierApprovalAbortReasonV1
      /** Only responses actually received from the reviewer are included. */
      readonly decisions: ReadonlyArray<ManagedVerifierApprovalDecisionV1>
    }

/**
 * Collect the bounded reviewer set without losing genuine earlier decisions if a
 * later prompt expires, is interrupted, or loses transport. The sequential waits
 * keep the UI queue below its 16-entry limit while preserving the host's all-or-none
 * lease resolution contract.
 */
export const collectManagedVerifierApprovalDecisions = (
  challenges: ReadonlyArray<ManagedVerifierGuardChallengeV1>,
  awaitDecision: (
    challenge: ManagedVerifierGuardChallengeV1,
  ) => Effect.Effect<GuardApprovalDecision, unknown>,
): Effect.Effect<ManagedVerifierApprovalCollectionV1> =>
  Effect.gen(function* () {
    const decisions: ManagedVerifierApprovalDecisionV1[] = []
    for (const challenge of challenges) {
      const exit = yield* Effect.exit(awaitDecision(challenge))
      if (exit._tag === "Failure") {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        const reason: ManagedVerifierApprovalAbortReasonV1 = Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : error instanceof SessionSupervisorError && /expired/i.test(error.reason)
            ? "expired"
            : "transport_lost"
        return { kind: "abort", reason, decisions }
      }
      decisions.push({ challengeID: challenge.challengeID, decision: exit.value })
      if (exit.value === "deny") return { kind: "abort", reason: "reviewer_denied", decisions }
    }
    return { kind: "decisions", decisions }
  })
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
  readonly subscriptionId: string
}
export type HostKernelResnapshot = {
  readonly kind: "resnapshot_required"
  readonly subscriptionId: string
  readonly requested: Cursor
  readonly latest: Cursor
}
export type HostKernelStreamMessage = HostKernelEvent | HostKernelResnapshot

export type ArtifactRefWireV1 = {
  readonly artifactId: string
  readonly digest: string
  readonly byteLength: string
  readonly mediaType: string
  readonly classification: "public" | "workspace" | "sensitive"
}

/** Out-of-body metadata tied to the current authenticated Core principal. */
export type AuthenticatedRequestContextV1 =
  | {
  readonly kind: "repo_read"
  readonly sessionID: string
  readonly locationID: string
  }
  | {
      readonly kind: "artifact_read"
      readonly sessionID: string
      readonly locationID: string
      readonly artifactRef: ArtifactRefWireV1
      readonly managedAttempt?: ManagedAttemptScopeV1
      /** HostKernel requires the unsigned-integer wire projection for direct Attempt scopes. */
      readonly directAttempt?: DirectAttemptScopeWireV1
    }
  | {
      readonly kind: "artifact_scope_resolve"
      readonly sessionID: string
      readonly locationID: string
      readonly artifactRef: ArtifactRefWireV1
    }
  | {
      /** Root-session artifact reads must resolve through the immutable direct receipt index. */
      readonly kind: "direct_session_artifact_read"
      readonly sessionID: string
      readonly locationID: string
      readonly artifactRef: ArtifactRefWireV1
    }
  | {
      /** Private correlation for an ordinary guarded CodeMode tool call. */
      readonly kind: "code_mode_call"
      readonly sessionID: string
      readonly locationID: string
      readonly callID: string
      readonly lane: "direct_session" | "managed_attempt"
      readonly managedAttempt?: ManagedAttemptScopeV1
    }

function validateArtifactRefWire(value: unknown): value is ArtifactRefWireV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    Object.keys(ref).toSorted().join("\0") === ["artifactId", "byteLength", "classification", "digest", "mediaType"].sort().join("\0") &&
    typeof ref.artifactId === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(ref.artifactId) &&
    typeof ref.digest === "string" && /^blake3:[0-9a-f]{64}$/.test(ref.digest) &&
    typeof ref.byteLength === "string" && /^(0|[1-9][0-9]{0,19})$/.test(ref.byteLength) &&
    BigInt(ref.byteLength) <= 0xffff_ffff_ffff_ffffn &&
    typeof ref.mediaType === "string" && ref.mediaType.length > 0 && Buffer.byteLength(ref.mediaType, "utf8") <= 256 &&
    (ref.classification === "public" || ref.classification === "workspace" || ref.classification === "sensitive")
  )
}

function sameArtifactRef(left: unknown, right: ArtifactRefWireV1): boolean {
  if (!validateArtifactRefWire(left)) return false
  return left.artifactId === right.artifactId && left.digest === right.digest && left.byteLength === right.byteLength &&
    left.mediaType === right.mediaType && left.classification === right.classification
}

function validArtifactReadRequest(serviceID: string, operation: string, body: Readonly<Record<string, unknown>>, context: AuthenticatedRequestContextV1) {
  if (serviceID !== "artifact.v1" || context.kind !== "artifact_read" ||
    (operation !== "artifacts.inspect" && operation !== "artifacts.read_range") ||
    !validateArtifactRefWire(context.artifactRef) || !sameArtifactRef(body.artifactRef, context.artifactRef)) return false
  const expected = operation === "artifacts.inspect" ? ["artifactRef"] : ["artifactRef", "maxBytes", "offset"]
  if (Object.keys(body).toSorted().join("\0") !== expected.sort().join("\0")) return false
  if (operation === "artifacts.read_range") {
    if (typeof body.offset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(body.offset) || BigInt(body.offset) > 0xffff_ffff_ffff_ffffn) return false
    if (typeof body.maxBytes !== "number" || !Number.isSafeInteger(body.maxBytes) || body.maxBytes < 1 || body.maxBytes > 768 * 1024) return false
  }
  try {
    // The kernel accepts exactly one Attempt lane on artifact_read (never both);
    // Core keeps requiring one so a scope-free context can never widen the read.
    if ((context.managedAttempt === undefined) === (context.directAttempt === undefined)) return false
    if (context.managedAttempt !== undefined) {
      const scope = managedAttemptScopeToWire(context.managedAttempt)
      if (scope.sessionID !== context.sessionID || scope.locationID !== context.locationID) return false
    } else {
      // The context carries the unsigned-integer wire projection; the FromWire
      // parser accepts that form and returns the validated Core decimal-string scope.
      const scope = directAttemptScopeFromWire(context.directAttempt!)
      if (scope.childSessionID !== context.sessionID || scope.locationID !== context.locationID) return false
    }
  } catch {
    return false
  }
  return /^ses_[A-Za-z0-9_-]{1,128}$/.test(context.sessionID) && /^loc_[0-9a-f]{64}$/.test(context.locationID)
}

function validArtifactScopeResolveRequest(serviceID: string, operation: string, body: Readonly<Record<string, unknown>>, context: AuthenticatedRequestContextV1) {
  return serviceID === "artifact.v1" && operation === "artifacts.resolve_scope" &&
    context.kind === "artifact_scope_resolve" &&
    Object.keys(body).toSorted().join("\0") === ["artifactRef", "schemaVersion"].sort().join("\0") &&
    body.schemaVersion === 1 && validateArtifactRefWire(context.artifactRef) &&
    sameArtifactRef(body.artifactRef, context.artifactRef) &&
    /^ses_[A-Za-z0-9_-]{1,128}$/.test(context.sessionID) && /^loc_[0-9a-f]{64}$/.test(context.locationID)
}

function validDirectSessionArtifactReadRequest(serviceID: string, operation: string, body: Readonly<Record<string, unknown>>, context: AuthenticatedRequestContextV1) {
  if (serviceID !== "artifact.v1" || context.kind !== "direct_session_artifact_read" ||
    (operation !== "artifacts.inspect" && operation !== "artifacts.read_range") ||
    !validateArtifactRefWire(context.artifactRef) || !sameArtifactRef(body.artifactRef, context.artifactRef) ||
    body.schemaVersion !== 1 || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(context.sessionID) || !/^loc_[0-9a-f]{64}$/.test(context.locationID)) return false
  const expected = operation === "artifacts.inspect"
    ? ["artifactRef", "schemaVersion"]
    : ["artifactRef", "maxBytes", "offset", "schemaVersion"]
  if (Object.keys(body).toSorted().join("\0") !== expected.sort().join("\0")) return false
  if (operation === "artifacts.read_range") {
    if (typeof body.offset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(body.offset) || BigInt(body.offset) > 0xffff_ffff_ffff_ffffn) return false
    if (typeof body.maxBytes !== "number" || !Number.isSafeInteger(body.maxBytes) || body.maxBytes < 1 || body.maxBytes > 768 * 1024) return false
  }
  return true
}

export function validDirectReadBatchAuthenticatedRequest(
  serviceID: string,
  operation: string,
  body: Readonly<Record<string, unknown>>,
  context: AuthenticatedRequestContextV1,
) {
  if (serviceID !== "effects.v2" || operation !== "prepare_tool_batch_read" || context.kind !== "repo_read") return false
  if (body.schemaVersion !== 1 || body.sessionID !== context.sessionID || body.locationID !== context.locationID) return false
  return Array.isArray(body.calls) && body.calls.length >= 1 && body.calls.length <= 8
}

function validCodeModeAuthenticatedRequest(serviceID: string, operation: string, body: Readonly<Record<string, unknown>>, context: AuthenticatedRequestContextV1) {
  if (serviceID !== "execution.v1" || context.kind !== "code_mode_call" ||
    !["codemode_enablement", "codemode_start", "codemode_resume", "codemode_cancel", "codemode_cancel_wave", "codemode_inspect", "codemode_prepare_wave", "codemode_settle_tool_results", "codemode_wave_receipts"].includes(operation) ||
    body.schemaVersion !== 1 || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(context.sessionID) || !/^loc_[0-9a-f]{64}$/.test(context.locationID) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(context.callID) ||
    ((context.lane === "managed_attempt") !== (context.managedAttempt !== undefined))) return false
  if (context.lane === "direct_session") return context.managedAttempt === undefined && body.lane === "direct_session" && body.sessionID === context.sessionID
  if (!context.managedAttempt || body.lane !== "managed_attempt" || body.runID !== context.managedAttempt.runID ||
    body.taskID !== context.managedAttempt.taskID || body.attemptID !== context.managedAttempt.attemptID) return false
  try {
    const scope = managedAttemptScopeToWire(context.managedAttempt)
    return scope.sessionID === context.sessionID && scope.locationID === context.locationID
  } catch {
    return false
  }
}

/**
 * A terminal event carries a free-form `kind` from the host, so the control message is
 * identified structurally: only a resnapshot carries `requested`/`latest` cursors.
 */
export function isHostKernelResnapshot(message: HostKernelStreamMessage): message is HostKernelResnapshot {
  return "latest" in message
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

export type CodeModeHelperManifest = {
  readonly schemaVersion: 1
  readonly status: "available" | "unavailable"
  readonly helperSelector: "horizoncode:codemode:bun"
  readonly relativeEntrypoint: "codemode-helper.js"
  readonly sha256: `sha256:${string}` | null
  readonly target: string
  readonly reason?: string
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
  readonly codeModeHelperAssetPath?: string
  readonly codeModeHelperManifestJSON?: string
  readonly codeModeHelperInstallRoot?: string
}

export type SessionSupervisorStart =
  | { readonly status: "available"; readonly client: SessionSupervisorClient }
  | { readonly status: "unavailable"; readonly reason: string }

export class RuntimeConfig extends Context.Service<RuntimeConfig, RuntimeConfigOptions>()(
  "@opencode/SessionSupervisorRuntime",
) {}

export type GuardApprovalErrorCode = "approval-not-found" | "approval-conflict" | "approval-invalid"

export class SessionSupervisorError extends Schema.TaggedErrorClass<SessionSupervisorError>()(
  "SessionSupervisorError",
  {
    stage: Schema.String,
    reason: Schema.String,
    approvalCode: Schema.optional(Schema.Literals(["approval-not-found", "approval-conflict", "approval-invalid"])),
    /** Typed kernel error code (`managed_conflict`, `managed_not_found`, ...) when the host refused an RPC. */
    hostCode: Schema.optional(Schema.String),
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

export type DirectSessionWorkspaceSnapshotV1 = {
  readonly sessionID: string
  readonly locationID: string
  readonly ownerEpoch: string
  readonly workspaceRevision: string
  readonly workspaceRootDigest: string
  readonly observedAtUnixMs: string
}

export type ManagedEffectWaveReceiptProjectionV1 = {
  readonly status: "RECOVERED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly batchID: string
  readonly waveIndex: number
  readonly sourceScopeDigest: string
  readonly waveDigest: string
  readonly effects: ReadonlyArray<{
    readonly callIndex: number
    readonly callID: string
    readonly effectID: string
    readonly receiptRef: string | null
    readonly capabilityID: string
    readonly attemptScopeDigest: string
    readonly status: "SETTLED" | "NOT_APPLIED" | "DENIED" | "EXPIRED" | "CANCELLED" | "UNKNOWN"
    readonly receiptKind: "effect" | "decision" | null
    readonly receiptDigest: string | null
  }>
}

export type ManagedCurrentEpochRecoveryQuiescenceV1 = {
  readonly status: "CURRENT_EPOCH_QUIESCED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly parentSessionID: string
  readonly sessionID: string
  readonly principal: string
  readonly locationID: string
  readonly currentOwnerEpoch: string
  readonly currentProcessIncarnation: string
  readonly currentCorePID: number
  readonly currentCoreStartIdentity: string
  readonly currentCoreExecutableDigest: string
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  readonly childSessionStateDigest: string
  readonly childObservationDigest: string
  readonly hostQuiescenceDigest: string
  readonly originalTerminalOwnerLogID: string
  readonly originalTerminalOwnerLogSequence: string
  readonly originalTerminalOwnerLogEventDigest: string
  readonly originalPromptQuiescenceDigest: string
  readonly originalPromptQuiescenceOwnerEpoch: string
  readonly originalAttemptStateDigest: string
  readonly originalEffectChainDigest: string
  readonly originalEvidenceDigest: string
  readonly verifiedWorkspaceHead: string
  readonly receiptDigest: string
}

export type DirectCodeModeWaveReceiptProjectionV1 = {
  readonly status: "SETTLED" | "REJECTED" | "CANCELLED"
  readonly sessionID: string
  readonly locationID: string
  readonly requestID: string
  readonly batchID: string
  readonly waveIndex: number
  readonly frameDigest: string
  readonly waveDigest: string | null
  readonly directSessionScopeDigest: string
  readonly effects: ReadonlyArray<{
    readonly callIndex: number
    readonly callID: string
    readonly effectID: string | null
    readonly challengeID: string | null
    readonly receiptRef: string
    readonly capabilityID: string | null
    readonly status: "SETTLED" | "REJECTED" | "CANCELLED"
    readonly receiptKind: "effect" | "decision"
    readonly receiptDigest: string
  }>
}

export type DirectAttemptTerminalArtifactProjectionV1 = {
  readonly status: "RECOVERED"
  readonly sessionID: string
  readonly locationID: string
  readonly directAttemptID: string
  readonly ownerEpoch: string
  readonly artifacts: ReadonlyArray<{
    readonly artifactRef: ArtifactRefWireV1
    readonly effectID: string
    readonly batchID: string
    readonly callIndex: number
    readonly callID: string
    readonly challengeID: string
    readonly attemptScopeDigest: string
    readonly receiptDigest: string
    readonly outputDigest: string
    readonly workspaceRevision: string
    readonly fidelity: "FULL" | "SAMPLE"
    readonly observedBytes: string
    readonly droppedBytes: string
  }>
}

/** Authenticated root DirectSession terminal artifacts; no synthetic Attempt scope is accepted. */
export type DirectSessionTerminalArtifactProjectionV1 = {
  readonly status: "RECOVERED"
  readonly sessionID: string
  readonly locationID: string
  readonly currentOwnerEpoch: string
  readonly artifacts: ReadonlyArray<{
    readonly artifactRef: ArtifactRefWireV1
    readonly effectID: string
    readonly batchID: string
    readonly ownerEpoch: string
    readonly callIndex: number
    readonly callID: string
    readonly challengeID: string
    readonly receiptDigest: string
    readonly outputDigest: string
    readonly workspaceRevision: string
    readonly fidelity: "FULL" | "SAMPLE"
    readonly observedBytes: string
    readonly droppedBytes: string
  }>
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
  readonly registerHostLocation: (locationRef: typeof LocationSchema.Ref.Type) => Effect.Effect<string, SessionSupervisorError, TrustedPrincipalContext>
  /** Read the authenticated, HostKernel-derived per-Session permission posture. */
  readonly directSessionPermissionModeSnapshot: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
  }) => Effect.Effect<DirectSessionPermissionModeV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Read-only permission-scope projection derived from the authenticated HostKernel mode snapshot. */
  readonly directProviderPermissionScope: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
  }) => Effect.Effect<DirectProviderPermissionScopeV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Persist a user-selected sandbox/approval posture with HostKernel CAS revision. */
  readonly setDirectSessionPermissionMode: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly sandboxMode: DirectSessionPermissionModeV1["sandboxMode"]
    readonly approvalPolicy: DirectSessionPermissionModeV1["approvalPolicy"]
    readonly expectedRevision: string
  }) => Effect.Effect<DirectSessionPermissionModeV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Explicit UI-only consent persistence; this never resolves the displayed challenge. */
  readonly issueDirectSessionGrant: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly sessionID: string
    readonly challengeID: string
    readonly effectID: string
    readonly scopeKind: "session" | "workspace"
    readonly actions: readonly ("read" | "edit")[]
  }) => Effect.Effect<DirectSessionGrantProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  readonly revokeDirectSessionGrant: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly grantID: string
  }) => Effect.Effect<DirectSessionGrantProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  readonly prepareUserEffect: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly sessionID?: string
    readonly capabilityID: UserEffectCapabilityID
    readonly arguments: Readonly<Record<string, unknown>>
  }) => Effect.Effect<PreparedUserEffect, SessionSupervisorError, TrustedPrincipalContext>
  /** Resolve one HostKernel-minted editor-process Guard challenge through the shared approval owner. */
  readonly resolveEditorProcessApproval: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly challenge: GuardApprovalRequest
  }) => Effect.Effect<PreparedEditorProcessApprovalV1, SessionSupervisorError, TrustedPrincipalContext>
  /**
   * Per-frame editor Guard admission through the existing HostKernel
   * prepare_user_effect and durable protocol receipt path. The source adapter
   * remains unavailable until integrated Guard, receipt and OS acceptance;
   * process-start approval must never be reused for protocol traffic.
   */
  readonly authorizeEditorProtocolOperation: (
    input: EditorProtocolAuthorizationRequestV1,
  ) => Effect.Effect<EditorProtocolAuthorizationLeaseV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Fresh Guard admission for each REPL call; start approval cannot authorize execution. */
  readonly authorizeReplOperation: (
    input: ReplOperationAuthorizationRequestV1,
  ) => Effect.Effect<ReplOperationAuthorizationLeaseV1, SessionSupervisorError, TrustedPrincipalContext>
  readonly replyGuardApproval: (input: {
    readonly approvalID: string
    readonly decision: GuardApprovalReplyDecisionV1
  }) => Effect.Effect<void, SessionSupervisorError, TrustedPrincipalContext>
  /**
   * Publishes and waits for a bounded complete set of HostKernel-minted verifier
   * challenges. It returns decisions only; leases are issued later by the single
   * atomic HostKernel resolve_approvals operation after the complete set is allowed.
   */
  readonly awaitManagedVerifierApprovals: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly sessionID?: string
    readonly challenges: ReadonlyArray<ManagedVerifierGuardChallengeV1>
  }) => Effect.Effect<ManagedVerifierApprovalCollectionV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Present one HostKernel-minted providers.infer challenge to the authenticated user,
   * then resolve that exact challenge through the dedicated managed-provider RPC. */
  readonly awaitManagedProviderApproval: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly scope: ManagedAttemptScopeV1
    readonly routeProjection: {
      readonly providerID: string
      readonly modelID: string
      readonly harnessID: string
      readonly routeID: string
      readonly endpointRevision: string
      readonly credentialLeaseRef: string | null
    }
    readonly requestPins: {
      readonly requestID: string
      readonly requestSequence: string
      readonly contextSelectionDigest: string
      readonly requestDigest: string
      readonly transportRequestDigest: string
      readonly operationDigest: string
    }
    readonly challenge: ManagedProviderGuardChallengeV1
  }) => Effect.Effect<ManagedProviderApprovalResultV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Publishes one exact P8 final-Inspect challenge, then resolves its one-use lease. */
  readonly awaitManagedRootApproval: (input: {
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly runID: string
    readonly challenge: ManagedRootGuardChallengeV1
  }) => Effect.Effect<EffectLease & { readonly locationID: string }, SessionSupervisorError, TrustedPrincipalContext>
  readonly prepareToolBatch: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly batchID: string
    readonly turnContextDigest: string
    readonly calls: ReadonlyArray<GuardedToolCall>
    /** Authenticated Core Config projection for `terminal.run` workspace profiles.
     * This is private RPC metadata and is never part of model tool arguments. */
    readonly workspaceCommandProfiles?: ReadonlyArray<{
      readonly callID: string
      readonly reference: { readonly profileId: string; readonly revision: string; readonly profileDigest: string; readonly action: "build" | "test" }
      readonly definition: unknown
      readonly resolvedEnvironment: Readonly<Record<string, string>>
    }>
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
  }) => Effect.Effect<EffectAdmission, SessionSupervisorError, TrustedPrincipalContext>
  readonly executeWrite: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly lease: EffectLease
    readonly content: string
    readonly directAttempt?: DirectAttemptScopeV1
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly trustedPrincipal: TrustedPrincipal
  }) => Effect.Effect<EffectReceipt, SessionSupervisorError>
  readonly executePatch: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly lease: EffectLease
    readonly operations: ReadonlyArray<PatchOperation>
    readonly directAttempt?: DirectAttemptScopeV1
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly trustedPrincipal: TrustedPrincipal
  }) => Effect.Effect<PatchReceipt, SessionSupervisorError>
  readonly runPatch: (input: {
    readonly sessionID: string
    readonly workspaceRoot: string
    readonly turnContextDigest: string
    readonly operations: ReadonlyArray<PatchOperation>
  }) => Effect.Effect<PatchReceipt, SessionSupervisorError, TrustedPrincipalContext>
  /**
   * Host-only authenticated RPC; never routes through a Session projection worker.
   * A refusal rejects with the host's typed code preserved on `SessionSupervisorError.hostCode`.
   */
  readonly requestHostKernel: (
    serviceID: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options?: {
      readonly cancelOnInterrupt?: boolean
      readonly deliveryID?: string
      /** Delegated identity captured from TrustedPrincipalContext middleware. */
      readonly trustedPrincipal?: TrustedPrincipal
      /** Private authenticated envelope context; only bounded RepoIntel, artifact and direct read-batch reads are allowed. */
      readonly authenticatedContext?: AuthenticatedRequestContextV1
      /**
       * Optional canonical envelope `requestID` (1..256 of `[A-Za-z0-9._:-]`).
       * Reserved for the P1-10 direct read path, which binds every projection row
       * to it; absent, the client mints its own `req_<uuid>` as before.
       */
      readonly requestID?: string
    },
  ) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError>
  /** Read-only handshake projection; effect adapters must fail closed when absent. */
  readonly hostFeatureEnabled: (feature: string) => Effect.Effect<boolean, SessionSupervisorError>
  /** Authenticated HostKernel projection of the current root Session workspace; carries no effect authority. */
  readonly directSessionWorkspaceSnapshot: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
  }) => Effect.Effect<DirectSessionWorkspaceSnapshotV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Exact durable receipt projection for one committed managed Guarded effect wave. */
  readonly managedEffectWaveReceipts: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly batchID: string
    readonly waveIndex: number
  }) => Effect.Effect<ManagedEffectWaveReceiptProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Mint a new current-owner observation while preserving the immutable terminal marker. */
  readonly managedCurrentEpochRecoveryQuiescence: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly parentSessionID: string
    readonly sessionID: string
    readonly observation: {
      readonly childSessionSequence: string
      readonly childSessionEventDigest: string
      readonly childSessionStateDigest: string
      readonly sessionStatus: "idle"
      readonly activePromptCount: 0
      readonly activeProviderTaskCount: 0
      readonly runningBackgroundTaskCount: 0
      readonly pendingToolCallCount: 0
      readonly incompleteAssistantMessageCount: 0
      readonly observationDigest: string
    }
  }) => Effect.Effect<ManagedCurrentEpochRecoveryQuiescenceV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Exact direct-root CodeMode terminal receipts; no synthetic Attempt identity is accepted. */
  readonly directCodeModeWaveReceipts: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly requestID: string
    readonly waveIndex: number
  }) => Effect.Effect<DirectCodeModeWaveReceiptProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Typed private call-correlation envelope for §37.24 CodeMode lifecycle RPCs. */
  readonly codeModeHostRequest: (input: {
    readonly operation: "codemode_enablement" | "codemode_start" | "codemode_resume" | "codemode_cancel" | "codemode_cancel_wave" | "codemode_inspect" | "codemode_prepare_wave" | "codemode_settle_tool_results" | "codemode_wave_receipts"
    readonly body: Readonly<Record<string, unknown>>
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly callID: string
    readonly lane: "direct_session" | "managed_attempt"
    readonly managedAttempt?: ManagedAttemptScopeV1
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Report bounded callback completion metadata; Rust binds it to the retained wave and issues tool_result provenance. */
  readonly settleCodeModeToolResults: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly callID: string
    readonly lane: "direct_session" | "managed_attempt"
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly requestID: string
    readonly waveIndex: number
    readonly results: ReadonlyArray<{
      readonly callIndex: number
      readonly callID: string
      readonly status: "settled" | "rejected" | "cancelled" | "unknown"
      readonly resultDigest?: string
      readonly outputBytes?: number
      readonly errorCode?: string
    }>
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Atomic CodeMode wave admission: the HostKernel returns ordinary ToolBatch challenges/leases only after its durable wave bind succeeds. */
  readonly prepareCodeModeToolBatch: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly callID: string
    readonly lane: "direct_session" | "managed_attempt"
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly requestID: string
    readonly waveFrame: Readonly<Record<string, unknown>>
    /** Exact Core SessionTools.resolve output after schema validation and prepare/normalization. */
    readonly calls: ReadonlyArray<CodeModeGuardedToolCall>
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Read exact terminal nested-call receipts; UNKNOWN carries no receipt fields. */
  readonly codeModeWaveReceipts: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly callID: string
    readonly lane: "direct_session" | "managed_attempt"
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly requestID: string
    readonly waveIndex: number
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Cancel only the exact retained wave; never infer a terminal outcome from AbortSignal alone. */
  readonly cancelCodeModeWave?: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly callID: string
    readonly lane: "direct_session" | "managed_attempt"
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly requestID: string
    readonly waveIndex: number
    readonly reason: "user_abort" | "deadline" | "parent_cancel"
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Resolve exact direct-Attempt terminal artifacts from durable Guard/ArtifactStore receipts. */
  readonly listDirectAttemptArtifacts: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly directAttempt: DirectAttemptScopeV1
  }) => Effect.Effect<DirectAttemptTerminalArtifactProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Resolve root DirectSession receipts from the HostKernel index and verified ArtifactStore. */
  readonly listDirectSessionArtifacts: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
  }) => Effect.Effect<DirectSessionTerminalArtifactProjectionV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Inspect root-session artifacts only through the exact direct-session receipt index. */
  readonly inspectDirectSessionArtifact: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly ownerEpoch: string
    readonly artifactRef: ArtifactRefWireV1
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Bounded root-session artifact range read through the exact direct-session receipt index. */
  readonly readDirectSessionArtifactRange: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly ownerEpoch: string
    readonly artifactRef: ArtifactRefWireV1
    readonly offset: string
    readonly maxBytes: number
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Generation-pinned RepoIntel read through the authenticated Rust boundary. */
  readonly queryRepoStructure?: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly query: Omit<typeof RepoStructureQueryV1.Type, "sourceGeneration">
  }) => Effect.Effect<typeof RepoStructurePageV1.Type, SessionSupervisorError, TrustedPrincipalContext>
  /** Bounded Guarded no-follow tree/manifest discovery; no app-process filesystem fallback. */
  readonly discoverRepo?: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly request: typeof RepoDiscoveryRequestV1.Type
  }) => Effect.Effect<typeof RepoDiscoveryPageV1.Type, SessionSupervisorError, TrustedPrincipalContext>
  /** Bounded authenticated source read for LSP synchronization; never an edit grant. */
  readonly readRepoDocument?: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly request: typeof RepoDocumentReadRequestV1.Type
  }) => Effect.Effect<typeof RepoDocumentReadResponseV1.Type, SessionSupervisorError, TrustedPrincipalContext>
  /** Read verifier artifacts only through the managed Attempt scope that owns the ref. */
  readonly inspectManagedArtifact?: (input: {
    readonly sessionID: string
    readonly managedAttempt: ManagedAttemptScopeV1
    readonly artifactRef: ArtifactRefWireV1
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Inspect a direct terminal artifact only after HostKernel re-derives its receipt from the live DirectAttempt. */
  readonly inspectDirectAttemptArtifact?: (input: {
    readonly sessionID: string
    readonly directAttempt: DirectAttemptScopeV1
    readonly artifactRef: ArtifactRefWireV1
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Resolve, without reading bytes, the terminal verified Attempt that durably owns a verifier artifact ref. */
  readonly resolveVerifiedManagedArtifactScope?: (input: {
    readonly sessionID: string
    readonly locationRef: typeof LocationSchema.Ref.Type
    readonly artifactRef: ArtifactRefWireV1
  }) => Effect.Effect<ManagedAttemptScopeV1, SessionSupervisorError, TrustedPrincipalContext>
  /** Read a bounded range from a verifier artifact; direct Attempt refs remain unavailable. */
  readonly readManagedArtifactRange?: (input: {
    readonly sessionID: string
    readonly managedAttempt: ManagedAttemptScopeV1
    readonly artifactRef: ArtifactRefWireV1
    readonly offset: string
    readonly maxBytes: number
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  /** Read a bounded range only through the exact DirectAttempt terminal receipt and ArtifactStore owner metadata. */
  readonly readDirectAttemptArtifactRange?: (input: {
    readonly sessionID: string
    readonly directAttempt: DirectAttemptScopeV1
    readonly artifactRef: ArtifactRefWireV1
    readonly offset: string
    readonly maxBytes: number
  }) => Effect.Effect<Readonly<Record<string, unknown>>, SessionSupervisorError, TrustedPrincipalContext>
  readonly hostOwnerEpoch: () => Effect.Effect<number, SessionSupervisorError>
  /** Current exact Rust SessionProjection cursor last durably acknowledged by Core. */
  readonly sessionProjectionCursor: (sessionID: string) => Effect.Effect<Cursor, SessionSupervisorError>
  /** Subscribe to terminal events over the host connection with bounded backpressure. */
  readonly subscribeHostKernelEvents: (input: {
    readonly terminalID: string
    readonly generation: number
    readonly after: Cursor
    readonly capacity?: number
  }) => Stream.Stream<HostKernelStreamMessage, SessionSupervisorError>
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

function fail(stage: string, reason: string, approvalCode?: GuardApprovalErrorCode, hostCode?: string) {
  return new SessionSupervisorError({
    stage,
    reason,
    ...(approvalCode === undefined ? {} : { approvalCode }),
    ...(hostCode === undefined ? {} : { hostCode }),
  })
}

const MAX_MANAGED_VERIFIER_APPROVALS = 16
const MAX_MANAGED_VERIFIER_CHALLENGES = 32
const MAX_GUARD_SUMMARY_BYTES = 512
const MAX_GUARD_METADATA_BYTES = 128 * 1024
const MAX_GUARD_GUARANTEES = 16
const MANAGED_VERIFIER_CHALLENGE_KEYS = [
  "allowEnabled",
  "argumentSummary",
  "capabilityID",
  "challengeID",
  "effectID",
  "expiresAtUnixMs",
  "guaranteeAssessment",
  "inputDigest",
  "locationID",
  "noResponse",
  "normalizedAction",
  "normalizedTargets",
  "origin",
  "policyDigest",
  "policyID",
  "policySummary",
  "requestedGuarantees",
  "runID",
  "source",
] as const

/** Parse only host-generated, bounded consent context. Never infer a missing assessment. */
type ValidatedGuardConsentProjection<
  Origin extends GuardApprovalOriginV1,
  Source extends GuardApprovalSourceV1,
  RunID extends string | undefined,
  CapabilityID extends string,
> = Omit<
  Pick<
    GuardApprovalRequest,
    | "origin"
    | "source"
    | "policyID"
    | "policyDigest"
    | "normalizedAction"
    | "argumentSummary"
    | "requestedGuarantees"
    | "guaranteeAssessment"
    | "runID"
    | "noResponse"
    | "allowEnabled"
    | "routePlanDigest"
  >,
  "origin" | "source" | "runID" | "normalizedAction"
> & {
  readonly origin: Origin
  readonly source: Source
  readonly normalizedAction: string
} & (RunID extends string ? { readonly runID: RunID } : { readonly runID?: undefined })

function validateGuardConsentProjection<
  const Origin extends GuardApprovalOriginV1,
  const Source extends GuardApprovalSourceV1,
  const RunID extends string | undefined = undefined,
  const CapabilityID extends string = string,
>(
  value: Record<string, unknown>,
  input: {
    readonly capabilityID: CapabilityID
    readonly normalizedAction?: string
    readonly origin: Origin
    readonly source: Source
    readonly runID?: RunID
  },
): ValidatedGuardConsentProjection<Origin, Source, RunID, CapabilityID> {
  const policyID = stringField(value, "policyID", 128)
  const policyDigest = stringField(value, "policyDigest")
  const normalizedAction = stringField(value, "normalizedAction", 128)
  const routePlanDigest = value.routePlanDigest
  if (
    input.capabilityID === "web.search"
      ? typeof routePlanDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(routePlanDigest)
      : routePlanDigest !== undefined
  ) {
    throw fail("protocol", "Guard route-plan authority is missing or unexpected")
  }
  if (value.argumentSummary === undefined) throw fail("protocol", "Guard argument summary is missing")
  if (value.guaranteeAssessment === undefined) throw fail("protocol", "Guard guarantee assessment is missing")
  const rawSummary = record(value.argumentSummary)
  const rawAssessment = record(value.guaranteeAssessment)
  const requested = value.requestedGuarantees
  const runID = value.runID
  const expectedNormalizedAction = input.normalizedAction ?? input.capabilityID
  let argumentSummary: GuardArgumentSummaryV1
  if (rawSummary.status === "available") {
    if (Object.keys(rawSummary).toSorted().join("\0") !== "status\0text") {
      throw fail("protocol", "Guard argument summary has an invalid shape")
    }
    const summary = stringField(rawSummary, "text", MAX_GUARD_SUMMARY_BYTES)
    if (summary.trim().length === 0) throw fail("protocol", "Guard argument summary is empty")
    argumentSummary = { status: "available", text: summary }
  } else if (rawSummary.status === "unavailable") {
    if (Object.keys(rawSummary).toSorted().join("\0") !== "reason\0status") {
      throw fail("protocol", "Guard argument summary has an invalid shape")
    }
    argumentSummary = { status: "unavailable", reason: stringField(rawSummary, "reason", 256) }
  } else {
    throw fail("protocol", "Guard argument summary is missing")
  }
  let guaranteeAssessment: GuardGuaranteeAssessmentV1
  if (rawAssessment.status === "assessed") {
    if (Object.keys(rawAssessment).toSorted().join("\0") !== "residual\0status") {
      throw fail("protocol", "Guard guarantee assessment has an invalid shape")
    }
    const residual = rawAssessment.residual
    if (!Array.isArray(residual) || residual.length > MAX_GUARD_GUARANTEES) {
      throw fail("protocol", "Guard residual guarantees exceed their bound")
    }
    const residualIDs = residual.map((id) => {
      if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) {
        throw fail("protocol", "Guard residual guarantee is invalid")
      }
      return id
    })
    guaranteeAssessment = { status: "assessed", residual: residualIDs }
  } else if (rawAssessment.status === "not_assessed") {
    if (
      Object.keys(rawAssessment).toSorted().join("\0") !== "residual\0status" ||
      rawAssessment.residual !== null
    ) {
      throw fail("protocol", "Unassessed Guard guarantees must have a null residual")
    }
    guaranteeAssessment = { status: "not_assessed", residual: null }
  } else {
    throw fail("protocol", "Guard guarantee assessment is missing")
  }
  if (
    !/^[a-z][a-z0-9._-]{0,127}$/.test(policyID) ||
    !/^blake3:[0-9a-f]{64}$/.test(policyDigest) ||
    normalizedAction !== expectedNormalizedAction ||
    value.origin !== input.origin ||
    value.source !== input.source ||
    !Array.isArray(requested) ||
    requested.length === 0 ||
    requested.length > MAX_GUARD_GUARANTEES ||
    value.noResponse !== "deny_and_expire" ||
    typeof value.allowEnabled !== "boolean" ||
    (input.runID === undefined ? runID !== undefined : runID !== input.runID)
  ) {
    throw fail("protocol", "Guard consent projection is incomplete or mismatched")
  }
  const requestedIDs = requested.map((id) => {
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) {
      throw fail("protocol", "Guard requested guarantee is invalid")
    }
    return id
  })
  if (new Set(requestedIDs).size !== requestedIDs.length) {
    throw fail("protocol", "Guard requested guarantees contain duplicates")
  }
  if (
    guaranteeAssessment.status === "assessed" &&
    (new Set(guaranteeAssessment.residual).size !== guaranteeAssessment.residual.length ||
      guaranteeAssessment.residual.some((id) => !requestedIDs.includes(id)))
  ) {
    throw fail("protocol", "Guard residual guarantee assessment does not match its request")
  }
  const allowEligible =
    guaranteeAssessment.status === "assessed" && argumentSummary.status === "available"
  if (value.allowEnabled !== allowEligible) {
    throw fail("protocol", "Guard allow availability does not match its assessed context")
  }
  const encoded = JSON.stringify(value, (_key, child) => (typeof child === "bigint" ? child.toString() : child))
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_GUARD_METADATA_BYTES) {
    throw fail("protocol", "Guard approval projection exceeds its payload bound")
  }
  return {
    origin: input.origin,
    source: input.source,
    policyID,
    policyDigest,
    normalizedAction,
    argumentSummary,
    requestedGuarantees: requestedIDs,
    guaranteeAssessment,
    ...(input.runID === undefined ? {} : { runID: input.runID }),
    noResponse: "deny_and_expire",
    allowEnabled: value.allowEnabled,
    ...(typeof routePlanDigest === "string" ? { routePlanDigest } : {}),
  } as unknown as ValidatedGuardConsentProjection<Origin, Source, RunID, CapabilityID>
}

/** Validate the complete challenge set before any approval event becomes visible. */
export function validateManagedVerifierChallenges(
  registeredLocationID: string,
  challenges: ReadonlyArray<ManagedVerifierGuardChallengeV1>,
): ReadonlyArray<ManagedVerifierGuardChallengeV1> {
  if (!/^loc_[0-9a-f]{64}$/.test(registeredLocationID)) {
    throw fail("protocol", "registered Location ID is invalid")
  }
  if (!Array.isArray(challenges) || challenges.length === 0 || challenges.length > MAX_MANAGED_VERIFIER_CHALLENGES) {
    throw fail("protocol", "verifier challenge set exceeds the managed criteria bound")
  }
  const challengeIDs = new Set<string>()
  const effectIDs = new Set<string>()
  const now = Date.now()
  const validated = challenges.map((candidate) => {
    const value = record(candidate)
    if (Object.keys(value).toSorted().join("\0") !== [...MANAGED_VERIFIER_CHALLENGE_KEYS].sort().join("\0")) {
      throw fail("protocol", "verifier challenge has an invalid shape")
    }
    const challengeID = stringField(value, "challengeID")
    const effectID = stringField(value, "effectID")
    const locationID = stringField(value, "locationID")
    const policySummary = stringField(value, "policySummary", 512)
    const inputDigest = stringField(value, "inputDigest")
    const targets = value.normalizedTargets
    const runID = stringField(value, "runID", MAX_IDENTIFIER_BYTES)
    const consent = validateGuardConsentProjection(value, {
      capabilityID: "builtin.verifier",
      normalizedAction: "builtin.verifier",
      origin: "managed_run",
      source: "host.managed_verifier",
      runID,
    })
    if (locationID !== registeredLocationID) {
      throw fail("protocol", "verifier challenge is not bound to the registered Location")
    }
    if (
      !/^[A-Za-z0-9._-]{1,256}$/.test(challengeID) ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(effectID) ||
      value.capabilityID !== "builtin.verifier" ||
      !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
      !Array.isArray(targets) ||
      targets.length === 0 ||
      targets.length > 64 ||
      !Number.isSafeInteger(value.expiresAtUnixMs) ||
      (value.expiresAtUnixMs as number) <= now ||
      (value.expiresAtUnixMs as number) > now + 5 * 60 * 1000 ||
      Buffer.byteLength(JSON.stringify(targets), "utf8") > 64 * 1024 ||
      policySummary.trim().length === 0 ||
      consent.allowEnabled !== false ||
      consent.guaranteeAssessment.status !== "not_assessed" ||
      consent.guaranteeAssessment.residual !== null ||
      consent.requestedGuarantees.length > 16
    ) {
      throw fail("protocol", "verifier challenge is invalid or exceeds bounds")
    }
    if (challengeIDs.has(challengeID) || effectIDs.has(effectID)) {
      throw fail("protocol", "verifier challenge set contains a duplicate challenge or effect")
    }
    challengeIDs.add(challengeID)
    effectIDs.add(effectID)
    return {
      challengeID,
      effectID,
      capabilityID: "builtin.verifier" as const,
      locationID,
      inputDigest,
      normalizedTargets: targets as ReadonlyArray<unknown>,
      expiresAtUnixMs: value.expiresAtUnixMs as number,
      policySummary,
      origin: consent.origin,
      source: consent.source,
      policyID: consent.policyID,
      policyDigest: consent.policyDigest,
      normalizedAction: "builtin.verifier" as const,
      argumentSummary: consent.argumentSummary,
      requestedGuarantees: consent.requestedGuarantees,
      guaranteeAssessment: consent.guaranteeAssessment,
      runID: consent.runID,
      noResponse: "deny_and_expire" as const,
      allowEnabled: false as const,
    } satisfies ManagedVerifierGuardChallengeV1
  })
  return validated
}

const MANAGED_ROOT_INSPECT_GUARANTEES = [
  "configured_executable",
  "bounded_argv_env",
  "beneath_workspace_root",
  "one_use",
] as const

/** Validate the single HostKernel-minted final Inspect consent projection. */
export function validateManagedRootGuardChallenge(
  registeredLocationID: string,
  raw: unknown,
): ManagedRootGuardChallengeV1 {
  if (!/^loc_[0-9a-f]{64}$/.test(registeredLocationID)) {
    throw fail("protocol", "managed-root Location ID is invalid")
  }
  const value = record(raw)
  const expectedKeys = [
    "status", "challengeID", "effectID", "capabilityID", "locationID", "inputDigest", "targets",
    "normalizedTargets", "expiresAtUnixMs", "policySummary", "origin", "source", "policyID", "policyDigest",
    "normalizedAction", "argumentSummary", "requestedGuarantees", "guaranteeAssessment", "noResponse", "allowEnabled",
  ].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== expectedKeys.join("\0") || value.status !== "needs_approval") {
    throw fail("protocol", "managed-root Guard challenge has an invalid shape")
  }
  const challengeID = stringField(value, "challengeID", MAX_IDENTIFIER_BYTES)
  const effectID = stringField(value, "effectID", MAX_IDENTIFIER_BYTES)
  const locationID = stringField(value, "locationID", MAX_IDENTIFIER_BYTES)
  const inputDigest = stringField(value, "inputDigest")
  const policySummary = stringField(value, "policySummary", 1024)
  const normalizedTargets = value.normalizedTargets
  const targets = value.targets
  const expiresAtUnixMs = wireUnixMs(value.expiresAtUnixMs)
  const consent = validateGuardConsentProjection(value, {
    capabilityID: "git.worktree.list",
    origin: "managed_root",
    source: "host.managed_worktree",
  })
  if (
    !/^[A-Za-z0-9._-]{1,256}$/.test(challengeID) ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(effectID) ||
    locationID !== registeredLocationID ||
    value.capabilityID !== "git.worktree.list" ||
    !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
    !Array.isArray(normalizedTargets) || normalizedTargets.length !== 1 ||
    !Array.isArray(targets) || JSON.stringify(targets) !== JSON.stringify(normalizedTargets) ||
    Buffer.byteLength(JSON.stringify(normalizedTargets), "utf8") > 64 * 1024 ||
    expiresAtUnixMs === undefined || expiresAtUnixMs <= Date.now() || expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
    policySummary.trim().length === 0 || consent.policyID !== "broker-process.local.v1" ||
    consent.requestedGuarantees.join("\0") !== MANAGED_ROOT_INSPECT_GUARANTEES.join("\0") ||
    consent.guaranteeAssessment.status === "assessed" && consent.guaranteeAssessment.residual.length > 0
  ) {
    throw fail("protocol", "managed-root Guard challenge does not match the exact final Inspect policy")
  }
  return {
    ...consent,
    challengeID,
    effectID,
    capabilityID: "git.worktree.list" as const,
    locationID,
    inputDigest,
    normalizedTargets: normalizedTargets as ReadonlyArray<unknown>,
    expiresAtUnixMs,
    policySummary,
    origin: "managed_root",
    source: "host.managed_worktree",
    normalizedAction: "git.worktree.list" as const,
  } satisfies ManagedRootGuardChallengeV1
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

function parseCodeModeHelperManifest(input: string): CodeModeHelperManifest {
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(input))
  } catch {
    throw fail("manifest", "embedded CodeMode helper manifest is malformed")
  }
  const common = ["helperSelector", "relativeEntrypoint", "schemaVersion", "sha256", "status", "target"]
  const expected = value.status === "unavailable" ? [...common, "reason"].toSorted() : [...common].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== expected.join("\0") || value.schemaVersion !== 1 ||
    value.helperSelector !== "horizoncode:codemode:bun" || value.relativeEntrypoint !== "codemode-helper.js" ||
    typeof value.target !== "string") {
    throw fail("manifest", "CodeMode helper manifest has an unsupported or non-canonical shape")
  }
  if (value.status === "unavailable") {
    if (value.sha256 !== null || typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 1024) {
      throw fail("manifest", "unavailable CodeMode helper manifest is invalid")
    }
    return {
      schemaVersion: 1,
      status: "unavailable",
      helperSelector: "horizoncode:codemode:bun",
      relativeEntrypoint: "codemode-helper.js",
      sha256: null,
      target: value.target,
      reason: value.reason,
    }
  }
  if (value.status !== "available" || typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.sha256) ||
    !/^linux-(x64|arm64)-gnu$/.test(value.target)) {
    throw fail("manifest", "available CodeMode helper manifest is invalid")
  }
  return {
    schemaVersion: 1,
    status: "available",
    helperSelector: "horizoncode:codemode:bun",
    relativeEntrypoint: "codemode-helper.js",
    sha256: value.sha256 as `sha256:${string}`,
    target: value.target,
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
  binaryName: "session_supervisor" | "hz-kernel" = "session_supervisor",
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
  const pin = () => {
    const path = verify()
    pinSupervisorExecutable({ path, binaryName, sha256: expectedDigest })
    return path
  }
  if (existsSync(target)) return pin()

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
  return pin()
}

function installPrivateAsset(root: string, name: "codemode-helper.js" | "codemode-helper.manifest.json", bytes: Uint8Array) {
  const target = join(root, name)
  try {
    const existing = lstatSync(target)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
      (process.getuid && existing.uid !== process.getuid()) || (existing.mode & 0o077) !== 0 || realpathSync(target) !== target) {
      throw fail("helper-install", "existing CodeMode helper asset is not a private regular file")
    }
  } catch (error) {
    if (error instanceof SessionSupervisorError) throw error
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
  }
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`)
  try {
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, target)
    const directory = openSync(root, "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    if (error instanceof SessionSupervisorError) throw error
    throw fail("helper-install", "could not atomically install the pinned CodeMode helper asset")
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

async function installBundledCodeModeHelper(input: {
  readonly assetPath?: string
  readonly manifestJSON?: string
  readonly installRoot?: string
}): Promise<string | undefined> {
  if (!input.manifestJSON) return undefined
  const manifest = parseCodeModeHelperManifest(input.manifestJSON)
  if (manifest.status === "unavailable" || process.platform !== "linux" || manifest.target !== `linux-${process.arch}-gnu`) {
    return undefined
  }
  if (!input.assetPath || !input.installRoot) throw fail("helper-install", "available CodeMode helper manifest is missing its embedded asset or install root")
  const bytes = await Bun.file(input.assetPath).bytes()
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) throw fail("helper-install", "embedded CodeMode helper asset is empty or exceeds its bound")
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  if (actualDigest !== manifest.sha256) throw fail("helper-install", "embedded CodeMode helper does not match its build manifest")
  const root = ensurePrivateDirectory(input.installRoot, "helper-install")
  installPrivateAsset(root, "codemode-helper.js", bytes)
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")
  if (manifestBytes.byteLength > 4 * 1024) throw fail("helper-install", "CodeMode helper manifest exceeds its bound")
  // Publish the manifest last. During an update a concurrent HostKernel can
  // observe a digest mismatch and remain unavailable, but cannot run a mixed pair.
  installPrivateAsset(root, "codemode-helper.manifest.json", manifestBytes)
  pinCodeModeHelperRoot({ path: root, sha256: manifest.sha256! })
  return root
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

// Rust encodes unsigned integers with the smallest MessagePack form, so a deadline far in the
// future arrives as `uint64` and msgpackr decodes that as BigInt. A safe-integer-only reader
// would reject every real host challenge; Core's own writer already sends the same wire type
// as BigInt (`deadlineUnixMs`).
export function wireUnixMs(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
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
      (parsed.operation !== "write" && parsed.operation !== "delete" && parsed.operation !== "run") ||
      typeof parsed.existed !== "boolean" ||
      (parsed.operation === "run" && parsed.executable !== undefined)
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

type ParsedBatchMember = {
  readonly callID: string
  readonly capabilityID: string
  readonly challengeID: string
  readonly effectID: string
  readonly challenge: EffectChallenge
  readonly request: GuardApprovalRequest
}

/**
 * Read one member field that the host may spell with either the request-style or the
 * response-style identifier (`callID`/`callId`, `capabilityID`/`capabilityId`). The single
 * spelling is not yet frozen across the host boundary, so both are accepted while the
 * value itself stays strictly validated.
 */
function batchField(
  entry: Record<string, unknown>,
  primary: string,
  alias: string,
  maxBytes = 256,
): string {
  return primary in entry ? stringField(entry, primary, maxBytes) : stringField(entry, alias, maxBytes)
}

function validBatchIdentity(value: string) {
  return /^[A-Za-z0-9._-]{1,256}$/.test(value)
}

function validateWorkspaceCommandProjections(
  calls: ReadonlyArray<GuardedToolCall>,
  projections: ReadonlyArray<{
    readonly callID: string
    readonly reference: { readonly profileId: string; readonly revision: string; readonly profileDigest: string; readonly action: "build" | "test" }
    readonly definition: unknown
    readonly resolvedEnvironment: Readonly<Record<string, string>>
  }> | undefined,
): void {
  const profileCalls = new Set<string>()
  for (const call of calls) {
    if (call.capabilityID !== "terminal.run") continue
    const args = record(call.arguments)
    if (args.mode === "workspace_profile") profileCalls.add(call.callID)
  }
  if (!projections?.length) {
    if (profileCalls.size) throw fail("protocol", "workspace command profile projection is missing")
    return
  }
  if (projections.length > MAX_TOOL_BATCH_CALLS) throw fail("protocol", "workspace command profile projection exceeds the call bound")
  const seen = new Set<string>()
  for (const item of projections) {
    if (!item || !validBatchIdentity(item.callID) || seen.has(item.callID) || !profileCalls.has(item.callID)) {
      throw fail("protocol", "workspace command profile projection has an invalid call binding")
    }
    seen.add(item.callID)
    const ref = item.reference
    if (!ref || !validBatchIdentity(ref.profileId) || !/^[1-9][0-9]{0,19}$/.test(ref.revision) ||
      !/^blake3:[0-9a-f]{64}$/.test(ref.profileDigest) || !["build", "test"].includes(ref.action)) {
      throw fail("protocol", "workspace command profile reference is invalid")
    }
    const definition = record(item.definition)
    if (definition.profileId !== ref.profileId || definition.revision !== ref.revision ||
      definition.profileDigest !== ref.profileDigest || definition.enabled !== true ||
      !Array.isArray(definition.actions) || !definition.actions.includes(ref.action)) {
      throw fail("protocol", "workspace command profile definition does not match its selected reference")
    }
    if (!item.resolvedEnvironment || typeof item.resolvedEnvironment !== "object" || Array.isArray(item.resolvedEnvironment)) {
      throw fail("protocol", "workspace command profile environment is invalid")
    }
    const environment = definition.environment as Record<string, unknown> | null | undefined
    const allowedNames = new Set<unknown>(
      environment !== null && environment !== undefined && typeof environment === "object" && !Array.isArray(environment) &&
        Array.isArray(environment.allowedNames)
        ? environment.allowedNames
        : [],
    )
    for (const [name, value] of Object.entries(item.resolvedEnvironment)) {
      if (!allowedNames.has(name) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096) {
        throw fail("protocol", "workspace command profile environment exceeds its configured allowlist")
      }
    }
  }
  if (seen.size !== profileCalls.size) throw fail("protocol", "workspace command profile calls and projections differ")
}

/** Apply the Rust EffectHost ToolBatch envelope limits before packing or sending IPC. */
function validateToolBatchCalls(calls: ReadonlyArray<GuardedToolCall>): void {
  if (calls.length === 0 || calls.length > MAX_TOOL_BATCH_CALLS) {
    throw fail("protocol", "ToolBatch call count is outside the supported bound")
  }
  const callIDs = new Set<string>()
  let totalBytes = 0
  for (const call of calls) {
    if (
      typeof call !== "object" ||
      call === null ||
      !validBatchIdentity(call.callID) ||
      !validBatchIdentity(call.capabilityID) ||
      callIDs.has(call.callID)
    ) {
      throw fail("protocol", "ToolBatch contains an invalid or duplicate call identity")
    }
    callIDs.add(call.callID)
    let encodedBytes: number
    try {
      // Match EffectHost's encoded_len(call): include the call/capability identity map,
      // not only the arguments, and use the same MessagePack codec as the host request.
      encodedBytes = pack({
        callId: call.callID,
        capabilityId: call.capabilityID,
        arguments: call.arguments,
      }).byteLength
    } catch {
      throw fail("protocol", "ToolBatch arguments cannot be encoded")
    }
    if (encodedBytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
      throw fail("protocol", "ToolBatch member exceeds the encoded argument bound")
    }
    if (encodedBytes > MAX_TOOL_BATCH_ARGUMENT_BYTES - totalBytes) {
      throw fail("protocol", "ToolBatch exceeds the aggregate encoded argument bound")
    }
    totalBytes += encodedBytes
  }
}

/**
 * Parse the guard owner's complete multi-call `calls[]` challenge response. Every member
 * must map one-to-one onto the requested calls: a missing, duplicated, reordered into an
 * unknown call, capability-swapped or malformed member refuses the complete batch. The
 * parse is side-effect free; callers cancel defensively because a mismatch may still mean
 * the host prepared durable members.
 */
function parseMultiCallChallenges(input: {
  readonly sessionID: string
  readonly batchID: string
  readonly locationID: string
  readonly calls: ReadonlyArray<GuardedToolCall>
  readonly response: Readonly<Record<string, unknown>>
}): ParsedBatchMember[] {
  if (input.calls.length < 2 || input.calls.length > MAX_TOOL_BATCH_CALLS) {
    throw fail("protocol", "multi-call Guard relay call count is outside the supported bound")
  }
  const rawCalls = input.response.calls
  if (!Array.isArray(rawCalls) || rawCalls.length !== input.calls.length) {
    throw fail("protocol", "Rust returned a mismatched multi-call Guard challenge")
  }
  const requested = new Map(input.calls.map((member) => [member.callID, member]))
  if (
    requested.size !== input.calls.length ||
    input.calls.some((member) => !validBatchIdentity(member.callID) || !validBatchIdentity(member.capabilityID))
  ) {
    throw fail("protocol", "requested multi-call Guard batch has invalid identities")
  }
  const now = Date.now()
  const members: ParsedBatchMember[] = []
  const seen = new Set<string>()
  const seenChallengeIDs = new Set<string>()
  const seenEffectIDs = new Set<string>()
  for (const raw of rawCalls) {
    const entry = record(raw)
    const callID = batchField(entry, "callId", "callID", MAX_IDENTIFIER_BYTES)
    if (!validBatchIdentity(callID)) {
      throw fail("protocol", "Rust returned an invalid multi-call identity")
    }
    const call = requested.get(callID)
    if (!call || seen.has(callID)) {
      throw fail("protocol", "Rust returned a mismatched multi-call Guard challenge")
    }
    seen.add(callID)
    const capabilityID = batchField(entry, "capabilityId", "capabilityID", MAX_IDENTIFIER_BYTES)
    if (
      !validBatchIdentity(capabilityID) ||
      capabilityID !== call.capabilityID ||
      entry.locationID !== input.locationID
    ) {
      throw fail("protocol", "Rust returned a mismatched multi-call Guard challenge")
    }
    const challengeID = batchField(entry, "challengeId", "challengeID", MAX_IDENTIFIER_BYTES)
    const effectID = batchField(entry, "effectId", "effectID", MAX_IDENTIFIER_BYTES)
    if (
      !validBatchIdentity(challengeID) ||
      !validBatchIdentity(effectID) ||
      seenChallengeIDs.has(challengeID) ||
      seenEffectIDs.has(effectID)
    ) {
      throw fail("protocol", "Rust returned duplicate or invalid multi-call effect identities")
    }
    seenChallengeIDs.add(challengeID)
    seenEffectIDs.add(effectID)
    const inputDigest = batchField(entry, "inputDigest", "inputDigest")
    const challengeLocationID = batchField(entry, "locationID", "locationId", 4096)
    const expiresAtUnixMs = wireUnixMs(entry.expiresAtUnixMs)
    const normalizedTargets = entry.normalizedTargets
    const policySummary = batchField(entry, "policySummary", "policySummary", 1024)
    const consent = validateGuardConsentProjection(entry, {
      capabilityID,
      origin: "session_batch",
      source: "core.tool_batch",
    })
    if (
      challengeID.length === 0 ||
      effectID.length === 0 ||
      !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
      challengeLocationID !== input.locationID ||
      expiresAtUnixMs === undefined ||
      expiresAtUnixMs <= now ||
      expiresAtUnixMs > now + 5 * 60 * 1000 ||
      !Array.isArray(normalizedTargets) ||
      normalizedTargets.length === 0 ||
      normalizedTargets.length > 64
    ) {
      throw fail("protocol", "Rust returned incomplete multi-call Guard approval metadata")
    }
    const targets = Array.isArray(entry.targets)
      ? parseEffectTargets(entry.targets, call.capabilityID === "files.patch")
      : typeof entry.existed === "boolean"
        ? [
            {
              target: stringField(entry, "target", 4096),
              resource: stringField(entry, "resource", 4096),
              operation: "write" as const,
              existed: entry.existed,
            },
          ]
        : []
    if (targets.length === 0) {
      throw fail("protocol", "Rust returned incomplete multi-call Guard approval metadata")
    }
    const challenge: EffectChallenge = {
      challengeID,
      effectID,
      target: targets[0]!.target,
      resource: targets[0]!.resource,
      existed: targets[0]!.existed,
      targets,
      approval: {
        capabilityID,
        locationID: input.locationID,
        inputDigest,
        normalizedTargets,
        expiresAtUnixMs,
        policySummary,
        consent,
      },
    }
    members.push({
      callID,
      capabilityID,
      challengeID,
      effectID,
      challenge,
      request: {
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID,
        effectID,
        capabilityID,
        locationID: input.locationID,
        sessionID: input.sessionID,
        inputDigest,
        normalizedTargets,
        expiresAtUnixMs,
        policySummary,
        ...consent,
      },
    })
  }
  // The member count already equals the requested count, so an unclaimed request would mean
  // a duplicate that replaced a real member; refuse rather than admit a partial batch.
  if (seen.size !== requested.size) {
    throw fail("protocol", "Rust returned a mismatched multi-call Guard challenge")
  }
  return members
}

/**
 * Relay one complete multi-call ToolBatch admission: ask one explicit approval per member,
 * resolve every approved member to its own one-use lease and cancel the complete batch
 * whenever anything denies, expires, mismatches or fails. Nothing is executed here, and no
 * lease is returned unless every member was approved and resolved.
 */
export function relayMultiCallToolBatch(
  input: {
    readonly sessionID: string
    readonly batchID: string
    readonly locationID: string
    readonly calls: ReadonlyArray<GuardedToolCall>
    readonly response: Readonly<Record<string, unknown>>
  },
  port: ToolBatchRelayPort,
): Effect.Effect<EffectAdmission, SessionSupervisorError> {
  return Effect.gen(function* () {
    // Cancellation is best-effort and lazy: it is invoked only when the batch actually
    // needs cancelling, so a host that cannot cancel yet never masks the original typed
    // failure, and the un-executed members expire on their own durable TTL.
    const cancel = Effect.suspend(() =>
      port.cancelBatch({ sessionID: input.sessionID, batchID: input.batchID }),
    ).pipe(Effect.catch(() => Effect.void))
    const members = yield* Effect.try({
      try: () => parseMultiCallChallenges(input),
      catch: (error) =>
        error instanceof SessionSupervisorError
          ? error
          : fail("protocol", "Rust returned an invalid multi-call Guard challenge"),
    }).pipe(Effect.tapError(() => cancel))
    const challengeIDs = members.map((member) => member.challengeID)
    const preflightRequest = {
      sessionID: input.sessionID,
      locationID: input.locationID,
      batchID: input.batchID,
      challengeIDs,
    }
    // A stored exact grant is only a quiet-prompt hint here. HostKernel's later
    // approval-set transaction is authoritative and can still reject stale scope.
    const grantCandidate = (port.preflightDirectGrant
      ? yield* port.preflightDirectGrant(preflightRequest).pipe(Effect.catch(() => Effect.succeed(false)))
      : false) && members.every((member) => member.request.allowEnabled)
    const decisions = grantCandidate
      ? members.map(() => "allow_once" as const)
      : yield* Effect.forEach(members, (member) => port.requestApproval(member.request), {
          concurrency: "unbounded",
        }).pipe(Effect.tapError(() => cancel))
    if (decisions.some((decision) => decision !== "allow_once") ||
      (!grantCandidate && members.some((member) => !member.request.allowEnabled))) {
      yield* cancel
      return { status: "denied" as const, reason: "Guard approval was denied" }
    }
    const approvalSet = yield* port.resolveApprovalSet({
      sessionID: input.sessionID,
      locationID: input.locationID,
      batchID: input.batchID,
      challengeIDs,
    }).pipe(Effect.tapError(() => cancel))
    const serializedAttempt = approvalSet.nextLeaseRequired === true
    if (serializedAttempt && (!approvalSet.directAttempt && !approvalSet.managedAttempt)) {
      yield* cancel
      return yield* Effect.fail(fail("protocol", "HostKernel requested serial leases without an Attempt scope"))
    }
    const leasesByChallenge = new Map<string, EffectLease>()
    for (const item of approvalSet.leases) {
      if (
        !validBatchIdentity(item.challengeID) ||
        leasesByChallenge.has(item.challengeID) ||
        !item.lease ||
        !validBatchIdentity(item.lease.effectID) ||
        !/^blake3:[0-9a-f]{64}$/.test(item.lease.capabilityLeaseDigest)
      ) {
        yield* cancel
        return yield* Effect.fail(fail("protocol", "approval set returned an invalid or duplicate lease"))
      }
      leasesByChallenge.set(item.challengeID, item.lease)
    }
    if (leasesByChallenge.size !== (serializedAttempt ? 1 : members.length)) {
      yield* cancel
      return yield* Effect.fail(fail("protocol", "approval set returned an incomplete or over-issued lease set"))
    }
    const calls: ToolBatchCallLease[] = []
    const seenEffectIDs = new Set<string>()
    const seenLeaseDigests = new Set<string>()
    for (const [index, member] of members.entries()) {
      const lease = leasesByChallenge.get(member.challengeID)
      if (!lease && (!serializedAttempt || index === 0)) {
        yield* cancel
        return yield* Effect.fail(fail("protocol", "approval set omitted a challenged effect"))
      }
      if (lease && (
        typeof lease !== "object" ||
        lease === null ||
        !validBatchIdentity(lease.effectID) ||
        !/^blake3:[0-9a-f]{64}$/.test(lease.capabilityLeaseDigest) ||
        lease.effectID !== member.effectID ||
        seenEffectIDs.has(lease.effectID) ||
        seenLeaseDigests.has(lease.capabilityLeaseDigest)
      )) {
        yield* cancel
        return yield* Effect.fail(fail("protocol", "approval lease is invalid, duplicate, or mismatched"))
      }
      if (lease) {
        seenEffectIDs.add(lease.effectID)
        seenLeaseDigests.add(lease.capabilityLeaseDigest)
      }
      calls.push({ callID: member.callID, capabilityID: member.capabilityID, ...(lease ? { lease } : {}) })
    }
    let nextIndex = 1
    const leaseNext = serializedAttempt
      ? (request: { readonly callID: string; readonly previousEffectID: string }) => Effect.gen(function* () {
          const member = members[nextIndex]
          if (!member || member.callID !== request.callID || !validBatchIdentity(request.previousEffectID) || !port.leaseNextEffect) {
            yield* cancel
            return yield* Effect.fail(fail("protocol", "Attempt batch next-lease order is invalid"))
          }
          const response = yield* port.leaseNextEffect({
            sessionID: input.sessionID,
            locationID: input.locationID,
            batchID: input.batchID,
            previousEffectID: request.previousEffectID,
          }).pipe(Effect.tapError(() => cancel))
          if (response.challengeID !== member.challengeID || response.lease.effectID !== member.effectID ||
              !/^blake3:[0-9a-f]{64}$/.test(response.lease.capabilityLeaseDigest)) {
            yield* cancel
            return yield* Effect.fail(fail("protocol", "HostKernel returned a lease outside the ordered Attempt batch"))
          }
          nextIndex += 1
          return { callID: member.callID, capabilityID: member.capabilityID, lease: response.lease }
        })
      : undefined
    return {
      status: "prepared_batch" as const,
      calls,
      ...(leaseNext ? { leaseNext } : {}),
      ...(approvalSet.directAttempt ? { directAttempt: approvalSet.directAttempt } : {}),
      ...(approvalSet.directTurnScope ? { directTurnScope: approvalSet.directTurnScope } : {}),
      ...(approvalSet.managedAttempt ? { managedAttempt: approvalSet.managedAttempt } : {}),
    }
  }).pipe(
    Effect.onInterrupt(() =>
      port.cancelBatch({ sessionID: input.sessionID, batchID: input.batchID }).pipe(Effect.catch(() => Effect.void)),
    ),
  )
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
  | {
      readonly requestID: string
      readonly outcome: "error"
      readonly message: string
      readonly code?: string
    }

function decodeRpcResponse(input: unknown): DecodedRpcResponse {
  const response = record(input)
  if (response.kind !== "response" || response.protocol !== PROTOCOL)
    throw fail("protocol", "incompatible RPC response")
  const requestID = stringField(response, "requestId")
  if (response.outcome === "error") {
    const error = record(response.error)
    // The host's typed error code is preserved so managed-control callers can map a
    // refusal (`managed_conflict`, `managed_not_found`, ...) without parsing prose.
    const code =
      typeof error.code === "string" && error.code.length > 0 && Buffer.byteLength(error.code, "utf8") <= 128
        ? error.code
        : undefined
    return { requestID, outcome: "error", message: stringField(error, "message"), ...(code === undefined ? {} : { code }) }
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
    const subscriptionId = stringField(message, "subscriptionId")
    if (
      requested.ownerKind !== "session" ||
      latest.ownerKind !== "session" ||
      requested.ownerId !== latest.ownerId ||
      !/^(0|[1-9]\d*)$/.test(requested.seq) ||
      !/^(0|[1-9]\d*)$/.test(latest.seq) ||
      !Number.isSafeInteger(Number(requested.seq)) ||
      !Number.isSafeInteger(Number(latest.seq)) ||
      Number(latest.seq) < Number(requested.seq)
    ) {
      throw fail("protocol", "resnapshot cursors are invalid")
    }
    return { kind, subscriptionId, requested, latest }
  }
  throw fail("protocol", "unexpected server message")
}

type ApplicationFrameFence = {
  readonly ownerEpoch: number
  readonly processIncarnation: string
}

const APPLICATION_FRAME_KINDS: Record<string, true> = {
  request: true,
  response: true,
  event: true,
  subscribe: true,
  unsubscribe: true,
  ack: true,
  page_end: true,
  resnapshot_required: true,
  cancel_request: true,
  ping: true,
}

function validateApplicationFrameFence(fence: ApplicationFrameFence) {
  if (
    !Number.isSafeInteger(fence.ownerEpoch) ||
    fence.ownerEpoch < 1 ||
    typeof fence.processIncarnation !== "string" ||
    fence.processIncarnation.includes("\0")
  ) {
    throw fail("protocol", "negotiated application frame fence is invalid")
  }
  const incarnationBytes = Buffer.byteLength(fence.processIncarnation, "utf8")
  if (incarnationBytes === 0 || incarnationBytes > MAX_IDENTIFIER_BYTES) {
    throw fail("protocol", "negotiated application frame fence is invalid")
  }
}

export function withApplicationFrameFence(
  message: Readonly<Record<string, unknown>>,
  fence: ApplicationFrameFence,
): Record<string, unknown> {
  validateApplicationFrameFence(fence)
  if (typeof message.kind !== "string" || !Object.hasOwn(APPLICATION_FRAME_KINDS, message.kind)) {
    throw fail("protocol", "cannot fence a non-application frame")
  }
  if (
    (Object.hasOwn(message, "ownerEpoch") && message.ownerEpoch !== fence.ownerEpoch) ||
    (Object.hasOwn(message, "processIncarnation") &&
      message.processIncarnation !== fence.processIncarnation)
  ) {
    throw fail("protocol", "caller-supplied application frame fence does not match negotiation")
  }
  return {
    ...message,
    ownerEpoch: fence.ownerEpoch,
    processIncarnation: fence.processIncarnation,
  }
}

export function assertApplicationFrameFence(
  message: Readonly<Record<string, unknown>>,
  fence: ApplicationFrameFence,
): void {
  validateApplicationFrameFence(fence)
  if (
    typeof message.kind !== "string" ||
    !Object.hasOwn(APPLICATION_FRAME_KINDS, message.kind) ||
    !Object.hasOwn(message, "ownerEpoch") ||
    !Object.hasOwn(message, "processIncarnation") ||
    message.ownerEpoch !== fence.ownerEpoch ||
    message.processIncarnation !== fence.processIncarnation
  ) {
    throw fail("protocol", "application frame does not match the negotiated fence")
  }
}

function isHandshakeOrStartupFrame(message: Record<string, unknown>) {
  return (
    message.kind === "hello_result" ||
    message.kind === "hello_rejected" ||
    message.kind === "startup_status"
  )
}

function isPreFenceHelloFrame(message: Record<string, unknown>) {
  return message.kind === "hello_result" || message.kind === "hello_rejected"
}

function validateInboundApplicationFrame(
  value: unknown,
  fence: ApplicationFrameFence | undefined,
) {
  const message = record(value)
  if (isHandshakeOrStartupFrame(message)) {
    if (fence && isPreFenceHelloFrame(message)) {
      throw fail("protocol", "handshake frame arrived after fence negotiation")
    }
    return
  }
  if (!fence) throw fail("protocol", "application frame arrived before fence negotiation")
  assertApplicationFrameFence(message, fence)
}


class MessageChannel {
  #socket: Socket
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #messages: Array<{ value: unknown; bytes: number }> = []
  #messageBytes = 0
  #waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  #closed: Error | undefined
  #frameFence: ApplicationFrameFence | undefined

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on("data", (chunk: Buffer) => this.#onData(chunk))
    socket.on("error", (error) => this.#close(fail("transport", error.message)))
    socket.on("end", () => this.#close(fail("transport", "peer closed the channel")))
    socket.on("close", () => this.#close(fail("transport", "channel closed")))
  }

  setFrameFence(ownerEpoch: number, processIncarnation: string) {
    if (this.#frameFence) throw fail("protocol", "application frame fence was already negotiated")
    const fence = { ownerEpoch, processIncarnation }
    validateApplicationFrameFence(fence)
    this.#frameFence = fence
  }

  async send(value: Record<string, unknown>) {
    if (this.#closed) throw this.#closed
    let framed: Record<string, unknown>
    if (value.kind === "hello" && !this.#frameFence) {
      framed = value
    } else {
      if (!this.#frameFence) throw fail("protocol", "application frame requires a negotiated fence")
      framed = withApplicationFrameFence(value, this.#frameFence)
    }
    const payload = Buffer.from(pack(framed))
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
      try {
        validateInboundApplicationFrame(value, this.#frameFence)
      } catch (error) {
        this.#close(
          error instanceof SessionSupervisorError
            ? error
            : fail("protocol", "incoming application frame has invalid fencing"),
        )
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

/**
 * Builds the exact `session_supervisor` argv. The Rust child requires a positive
 * host-kernel owner epoch (`--owner-epoch`) and rejects any other argument, including the
 * retired host-wide `--workspace-root` (see arch_V1/14 and arch_V1/37: this process stays
 * projection/ACK-only and Locations are registered through `effects.v2/register_location`).
 */
export function sessionSupervisorArgs(input: {
  readonly source: string
  readonly stateDirectory: string
  readonly socketPath: string
  readonly hostExecutable: string
  readonly sessionID: string
  readonly nonce: string
  readonly incarnation: string
  readonly ownerEpoch: number
}): string[] {
  if (!Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1)
    throw fail("owner-epoch", "host kernel owner epoch must be a positive safe integer")
  for (const [name, path] of [
    ["source", input.source],
    ["state directory", input.stateDirectory],
    ["socket", input.socketPath],
    ["host executable", input.hostExecutable],
  ] as const) {
    if (!path.startsWith("/")) throw fail("configuration", `${name} must be absolute`)
  }
  return [
    `--source=${input.source}`,
    `--state-dir=${input.stateDirectory}`,
    `--socket=${input.socketPath}`,
    `--host-exe=${input.hostExecutable}`,
    `--session=${input.sessionID}`,
    `--nonce=${input.nonce}`,
    `--incarnation=${input.incarnation}`,
    `--owner-epoch=${input.ownerEpoch}`,
  ]
}

const SOCKET_PERMISSION_SETTLE_MS = 200
const SOCKET_POLL_INTERVAL_MS = 10
const STARTUP_STDERR_CAPTURE_BYTES = 8 * 1024
const STARTUP_DIAGNOSTIC_TIMEOUT_MS = 500

/** Resolves with the promise's value, or `undefined` after a bounded wait. Never rejects. */
function diagnosticRace<A>(promise: Promise<A>): Promise<A | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), STARTUP_DIAGNOSTIC_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/**
 * Drains a freshly spawned child's stderr into a bounded buffer so a
 * `Session supervisor startup failed` failure can say *why* the child died.
 *
 * Two independent reasons, both hit by the free-model E2E run:
 * - a piped-but-never-read stderr fills the OS pipe and eventually blocks the
 *   child, so the drain has to start as soon as the child is spawned;
 * - reporting only `exited before binding its socket (...)` is undiagnosable —
 *   four attempts (including `--print-logs --log-level DEBUG`) were spent on a
 *   message that never surfaced the child's own output.
 *
 * The buffer is bounded and marked truncated rather than unbounded, and reads
 * are raced against `STARTUP_DIAGNOSTIC_TIMEOUT_MS` so a diagnostic can never
 * hang the failure path itself.
 */
function captureChildStderr(child: ChildProcessHandle): () => Promise<string> {
  if (!child.stderr) return async () => ""
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  const drained = diagnosticRace(
    Effect.runPromise(
      Effect.scoped(
        Stream.runForEach(child.stderr, (chunk: Uint8Array) =>
          Effect.sync(() => {
            if (bytes >= STARTUP_STDERR_CAPTURE_BYTES) {
              truncated = true
              return
            }
            const slice = chunk.subarray(0, STARTUP_STDERR_CAPTURE_BYTES - bytes)
            chunks.push(slice)
            bytes += slice.length
            if (slice.length < chunk.length) truncated = true
          }),
        ),
      ),
    ),
  )
  return async () => {
    await drained
    const text = Buffer.concat(chunks).toString("utf8").trimEnd()
    return truncated ? `${text}\n… (stderr truncated at ${STARTUP_STDERR_CAPTURE_BYTES} bytes)` : text
  }
}

/** `; exit code N; stderr: …` — never throws, never hangs past the bound. */
async function describeChildExit(child: ChildProcessHandle, stderrTail: () => Promise<string>): Promise<string> {
  const exitCode = child.exitCode ? await diagnosticRace(Effect.runPromise(child.exitCode).catch(() => undefined)) : undefined
  const parts = [exitCode === undefined ? "exit status unavailable" : `exit code ${exitCode}`]
  const tail = await stderrTail()
  if (tail.length > 0) parts.push(`stderr: ${tail}`)
  return `; ${parts.join("; ")}`
}

export function waitForSocket(path: string, child: ChildProcessHandle, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  const stderrTail = captureChildStderr(child)
  const diagnose = () => describeChildExit(child, stderrTail)
  return new Promise<void>((resolve, reject) => {
    let permissionMismatchSince: number | undefined
    let pendingSocketIdentity: string | undefined
    const inspect = async () => {
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"))
      if (Date.now() >= deadline) return reject(fail("startup", "timed out waiting for the supervisor socket"))
      try {
        const stat = lstatSync(path)
        if (!stat.isSocket() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
          return reject(fail("authentication", "supervisor socket permissions or owner are invalid"))
        }
        const identity = `${stat.dev}:${stat.ino}`
        if (pendingSocketIdentity && pendingSocketIdentity !== identity)
          return reject(fail("authentication", "supervisor socket changed during startup"))
        if ((stat.mode & 0o777) !== 0o600) {
          // UnixPeerListener binds and then applies 0600. The inode becomes visible
          // during that small interval. Wait briefly for that exact owner-owned inode
          // to be hardened; a persistent insecure socket still fails closed.
          pendingSocketIdentity ??= identity
          permissionMismatchSince ??= Date.now()
          if (Date.now() - permissionMismatchSince >= SOCKET_PERMISSION_SETTLE_MS)
            return reject(fail("authentication", "supervisor socket permissions or owner are invalid"))
          const running = await Effect.runPromise(child.isRunning).catch(() => false)
          if (!running) return reject(fail("startup", `supervisor exited before securing its socket (${path})${await diagnose()}`))
          setTimeout(inspect, SOCKET_POLL_INTERVAL_MS)
          return
        }
        return resolve()
      } catch {
        const running = await Effect.runPromise(child.isRunning).catch(() => false)
        if (!running) return reject(fail("startup", `supervisor exited before binding its socket (${path})${await diagnose()}`))
        setTimeout(inspect, SOCKET_POLL_INTERVAL_MS)
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
): { readonly ownerEpoch: number; readonly enabledFeatures: ReadonlyArray<string> } {
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
  if (
    enabledFeatures.some((feature) => typeof feature !== "string" || feature.length === 0 || feature.length > 128)
  ) {
    throw fail("handshake", "kernel returned an invalid enabled feature list")
  }
  if (!Number.isSafeInteger(message.ownerEpoch) || (message.ownerEpoch as number) < 1) {
    throw fail("handshake", "kernel returned an invalid durable owner epoch")
  }
  return { ownerEpoch: message.ownerEpoch as number, enabledFeatures: enabledFeatures as string[] }
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
  const { ownerEpoch } = validateHelloResult(reply, nonce, incarnation, REQUIRED_FEATURES)
  channel.setFrameFence(ownerEpoch, incarnation)
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
    optionalFeatures: [...OPTIONAL_HOST_FEATURES],
  })
  const reply = record(await channel.receive())
  if (reply.kind === "hello_rejected") throw fail("handshake", "host kernel rejected protocol or required features")
  const { ownerEpoch, enabledFeatures } = validateHelloResult(reply, nonce, incarnation, REQUIRED_HOST_FEATURES)
  channel.setFrameFence(ownerEpoch, incarnation)
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
  return new HostKernelClientImpl(channel, child, ownerEpoch, enabledFeatures)
}

function openHostKernel(input: {
  readonly binary: string
  readonly stateDirectory: string
  readonly hostBuildDigest: string
  readonly appProcess: AppProcess.Interface
  readonly codeModeHelperRoot?: string
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
      ...(input.codeModeHelperRoot ? [`--codemode-helper-root=${input.codeModeHelperRoot}`] : []),
    ]
    const child = yield* input.appProcess
      .spawn(
        ChildProcess.make(input.binary, args, {
          stdin: "ignore",
          stdout: "ignore",
          // Piped so a startup failure can report why the child died; the
          // drain starts in `waitForSocket` so the pipe never back-pressures.
          stderr: "pipe",
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

/**
 * Transport surface `HostKernelClientImpl` actually drives. Production always
 * negotiates a `MessageChannel` over the host socket; the shape is exported only
 * so the client's pre-send admission gates can be exercised over a test double.
 */
export type HostKernelTransport = {
  send(value: Record<string, unknown>): Promise<void>
  receive(): Promise<unknown>
  end(): void
  isClosed(): boolean
  destroy(): void
}

export class HostKernelClientImpl {
  #channel: HostKernelTransport
  #child: ChildProcessHandle
  #pendingRequests = new Map<string, PendingRpc>()
  #expiredRequestIDs: string[] = []
  #subscriptions = new Map<string, (message: SessionEvent | ResnapshotRequired) => Promise<void>>()
  #closed = false
  #pump: Promise<void>
  #stopPromise: Promise<void> | undefined
  readonly ownerEpoch: number
  /** Features the host negotiated in its hello, including optional ones it advertised. */
  readonly enabledFeatures: ReadonlyArray<string>

  constructor(
    channel: HostKernelTransport,
    child: ChildProcessHandle,
    ownerEpoch: number,
    enabledFeatures: ReadonlyArray<string> = [],
  ) {
    this.#channel = channel
    this.#child = child
    this.ownerEpoch = ownerEpoch
    this.enabledFeatures = [...enabledFeatures]
    this.#pump = this.#receive()
    void this.#pump.catch(() => undefined)
  }

  async request(
    serviceID: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    deliveryID?: string,
    trustedPrincipal?: TrustedPrincipal,
    authenticatedContext?: AuthenticatedRequestContextV1,
    options?: {
      /**
       * Optional canonical envelope `requestID` (1..256 of `[A-Za-z0-9._:-]`).
       * Supplied only by the P1-10 direct read path so Core can bind every
       * projection row to an identity it already knows; absent, the client keeps
       * minting `req_<uuid>` exactly as before.
       */
      readonly requestID?: string
    },
  ) {
    if (this.#closed) throw fail("effect", "host kernel channel is closed")
    if (!serviceID || serviceID.length > 128 || !operation || operation.length > 128)
      throw fail("effect", "RPC service or operation is invalid")
    // `managed.v1` mutating operations are one-use-keyed. The key is the caller's
    // idempotency fence: an exact retry of the same logical operation is safe, while
    // reuse for a different command fails closed in the kernel.
    if (deliveryID !== undefined && !/^[A-Za-z0-9._-]{1,200}$/.test(deliveryID))
      throw fail("protocol", "RPC delivery id is invalid")
    if (
      trustedPrincipal?.kind === "server_auth" &&
      (!trustedPrincipal.subject || trustedPrincipal.subject.length > 256 || /[\x00-\x1f\x7f]/u.test(trustedPrincipal.subject))
    ) {
      throw fail("protocol", "authenticated ServerAuth subject is invalid")
    }
    const isRepoIntelRead =
      serviceID === "repo-intel.v1" && (operation === "query_structure" || operation === "ensure_generation" || operation === "read_document" || operation === "discover")
    /** The one allowlisted `effects.v2` read-only projection RPC (P1-10 direct read batch). */
    const isDirectReadBatch = serviceID === "effects.v2" && operation === "prepare_tool_batch_read"
    const isArtifactRead = serviceID === "artifact.v1" && (operation === "artifacts.inspect" || operation === "artifacts.read_range")
    const isArtifactScopeResolve = serviceID === "artifact.v1" && operation === "artifacts.resolve_scope"
    const isCodeModeOperation = serviceID === "execution.v1" &&
      ["codemode_enablement", "codemode_start", "codemode_resume", "codemode_cancel", "codemode_cancel_wave", "codemode_inspect", "codemode_prepare_wave", "codemode_settle_tool_results", "codemode_wave_receipts"].includes(operation)
    // Only the direct read path may pin the envelope `requestID` so Core can bind
    // every projection row to an identity it already knows; any other caller-supplied
    // ID fails closed here, before a frame is written.
    if (
      options?.requestID !== undefined &&
      (!isDirectReadBatch || !/^[A-Za-z0-9._:-]{1,256}$/.test(options.requestID))
    ) {
      throw fail("protocol", "RPC request id is invalid")
    }
    if (isRepoIntelRead || isDirectReadBatch || isArtifactRead || isArtifactScopeResolve || isCodeModeOperation || authenticatedContext) {
      if (
        !authenticatedContext ||
        trustedPrincipal?.kind !== "server_auth" ||
        (authenticatedContext.kind === "repo_read" && (
          (!isRepoIntelRead && !isDirectReadBatch) ||
          (isRepoIntelRead && !this.enabledFeatures.includes(REPO_INTEL_READ_CONTEXT_FEATURE)) ||
          (isDirectReadBatch && (
            !this.enabledFeatures.includes("effects.v2") ||
            !validDirectReadBatchAuthenticatedRequest(serviceID, operation, body, authenticatedContext)
          )) ||
          !/^ses_[A-Za-z0-9_-]{1,128}$/.test(authenticatedContext.sessionID) ||
          !/^loc_[0-9a-f]{64}$/.test(authenticatedContext.locationID)
        )) ||
        (authenticatedContext.kind === "artifact_read" && (
          !isArtifactRead ||
          !this.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) ||
          !validArtifactReadRequest(serviceID, operation, body, authenticatedContext)
        )) ||
        (authenticatedContext.kind === "artifact_scope_resolve" && (
          !isArtifactScopeResolve ||
          !this.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) ||
          !validArtifactScopeResolveRequest(serviceID, operation, body, authenticatedContext)
        )) ||
        (authenticatedContext.kind === "direct_session_artifact_read" && (
          !isArtifactRead ||
          !this.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) ||
          !validDirectSessionArtifactReadRequest(serviceID, operation, body, authenticatedContext)
        )) ||
        (authenticatedContext.kind === "code_mode_call" && (
          !isCodeModeOperation || !validCodeModeAuthenticatedRequest(serviceID, operation, body, authenticatedContext)
        ))
      ) {
        throw fail("protocol", "authenticated read context is unavailable or invalid")
      }
    }
    if (this.#pendingRequests.size >= 16) throw fail("effect", "too many pending host requests")
    const requestID = options?.requestID ?? `req_${randomUUID().replaceAll("-", "")}`
    let resolve!: (value: Record<string, unknown>) => void
    let reject!: (error: SessionSupervisorError) => void
    const response = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    void response.catch(() => undefined)
    // `terminal.run` owns a separate process deadline. Keep one generic RPC window
    // afterward for ExecutionHost to observe termination and durably settle UNKNOWN;
    // the 30-second wire deadline still fences request admission.
    const terminalRunTimeoutMs =
      serviceID === "terminal.v1" &&
      operation === "run" &&
      typeof body.timeoutMs === "number" &&
      Number.isSafeInteger(body.timeoutMs) &&
      body.timeoutMs > 0 &&
      body.timeoutMs <= 600_000
        ? Math.max(30_000, body.timeoutMs + 30_000)
        : 30_000
    const timer = setTimeout(() => {
      this.#pendingRequests.delete(requestID)
      this.#expiredRequestIDs.push(requestID)
      if (this.#expiredRequestIDs.length > 64) this.#expiredRequestIDs.shift()
      reject(fail("effect", "host kernel request timed out"))
    }, terminalRunTimeoutMs)
    this.#pendingRequests.set(requestID, { resolve, reject, timer })
    let requestSent = false
    let cancellationPending = false
    let cancellationSent = false
    const cancelRequest = () => {
      if (!signal?.aborted || cancellationSent) return
      if (!requestSent) {
        cancellationPending = true
        return
      }
      cancellationSent = true
      void this.#channel.send({ kind: "cancel_request", requestId: requestID }).catch(() => undefined)
    }
    signal?.addEventListener("abort", cancelRequest, { once: true })
    try {
      await this.#channel.send({
        protocol: PROTOCOL,
        kind: "request",
        requestId: requestID,
        serviceId: serviceID,
        operation,
        ...(deliveryID === undefined ? {} : { deliveryId: deliveryID }),
        deadlineUnixMs: BigInt(Date.now() + 30_000),
        traceId: randomUUID(),
        ...(trustedPrincipal?.kind === "server_auth"
          ? { authenticatedPrincipal: { kind: "server_auth", subject: trustedPrincipal.subject } }
          : {}),
        ...(authenticatedContext === undefined
          ? {}
          : {
              authenticatedContext: authenticatedContext.kind === "repo_read"
                ? {
                    kind: "repo_read",
                    sessionID: authenticatedContext.sessionID,
                    locationID: authenticatedContext.locationID,
                  }
                : authenticatedContext.kind === "artifact_read"
                  ? {
                      kind: "artifact_read",
                      sessionID: authenticatedContext.sessionID,
                      locationID: authenticatedContext.locationID,
                      artifactRef: authenticatedContext.artifactRef,
                      ...(authenticatedContext.managedAttempt
                        ? { managedAttempt: managedAttemptScopeToWire(authenticatedContext.managedAttempt) }
                        : {}),
                      ...(authenticatedContext.directAttempt
                        ? { directAttempt: authenticatedContext.directAttempt }
                        : {}),
                    }
                  : authenticatedContext.kind === "artifact_scope_resolve"
                    ? {
                        kind: "artifact_scope_resolve",
                        sessionID: authenticatedContext.sessionID,
                        locationID: authenticatedContext.locationID,
                        artifactRef: authenticatedContext.artifactRef,
                      }
                    : authenticatedContext.kind === "direct_session_artifact_read"
                      ? {
                          kind: "direct_session_artifact_read",
                          sessionID: authenticatedContext.sessionID,
                          locationID: authenticatedContext.locationID,
                          artifactRef: authenticatedContext.artifactRef,
                        }
                      : {
                          kind: "code_mode_call",
                          sessionID: authenticatedContext.sessionID,
                          locationID: authenticatedContext.locationID,
                          callID: authenticatedContext.callID,
                          lane: authenticatedContext.lane,
                          ...(authenticatedContext.managedAttempt
                            ? { managedAttempt: managedAttemptScopeToWire(authenticatedContext.managedAttempt) }
                            : {}),
                        },
            }),
        body,
      })
      requestSent = true
      if (cancellationPending || signal?.aborted) cancelRequest()
    } catch {
      signal?.removeEventListener("abort", cancelRequest)
      clearTimeout(timer)
      this.#pendingRequests.delete(requestID)
      reject(fail("transport", "could not send host kernel request"))
    }
    const result = response.finally(() => signal?.removeEventListener("abort", cancelRequest))
    void result.catch(() => undefined)
    return result
  }

  async subscribe(
    terminalID: string,
    generation: number,
    after: Cursor,
    onEvent: (event: SessionEvent | ResnapshotRequired) => Promise<void>,
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
          if (response.outcome === "error") pending.reject(fail("effect", response.message, undefined, response.code))
          else pending.resolve(response.body)
          continue
        }
        const message = decodeServerMessage(raw)
        if (message.kind !== "event" && message.kind !== "resnapshot_required") {
          throw fail("protocol", "unexpected host kernel control message")
        }
        const subscriber = this.#subscriptions.get(message.subscriptionId)
        if (!subscriber) throw fail("protocol", "host control belongs to an unknown subscription")
        if (message.kind === "resnapshot_required") {
          this.#subscriptions.delete(message.subscriptionId)
          void subscriber(message).catch(() => undefined)
          continue
        }
        await subscriber(message)
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
    // Capture the active Core database once at layer construction. `open` binds the
    // observer source authority to this exact database path; holding the closure
    // value keeps `open`'s Effect requirement at Scope only for its consumers.
    const database = yield* Database.Service
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
          const codeModeHelperRoot = yield* Effect.tryPromise({
            try: () => installBundledCodeModeHelper({
              assetPath: runtime.codeModeHelperAssetPath,
              manifestJSON: runtime.codeModeHelperManifestJSON,
              installRoot: runtime.codeModeHelperInstallRoot,
            }),
            catch: (error) => error instanceof SessionSupervisorError ? error : fail("helper-install", "bundled CodeMode helper is unavailable"),
          })
          hostKernelClient = yield* openHostKernel({
            binary,
            stateDirectory: runtime.hostKernelStateRoot,
            hostBuildDigest,
            appProcess,
            ...(codeModeHelperRoot === undefined ? {} : { codeModeHelperRoot }),
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
      // A caller-supplied absolute path is not source authority. Bind the observer
      // to the live Core database selected by Database, then pin that exact file
      // identity before AppProcess can dispatch the child.
      let canonicalSource: string
      try {
        canonicalSource = realpathSync(options.source)
        if (canonicalSource !== realpathSync(database.path)) {
          return yield* Effect.fail(fail("configuration", "observer source is not the active Core database"))
        }
        pinSupervisorSource(canonicalSource)
      } catch {
        return yield* Effect.fail(fail("configuration", "active Core database source is unavailable"))
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
      try {
        binary = realpathSync(options.binary)
        if (options.workspaceRoot !== undefined) {
          if (!options.workspaceRoot.startsWith("/"))
            return yield* Effect.fail(fail("configuration", "workspace root must be absolute"))
          const workspaceRoot = realpathSync(options.workspaceRoot)
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
      if (!hostKernelClient) {
        return yield* Effect.fail(
          fail(
            "owner-epoch",
            "host kernel owner epoch is unavailable; session_supervisor cannot start without it",
          ),
        )
      }
      const args = sessionSupervisorArgs({
        source: canonicalSource,
        stateDirectory,
        socketPath,
        hostExecutable: realpathSync(globalThis.process.execPath),
        sessionID: options.sessionID,
        nonce,
        incarnation,
        ownerEpoch: hostKernelClient.ownerEpoch,
      })
      const child = yield* appProcess
        .spawn(
          ChildProcess.make(binary, args, {
            stdin: "ignore",
            stdout: "ignore",
            // Piped so a startup failure can report why the child died; the
            // drain starts in `waitForSocket` so the pipe never back-pressures.
            stderr: "pipe",
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
      options?: {
        readonly cancelOnInterrupt?: boolean
        readonly deliveryID?: string
        readonly trustedPrincipal?: TrustedPrincipal
        readonly authenticatedContext?: AuthenticatedRequestContextV1
        /** Canonical envelope `requestID`; reserved for the P1-10 direct read path. */
        readonly requestID?: string
      },
    ) {
      if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
      if (
        options?.cancelOnInterrupt &&
        !(
          (serviceID === "terminal.v1" && operation === "run") ||
          (serviceID === "execution.v1" && (operation === "execute_search_cascade" || operation === "resume_search_cascade" || operation === "cancel_search_cascade")) ||
          (serviceID === "execution.v1" && operation === "git_read") ||
          (serviceID === "repo-intel.v1" && (operation === "query_structure" || operation === "ensure_generation" || operation === "read_document" || operation === "discover"))
        )
      ) {
        return yield* Effect.fail(fail("protocol", "host request cancellation is unavailable for this operation"))
      }
      if (options?.deliveryID !== undefined && !/^[A-Za-z0-9._-]{1,200}$/.test(options.deliveryID)) {
        return yield* Effect.fail(fail("protocol", "host request delivery id is invalid"))
      }
      const isRepoIntelRead =
        serviceID === "repo-intel.v1" && (operation === "query_structure" || operation === "ensure_generation" || operation === "read_document" || operation === "discover")
      const isDirectReadBatch = serviceID === "effects.v2" && operation === "prepare_tool_batch_read"
      const isArtifactRead = serviceID === "artifact.v1" && (operation === "artifacts.inspect" || operation === "artifacts.read_range")
      const isArtifactScopeResolve = serviceID === "artifact.v1" && operation === "artifacts.resolve_scope"
      const isCodeModeOperation = serviceID === "execution.v1" &&
        ["codemode_enablement", "codemode_start", "codemode_resume", "codemode_cancel", "codemode_cancel_wave", "codemode_inspect", "codemode_prepare_wave", "codemode_settle_tool_results", "codemode_wave_receipts"].includes(operation)
      if (isRepoIntelRead || isDirectReadBatch || isArtifactRead || isArtifactScopeResolve || isCodeModeOperation || options?.authenticatedContext) {
        const context = options?.authenticatedContext
        const validCodeModeContext = !!context && options?.trustedPrincipal?.kind === "server_auth" &&
          validCodeModeAuthenticatedRequest(serviceID, operation, body, context)
        const valid = !!context && options?.trustedPrincipal?.kind === "server_auth" && (
          context.kind === "repo_read"
            ? ((isRepoIntelRead && hostKernelClient.enabledFeatures.includes(REPO_INTEL_READ_CONTEXT_FEATURE)) ||
                (isDirectReadBatch && hostKernelClient.enabledFeatures.includes("effects.v2"))) &&
              /^ses_[A-Za-z0-9_-]{1,128}$/.test(context.sessionID) && /^loc_[0-9a-f]{64}$/.test(context.locationID) &&
              (!isDirectReadBatch || validDirectReadBatchAuthenticatedRequest(serviceID, operation, body, context))
            : context.kind === "artifact_read"
            ? isArtifactRead && hostKernelClient.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) &&
              validArtifactReadRequest(serviceID, operation, body, context)
            : context.kind === "artifact_scope_resolve"
              ? isArtifactScopeResolve && hostKernelClient.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) &&
                validArtifactScopeResolveRequest(serviceID, operation, body, context)
          : context.kind === "direct_session_artifact_read"
              ? isArtifactRead && hostKernelClient.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE) &&
                validDirectSessionArtifactReadRequest(serviceID, operation, body, context)
              : validCodeModeContext
        )
        if (!valid) {
          return yield* Effect.fail(fail("protocol", "authenticated read context is unavailable"))
        }
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          hostKernelClient!.request(
            serviceID,
            operation,
            body,
            options?.cancelOnInterrupt ? signal : undefined,
            options?.deliveryID,
            options?.trustedPrincipal,
            options?.authenticatedContext,
            options?.requestID === undefined ? undefined : { requestID: options.requestID },
          ),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("host-kernel", "host kernel request failed"),
      })
    })
    const hostFeatureEnabled = Effect.fn("SessionSupervisor.hostFeatureEnabled")(function* (feature: string) {
      if (!hostKernelClient || typeof feature !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(feature)) {
        return false
      }
      return hostKernelClient.enabledFeatures.includes(feature)
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
    }): Stream.Stream<HostKernelStreamMessage, SessionSupervisorError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
          const capacity = input.capacity ?? 64
          if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
            return yield* Effect.fail(fail("backpressure", "terminal event capacity must be between 1 and 128"))
          }
          const queue = yield* Queue.dropping<HostKernelStreamMessage, SessionSupervisorError>(capacity)
          // A resnapshot retires the old subscription and installs a new one, so an event must be
          // acknowledged through the exact subscription that delivered it; a single "current"
          // subscription would misroute ACKs for events already in the queue.
          const subscriptions = new Map<string, HostEventSubscription>()
          const failQueue = (error: unknown) =>
            Effect.runPromise(
              Queue.fail(
                queue,
                error instanceof SessionSupervisorError ? error : fail("protocol", "invalid terminal stream message"),
              ),
            ).catch(() => undefined)
          // A host refusal (unknown terminal, exhausted subscription capacity, unusable cursor)
          // shares the resnapshot wire shape with replay loss, so retries are bounded: each
          // recovered event clears the budget, while a refusal loop ends in a typed failure.
          let resnapshotAttempts = 0
          const subscribeFrom = async (after: Cursor): Promise<HostEventSubscription> => {
            const next = await hostKernelClient!.subscribe(input.terminalID, input.generation, after, async (message) => {
              try {
                if (message.kind === "resnapshot_required") {
                  if (
                    message.requested.ownerKind !== "terminal" ||
                    message.requested.ownerId !== input.terminalID ||
                    message.latest.ownerKind !== "terminal" ||
                    message.latest.ownerId !== input.terminalID
                  ) throw fail("protocol", "resnapshot control belongs to another terminal")
                  if (!(await Effect.runPromise(Queue.offer(queue, message)))) {
                    await failQueue(fail("backpressure", "terminal event stream exceeded its bounded capacity"))
                    return
                  }
                  resnapshotAttempts += 1
                  if (resnapshotAttempts > RESNAPSHOT_ATTEMPT_LIMIT) {
                    await failQueue(
                      fail("resnapshot", "host refused the terminal subscription without a recoverable replay"),
                    )
                    return
                  }
                  void subscribeFrom(message.latest).catch(failQueue)
                  return
                }
                const payload = record(message.payload)
                const parsed = {
                  terminalID: stringField(payload, "terminalID"),
                  generation: payload.generation,
                  sequence: payload.sequence,
                  byteCursor: payload.byteCursor,
                  kind: stringField(payload, "kind"),
                  payload: payload.payload,
                  cursor: message.cursor,
                  eventType: message.eventType,
                  subscriptionId: message.subscriptionId,
                }
                if (
                  parsed.terminalID !== input.terminalID ||
                  parsed.generation !== input.generation ||
                  !Number.isSafeInteger(parsed.sequence) ||
                  (parsed.sequence as number) < 1 ||
                  !Number.isSafeInteger(parsed.byteCursor) ||
                  (parsed.byteCursor as number) < 0 ||
                  message.cursor.ownerKind !== "terminal" ||
                  message.cursor.ownerId !== input.terminalID ||
                  message.cursor.seq !== String(parsed.sequence) ||
                  !/^blake3:[0-9a-f]{64}$/.test(message.cursor.eventDigest)
                ) throw fail("protocol", "host returned an invalid terminal event")
                if (!(await Effect.runPromise(Queue.offer(queue, parsed as HostKernelEvent)))) {
                  await failQueue(fail("backpressure", "terminal event stream exceeded its bounded capacity"))
                  return
                }
                resnapshotAttempts = 0
              } catch (error) {
                await failQueue(error)
              }
            })
            subscriptions.set(next.subscriptionID, next)
            return next
          }
          yield* Effect.tryPromise({
            try: () => subscribeFrom(input.after),
            catch: (error) =>
              error instanceof SessionSupervisorError ? error : fail("subscription", "cannot subscribe to terminal events"),
          })
          yield* Effect.addFinalizer(() =>
            Effect.forEach(subscriptions.values(), (current) =>
              Effect.tryPromise({
                try: () => current.unsubscribe(),
                catch: () => fail("subscription", "could not unsubscribe from terminal events"),
              }).pipe(Effect.ignore),
            ).pipe(
              Effect.andThen(Queue.shutdown(queue)),
              Effect.asVoid,
              Effect.orDie,
            ),
          )
          return Stream.fromQueue(queue).pipe(
            Stream.tap((message) => {
              if (message.kind !== "event") return Effect.void
              const delivering = subscriptions.get(message.subscriptionId)
              if (!delivering) {
                return Effect.fail(fail("ack", "terminal event arrived without a live subscription"))
              }
              return Effect.tryPromise({
                try: () => delivering.ack(message.cursor),
                catch: (error) =>
                  error instanceof SessionSupervisorError ? error : fail("ack", "could not acknowledge terminal event"),
              })
            }),
          )
        }),
      )
    const replyGuardApproval = Effect.fn("SessionSupervisor.replyGuardApproval")(function* (input: {
      readonly approvalID: string
      readonly decision: GuardApprovalReplyDecisionV1
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (!(["allow_once", "deny", "grant_session", "grant_workspace"] as const).includes(input.decision)) {
        return yield* Effect.fail(fail("approval-invalid", "Guard approval decision is invalid", "approval-invalid"))
      }
      const pending = pendingApprovals.get(input.approvalID)
      if (!pending) {
        const closed = closedApprovals.has(input.approvalID)
        const code = closed ? "approval-conflict" : "approval-not-found"
        return yield* Effect.fail(
          fail(code, closed ? "Guard approval is no longer active" : "Guard approval was not found", code),
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
        return yield* Effect.fail(fail("approval-not-found", "Guard approval was not found", "approval-not-found"))
      }
      if (input.decision === "allow_once" && !pending.request.allowEnabled) {
        return yield* Effect.fail(
          fail("approval-invalid", "Guard allow is unavailable until consent guarantees are assessed", "approval-invalid"),
        )
      }
      if (Date.now() >= pending.request.expiresAtUnixMs) {
        pendingApprovals.delete(input.approvalID)
        closedApprovals.set(input.approvalID, Date.now())
        yield* Deferred.fail(pending.decision, fail("approval-conflict", "Guard approval expired", "approval-conflict"))
        yield* events.publish(GuardApprovalResolved, {
          approvalID: input.approvalID,
          decision: "expired",
        })
        return yield* Effect.fail(fail("approval-conflict", "Guard approval expired", "approval-conflict"))
      }
      let resolvedDecision: GuardApprovalDecision = input.decision === "allow_once" ? "allow_once" : "deny"
      if (input.decision === "grant_session" || input.decision === "grant_workspace") {
        const request = pending.request
        const sessionID = request.sessionID
        const action = request.capabilityID === "files.write" || request.capabilityID === "files.patch" ? "edit" : undefined
        if (trusted.principal.kind !== "server_auth" || !sessionID || !action ||
          request.origin !== "session_batch" || request.source !== "core.tool_batch" || request.runID !== undefined ||
          !/^[A-Za-z0-9._-]{1,256}$/.test(request.challengeID) || !/^[A-Za-z0-9._-]{1,256}$/.test(request.effectID)) {
          return yield* Effect.fail(fail("approval-invalid", "Persistent grant choices are unavailable for this challenge", "approval-invalid"))
        }
        // Persist the explicit choice against this host-issued challenge, then
        // deny that challenge. The challenged effect is never dispatched under
        // the grant; a fresh prepare must revalidate Guard and issue a new lease.
        yield* issueDirectSessionGrant({
          locationRef: pending.locationRef,
          sessionID,
          challengeID: request.challengeID,
          effectID: request.effectID,
          scopeKind: input.decision === "grant_session" ? "session" : "workspace",
          actions: [action],
        })
        resolvedDecision = "deny"
      }
      pendingApprovals.delete(input.approvalID)
      closedApprovals.set(input.approvalID, Date.now())
      yield* Deferred.succeed(pending.decision, resolvedDecision)
      yield* events.publish(GuardApprovalResolved, {
        approvalID: input.approvalID,
        decision: resolvedDecision,
      })
    })
    const registeredLocations = new Map<string, string>()
    const locationBySession = new Map<string, string>()
    const registerHostLocationFor = Effect.fn("SessionSupervisor.registerHostLocationFor")(function* (
      locationRef: typeof LocationSchema.Ref.Type,
      principal: TrustedPrincipal,
    ) {
      if (!hostKernelClient) return yield* Effect.fail(fail("host-kernel", "host kernel is unavailable"))
      if (principal.kind !== "server_auth" || !principal.subject) {
        return yield* Effect.fail(fail("authorization", "Location registration requires authenticated ServerAuth context"))
      }
      const root = locationRef?.directory
      const workspaceID = locationRef?.workspaceID
      if (typeof root !== "string" || root.length === 0 || Buffer.byteLength(root, "utf8") > 4096) {
        return yield* Effect.fail(fail("location", "Location root is invalid"))
      }
      const key = `${principal.subject}\0${root}\0${workspaceID ?? ""}`
      const registered = registeredLocations.get(key)
      if (registered) return registered
      const response = yield* requestHostKernel("effects.v2", "register_location", {
        canonicalRoot: root,
        ...(workspaceID === undefined ? {} : { workspaceID }),
      }, { trustedPrincipal: principal })
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
    const registerHostLocation = Effect.fn("SessionSupervisor.registerHostLocation")(function* (
      locationRef: typeof LocationSchema.Ref.Type,
    ) {
      const trusted = yield* TrustedPrincipalContext
      return yield* registerHostLocationFor(locationRef, trusted.principal)
    })
    const directSessionWorkspaceSnapshot = Effect.fn("SessionSupervisor.directSessionWorkspaceSnapshot")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("authorization", "direct Session workspace projection requires authenticated ServerAuth"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("execution.v1", "direct_session_workspace_snapshot", {
        sessionID: input.sessionID,
        locationID,
      }, { trustedPrincipal: trusted.principal })
      const expectedKeys = ["sessionID", "locationID", "ownerEpoch", "workspaceRevision", "workspaceRootDigest", "observedAtUnixMs"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0") ||
        response.sessionID !== input.sessionID || response.locationID !== locationID ||
        typeof response.ownerEpoch !== "string" || !/^[1-9][0-9]{0,19}$/.test(response.ownerEpoch) ||
        typeof response.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.workspaceRevision) ||
        typeof response.workspaceRootDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.workspaceRootDigest) ||
        typeof response.observedAtUnixMs !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(response.observedAtUnixMs)) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned an invalid direct Session workspace snapshot"))
      }
      return response as unknown as DirectSessionWorkspaceSnapshotV1
    })
    const managedEffectWaveReceipts: Interface["managedEffectWaveReceipts"] = Effect.fn("SessionSupervisor.managedEffectWaveReceipts")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(input.goalID) || !/^[A-Za-z0-9._-]{1,256}$/.test(input.runID) ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(input.taskID) || !/^[A-Za-z0-9._-]{1,256}$/.test(input.attemptID) ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(input.batchID) || !Number.isInteger(input.waveIndex) ||
        input.waveIndex < 0 || input.waveIndex > 63) {
        return yield* Effect.fail(fail("authorization", "managed wave receipt lookup requires exact authenticated Attempt pins"))
      }
      const response = yield* requestHostKernel("managed.v1", "effect_wave_receipts", {
        goalID: input.goalID,
        runID: input.runID,
        taskID: input.taskID,
        attemptID: input.attemptID,
        batchID: input.batchID,
        waveIndex: input.waveIndex,
      }, { trustedPrincipal: trusted.principal })
      const expected = ["status", "goalID", "runID", "taskID", "attemptID", "batchID", "waveIndex", "sourceScopeDigest", "waveDigest", "effects"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expected.join("\0") ||
        response.status !== "RECOVERED" || response.goalID !== input.goalID || response.runID !== input.runID ||
        response.taskID !== input.taskID || response.attemptID !== input.attemptID || response.batchID !== input.batchID ||
        response.waveIndex !== input.waveIndex || typeof response.sourceScopeDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.sourceScopeDigest) ||
        typeof response.waveDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.waveDigest) ||
        !Array.isArray(response.effects) || response.effects.length < 1 || response.effects.length > MAX_TOOL_BATCH_CALLS) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed managed effect wave receipts"))
      }
      const seenCalls = new Set<string>()
      const seenEffects = new Set<string>()
      const effects = response.effects.map((raw, index) => {
        const item = record(raw)
        const keys = ["callIndex", "callID", "effectID", "receiptRef", "capabilityID", "attemptScopeDigest", "status", "receiptKind", "receiptDigest"].toSorted()
        const status = item.status
        if (Object.keys(item).toSorted().join("\0") !== keys.join("\0") || item.callIndex !== index ||
          typeof item.callID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.callID) || seenCalls.has(item.callID) ||
          typeof item.effectID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.effectID) || seenEffects.has(item.effectID) ||
          typeof item.capabilityID !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/.test(item.capabilityID) ||
          typeof item.attemptScopeDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.attemptScopeDigest) ||
          !["SETTLED", "NOT_APPLIED", "DENIED", "EXPIRED", "CANCELLED", "UNKNOWN"].includes(String(status))) {
          throw fail("protocol", "HostKernel returned malformed or reordered managed wave receipt edge")
        }
        seenCalls.add(item.callID)
        seenEffects.add(item.effectID)
        const unknown = status === "UNKNOWN"
        if (unknown ? item.receiptRef !== null || item.receiptKind !== null || item.receiptDigest !== null :
          typeof item.receiptRef !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.receiptRef) ||
          typeof item.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.receiptDigest) ||
          (status === "SETTLED" ? item.receiptKind !== "effect" : item.receiptKind !== "decision")) {
          throw fail("protocol", "HostKernel receipt refs do not match terminal effect status")
        }
        return item
      })
      return { ...response, effects } as unknown as ManagedEffectWaveReceiptProjectionV1
    })
    const managedCurrentEpochRecoveryQuiescence: Interface["managedCurrentEpochRecoveryQuiescence"] = Effect.fn("SessionSupervisor.managedCurrentEpochRecoveryQuiescence")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      const ids = [input.goalID, input.runID, input.taskID, input.attemptID, input.parentSessionID, input.sessionID]
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        ids.some((value) => !/^[A-Za-z0-9._-]{1,256}$/.test(value)) ||
        input.observation.sessionStatus !== "idle" || input.observation.activePromptCount !== 0 ||
        input.observation.activeProviderTaskCount !== 0 || input.observation.runningBackgroundTaskCount !== 0 ||
        input.observation.pendingToolCallCount !== 0 || input.observation.incompleteAssistantMessageCount !== 0 ||
        !/^[1-9][0-9]{0,19}$/.test(input.observation.childSessionSequence) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.observation.childSessionEventDigest) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.observation.childSessionStateDigest) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.observation.observationDigest)) {
        return yield* Effect.fail(fail("protocol", "current-epoch managed recovery observation is malformed"))
      }
      const response = yield* requestHostKernel("managed.v1", "current_epoch_recovery_quiescence", {
        goalID: input.goalID,
        runID: input.runID,
        taskID: input.taskID,
        attemptID: input.attemptID,
        parentSessionID: input.parentSessionID,
        sessionID: input.sessionID,
        childSessionSequence: input.observation.childSessionSequence,
        childSessionEventDigest: input.observation.childSessionEventDigest,
        childSessionStateDigest: input.observation.childSessionStateDigest,
        sessionStatus: input.observation.sessionStatus,
        activePromptCount: input.observation.activePromptCount,
        activeProviderTaskCount: input.observation.activeProviderTaskCount,
        runningBackgroundTaskCount: input.observation.runningBackgroundTaskCount,
        pendingToolCallCount: input.observation.pendingToolCallCount,
        incompleteAssistantMessageCount: input.observation.incompleteAssistantMessageCount,
        observationDigest: input.observation.observationDigest,
      }, { trustedPrincipal: trusted.principal })
      const keys = ["status", "goalID", "runID", "taskID", "attemptID", "parentSessionID", "sessionID", "principal", "locationID",
        "currentOwnerEpoch", "currentProcessIncarnation", "currentCorePID", "currentCoreStartIdentity", "currentCoreExecutableDigest",
        "childSessionSequence", "childSessionEventDigest", "childSessionStateDigest", "childObservationDigest", "hostQuiescenceDigest",
        "originalTerminalOwnerLogID", "originalTerminalOwnerLogSequence", "originalTerminalOwnerLogEventDigest",
        "originalPromptQuiescenceDigest", "originalPromptQuiescenceOwnerEpoch", "originalAttemptStateDigest",
        "originalEffectChainDigest", "originalEvidenceDigest", "verifiedWorkspaceHead", "receiptDigest"].toSorted()
      const digestFields = ["currentCoreExecutableDigest", "childSessionEventDigest", "childSessionStateDigest", "childObservationDigest",
        "hostQuiescenceDigest", "originalTerminalOwnerLogEventDigest", "originalPromptQuiescenceDigest",
        "originalAttemptStateDigest", "originalEffectChainDigest", "originalEvidenceDigest", "verifiedWorkspaceHead", "receiptDigest"] as const
      const decimalFields = ["currentOwnerEpoch", "currentCoreStartIdentity", "childSessionSequence", "originalTerminalOwnerLogSequence", "originalPromptQuiescenceOwnerEpoch"] as const
      if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.status !== "CURRENT_EPOCH_QUIESCED" ||
        response.goalID !== input.goalID || response.runID !== input.runID || response.taskID !== input.taskID ||
        response.attemptID !== input.attemptID || response.parentSessionID !== input.parentSessionID || response.sessionID !== input.sessionID ||
        response.principal !== `server_auth:${trusted.principal.subject}` ||
        typeof response.locationID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(response.locationID) ||
        typeof response.currentProcessIncarnation !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(response.currentProcessIncarnation) ||
        !Number.isSafeInteger(response.currentCorePID) || (response.currentCorePID as number) < 1 ||
        digestFields.some((key) => typeof response[key] !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response[key] as string)) ||
        decimalFields.some((key) => typeof response[key] !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(response[key] as string)) ||
        response.currentOwnerEpoch === "0" || response.childSessionSequence !== input.observation.childSessionSequence ||
        response.childSessionEventDigest !== input.observation.childSessionEventDigest ||
        response.childSessionStateDigest !== input.observation.childSessionStateDigest ||
        response.childObservationDigest !== input.observation.observationDigest) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned a malformed or mismatched current-epoch recovery proof"))
      }
      return response as unknown as ManagedCurrentEpochRecoveryQuiescenceV1
    })
    const directCodeModeWaveReceipts: Interface["directCodeModeWaveReceipts"] = Effect.fn("SessionSupervisor.directCodeModeWaveReceipts")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID) ||
        !Number.isInteger(input.waveIndex) || input.waveIndex < 0 || input.waveIndex > 63) {
        return yield* Effect.fail(fail("authorization", "direct CodeMode receipt lookup requires authenticated Session and exact wave selector"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("execution.v1", "direct_effect_wave_receipts", {
        sessionID: input.sessionID,
        locationID,
        requestID: input.requestID,
        waveIndex: input.waveIndex,
      }, { trustedPrincipal: trusted.principal })
      const keys = ["status", "sessionID", "locationID", "requestID", "batchID", "waveIndex", "frameDigest", "waveDigest", "directSessionScopeDigest", "effects"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") ||
        !["SETTLED", "REJECTED", "CANCELLED"].includes(String(response.status)) ||
        response.sessionID !== input.sessionID || response.locationID !== locationID || response.requestID !== input.requestID ||
        !Number.isSafeInteger(response.waveIndex) || response.waveIndex !== input.waveIndex ||
        typeof response.batchID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(response.batchID) ||
        typeof response.frameDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.frameDigest) ||
        (response.waveDigest !== null && (typeof response.waveDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.waveDigest))) ||
        typeof response.directSessionScopeDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.directSessionScopeDigest) ||
        !Array.isArray(response.effects) || response.effects.length < 1 || response.effects.length > MAX_TOOL_BATCH_CALLS) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed direct CodeMode receipts"))
      }
      const effects = response.effects.map((raw, index) => {
        const item = record(raw)
        const expected = ["callIndex", "callID", "effectID", "challengeID", "receiptRef", "capabilityID", "status", "receiptKind", "receiptDigest"].toSorted()
        if (Object.keys(item).toSorted().join("\0") !== expected.join("\0") || item.callIndex !== index ||
          typeof item.callID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.callID) ||
          (item.effectID !== null && (typeof item.effectID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.effectID))) ||
          (item.challengeID !== null && (typeof item.challengeID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.challengeID))) ||
          typeof item.receiptRef !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.receiptRef) ||
          (item.capabilityID !== null && (typeof item.capabilityID !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/.test(item.capabilityID))) ||
          !["SETTLED", "REJECTED", "CANCELLED"].includes(String(item.status)) ||
          (item.status === "SETTLED" ? item.receiptKind !== "effect" : item.receiptKind !== "decision") ||
          typeof item.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.receiptDigest)) {
          throw fail("protocol", "HostKernel returned an invalid direct CodeMode wave edge")
        }
        return item
      })
      const aggregate = effects.some((edge) => edge.status === "REJECTED") ? "REJECTED" :
        effects.some((edge) => edge.status === "CANCELLED") ? "CANCELLED" : "SETTLED"
      if (response.status !== aggregate) return yield* Effect.fail(fail("protocol", "HostKernel direct wave outcome differs from its ordered receipts"))
      return { ...response, effects } as unknown as DirectCodeModeWaveReceiptProjectionV1
    })
    const listDirectAttemptArtifacts: Interface["listDirectAttemptArtifacts"] = Effect.fn("SessionSupervisor.listDirectAttemptArtifacts")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("authorization", "direct artifact resolution requires authenticated ServerAuth and Session"))
      }
      const directAttempt = yield* Effect.try({
        try: () => directAttemptScopeToWire(input.directAttempt),
        catch: () => fail("protocol", "direct artifact Attempt scope is malformed"),
      })
      if (directAttempt.childSessionID !== input.sessionID) {
        return yield* Effect.fail(fail("authorization", "direct artifact Attempt does not belong to the current Session"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated direct artifact reads are unavailable"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("execution.v1", "direct_attempt_artifacts", {
        sessionID: input.sessionID,
        locationID,
        directAttempt,
      }, { trustedPrincipal: trusted.principal })
      const responseKeys = ["status", "sessionID", "locationID", "directAttemptID", "ownerEpoch", "artifacts"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== responseKeys.join("\0") ||
        response.status !== "RECOVERED" || response.sessionID !== input.sessionID ||
        response.locationID !== locationID || response.directAttemptID !== directAttempt.attemptID ||
        response.ownerEpoch !== String(directAttempt.ownerEpoch) || !Array.isArray(response.artifacts) || response.artifacts.length > MAX_TOOL_BATCH_CALLS) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed direct Attempt artifact provenance"))
      }
      const seenEffects = new Set<string>()
      const artifacts = response.artifacts.map((raw, index) => {
        const item = record(raw)
        const keys = ["artifactRef", "effectID", "batchID", "callIndex", "callID", "challengeID", "attemptScopeDigest", "receiptDigest", "outputDigest", "workspaceRevision", "fidelity", "observedBytes", "droppedBytes"].toSorted()
        if (Object.keys(item).toSorted().join("\0") !== keys.join("\0") || !validateArtifactRefWire(item.artifactRef) ||
          typeof item.effectID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.effectID) || seenEffects.has(item.effectID) ||
          typeof item.batchID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.batchID) ||
          !Number.isSafeInteger(item.callIndex) || (item.callIndex as number) < 0 || (item.callIndex as number) > 31 ||
          typeof item.callID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.callID) ||
          typeof item.challengeID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.challengeID) ||
          item.attemptScopeDigest !== directAttempt.scopeDigest ||
          typeof item.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.receiptDigest) ||
          typeof item.outputDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.outputDigest) ||
          typeof item.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.workspaceRevision) ||
          !["FULL", "SAMPLE"].includes(String(item.fidelity)) ||
          typeof item.observedBytes !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(item.observedBytes) ||
          typeof item.droppedBytes !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(item.droppedBytes)) {
          throw fail("protocol", "HostKernel returned an invalid or duplicated direct terminal artifact edge")
        }
        seenEffects.add(item.effectID)
        return item
      })
      return { ...response, artifacts } as unknown as DirectAttemptTerminalArtifactProjectionV1
    })
    const listDirectSessionArtifacts: Interface["listDirectSessionArtifacts"] = Effect.fn("SessionSupervisor.listDirectSessionArtifacts")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("authorization", "root artifact resolution requires authenticated ServerAuth and Session"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated root artifact reads are unavailable"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("execution.v1", "direct_session_artifacts", {
        sessionID: input.sessionID,
        locationID,
      }, { trustedPrincipal: trusted.principal })
      const responseKeys = ["status", "sessionID", "locationID", "currentOwnerEpoch", "artifacts"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== responseKeys.join("\0") ||
        response.status !== "RECOVERED" || response.sessionID !== input.sessionID ||
        response.locationID !== locationID || typeof response.currentOwnerEpoch !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(response.currentOwnerEpoch) ||
        BigInt(response.currentOwnerEpoch) > 0xffff_ffff_ffff_ffffn ||
        !Array.isArray(response.artifacts) || response.artifacts.length > 256) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed root DirectSession artifact provenance"))
      }
      const seenEffects = new Set<string>()
      const artifacts = response.artifacts.map((raw, index) => {
        const item = record(raw)
        const keys = ["artifactRef", "effectID", "batchID", "ownerEpoch", "callIndex", "callID", "challengeID", "receiptDigest", "outputDigest", "workspaceRevision", "fidelity", "observedBytes", "droppedBytes"].toSorted()
        if (Object.keys(item).toSorted().join("\0") !== keys.join("\0") || !validateArtifactRefWire(item.artifactRef) ||
          typeof item.effectID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.effectID) || seenEffects.has(item.effectID) ||
          typeof item.batchID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.batchID) ||
          typeof item.ownerEpoch !== "string" || !/^[1-9][0-9]{0,19}$/.test(item.ownerEpoch) || BigInt(item.ownerEpoch) > 0xffff_ffff_ffff_ffffn ||
          !Number.isSafeInteger(item.callIndex) || (item.callIndex as number) < 0 || (item.callIndex as number) > 31 ||
          typeof item.callID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.callID) ||
          typeof item.challengeID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(item.challengeID) ||
          typeof item.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.receiptDigest) ||
          typeof item.outputDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.outputDigest) ||
          typeof item.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.workspaceRevision) ||
          !["FULL", "SAMPLE"].includes(String(item.fidelity)) ||
          typeof item.observedBytes !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(item.observedBytes) ||
          BigInt(item.observedBytes) > 0xffff_ffff_ffff_ffffn ||
          typeof item.droppedBytes !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(item.droppedBytes) ||
          BigInt(item.droppedBytes) > 0xffff_ffff_ffff_ffffn) {
          throw fail("protocol", "HostKernel returned an invalid or duplicated root terminal artifact edge")
        }
        seenEffects.add(item.effectID)
        return item
      })
      return { ...response, artifacts } as unknown as DirectSessionTerminalArtifactProjectionV1
    })
    const inspectDirectSessionArtifact: Interface["inspectDirectSessionArtifact"] = Effect.fn("SessionSupervisor.inspectDirectSessionArtifact")(function* (input) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef) ||
        !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) || BigInt(input.ownerEpoch) > 0xffff_ffff_ffff_ffffn) {
        return yield* Effect.fail(fail("protocol", "root DirectSession artifact identity is invalid"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "root artifact reads require authenticated ServerAuth"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated root artifact reads are unavailable"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const projection = yield* listDirectSessionArtifacts({ sessionID: input.sessionID, locationRef: input.locationRef })
      if (projection.locationID !== locationID || projection.currentOwnerEpoch !== input.ownerEpoch ||
        !projection.artifacts.some((edge) => sameArtifactRef(edge.artifactRef, input.artifactRef))) {
        return yield* Effect.fail(fail("authorization", "root artifact is stale or absent from the current authenticated receipt index"))
      }
      const response = yield* requestHostKernel("artifact.v1", "artifacts.inspect", {
        schemaVersion: 1,
        artifactRef: input.artifactRef,
      }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: { kind: "direct_session_artifact_read", sessionID: input.sessionID, locationID, artifactRef: input.artifactRef },
      })
      const expected = ["artifactRef", "retentionClass", "createdAt", "fidelity", "droppedByteCount", "encryption", "redaction"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expected.join("\0") ||
        !sameArtifactRef(response.artifactRef, input.artifactRef) ||
        typeof response.retentionClass !== "string" || typeof response.createdAt !== "string" ||
        !["FULL", "SAMPLE", "FAILED"].includes(String(response.fidelity)) ||
        typeof response.droppedByteCount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(response.droppedByteCount) ||
        BigInt(response.droppedByteCount) > 0xffff_ffff_ffff_ffffn ||
        !["NONE", "STATE_KEY"].includes(String(response.encryption)) || !["NOT_NEEDED", "APPLIED", "UNKNOWN"].includes(String(response.redaction))) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed root artifact metadata"))
      }
      return response
    })
    const readDirectSessionArtifactRange: Interface["readDirectSessionArtifactRange"] = Effect.fn("SessionSupervisor.readDirectSessionArtifactRange")(function* (input) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef) ||
        !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) || BigInt(input.ownerEpoch) > 0xffff_ffff_ffff_ffffn ||
        typeof input.offset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(input.offset) || BigInt(input.offset) > 0xffff_ffff_ffff_ffffn ||
        !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 768 * 1024) {
        return yield* Effect.fail(fail("protocol", "root DirectSession artifact range is invalid"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "root artifact reads require authenticated ServerAuth"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated root artifact reads are unavailable"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const projection = yield* listDirectSessionArtifacts({ sessionID: input.sessionID, locationRef: input.locationRef })
      if (projection.locationID !== locationID || projection.currentOwnerEpoch !== input.ownerEpoch ||
        !projection.artifacts.some((edge) => sameArtifactRef(edge.artifactRef, input.artifactRef))) {
        return yield* Effect.fail(fail("authorization", "root artifact is stale or absent from the current authenticated receipt index"))
      }
      const response = yield* requestHostKernel("artifact.v1", "artifacts.read_range", {
        schemaVersion: 1,
        artifactRef: input.artifactRef,
        offset: input.offset,
        maxBytes: input.maxBytes,
      }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: { kind: "direct_session_artifact_read", sessionID: input.sessionID, locationID, artifactRef: input.artifactRef },
      })
      const expected = ["artifactRef", "offset", "nextOffset", "complete", "bytes"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expected.join("\0") ||
        !sameArtifactRef(response.artifactRef, input.artifactRef) || response.offset !== input.offset ||
        typeof response.nextOffset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(response.nextOffset) ||
        BigInt(response.nextOffset) > 0xffff_ffff_ffff_ffffn || typeof response.complete !== "boolean" ||
        !(response.bytes instanceof Uint8Array) || response.bytes.byteLength > input.maxBytes) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed root artifact range data"))
      }
      return response
    })
    const directSessionPermissionModeSnapshot = Effect.fn("SessionSupervisor.directSessionPermissionModeSnapshot")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("authorization", "direct Session permission mode requires authenticated ServerAuth"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("effects.v1", "direct_session_permission_mode_snapshot", {
        sessionID: input.sessionID,
        locationID,
      }, { trustedPrincipal: trusted.principal })
      return yield* Effect.try({
        try: () => decodeDirectSessionPermissionMode(response, { sessionID: input.sessionID, locationID }),
        catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid direct Session permission mode"),
      })
    })
    const directProviderPermissionScope: Interface["directProviderPermissionScope"] = Effect.fn("SessionSupervisor.directProviderPermissionScope")(function* (input) {
      const mode = yield* directSessionPermissionModeSnapshot(input)
      // The digest is HostKernel-authored over the live Session owner epoch,
      // workspace root/backend, Guard policy, and effective Session modes.
      // It is a request pin only; Guard still authorizes every effect separately.
      return {
        sessionID: mode.sessionId,
        locationID: mode.locationId,
        ownerEpoch: mode.ownerEpoch,
        permissionScopeDigest: mode.digest,
        policyDigest: mode.policyDigest,
      }
    })
    const setDirectSessionPermissionMode = Effect.fn("SessionSupervisor.setDirectSessionPermissionMode")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly sandboxMode: DirectSessionPermissionModeV1["sandboxMode"]
      readonly approvalPolicy: DirectSessionPermissionModeV1["approvalPolicy"]
      readonly expectedRevision: string
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) ||
        !/^[1-9][0-9]{0,19}$/.test(input.expectedRevision) || BigInt(input.expectedRevision) > 0xffff_ffff_ffff_ffffn ||
        !["read-only", "workspace-write", "danger-full-access"].includes(input.sandboxMode) ||
        !["on-request", "always", "never"].includes(input.approvalPolicy)) {
        return yield* Effect.fail(fail("authorization", "direct Session permission mode update is invalid"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("effects.v1", "set_direct_session_permission_mode", {
        sessionID: input.sessionID,
        locationID,
        sandboxMode: input.sandboxMode,
        approvalPolicy: input.approvalPolicy,
        expectedRevision: input.expectedRevision,
      }, { trustedPrincipal: trusted.principal })
      return yield* Effect.try({
        try: () => {
          const mode = decodeDirectSessionPermissionMode(response, { sessionID: input.sessionID, locationID })
          if (mode.sandboxMode !== input.sandboxMode || mode.approvalPolicy !== input.approvalPolicy ||
            BigInt(mode.revision) !== BigInt(input.expectedRevision) + 1n) {
            throw fail("protocol", "HostKernel returned a different direct Session permission mode revision")
          }
          return mode
        },
        catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid direct Session permission mode update"),
      })
    })
    const decodeDirectSessionGrantProjection = (response: unknown, expectedStatus: "ACTIVE" | "REVOKED") => {
      const value = record(response)
      const keys = ["status", "grantID", "grantDigest", "scopeKind", "scopeDigest", "expiresAtUnixMs", "revokedAtUnixMs"].toSorted()
      if (Object.keys(value).toSorted().join("\0") !== keys.join("\0") || value.status !== expectedStatus ||
        typeof value.grantID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.grantID) ||
        typeof value.grantDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(value.grantDigest) ||
        typeof value.scopeDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(value.scopeDigest) ||
        (value.scopeKind !== "session" && value.scopeKind !== "workspace") ||
        !(value.expiresAtUnixMs === null || typeof value.expiresAtUnixMs === "string" && /^(0|[1-9][0-9]*)$/.test(value.expiresAtUnixMs)) ||
        !(value.revokedAtUnixMs === null || typeof value.revokedAtUnixMs === "string" && /^(0|[1-9][0-9]*)$/.test(value.revokedAtUnixMs))) {
        throw fail("protocol", "HostKernel direct grant projection is malformed")
      }
      return value as unknown as DirectSessionGrantProjectionV1
    }
    const issueDirectSessionGrant = Effect.fn("SessionSupervisor.issueDirectSessionGrant")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly sessionID: string
      readonly challengeID: string
      readonly effectID: string
      readonly scopeKind: "session" | "workspace"
      readonly actions: readonly ("read" | "edit")[]
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(input.challengeID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.effectID) ||
        (input.scopeKind !== "session" && input.scopeKind !== "workspace") ||
        input.actions.length === 0 || input.actions.length > 2 || new Set(input.actions).size !== input.actions.length ||
        input.actions.some((action) => action !== "read" && action !== "edit")) {
        return yield* Effect.fail(fail("authorization", "direct grant requires a bounded authenticated UI selection"))
      }
      yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const scope = {
        profile: "workspace-code",
        actions: [...input.actions].toSorted(),
        resourceScope: "registered_workspace_and_isolated_temp_cache_roots",
        limits: { maxEffectCount: 64, maxPayloadBytes: 1_048_576, maxWallTimeMs: 30_000 },
      } as const
      const deliveryID = `grantissue_${createHash("sha256").update(JSON.stringify([
        input.challengeID, input.effectID, input.scopeKind, scope.actions, input.sessionID,
      ])).digest("hex")}`
      const response = yield* requestHostKernel("execution.v1", "issue_direct_session_grant", {
        scopeKind: input.scopeKind,
        scope,
        challengeID: input.challengeID,
        effectID: input.effectID,
      }, { trustedPrincipal: trusted.principal, deliveryID })
      const projection = yield* Effect.try({
        try: () => decodeDirectSessionGrantProjection(response, "ACTIVE"),
        catch: () => fail("protocol", "HostKernel did not confirm direct grant issuance"),
      })
      if (projection.scopeKind !== input.scopeKind) return yield* Effect.fail(fail("protocol", "HostKernel direct grant class differs from the selected class"))
      return projection
    })
    const revokeDirectSessionGrant = Effect.fn("SessionSupervisor.revokeDirectSessionGrant")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly grantID: string
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.grantID)) {
        return yield* Effect.fail(fail("authorization", "direct grant revocation requires authenticated ServerAuth"))
      }
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      const response = yield* requestHostKernel("execution.v1", "revoke_direct_session_grant", {
        locationID, grantID: input.grantID,
      }, { trustedPrincipal: trusted.principal, deliveryID: `grantrevoke_${createHash("sha256").update(input.grantID).digest("hex")}` })
      return yield* Effect.try({
        try: () => decodeDirectSessionGrantProjection(response, "REVOKED"),
        catch: () => fail("protocol", "HostKernel did not confirm direct grant revocation"),
      })
    })
    const queryRepoStructure = Effect.fn("SessionSupervisor.queryRepoStructure")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly query: Omit<typeof RepoStructureQueryV1.Type, "sourceGeneration">
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("protocol", "RepoIntel Session ID is invalid"))
      }
      // A continuation is only usable after HostKernel has negotiated and
      // implemented the opaque owner-bound cursor lease. Until then reject it
      // before Location registration or source collection; never restart page 1.
      if (input.query.cursor !== undefined && !hostKernelClient?.enabledFeatures.includes(REPO_INTEL_CURSOR_LEASE_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel", "RepoIntel continuation leases are unavailable", undefined, "capability_unavailable"))
      }
      // An overlay reference has no Core snapshot owner. The gate runs before
      // Location registration or generation acquisition can collect workspace files.
      return yield* withRepoIntelOverlayGate({
        overlayRef: input.query.overlayRef,
        unavailable: () => fail("host-kernel", "RepoIntel overlays are unavailable", undefined, "capability_unavailable"),
        dispatch: () => Effect.gen(function* () {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "RepoIntel requires authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(REPO_INTEL_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated RepoIntel reads are unavailable"))
      }
      const requestId = input.query.queryId
      const now = Date.now()
      const deadlineAt = Date.parse(input.query.deadline)
      if (!Number.isFinite(deadlineAt) || deadlineAt <= now || deadlineAt > now + 5 * 60_000) {
        return yield* Effect.fail(fail("protocol", "RepoIntel query deadline is invalid"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      const authenticatedContext = { kind: "repo_read" as const, sessionID: input.sessionID, locationID }
      let generationPin: typeof RepoGenerationPinV1.Type | undefined
      if (input.query.cursor === undefined) {
        const ensureRequest = yield* Effect.try({
          try: () => Schema.encodeSync(RepoGenerationRequestV1)({
            schemaVersion: 1,
            messageType: "ensure_generation",
            requestId,
            rootRef: input.query.rootRef,
            maxFiles: 4096,
            maxBytes: 67_108_864,
            maxFileBytes: 1_048_576,
            deadline: input.query.deadline,
          }),
          catch: () => fail("protocol", "RepoIntel generation request does not match the strict schema"),
        })
        const generationResponse = yield* requestHostKernel("repo-intel.v1", "ensure_generation", ensureRequest, {
          cancelOnInterrupt: true,
          trustedPrincipal: trusted.principal,
          authenticatedContext,
        })
        generationPin = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(RepoGenerationPinV1, { onExcessProperty: "error" })(generationResponse),
          catch: () => fail("protocol", "HostKernel returned an invalid RepoIntel generation pin"),
        })
        const pinExpiresAt = Date.parse(generationPin.expiresAt)
        const coverageFiles = Number(generationPin.coverage.files)
        const coverageBytes = Number(generationPin.coverage.bytes)
        if (
          generationPin.requestId !== requestId ||
          !Number.isFinite(pinExpiresAt) ||
          pinExpiresAt <= now ||
          pinExpiresAt > now + 5 * 60_000 ||
          pinExpiresAt > deadlineAt ||
          !Number.isSafeInteger(coverageFiles) || coverageFiles < 0 || coverageFiles > 4096 ||
          !Number.isSafeInteger(coverageBytes) || coverageBytes < 0 || coverageBytes > 67_108_864
        ) {
          return yield* Effect.fail(fail("stale-generation", "RepoIntel generation pin or deadline expired", undefined, "stale_generation"))
        }
      }
      const query = yield* Effect.try({
        try: () => Schema.encodeSync(RepoStructureQueryV1)({
          ...input.query,
          ...(generationPin ? { sourceGeneration: generationPin.sourceGeneration } : {}),
        }),
        catch: () => fail("protocol", "RepoIntel query does not match the strict query schema"),
      })
      const response = yield* requestHostKernel("repo-intel.v1", "query_structure", query, {
        cancelOnInterrupt: true,
        trustedPrincipal: trusted.principal,
        authenticatedContext,
      })
      const page = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RepoStructurePageV1, { onExcessProperty: "error" })(response),
        catch: () => fail("protocol", "HostKernel returned an invalid RepoIntel page"),
      })
      if (
        page.status === "STALE" ||
        page.freshness === "stale" ||
        page.queryId !== requestId ||
        (generationPin !== undefined && (
          page.workspaceBinding !== generationPin.workspaceBinding ||
          page.sourceGeneration !== generationPin.sourceGeneration ||
          page.sourceRevision !== generationPin.sourceRevision
        ))
      ) {
        return yield* Effect.fail(fail("stale-generation", "RepoIntel source changed or cursor lease is stale", undefined, "stale_generation"))
      }
      return page
        }),
      })
    })
    const discoverRepo = Effect.fn("SessionSupervisor.discoverRepo")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly request: typeof RepoDiscoveryRequestV1.Type
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("protocol", "RepoIntel Session ID is invalid"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "RepoIntel discovery requires authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(REPO_INTEL_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated RepoIntel discovery is unavailable"))
      }
      const request = yield* Effect.try({
        try: () => Schema.encodeSync(RepoDiscoveryRequestV1)(input.request),
        catch: () => fail("protocol", "RepoIntel discovery request does not match the strict schema"),
      })
      const now = Date.now()
      const deadlineAt = Date.parse(input.request.deadline)
      if (!Number.isFinite(deadlineAt) || deadlineAt <= now || deadlineAt > now + 5 * 60_000) {
        return yield* Effect.fail(fail("protocol", "RepoIntel discovery deadline is invalid"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      const response = yield* requestHostKernel("repo-intel.v1", "discover", request, {
        cancelOnInterrupt: true,
        trustedPrincipal: trusted.principal,
        authenticatedContext: { kind: "repo_read", sessionID: input.sessionID, locationID },
      })
      const page = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RepoDiscoveryPageV1, { onExcessProperty: "error" })(response),
        catch: () => fail("protocol", "HostKernel returned an invalid RepoIntel discovery page"),
      })
      const authority = page.authority
      const expectedRoot = input.request.rootRef
      if (
        page.requestId !== input.request.requestId ||
        authority.sessionID !== input.sessionID || authority.locationID !== locationID ||
        authority.principalBinding !== repoDiscoveryPrincipalBinding(trusted.principal.subject) ||
        authority.ownerEpoch !== String(hostKernelClient.ownerEpoch) ||
        authority.rootRef !== expectedRoot || authority.mode !== input.request.mode ||
        authority.maxEntries !== input.request.maxEntries || authority.maxBytes !== input.request.maxBytes ||
        authority.maxDepth !== input.request.maxDepth ||
        !repoDiscoveryPageMatchesRequest(input.request, page)
      ) {
        return yield* Effect.fail(fail("stale-generation", "RepoIntel discovery authority or bounds do not match the request", undefined, "stale_generation"))
      }
      return page
    })
    const readRepoDocument = Effect.fn("SessionSupervisor.readRepoDocument")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly request: typeof RepoDocumentReadRequestV1.Type
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("protocol", "RepoIntel Session ID is invalid"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "RepoIntel document read requires authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(REPO_INTEL_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated RepoIntel reads are unavailable"))
      }
      const body = yield* Effect.try({
        try: () => Schema.encodeSync(RepoDocumentReadRequestV1)(input.request),
        catch: () => fail("protocol", "RepoIntel document read request does not match the strict schema"),
      })
      const locationID = yield* registerHostLocation(input.locationRef)
      const response = yield* requestHostKernel("repo-intel.v1", "read_document", body, {
        cancelOnInterrupt: true,
        trustedPrincipal: trusted.principal,
        authenticatedContext: { kind: "repo_read", sessionID: input.sessionID, locationID },
      })
      const document = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RepoDocumentReadResponseV1, { onExcessProperty: "error" })(response),
        catch: () => fail("protocol", "HostKernel returned an invalid RepoIntel document"),
      })
      if (
        document.pathRef !== input.request.pathRef ||
        document.revisionKind !== input.request.revisionKind ||
        document.observedWorkspaceRevision !== input.request.expectedWorkspaceRevision ||
        Buffer.byteLength(document.text, "utf8") > input.request.maxBytes ||
        document.contentDigest !== repoDocumentContentDigest(document.text)
      ) {
        return yield* Effect.fail(fail("stale-generation", "RepoIntel document binding, digest, or revision does not match the request", undefined, "stale_generation"))
      }
      return document
    })
    const resolveVerifiedManagedArtifactScope = Effect.fn("SessionSupervisor.resolveVerifiedManagedArtifactScope")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly artifactRef: ArtifactRefWireV1
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef)) {
        return yield* Effect.fail(fail("protocol", "managed artifact identity is invalid"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "artifact scope resolution requires authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated managed artifact reads are unavailable"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      const response = yield* requestHostKernel("artifact.v1", "artifacts.resolve_scope", {
        schemaVersion: 1,
        artifactRef: input.artifactRef,
      }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "artifact_scope_resolve",
          sessionID: input.sessionID,
          locationID,
          artifactRef: input.artifactRef,
        },
      })
      if (Object.keys(response).toSorted().join("\0") !== ["artifactRef", "managedAttempt", "schemaVersion"].sort().join("\0") ||
        response.schemaVersion !== 1 || !sameArtifactRef(response.artifactRef, input.artifactRef)) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned an invalid verified artifact scope"))
      }
      const scope = yield* Effect.try({
        try: () => managedAttemptScopeFromWire(response.managedAttempt),
        catch: () => fail("protocol", "HostKernel returned an invalid verified artifact Attempt scope"),
      })
      return scope
    })
    const inspectManagedArtifact = Effect.fn("SessionSupervisor.inspectManagedArtifact")(function* (input: {
      readonly sessionID: string
      readonly managedAttempt: ManagedAttemptScopeV1
      readonly artifactRef: ArtifactRefWireV1
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef)) {
        return yield* Effect.fail(fail("protocol", "managed artifact identity is invalid"))
      }
      const scope = yield* Effect.try({
        try: () => managedAttemptScopeToWire(input.managedAttempt),
        catch: () => fail("protocol", "managed artifact Attempt scope is invalid"),
      })
      if (scope.sessionID !== input.sessionID) {
        return yield* Effect.fail(fail("authorization", "managed artifact Attempt does not belong to the current Session"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "artifact reads require authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated managed artifact reads are unavailable"))
      }
      const locationID = scope.locationID
      return yield* requestHostKernel("artifact.v1", "artifacts.inspect", { artifactRef: input.artifactRef }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "artifact_read",
          sessionID: input.sessionID,
          locationID,
          artifactRef: input.artifactRef,
          managedAttempt: scope,
        },
      })
    })
    const readManagedArtifactRange = Effect.fn("SessionSupervisor.readManagedArtifactRange")(function* (input: {
      readonly sessionID: string
      readonly managedAttempt: ManagedAttemptScopeV1
      readonly artifactRef: ArtifactRefWireV1
      readonly offset: string
      readonly maxBytes: number
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef) ||
        typeof input.offset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(input.offset) || BigInt(input.offset) > 0xffff_ffff_ffff_ffffn ||
        !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 768 * 1024) {
        return yield* Effect.fail(fail("protocol", "managed artifact range is invalid"))
      }
      const scope = yield* Effect.try({
        try: () => managedAttemptScopeToWire(input.managedAttempt),
        catch: () => fail("protocol", "managed artifact Attempt scope is invalid"),
      })
      if (scope.sessionID !== input.sessionID) {
        return yield* Effect.fail(fail("authorization", "managed artifact Attempt does not belong to the current Session"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "artifact reads require authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated managed artifact reads are unavailable"))
      }
      const locationID = scope.locationID
      return yield* requestHostKernel("artifact.v1", "artifacts.read_range", {
        artifactRef: input.artifactRef,
        offset: input.offset,
        maxBytes: input.maxBytes,
      }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "artifact_read",
          sessionID: input.sessionID,
          locationID,
          artifactRef: input.artifactRef,
          managedAttempt: scope,
        },
      })
    })
    const inspectDirectAttemptArtifact = Effect.fn("SessionSupervisor.inspectDirectAttemptArtifact")(function* (input: {
      readonly sessionID: string
      readonly directAttempt: DirectAttemptScopeV1
      readonly artifactRef: ArtifactRefWireV1
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef)) {
        return yield* Effect.fail(fail("protocol", "direct artifact identity is invalid"))
      }
      const scope = yield* Effect.try({
        try: () => directAttemptScopeToWire(input.directAttempt),
        catch: () => fail("protocol", "direct artifact Attempt scope is invalid"),
      })
      if (scope.childSessionID !== input.sessionID) {
        return yield* Effect.fail(fail("authorization", "direct artifact Attempt does not belong to the current Session"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "artifact reads require authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated direct artifact reads are unavailable"))
      }
      return yield* requestHostKernel("artifact.v1", "artifacts.inspect", { artifactRef: input.artifactRef }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "artifact_read",
          sessionID: input.sessionID,
          locationID: scope.locationID,
          artifactRef: input.artifactRef,
          directAttempt: scope,
        },
      })
    })
    const readDirectAttemptArtifactRange = Effect.fn("SessionSupervisor.readDirectAttemptArtifactRange")(function* (input: {
      readonly sessionID: string
      readonly directAttempt: DirectAttemptScopeV1
      readonly artifactRef: ArtifactRefWireV1
      readonly offset: string
      readonly maxBytes: number
    }) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !validateArtifactRefWire(input.artifactRef) ||
        typeof input.offset !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(input.offset) || BigInt(input.offset) > 0xffff_ffff_ffff_ffffn ||
        !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 768 * 1024) {
        return yield* Effect.fail(fail("protocol", "direct artifact range is invalid"))
      }
      const scope = yield* Effect.try({
        try: () => directAttemptScopeToWire(input.directAttempt),
        catch: () => fail("protocol", "direct artifact Attempt scope is invalid"),
      })
      if (scope.childSessionID !== input.sessionID) {
        return yield* Effect.fail(fail("authorization", "direct artifact Attempt does not belong to the current Session"))
      }
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "artifact reads require authenticated ServerAuth context"))
      }
      if (!hostKernelClient?.enabledFeatures.includes(ARTIFACT_READ_CONTEXT_FEATURE)) {
        return yield* Effect.fail(fail("host-kernel-feature", "authenticated direct artifact reads are unavailable"))
      }
      return yield* requestHostKernel("artifact.v1", "artifacts.read_range", {
        artifactRef: input.artifactRef,
        offset: input.offset,
        maxBytes: input.maxBytes,
      }, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "artifact_read",
          sessionID: input.sessionID,
          locationID: scope.locationID,
          artifactRef: input.artifactRef,
          directAttempt: scope,
        },
      })
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
      readonly capabilityID: UserEffectCapabilityID
      readonly arguments: Readonly<Record<string, unknown>>
    }) {
      const trusted = yield* TrustedPrincipalContext
      const automationAction = input.capabilityID.startsWith("automations.")
      if (automationAction && (trusted.principal.kind !== "server_auth" || !trusted.principal.subject)) {
        return yield* Effect.fail(fail("authorization", "automation definition changes require authenticated ServerAuth"))
      }
      if (automationAction && input.sessionID !== undefined) {
        return yield* Effect.fail(fail("authorization", "automation definition changes use the authenticated workspace-owner lane"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      const userActionID = `action_${randomUUID().replaceAll("-", "")}`
      const response = yield* requestHostKernel("effects.v2", "prepare_user_effect", {
        locationID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        userActionID,
        capabilityID: input.capabilityID,
        arguments: input.arguments,
      }, { trustedPrincipal: trusted.principal })
      if (response.status === "prepared") {
        const lease = yield* Effect.try({
          try: () => parseCapabilityLease(response),
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid capability lease"),
        })
        return { ...lease, locationID, userActionID, capabilityID: input.capabilityID }
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
          const expiresAtUnixMs = wireUnixMs(response.expiresAtUnixMs)
          const normalizedTargets = response.normalizedTargets
          const policySummary = stringField(response, "policySummary", 1024)
          const consent = validateGuardConsentProjection(response, {
            capabilityID,
            origin: "user_action",
            source: "authenticated.user_action",
          })
          if (
            capabilityID !== input.capabilityID ||
            responseLocationID !== locationID ||
            !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
            expiresAtUnixMs === undefined ||
            expiresAtUnixMs <= Date.now() ||
            expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
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
            expiresAtUnixMs,
            policySummary,
            ...consent,
          }
        },
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid approval challenge"),
      })
      const decision = yield* awaitGuardApproval(challenge, trusted.principal, input.locationRef)
      if (decision === "allow_once" && !challenge.allowEnabled) {
        return yield* Effect.fail(fail("authorization", "Guard allow is unavailable without assessed guarantees"))
      }
      const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: challenge.challengeID,
        decision,
      }, { trustedPrincipal: trusted.principal })
      if (decision !== "allow_once") return yield* Effect.fail(fail("authorization", "Guard approval was denied"))
      if (resolved.status !== "approved") {
        return yield* Effect.fail(fail("authorization", "host rejected Guard approval"))
      }
      const lease = yield* Effect.try({
        try: () => parseCapabilityLease(resolved),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid capability lease"),
      })
      if (lease.effectID !== challenge.effectID) {
        return yield* Effect.fail(fail("protocol", "approval lease does not match its challenge"))
      }
      return {
        ...lease,
        locationID,
        userActionID,
        capabilityID: input.capabilityID,
        challengeID: challenge.challengeID,
        inputDigest: challenge.inputDigest,
      }
    })
    const codeModeHostRequest: Interface["codeModeHostRequest"] = Effect.fn("SessionSupervisor.codeModeHostRequest")(function* (input) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject ||
        !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.callID) ||
        !["codemode_enablement", "codemode_start", "codemode_resume", "codemode_cancel", "codemode_cancel_wave", "codemode_inspect", "codemode_prepare_wave", "codemode_settle_tool_results", "codemode_wave_receipts"].includes(input.operation) ||
        input.body.schemaVersion !== 1 || (input.lane === "managed_attempt") !== (input.managedAttempt !== undefined)) {
        return yield* Effect.fail(fail("authorization", "CodeMode request requires authenticated Session and Tool.Context correlation"))
      }
      const bindingMatches = input.lane === "direct_session"
        ? input.managedAttempt === undefined && input.body.lane === "direct_session" && input.body.sessionID === input.sessionID
        : input.managedAttempt !== undefined && input.body.lane === "managed_attempt" &&
          input.body.runID === input.managedAttempt.runID && input.body.taskID === input.managedAttempt.taskID &&
          input.body.attemptID === input.managedAttempt.attemptID && input.managedAttempt.sessionID === input.sessionID
      if (!bindingMatches) return yield* Effect.fail(fail("authorization", "CodeMode public lane binding differs from private Tool.Context"))
      const locationID = yield* registerHostLocationFor(input.locationRef, trusted.principal)
      let managedAttempt: ManagedAttemptScopeV1 | undefined
      if (input.managedAttempt) {
        const scope = managedAttemptScopeToWire(input.managedAttempt)
        if (scope.locationID !== locationID) return yield* Effect.fail(fail("authorization", "CodeMode managed Attempt Location differs from authenticated Location"))
        managedAttempt = input.managedAttempt
      }
      return yield* requestHostKernel("execution.v1", input.operation, input.body, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: {
          kind: "code_mode_call",
          sessionID: input.sessionID,
          locationID,
          callID: input.callID,
          lane: input.lane,
          ...(managedAttempt ? { managedAttempt } : {}),
        },
      })
    })
    const prepareCodeModeToolBatch: Interface["prepareCodeModeToolBatch"] = Effect.fn("SessionSupervisor.prepareCodeModeToolBatch")(function* (input) {
      if (input.calls.some((call) => !validBatchIdentity(call.toolName))) {
        return yield* Effect.fail(fail("protocol", "CodeMode resolved executor name is invalid"))
      }
      yield* Effect.try({
        try: () => validateToolBatchCalls(input.calls),
        catch: () => fail("protocol", "CodeMode ToolBatch calls are malformed or exceed ordinary admission bounds"),
      })
      const laneBinding = input.lane === "direct_session"
        ? { sessionID: input.sessionID }
        : { runID: input.managedAttempt!.runID, taskID: input.managedAttempt!.taskID, attemptID: input.managedAttempt!.attemptID }
      return yield* codeModeHostRequest({
        operation: "codemode_prepare_wave",
        body: { schemaVersion: 1, lane: input.lane, ...laneBinding, requestId: input.requestID,
          waveFrame: input.waveFrame, calls: input.calls },
        sessionID: input.sessionID, locationRef: input.locationRef, callID: input.callID,
        lane: input.lane, ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
      })
    })
    const settleCodeModeToolResults: Interface["settleCodeModeToolResults"] = Effect.fn("SessionSupervisor.settleCodeModeToolResults")(function* (input) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.callID) ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID) || !Number.isInteger(input.waveIndex) || input.waveIndex < 0 || input.waveIndex > 63 ||
        input.results.length < 1 || input.results.length > MAX_TOOL_BATCH_CALLS || input.results.some((result, index) =>
          result.callIndex !== index || !/^[A-Za-z0-9._:-]{1,256}$/.test(result.callID) ||
          !["settled", "rejected", "cancelled", "unknown"].includes(result.status) ||
          (result.status === "settled" && (typeof result.resultDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(result.resultDigest) ||
            !Number.isSafeInteger(result.outputBytes) || result.outputBytes! < 0 || result.outputBytes! > 65536 || result.errorCode !== undefined)) ||
          (result.status !== "unknown" && ((result.resultDigest === undefined) !== (result.outputBytes === undefined) ||
            (result.resultDigest !== undefined && (typeof result.resultDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(result.resultDigest))))) ||
          (result.status === "unknown" && (result.resultDigest !== undefined || result.outputBytes !== undefined || result.errorCode !== undefined)) ||
          (result.outputBytes !== undefined && (!Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0 || result.outputBytes > 65536)) ||
          (result.errorCode !== undefined && (typeof result.errorCode !== "string" || result.errorCode.length > 128)))) {
        return yield* Effect.fail(fail("protocol", "CodeMode callback settlement is malformed or outside bounds"))
      }
      const laneBinding = input.lane === "direct_session"
        ? { sessionID: input.sessionID }
        : { runID: input.managedAttempt!.runID, taskID: input.managedAttempt!.taskID, attemptID: input.managedAttempt!.attemptID }
      return yield* codeModeHostRequest({
        operation: "codemode_settle_tool_results",
        body: { schemaVersion: 1, lane: input.lane, ...laneBinding, requestId: input.requestID,
          waveIndex: input.waveIndex, results: input.results.map((result) => ({
            ...result, resultDigest: result.resultDigest ?? null, outputBytes: result.outputBytes ?? null,
            errorCode: result.errorCode ?? null,
          })) },
        sessionID: input.sessionID, locationRef: input.locationRef, callID: input.callID,
        lane: input.lane, ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
      })
    })
    const codeModeWaveReceipts: Interface["codeModeWaveReceipts"] = Effect.fn("SessionSupervisor.codeModeWaveReceipts")(function* (input) {
      const laneBinding = input.lane === "direct_session"
        ? { sessionID: input.sessionID }
        : { runID: input.managedAttempt!.runID, taskID: input.managedAttempt!.taskID, attemptID: input.managedAttempt!.attemptID }
      const response = yield* codeModeHostRequest({
        operation: "codemode_wave_receipts",
        body: { schemaVersion: 1, lane: input.lane, ...laneBinding, requestId: input.requestID,
          waveIndex: input.waveIndex },
        sessionID: input.sessionID, locationRef: input.locationRef, callID: input.callID,
        lane: input.lane, ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
      })
      const expected = ["status", "requestID", "batchID", "waveIndex", "results", "receiptDigest"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expected.join("\0") ||
        !["settled", "rejected", "cancelled", "unknown"].includes(String(response.status)) ||
        response.requestID !== input.requestID || response.waveIndex !== input.waveIndex ||
        typeof response.batchID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(response.batchID) ||
        !Array.isArray(response.results) || response.results.length < 1 || response.results.length > MAX_TOOL_BATCH_CALLS) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed CodeMode wave result provenance"))
      }
      const results = response.results.map((raw, index) => {
        const item = record(raw)
        const keys = ["callIndex", "callID", "status", "receiptKind", "receiptRef", "receiptDigest", "resultDigest", "outputBytes", "errorCode"].toSorted()
        if (Object.keys(item).toSorted().join("\0") !== keys.join("\0") || item.callIndex !== index ||
          typeof item.callID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.callID) ||
          !["settled", "rejected", "cancelled", "unknown"].includes(String(item.status))) {
          throw fail("protocol", "HostKernel CodeMode result rows are malformed or reordered")
        }
        if (item.status === "unknown") {
          if (item.receiptKind !== null || item.receiptRef !== null || item.receiptDigest !== null ||
            item.resultDigest !== null || item.outputBytes !== null || item.errorCode !== null) {
            throw fail("protocol", "UNKNOWN CodeMode result exposes receipt provenance")
          }
        } else if ((item.receiptKind !== "effect_receipt" && item.receiptKind !== "host_decision" && item.receiptKind !== "tool_result") ||
          typeof item.receiptRef !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(item.receiptRef) ||
          typeof item.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.receiptDigest) ||
          (item.receiptKind === "tool_result" && item.status === "settled" &&
            (typeof item.resultDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.resultDigest) ||
             !Number.isSafeInteger(item.outputBytes) || (item.outputBytes as number) < 0 || (item.outputBytes as number) > 65536)) ||
          (item.receiptKind !== "tool_result" && (item.resultDigest !== null || item.outputBytes !== null)) ||
          (item.receiptKind === "tool_result" && ((item.resultDigest === null) !== (item.outputBytes === null) ||
            (item.resultDigest !== null && (typeof item.resultDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(item.resultDigest))) ||
            (item.outputBytes !== null && (!Number.isSafeInteger(item.outputBytes) || (item.outputBytes as number) < 0 || (item.outputBytes as number) > 65536)))) ||
          (item.errorCode !== null && (typeof item.errorCode !== "string" || item.errorCode.length > 128))) {
          throw fail("protocol", "Known CodeMode result lacks correct typed provenance")
        }
        return item
      })
      const aggregateStatus = results.some((item) => item.status === "unknown") ? "unknown" :
        results.some((item) => item.status === "cancelled") ? "cancelled" :
          results.some((item) => item.status === "rejected") ? "rejected" : "settled"
      if (response.status !== aggregateStatus) {
        return yield* Effect.fail(fail("protocol", "HostKernel CodeMode aggregate status differs from ordered rows"))
      }
      if (aggregateStatus === "unknown") {
        if (response.receiptDigest !== null) {
          return yield* Effect.fail(fail("protocol", "UNKNOWN CodeMode wave cannot claim an aggregate receipt digest"))
        }
      } else {
        if (typeof response.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.receiptDigest)) {
          return yield* Effect.fail(fail("protocol", "Known CodeMode wave lacks its aggregate receipt digest"))
        }
        const tuples = results.map((item, index) => [
          input.waveIndex,
          index,
          item.callID as string,
          item.status as "settled" | "rejected" | "cancelled",
          item.receiptKind as "effect_receipt" | "host_decision" | "tool_result",
          item.receiptRef as string,
          item.receiptDigest as string,
        ] as const)
        const encoded = encodeCanonicalMessagePackV1(tuples, {
          maxEncodedBytes: 1024 * MAX_TOOL_BATCH_CALLS,
          maxDepth: 4,
          maxNodes: 1 + MAX_TOOL_BATCH_CALLS * 8,
          maxCollectionItems: 1 + MAX_TOOL_BATCH_CALLS,
          maxScalarBytes: MAX_IDENTIFIER_BYTES,
        })
        const domain = new TextEncoder().encode("horizoncode.codemode-wave-receipts.v2\0")
        const bytes = new Uint8Array(domain.byteLength + encoded.byteLength)
        bytes.set(domain)
        bytes.set(encoded, domain.byteLength)
        const digest = `blake3:${bytesToHex(blake3(bytes))}`
        if (digest !== response.receiptDigest) {
          return yield* Effect.fail(fail("protocol", "HostKernel CodeMode aggregate receipt digest differs from ordered rows"))
        }
      }
      return { ...response, results } as Readonly<Record<string, unknown>>
    })
    const cancelCodeModeWave: NonNullable<Interface["cancelCodeModeWave"]> = Effect.fn("SessionSupervisor.cancelCodeModeWave")(function* (input) {
      if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.callID) ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID) || !Number.isInteger(input.waveIndex) || input.waveIndex < 0 || input.waveIndex > 63 ||
        !["user_abort", "deadline", "parent_cancel"].includes(input.reason) ||
        (input.lane === "managed_attempt") !== (input.managedAttempt !== undefined)) {
        return yield* Effect.fail(fail("protocol", "CodeMode wave cancellation selector is invalid"))
      }
      const laneBinding = input.lane === "direct_session"
        ? { sessionID: input.sessionID }
        : { runID: input.managedAttempt!.runID, taskID: input.managedAttempt!.taskID, attemptID: input.managedAttempt!.attemptID }
      const response = yield* codeModeHostRequest({
        operation: "codemode_cancel_wave",
        body: { schemaVersion: 1, lane: input.lane, ...laneBinding, requestId: input.requestID, waveIndex: input.waveIndex, reason: input.reason },
        sessionID: input.sessionID, locationRef: input.locationRef, callID: input.callID,
        lane: input.lane, ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
      })
      const expected = ["status", "requestID", "batchID", "waveIndex", "results", "receiptDigest"].toSorted()
      if (Object.keys(response).toSorted().join("\0") !== expected.join("\0") ||
        !["cancelled", "unknown"].includes(String(response.status)) || response.requestID !== input.requestID ||
        response.waveIndex !== input.waveIndex || typeof response.batchID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(response.batchID) ||
        !Array.isArray(response.results) || response.results.length < 1 || response.results.length > MAX_TOOL_BATCH_CALLS ||
        (response.status === "cancelled" ? typeof response.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(response.receiptDigest) : response.receiptDigest !== null)) {
        return yield* Effect.fail(fail("protocol", "HostKernel returned malformed correlated CodeMode cancellation"))
      }
      const rows = response.results.map((raw, index) => {
        const row = record(raw)
        const keys = ["callIndex", "callID", "status", "receiptKind", "receiptRef", "receiptDigest", "resultDigest", "outputBytes", "errorCode"].toSorted()
        if (Object.keys(row).toSorted().join("\0") !== keys.join("\0") || row.callIndex !== index ||
          typeof row.callID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(row.callID) ||
          (response.status === "unknown"
            ? row.status !== "unknown" || row.receiptKind !== null || row.receiptRef !== null || row.receiptDigest !== null || row.resultDigest !== null || row.outputBytes !== null || row.errorCode !== null
            : row.status !== "cancelled" || row.receiptKind !== "host_decision" || typeof row.receiptRef !== "string" ||
              !/^[A-Za-z0-9._:-]{1,256}$/.test(row.receiptRef) || typeof row.receiptDigest !== "string" ||
              !/^blake3:[0-9a-f]{64}$/.test(row.receiptDigest) || row.resultDigest !== null || row.outputBytes !== null ||
              (row.errorCode !== null && (typeof row.errorCode !== "string" || Buffer.byteLength(row.errorCode, "utf8") > 128)))) {
          throw fail("protocol", "HostKernel cancellation rows are malformed or uncorrelated")
        }
        return row
      })
      return { ...response, results: rows }
    })
    const resolveEditorProcessApproval = Effect.fn("SessionSupervisor.resolveEditorProcessApproval")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly challenge: GuardApprovalRequest
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "editor process approval requires authenticated ServerAuth"))
      }
      const challenge = input.challenge
      const capabilityID = challenge.capabilityID
      if (capabilityID !== "language.start" && capabilityID !== "debug.start") {
        return yield* Effect.fail(fail("protocol", "editor process approval has an unsupported capability"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      if (challenge.locationID !== locationID ||
        typeof challenge.sessionID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge.sessionID) ||
        typeof challenge.challengeID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge.challengeID) ||
        typeof challenge.effectID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge.effectID)) {
        return yield* Effect.fail(fail("protocol", "editor process challenge identity is invalid"))
      }
      const consent = yield* Effect.try({
        try: () => validateGuardConsentProjection(challenge as unknown as Record<string, unknown>, {
          capabilityID,
          origin: "user_action",
          source: "authenticated.user_action",
        }),
        catch: (error) => error instanceof SessionSupervisorError
          ? error
          : fail("protocol", "editor process Guard consent projection is invalid"),
      })
      const request: GuardApprovalRequest = {
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        capabilityID,
        locationID,
        sessionID: challenge.sessionID,
        inputDigest: challenge.inputDigest,
        normalizedTargets: challenge.normalizedTargets,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        policySummary: challenge.policySummary,
        ...consent,
      }
      const decision = yield* awaitGuardApproval(request, trusted.principal, input.locationRef)
      if (decision !== "allow_once") return yield* Effect.fail(fail("authorization", "editor process Guard approval was denied"))
      if (!request.allowEnabled) return yield* Effect.fail(fail("authorization", "Guard allow is unavailable without assessed guarantees"))
      const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: request.challengeID,
        decision,
      }, { trustedPrincipal: trusted.principal })
      if (resolved.status !== "approved") return yield* Effect.fail(fail("authorization", "HostKernel rejected editor process approval"))
      const lease = yield* Effect.try({
        try: () => parseCapabilityLease(resolved),
        catch: (error) => error instanceof SessionSupervisorError
          ? error
          : fail("protocol", "HostKernel returned an invalid editor process lease"),
      })
      if (lease.effectID !== request.effectID) return yield* Effect.fail(fail("protocol", "editor process lease differs from its Guard challenge"))
      return {
        ...lease,
        locationID,
        capabilityID,
        challengeID: request.challengeID,
        inputDigest: request.inputDigest,
      } satisfies PreparedEditorProcessApprovalV1
    })
    const authorizeEditorProtocolOperation = Effect.fn("SessionSupervisor.authorizeEditorProtocolOperation")(
      function* (input: EditorProtocolAuthorizationRequestV1) {
        const trusted = yield* TrustedPrincipalContext
        if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
          return yield* Effect.fail(fail("authorization", "editor protocol authorization requires authenticated ServerAuth"))
        }
        if (!EDITOR_PROTOCOL_GUARD_RUNTIME_READY) {
          return yield* Effect.fail(fail("host-kernel-feature", "LSP/DAP per-operation Guard admission is unavailable until integrated acceptance passes"))
        }
        const locationID = yield* registerHostLocation(input.locationRef)
        const authorization = yield* Effect.try({
          try: () => {
            const subject = record(input.arguments)
            const required = ["hostProcessRef", "sessionID", "locationID", "workspaceRevision", "protocol", "requestSequence", "operation"]
            const optional = ["operationDigest", "callbackEventSequence"]
            if (Object.keys(subject).toSorted().join("\0") !== [...required, ...Object.keys(subject).filter((key) => optional.includes(key))].sort().join("\0")) {
              throw fail("protocol", "editor protocol authorization subject has unknown or missing fields")
            }
            const hostProcessRef = record(subject.hostProcessRef)
            const processKeys = ["executionID", "generation", "ownerEpoch", "kind", "profileID", "profileRevision", "profileDigest", "executableDigest"]
            if (Object.keys(hostProcessRef).toSorted().join("\0") !== processKeys.sort().join("\0")) {
              throw fail("protocol", "editor protocol HostProcessRef is malformed")
            }
            const protocol = subject.protocol
            const kind = protocol === "lsp" ? "language_server" : protocol === "dap" ? "debug_adapter" : undefined
            const sequence = subject.requestSequence
            const operation = record(subject.operation)
            if (
              !kind || hostProcessRef.kind !== kind || subject.sessionID !== input.sessionID ||
              subject.locationID !== locationID || typeof subject.workspaceRevision !== "string" ||
              !/^blake3:[0-9a-f]{64}$/.test(subject.workspaceRevision) ||
              typeof sequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(sequence) || BigInt(sequence) > 0xffff_ffff_ffff_ffffn ||
              operation.requestSequence !== sequence ||
              (subject.operationDigest !== undefined && (typeof subject.operationDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(subject.operationDigest)))
            ) throw fail("protocol", "editor protocol authorization pins are invalid")
            const callback = Object.hasOwn(subject, "callbackEventSequence")
            const isReply = protocol === "lsp" && Object.hasOwn(operation, "serverRequestID")
            if (callback !== isReply || (callback && (typeof subject.callbackEventSequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(subject.callbackEventSequence) || BigInt(subject.callbackEventSequence) > 0xffff_ffff_ffff_ffffn))) {
              throw fail("protocol", "editor protocol callback correlation is invalid")
            }
            for (const key of ["executionID", "profileID"] as const) {
              if (typeof hostProcessRef[key] !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(hostProcessRef[key] as string)) {
                throw fail("protocol", `editor protocol HostProcessRef ${key} is invalid`)
              }
            }
            for (const key of ["generation", "ownerEpoch", "profileRevision"] as const) {
              const value = hostProcessRef[key]
              if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
                throw fail("protocol", `editor protocol HostProcessRef ${key} is invalid`)
              }
            }
            for (const key of ["profileDigest", "executableDigest"] as const) {
              if (typeof hostProcessRef[key] !== "string" || !/^blake3:[0-9a-f]{64}$/.test(hostProcessRef[key] as string)) {
                throw fail("protocol", `editor protocol HostProcessRef ${key} is invalid`)
              }
            }
            return Object.freeze({ ...subject })
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "editor protocol authorization subject is invalid"),
        })
        if (!input.sessionID || !/^[A-Za-z0-9._-]{1,256}$/.test(input.sessionID) ||
          (input.managedAttempt !== undefined && input.directAttempt !== undefined)) {
          return yield* Effect.fail(fail("protocol", "editor protocol authorization cannot combine Attempt scopes"))
        }
        // The HostKernel MessagePack parser requires unsigned integers for the
        // direct Attempt u64 fields, so the RPC body carries the wire projection.
        const scope: { readonly managedAttempt?: ManagedAttemptScopeV1; readonly directAttempt?: DirectAttemptScopeWireV1 } = yield* Effect.try({
          try: () => input.managedAttempt !== undefined
            ? { managedAttempt: managedAttemptScopeToWire(input.managedAttempt) }
            : input.directAttempt !== undefined
              ? { directAttempt: directAttemptScopeToWire(input.directAttempt) }
              : {},
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "editor protocol Attempt scope is invalid"),
        })
        const attemptScope = input.managedAttempt !== undefined ? scope.managedAttempt : scope.directAttempt
        const attemptSessionID = input.managedAttempt?.sessionID ?? input.directAttempt?.childSessionID
        const attemptOwnerEpoch = input.managedAttempt?.ownerEpoch ?? input.directAttempt?.ownerEpoch
        // The authorization subject above strictly validated HostProcessRef with a
        // canonical decimal-string ownerEpoch; re-extract it fail-closed for the
        // exact epoch comparisons below.
        const authorizationOwnerEpoch = yield* Effect.try({
          try: () => {
            const processRef = record(authorization.hostProcessRef)
            const ownerEpoch = processRef.ownerEpoch
            if (typeof ownerEpoch !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(ownerEpoch) || BigInt(ownerEpoch) > 0xffff_ffff_ffff_ffffn) {
              throw fail("protocol", "editor protocol HostProcessRef ownerEpoch is invalid")
            }
            return ownerEpoch
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "editor protocol HostProcessRef is invalid"),
        })
        if (authorization.sessionID !== input.sessionID || authorization.locationID !== locationID ||
          (attemptScope !== undefined && (attemptSessionID !== input.sessionID || attemptScope.locationID !== locationID ||
            authorization.workspaceRevision !== attemptScope.workspaceRevision ||
            authorizationOwnerEpoch !== attemptOwnerEpoch))) {
          return yield* Effect.fail(fail("authorization", "editor protocol subject differs from its authenticated Session scope"))
        }
        if (attemptScope === undefined) {
          const currentOwnerEpoch = yield* hostOwnerEpoch()
          if (authorizationOwnerEpoch !== String(currentOwnerEpoch)) {
            return yield* Effect.fail(fail("authorization", "root Session protocol process belongs to a stale HostKernel epoch"))
          }
        }
        if (input.capabilityID.length === 0 || input.capabilityID.length > 160 || /[\0\s]/.test(input.capabilityID)) {
          return yield* Effect.fail(fail("protocol", "editor protocol capability ID is invalid"))
        }
        const userActionID = `action_${randomUUID().replaceAll("-", "")}`
        const response = yield* requestHostKernel("effects.v2", "prepare_user_effect", {
          locationID,
          userActionID,
          capabilityID: input.capabilityID,
          sessionID: input.sessionID,
          arguments: authorization,
          ...scope,
        }, { trustedPrincipal: trusted.principal })
        if (response.status === "denied") return yield* Effect.fail(fail("authorization", "Guard denied the editor protocol operation"))
        if (response.status !== "needs_approval") {
          return yield* Effect.fail(fail("protocol", "HostKernel returned an invalid editor protocol admission"))
        }
        const challenge = yield* Effect.try({
          try: () => {
            const challengeID = stringField(response, "challengeID")
            const effectID = stringField(response, "effectID")
            const capabilityID = stringField(response, "capabilityID")
            const responseLocationID = stringField(response, "locationID")
            const inputDigest = stringField(response, "inputDigest")
            const expiresAtUnixMs = wireUnixMs(response.expiresAtUnixMs)
            const normalizedTargets = response.normalizedTargets
            const policySummary = stringField(response, "policySummary", 1024)
            const consent = validateGuardConsentProjection(response, {
              capabilityID,
              origin: "user_action",
              source: "authenticated.user_action",
            })
            if (capabilityID !== input.capabilityID || responseLocationID !== locationID ||
              !/^blake3:[0-9a-f]{64}$/.test(inputDigest) || expiresAtUnixMs === undefined ||
              expiresAtUnixMs <= Date.now() || expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
              !Array.isArray(normalizedTargets) || normalizedTargets.length === 0 || normalizedTargets.length > 64) {
              throw fail("protocol", "HostKernel returned an invalid editor protocol Guard challenge")
            }
            return {
              approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
              challengeID, effectID, capabilityID, locationID, sessionID: input.sessionID,
              inputDigest, normalizedTargets, expiresAtUnixMs, policySummary, ...consent,
            } satisfies GuardApprovalRequest
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel editor protocol challenge is malformed"),
        })
        // A direct root Session may already have an exact persisted routine
        // grant. HostKernel preflight is read-only: it re-resolves the retained
        // challenge/process/workspace and returns correlation data only. The
        // ordinary allow_once resolution below still reserves grant use,
        // rechecks Guard, and issues the one-use lease atomically. Child and
        // managed Attempts, LSP callbacks, and any preflight error always use
        // the normal approval UI.
        const directGrantPreflightDigest = !attemptScope &&
          authorization.callbackEventSequence === undefined && challenge.allowEnabled
          ? yield* requestHostKernel("effects.v1", "preflight_direct_session_grant_protocol_effect", {
              sessionID: input.sessionID,
              locationID,
              challengeID: challenge.challengeID,
            }, { trustedPrincipal: trusted.principal }).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            ).pipe(Effect.map((response) => {
              const expectedDigest = directGrantChallengeSetDigest([challenge.challengeID])
              return response !== undefined &&
                Object.keys(response).toSorted().join("\0") === ["challengeID", "challengeSetDigest", "status"].join("\0") &&
                response.challengeID === challenge.challengeID &&
                response.challengeSetDigest === expectedDigest &&
                response.status === "eligible"
                ? expectedDigest
                : undefined
            }))
          : undefined
        const decision = directGrantPreflightDigest !== undefined
          ? "allow_once"
          : yield* awaitGuardApproval(challenge, trusted.principal, input.locationRef)
        if (decision !== "allow_once") return yield* Effect.fail(fail("authorization", "Guard denied the editor protocol operation"))
        if (!challenge.allowEnabled) return yield* Effect.fail(fail("authorization", "Guard allow is unavailable without assessed guarantees"))
        const resolveApproval = (grantPreflightDigest?: string) => requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: challenge.challengeID,
          decision,
          ...(grantPreflightDigest === undefined ? {} : { grantPreflightDigest }),
        }, { trustedPrincipal: trusted.principal })
        const resolved = directGrantPreflightDigest === undefined
          ? yield* resolveApproval()
          : yield* resolveApproval(directGrantPreflightDigest).pipe(Effect.catch((error) =>
              error instanceof SessionSupervisorError && error.hostCode === "effect_conflict"
                ? Effect.gen(function* () {
                    // The persisted grant changed after preflight. Restore the
                    // ordinary approval dialog; the stale candidate can never
                    // be interpreted as the user's approval.
                    const explicitDecision = yield* awaitGuardApproval(challenge, trusted.principal, input.locationRef)
                    if (explicitDecision !== "allow_once") {
                      return yield* Effect.fail(fail("authorization", "Guard denied the editor protocol operation"))
                    }
                    return yield* resolveApproval()
                  })
                : Effect.fail(error),
            ))
        if (resolved.status !== "approved" || Object.keys(resolved).toSorted().join("\0") !== ["capabilityLeaseDigest", "effectID", "status"].join("\0")) {
          return yield* Effect.fail(fail("authorization", "HostKernel rejected editor protocol approval"))
        }
        const lease = yield* Effect.try({
          try: () => parseCapabilityLease(resolved),
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel editor protocol lease is malformed"),
        })
        if (lease.effectID !== challenge.effectID) return yield* Effect.fail(fail("protocol", "editor protocol lease differs from its Guard challenge"))
        return {
          ...lease,
          // The durable lease echoes the caller's canonical decimal-string Attempt
          // scope (already shape-validated above); only the RPC body uses the
          // unsigned-integer wire projection.
          ...(input.managedAttempt !== undefined
            ? { managedAttempt: input.managedAttempt }
            : input.directAttempt !== undefined
              ? { directAttempt: input.directAttempt }
              : {}),
          locationID,
          userActionID,
          challengeID: challenge.challengeID,
          inputDigest: challenge.inputDigest,
          capabilityID: input.capabilityID,
          arguments: authorization,
        } satisfies EditorProtocolAuthorizationLeaseV1
      },
    )
    const authorizeReplOperation = Effect.fn("SessionSupervisor.authorizeReplOperation")(
      function* (input: ReplOperationAuthorizationRequestV1) {
        const trusted = yield* TrustedPrincipalContext
        if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
          return yield* Effect.fail(fail("authorization", "REPL operation authorization requires authenticated ServerAuth"))
        }
        if (!REPL_OPERATION_GUARD_RUNTIME_READY) {
          return yield* Effect.fail(fail("host-kernel-feature", "REPL per-call Guard admission is unavailable until HostKernel receipt and OS-quota acceptance passes"))
        }
        if (input.capabilityID !== "repl.execute" && input.capabilityID !== "repl.reset") {
          return yield* Effect.fail(fail("protocol", "REPL operation has an unsupported canonical capability"))
        }
        const locationID = yield* registerHostLocation(input.locationRef)
        const authorization = yield* Effect.try({
          try: () => {
            const subject = record(input.arguments)
            const required = ["hostProcessRef", "sessionID", "locationID", "workspaceRevision", "requestSequence", "operation"]
            if (Object.keys(subject).toSorted().join("\0") !== required.toSorted().join("\0")) {
              throw fail("protocol", "REPL authorization subject has unknown or missing fields")
            }
            const process = record(subject.hostProcessRef)
            const processKeys = ["executionID", "generation", "ownerEpoch", "kind", "profileID", "profileRevision", "profileDigest", "executableDigest"]
            if (Object.keys(process).toSorted().join("\0") !== processKeys.toSorted().join("\0") || process.kind !== "interpreter") {
              throw fail("protocol", "REPL HostProcessRef is malformed")
            }
            for (const key of ["executionID", "profileID"] as const) {
              if (typeof process[key] !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(process[key] as string)) {
                throw fail("protocol", `REPL HostProcessRef ${key} is invalid`)
              }
            }
            for (const key of ["generation", "ownerEpoch", "profileRevision"] as const) {
              if (typeof process[key] !== "string" || !/^[1-9][0-9]{0,19}$/.test(process[key] as string) ||
                  BigInt(process[key] as string) > 0xffff_ffff_ffff_ffffn) {
                throw fail("protocol", `REPL HostProcessRef ${key} is invalid`)
              }
            }
            for (const key of ["profileDigest", "executableDigest"] as const) {
              if (typeof process[key] !== "string" || !/^blake3:[0-9a-f]{64}$/.test(process[key] as string)) {
                throw fail("protocol", `REPL HostProcessRef ${key} is invalid`)
              }
            }
            const operation = record(subject.operation)
            const sequence = subject.requestSequence
            if (typeof sequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(sequence) || BigInt(sequence) > 0xffff_ffff_ffff_ffffn) {
              throw fail("protocol", "REPL operation sequence is invalid")
            }
            if (input.capabilityID === "repl.execute") {
              if (Object.keys(operation).toSorted().join("\0") !== ["kind", "code", "deadlineMs", "maxOutputBytes"].sort().join("\0") ||
                  operation.kind !== "execute" || typeof operation.code !== "string" || operation.code.length === 0 || operation.code.includes("\0") || Buffer.byteLength(operation.code, "utf8") > 64 * 1024 ||
                  !Number.isSafeInteger(operation.deadlineMs) || (operation.deadlineMs as number) < 1 || (operation.deadlineMs as number) > 30_000 ||
                  !Number.isSafeInteger(operation.maxOutputBytes) || (operation.maxOutputBytes as number) < 1 || (operation.maxOutputBytes as number) > 64 * 1024) {
                throw fail("protocol", "bounded repl.execute operation is invalid")
              }
            } else {
              if (Object.keys(operation).toSorted().join("\0") !== ["kind", "profileRef"].sort().join("\0") || operation.kind !== "reset") {
                throw fail("protocol", "repl.reset operation is invalid")
              }
              const profile = record(operation.profileRef)
              if (Object.keys(profile).toSorted().join("\0") !== ["profileId", "revision", "profileDigest"].sort().join("\0") ||
                  profile.profileId !== process.profileID || profile.revision !== process.profileRevision ||
                  profile.profileDigest !== process.profileDigest) {
                throw fail("protocol", "repl.reset profile differs from the retained interpreter")
              }
            }
            if (subject.sessionID !== input.sessionID || subject.locationID !== locationID ||
                typeof subject.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(subject.workspaceRevision)) {
              throw fail("protocol", "REPL operation Session, Location, or workspace revision is invalid")
            }
            return Object.freeze({ ...subject })
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "REPL operation authorization subject is invalid"),
        })
        if (!input.sessionID || !/^[A-Za-z0-9._-]{1,256}$/.test(input.sessionID) ||
            (input.managedAttempt !== undefined && input.directAttempt !== undefined)) {
          return yield* Effect.fail(fail("protocol", "REPL authorization cannot combine Attempt scopes"))
        }
        // The HostKernel MessagePack parser requires unsigned integers for the
        // direct Attempt u64 fields, so the RPC body carries the wire projection.
        const scope: { readonly managedAttempt?: ManagedAttemptScopeV1; readonly directAttempt?: DirectAttemptScopeWireV1 } = yield* Effect.try({
          try: () => input.managedAttempt !== undefined
            ? { managedAttempt: managedAttemptScopeToWire(input.managedAttempt) }
            : input.directAttempt !== undefined
              ? { directAttempt: directAttemptScopeToWire(input.directAttempt) }
              : {},
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "REPL Attempt scope is invalid"),
        })
        const attemptScope = input.managedAttempt !== undefined ? scope.managedAttempt : scope.directAttempt
        const attemptSessionID = input.managedAttempt?.sessionID ?? input.directAttempt?.childSessionID
        const attemptOwnerEpoch = input.managedAttempt?.ownerEpoch ?? input.directAttempt?.ownerEpoch
        // The authorization subject above strictly validated HostProcessRef with a
        // canonical decimal-string ownerEpoch; re-extract it fail-closed for the
        // exact epoch comparisons below.
        const authorizationOwnerEpoch = yield* Effect.try({
          try: () => {
            const processRef = record(authorization.hostProcessRef)
            const ownerEpoch = processRef.ownerEpoch
            if (typeof ownerEpoch !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(ownerEpoch) || BigInt(ownerEpoch) > 0xffff_ffff_ffff_ffffn) {
              throw fail("protocol", "REPL HostProcessRef ownerEpoch is invalid")
            }
            return ownerEpoch
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "REPL HostProcessRef is invalid"),
        })
        if (authorization.sessionID !== input.sessionID || authorization.locationID !== locationID ||
            (attemptScope !== undefined && (attemptSessionID !== input.sessionID || attemptScope.locationID !== locationID ||
              authorization.workspaceRevision !== attemptScope.workspaceRevision ||
              authorizationOwnerEpoch !== attemptOwnerEpoch))) {
          return yield* Effect.fail(fail("authorization", "REPL operation differs from its authenticated Session scope"))
        }
        if (attemptScope === undefined) {
          const currentOwnerEpoch = yield* hostOwnerEpoch()
          if (authorizationOwnerEpoch !== String(currentOwnerEpoch)) {
            return yield* Effect.fail(fail("authorization", "root Session REPL process belongs to a stale HostKernel epoch"))
          }
        }
        const userActionID = `action_${randomUUID().replaceAll("-", "")}`
        const response = yield* requestHostKernel("effects.v2", "prepare_user_effect", {
          locationID,
          userActionID,
          capabilityID: input.capabilityID,
          sessionID: input.sessionID,
          arguments: authorization,
          ...scope,
        }, { trustedPrincipal: trusted.principal })
        if (response.status === "denied") return yield* Effect.fail(fail("authorization", "Guard denied the REPL operation"))
        if (response.status !== "needs_approval") {
          return yield* Effect.fail(fail("protocol", "HostKernel returned an invalid REPL operation admission"))
        }
        const challenge = yield* Effect.try({
          try: () => {
            const challengeID = stringField(response, "challengeID")
            const effectID = stringField(response, "effectID")
            const capabilityID = stringField(response, "capabilityID")
            const responseLocationID = stringField(response, "locationID")
            const inputDigest = stringField(response, "inputDigest")
            const expiresAtUnixMs = wireUnixMs(response.expiresAtUnixMs)
            const normalizedTargets = response.normalizedTargets
            const policySummary = stringField(response, "policySummary", 1024)
            const consent = validateGuardConsentProjection(response, {
              capabilityID,
              origin: "user_action",
              source: "authenticated.user_action",
            })
            if (capabilityID !== input.capabilityID || responseLocationID !== locationID ||
                !/^blake3:[0-9a-f]{64}$/.test(inputDigest) || expiresAtUnixMs === undefined ||
                expiresAtUnixMs <= Date.now() || expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
                !Array.isArray(normalizedTargets) || normalizedTargets.length === 0 || normalizedTargets.length > 64) {
              throw fail("protocol", "HostKernel returned an invalid REPL Guard challenge")
            }
            return {
              approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
              challengeID, effectID, capabilityID, locationID, sessionID: input.sessionID,
              inputDigest, normalizedTargets, expiresAtUnixMs, policySummary, ...consent,
            } satisfies GuardApprovalRequest
          },
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel REPL challenge is malformed"),
        })
        const decision = yield* awaitGuardApproval(challenge, trusted.principal, input.locationRef)
        if (decision !== "allow_once") return yield* Effect.fail(fail("authorization", "Guard denied the REPL operation"))
        if (!challenge.allowEnabled) return yield* Effect.fail(fail("authorization", "REPL Guard allow is unavailable without assessed guarantees"))
        const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: challenge.challengeID,
          decision,
        }, { trustedPrincipal: trusted.principal })
        if (resolved.status !== "approved" || Object.keys(resolved).toSorted().join("\0") !== ["capabilityLeaseDigest", "effectID", "status"].sort().join("\0")) {
          return yield* Effect.fail(fail("authorization", "HostKernel rejected REPL operation approval"))
        }
        const lease = yield* Effect.try({
          try: () => parseCapabilityLease(resolved),
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel REPL lease is malformed"),
        })
        if (lease.effectID !== challenge.effectID) return yield* Effect.fail(fail("protocol", "REPL lease differs from its Guard challenge"))
        return {
          ...lease,
          // The durable lease echoes the caller's canonical decimal-string Attempt
          // scope (already shape-validated above); only the RPC body uses the
          // unsigned-integer wire projection.
          ...(input.managedAttempt !== undefined
            ? { managedAttempt: input.managedAttempt }
            : input.directAttempt !== undefined
              ? { directAttempt: input.directAttempt }
              : {}),
          locationID,
          userActionID,
          challengeID: challenge.challengeID,
          inputDigest: challenge.inputDigest,
          capabilityID: input.capabilityID,
          arguments: authorization,
        } satisfies ReplOperationAuthorizationLeaseV1
      },
    )
    const awaitManagedVerifierApprovals = Effect.fn("SessionSupervisor.awaitManagedVerifierApprovals")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly sessionID?: string
      readonly challenges: ReadonlyArray<ManagedVerifierGuardChallengeV1>
    }) {
      const trusted = yield* TrustedPrincipalContext
      const locationID = yield* registerHostLocation(input.locationRef)
      const challenges = yield* Effect.try({
        try: () => validateManagedVerifierChallenges(locationID, input.challenges),
        catch: (error) =>
          error instanceof SessionSupervisorError
            ? error
            : fail("protocol", "managed verifier challenge set is invalid"),
      })
      if (input.sessionID !== undefined && !/^[A-Za-z0-9._-]{1,256}$/.test(input.sessionID)) {
        return yield* Effect.fail(fail("protocol", "managed verifier Session ID is invalid"))
      }
      const requests = challenges.map((challenge): GuardApprovalRequest => ({
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        capabilityID: challenge.capabilityID,
        locationID,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        inputDigest: challenge.inputDigest,
        normalizedTargets: challenge.normalizedTargets,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        policySummary: challenge.policySummary,
        origin: challenge.origin,
        source: challenge.source,
        policyID: challenge.policyID,
        policyDigest: challenge.policyDigest,
        normalizedAction: challenge.normalizedAction,
        argumentSummary: challenge.argumentSummary,
        requestedGuarantees: challenge.requestedGuarantees,
        guaranteeAssessment: challenge.guaranteeAssessment,
        runID: challenge.runID,
        noResponse: challenge.noResponse,
        allowEnabled: challenge.allowEnabled,
      }))
      const retirePending = Effect.forEach(
        requests,
        (request) =>
          Effect.gen(function* () {
            const pending = pendingApprovals.get(request.approvalID)
            if (!pending) return
            pendingApprovals.delete(request.approvalID)
            closedApprovals.set(request.approvalID, Date.now())
            yield* Deferred.fail(pending.decision, fail("approval-conflict", "verifier challenge set was interrupted"))
            yield* events.publish(
              GuardApprovalResolved,
              { approvalID: request.approvalID, decision: "expired" },
              { location: input.locationRef },
            ).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid)
      const collectDecisions = collectManagedVerifierApprovalDecisions(challenges, (challenge) => {
        const request = requests.find((candidate) => candidate.challengeID === challenge.challengeID)!
        return awaitGuardApproval(request, trusted.principal, input.locationRef).pipe(
          Effect.filterOrFail(
            (decision) => decision !== "allow_once" || request.allowEnabled,
            () => fail("authorization", "Guard allow is unavailable without assessed guarantees"),
          ),
        )
      })
      return yield* Effect.ensuring(collectDecisions, retirePending)
    })
    const awaitManagedProviderApproval = Effect.fn("SessionSupervisor.awaitManagedProviderApproval")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly scope: ManagedAttemptScopeV1
      readonly routeProjection: {
        readonly providerID: string
        readonly modelID: string
        readonly harnessID: string
        readonly routeID: string
        readonly endpointRevision: string
        readonly credentialLeaseRef: string | null
      }
      readonly requestPins: {
        readonly requestID: string
        readonly requestSequence: string
        readonly contextSelectionDigest: string
        readonly requestDigest: string
        readonly transportRequestDigest: string
        readonly operationDigest: string
      }
      readonly challenge: ManagedProviderGuardChallengeV1
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "provider inference approval requires authenticated ServerAuth context"))
      }
      const scope = yield* Effect.try({
        try: () => managedAttemptScopeToWire(input.scope),
        catch: () => fail("protocol", "provider approval Attempt scope is invalid"),
      })
      const locationID = yield* registerHostLocation(input.locationRef)
      if (scope.locationID !== locationID || scope.sessionID.length === 0 ||
        scope.requestID !== input.requestPins.requestID || scope.requestSequence !== input.requestPins.requestSequence) {
        return yield* Effect.fail(fail("authorization", "provider approval pins do not match the current managed Attempt"))
      }
      const challenge = yield* Effect.try({
        try: () => {
          const value = record(input.challenge)
          const exact = [
            "allowEnabled", "argumentSummary", "capabilityID", "challengeID", "effectID", "expiresAtUnixMs",
            "guaranteeAssessment", "inputDigest", "locationID", "normalizedAction", "normalizedTargets", "noResponse", "origin",
            "policyDigest", "policyID", "policySummary", "requestedGuarantees", "runID", "sessionID", "source",
          ].toSorted()
          if (Object.keys(value).toSorted().join("\0") !== exact.join("\0") ||
            value.capabilityID !== "providers.infer" || value.origin !== "managed_run" ||
            value.source !== "host.managed_provider" || value.policyID !== "provider-inference.managed.v1" ||
            value.normalizedAction !== "providers.infer" || value.runID !== scope.runID ||
            value.sessionID !== scope.sessionID || value.locationID !== locationID || value.noResponse !== "deny_and_expire" || value.allowEnabled !== true) {
            throw fail("protocol", "provider Guard challenge has an invalid source, scope, or approval policy")
          }
          const guarantees = value.requestedGuarantees
          const expectedGuarantees = ["live_managed_attempt", "selected_route_revision", "normalized_request_digest", "transport_request_digest", "secret_operation_digest", "explicit_route_consent", "budget_bound", "one_use", "no_fallback"]
          if (!Array.isArray(guarantees) || guarantees.join("\0") !== expectedGuarantees.join("\0")) {
            throw fail("protocol", "provider Guard challenge guarantee set is invalid")
          }
          const targets = value.normalizedTargets
          if (!Array.isArray(targets) || targets.length !== 1) throw fail("protocol", "provider Guard challenge targets are invalid")
          const target = record(targets[0])
          const targetKeys = ["endpointRevision", "harnessID", "maxCostMicros", "maxTokens", "modelID", "providerID", "routeID"].toSorted()
          if (Object.keys(target).toSorted().join("\0") !== targetKeys.join("\0") ||
            target.providerID !== input.routeProjection.providerID || target.modelID !== input.routeProjection.modelID ||
            target.harnessID !== input.routeProjection.harnessID || target.routeID !== input.routeProjection.routeID ||
            target.endpointRevision !== input.routeProjection.endpointRevision || target.maxTokens !== scope.remainingTokens ||
            typeof target.maxCostMicros !== "string" || !/^(0|[1-9][0-9]*)$/.test(target.maxCostMicros)) {
            throw fail("protocol", "provider Guard challenge target differs from the selected route or budget")
          }
          const projection = validateGuardConsentProjection(value, {
            capabilityID: "providers.infer", origin: "managed_run", source: "host.managed_provider", runID: scope.runID,
          })
          if (projection.guaranteeAssessment.status !== "assessed" || projection.guaranteeAssessment.residual.length !== 0) {
            throw fail("authorization", "provider Guard allow is unavailable without complete assessed guarantees")
          }
          const expiresAtUnixMs = value.expiresAtUnixMs
          if (typeof expiresAtUnixMs !== "number" || !Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= Date.now() || expiresAtUnixMs - Date.now() > 5 * 60 * 1000) {
            throw fail("protocol", "provider Guard challenge expiry is invalid")
          }
          return {
            challengeID: stringField(value, "challengeID", 256),
            effectID: stringField(value, "effectID", 256),
            capabilityID: "providers.infer" as const,
            locationID,
            inputDigest: stringField(value, "inputDigest"),
            normalizedTargets: targets,
            expiresAtUnixMs,
            policySummary: stringField(value, "policySummary", MAX_GUARD_SUMMARY_BYTES),
            origin: "managed_run" as const,
            source: "host.managed_provider" as const,
            policyID: "provider-inference.managed.v1" as const,
            policyDigest: stringField(value, "policyDigest"),
            normalizedAction: "providers.infer" as const,
            argumentSummary: projection.argumentSummary,
            requestedGuarantees: expectedGuarantees,
            guaranteeAssessment: projection.guaranteeAssessment,
            runID: scope.runID,
            sessionID: scope.sessionID,
            noResponse: "deny_and_expire" as const,
            allowEnabled: true,
          } satisfies ManagedProviderGuardChallengeV1
        },
        catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "provider Guard challenge is invalid"),
      })
      const request: GuardApprovalRequest = {
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        capabilityID: challenge.capabilityID,
        locationID,
        sessionID: challenge.sessionID,
        inputDigest: challenge.inputDigest,
        normalizedTargets: challenge.normalizedTargets,
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        policySummary: challenge.policySummary,
        origin: challenge.origin,
        source: challenge.source,
        policyID: challenge.policyID,
        policyDigest: challenge.policyDigest,
        normalizedAction: challenge.normalizedAction,
        argumentSummary: challenge.argumentSummary,
        requestedGuarantees: challenge.requestedGuarantees,
        guaranteeAssessment: challenge.guaranteeAssessment,
        runID: challenge.runID,
        noResponse: challenge.noResponse,
        allowEnabled: challenge.allowEnabled,
      }
      const decision = yield* awaitGuardApproval(request, trusted.principal, input.locationRef)
      const resolved = yield* requestHostKernel("managed.v1", "managed_provider.resolve_approval", {
        managedAttempt: scope,
        routeProjection: input.routeProjection,
        requestPins: input.requestPins,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        allow: decision === "allow_once",
      }, { trustedPrincipal: trusted.principal })
      const expectedKeys = ["status", "challengeID", "effectID", "providerRequestID", "prepareDigest", "revision", "managedAttempt"].toSorted()
      if (Object.keys(resolved).toSorted().join("\0") !== expectedKeys.join("\0") ||
        resolved.status !== (decision === "allow_once" ? "APPROVED" : "DENIED") ||
        resolved.challengeID !== challenge.challengeID || resolved.effectID !== challenge.effectID ||
        resolved.providerRequestID !== `mpr_${scope.attemptID}_${scope.requestSequence}` ||
        resolved.prepareDigest === undefined || typeof resolved.prepareDigest !== "string" ||
        !/^blake3:[0-9a-f]{64}$/.test(resolved.prepareDigest) || resolved.revision !== scope.expectedManagedRevision ||
        !sameManagedAttemptScopeCore(scope, managedAttemptScopeFromWire(resolved.managedAttempt))) {
        return yield* Effect.fail(fail("authorization", "HostKernel did not durably resolve the exact provider Guard decision"))
      }
      return {
        decision,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        providerRequestID: resolved.providerRequestID as string,
        prepareDigest: resolved.prepareDigest,
      } satisfies ManagedProviderApprovalResultV1
    })
    const awaitManagedRootApproval = Effect.fn("SessionSupervisor.awaitManagedRootApproval")(function* (input: {
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly runID: string
      readonly challenge: ManagedRootGuardChallengeV1
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject) {
        return yield* Effect.fail(fail("authorization", "managed-root approval requires authenticated ServerAuth context"))
      }
      if (!/^[A-Za-z0-9._-]{1,256}$/.test(input.runID)) {
        return yield* Effect.fail(fail("protocol", "managed-root Run ID is invalid"))
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      const challenge = yield* Effect.try({
        try: () => validateManagedRootGuardChallenge(locationID, {
          ...record(input.challenge),
          status: "needs_approval",
          targets: input.challenge.normalizedTargets,
        }),
        catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "managed-root Guard challenge is invalid"),
      })
      const request: GuardApprovalRequest = {
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
        challengeID: challenge.challengeID,
        effectID: challenge.effectID,
        capabilityID: challenge.capabilityID,
        locationID,
        inputDigest: challenge.inputDigest,
        normalizedTargets: [...challenge.normalizedTargets],
        expiresAtUnixMs: challenge.expiresAtUnixMs,
        policySummary: challenge.policySummary,
        origin: challenge.origin,
        source: challenge.source,
        policyID: challenge.policyID,
        policyDigest: challenge.policyDigest,
        normalizedAction: challenge.normalizedAction,
        argumentSummary: challenge.argumentSummary,
        requestedGuarantees: [...challenge.requestedGuarantees],
        guaranteeAssessment: challenge.guaranteeAssessment,
        runID: input.runID,
        noResponse: "deny_and_expire",
        allowEnabled: challenge.allowEnabled,
      }
      const decision = yield* awaitGuardApproval(request, trusted.principal, input.locationRef)
      const resolved = yield* requestHostKernel("effects.v2", "resolve_approval", {
        challengeID: challenge.challengeID,
        decision,
      }, { trustedPrincipal: trusted.principal })
      if (decision !== "allow_once") {
        if (resolved.status !== "denied" || Object.keys(resolved).toSorted().join("\0") !== "status") {
          return yield* Effect.fail(fail("protocol", "HostKernel did not durably record managed-root denial"))
        }
        return yield* Effect.fail(fail("authorization", "final Inspect approval was denied"))
      }
      if (resolved.status !== "approved" || Object.keys(resolved).toSorted().join("\0") !== ["capabilityLeaseDigest", "effectID", "status"].sort().join("\0")) {
        return yield* Effect.fail(fail("authorization", "HostKernel rejected managed-root approval"))
      }
      const lease = yield* Effect.try({
        try: () => parseCapabilityLease(resolved),
        catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid managed-root lease"),
      })
      if (lease.effectID !== challenge.effectID) return yield* Effect.fail(fail("protocol", "managed-root lease does not match its challenge"))
      return { ...lease, locationID }
    })
    const prepareToolBatch = Effect.fn("SessionSupervisor.prepareToolBatch")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly batchID: string
      readonly turnContextDigest: string
      readonly calls: ReadonlyArray<GuardedToolCall>
      /** Authenticated Core Config projection for `terminal.run` workspace profiles.
       * This is private RPC metadata and is never part of model tool arguments. */
      readonly workspaceCommandProfiles?: ReadonlyArray<{
        readonly callID: string
        readonly reference: { readonly profileId: string; readonly revision: string; readonly profileDigest: string; readonly action: "build" | "test" }
        readonly definition: unknown
        readonly resolvedEnvironment: Readonly<Record<string, string>>
      }>
      readonly directTurnScope?: DirectTurnScopeV1
      readonly managedAttempt?: ManagedAttemptScopeV1
    }) {
      const trusted = yield* TrustedPrincipalContext
      if (input.directTurnScope && input.managedAttempt) {
        return yield* Effect.fail(fail("protocol", "ToolBatch cannot carry both Attempt lanes"))
      }
      if (input.managedAttempt) {
        const managedAttempt = yield* Effect.try({
          try: () => managedAttemptScopeToWire(input.managedAttempt!),
          catch: () => fail("protocol", "managed Attempt scope is invalid"),
        })
        if (managedAttempt.remainingTokens === "0") {
          return { status: "denied" as const, reason: "managed Attempt token budget is exhausted" }
        }
      }
      yield* Effect.try({ try: () => validateToolBatchCalls(input.calls), catch: (error) =>
        error instanceof SessionSupervisorError ? error : fail("protocol", "ToolBatch is invalid") })
      yield* Effect.try({ try: () => validateWorkspaceCommandProjections(input.calls, input.workspaceCommandProfiles), catch: (error) =>
        error instanceof SessionSupervisorError ? error : fail("protocol", "workspace command profile projection is invalid") })
      for (const call of input.calls) {
        if (call.capabilityID !== "files.patch") continue
        yield* Effect.try({
          try: () => {
            const args = record(call.arguments)
            if (!("operations" in args) || Object.keys(args).some((key) => !["operations", "repoIntelFence"].includes(key))) {
              throw fail("effect", "files.patch arguments are invalid")
            }
            validatePatchOperations(args.operations)
            if (args.repoIntelFence !== undefined) {
              Schema.decodeUnknownSync(RepoIntelPatchFenceV1, { onExcessProperty: "error" })(args.repoIntelFence)
            }
          },
          catch: (error) =>
            error instanceof SessionSupervisorError ? error : fail("effect", "files.patch arguments are invalid"),
        })
      }
      const locationID = yield* registerHostLocation(input.locationRef)
      locationBySession.set(input.sessionID, locationID)
      // Preserve request ordering against cancel_batch. If the prompt is interrupted while
      // this RPC is in flight, wait for its durable PREPARE result before the caller sends
      // cancellation; the following approval wait remains interruptible.
      const response = yield* Effect.uninterruptible(
        requestHostKernel("effects.v2", "prepare_tool_batch", {
          sessionID: input.sessionID,
          locationID,
          batchID: input.batchID,
          turnContextDigest: input.turnContextDigest,
          ...(input.directTurnScope ? { directTurnScope: directTurnScopeToWire(input.directTurnScope) } : {}),
          ...(input.managedAttempt ? { managedAttempt: managedAttemptScopeToWire(input.managedAttempt) } : {}),
          calls: input.calls.map((call) => ({
            callID: call.callID,
            capabilityID: call.capabilityID,
            arguments: call.arguments,
          })),
          ...(input.workspaceCommandProfiles?.length ? { workspaceCommandProfiles: input.workspaceCommandProfiles } : {}),
        }),
      )
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
      if (response.status === "admitted_batch") {
        const responseKeys = Object.keys(response).sort().join("\0")
        if (input.calls.length < 2 || input.calls.length > MAX_TOOL_BATCH_CALLS ||
          input.directTurnScope || input.managedAttempt ||
          !(hostKernelClient?.enabledFeatures ?? []).includes(MULTI_CALL_BATCH_FEATURE) ||
          responseKeys !== ["batchID", "calls", "status"].sort().join("\0") ||
          response.batchID !== input.batchID) {
          return yield* Effect.fail(fail("protocol", "HostKernel returned an out-of-scope admitted ToolBatch"))
        }
        const members = yield* Effect.try({
          try: () => parseMultiCallChallenges({
            sessionID: input.sessionID,
            batchID: input.batchID,
            locationID,
            calls: input.calls,
            response,
          }),
          catch: (error) => error instanceof SessionSupervisorError
            ? error : fail("protocol", "HostKernel returned invalid mode-approved challenges"),
        })
        const rawCalls = response.calls as ReadonlyArray<unknown>
        const byCall = new Map(rawCalls.map((value) => {
          const item = record(value)
          return [batchField(item, "callId", "callID", MAX_IDENTIFIER_BYTES), item] as const
        }))
        const calls = yield* Effect.try({
          try: () => members.map((member) => {
            const item = byCall.get(member.callID)
            if (!item) throw fail("protocol", "HostKernel omitted a mode-approved call")
            const lease = parseCapabilityLease(record(item.lease))
            if (lease.effectID !== member.effectID) throw fail("protocol", "HostKernel returned a mode lease for another effect")
            return {
              callID: member.callID,
              capabilityID: member.capabilityID,
              challenge: member.challenge,
              lease,
            }
          }),
          catch: (error) => error instanceof SessionSupervisorError
            ? error : fail("protocol", "HostKernel returned an invalid mode-approved lease set"),
        })
        return { status: "admitted_batch" as const, calls }
      }
      const refreshedDirectTurn = response.status === "prepared" && input.directTurnScope
        ? yield* Effect.try({
            try: () => {
              const refreshed = directTurnScopeFromWire(response.directTurnScope)
              if (response.attemptScopeTransition !== "batch_bind" || !isNextDirectTurnScopeCore(input.directTurnScope!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale DirectTurnScope batch bind")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid DirectTurnScope batch bind"),
          })
        : undefined
      const refreshedManagedAttempt = response.status === "prepared" && input.managedAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = managedAttemptScopeFromWire(response.managedAttempt)
              if (response.attemptScopeTransition !== "batch_bind" ||
                !isNextManagedAttemptScopeCore(input.managedAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale managed Attempt batch scope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid managed Attempt scope"),
          })
        : undefined
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
        return {
          status: "prepared" as const,
          lease,
          ...(refreshedDirectTurn ? { directTurnScope: refreshedDirectTurn } : {}),
          ...(refreshedManagedAttempt ? { managedAttempt: refreshedManagedAttempt } : {}),
        }
      }
      if (response.status !== "needs_approval") {
        return yield* Effect.fail(fail("protocol", "Rust returned an invalid effect challenge"))
      }
      if (Array.isArray(response.calls)) {
        // Complete multi-call admission. It is only reachable once the host negotiates
        // `effects.v2.multi-call`: the Rust HostKernel/EffectHost multi-call contract,
        // cancellation routing and receipt reconciliation must be accepted first.
        if (input.calls.length < 2) {
          return yield* Effect.fail(fail("protocol", "host returned a multi-call challenge for a single call"))
        }
        if (!(hostKernelClient?.enabledFeatures ?? []).includes(MULTI_CALL_BATCH_FEATURE)) {
          return yield* Effect.fail(fail("capability", "host did not negotiate multi-call tool batches"))
        }
        const currentAttempt: {
          direct?: DirectAttemptScopeV1
          managed?: ManagedAttemptScopeV1
          directTurn?: DirectTurnScopeV1
        } = {
          ...(input.directTurnScope ? { direct: input.directTurnScope.directAttempt, directTurn: input.directTurnScope } : {}),
          ...(input.managedAttempt ? { managed: input.managedAttempt } : {}),
        }
        const resolveApprovedSet = (request: {
          readonly sessionID: string
          readonly locationID: string
          readonly batchID: string
          readonly challengeIDs: ReadonlyArray<string>
        }) =>
          Effect.gen(function* () {
            const resolved = yield* requestHostKernel("effects.v2", "resolve_approval_set", {
              sessionID: request.sessionID,
              locationID: request.locationID,
              batchID: request.batchID,
              challengeIDs: request.challengeIDs,
            })
            const serialAttempt = resolved.nextLeaseRequired === true
            const approvedLeases: ReadonlyArray<unknown> | undefined = Array.isArray(resolved.leases) ? resolved.leases : undefined
            if (resolved.status !== "approved_set" || resolved.batchID !== request.batchID ||
              approvedLeases === undefined ||
              approvedLeases.length !== (serialAttempt ? 1 : request.challengeIDs.length)) {
              return yield* Effect.fail(fail("authorization", "HostKernel rejected the complete Guard approval set"))
            }
            const leases = yield* Effect.try({
              try: () => approvedLeases.map((raw) => {
                const item = record(raw)
                const challengeID = stringField(item, "challengeID")
                if (!request.challengeIDs.includes(challengeID)) throw fail("protocol", "HostKernel returned an unknown challenge")
                return { challengeID, lease: parseCapabilityLease(item) }
              }),
              catch: (error) => error instanceof SessionSupervisorError
                ? error : fail("protocol", "HostKernel returned an invalid approval lease set"),
            })
            const byChallenge = new Map(leases.map((item) => [item.challengeID, item.lease]))
            if (byChallenge.size !== (serialAttempt ? 1 : request.challengeIDs.length) ||
              [...byChallenge.keys()].some((id) => !request.challengeIDs.includes(id)) ||
              (!serialAttempt && request.challengeIDs.some((id) => !byChallenge.has(id)))) {
              return yield* Effect.fail(fail("protocol", "HostKernel returned a mismatched approval lease set"))
            }
            const refreshedDirectTurn = input.directTurnScope
              ? yield* Effect.try({
                  try: () => {
                    const refreshed = directTurnScopeFromWire(resolved.directTurnScope)
                    if (resolved.attemptScopeTransition !== "batch_bind" ||
                      !isNextDirectTurnScopeCore(input.directTurnScope!, refreshed)) {
                      throw fail("protocol", "HostKernel returned a stale DirectTurnScope batch bind")
                    }
                    return refreshed
                  },
                  catch: (error) => error instanceof SessionSupervisorError
                    ? error : fail("protocol", "HostKernel returned an invalid DirectTurnScope"),
                })
              : undefined
            const refreshedDirectAttempt = refreshedDirectTurn?.directAttempt
            const refreshedManagedAttempt = input.managedAttempt
              ? yield* Effect.try({
                  try: () => {
                    const refreshed = managedAttemptScopeFromWire(resolved.managedAttempt)
                    if (resolved.attemptScopeTransition !== "batch_bind" ||
                      !isNextManagedAttemptScopeCore(input.managedAttempt!, refreshed)) {
                      throw fail("protocol", "HostKernel returned a stale managed Attempt batch scope")
                    }
                    return refreshed
                  },
                  catch: (error) => error instanceof SessionSupervisorError
                    ? error : fail("protocol", "HostKernel returned an invalid managed Attempt scope"),
                })
              : undefined
            if (serialAttempt && !refreshedDirectTurn && !refreshedManagedAttempt) {
              return yield* Effect.fail(fail("protocol", "HostKernel requested serial Attempt leases without a refreshed scope"))
            }
            if (refreshedDirectAttempt) currentAttempt.direct = refreshedDirectAttempt
            if (refreshedDirectTurn) currentAttempt.directTurn = refreshedDirectTurn
            if (refreshedManagedAttempt) currentAttempt.managed = refreshedManagedAttempt
            const scopedLeases = leases.map((item) => ({
              ...item,
              lease: {
                ...item.lease,
                ...(refreshedDirectAttempt ? { directAttempt: refreshedDirectAttempt } : {}),
                ...(refreshedManagedAttempt ? { managedAttempt: refreshedManagedAttempt } : {}),
              },
            }))
            return {
              leases: scopedLeases,
              ...(refreshedDirectAttempt ? { directAttempt: refreshedDirectAttempt } : {}),
              ...(refreshedDirectTurn ? { directTurnScope: refreshedDirectTurn } : {}),
              ...(refreshedManagedAttempt ? { managedAttempt: refreshedManagedAttempt } : {}),
              ...(serialAttempt ? { nextLeaseRequired: true } : {}),
            }
          })
        const preflightDirectGrant = (request: {
          readonly sessionID: string
          readonly locationID: string
          readonly batchID: string
          readonly challengeIDs: ReadonlyArray<string>
        }) => Effect.gen(function* () {
          // Direct-session grants never authorize a managed Task/Attempt. Keep
          // managed approval on its authenticated Attempt path even when a user
          // also has a matching direct workspace grant. A root Session has no
          // DirectTurnScope by design; HostKernel derives that lane from the
          // authenticated Session/Location and must still get the read-only
          // grant hint so the user is not prompted on every pre-authorized edit.
          if (input.managedAttempt ||
            trusted.principal.kind !== "server_auth" || !trusted.principal.subject) return false
          const response = yield* requestHostKernel("effects.v1", "preflight_direct_session_grant_batch", {
            sessionID: request.sessionID,
            locationID: request.locationID,
            batchID: request.batchID,
            challengeIDs: request.challengeIDs,
          }, { trustedPrincipal: trusted.principal })
          const responseKeys = Object.keys(response).sort().join("\0")
          if (responseKeys !== ["batchID", "challengeSetDigest", "status"].sort().join("\0") ||
            response.batchID !== request.batchID || !["eligible", "prompt_required"].includes(String(response.status)) ||
            typeof response.challengeSetDigest !== "string" ||
            response.challengeSetDigest !== directGrantChallengeSetDigest(request.challengeIDs)) return false
          return response.status === "eligible"
        })
        const leaseNextEffect = (request: {
          readonly sessionID: string
          readonly locationID: string
          readonly batchID: string
          readonly previousEffectID: string
        }) => Effect.gen(function* () {
          const response = yield* requestHostKernel("effects.v2", "lease_next_batch_effect", {
            sessionID: request.sessionID,
            locationID: request.locationID,
            batchID: request.batchID,
            previousEffectID: request.previousEffectID,
          })
          if (response.status !== "approved_next" || response.batchID !== request.batchID) {
            return yield* Effect.fail(fail("authorization", "HostKernel rejected the next serialized Attempt lease"))
          }
          const lease = yield* Effect.try({
            try: () => parseCapabilityLease(record(response)),
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid next Attempt lease"),
          })
          const directAttempt = currentAttempt.direct
            ? yield* Effect.try({
                try: () => {
                  const next = directAttemptScopeFromWire(response.directAttempt)
                  if (response.attemptScopeTransition !== "effect_receipt" ||
                    !isReceiptAdvancedDirectAttemptScopeCore(currentAttempt.direct!, next)) {
                    throw fail("protocol", "HostKernel returned a stale direct Attempt receipt scope")
                  }
                  return next
                },
                catch: (error) => error instanceof SessionSupervisorError
                  ? error : fail("protocol", "HostKernel returned an invalid direct Attempt receipt scope"),
              })
            : undefined
          const managedAttempt = currentAttempt.managed
            ? yield* Effect.try({
                try: () => {
                  const next = managedAttemptScopeFromWire(response.managedAttempt)
                  if (response.attemptScopeTransition !== "effect_receipt" ||
                    !isReceiptAdvancedManagedAttemptScopeCore(currentAttempt.managed!, next)) {
                    throw fail("protocol", "HostKernel returned a stale managed Attempt receipt scope")
                  }
                  return next
                },
                catch: (error) => error instanceof SessionSupervisorError
                  ? error : fail("protocol", "HostKernel returned an invalid managed Attempt receipt scope"),
              })
            : undefined
          if ((!directAttempt && !managedAttempt) || lease.effectID !== response.effectID) {
            return yield* Effect.fail(fail("protocol", "HostKernel omitted the refreshed scope for a serialized lease"))
          }
          if (directAttempt) currentAttempt.direct = directAttempt
          if (managedAttempt) currentAttempt.managed = managedAttempt
          return {
            challengeID: stringField(response, "challengeID"),
            lease: {
              ...lease,
              ...(directAttempt ? { directAttempt } : {}),
              ...(managedAttempt ? { managedAttempt } : {}),
            },
            ...(directAttempt ? { directAttempt } : {}),
            ...(managedAttempt ? { managedAttempt } : {}),
          }
        })
        const relayed = yield* relayMultiCallToolBatch(
          {
            sessionID: input.sessionID,
            batchID: input.batchID,
            locationID,
            calls: input.calls,
            response,
          },
          {
            requestApproval: (request) => awaitGuardApproval(request, undefined, input.locationRef),
            preflightDirectGrant,
            resolveApprovalSet: resolveApprovedSet,
            leaseNextEffect,
            cancelBatch: (value) =>
              requestHostKernel("effects.v2", "cancel_batch", {
                locationID,
                sessionID: value.sessionID,
                batchID: value.batchID,
              }).pipe(Effect.asVoid),
          },
        )
        if (relayed.status !== "prepared_batch") return relayed
        return {
          ...relayed,
          ...(relayed.directAttempt ? { directAttempt: relayed.directAttempt } : {}),
          ...(relayed.directTurnScope ? { directTurnScope: relayed.directTurnScope } : {}),
          ...(relayed.managedAttempt ? { managedAttempt: relayed.managedAttempt } : {}),
          ...(relayed.directTurnScope || relayed.managedAttempt ? { attemptScopeTransition: "batch_bind" as const } : {}),
        }
      }
      if (input.calls.length !== 1) {
        return yield* Effect.fail(fail("protocol", "host returned a single-call challenge for a multi-call batch"))
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
          const expiresAtUnixMs = wireUnixMs(response.expiresAtUnixMs)
          const normalizedTargets = response.normalizedTargets
          const policySummary = stringField(response, "policySummary", 1024)
          const consent = validateGuardConsentProjection(response, {
            capabilityID,
            origin: "session_batch",
            source: "core.tool_batch",
          })
          if (
            targets.length === 0 ||
            challengeLocationID !== locationID ||
            !input.calls.some((call) => call.capabilityID === capabilityID) ||
            !/^blake3:[0-9a-f]{64}$/.test(inputDigest) ||
            expiresAtUnixMs === undefined ||
            expiresAtUnixMs <= Date.now() ||
            expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
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
              expiresAtUnixMs,
              policySummary,
              consent,
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
        ...details.consent,
      }
      const decision = yield* awaitGuardApproval(request, undefined, input.locationRef)
      if (decision === "allow_once" && !request.allowEnabled) {
        return yield* Effect.fail(fail("authorization", "Guard allow is unavailable without assessed guarantees"))
      }
      const resolved = decision === "allow_once" && input.managedAttempt
        ? yield* requestHostKernel("effects.v2", "resolve_approval_set", {
            sessionID: input.sessionID,
            locationID,
            batchID: input.batchID,
            challengeIDs: [challenge.challengeID],
          })
        : yield* requestHostKernel("effects.v2", "resolve_approval", {
            challengeID: challenge.challengeID,
            decision,
          })
      if (decision !== "allow_once") {
        return { status: "denied" as const, reason: "Guard approval was denied" }
      }
      const approvedLeases: ReadonlyArray<unknown> | undefined = Array.isArray(resolved.leases) ? resolved.leases : undefined
      if (input.managedAttempt && (resolved.status !== "approved_set" || approvedLeases === undefined || approvedLeases.length !== 1) ||
        !input.managedAttempt && resolved.status !== "approved") {
        return yield* Effect.fail(fail("authorization", "host rejected Guard approval"))
      }
      const leaseResponse = input.managedAttempt ? record(approvedLeases![0]) : resolved
      if (input.managedAttempt && stringField(leaseResponse, "challengeID") !== challenge.challengeID) {
        return yield* Effect.fail(fail("protocol", "managed wave lease does not match its approved challenge"))
      }
      const lease = yield* Effect.try({
        try: () => parseCapabilityLease(leaseResponse),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("protocol", "host returned an invalid capability lease"),
      })
      if (lease.effectID !== challenge.effectID) {
        return yield* Effect.fail(fail("protocol", "approval lease does not match its challenge"))
      }
      const approvedDirectTurn = input.directTurnScope
        ? yield* Effect.try({
            try: () => {
              const refreshed = directTurnScopeFromWire(resolved.directTurnScope)
              if (resolved.attemptScopeTransition !== "batch_bind" ||
                !isNextDirectTurnScopeCore(input.directTurnScope!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale DirectTurnScope after approval")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid DirectTurnScope after approval"),
          })
        : undefined
      const approvedManagedAttempt = input.managedAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = managedAttemptScopeFromWire(resolved.managedAttempt)
              if (resolved.attemptScopeTransition !== "batch_bind" ||
                !isNextManagedAttemptScopeCore(input.managedAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale managed Attempt scope after approval")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid managed Attempt scope"),
          })
        : undefined
      return {
        status: "prepared" as const,
        lease,
        ...(approvedDirectTurn ? { directTurnScope: approvedDirectTurn } : {}),
        ...(approvedManagedAttempt ? { managedAttempt: approvedManagedAttempt } : {}),
        ...(approvedDirectTurn || approvedManagedAttempt ? { attemptScopeTransition: "batch_bind" as const } : {}),
      }
    })
    const executeWrite = Effect.fn("SessionSupervisor.executeWrite")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly lease: EffectLease
      readonly content: string
      readonly directAttempt?: DirectAttemptScopeV1
      readonly directTurnScope?: DirectTurnScopeV1
      readonly managedAttempt?: ManagedAttemptScopeV1
      readonly trustedPrincipal: TrustedPrincipal
    }) {
      const locationID = yield* registerHostLocationFor(input.locationRef, input.trustedPrincipal)
      if (input.directAttempt && (!input.directTurnScope ||
        !sameDirectTurnScopeCore(input.directTurnScope, { ...input.directTurnScope, directAttempt: input.directAttempt }))) {
        return yield* Effect.fail(fail("authorization", "direct effect Attempt does not match its DirectTurnScope"))
      }
      if (!/^blake3:[0-9a-f]{64}$/.test(input.lease.capabilityLeaseDigest)) {
        return yield* Effect.fail(fail("authorization", "capability lease is invalid"))
      }
      const response = yield* requestHostKernel("effects.v2", "execute_write", {
        sessionID: input.sessionID,
        locationID,
        effectID: input.lease.effectID,
        capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
        ...(input.directTurnScope ? { directTurnScope: directTurnScopeToWire(input.directTurnScope) } : {}),
        ...(input.managedAttempt ? { managedAttempt: managedAttemptScopeToWire(input.managedAttempt) } : {}),
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
      const refreshedManagedAttempt = input.managedAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = managedAttemptScopeFromWire(response.managedAttempt)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isReceiptAdvancedManagedAttemptScopeCore(input.managedAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale managed Attempt receipt scope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid managed Attempt receipt scope"),
          })
        : undefined
      const refreshedDirectAttempt = input.directAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = directAttemptScopeFromWire(response.directAttempt)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isReceiptAdvancedDirectAttemptScopeCore(input.directAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale direct Attempt receipt scope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid direct Attempt receipt scope"),
          })
        : undefined
      const refreshedDirectTurn = input.directTurnScope && response.directTurnScope !== undefined
        ? yield* Effect.try({
            try: () => {
              const refreshed = directTurnScopeFromWire(response.directTurnScope)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isCompletedDirectTurnBatchScopeCore(input.directTurnScope!, refreshed) ||
                (refreshedDirectAttempt && JSON.stringify(refreshed.directAttempt) !== JSON.stringify(refreshedDirectAttempt))) {
                throw fail("protocol", "HostKernel returned a stale or mismatched completed DirectTurnScope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid completed DirectTurnScope"),
          })
        : undefined
      return {
        ...receipt,
        ...(refreshedDirectAttempt ? { directAttempt: refreshedDirectAttempt } : {}),
        ...(refreshedDirectTurn ? { directTurnScope: refreshedDirectTurn } : {}),
        ...(refreshedManagedAttempt ? { managedAttempt: refreshedManagedAttempt } : {}),
        ...(refreshedDirectAttempt || refreshedManagedAttempt ? { attemptScopeTransition: "effect_receipt" as const } : {}),
      }
    })
    const executePatch = Effect.fn("SessionSupervisor.executePatch")(function* (input: {
      readonly sessionID: string
      readonly locationRef: typeof LocationSchema.Ref.Type
      readonly lease: EffectLease
      readonly operations: ReadonlyArray<PatchOperation>
      readonly directAttempt?: DirectAttemptScopeV1
      readonly directTurnScope?: DirectTurnScopeV1
      readonly managedAttempt?: ManagedAttemptScopeV1
      readonly trustedPrincipal: TrustedPrincipal
    }) {
      yield* Effect.try({
        try: () => validatePatchOperations(input.operations),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("effect", "files.patch operations are invalid"),
      })
      const locationID = yield* registerHostLocationFor(input.locationRef, input.trustedPrincipal)
      if (input.directAttempt && (!input.directTurnScope ||
        !sameDirectTurnScopeCore(input.directTurnScope, { ...input.directTurnScope, directAttempt: input.directAttempt }))) {
        return yield* Effect.fail(fail("authorization", "direct effect Attempt does not match its DirectTurnScope"))
      }
      if (!/^blake3:[0-9a-f]{64}$/.test(input.lease.capabilityLeaseDigest)) {
        return yield* Effect.fail(fail("authorization", "capability lease is invalid"))
      }
      const response = yield* requestHostKernel("effects.v2", "execute_patch", {
        sessionID: input.sessionID,
        locationID,
        effectID: input.lease.effectID,
        capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
        ...(input.directTurnScope ? { directTurnScope: directTurnScopeToWire(input.directTurnScope) } : {}),
        ...(input.managedAttempt ? { managedAttempt: managedAttemptScopeToWire(input.managedAttempt) } : {}),
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
      const refreshedManagedAttempt = input.managedAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = managedAttemptScopeFromWire(response.managedAttempt)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isReceiptAdvancedManagedAttemptScopeCore(input.managedAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale managed Attempt receipt scope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid managed Attempt receipt scope"),
          })
        : undefined
      const refreshedDirectAttempt = input.directAttempt
        ? yield* Effect.try({
            try: () => {
              const refreshed = directAttemptScopeFromWire(response.directAttempt)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isReceiptAdvancedDirectAttemptScopeCore(input.directAttempt!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale direct Attempt receipt scope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError
              ? error : fail("protocol", "HostKernel returned an invalid direct Attempt receipt scope"),
          })
        : undefined
      const refreshedDirectTurn = input.directTurnScope && response.directTurnScope !== undefined
        ? yield* Effect.try({
            try: () => {
              const refreshed = directTurnScopeFromWire(response.directTurnScope)
              if (response.attemptScopeTransition !== "effect_receipt" ||
                !isCompletedDirectTurnBatchScopeCore(input.directTurnScope!, refreshed)) {
                throw fail("protocol", "HostKernel returned a stale completed DirectTurnScope")
              }
              return refreshed
            },
            catch: (error) => error instanceof SessionSupervisorError ? error : fail("protocol", "HostKernel returned an invalid completed DirectTurnScope"),
          })
        : undefined
      return {
        ...receipt,
        ...(refreshedDirectAttempt ? { directAttempt: refreshedDirectAttempt } : {}),
        ...(refreshedDirectTurn ? { directTurnScope: refreshedDirectTurn } : {}),
        ...(refreshedManagedAttempt ? { managedAttempt: refreshedManagedAttempt } : {}),
        ...(refreshedDirectAttempt || refreshedManagedAttempt
          ? { attemptScopeTransition: "effect_receipt" as const }
          : {}),
      }
    })
    const runPatch = Effect.fn("SessionSupervisor.runPatch")(function* (input: {
      readonly sessionID: string
      readonly workspaceRoot: string
      readonly turnContextDigest: string
      readonly operations: ReadonlyArray<PatchOperation>
    }) {
      const trusted = yield* TrustedPrincipalContext
      yield* Effect.try({
        try: () => validatePatchOperations(input.operations),
        catch: (error) =>
          error instanceof SessionSupervisorError ? error : fail("effect", "files.patch operations are invalid"),
      })
      if (!input.workspaceRoot || !input.turnContextDigest) {
        return yield* Effect.fail(fail("configuration", "files.patch requires trusted Location and turn context"))
      }
      const locationRef = { directory: AbsolutePath.make(input.workspaceRoot) }
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
        trustedPrincipal: trusted.principal,
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
      directSessionPermissionModeSnapshot,
      directProviderPermissionScope,
      setDirectSessionPermissionMode,
      issueDirectSessionGrant,
      revokeDirectSessionGrant,
      prepareUserEffect,
      resolveEditorProcessApproval,
      authorizeEditorProtocolOperation,
      authorizeReplOperation,
      replyGuardApproval,
      awaitManagedVerifierApprovals,
      awaitManagedProviderApproval,
      awaitManagedRootApproval,
      prepareToolBatch,
      executeWrite,
      executePatch,
      runPatch,
      requestHostKernel,
      hostFeatureEnabled,
      directSessionWorkspaceSnapshot,
      managedEffectWaveReceipts,
      managedCurrentEpochRecoveryQuiescence,
      directCodeModeWaveReceipts,
      codeModeHostRequest,
      prepareCodeModeToolBatch,
      settleCodeModeToolResults,
      codeModeWaveReceipts,
      cancelCodeModeWave,
      listDirectAttemptArtifacts,
      listDirectSessionArtifacts,
      inspectDirectSessionArtifact,
      readDirectSessionArtifactRange,
      queryRepoStructure,
      discoverRepo,
      readRepoDocument,
      resolveVerifiedManagedArtifactScope,
      inspectManagedArtifact,
      inspectDirectAttemptArtifact,
      readManagedArtifactRange,
      readDirectAttemptArtifactRange,
      hostOwnerEpoch,
      sessionProjectionCursor: Effect.fn("SessionSupervisor.sessionProjectionCursor")(function* (sessionID: string) {
        if (typeof sessionID !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(sessionID)) {
          return yield* fail("checkpoint", "Session ID is invalid")
        }
        const path = yield* Effect.try({
          try: () => join(sessionStateDirectory(runtime.stateRoot, sessionID), `session-${sessionID}.cursor`),
          catch: () => fail("checkpoint", "Session projection state is unavailable"),
        })
        const value = yield* Effect.try({
          try: () => readCheckpoint(path, sessionID),
          catch: (error) => error instanceof SessionSupervisorError ? error : fail("checkpoint", "Session projection cursor is unavailable"),
        })
        if (value.seq === "0") return yield* fail("checkpoint", "Session has no acknowledged durable projection cursor")
        return value
      }),
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
    codeModeHelperAssetPath: typeof OPENCODE_CODE_MODE_HELPER_ASSET === "undefined" ? undefined : OPENCODE_CODE_MODE_HELPER_ASSET,
    codeModeHelperManifestJSON:
      typeof OPENCODE_CODE_MODE_HELPER_MANIFEST === "undefined" ? undefined : OPENCODE_CODE_MODE_HELPER_MANIFEST,
    codeModeHelperInstallRoot: join(Global.Path.bin, "codemode-helper"),
  }),
)

export const runtimeConfigNode = LayerNode.make({
  service: RuntimeConfig,
  layer: runtimeConfigLayer,
  deps: [],
})

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AppProcess.node, runtimeConfigNode, EventV2.node, Database.node],
})

export const SessionSupervisor = { Service, RuntimeConfig, runtimeConfigNode, node, acquireExecutionOwner }
