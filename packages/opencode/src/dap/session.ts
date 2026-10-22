import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  type ExecutionLaunchProfileRefV1,
  HostProcessRefV1,
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  validateExecutionLaunchProfileRef,
  validateHostProcessRef,
  validateHostProcessScope,
} from "@/lsp/process-scope"

/**
 * DebugAdapterBrokerV1 session bookkeeping and generation-scoped references
 * (§37.7, §32.28).
 *
 * Scope of this module: lifecycle state, generation-scoped refs and the
 * fail-closed effect boundary. It must never spawn or attach a debug adapter,
 * download/install one, execute `runInTerminal`, set/remove breakpoints,
 * control execution or evaluate an expression. Those are effects and stay
 * UNAVAILABLE until the Rust Guard/ExecutionHost mediation for this origin is
 * implemented and verified.
 *
 * The lifecycle registry below is driven explicitly (activation, crash,
 * expiry, reset). It is the reusable half that a future Guard-mediated
 * adapter session will feed; until then nothing in production calls it and
 * every effectful operation throws `UnavailableError`.
 *
 * Session-loss rule (§37.7): a crashed, expired, replaced or terminated
 * generation can never be reused — refs to it fail with `StaleRefError`.
 */

export const SessionState = Schema.Literals(["created", "active", "crashed", "expired", "unknown", "terminated"])
export type SessionState = typeof SessionState.Type

export const Ref = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
}).annotate({ identifier: "DAPSessionRefV1" })
export type Ref = typeof Ref.Type

export const ObjectKind = Schema.Literals(["thread", "frame", "variables"])
export type ObjectKind = typeof ObjectKind.Type

/**
 * An adapter object ID is meaningful only inside the active session
 * generation that returned it. Zero is not a usable DAP reference (for
 * example, variablesReference 0 means there are no child variables).
 */
export const ObjectRef = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
  kind: ObjectKind,
  id: PositiveInt,
}).annotate({ identifier: "DAPObjectRefV1" })
export type ObjectRef = typeof ObjectRef.Type

const decodeObjectRef = Schema.decodeUnknownSync(ObjectRef)

export interface Session {
  readonly sessionID: string
  readonly generation: number
  readonly adapterID: string
  /** Authenticated host bindings; never accept these from DAP `arguments`. */
  readonly principalId: string
  readonly locationID: string
  readonly workspaceId: string
  readonly workspaceRevision: string
  readonly ownerEpoch: string
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
  readonly policyGeneration: string
  readonly sandboxGeneration: number
  readonly capabilityCeilingDigest: string
  readonly launchConfigDigest: string
  readonly launchProfileRef: ExecutionLaunchProfileRefV1
  /** HostKernel-issued adapter process identity; resolved again before each IO. */
  readonly processRef: ProcessTargetRef
  readonly state: SessionState
}

/** Authenticated caller scope required to inspect a DAP session or its refs. */
export type AuthorityBinding = Pick<
  Session,
  | "principalId"
  | "locationID"
  | "workspaceId"
  | "workspaceRevision"
  | "ownerEpoch"
  | "managedAttemptScope"
  | "directAttemptScope"
  | "policyGeneration"
  | "sandboxGeneration"
  | "capabilityCeilingDigest"
>

/** HostKernel-minted process identity. It carries retained owner epoch and
 * generation data; a PID is never an attach target because it can be forged
 * or recycled. The resolver must still check this ref against authenticated
 * principal/session/location/Attempt scope and current process status. */
export const ProcessTargetRef = HostProcessRefV1
export type ProcessTargetRef = typeof ProcessTargetRef.Type

function decodeProcessTargetRef(input: unknown): ProcessTargetRef {
  return validateHostProcessRef(input)
}

export class TransitionError extends Schema.TaggedErrorClass<TransitionError>()("DAPSessionTransitionError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  state: SessionState,
  action: Schema.String,
}) {}

export const StaleReason = Schema.Literals([
  "generation_replaced",
  "not_active",
  "session_lost",
  "session_expired",
  "outcome_unknown",
  "session_terminated",
])
export type StaleReason = typeof StaleReason.Type

