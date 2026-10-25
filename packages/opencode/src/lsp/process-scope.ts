import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import { Schema } from "effect"

/**
 * Scope attached to every P4 process request. The caller's FrameFence owns
 * session/location/epoch; HostKernel reauthenticates them and recomputes the
 * workspace revision before dispatch. Managed work carries the exact parsed
 * Attempt scope from the canonical managed-control contract.
 */
export type HostProcessScopeV1 = {
  readonly sessionID: string
  readonly locationID: string
  readonly ownerEpoch: string
  readonly workspaceRevision: string
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
  /** Required when a DirectAttempt scope is present; binds its workspace ID. */
  readonly workspaceID?: string
}

/** Caller-visible selector for a HostKernel-projected immutable launch profile. */
export type ExecutionLaunchProfileRefV1 = {
  readonly profileId: string
  readonly revision: string
  readonly profileDigest: string
}

export const HostProcessRefV1 = Schema.Struct({
  executionID: Schema.String,
  generation: Schema.String,
  ownerEpoch: Schema.String,
  kind: Schema.Literals(["terminal_run", "language_server", "debug_adapter", "interpreter", "managed_verifier"]),
  profileID: Schema.String,
  profileRevision: Schema.String,
  profileDigest: Schema.String,
  executableDigest: Schema.String,
}).annotate({ identifier: "HostProcessRefV1" })
export type HostProcessRefV1 = typeof HostProcessRefV1.Type

/** Exact current `ManagedAttemptScopeV1` key set (see
 * `@/session/managed-control` and kernel `ManagedAttemptScopeV1::from_value`).
 * HostKernel projections always carry the provider-request pin trio and the
 * leased worktree target; a shorter scope is rejected fail-closed. */
const MANAGED_SCOPE_KEYS = [
  "goalID",
  "runID",
  "taskID",
  "attemptID",
  "ownerEpoch",
  "expectedManagedRevision",
  "requestSequence",
  "requestID",
  "contextSelectionDigest",
  "locationID",
  "sessionID",
  "workspaceRevision",
  "effectiveMaxTokens",
  "remainingTokens",
  "delegationBindingDigest",
  "permissionScopeDigest",
  "worktreeTarget",
] as const

/** Exact `ManagedWorktreeTargetV1` keys; the Rust decoder rejects any other set. */
const WORKTREE_TARGET_KEYS = [
  "worktreeID",
  "worktreeBaseRevision",
  "worktreePoolRevision",
  "locationID",
  "workspaceID",
  "workspaceRef",
  "canonicalRoot",
  "workspaceRevision",
] as const

const DIRECT_SCOPE_KEYS = [
  "attemptID",
  "parentSessionID",
  "childSessionID",
  "ownerEpoch",
  "expectedRevision",
  "locationID",
  "workspaceID",
  "workspaceRevision",
  "profileID",
  "profileRevision",
  "profileDigest",
  "capabilityDigest",
  "permissionsDigest",
  "budgetDigest",
  "scopeDigest",
] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function nonEmptyID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0\s]/.test(value)
}

function u64(value: unknown, name: string, allowZero: boolean): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > 18_446_744_073_709_551_615n
  ) {
    throw new TypeError(`${name} must be a canonical u64 decimal string`)
  }
}

