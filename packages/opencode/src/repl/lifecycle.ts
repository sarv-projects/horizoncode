import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import {
  ReplLanguage,
  MAX_OUTPUT_REFERENCES_PER_GENERATION,
  parseExecuteRequest,
  parseExecuteResult,
  parseStartRequest,
  type ExecuteRequest,
  type ExecuteResult,
  type ResourceLimits,
} from "./protocol"
import { DEFAULT_IDLE_TTL_MS, validateIdleTtl } from "./protocol"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  type ExecutionLaunchProfileRefV1,
  type HostProcessRefV1,
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  validateExecutionLaunchProfileRef,
  validateHostProcessRef,
  validateHostProcessScope,
} from "@/lsp/process-scope"

export { DEFAULT_IDLE_TTL_MS }

/**
 * ReplBrokerV1 session lifecycle (§37.8, §32.28) — bounded, Python-first
 * generation bookkeeping.
 *
 * Scope of this module: session generations, idle-expiry, crash/reset
 * invalidation and generation-scoped result acceptance. It must never start
 * an interpreter, execute code or invoke an agent-tool callback. Execution,
 * callbacks and interpreter stop stay UNAVAILABLE until the Rust Guard/
 * ExecutionHost mediation for this origin is implemented and verified.
 *
 * Rules enforced here:
 * - state persists only inside one REPL generation; refs to a replaced,
 *   expired, crashed or stopped generation always fail with `StaleRefError`;
 * - idle expiry invalidates the generation (`expireIdle`);
 * - `reset` bumps the generation, so every old reference is stale by
 *   construction;
 * - a result envelope is accepted only for the live generation it was
 *   produced by (`acceptResult`);
 * - artifact/output references are generation-bound: an output ref may only be
 *   resolved while the issuing generation is live, so a stale or forged ref
 *   can never be served as current output (`bindOutputRef`/`resolveOutputRef`);
 * - callbacks to agent tools must re-enter the canonical ActionDescriptor/
 *   Guard path; this module only records the declared capability set and
 *   reports the effect as unavailable.
 *
 * The registry is driven explicitly. It is the reusable half that a future
 * Guard-mediated interpreter session will feed; until then nothing in
 * production calls it and every effectful operation throws `UnavailableError`.
 */

export const ReplState = Schema.Literals(["created", "active", "expired", "crashed", "cancelled", "unknown", "stopped"])
export type ReplState = typeof ReplState.Type

export const Ref = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
}).annotate({ identifier: "ReplRefV1" })
export type Ref = typeof Ref.Type

/**
 * A generation-bound reference to artifactized REPL output (`repl.output_range`
 * in §37.8). Output is only servable while the generation that produced it is
 * live: replacing, expiring, crashing, cancelling or stopping that generation
 * stales every output reference, and only refs actually issued by
 * `bindOutputRef` for the live generation resolve.
 */
export const OutputRef = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
  artifactRef: Schema.String,
}).annotate({ identifier: "ReplOutputRefV1" })
export type OutputRef = typeof OutputRef.Type

export const Status = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
  language: ReplLanguage,
  state: ReplState,
  createdAtMs: NonNegativeInt,
  lastActivityMs: NonNegativeInt,
  idleTtlMs: PositiveInt,
}).annotate({ identifier: "ReplStatusV1" })
export type Status = typeof Status.Type

export interface ReplSession {
  readonly sessionID: string
  readonly generation: number
  /** Authenticated host bindings; do not derive these from REPL code or callbacks. */
  readonly ownerId: string
  readonly locationID: string
  readonly workspaceId: string
  readonly workspaceRevision: string
  readonly ownerEpoch: string
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
  readonly sourceGeneration: string
  readonly sandboxGeneration: number
  readonly policyGeneration: string
  readonly capabilityCeilingDigest: string
  readonly language: ReplLanguage
  readonly state: ReplState
  readonly scope: string
  readonly idleTtlMs: number
  readonly createdAtMs: number
  readonly lastActivityMs: number
  readonly resourceLimits: ResourceLimits
  readonly callbackCapabilities: readonly string[]
  readonly launchProfileRef: ExecutionLaunchProfileRefV1
}