/**
 * A frame/variable/thread reference no longer names a live adapter session.
 * Session loss invalidates every generation-scoped reference with it.
 */
export class StaleRefError extends Schema.TaggedErrorClass<StaleRefError>()("DAPStaleRefError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  reason: StaleReason,
  current: Schema.optional(PositiveInt),
}) {}

export const Operation = Schema.Literals([
  "adapter.install",
  "session.start",
  "session.attach",
  "session.stop",
  "session.evaluate",
  "session.control",
  "breakpoint.set",
  "breakpoint.remove",
  "debug.breakpoints",
  "debug.continue",
  "debug.pause",
  "debug.step.over",
  "debug.step.into",
  "debug.step.out",
  "debug.stack",
  "debug.scopes",
  "run_in_terminal",
])
export type Operation = typeof Operation.Type

/**
 * Canonical Guard action IDs (the `debug.*` family owned by `kernel/src/guard.rs`). An
 * operation without an entry has no canonical Guard action yet, so no route may execute
 * it: absence here is a fail-closed fact, not an oversight to work around.
 */
export const GuardAction = {
  "session.start": "debug.start",
  "session.attach": "debug.attach",
  "session.stop": "debug.stop",
  "session.evaluate": "debug.evaluate",
  "breakpoint.set": "debug.breakpoint.set",
  "breakpoint.remove": "debug.breakpoint.remove",
  "debug.breakpoints": "debug.breakpoints",
  "debug.continue": "debug.continue",
  "debug.pause": "debug.pause",
  "debug.step.over": "debug.step.over",
  "debug.step.into": "debug.step.into",
  "debug.step.out": "debug.step.out",
  "debug.stack": "debug.stack",
  "debug.scopes": "debug.scopes",
} as const

export function guardActionID(operation: Operation): string | undefined {
  return (GuardAction as Partial<Record<Operation, string>>)[operation]
}

/**
 * Map a DAP command to one canonical capability family member before any
 * adapter dispatch. Unknown extensions and commands that have no catalogued
 * action (including `runInTerminal`) stay unavailable. This is policy
 * classification only; the returned operation still needs authenticated
 * session scope, a live Guard lease, and the supervised adapter transport.
 */
export function operationForCommand(command: string): Operation | undefined {
  switch (command) {
    case "initialize":
    case "configurationDone":
      return "session.start"
    case "attach":
      return "session.attach"
    case "disconnect":
    case "terminate":
      return "session.stop"
    case "evaluate":
      return "session.evaluate"
    case "setBreakpoints":
    case "setFunctionBreakpoints":
    case "setExceptionBreakpoints":
      return "breakpoint.set"
    case "continue":
      return "debug.continue"
    case "pause":
      return "debug.pause"
    case "next":
      return "debug.step.over"
    case "stepIn":
      return "debug.step.into"
    case "stepOut":
      return "debug.step.out"
    case "threads":
    case "stackTrace":
      return "debug.stack"
    case "scopes":
      return "debug.scopes"
    // DAP variables can cause adapters to execute property getters, lazy
    // formatters, or target code. No adapter-specific passive-inspection
    // guarantee is registered yet, so the request cannot use the generic
    // read-only route. A future trusted adapter may expose this capability
    // only after proving that it does not evaluate target code.
    case "variables":
      return undefined
    case "launch":
    case "runInTerminal":
    case "startDebugging":
    default:
      return undefined
  }
}

/** Fail-closed DAP policy gate. The actual command payload must be passed to
 * the same Guard intent by the host adapter; this helper never dispatches it. */
export async function authorizeCommand(
  command: string,
  request: Omit<DebugEffectRequest, "operation">,
): Promise<DebugEffectAuthorization> {
  const operation = operationForCommand(command)
  if (!operation) {
    throw new UnavailableError({
      operation: "run_in_terminal",
      reason: "guard_not_verified",
      detail: "DAP command has no V1 canonical capability and is unavailable",
    })
  }
  return authorizeEffect({ ...request, operation })
}