function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a BLAKE3 digest`)
  }
}

/** Exact HostKernel `ManagedWorktreeTargetV1` wire shape; the Rust decoder
 * rejects any other key set, so Core must too. Text fields follow the Rust
 * `text()` rule (non-empty, no NUL) rather than the tighter ID rule. */
function validateManagedWorktreeTarget(input: unknown): void {
  if (!record(input) || !exactKeys(input, WORKTREE_TARGET_KEYS)) {
    throw new TypeError("managed process scope worktreeTarget must use the exact ManagedWorktreeTargetV1 fields")
  }
  for (const field of ["worktreeID", "locationID", "workspaceID", "workspaceRef", "canonicalRoot"] as const) {
    const value = input[field]
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new TypeError(`managed process scope worktreeTarget ${field} is required`)
    }
  }
  if (typeof input.worktreeBaseRevision !== "string" || input.worktreeBaseRevision.length === 0 ||
      input.worktreeBaseRevision.includes("\0")) {
    throw new TypeError("managed process scope worktreeTarget worktreeBaseRevision is required")
  }
  u64(input.worktreePoolRevision, "managed process scope worktreeTarget worktreePoolRevision", true)
  if (typeof input.workspaceRevision !== "string" || input.workspaceRevision.length === 0 ||
      input.workspaceRevision.includes("\0")) {
    throw new TypeError("managed process scope worktreeTarget workspaceRevision is required")
  }
}

/** Exact `ManagedAttemptScopeV1` field contract, independent of the process
 * scope it is attached to. Shared by HostKernel process-scope admission and
 * trusted launch-profile resolution so the two boundaries can never drift into
 * different key sets; a shorter or malformed scope is rejected fail-closed. */
export function validateManagedAttemptScopeFieldsV1(attempt: ManagedAttemptScopeV1): void {
  if (!record(attempt) || !exactKeys(attempt, MANAGED_SCOPE_KEYS)) {
    throw new TypeError("managed process scope must use the exact ManagedAttemptScopeV1 fields")
  }
  for (const field of ["goalID", "runID", "taskID", "attemptID", "locationID", "sessionID"] as const) {
    if (!nonEmptyID(attempt[field])) throw new TypeError(`managed process scope ${field} is required`)
  }
  u64(attempt.ownerEpoch, "managed process scope ownerEpoch", false)
  u64(attempt.expectedManagedRevision, "managed process scope expectedManagedRevision", true)
  u64(attempt.effectiveMaxTokens, "managed process scope effectiveMaxTokens", false)
  u64(attempt.remainingTokens, "managed process scope remainingTokens", false)
  if (BigInt(attempt.remainingTokens) > BigInt(attempt.effectiveMaxTokens)) {
    throw new TypeError("managed process scope token remainder exceeds its effective budget")
  }
  digest(attempt.workspaceRevision, "managed process scope workspaceRevision")
  digest(attempt.delegationBindingDigest, "managed process scope delegationBindingDigest")
  digest(attempt.permissionScopeDigest, "managed process scope permissionScopeDigest")
  digest(attempt.contextSelectionDigest, "managed process scope contextSelectionDigest")
  if (!nonEmptyID(attempt.requestID)) throw new TypeError("managed process scope requestID is required")
  u64(attempt.requestSequence, "managed process scope requestSequence", false)
  if (BigInt(attempt.requestSequence) > 1024n) {
    throw new TypeError("managed process scope requestSequence must be within the HostKernel window")
  }
  validateManagedWorktreeTarget(attempt.worktreeTarget)
}

export function validateHostProcessScope(input: HostProcessScopeV1): HostProcessScopeV1 {
  if (!nonEmptyID(input.sessionID)) throw new TypeError("process scope sessionID is required")
  if (!nonEmptyID(input.locationID)) throw new TypeError("process scope locationID is required")
  u64(input.ownerEpoch, "process scope ownerEpoch", false)
  digest(input.workspaceRevision, "process scope workspaceRevision")

  const attempt = input.managedAttemptScope
  const direct = input.directAttemptScope
  if (attempt !== undefined && direct !== undefined) {
    throw new TypeError("a process request cannot claim both managed and direct Attempt authority")
  }
  if (attempt !== undefined) {
    validateManagedAttemptScopeFieldsV1(attempt)
    if (
      attempt.sessionID !== input.sessionID ||
      attempt.locationID !== input.locationID ||
      attempt.ownerEpoch !== input.ownerEpoch ||
      attempt.workspaceRevision !== input.workspaceRevision
    ) {
      throw new TypeError("managed process scope does not match the authenticated session, location, epoch, and revision")
    }
    return input
  }
  if (direct === undefined) return input
  if (!record(direct) || !exactKeys(direct, DIRECT_SCOPE_KEYS)) {
    throw new TypeError("direct process scope must use the exact DirectAttemptScopeV1 fields")
  }
  for (const field of ["attemptID", "parentSessionID", "childSessionID", "locationID", "workspaceID"] as const) {
    if (!nonEmptyID(direct[field])) throw new TypeError(`direct process scope ${field} is required`)
  }
  u64(direct.ownerEpoch, "direct process scope ownerEpoch", false)
  u64(direct.expectedRevision, "direct process scope expectedRevision", true)
  for (const field of [
    "workspaceRevision",
    "profileDigest",
    "capabilityDigest",
    "permissionsDigest",
    "budgetDigest",
    "scopeDigest",
  ] as const) {
    digest(direct[field], `direct process scope ${field}`)
  }
  if (!nonEmptyID(direct.profileID)) throw new TypeError("direct process scope profileID is required")
  u64(direct.profileRevision, "direct process scope profileRevision", false)
  if (
    direct.childSessionID !== input.sessionID ||
    direct.locationID !== input.locationID ||
    direct.ownerEpoch !== input.ownerEpoch ||
    direct.workspaceRevision !== input.workspaceRevision ||
    input.workspaceID !== direct.workspaceID
  ) {
    throw new TypeError("direct process scope does not match the authenticated child session, location, epoch, workspace, and revision")
  }
  return input
}

export function validateHostProcessRef(input: unknown): HostProcessRefV1 {
  if (
    !record(input) ||
    !exactKeys(input, [
      "executionID",
      "generation",
      "ownerEpoch",
      "kind",
      "profileID",
      "profileRevision",
      "profileDigest",
      "executableDigest",
    ])
  ) {
    throw new TypeError("process reference must use the exact HostKernel identity fields")
  }
  const ref = Schema.decodeUnknownSync(HostProcessRefV1)(input)
  if (!nonEmptyID(ref.executionID)) throw new TypeError("process reference executionID is invalid")
  u64(ref.generation, "process reference generation", false)
  u64(ref.ownerEpoch, "process reference ownerEpoch", false)
  if (typeof ref.profileID !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(ref.profileID)) {
    throw new TypeError("process reference profileID is invalid")
  }
  u64(ref.profileRevision, "process reference profileRevision", false)
  digest(ref.profileDigest, "process reference profileDigest")
  digest(ref.executableDigest, "process reference executableDigest")
  return ref
}

export function validateExecutionLaunchProfileRef(input: unknown): ExecutionLaunchProfileRefV1 {
  if (!record(input) || !exactKeys(input, ["profileId", "revision", "profileDigest"])) {
    throw new TypeError("launch profile reference must use the exact HostKernel profile selector fields")
  }
  if (typeof input.profileId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.profileId)) {
    throw new TypeError("launch profile reference profileId is invalid")
  }
  u64(input.revision, "launch profile revision", false)
  digest(input.profileDigest, "launch profile digest")
  return Object.freeze({
    profileId: input.profileId,
    revision: input.revision,
    profileDigest: input.profileDigest,
  })
}

export function sameManagedAttemptScope(
  left: ManagedAttemptScopeV1 | undefined,
  right: ManagedAttemptScopeV1 | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return MANAGED_SCOPE_KEYS.every((key) => left[key] === right[key])
}

export function sameDirectAttemptScope(
  left: DirectAttemptScopeV1 | undefined,
  right: DirectAttemptScopeV1 | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return DIRECT_SCOPE_KEYS.every((key) => left[key] === right[key])
}

/** Freeze a validated scope before retaining or forwarding it across an async boundary. */
export function freezeManagedAttemptScope(
  scope: ManagedAttemptScopeV1 | undefined,
): ManagedAttemptScopeV1 | undefined {
  return scope === undefined ? undefined : Object.freeze({ ...scope })
}

/** Freeze an exact direct Attempt scope before retaining it across async work. */
export function freezeDirectAttemptScope(
  scope: DirectAttemptScopeV1 | undefined,
): DirectAttemptScopeV1 | undefined {
  return scope === undefined ? undefined : Object.freeze({ ...scope })
}