/** Trusted owner scope required when a persisted REPL reference is presented. */
export type ReplAuthorityBinding = Pick<
  ReplSession,
  | "ownerId"
  | "locationID"
  | "workspaceId"
  | "workspaceRevision"
  | "ownerEpoch"
  | "managedAttemptScope"
  | "directAttemptScope"
  | "sourceGeneration"
  | "sandboxGeneration"
  | "policyGeneration"
  | "capabilityCeilingDigest"
>

export class TransitionError extends Schema.TaggedErrorClass<TransitionError>()("ReplSessionTransitionError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  state: ReplState,
  action: Schema.String,
}) {}

export const StaleReason = Schema.Literals([
  "generation_replaced",
  "not_active",
  "expired",
  "crashed",
  "cancelled",
  "outcome_unknown",
  "stopped",
  "session_lost",
  "invalidated",
])
export type StaleReason = typeof StaleReason.Type

export class StaleRefError extends Schema.TaggedErrorClass<StaleRefError>()("ReplStaleRefError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  reason: StaleReason,
  current: Schema.optional(PositiveInt),
}) {}

export class OutputLimitError extends Schema.TaggedErrorClass<OutputLimitError>()("ReplOutputLimitError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  maximumBytes: PositiveInt,
  observedBytes: Schema.Int,
}) {}

export class OutputReferenceLimitError extends Schema.TaggedErrorClass<OutputReferenceLimitError>()(
  "ReplOutputReferenceLimitError",
  {
    sessionID: Schema.String,
    generation: PositiveInt,
    maximumReferences: PositiveInt,
  },
) {}

export class CallbackCapabilityDeniedError extends Schema.TaggedErrorClass<CallbackCapabilityDeniedError>()(
  "ReplCallbackCapabilityDeniedError",
  { reason: Schema.Literal("not_declared") },
) {}

export class DeadlineLimitError extends Schema.TaggedErrorClass<DeadlineLimitError>()("ReplDeadlineLimitError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  maximumMs: PositiveInt,
  requestedMs: PositiveInt,
}) {}

export const Operation = Schema.Literals(["repl.start", "repl.execute", "repl.callback", "repl.reset", "repl.stop"])
export type Operation = typeof Operation.Type

/**
 * Canonical Guard action IDs (the `repl.*` family owned by `kernel/src/guard.rs`). An
 * operation without an entry (`repl.callback`) has no single canonical action: callbacks
 * re-enter the invoked tool's own canonical action/Guard path instead.
 */
export const GuardAction = {
  "repl.start": "repl.start",
  "repl.execute": "repl.execute",
  "repl.reset": "repl.reset",
  "repl.stop": "repl.stop",
} as const

export function guardActionID(operation: Operation): string | undefined {
  return (GuardAction as Partial<Record<Operation, string>>)[operation]
}

export const UnavailableReason = Schema.Literals(["guard_not_verified"])
export type UnavailableReason = typeof UnavailableReason.Type

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("ReplUnavailableError", {
  operation: Operation,
  reason: UnavailableReason,
  detail: Schema.optional(Schema.String),
}) {}

/**
 * One authorized REPL effect. The token is issued by the canonical Guard/ExecutionHost
 * boundary; this module never manufactures one and never executes an interpreter action
 * without it.
 */
export type ReplEffectAuthorization = {
  readonly capabilityID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityLeaseDigest: string
}

/**
 * A request to the canonical boundary. Launch authority is a pinned logical profile ref.
 */
export type ReplEffectRequest = {
  readonly operation: Operation
  readonly sessionID: string
  readonly generation: number
  readonly language: ReplLanguage
  readonly scope: string
  readonly resourceLimits: ResourceLimits
  readonly callbackCapabilities: readonly string[]
  /** Authenticated host context; never copied from an interpreter callback. */
  readonly ownerId: string
  readonly locationID: string
  readonly workspaceId: string
  readonly workspaceRevision: string
  readonly ownerEpoch: string
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
  readonly sourceGeneration: string
  readonly sandboxGeneration: number
  readonly policyGeneration: string
  readonly capabilityCeilingDigest: string
  /** HostKernel-issued interpreter identity for operations on a retained worker. */
  readonly processRef?: HostProcessRefV1
  readonly launchProfileRef?: ExecutionLaunchProfileRefV1
}