export const UnavailableReason = Schema.Literals(["guard_not_verified"])
export type UnavailableReason = typeof UnavailableReason.Type

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("DAPUnavailableError", {
  operation: Operation,
  reason: UnavailableReason,
  detail: Schema.optional(Schema.String),
}) {}

/**
 * One authorized debug effect. The token is issued by the canonical Guard/ExecutionHost
 * boundary; this module never manufactures one and never executes an effect without it.
 */
export type DebugEffectAuthorization = {
  readonly capabilityID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityLeaseDigest: string
}

/** A request to the canonical boundary. Launch authority is a pinned logical profile ref. */
export type DebugEffectRequest = {
  readonly operation: Operation
  readonly sessionID: string
  readonly generation: number
  /** HostKernel-projected adapter profile only; this grants no debuggee authority. */
  readonly launchProfileRef?: ExecutionLaunchProfileRefV1
  /** HostKernel-issued adapter process identity for commands after launch/attach. */
  readonly adapterProcessRef?: ProcessTargetRef
  /** HostKernel-issued debuggee identity, only for attach. */
  readonly targetProcessRef?: ProcessTargetRef
  readonly launchConfigDigest?: string
  /** Authenticated host context; never copied from a DAP request envelope. */
  readonly principalId: string
  readonly locationID: string
  readonly workspaceId: string
  readonly workspaceRevision: string
  readonly ownerEpoch: string
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
  readonly policyGeneration: string
  readonly sandboxGeneration: number
  readonly capabilityCeilingDigest: string
}

export interface DebugEffectRoute {
  /** The canonical Guard/ExecutionHost boundary for debug-adapter effects. */
  readonly authorize: (request: DebugEffectRequest) => Promise<DebugEffectAuthorization>
}

let route: DebugEffectRoute | undefined

/**
 * DAP launch/attach and protocol effects stay unavailable until P1 Guard,
 * process confinement, durable receipt recovery, and the P4 integration
 * journey are accepted together. Registering an adapter callback is not
 * evidence for those prerequisites and must never unlock this boundary.
 */
const GUARDED_DEBUG_RUNTIME_READY = false

/**
 * Register the canonical Guard route for debug effects. Only the host integration that
 * owns an admitted `debug.*` action may call this; the default (no route) keeps every
 * debug effect typed-unavailable.
 */
export function setDebugEffectRoute(next: DebugEffectRoute | undefined): void {
  route = next
}

export function debugEffectRouteAvailable(): boolean {
  return GUARDED_DEBUG_RUNTIME_READY && route !== undefined
}

function validAuthorization(value: unknown): value is DebugEffectAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 4 &&
    ["capabilityID", "challengeID", "effectID", "capabilityLeaseDigest"].every((key) => key in record) &&
    validTokenID(record.capabilityID) &&
    validTokenID(record.challengeID) &&
    validTokenID(record.effectID) &&
    typeof record.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(record.capabilityLeaseDigest)
  )
}

function validTokenID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0\s]/.test(value)
}

/**
 * Ask the canonical boundary to authorize one debug effect. Without a registered route
 * (the current build) this fails closed with `UnavailableError`; with a route, the
 * boundary alone decides and a malformed answer is refused rather than trusted.
 */
export async function authorizeEffect(request: DebugEffectRequest): Promise<DebugEffectAuthorization> {
  if (!GUARDED_DEBUG_RUNTIME_READY) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: "DAP effects remain unavailable until integrated HostKernel Guard, process confinement, and receipt-recovery acceptance passes",
    })
  }
  const action = guardActionID(request.operation)
  if (!action) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: `debug-adapter operation ${request.operation} has no canonical Guard action and cannot be authorized`,
    })
  }

  try {
    validateEffectRequest(request)
  } catch (error) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: error instanceof Error ? error.message : "debug effect request has invalid host bindings",
    })
  }

  const current = route
  if (!current) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: "debug-adapter effects need the Rust Guard/ExecutionHost route, which is not registered for this origin",
    })
  }
  const scopedRequest = Object.freeze({
    ...request,
    managedAttemptScope: freezeManagedAttemptScope(request.managedAttemptScope),
    directAttemptScope: freezeDirectAttemptScope(request.directAttemptScope),
    launchProfileRef: request.launchProfileRef
      ? validateExecutionLaunchProfileRef(request.launchProfileRef)
      : undefined,
    adapterProcessRef: request.adapterProcessRef ? Object.freeze({ ...request.adapterProcessRef }) : undefined,
    targetProcessRef: request.targetProcessRef ? Object.freeze({ ...request.targetProcessRef }) : undefined,
  })
  const authorization = await current.authorize(scopedRequest)
  if (!validAuthorization(authorization) || authorization.capabilityID !== action) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: `the debug-adapter effect route did not authorize canonical action ${action}`,
    })
  }
  return Object.freeze({ ...authorization })
}

function validateEffectRequest(request: DebugEffectRequest): void {
  if (request.operation === "session.evaluate") {
    throw new TypeError("debug evaluation remains unavailable until a trusted adapter profile grants it")
  }
  for (const [field, value] of Object.entries({
    sessionID: request.sessionID,
    principalId: request.principalId,
    locationID: request.locationID,
    workspaceId: request.workspaceId,
    workspaceRevision: request.workspaceRevision,
    ownerEpoch: request.ownerEpoch,
    policyGeneration: request.policyGeneration,
    capabilityCeilingDigest: request.capabilityCeilingDigest,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`debug effect ${field} is required`)
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    throw new TypeError("debug effect generation must be a positive safe integer")
  }
  if (!Number.isSafeInteger(request.sandboxGeneration) || request.sandboxGeneration < 1) {
    throw new TypeError("debug effect sandboxGeneration must be a positive safe integer")
  }
  if (!/^blake3:[0-9a-f]{64}$/.test(request.capabilityCeilingDigest)) {
    throw new TypeError("debug effect capabilityCeilingDigest must be a blake3 digest")
  }
  try {
    validateHostProcessScope({
      sessionID: request.sessionID,
      locationID: request.locationID,
      ownerEpoch: request.ownerEpoch,
      workspaceRevision: request.workspaceRevision,
      managedAttemptScope: request.managedAttemptScope,
      directAttemptScope: request.directAttemptScope,
      workspaceID: request.workspaceId,
    })
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "debug effect process scope is invalid")
  }
  const createsAdapter = request.operation === "session.start" || request.operation === "session.attach"
  if (createsAdapter) {
    try {
      validateExecutionLaunchProfileRef(request.launchProfileRef)
    } catch {
      throw new TypeError("debug adapter launch requires a HostKernel launch profile reference")
    }
    if (!request.launchConfigDigest || !/^blake3:[0-9a-f]{64}$/.test(request.launchConfigDigest)) {
      throw new TypeError("debug adapter launchConfigDigest must be a canonical host-computed digest")
    }
    if (request.operation === "session.attach") {
      try {
        const target = decodeProcessTargetRef(request.targetProcessRef)
        if (target.ownerEpoch !== request.ownerEpoch || target.kind !== "terminal_run") {
          throw new TypeError("attach target must be a HostKernel terminal_run reference in this owner epoch")
        }
      } catch {
        throw new TypeError("debug adapter attach requires a host-issued process reference; raw PIDs are forbidden")
      }
    } else if (request.targetProcessRef !== undefined) {
      throw new TypeError("debug adapter launch cannot include an attach process reference")
    }
    if (request.adapterProcessRef !== undefined) {
      throw new TypeError("adapter creation cannot include a pre-existing adapter process reference")
    }
  } else {
    if (request.launchProfileRef !== undefined) {
      throw new TypeError("debug command cannot replace the active adapter launch profile")
    }
    if (request.targetProcessRef !== undefined) {
      throw new TypeError("debug command cannot replace its adapter process with a caller-supplied target")
    }
    try {
      const adapter = decodeProcessTargetRef(request.adapterProcessRef)
      if (adapter.kind !== "debug_adapter" || adapter.ownerEpoch !== request.ownerEpoch) {
        throw new TypeError("adapter process reference does not match the active HostKernel owner")
      }
    } catch {
      throw new TypeError("debug command requires the active HostKernel adapter process reference")
    }
  }
}