export type ReplResourceGuaranteesV1 = {
  readonly cpuTimeEnforced: boolean
  readonly memoryEnforced: boolean
  readonly processCountEnforced: boolean
  readonly fileDescriptorsEnforced: boolean
}

export interface ReplEffectRoute {
  /** The canonical Guard/ExecutionHost boundary for REPL effects. */
  readonly authorize: (request: ReplEffectRequest) => Promise<ReplEffectAuthorization>
  /** HostKernel assessment; monitoring/admission values do not count as enforcement. */
  readonly resourceGuarantees?: ReplResourceGuaranteesV1
}

let route: ReplEffectRoute | undefined

/**
 * Register the canonical Guard route for REPL effects. Only the host integration that
 * owns an admitted `repl.*` action may call this; the default (no route) keeps every
 * interpreter effect typed-unavailable.
 */
export function setReplEffectRoute(next: ReplEffectRoute | undefined): void {
  route = next
}

export function replEffectRouteAvailable(): boolean {
  return route !== undefined
}

function validAuthorization(value: unknown): value is ReplEffectAuthorization {
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
 * Ask the canonical boundary to authorize one REPL effect. Without a registered route
 * (the current build) this fails closed with `UnavailableError`; with a route, the
 * boundary alone decides and a malformed answer is refused rather than trusted.
 */
export async function authorizeEffect(request: ReplEffectRequest): Promise<ReplEffectAuthorization> {
  const action = guardActionID(request.operation)
  if (!action) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: `REPL operation ${request.operation} has no single canonical Guard action; callbacks must re-enter the invoked tool's own Guard path`,
    })
  }

  try {
    validateEffectRequest(request)
  } catch (error) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: error instanceof Error ? error.message : "REPL effect request has invalid host bindings",
    })
  }

  const current = route
  if (!current) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail:
        "REPL execution and callbacks need the Rust Guard/ExecutionHost route, which is not registered for this origin",
    })
  }
  if (["repl.start", "repl.reset", "repl.execute"].includes(request.operation)) {
    const guarantees = current.resourceGuarantees
    if (
      !guarantees ||
      guarantees.cpuTimeEnforced !== true ||
      guarantees.memoryEnforced !== true ||
      guarantees.processCountEnforced !== true ||
      guarantees.fileDescriptorsEnforced !== true
    ) {
      throw new UnavailableError({
        operation: request.operation,
        reason: "guard_not_verified",
        detail: "REPL execution requires HostKernel-confirmed OS enforcement for CPU time, memory, process count, and file descriptors",
      })
    }
  }
  const scopedRequest = Object.freeze({
    ...request,
    managedAttemptScope: freezeManagedAttemptScope(request.managedAttemptScope),
    directAttemptScope: freezeDirectAttemptScope(request.directAttemptScope),
    resourceLimits: Object.freeze({ ...request.resourceLimits }),
    callbackCapabilities: Object.freeze([...request.callbackCapabilities]),
    launchProfileRef: request.launchProfileRef
      ? validateExecutionLaunchProfileRef(request.launchProfileRef)
      : undefined,
    processRef: request.processRef ? Object.freeze({ ...validateHostProcessRef(request.processRef) }) : undefined,
  })
  const authorization = await current.authorize(scopedRequest)
  if (!validAuthorization(authorization) || authorization.capabilityID !== action) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: `the REPL effect route did not authorize canonical action ${action}`,
    })
  }
  return Object.freeze({ ...authorization })
}