export interface Availability {
  readonly operation: Operation
  readonly available: false
  readonly reason: UnavailableReason
  readonly detail: string
}

/**
 * Non-throwing availability report. No debug-adapter effect is available yet:
 * adapter installation, start/attach, runInTerminal, breakpoint mutation,
 * execution control and evaluate all require the canonical Guard/
 * ExecutionHost route, which is not registered for this origin. The report names the
 * canonical Guard action when one exists, so a status surface states the exact missing
 * owner instead of a generic refusal.
 */
export function availability(operation: Operation): Availability {
  const action = guardActionID(operation)
  return {
    operation,
    available: false,
    reason: "guard_not_verified",
    detail: action
      ? `debug-adapter effect ${operation} needs the Rust Guard/ExecutionHost route for canonical action ${action}, which is not registered for this origin`
      : `debug-adapter effect ${operation} has no canonical Guard action yet and is unavailable`,
  }
}

/** Fail-closed enforcement; always throws `UnavailableError` today. */
export function requireEffectAllowed(operation: Operation): never {
  const report = availability(operation)
  throw new UnavailableError({ operation, reason: report.reason, detail: report.detail })
}

export interface Sessions {
  /**
   * Bookkeeping only: registers a session generation. Calling this does not
   * launch anything; a future Guard-mediated launcher registers the session
   * after its process effect is admitted and receipted.
   * Registering an existing sessionID replaces the generation.
   */
  readonly create: (input: {
    sessionID: string
    adapterID: string
    principalId: string
    locationID: string
    workspaceId: string
    workspaceRevision: string
    ownerEpoch: string
    managedAttemptScope?: ManagedAttemptScopeV1
    directAttemptScope?: DirectAttemptScopeV1
    policyGeneration: string
    sandboxGeneration: number
    capabilityCeilingDigest: string
    launchConfigDigest: string
    launchProfileRef: ExecutionLaunchProfileRefV1
    processRef: ProcessTargetRef
  }) => Session
  readonly activate: (ref: Ref) => Session
  readonly activateOwned: (ref: Ref, authority: AuthorityBinding) => Session
  readonly crash: (ref: Ref) => Session
  readonly crashOwned: (ref: Ref, authority: AuthorityBinding) => Session
  /** Quarantine a generation when the adapter command outcome is uncertain. */
  readonly markUnknown: (ref: Ref) => Session
  readonly markUnknownOwned: (ref: Ref, authority: AuthorityBinding) => Session
  readonly expire: (ref: Ref) => Session
  readonly terminate: (ref: Ref) => Session
  readonly terminateOwned: (ref: Ref, authority: AuthorityBinding) => Session
  /** Throws `StaleRefError` unless the authenticated caller owns the active generation. */
  readonly requireOwned: (ref: Ref, authority: AuthorityBinding) => Session
  /** Bind a DAP object ID to the active generation that produced it. */
  readonly bindObjectRefOwned: (ref: Ref, kind: ObjectKind, id: number, authority: AuthorityBinding) => ObjectRef
  /** Resolve a generation-bound DAP object ID for the authenticated owner; this is not effect authorization. */
  readonly resolveObjectRefOwned: (
    ref: ObjectRef,
    authority: AuthorityBinding,
  ) => {
    readonly session: Session
    readonly kind: ObjectKind
    readonly id: number
  }
  /** Return only sessions matching the full authenticated scope. */
  readonly listOwned: (authority: AuthorityBinding) => readonly Session[]
}

function freezeSession(session: Session): Session {
  return Object.freeze({
    ...session,
    managedAttemptScope: freezeManagedAttemptScope(session.managedAttemptScope),
    directAttemptScope: freezeDirectAttemptScope(session.directAttemptScope),
    launchProfileRef: validateExecutionLaunchProfileRef(session.launchProfileRef),
    processRef: Object.freeze({ ...session.processRef }),
  })
}