function validateEffectRequest(request: ReplEffectRequest): void {
  for (const [field, value] of Object.entries({
    sessionID: request.sessionID,
    ownerId: request.ownerId,
    locationID: request.locationID,
    workspaceId: request.workspaceId,
    workspaceRevision: request.workspaceRevision,
    ownerEpoch: request.ownerEpoch,
    sourceGeneration: request.sourceGeneration,
    policyGeneration: request.policyGeneration,
    capabilityCeilingDigest: request.capabilityCeilingDigest,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`REPL effect ${field} is required`)
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    throw new TypeError("REPL effect generation must be a positive safe integer")
  }
  if (!Number.isSafeInteger(request.sandboxGeneration) || request.sandboxGeneration < 1) {
    throw new TypeError("REPL effect sandboxGeneration must be a positive safe integer")
  }
  if (!/^blake3:[0-9a-f]{64}$/.test(request.capabilityCeilingDigest)) {
    throw new TypeError("REPL effect capabilityCeilingDigest must be a blake3 digest")
  }
  validateHostProcessScope({
    sessionID: request.sessionID,
    locationID: request.locationID,
    ownerEpoch: request.ownerEpoch,
    workspaceRevision: request.workspaceRevision,
    managedAttemptScope: request.managedAttemptScope,
    directAttemptScope: request.directAttemptScope,
    workspaceID: request.workspaceId,
  })
  if (request.operation === "repl.start" || request.operation === "repl.reset") {
    try {
      validateExecutionLaunchProfileRef(request.launchProfileRef)
    } catch {
      throw new TypeError("REPL worker start requires a HostKernel launch profile reference")
    }
    parseStartRequest({
      language: request.language,
      scope: request.scope,
      resourceLimits: request.resourceLimits,
      callbackCapabilities: [...request.callbackCapabilities],
    })
    if (request.operation === "repl.start" && request.processRef !== undefined) {
      throw new TypeError("REPL start cannot include a pre-existing interpreter process reference")
    }
    if (request.operation === "repl.reset") validateInterpreterProcessRef(request)
  } else {
    if (request.launchProfileRef !== undefined) {
      throw new TypeError("REPL operation cannot replace the retained interpreter launch profile")
    }
    validateInterpreterProcessRef(request)
  }
}

function validateInterpreterProcessRef(request: ReplEffectRequest): void {
  let processRef: ReturnType<typeof validateHostProcessRef>
  try {
    processRef = validateHostProcessRef(request.processRef)
  } catch {
    throw new TypeError("REPL operation requires a HostKernel interpreter process reference")
  }
  if (processRef.kind !== "interpreter" || processRef.ownerEpoch !== request.ownerEpoch) {
    throw new TypeError("REPL process reference must match the authenticated interpreter owner")
  }
}

export interface Availability {
  readonly operation: Operation
  readonly available: false
  readonly reason: UnavailableReason
  readonly detail: string
}

/**
 * Non-throwing availability report. Starting/executing/stopping an
 * interpreter and invoking an agent-tool callback are process/tool effects
 * and require the canonical Guard/ExecutionHost route, which is not registered
 * for this origin. The report names the canonical Guard action when one exists, so a
 * status surface states the exact missing owner instead of a generic refusal.
 */
export function availability(operation: Operation): Availability {
  const action = guardActionID(operation)
  return {
    operation,
    available: false,
    reason: "guard_not_verified",
    detail: action
      ? `REPL effect ${operation} needs the Rust Guard/ExecutionHost route for canonical action ${action} and OS-enforced CPU time, memory, process-count, and file-descriptor limits`
      : `REPL effect ${operation} re-enters the invoked tool's own canonical action/Guard path and is unavailable until that boundary is registered`,
  }
}

/** Fail-closed enforcement; always throws `UnavailableError` today. */
export function requireEffectAllowed(operation: Operation): never {
  const report = availability(operation)
  throw new UnavailableError({ operation, reason: report.reason, detail: report.detail })
}

export interface Registry {
  /** Bookkeeping only; no interpreter is started by this call. */
  readonly create: (input: {
    sessionID: string
    ownerId: string
    locationID: string
    workspaceId: string
    workspaceRevision: string
    ownerEpoch: string
    managedAttemptScope?: ManagedAttemptScopeV1
    directAttemptScope?: DirectAttemptScopeV1
    sourceGeneration: string
    sandboxGeneration: number
    policyGeneration: string
    capabilityCeilingDigest: string
    language: ReplLanguage
    scope: string
    nowMs: number
    resourceLimits: ResourceLimits
    idleTtlMs?: number
    callbackCapabilities?: readonly string[]
    launchProfileRef: ExecutionLaunchProfileRefV1
  }) => ReplSession
  readonly activate: (ref: Ref, nowMs: number) => ReplSession
  readonly touch: (ref: Ref, nowMs: number) => ReplSession
  /** Record cancellation and invalidate the generation; this does not stop a worker. */
  readonly cancel: (ref: Ref) => ReplSession
  /** Expire every created/active generation idle past its TTL; returns the expired refs. */
  readonly expireIdle: (nowMs: number) => readonly Ref[]
  readonly crash: (ref: Ref) => ReplSession
  /** Invalidate the current generation and open a fresh one (old refs become stale). */
  readonly reset: (ref: Ref, nowMs: number) => ReplSession
  /** Authenticated control entry points for host adapters; raw state-transition
   * methods above are for the broker's trusted internal lifecycle only. */
  readonly resetOwned: (ref: Ref, authority: ReplAuthorityBinding, nowMs: number) => ReplSession
  readonly stop: (ref: Ref) => ReplSession
  readonly stopOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /**
   * Resolve a persisted session only when its trusted owner/workspace/sandbox/capability
   * binding matches the authenticated caller. Mismatch is intentionally reported as an
   * invalidated ref so the caller cannot probe whether another owner's session exists.
   */
  readonly requireOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Check a callback against the immutable per-generation declaration. This
   * is only an admission precondition; invocation must still re-enter the
   * canonical ActionDescriptor and Guard path. */
  readonly requireCallbackCapability: (
    ref: Ref,
    authority: ReplAuthorityBinding,
    capabilityID: string,
  ) => ReplSession
  /** Read a bounded summary only for the authenticated owner binding. */
  readonly statusOwned: (ref: Ref, authority: ReplAuthorityBinding) => Status
  /** Validates an execute request against its live generation and wall-time budget. */
  readonly validateExecuteRequest: (ref: Ref, request: ExecuteRequest) => ExecuteRequest
  /** Accept a worker result only for the live generation that produced it. */
  readonly acceptResult: (ref: Ref, result: ExecuteResult) => ExecuteResult
  /**
   * Bind artifactized output to the live generation that produced it. The
   * result must belong to that generation and carry a non-blank artifact
   * reference; otherwise no output reference is issued (`undefined`).
   */
  readonly bindOutputRef: (ref: Ref, result: ExecuteResult) => OutputRef | undefined
  /**
   * Resolve an output reference only while the issuing generation is live and
   * only when the reference was actually issued for it. Stale, replaced or
   * forged references always throw `StaleRefError`.
   */
  /** Resolve an artifact reference only for the authenticated owner binding. */
  readonly resolveOutputRefOwned: (
    outputRef: OutputRef,
    authority: ReplAuthorityBinding,
  ) => { readonly session: ReplSession; readonly artifactRef: string }
  /** Enumerate only sessions belonging to the authenticated owner scope. */
  readonly listOwned: (authority: ReplAuthorityBinding) => readonly ReplSession[]
}

export function makeRegistry(): Registry {
  const generations = new Map<string, number>()
  const sessions = new Map<string, ReplSession>()
  const outputRefs = new Map<string, Set<string>>()
  const encoder = new TextEncoder()

  const generationKey = (sessionID: string, generation: number) => `${sessionID}:${generation}`

  const discardOutputRefs = (sessionID: string, keepGeneration?: number) => {
    const prefix = `${sessionID}:`
    for (const key of outputRefs.keys()) {
      if (!key.startsWith(prefix)) continue
      if (key === `${prefix}${keepGeneration}`) continue
      outputRefs.delete(key)
    }
  }

  const freezeSession = (session: ReplSession): ReplSession =>
    Object.freeze({
      ...session,
      managedAttemptScope: freezeManagedAttemptScope(session.managedAttemptScope),
      directAttemptScope: freezeDirectAttemptScope(session.directAttemptScope),
      resourceLimits: Object.freeze({ ...session.resourceLimits }),
      callbackCapabilities: Object.freeze([...session.callbackCapabilities]),
      launchProfileRef: validateExecutionLaunchProfileRef(session.launchProfileRef),
    })

  const lookup = (ref: Ref): ReplSession => {
    const session = sessions.get(ref.sessionID)
    if (!session || session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: session ? "generation_replaced" : "session_lost",
        current: session?.generation,
      })
    }
    return session
  }

  const assertAuthority = (session: ReplSession, authority: ReplAuthorityBinding): void => {
    if (
      authority.ownerId !== session.ownerId ||
      authority.locationID !== session.locationID ||
      authority.workspaceId !== session.workspaceId ||
      authority.workspaceRevision !== session.workspaceRevision ||
      authority.ownerEpoch !== session.ownerEpoch ||
      !sameManagedAttemptScope(session.managedAttemptScope, authority.managedAttemptScope) ||
      !sameDirectAttemptScope(session.directAttemptScope, authority.directAttemptScope) ||
      authority.sourceGeneration !== session.sourceGeneration ||
      authority.sandboxGeneration !== session.sandboxGeneration ||
      authority.policyGeneration !== session.policyGeneration ||
      authority.capabilityCeilingDigest !== session.capabilityCeilingDigest
    ) {
      throw new StaleRefError({
        sessionID: session.sessionID,
        generation: session.generation,
        reason: "invalidated",
      })
    }
  }

  const transition = (
    ref: Ref,
    action: string,
    allowed: readonly ReplState[],
    next: (session: ReplSession) => ReplSession,
  ): ReplSession => {
    const session = lookup(ref)
    if (!allowed.includes(session.state)) {
      throw new TransitionError({ sessionID: ref.sessionID, generation: ref.generation, state: session.state, action })
    }
    const updated = freezeSession(next(session))
    sessions.set(ref.sessionID, updated)
    return updated
  }

  const requireActive = (ref: Ref): ReplSession => {
    const session = lookup(ref)
    if (session.state === "active") return session
    const reason: StaleReason =
      session.state === "created"
        ? "not_active"
        : session.state === "expired"
          ? "expired"
          : session.state === "crashed"
            ? "crashed"
            : session.state === "cancelled"
              ? "cancelled"
              : session.state === "unknown"
                ? "outcome_unknown"
                : "stopped"
    throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason })
  }

  const requireOwned = (ref: Ref, authority: ReplAuthorityBinding): ReplSession => {
    const session = requireActive(ref)
    assertAuthority(session, authority)
    return session
  }

  const requireScope = (ref: Ref, authority: ReplAuthorityBinding): ReplSession => {
    const session = lookup(ref)
    assertAuthority(session, authority)
    return session
  }

  const resetSession = (ref: Ref, nowMs: number): ReplSession => {
    const session = transition(ref, "reset", ["created", "active", "crashed"], (current) => {
      const generation = (generations.get(current.sessionID) ?? current.generation) + 1
      generations.set(current.sessionID, generation)
      return {
        ...current,
        generation,
        sandboxGeneration: current.sandboxGeneration + 1,
        state: "created",
        createdAtMs: nowMs,
        lastActivityMs: nowMs,
      }
    })
    discardOutputRefs(ref.sessionID, session.generation)
    return session
  }

  const acceptResult = (ref: Ref, result: ExecuteResult): ExecuteResult => {
    const validated = parseExecuteResult(result)
    const session = requireActive(ref)
    if (validated.generation !== session.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: validated.generation,
        reason: "generation_replaced",
        current: session.generation,
      })
    }
    const observedBytes =
      encoder.encode(validated.value ?? "").byteLength +
      encoder.encode(validated.stdout).byteLength +
      encoder.encode(validated.stderr).byteLength +
      encoder.encode(validated.artifactRef ?? "").byteLength
    if (observedBytes > session.resourceLimits.maxOutputBytes) {
      sessions.set(ref.sessionID, freezeSession({ ...session, state: "unknown" }))
      throw new OutputLimitError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        maximumBytes: session.resourceLimits.maxOutputBytes,
        observedBytes,
      })
    }
    if (validated.status === "unknown" || validated.status === "timeout") {
      // A timed-out persistent interpreter may have partially mutated its
      // state. This envelope carries no proof that the worker was stopped
      // and reconciled, so quarantine it like any other uncertain outcome.
      sessions.set(ref.sessionID, freezeSession({ ...session, state: "unknown" }))
    }
    if (validated.status === "cancelled") {
      // Cancellation says the request stopped producing normal output; it
      // does not prove the persistent interpreter process exited cleanly.
      sessions.set(ref.sessionID, freezeSession({ ...session, state: "unknown" }))
    }
    return validated
  }

  return {
    create(input) {
      for (const [field, value] of Object.entries({
        sessionID: input.sessionID,
        ownerId: input.ownerId,
        locationID: input.locationID,
        workspaceId: input.workspaceId,
        workspaceRevision: input.workspaceRevision,
        ownerEpoch: input.ownerEpoch,
        sourceGeneration: input.sourceGeneration,
        policyGeneration: input.policyGeneration,
        capabilityCeilingDigest: input.capabilityCeilingDigest,
      })) {
        if (value.trim().length === 0) throw new TypeError(`REPL session ${field} must be non-empty`)
      }
      if (!Number.isSafeInteger(input.sandboxGeneration) || input.sandboxGeneration < 1) {
        throw new TypeError("REPL session sandboxGeneration must be a positive safe integer")
      }
      if (!/^blake3:[0-9a-f]{64}$/.test(input.capabilityCeilingDigest)) {
        throw new TypeError("REPL session capabilityCeilingDigest must be a blake3 digest")
      }
      const launchProfileRef = validateExecutionLaunchProfileRef(input.launchProfileRef)
      validateHostProcessScope({
        sessionID: input.sessionID,
        locationID: input.locationID,
        ownerEpoch: input.ownerEpoch,
        workspaceRevision: input.workspaceRevision,
        managedAttemptScope: input.managedAttemptScope,
        directAttemptScope: input.directAttemptScope,
        workspaceID: input.workspaceId,
      })
      const previous = sessions.get(input.sessionID)
      if (previous && ["created", "active", "expired", "cancelled", "unknown"].includes(previous.state)) {
        throw new TransitionError({
          sessionID: previous.sessionID,
          generation: previous.generation,
          state: previous.state,
          action: "create_replacement",
        })
      }
      const idleTtlMs = input.idleTtlMs === undefined ? DEFAULT_IDLE_TTL_MS : validateIdleTtl(input.idleTtlMs)
      const request = parseStartRequest({
        language: input.language,
        scope: input.scope,
        resourceLimits: input.resourceLimits,
        callbackCapabilities: [...(input.callbackCapabilities ?? [])],
      })
      const generation = (generations.get(input.sessionID) ?? 0) + 1
      generations.set(input.sessionID, generation)
      discardOutputRefs(input.sessionID, generation)
      const session: ReplSession = {
        sessionID: input.sessionID,
        generation,
        ownerId: input.ownerId,
        locationID: input.locationID,
        workspaceId: input.workspaceId,
        workspaceRevision: input.workspaceRevision,
        ownerEpoch: input.ownerEpoch,
        managedAttemptScope: input.managedAttemptScope,
        directAttemptScope: input.directAttemptScope,
        sourceGeneration: input.sourceGeneration,
        sandboxGeneration: input.sandboxGeneration,
        policyGeneration: input.policyGeneration,
        capabilityCeilingDigest: input.capabilityCeilingDigest,
        launchProfileRef,
        language: request.language,
        state: "created",
        scope: request.scope,
        idleTtlMs,
        createdAtMs: input.nowMs,
        lastActivityMs: input.nowMs,
        resourceLimits: { ...request.resourceLimits },
        callbackCapabilities: [...request.callbackCapabilities],
      }
      const frozen = freezeSession(session)
      sessions.set(input.sessionID, frozen)
      return frozen
    },
    activate(ref, nowMs) {
      return transition(ref, "activate", ["created"], (session) => ({
        ...session,
        state: "active",
        lastActivityMs: nowMs,
      }))
    },
    touch(ref, nowMs) {
      const session = requireActive(ref)
      const updated = freezeSession({ ...session, lastActivityMs: nowMs })
      sessions.set(ref.sessionID, updated)
      return updated
    },
    cancel(ref) {
      // The local cancellation request is not proof the supervised interpreter
      // exited or rolled back partial state, so the generation is quarantined.
      return transition(ref, "cancel", ["created", "active"], (session) => ({ ...session, state: "unknown" }))
    },
    expireIdle(nowMs) {
      const expired: Ref[] = []
      for (const session of sessions.values()) {
        if (session.state !== "created" && session.state !== "active") continue
        if (nowMs - session.lastActivityMs < session.idleTtlMs) continue
        sessions.set(session.sessionID, freezeSession({ ...session, state: "expired" }))
        discardOutputRefs(session.sessionID)
        expired.push({ sessionID: session.sessionID, generation: session.generation })
      }
      return expired
    },
    crash(ref) {
      return transition(ref, "crash", ["created", "active"], (session) => ({ ...session, state: "crashed" }))
    },
    reset(ref, nowMs) {
      return resetSession(ref, nowMs)
    },
    resetOwned(ref, authority, nowMs) {
      requireScope(ref, authority)
      return resetSession(ref, nowMs)
    },
    stop(ref) {
      const session = transition(ref, "stop", ["created", "active", "crashed", "expired"], (current) => ({
        ...current,
        state: "stopped",
      }))
      discardOutputRefs(ref.sessionID)
      return session
    },
    stopOwned(ref, authority) {
      requireScope(ref, authority)
      const session = transition(ref, "stop", ["created", "active", "crashed", "expired"], (current) => ({
        ...current,
        state: "stopped",
      }))
      discardOutputRefs(ref.sessionID)
      return session
    },
    requireOwned(ref, authority) {
      return requireOwned(ref, authority)
    },
    requireCallbackCapability(ref, authority, capabilityID) {
      const session = requireOwned(ref, authority)
      if (!session.callbackCapabilities.includes(capabilityID)) {
        throw new CallbackCapabilityDeniedError({ reason: "not_declared" })
      }
      return session
    },
    statusOwned(ref, authority) {
      const session = lookup(ref)
      assertAuthority(session, authority)
      return Object.freeze({
        sessionID: session.sessionID,
        generation: session.generation,
        language: session.language,
        state: session.state,
        createdAtMs: session.createdAtMs,
        lastActivityMs: session.lastActivityMs,
        idleTtlMs: session.idleTtlMs,
      })
    },
    validateExecuteRequest(ref, request) {
      const validated = parseExecuteRequest(request)
      const session = requireActive(ref)
      if (validated.generation !== session.generation) {
        throw new StaleRefError({
          sessionID: ref.sessionID,
          generation: validated.generation,
          reason: "generation_replaced",
          current: session.generation,
        })
      }
      if (validated.deadlineMs > session.resourceLimits.maxWallTimeMs) {
        throw new DeadlineLimitError({
          sessionID: ref.sessionID,
          generation: session.generation,
          maximumMs: session.resourceLimits.maxWallTimeMs,
          requestedMs: validated.deadlineMs,
        })
      }
      return validated
    },
    acceptResult,
    bindOutputRef(ref, result) {
      const validated = acceptResult(ref, result)
      const session = requireActive(ref)
      const artifactRef = validated.artifactRef
      if (artifactRef === undefined || artifactRef.trim().length === 0) return undefined
      const key = generationKey(session.sessionID, session.generation)
      let issued = outputRefs.get(key)
      if (issued?.has(artifactRef)) {
        return Object.freeze({ sessionID: session.sessionID, generation: session.generation, artifactRef })
      }
      if ((issued?.size ?? 0) >= MAX_OUTPUT_REFERENCES_PER_GENERATION) {
        throw new OutputReferenceLimitError({
          sessionID: session.sessionID,
          generation: session.generation,
          maximumReferences: MAX_OUTPUT_REFERENCES_PER_GENERATION,
        })
      }
      if (!issued) {
        issued = new Set()
        outputRefs.set(key, issued)
      }
      issued.add(artifactRef)
      return Object.freeze({ sessionID: session.sessionID, generation: session.generation, artifactRef })
    },
    resolveOutputRefOwned(outputRef, authority) {
      const ref = { sessionID: outputRef.sessionID, generation: outputRef.generation }
      const session = requireOwned(ref, authority)
      const issued = outputRefs.get(generationKey(outputRef.sessionID, outputRef.generation))
      if (!issued?.has(outputRef.artifactRef)) {
        throw new StaleRefError({
          sessionID: outputRef.sessionID,
          generation: outputRef.generation,
          reason: "invalidated",
        })
      }
      return Object.freeze({ session, artifactRef: outputRef.artifactRef })
    },
    listOwned(authority) {
      return Object.freeze(
        [...sessions.values()].filter((session) => {
          try {
            assertAuthority(session, authority)
            return true
          } catch {
            return false
          }
        }),
      )
    },
  }
}

export * as ReplLifecycle from "./lifecycle"