export function makeSessions(): Sessions {
  const generations = new Map<string, number>()
  const sessions = new Map<string, Session>()

  const update = (ref: Ref, action: string, next: (session: Session) => Session | undefined): Session => {
    const session = sessions.get(ref.sessionID)
    if (!session || session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: session ? "generation_replaced" : "session_lost",
        current: session?.generation,
      })
    }
    const updated = next(session)
    if (!updated)
      throw new TransitionError({ sessionID: ref.sessionID, generation: ref.generation, state: session.state, action })
    const frozen = freezeSession(updated)
    sessions.set(ref.sessionID, frozen)
    return frozen
  }

  const requireActive = (ref: Ref): Session => {
    const session = sessions.get(ref.sessionID)
    if (!session) {
      throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason: "session_lost" })
    }
    if (session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: "generation_replaced",
        current: session.generation,
      })
    }
    if (session.state === "active") return session
    const reason: StaleReason =
      session.state === "created"
        ? "not_active"
        : session.state === "crashed"
          ? "session_lost"
          : session.state === "expired"
            ? "session_expired"
            : session.state === "unknown"
              ? "outcome_unknown"
            : "session_terminated"
    throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason })
  }

  const hasAuthority = (session: Session, authority: AuthorityBinding): boolean =>
    authority.principalId === session.principalId &&
    authority.locationID === session.locationID &&
    authority.workspaceId === session.workspaceId &&
    authority.workspaceRevision === session.workspaceRevision &&
    authority.ownerEpoch === session.ownerEpoch &&
    sameManagedAttemptScope(session.managedAttemptScope, authority.managedAttemptScope) &&
    sameDirectAttemptScope(session.directAttemptScope, authority.directAttemptScope) &&
    authority.policyGeneration === session.policyGeneration &&
    authority.sandboxGeneration === session.sandboxGeneration &&
    authority.capabilityCeilingDigest === session.capabilityCeilingDigest

  const requireOwned = (ref: Ref, authority: AuthorityBinding): Session => {
    const session = requireActive(ref)
    if (!hasAuthority(session, authority)) {
      throw new StaleRefError({ sessionID: session.sessionID, generation: session.generation, reason: "session_lost" })
    }
    return session
  }

  const requireScope = (ref: Ref, authority: AuthorityBinding): Session => {
    const session = sessions.get(ref.sessionID)
    if (!session || session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: session ? "generation_replaced" : "session_lost",
        current: session?.generation,
      })
    }
    if (!hasAuthority(session, authority)) {
      throw new StaleRefError({ sessionID: session.sessionID, generation: session.generation, reason: "session_lost" })
    }
    return session
  }

  return {
    create(input) {
      for (const [field, value] of Object.entries({
        sessionID: input.sessionID,
        adapterID: input.adapterID,
        principalId: input.principalId,
        locationID: input.locationID,
        workspaceId: input.workspaceId,
        workspaceRevision: input.workspaceRevision,
        ownerEpoch: input.ownerEpoch,
        policyGeneration: input.policyGeneration,
        capabilityCeilingDigest: input.capabilityCeilingDigest,
        launchConfigDigest: input.launchConfigDigest,
      })) {
        if (value.trim().length === 0) throw new TypeError(`debug session ${field} must be non-empty`)
      }
      if (!Number.isSafeInteger(input.sandboxGeneration) || input.sandboxGeneration < 1) {
        throw new TypeError("debug session sandboxGeneration must be a positive safe integer")
      }
      if (!/^blake3:[0-9a-f]{64}$/.test(input.capabilityCeilingDigest)) {
        throw new TypeError("debug session capabilityCeilingDigest must be a blake3 digest")
      }
      if (!/^blake3:[0-9a-f]{64}$/.test(input.launchConfigDigest)) {
        throw new TypeError("debug session launchConfigDigest must be a blake3 digest")
      }
      const launchProfileRef = validateExecutionLaunchProfileRef(input.launchProfileRef)
      try {
        validateHostProcessScope({
          sessionID: input.sessionID,
          locationID: input.locationID,
          ownerEpoch: input.ownerEpoch,
          workspaceRevision: input.workspaceRevision,
          managedAttemptScope: input.managedAttemptScope,
          directAttemptScope: input.directAttemptScope,
          workspaceID: input.workspaceId,
        })
      } catch (error) {
        throw new TypeError(error instanceof Error ? error.message : "debug session process scope is invalid")
      }
      let processRef: ProcessTargetRef
      try {
        processRef = decodeProcessTargetRef(input.processRef)
        if (processRef.ownerEpoch !== input.ownerEpoch || processRef.kind !== "debug_adapter") {
          throw new TypeError("adapter process reference must match the current owner epoch and debug_adapter kind")
        }
      } catch {
        throw new TypeError("debug session requires a HostKernel-issued adapter process reference")
      }
      if (
        processRef.profileID !== launchProfileRef.profileId ||
        processRef.profileRevision !== launchProfileRef.revision ||
        processRef.profileDigest !== launchProfileRef.profileDigest
      ) {
        throw new TypeError("debug adapter process reference does not match the retained launch profile pin")
      }
      const previous = sessions.get(input.sessionID)
      if (previous && !["crashed", "expired", "terminated"].includes(previous.state)) {
        throw new TransitionError({
          sessionID: previous.sessionID,
          generation: previous.generation,
          state: previous.state,
          action: "create_replacement",
        })
      }
      const generation = (generations.get(input.sessionID) ?? 0) + 1
      generations.set(input.sessionID, generation)
      const session = freezeSession({ ...input, launchProfileRef, processRef, generation, state: "created" })
      sessions.set(input.sessionID, session)
      return session
    },
    activate(ref) {
      return update(ref, "activate", (session) =>
        session.state === "created" ? { ...session, state: "active" } : undefined,
      )
    },
    activateOwned(ref, authority) {
      requireScope(ref, authority)
      return update(ref, "activate", (session) =>
        session.state === "created" ? { ...session, state: "active" } : undefined,
      )
    },
    crash(ref) {
      return update(ref, "crash", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "crashed" } : undefined,
      )
    },
    crashOwned(ref, authority) {
      requireScope(ref, authority)
      return update(ref, "crash", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "crashed" } : undefined,
      )
    },
    markUnknown(ref) {
      return update(ref, "markUnknown", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "unknown" } : undefined,
      )
    },
    markUnknownOwned(ref, authority) {
      requireScope(ref, authority)
      return update(ref, "markUnknown", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "unknown" } : undefined,
      )
    },
    expire(ref) {
      return update(ref, "expire", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "expired" } : undefined,
      )
    },
    terminate(ref) {
      return update(ref, "terminate", (session) =>
        session.state === "created" ||
          session.state === "active" ||
          session.state === "crashed" ||
          session.state === "expired"
          ? { ...session, state: "terminated" }
          : undefined,
      )
    },
    terminateOwned(ref, authority) {
      requireScope(ref, authority)
      return update(ref, "terminate", (session) =>
        session.state === "created" ||
          session.state === "active" ||
          session.state === "crashed" ||
          session.state === "expired"
          ? { ...session, state: "terminated" }
          : undefined,
      )
    },
    requireOwned(ref, authority) {
      return requireOwned(ref, authority)
    },
    bindObjectRefOwned(ref, kind, id, authority) {
      const session = requireOwned(ref, authority)
      return Object.freeze(decodeObjectRef({ sessionID: session.sessionID, generation: session.generation, kind, id }))
    },
    resolveObjectRefOwned(input, authority) {
      const ref = decodeObjectRef(input)
      return Object.freeze({
        session: requireOwned(ref, authority),
        kind: ref.kind,
        id: ref.id,
      })
    },
    listOwned(authority) {
      return Object.freeze([...sessions.values()].filter((session) => hasAuthority(session, authority)))
    },
  }
}

export * as DapSession from "./session"
