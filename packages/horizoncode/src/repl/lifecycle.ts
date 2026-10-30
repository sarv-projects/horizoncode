import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { blake3 } from "@noble/hashes/blake3.js"
import { NonNegativeInt, PositiveInt } from "@horizoncode/core/schema"
import {
  ReplLanguage,
  MAX_OUTPUT_REFERENCES_PER_GENERATION,
  parseExecuteRequest,
  parseExecuteResult,
  parseCallbackRequest,
  parseCallbackResult,
  parseStartRequest,
  MAX_CALLBACKS_IN_FLIGHT,
  MAX_CALLBACKS_PER_GENERATION,
  MAX_CODE_BYTES,
  MAX_DEADLINE_MS,
  MAX_OUTPUT_BYTES,
  MIN_DEADLINE_MS,
  type CallbackRequest,
  type CallbackResult,
  type ExecuteRequest,
  type ExecuteResult,
  type ResourceLimits,
} from "./protocol"
import { DEFAULT_IDLE_TTL_MS, validateIdleTtl } from "./protocol"

const HOST_KERNEL_REPL_MAX_DEADLINE_MS = 30_000
const HOST_KERNEL_REPL_MAX_OUTPUT_BYTES = 64 * 1024
const HOST_KERNEL_REPL_MAX_CALLBACK_EVENTS = 16
const HOST_KERNEL_REPL_MAX_CALLBACK_PAGE_BYTES = 256 * 1024
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import type { Interface as SessionSupervisorInterface } from "@horizoncode/core/session/supervisor"
import { Location, encodeCanonicalMessagePackV1 } from "@horizoncode/schema"
import {
  cancelEditorProcessV1,
  launchApprovedEditorProcessV1,
  readEditorProcessOutputV1,
  readEditorProcessStatusV1,
  type EditorProcessOutputPageV1,
  type EditorProcessLifecycleScopeV1,
  type EditorProcessStatusV1,
  type RequestExecutionHostV1,
} from "@/lsp/process-lifecycle"
import { resolveTrustedReplLaunchProfileV1 } from "@/lsp/launch-profile"
import { assertLanguageServiceProcessAllowed } from "@/lsp/launch"
import { isDefinitiveProtocolAdmissionFailure, protocolHostErrorCode } from "@/lsp/protocol"
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
 * invalidation and generation-scoped result acceptance, plus typed Core
 * adapters for HostKernel-owned process status/output/cancel and per-call
 * execute/reset receipts. Those adapters remain unreachable until P1 Guard,
 * durable receipt/recovery, callback-result and OS-quota acceptance passes.
 * This module never owns an interpreter process or directly invokes an
 * agent-tool callback.
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
 * The registry is driven explicitly. It is bookkeeping for the shared
 * HostKernel interpreter owner; it cannot enable process effects or turn
 * caller-supplied guarantees into OS enforcement. Runtime gates remain false.
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
  /** HostKernel-minted interpreter identity, bound once after an accepted launch. */
  readonly processRef?: HostProcessRefV1
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

export class CallbackAdmissionError extends Schema.TaggedErrorClass<CallbackAdmissionError>()("ReplCallbackAdmissionError", {
  reason: Schema.Literals(["duplicate", "too_many_in_flight", "generation_limit", "not_pending"]),
}) {}

export class DeadlineLimitError extends Schema.TaggedErrorClass<DeadlineLimitError>()("ReplDeadlineLimitError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  maximumMs: PositiveInt,
  requestedMs: PositiveInt,
}) {}

export const Operation = Schema.Literals([
  "repl.start",
  "repl.execute",
  "repl.callback",
  "repl.reset",
  "repl.status",
  "repl.output_range",
  "repl.stop",
])
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

/** Strict post-Guard dispatch envelope for the internal HostKernel REPL RPC.
 * Its sequence is fetched from the durable journal immediately before Guard
 * admission; Core never allocates or advances it. Runtime remains gated. */
export type ExecutionReplOperationRequestV1 = {
  readonly schemaVersion: 1
  readonly executionID: string
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly requestSequence: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: "repl.execute" | "repl.reset"
  readonly capabilityLeaseDigest: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly operation:
    | { readonly kind: "execute"; readonly code: string; readonly deadlineMs: number; readonly maxOutputBytes: number }
    | { readonly kind: "reset"; readonly profileRef: ExecutionLaunchProfileRefV1 }
}

/** A candidate HostKernel-buffered callback event, checked against the retained
 * interpreter pins before Core considers ordinary ActionDescriptor routing. */
export type ReplCallbackEventV1 = {
  readonly eventSequence: string
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly callback: unknown
}

/** Exact bounded HostKernel callback page contract. The page carries no
 * authorization; every projected event still re-enters the ordinary action
 * and Guard path before a reply can be settled. */
export type ExecutionReplCallbackReadPageV1 = {
  readonly schemaVersion: 1
  readonly hostProcessRef: HostProcessRefV1
  readonly afterEventSequence: string
  readonly nextEventSequence: string
  readonly processIOSequence: string
  readonly workspaceRevision: string
  readonly status: "RUNNING" | "EXITED" | "UNKNOWN"
  readonly resnapshotRequired: boolean
  readonly events: readonly { readonly eventSequence: string; readonly callback: CallbackRequest }[]
}

/** Projected callback event. The callback action still passes the ordinary
 * ActionDescriptor/Guard path; this envelope authorizes neither that action
 * nor a process reply. */
export type ReplCallbackInvocationV1 = {
  readonly schemaVersion: 1
  readonly executionID: string
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly eventSequence: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly callback: CallbackRequest
}

/** Decode the exact Rust callback replay page. Any gap, overflow, stale
 * process/workspace pin, or request with a replacement cursor requires a
 * fresh HostKernel snapshot and cannot be repaired in Core. */
export function validateExecutionReplCallbackReadPageV1(input: {
  readonly response: unknown
  readonly expectedProcessRef: HostProcessRefV1
  readonly expectedWorkspaceRevision: string
  readonly afterEventSequence: string
  readonly maxEvents: number
  readonly maxBytes: number
}): ExecutionReplCallbackReadPageV1 {
  exactDispatchRecord(input.response, "HostKernel REPL callback page")
  const page = input.response
  const fields = ["schemaVersion", "hostProcessRef", "afterEventSequence", "nextEventSequence", "processIOSequence",
    "workspaceRevision", "status", "resnapshotRequired", "events"]
  if (Object.keys(page).length !== fields.length || Object.keys(page).some((key) => !fields.includes(key)) ||
      page.schemaVersion !== 1 || typeof page.workspaceRevision !== "string" ||
      page.workspaceRevision !== input.expectedWorkspaceRevision ||
      (page.status !== "RUNNING" && page.status !== "EXITED" && page.status !== "UNKNOWN") ||
      typeof page.resnapshotRequired !== "boolean" || !Array.isArray(page.events)) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback page is malformed or stale")
  }
  const processRef = validateHostProcessRef(page.hostProcessRef)
  if (!sameProcessRef(processRef, input.expectedProcessRef)) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback page differs from the retained interpreter")
  }
  canonicalU64(page.afterEventSequence, "afterEventSequence")
  canonicalU64(page.nextEventSequence, "nextEventSequence")
  canonicalU64(page.processIOSequence, "processIOSequence")
  if (page.afterEventSequence !== input.afterEventSequence) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback page does not match the requested cursor")
  }
  const maxEvents = Math.min(HOST_KERNEL_REPL_MAX_CALLBACK_EVENTS, input.maxEvents)
  const maxBytes = Math.min(HOST_KERNEL_REPL_MAX_CALLBACK_PAGE_BYTES, input.maxBytes)
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      page.events.length > maxEvents) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback page exceeds its requested bounds")
  }
  if (page.resnapshotRequired) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback history requires a fresh snapshot")
  }
  const after = BigInt(page.afterEventSequence)
  let expectedSequence = after + 1n
  const events: { readonly eventSequence: string; readonly callback: CallbackRequest }[] = []
  for (const raw of page.events) {
    exactDispatchRecord(raw, "HostKernel REPL callback event")
    if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "eventSequence") || !Object.hasOwn(raw, "callback")) {
      throw new ReplDispatchEnvelopeError("HostKernel REPL callback event has unknown or missing fields")
    }
    canonicalPositiveU64(raw.eventSequence, "callback eventSequence")
    if (BigInt(raw.eventSequence) !== expectedSequence) {
      throw new ReplDispatchEnvelopeError("HostKernel REPL callback event sequence has a gap or duplicate")
    }
    expectedSequence += 1n
    exactDispatchRecord(raw.callback, "HostKernel REPL callback")
    if (typeof raw.callback.generation !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw.callback.generation) ||
        BigInt(raw.callback.generation) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReplDispatchEnvelopeError("HostKernel REPL callback generation is not a safe positive integer")
    }
    const callback = parseCallbackRequest({ ...raw.callback, generation: Number(raw.callback.generation) })
    events.push(Object.freeze({ eventSequence: raw.eventSequence, callback }))
  }
  const next = page.events.length === 0 ? after : expectedSequence - 1n
  if (BigInt(page.nextEventSequence) !== next || Buffer.byteLength(JSON.stringify(page), "utf8") > maxBytes) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback cursor or page byte bound is invalid")
  }
  return Object.freeze({
    schemaVersion: 1,
    hostProcessRef: Object.freeze({ ...processRef }),
    afterEventSequence: page.afterEventSequence,
    nextEventSequence: page.nextEventSequence,
    processIOSequence: page.processIOSequence,
    workspaceRevision: page.workspaceRevision,
    status: page.status,
    resnapshotRequired: page.resnapshotRequired,
    events: Object.freeze(events),
  })
}

/** Strictly validate the durable HostKernel callback-reply acknowledgement
 * against the exact callback, action settlement, and outbound sequence. */
export function validateExecutionReplCallbackReplyReceiptV1(
  input: unknown,
  request: ExecutionReplCallbackReplyRequestV1,
): ExecutionReplCallbackReplyReceiptV1 {
  exactDispatchRecord(input, "HostKernel REPL callback reply receipt")
  const required = ["schemaVersion", "status", "hostProcessRef", "eventSequence", "requestSequence", "callbackID",
    "capabilityID", "effectID", "challengeID", "effectReceiptDigest", "operationDigest", "dispatchReceiptDigest"]
  const allowed = new Set([...required, "capabilityLeaseDigest"])
  if (required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !allowed.has(key)) ||
      Object.hasOwn(input, "capabilityLeaseDigest") !== Object.hasOwn(request, "capabilityLeaseDigest") ||
      input.schemaVersion !== 1 || input.status !== "DISPATCHED" || input.eventSequence !== request.eventSequence ||
      input.requestSequence !== request.requestSequence || input.callbackID !== request.callbackID ||
      input.capabilityID !== request.capabilityID || input.effectID !== request.effectID ||
      input.challengeID !== request.challengeID || input.effectReceiptDigest !== request.effectReceiptDigest ||
      input.operationDigest !== request.operationDigest ||
      (Object.hasOwn(request, "capabilityLeaseDigest") && input.capabilityLeaseDigest !== request.capabilityLeaseDigest)) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback reply receipt differs from its exact request")
  }
  canonicalPositiveU64(input.eventSequence, "callback receipt eventSequence")
  canonicalPositiveU64(input.requestSequence, "callback receipt requestSequence")
  for (const [field, value] of Object.entries({
    callbackID: input.callbackID,
    capabilityID: input.capabilityID,
    effectID: input.effectID,
    challengeID: input.challengeID,
  })) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
      throw new ReplDispatchEnvelopeError(`callback receipt ${field} is malformed`)
    }
  }
  for (const [field, value] of Object.entries({
    effectReceiptDigest: input.effectReceiptDigest,
    operationDigest: input.operationDigest,
    dispatchReceiptDigest: input.dispatchReceiptDigest,
  })) {
    if (typeof value !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value)) {
      throw new ReplDispatchEnvelopeError(`callback receipt ${field} is malformed`)
    }
  }
  if (Object.hasOwn(input, "capabilityLeaseDigest") &&
      (typeof input.capabilityLeaseDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(input.capabilityLeaseDigest))) {
    throw new ReplDispatchEnvelopeError("callback receipt capabilityLeaseDigest is malformed")
  }
  const hostProcessRef = validateHostProcessRef(input.hostProcessRef)
  if (!sameProcessRef(hostProcessRef, request.hostProcessRef)) {
    throw new ReplDispatchEnvelopeError("HostKernel REPL callback receipt differs from its interpreter generation")
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "DISPATCHED",
    hostProcessRef: Object.freeze({ ...hostProcessRef }),
    eventSequence: input.eventSequence as string,
    requestSequence: input.requestSequence as string,
    callbackID: input.callbackID as string,
    capabilityID: input.capabilityID as string,
    effectID: input.effectID as string,
    challengeID: input.challengeID as string,
    ...(Object.hasOwn(input, "capabilityLeaseDigest") ? { capabilityLeaseDigest: input.capabilityLeaseDigest as string } : {}),
    effectReceiptDigest: input.effectReceiptDigest as string,
    operationDigest: input.operationDigest as string,
    dispatchReceiptDigest: input.dispatchReceiptDigest as string,
  })
}

/** Proposed durable positive settlement returned by HostKernel after exactly
 * one interpreter dispatch. UNKNOWN remains an error/quarantine projection,
 * never a Core-manufactured receipt value. */
export type ExecutionReplOperationReceiptV1 = {
  readonly schemaVersion: 1
  readonly status: "DISPATCHED"
  readonly hostProcessRef: HostProcessRefV1
  readonly requestSequence: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: "repl.execute" | "repl.reset"
  readonly capabilityLeaseDigest: string
  readonly operationDigest: string
  readonly dispatchReceiptDigest: string
  readonly replacementHostProcessRef?: HostProcessRefV1
}

/** Durable evidence returned by the ordinary ActionDescriptor/Guard path for
 * the callback action. A DENIED decision has no lease; a settled action must
 * carry its one-use lease. HostKernel verifies both forms against its journal. */
export type GuardedReplCallbackSettlementV1 = {
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly effectReceiptDigest: string
} & (
  | { readonly actionOutcome: "settled"; readonly capabilityLeaseDigest: string }
  | { readonly actionOutcome: "denied"; readonly capabilityLeaseDigest?: never }
)

export type ExecutionReplCallbackResultV1 =
  | { readonly generation: string; readonly callbackID: string; readonly status: "ok"; readonly result: unknown }
  | { readonly generation: string; readonly callbackID: string; readonly status: "denied" | "error"; readonly message: string }

export type ExecutionReplCallbackReplyRequestV1 = {
  readonly schemaVersion: 1
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly eventSequence: string
  readonly requestSequence: string
  readonly callbackID: string
  readonly capabilityID: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest?: string
  readonly effectReceiptDigest: string
  readonly operationDigest: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly result: ExecutionReplCallbackResultV1
}

export type ExecutionReplCallbackReplyReceiptV1 = {
  readonly schemaVersion: 1
  readonly status: "DISPATCHED"
  readonly hostProcessRef: HostProcessRefV1
  readonly eventSequence: string
  readonly requestSequence: string
  readonly callbackID: string
  readonly capabilityID: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest?: string
  readonly effectReceiptDigest: string
  readonly operationDigest: string
  readonly dispatchReceiptDigest: string
}

export class ReplDispatchEnvelopeError extends Error {
  readonly _tag = "ReplDispatchEnvelopeError"
  constructor(message: string) {
    super(message)
    this.name = "ReplDispatchEnvelopeError"
  }
}

/** HostKernel effect_conflict is the pre-PREPARED sequence conflict. Other
 * unclassified REPL RPC failures may have dispatched and must quarantine. */
export function isDefinitiveReplOperationFailure(error: unknown): boolean {
  return isDefinitiveProtocolAdmissionFailure(error) || protocolHostErrorCode(error) === "effect_conflict"
}

/** Validate the read-only sequence projection for the exact interpreter ref. */
export function validateExecutionReplNextSequenceV1(
  input: unknown,
  expectedProcessRef: HostProcessRefV1,
): string {
  exactDispatchRecord(input, "HostKernel next REPL sequence")
  if (Object.keys(input).length !== 3 || input.schemaVersion !== 1 ||
      !sameProcessRef(validateHostProcessRef(input.hostProcessRef), expectedProcessRef)) {
    throw new ReplDispatchEnvelopeError("HostKernel next REPL sequence differs from the retained interpreter")
  }
  const nextRequestSequence = input.nextRequestSequence
  canonicalPositiveU64(nextRequestSequence, "HostKernel nextRequestSequence")
  return nextRequestSequence
}

function canonicalPositiveU64(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) ||
      BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new ReplDispatchEnvelopeError(`${name} must be a canonical positive u64`)
  }
}

function canonicalU64(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
      BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new ReplDispatchEnvelopeError(`${name} must be a canonical u64`)
  }
}

function exactDispatchRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReplDispatchEnvelopeError(`${name} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReplDispatchEnvelopeError(`${name} must be a plain data object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new ReplDispatchEnvelopeError(`${name} must contain only enumerable data fields`)
    }
  }
}

function validateDispatchScope(input: {
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly hostProcessRef: HostProcessRefV1
}): HostProcessRefV1 {
  if ((input.managedAttempt === undefined) === (input.directAttempt === undefined)) {
    throw new ReplDispatchEnvelopeError("REPL dispatch requires exactly one authenticated Attempt lane")
  }
  exactDispatchRecord(input.hostProcessRef, "interpreter HostProcessRef")
  if (input.managedAttempt !== undefined) exactDispatchRecord(input.managedAttempt, "managed Attempt scope")
  if (input.directAttempt !== undefined) exactDispatchRecord(input.directAttempt, "direct Attempt scope")
  const processRef = validateHostProcessRef(input.hostProcessRef)
  if (processRef.kind !== "interpreter") throw new ReplDispatchEnvelopeError("REPL dispatch requires an interpreter HostProcessRef")
  const ownerEpoch = input.managedAttempt?.ownerEpoch ?? input.directAttempt!.ownerEpoch
  if (processRef.ownerEpoch !== ownerEpoch) throw new ReplDispatchEnvelopeError("interpreter owner epoch is stale")
  validateHostProcessScope({
    sessionID: input.sessionID,
    locationID: input.locationID,
    ownerEpoch,
    workspaceRevision: input.workspaceRevision,
    managedAttemptScope: input.managedAttempt,
    directAttemptScope: input.directAttempt,
    workspaceID: input.directAttempt?.workspaceID,
  })
  return Object.freeze({ ...processRef })
}

/** Strictly validate the HostKernel DTO after Guard approval and before IPC.
 * The runtime remains unavailable until P1/P4 and DEC-V1-27 acceptance. */
export function validateExecutionReplOperationRequestV1(input: unknown): ExecutionReplOperationRequestV1 {
  exactDispatchRecord(input, "REPL dispatch envelope")
  const value = input
  const common = ["schemaVersion", "executionID", "hostProcessRef", "sessionID", "locationID", "workspaceRevision",
    "requestSequence", "effectID", "challengeID", "capabilityID", "capabilityLeaseDigest", "operation"]
  const attempt = Object.hasOwn(value, "managedAttempt") ? "managedAttempt" : "directAttempt"
  const expected = new Set([...common, attempt])
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new ReplDispatchEnvelopeError("REPL dispatch envelope has missing or unknown fields")
  }
  if (value.schemaVersion !== 1 || typeof value.executionID !== "string" || !value.executionID ||
      typeof value.sessionID !== "string" || !value.sessionID || typeof value.locationID !== "string" || !value.locationID ||
      typeof value.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value.workspaceRevision)) {
    throw new ReplDispatchEnvelopeError("REPL dispatch identity or revision is malformed")
  }
  canonicalPositiveU64(value.requestSequence, "requestSequence")
  for (const field of ["effectID", "challengeID"] as const) {
    if (typeof value[field] !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value[field])) {
      throw new ReplDispatchEnvelopeError(`${field} is malformed`)
    }
  }
  if (typeof value.capabilityLeaseDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)) {
    throw new ReplDispatchEnvelopeError("capabilityLeaseDigest is malformed")
  }
  if (value.capabilityID !== "repl.execute" && value.capabilityID !== "repl.reset") {
    throw new ReplDispatchEnvelopeError("REPL dispatch capability is not canonical")
  }
  const processRef = validateDispatchScope({
    sessionID: value.sessionID,
    locationID: value.locationID,
    workspaceRevision: value.workspaceRevision,
    managedAttempt: value.managedAttempt as ManagedAttemptScopeV1 | undefined,
    directAttempt: value.directAttempt as DirectAttemptScopeV1 | undefined,
    hostProcessRef: value.hostProcessRef as HostProcessRefV1,
  })
  if (processRef.executionID !== value.executionID) throw new ReplDispatchEnvelopeError("executionID differs from HostProcessRef")
  const op = value.operation
  exactDispatchRecord(op, "REPL operation")
  const operation = op
  if (value.capabilityID === "repl.execute") {
    if (Object.keys(operation).length !== 4 || operation.kind !== "execute" || typeof operation.code !== "string" ||
        operation.code.length === 0 || operation.code.includes("\0") ||
        new TextEncoder().encode(operation.code).byteLength > MAX_CODE_BYTES ||
        !Number.isSafeInteger(operation.deadlineMs) || (operation.deadlineMs as number) < MIN_DEADLINE_MS ||
        (operation.deadlineMs as number) > MAX_DEADLINE_MS || !Number.isSafeInteger(operation.maxOutputBytes) ||
        (operation.maxOutputBytes as number) < 1 || (operation.maxOutputBytes as number) > MAX_OUTPUT_BYTES) {
      throw new ReplDispatchEnvelopeError("bounded repl.execute operation is malformed")
    }
  } else {
    if (Object.keys(operation).length !== 2 || operation.kind !== "reset") {
      throw new ReplDispatchEnvelopeError("repl.reset operation is malformed")
    }
    exactDispatchRecord(operation.profileRef, "reset launch profile reference")
    validateExecutionLaunchProfileRef(operation.profileRef)
    const profileRef = operation.profileRef as ExecutionLaunchProfileRefV1
    if (profileRef.profileId !== processRef.profileID || profileRef.revision !== processRef.profileRevision ||
        profileRef.profileDigest !== processRef.profileDigest) {
      throw new ReplDispatchEnvelopeError("reset launch profile differs from the retained interpreter")
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    executionID: value.executionID,
    hostProcessRef: processRef,
    sessionID: value.sessionID,
    locationID: value.locationID,
    workspaceRevision: value.workspaceRevision,
    requestSequence: value.requestSequence as string,
    effectID: value.effectID as string,
    challengeID: value.challengeID as string,
    capabilityID: value.capabilityID as ExecutionReplOperationRequestV1["capabilityID"],
    capabilityLeaseDigest: value.capabilityLeaseDigest as string,
    ...(value.managedAttempt === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(value.managedAttempt as ManagedAttemptScopeV1) }),
    ...(value.directAttempt === undefined ? {} : { directAttempt: freezeDirectAttemptScope(value.directAttempt as DirectAttemptScopeV1) }),
    operation: Object.freeze({ ...operation }) as ExecutionReplOperationRequestV1["operation"],
  })
}

/** Validate a HostKernel durable dispatch receipt against its exact input. */
export function validateExecutionReplOperationReceiptV1(
  input: unknown,
  request: ExecutionReplOperationRequestV1,
): ExecutionReplOperationReceiptV1 {
  exactDispatchRecord(input, "REPL dispatch receipt")
  const required = ["schemaVersion", "status", "hostProcessRef", "requestSequence", "effectID", "challengeID",
    "capabilityID", "capabilityLeaseDigest", "operationDigest", "dispatchReceiptDigest"]
  const allowed = new Set([...required, "replacementHostProcessRef"])
  if (required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ReplDispatchEnvelopeError("REPL dispatch receipt has missing or unknown fields")
  }
  const reset = request.operation.kind === "reset"
  if (Object.hasOwn(input, "replacementHostProcessRef") !== reset) {
    throw new ReplDispatchEnvelopeError("REPL reset receipt must identify its replacement process exactly once")
  }
  if (input.schemaVersion !== 1 || input.status !== "DISPATCHED" ||
      input.requestSequence !== request.requestSequence || input.effectID !== request.effectID ||
      input.challengeID !== request.challengeID || input.capabilityID !== request.capabilityID ||
      input.capabilityLeaseDigest !== request.capabilityLeaseDigest) {
    throw new ReplDispatchEnvelopeError("REPL dispatch receipt differs from its exact authorized request")
  }
  canonicalPositiveU64(input.requestSequence, "receipt requestSequence")
  if (typeof input.operationDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(input.operationDigest) ||
      typeof input.dispatchReceiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(input.dispatchReceiptDigest)) {
    throw new ReplDispatchEnvelopeError("REPL dispatch receipt digest is malformed")
  }
  exactDispatchRecord(input.hostProcessRef, "receipt HostProcessRef")
  const hostProcessRef = validateHostProcessRef(input.hostProcessRef)
  if (!sameProcessRef(hostProcessRef, request.hostProcessRef)) {
    throw new ReplDispatchEnvelopeError("REPL dispatch receipt is bound to a different interpreter generation")
  }
  let replacementHostProcessRef: HostProcessRefV1 | undefined
  if (reset) {
    exactDispatchRecord(input.replacementHostProcessRef, "replacement interpreter HostProcessRef")
    replacementHostProcessRef = validateHostProcessRef(input.replacementHostProcessRef)
    if (replacementHostProcessRef.kind !== "interpreter" || replacementHostProcessRef.ownerEpoch !== request.hostProcessRef.ownerEpoch ||
        replacementHostProcessRef.executionID === request.hostProcessRef.executionID ||
        BigInt(replacementHostProcessRef.generation) <= BigInt(request.hostProcessRef.generation) ||
        replacementHostProcessRef.profileID !== request.hostProcessRef.profileID ||
        replacementHostProcessRef.profileRevision !== request.hostProcessRef.profileRevision ||
        replacementHostProcessRef.profileDigest !== request.hostProcessRef.profileDigest ||
        replacementHostProcessRef.executableDigest !== request.hostProcessRef.executableDigest) {
      throw new ReplDispatchEnvelopeError("REPL reset receipt does not identify a new matching interpreter generation")
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "DISPATCHED",
    hostProcessRef: Object.freeze({ ...hostProcessRef }),
    requestSequence: input.requestSequence,
    effectID: input.effectID,
    challengeID: input.challengeID,
    capabilityID: input.capabilityID as ExecutionReplOperationReceiptV1["capabilityID"],
    capabilityLeaseDigest: input.capabilityLeaseDigest,
    operationDigest: input.operationDigest,
    dispatchReceiptDigest: input.dispatchReceiptDigest,
    ...(replacementHostProcessRef === undefined ? {} : { replacementHostProcessRef }),
  })
}

/** Candidate callback projection. It is deliberately false-gated because no
 * authenticated HostKernel event-read or receipt-bound reply DTO exists yet. */
export function projectReplCallbackInvocationV1(input: {
  readonly session: ReplSession
  readonly event: ReplCallbackEventV1
}): ReplCallbackInvocationV1 {
  if (!HOST_KERNEL_REPL_CALLBACK_INGRESS_READY) {
    throw new ReplDispatchEnvelopeError("REPL callback ingress is unavailable until HostKernel authenticates the event and receipt-binds its reply")
  }
  const session = input.session
  if (session.state !== "active" || !session.processRef) {
    throw new ReplDispatchEnvelopeError("callback requires an active HostKernel-owned interpreter")
  }
  const event = input.event
  exactDispatchRecord(event, "HostKernel callback event")
  const eventFields = ["eventSequence", "hostProcessRef", "sessionID", "locationID", "workspaceRevision", "callback"]
  if (Object.keys(event).length !== eventFields.length || Object.keys(event).some((key) => !eventFields.includes(key))) {
    throw new ReplDispatchEnvelopeError("HostKernel callback event has missing or unknown fields")
  }
  canonicalPositiveU64(event.eventSequence, "eventSequence")
  const eventProcessRef = validateHostProcessRef(event.hostProcessRef)
  if (event.sessionID !== session.sessionID || event.locationID !== session.locationID ||
      event.workspaceRevision !== session.workspaceRevision || !sameProcessRef(eventProcessRef, session.processRef)) {
    throw new ReplDispatchEnvelopeError("callback event differs from the retained interpreter scope")
  }
  const callback = parseCallbackRequest(event.callback)
  if (callback.generation !== session.generation || !session.callbackCapabilities.includes(callback.capabilityID)) {
    throw new ReplDispatchEnvelopeError("callback does not match the active generation capability ceiling")
  }
  const hostProcessRef = validateDispatchScope({
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    managedAttempt: session.managedAttemptScope,
    directAttempt: session.directAttemptScope,
    hostProcessRef: session.processRef,
  })
  return Object.freeze({
    schemaVersion: 1,
    executionID: hostProcessRef.executionID,
    hostProcessRef,
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    eventSequence: event.eventSequence,
    ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(session.managedAttemptScope) }),
    ...(session.directAttemptScope === undefined ? {} : { directAttempt: freezeDirectAttemptScope(session.directAttemptScope) }),
    callback,
  })
}

/** Read only the next bounded page for an authenticated live REPL generation.
 * Any malformed page, gap, evicted cursor, or non-running worker quarantines
 * the generation; Core never skips to a caller-selected replacement cursor. */
export async function readSupervisedReplCallbacksV1(input: {
  readonly registry: Pick<Registry, "requireOwned" | "markUnknownOwned" | "admitCallback">
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly afterEventSequence: string
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<readonly ReplCallbackInvocationV1[]> {
  if (!HOST_KERNEL_REPL_CALLBACK_INGRESS_READY) {
    throw new ReplDispatchEnvelopeError("REPL callback ingress is unavailable until HostKernel callback reads and reply receipts pass acceptance")
  }
  const session = input.registry.requireOwned(input.ref, input.authority)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  canonicalU64(input.afterEventSequence, "afterEventSequence")
  let page: ExecutionReplCallbackReadPageV1
  try {
    const response = await input.requestHostKernel("execution.v1", "repl_callback_read", {
      schemaVersion: 1,
      hostProcessRef: processRef,
      sessionID: session.sessionID,
      locationID: session.locationID,
      workspaceRevision: session.workspaceRevision,
      afterEventSequence: input.afterEventSequence,
      maxEvents: HOST_KERNEL_REPL_MAX_CALLBACK_EVENTS,
      maxBytes: HOST_KERNEL_REPL_MAX_CALLBACK_PAGE_BYTES,
      ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
      ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
    })
    page = validateExecutionReplCallbackReadPageV1({
      response,
      expectedProcessRef: processRef,
      expectedWorkspaceRevision: session.workspaceRevision,
      afterEventSequence: input.afterEventSequence,
      maxEvents: HOST_KERNEL_REPL_MAX_CALLBACK_EVENTS,
      maxBytes: HOST_KERNEL_REPL_MAX_CALLBACK_PAGE_BYTES,
    })
  } catch (error) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
  if (page.status !== "RUNNING" || page.resnapshotRequired) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw new ReplDispatchEnvelopeError("REPL callback history is unavailable for a stopped or uncertain interpreter")
  }
  try {
    return Object.freeze(page.events.map((event) => {
      const callback = input.registry.admitCallback(input.ref, input.authority, event.callback)
      return projectReplCallbackInvocationV1({
        session,
        event: {
          eventSequence: event.eventSequence,
          hostProcessRef: processRef,
          sessionID: session.sessionID,
          locationID: session.locationID,
          workspaceRevision: session.workspaceRevision,
          callback,
        },
      })
    }))
  } catch (error) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
}

export interface ReplEffectRoute {
  /** The canonical Guard/ExecutionHost boundary for REPL effects. */
  readonly authorize: (request: ReplEffectRequest) => Promise<ReplEffectAuthorization>
  /** HostKernel assessment; monitoring/admission values do not count as enforcement. */
  readonly resourceGuarantees?: ReplResourceGuaranteesV1
}

let route: ReplEffectRoute | undefined

/** Keep the Core REPL runtime closed until integrated HostKernel receipt,
 * recovery, callback and DEC-V1-27 OS-quota acceptance passes. */
// CODE_PRESENT / UNWIRED: lifecycle/callback adapters are not production ingress until P1/P2 receipts and P8 OS quotas pass.
const GUARDED_REPL_RUNTIME_READY = false
/** Callback DTOs are source-projected, but HostKernel read/reply routing and acceptance remain incomplete. */
const HOST_KERNEL_REPL_CALLBACK_INGRESS_READY = false

export function replCallbackIngressAvailable(): boolean {
  return HOST_KERNEL_REPL_CALLBACK_INGRESS_READY
}

/**
 * Register the canonical Guard route for REPL effects. Only the host integration that
 * owns an admitted `repl.*` action may call this; the default (no route) keeps every
 * interpreter effect typed-unavailable.
 */
export function setReplEffectRoute(next: ReplEffectRoute | undefined): void {
  route = next
}

export function replEffectRouteAvailable(): boolean {
  return GUARDED_REPL_RUNTIME_READY && route !== undefined
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

/** DEC-V1-27 policy boundary: REPL execution is unavailable unless the
 * HostKernel confirms OS enforcement for all four required dimensions.
 * Partial bounded admission/monitoring is never represented as hard quotas. */
export function validateReplResourceGuaranteesV1(
  guarantees: ReplResourceGuaranteesV1 | undefined,
): ReplResourceGuaranteesV1 {
  if (
    !guarantees ||
    guarantees.cpuTimeEnforced !== true ||
    guarantees.memoryEnforced !== true ||
    guarantees.processCountEnforced !== true ||
    guarantees.fileDescriptorsEnforced !== true
  ) {
    throw new TypeError(
      "REPL execution requires HostKernel-confirmed OS enforcement for CPU time, memory, process count, and file descriptors",
    )
  }
  return Object.freeze({
    cpuTimeEnforced: true,
    memoryEnforced: true,
    processCountEnforced: true,
    fileDescriptorsEnforced: true,
  })
}

/**
 * Ask the canonical boundary to authorize one REPL effect. Without a registered route
 * (the current build) this fails closed with `UnavailableError`; with a route, the
 * boundary alone decides and a malformed answer is refused rather than trusted.
 */
export async function authorizeEffect(request: ReplEffectRequest): Promise<ReplEffectAuthorization> {
  if (!GUARDED_REPL_RUNTIME_READY) {
    throw new UnavailableError({
      operation: request.operation,
      reason: "guard_not_verified",
      detail: "the HostKernel interpreter launch, operation, cancellation, recovery, and OS resource-limit path has not passed P1/P4 acceptance",
    })
  }
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
    try {
      validateReplResourceGuaranteesV1(current.resourceGuarantees)
    } catch {
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
  assertExactAttemptLane(request.managedAttemptScope, request.directAttemptScope)
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
  if (request.launchProfileRef !== undefined) validateExecutionLaunchProfileRef(request.launchProfileRef)
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

function assertExactAttemptLane(
  managedAttempt: ManagedAttemptScopeV1 | undefined,
  directAttempt: DirectAttemptScopeV1 | undefined,
): void {
  if ((managedAttempt === undefined) === (directAttempt === undefined)) {
    throw new TypeError("REPL authority requires exactly one authenticated Attempt lane")
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
  const detail = action
    ? `REPL effect ${operation} needs accepted HostKernel Guard/ExecutionHost mediation for canonical action ${action} and OS-enforced CPU time, memory, process-count, and file-descriptor limits`
    : operation === "repl.status" || operation === "repl.output_range"
      ? `REPL read ${operation} needs an authenticated HostKernel process/status route for the exact owned generation`
      : `REPL callback ${operation} must re-enter the invoked tool's own canonical ActionDescriptor/Guard path`
  return {
    operation,
    available: false,
    reason: "guard_not_verified",
    detail,
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
  /** Authenticated owner entry point; process startup still requires the unavailable Guard route. */
  readonly activateOwned: (ref: Ref, authority: ReplAuthorityBinding, nowMs: number) => ReplSession
  readonly touch: (ref: Ref, nowMs: number) => ReplSession
  /** Record cancellation and invalidate the generation; this does not stop a worker. */
  readonly cancel: (ref: Ref) => ReplSession
  /** Expire every created/active generation idle past its TTL; returns the expired refs. */
  readonly expireIdle: (nowMs: number) => readonly Ref[]
  readonly crash: (ref: Ref) => ReplSession
  /** Record an observed HostKernel process exit for the exact owner binding. */
  readonly crashOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Invalidate the current generation and open a fresh one (old refs become stale). */
  readonly reset: (ref: Ref, nowMs: number) => ReplSession
  /** Authenticated control entry points for host adapters; raw state-transition
   * methods above are for the broker's trusted internal lifecycle only. */
  readonly resetOwned: (ref: Ref, authority: ReplAuthorityBinding, nowMs: number) => ReplSession
  readonly stop: (ref: Ref) => ReplSession
  readonly stopOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Close a generation only after HostKernel has returned a terminal receipt. */
  readonly reconcileSettledOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Quarantine a generation after HostKernel reports an ambiguous process outcome. */
  readonly markUnknownOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /**
   * Resolve a persisted session only when its trusted owner/workspace/sandbox/capability
   * binding matches the authenticated caller. Mismatch is intentionally reported as an
   * invalidated ref so the caller cannot probe whether another owner's session exists.
   */
  readonly requireOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Resolve a session generation for status/recovery even after it is no longer active. */
  readonly requireScopeOwned: (ref: Ref, authority: ReplAuthorityBinding) => ReplSession
  /** Bind a HostKernel-minted interpreter identity exactly once to a created generation. */
  readonly bindProcessRefOwned: (ref: Ref, authority: ReplAuthorityBinding, processRef: HostProcessRefV1) => ReplSession
  /** Check a callback against the immutable per-generation declaration. This
   * is only an admission precondition; invocation must still re-enter the
   * canonical ActionDescriptor and Guard path. */
  readonly requireCallbackCapability: (
    ref: Ref,
    authority: ReplAuthorityBinding,
    capabilityID: string,
  ) => ReplSession
  /** Bounded, generation-scoped callback admission bookkeeping only. The
   * caller still has to invoke the canonical ActionDescriptor/Guard path. */
  readonly admitCallback: (ref: Ref, authority: ReplAuthorityBinding, input: unknown) => CallbackRequest
  /** Accept an exact callback settlement once. UNKNOWN quarantines the REPL
   * generation because its persistent state may have observed a partial call. */
  readonly acceptCallbackResult: (ref: Ref, authority: ReplAuthorityBinding, input: unknown) => CallbackResult
  /** Read a bounded summary only for the authenticated owner binding. */
  readonly statusOwned: (ref: Ref, authority: ReplAuthorityBinding) => Status
  /** Internal broker check; product callers must use validateExecuteRequestOwned. */
  readonly validateExecuteRequest: (ref: Ref, request: ExecuteRequest) => ExecuteRequest
  readonly validateExecuteRequestOwned: (ref: Ref, authority: ReplAuthorityBinding, request: ExecuteRequest) => ExecuteRequest
  /** Internal broker check; product callers must use acceptResultOwned. */
  readonly acceptResult: (ref: Ref, result: ExecuteResult) => ExecuteResult
  readonly acceptResultOwned: (ref: Ref, authority: ReplAuthorityBinding, result: ExecuteResult) => ExecuteResult
  /**
   * Bind artifactized output to the live generation that produced it. The
   * result must belong to that generation and carry a non-blank artifact
   * reference; otherwise no output reference is issued (`undefined`).
   */
  readonly bindOutputRef: (ref: Ref, result: ExecuteResult) => OutputRef | undefined
  readonly bindOutputRefOwned: (ref: Ref, authority: ReplAuthorityBinding, result: ExecuteResult) => OutputRef | undefined
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

/** Resolve only the HostKernel-retained interpreter process for this exact
 * registry generation. This is status/output/cancel plumbing only: it does
 * not launch, write input, execute code, reset state, or dispatch callbacks. */
function supervisedProcessScope(session: ReplSession): EditorProcessLifecycleScopeV1 {
  return Object.freeze({
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    ...(session.directAttemptScope === undefined ? {} : { workspaceID: session.workspaceId }),
    ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
    ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
  })
}

function supervisedProcessRef(session: ReplSession, input: HostProcessRefV1): HostProcessRefV1 {
  const processRef = validateHostProcessRef(input)
  if (
    processRef.kind !== "interpreter" ||
    processRef.ownerEpoch !== session.ownerEpoch ||
    processRef.profileID !== session.launchProfileRef.profileId ||
    processRef.profileRevision !== session.launchProfileRef.revision ||
    processRef.profileDigest !== session.launchProfileRef.profileDigest
  ) {
    throw new TypeError("HostKernel interpreter reference does not match the authenticated REPL generation and profile")
  }
  validateHostProcessScope({
    sessionID: session.sessionID,
    locationID: session.locationID,
    ownerEpoch: session.ownerEpoch,
    workspaceRevision: session.workspaceRevision,
    managedAttemptScope: session.managedAttemptScope,
    directAttemptScope: session.directAttemptScope,
    workspaceID: session.workspaceId,
  })
  return Object.freeze({ ...processRef })
}

function sameProcessRef(left: HostProcessRefV1, right: HostProcessRefV1): boolean {
  return left.executionID === right.executionID && left.generation === right.generation &&
    left.ownerEpoch === right.ownerEpoch && left.kind === right.kind &&
    left.profileID === right.profileID && left.profileRevision === right.profileRevision &&
    left.profileDigest === right.profileDigest && left.executableDigest === right.executableDigest
}

function requireReplProcessLimits(status: EditorProcessStatusV1): void {
  const limits = status.resourceGuarantees
  if (
    !limits || limits.cpuTimeEnforced !== true || limits.memoryEnforced !== true ||
    limits.processCountEnforced !== true || limits.fileDescriptorsEnforced !== true
  ) {
    throw new UnavailableError({
      operation: "repl.execute",
      reason: "guard_not_verified",
      detail: "interpreter output requires HostKernel-confirmed CPU, memory, process-count, and file-descriptor enforcement",
    })
  }
}

export async function readSupervisedStatusV1(input: {
  readonly registry: Pick<Registry, "requireScopeOwned" | "markUnknownOwned" | "reconcileSettledOwned">
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly effectID: string
  readonly challengeID: string
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  const status = await readEditorProcessStatusV1({
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    scope: supervisedProcessScope(session),
    expectedProcessRef: processRef,
    requestHostKernel: input.requestHostKernel,
  })
  if (status.hostProcessRef && validateHostProcessRef(status.hostProcessRef).kind !== "interpreter") {
    throw new TypeError("HostKernel returned a non-interpreter execution for a REPL session")
  }
  if (status.state === "RUNNING" || status.state === "CANCELLING") requireReplProcessLimits(status)
  if (status.state === "UNKNOWN" || status.state === "CANCELLING") {
    input.registry.markUnknownOwned(input.ref, input.authority)
  }
  else if (status.state === "SETTLED") input.registry.reconcileSettledOwned(input.ref, input.authority)
  return status
}

export async function readSupervisedOutputV1(input: {
  readonly registry: Pick<Registry, "requireScopeOwned" | "markUnknownOwned" | "reconcileSettledOwned">
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly afterStdoutSequence: string
  readonly afterStderrSequence: string
  readonly maxBytes: number
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessOutputPageV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new TypeError("REPL output page byte limit must be a positive safe integer")
  }
  const status = await readEditorProcessStatusV1({
    executionID: processRef.executionID,
    effectID: input.effectID,
    challengeID: input.challengeID,
    scope: supervisedProcessScope(session),
    expectedProcessRef: processRef,
    requestHostKernel: input.requestHostKernel,
  })
  if (status.state === "UNKNOWN" || status.state === "CANCELLING") {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw new UnavailableError({
      operation: "repl.output_range",
      reason: "guard_not_verified",
      detail: "HostKernel reported an unknown or cancelling interpreter outcome; the generation is quarantined",
    })
  }
  requireReplProcessLimits(status)
  const page = await readEditorProcessOutputV1({
    processRef,
    effectID: input.effectID,
    challengeID: input.challengeID,
    capabilityLeaseDigest: input.capabilityLeaseDigest,
    scope: supervisedProcessScope(session),
    afterStdoutSequence: input.afterStdoutSequence,
    afterStderrSequence: input.afterStderrSequence,
    maxBytes: Math.min(input.maxBytes, session.resourceLimits.maxOutputBytes, HOST_KERNEL_REPL_MAX_OUTPUT_BYTES),
    requestHostKernel: input.requestHostKernel,
  })
  if (page.state === "UNKNOWN") input.registry.markUnknownOwned(input.ref, input.authority)
  else if (page.state === "SETTLED" && page.eof && page.receipt) {
    input.registry.reconcileSettledOwned(input.ref, input.authority)
  }
  return page
}

export async function cancelSupervisedV1(input: {
  readonly registry: Pick<Registry, "requireScopeOwned" | "markUnknownOwned" | "reconcileSettledOwned">
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityLeaseDigest: string
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<EditorProcessStatusV1> {
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  let status: EditorProcessStatusV1
  try {
    status = await cancelEditorProcessV1({
      processRef,
      effectID: input.effectID,
      challengeID: input.challengeID,
      capabilityLeaseDigest: input.capabilityLeaseDigest,
      scope: supervisedProcessScope(session),
      requestHostKernel: input.requestHostKernel,
    })
  } catch (error) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
  if (status.state === "UNKNOWN" || status.state === "CANCELLING") {
    input.registry.markUnknownOwned(input.ref, input.authority)
  } else {
    input.registry.reconcileSettledOwned(input.ref, input.authority)
  }
  return status
}

/** Execute or reset one retained interpreter through a fresh Guard lease and
 * the shared HostKernel receipt boundary. The constant-false runtime gates
 * make this adapter non-runnable until P1's Rust DTO/journal and DEC-V1-27 OS
 * limits pass integrated acceptance. */
export async function dispatchSupervisedReplOperationV1(input: {
  readonly registry: Registry
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly operation:
    | { readonly kind: "execute"; readonly request: ExecuteRequest }
    | { readonly kind: "reset"; readonly profileRef: ExecutionLaunchProfileRefV1 }
  readonly locationRef: typeof Location.Ref.Type
  readonly supervisor: Pick<SessionSupervisorInterface, "authorizeReplOperation">
  readonly runTrustedEffect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly requestHostKernel: RequestExecutionHostV1
  readonly nowMs?: number
}): Promise<{ readonly receipt: ExecutionReplOperationReceiptV1; readonly session: ReplSession }> {
  const capabilityID = input.operation.kind === "execute" ? "repl.execute" : "repl.reset"
  const session = input.registry.requireOwned(input.ref, input.authority)
  // Exact Location pin before the route gate, Guard challenge or HostKernel
  // sequence: a LocationRef for another workspace must never reach
  // authorization (REPL-002). The authenticated session's workspace is
  // authority; the caller's LocationRef is only ever a claim.
  if (input.locationRef.workspaceID !== session.workspaceId) {
    throw new TypeError("REPL operation location pin does not match the authenticated session workspace")
  }
  assertLanguageServiceProcessAllowed(capabilityID)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  const attempt = session.managedAttemptScope ?? session.directAttemptScope
  if (!attempt || (session.managedAttemptScope !== undefined) === (session.directAttemptScope !== undefined)) {
    throw new TypeError("REPL operation requires exactly one authenticated Attempt scope")
  }
  let nextRequest: unknown
  try {
    nextRequest = await input.requestHostKernel("execution.v1", "repl_next_sequence", {
      schemaVersion: 1,
      hostProcessRef: processRef,
      sessionID: session.sessionID,
      locationID: session.locationID,
      workspaceRevision: session.workspaceRevision,
      ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
      ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
    })
  } catch (error) {
    if (!isDefinitiveReplOperationFailure(error)) input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
  let requestSequence: string
  try {
    requestSequence = validateExecutionReplNextSequenceV1(nextRequest, processRef)
  } catch (error) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
  let operation: ExecutionReplOperationRequestV1["operation"]
  if (input.operation.kind === "execute") {
    const request = input.registry.validateExecuteRequestOwned(input.ref, input.authority, input.operation.request)
    if (request.deadlineMs > HOST_KERNEL_REPL_MAX_DEADLINE_MS) {
      throw new TypeError("HostKernel REPL operation deadline exceeds its 30 second bound")
    }
    operation = Object.freeze({
      kind: "execute",
      code: request.code,
      deadlineMs: request.deadlineMs,
      maxOutputBytes: Math.min(session.resourceLimits.maxOutputBytes, HOST_KERNEL_REPL_MAX_OUTPUT_BYTES),
    })
  } else {
    const profileRef = validateExecutionLaunchProfileRef(input.operation.profileRef)
    if (profileRef.profileId !== session.launchProfileRef.profileId ||
        profileRef.revision !== session.launchProfileRef.revision ||
        profileRef.profileDigest !== session.launchProfileRef.profileDigest) {
      throw new TypeError("REPL reset profile differs from the authenticated generation")
    }
    operation = Object.freeze({ kind: "reset", profileRef })
  }
  const subject = Object.freeze({
    hostProcessRef: processRef,
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    requestSequence,
    operation,
  })
  const lease = await input.runTrustedEffect(input.supervisor.authorizeReplOperation({
    locationRef: input.locationRef,
    capabilityID,
    sessionID: session.sessionID,
    arguments: subject,
    ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
    ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
  }))
  if (lease.capabilityID !== capabilityID || lease.locationID !== session.locationID ||
      lease.arguments.requestSequence !== requestSequence || lease.arguments.sessionID !== session.sessionID ||
      lease.arguments.locationID !== session.locationID || lease.arguments.workspaceRevision !== session.workspaceRevision ||
      !sameManagedAttemptScope(lease.managedAttempt, session.managedAttemptScope) ||
      !sameDirectAttemptScope(lease.directAttempt, session.directAttemptScope) ||
      lease.effectID.length === 0 || lease.challengeID.length === 0 ||
      !/^blake3:[0-9a-f]{64}$/.test(lease.capabilityLeaseDigest)) {
    throw new TypeError("SessionSupervisor returned a REPL lease outside the exact operation scope")
  }
  const request = validateExecutionReplOperationRequestV1({
    schemaVersion: 1,
    executionID: processRef.executionID,
    hostProcessRef: processRef,
    sessionID: session.sessionID,
    locationID: session.locationID,
    workspaceRevision: session.workspaceRevision,
    requestSequence,
    effectID: lease.effectID,
    challengeID: lease.challengeID,
    capabilityID,
    capabilityLeaseDigest: lease.capabilityLeaseDigest,
    ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
    ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
    operation,
  })
  let raw: unknown
  try {
    raw = await input.requestHostKernel("execution.v1", "repl_op", request as unknown as Readonly<Record<string, unknown>>)
  } catch (error) {
    if (!isDefinitiveReplOperationFailure(error)) {
      input.registry.markUnknownOwned(input.ref, input.authority)
    }
    throw error
  }
  let receipt: ExecutionReplOperationReceiptV1
  try {
    receipt = validateExecutionReplOperationReceiptV1(raw, request)
  } catch (error) {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw error
  }
  if (request.operation.kind === "execute") return Object.freeze({ receipt, session })

  const next = input.registry.resetOwned(input.ref, input.authority, input.nowMs ?? Date.now())
  const nextRef = { sessionID: next.sessionID, generation: next.generation }
  try {
    if (!receipt.replacementHostProcessRef) throw new ReplDispatchEnvelopeError("REPL reset receipt is missing the replacement process ref")
    input.registry.bindProcessRefOwned(nextRef, input.authority, receipt.replacementHostProcessRef)
    const active = input.registry.activateOwned(nextRef, input.authority, input.nowMs ?? Date.now())
    return Object.freeze({ receipt, session: active })
  } catch (error) {
    input.registry.markUnknownOwned(nextRef, input.authority)
    throw error
  }
}

const replCallbackReplyTails = new Map<string, Promise<void>>()

async function serializeReplCallbackReply<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = replCallbackReplyTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  replCallbackReplyTails.set(key, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (replCallbackReplyTails.get(key) === current) replCallbackReplyTails.delete(key)
  }
}

/** Commit a callback result only after the callback action has completed via
 * its canonical ActionDescriptor/Guard path. HostKernel verifies the supplied
 * effect decision/receipt pins and durably acknowledges the exact event slot;
 * Core never requests a second Guard lease for this continuation write. */
export async function completeSupervisedReplCallbackV1(input: {
  readonly registry: Pick<Registry, "requireOwned" | "requireCallbackCapability" | "acceptCallbackResult" | "markUnknownOwned">
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly invocation: ReplCallbackInvocationV1
  readonly result: unknown
  readonly settlement: GuardedReplCallbackSettlementV1
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<ExecutionReplCallbackReplyReceiptV1> {
  if (!HOST_KERNEL_REPL_CALLBACK_INGRESS_READY) {
    throw new ReplDispatchEnvelopeError("REPL callback replies are unavailable until HostKernel callback receipts pass acceptance")
  }
  const session = input.registry.requireOwned(input.ref, input.authority)
  if (!session.processRef) throw new TypeError("REPL generation has no HostKernel interpreter identity")
  const processRef = supervisedProcessRef(session, session.processRef)
  const invocation = input.invocation
  if (invocation.sessionID !== session.sessionID || invocation.locationID !== session.locationID ||
      invocation.workspaceRevision !== session.workspaceRevision || !sameProcessRef(invocation.hostProcessRef, processRef) ||
      invocation.executionID !== processRef.executionID || invocation.eventSequence.length > 20) {
    throw new ReplDispatchEnvelopeError("callback invocation differs from the authenticated REPL generation")
  }
  canonicalPositiveU64(invocation.eventSequence, "callback eventSequence")
  const callback = parseCallbackRequest(invocation.callback)
  if (callback.generation !== session.generation) {
    throw new ReplDispatchEnvelopeError("callback generation differs from the retained REPL generation")
  }
  input.registry.requireCallbackCapability(input.ref, input.authority, callback.capabilityID)
  const result = parseCallbackResult(input.result, { generation: callback.generation, callbackID: callback.callbackID })
  if (result.status === "unknown") {
    input.registry.markUnknownOwned(input.ref, input.authority)
    throw new ReplDispatchEnvelopeError("UNKNOWN callback outcomes quarantine the interpreter and are never replied to it")
  }
  const settlement = input.settlement
  for (const [field, value] of Object.entries({
    effectID: settlement.effectID,
    challengeID: settlement.challengeID,
    capabilityID: settlement.capabilityID,
  })) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
      throw new ReplDispatchEnvelopeError(`callback action ${field} is malformed`)
    }
  }
  if (settlement.capabilityID !== callback.capabilityID ||
      !/^blake3:[0-9a-f]{64}$/.test(settlement.effectReceiptDigest) ||
      (settlement.actionOutcome === "settled" && !/^blake3:[0-9a-f]{64}$/.test(settlement.capabilityLeaseDigest)) ||
      (result.status === "denied" && settlement.capabilityLeaseDigest !== undefined) ||
      (result.status === "denied" && settlement.actionOutcome !== "denied") ||
      (result.status !== "denied" && settlement.actionOutcome !== "settled")) {
    throw new ReplDispatchEnvelopeError("callback result lacks matching Guard/EffectHost settlement evidence")
  }
  const lockKey = `${processRef.executionID}:${processRef.generation}`
  return serializeReplCallbackReply(lockKey, async () => {
    let sequence: string
    try {
      const rawSequence = await input.requestHostKernel("execution.v1", "repl_next_sequence", {
        schemaVersion: 1,
        hostProcessRef: processRef,
        sessionID: session.sessionID,
        locationID: session.locationID,
        workspaceRevision: session.workspaceRevision,
        ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
        ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
      })
      sequence = validateExecutionReplNextSequenceV1(rawSequence, processRef)
    } catch (error) {
      input.registry.markUnknownOwned(input.ref, input.authority)
      throw error
    }
    if (result.status === "unknown") {
      throw new ReplDispatchEnvelopeError("an UNKNOWN callback outcome has no reply; quarantine the interpreter generation")
    }
    const resultForHost: ExecutionReplCallbackResultV1 = result.status === "ok"
      ? Object.freeze({
        generation: String(result.generation),
        callbackID: result.callbackID,
        status: "ok",
        result: result.result,
      })
      : Object.freeze({
        generation: String(result.generation),
        callbackID: result.callbackID,
        status: result.status,
        message: result.message!,
      })
    const unsignedRequest = Object.freeze({
      schemaVersion: 1,
      hostProcessRef: processRef,
      sessionID: session.sessionID,
      locationID: session.locationID,
      workspaceRevision: session.workspaceRevision,
      eventSequence: invocation.eventSequence,
      requestSequence: sequence,
      callbackID: callback.callbackID,
      capabilityID: settlement.capabilityID,
      effectID: settlement.effectID,
      challengeID: settlement.challengeID,
      ...(settlement.capabilityLeaseDigest === undefined ? {} : { capabilityLeaseDigest: settlement.capabilityLeaseDigest }),
      effectReceiptDigest: settlement.effectReceiptDigest,
      ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
      ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
      result: resultForHost,
    })
    const encoded = encodeCanonicalMessagePackV1(unsignedRequest, {
      maxEncodedBytes: 256 * 1024,
      maxDepth: 16,
      maxNodes: 4_096,
      maxCollectionItems: 4_096,
      maxScalarBytes: 64 * 1024,
    })
    const domain = new TextEncoder().encode("horizoncode.repl-callback-reply.v1\0")
    const digestInput = new Uint8Array(domain.length + encoded.length)
    digestInput.set(domain)
    digestInput.set(encoded, domain.length)
    const operationDigest = `blake3:${Array.from(blake3(digestInput), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const request: ExecutionReplCallbackReplyRequestV1 = Object.freeze({ ...unsignedRequest, operationDigest })
    let receipt: ExecutionReplCallbackReplyReceiptV1
    try {
      const rawReceipt = await input.requestHostKernel("execution.v1", "repl_callback_reply", request as unknown as Readonly<Record<string, unknown>>)
      receipt = validateExecutionReplCallbackReplyReceiptV1(rawReceipt, request)
    } catch (error) {
      input.registry.markUnknownOwned(input.ref, input.authority)
      throw error
    }
    try {
      input.registry.acceptCallbackResult(input.ref, input.authority, result)
    } catch (error) {
      input.registry.markUnknownOwned(input.ref, input.authority)
      throw error
    }
    return receipt
  })
}

/** Compose a persistent interpreter only through the shared HostKernel launch
 * and Guard approval owner. The HostKernel currently refuses this profile and
 * the shared Core launch gate is false; the explicit resource check remains
 * mandatory if those upstream gates later open. */
export async function createSupervisedReplV1(input: {
  readonly registry: Registry
  readonly ref: Ref
  readonly authority: ReplAuthorityBinding
  readonly language: ReplLanguage
  readonly locationRef: typeof Location.Ref.Type
  readonly supervisor: Pick<SessionSupervisorInterface, "resolveEditorProcessApproval">
  readonly runTrustedEffect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly requestHostKernel: RequestExecutionHostV1
}): Promise<{
  readonly session: ReplSession
  readonly status: EditorProcessStatusV1
  readonly stop: () => Promise<EditorProcessStatusV1>
}> {
  assertLanguageServiceProcessAllowed("repl.start")
  const session = input.registry.requireScopeOwned(input.ref, input.authority)
  if (session.language !== input.language) throw new TypeError("REPL language differs from its created generation")
  const attempt = session.managedAttemptScope ?? session.directAttemptScope
  if (!attempt || session.managedAttemptScope && session.directAttemptScope) {
    throw new TypeError("REPL launch requires exactly one authenticated Attempt scope")
  }
  const approval = await resolveTrustedReplLaunchProfileV1({
    language: input.language,
    scope: {
      locationID: session.locationID,
      sessionID: session.sessionID,
      userActionID: `repl_${randomUUID().replaceAll("-", "")}`,
      callID: `repl_${randomUUID().replaceAll("-", "")}`,
      ...(session.managedAttemptScope === undefined ? {} : { managedAttempt: session.managedAttemptScope }),
      ...(session.directAttemptScope === undefined ? {} : { directAttempt: session.directAttemptScope }),
    },
    requestHostKernel: input.requestHostKernel,
  })
  if (
    approval.profileRef.profileId !== session.launchProfileRef.profileId ||
    approval.profileRef.revision !== session.launchProfileRef.revision ||
    approval.profileRef.profileDigest !== session.launchProfileRef.profileDigest
  ) {
    throw new TypeError("HostKernel REPL profile differs from the profile pinned to the created generation")
  }
  const scope = supervisedProcessScope(session)
  const launch = await launchApprovedEditorProcessV1({
    approval,
    scope,
    resolveApproval: (request) => input.runTrustedEffect(input.supervisor.resolveEditorProcessApproval({
      locationRef: input.locationRef,
      challenge: {
        ...request.approval,
        approvalID: `approval_${randomUUID().replaceAll("-", "")}`,
      },
    })),
    requestHostKernel: input.requestHostKernel,
  })
  const limits = launch.resourceGuarantees
  if (
    limits.cpuTimeEnforced !== true || limits.memoryEnforced !== true ||
    limits.processCountEnforced !== true || limits.fileDescriptorsEnforced !== true
  ) {
    try {
      await cancelEditorProcessV1({
        processRef: launch.processRef,
        effectID: launch.lease.effectID,
        challengeID: launch.lease.challengeID,
        capabilityLeaseDigest: launch.lease.capabilityLeaseDigest,
        scope,
        requestHostKernel: input.requestHostKernel,
      })
    } catch (cancelError) {
      throw new AggregateError(
        [new Error("HostKernel launched an interpreter without the required OS resource limits"), cancelError],
        "REPL process was not safely admitted and its exact cancellation could not be confirmed",
      )
    }
    throw new UnavailableError({
      operation: "repl.start",
      reason: "guard_not_verified",
      detail: "HostKernel did not enforce CPU time, memory, process count, and file descriptors",
    })
  }
  let active: ReplSession
  try {
    input.registry.bindProcessRefOwned(input.ref, input.authority, launch.processRef)
    active = input.registry.activateOwned(input.ref, input.authority, Date.now())
  } catch (error) {
    try {
      await cancelEditorProcessV1({
        processRef: launch.processRef,
        effectID: launch.lease.effectID,
        challengeID: launch.lease.challengeID,
        capabilityLeaseDigest: launch.lease.capabilityLeaseDigest,
        scope,
        requestHostKernel: input.requestHostKernel,
      })
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "REPL session binding failed and the exact interpreter process could not be confirmed stopped",
      )
    }
    throw error
  }
  const stop = () => cancelSupervisedV1({
    registry: input.registry,
    ref: input.ref,
    authority: input.authority,
    effectID: launch.lease.effectID,
    challengeID: launch.lease.challengeID,
    capabilityLeaseDigest: launch.lease.capabilityLeaseDigest,
    requestHostKernel: input.requestHostKernel,
  })
  return Object.freeze({ session: active, status: launch.status, stop })
}

export function makeRegistry(): Registry {
  const generations = new Map<string, number>()
  const sessions = new Map<string, ReplSession>()
  const outputRefs = new Map<string, Set<string>>()
  const callbackRecords = new Map<string, Map<string, "pending" | "settled" | "unknown">>()
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

  const discardCallbackRecords = (sessionID: string, keepGeneration?: number) => {
    const prefix = `${sessionID}:`
    for (const key of callbackRecords.keys()) {
      if (!key.startsWith(prefix)) continue
      if (key === `${prefix}${keepGeneration}`) continue
      callbackRecords.delete(key)
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
      ...(session.processRef === undefined ? {} : { processRef: Object.freeze({ ...validateHostProcessRef(session.processRef) }) }),
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

  const quarantineGeneration = (session: ReplSession): ReplSession => {
    const quarantined = freezeSession({ ...session, state: "unknown" })
    sessions.set(session.sessionID, quarantined)
    discardOutputRefs(session.sessionID)
    const records = callbackRecords.get(generationKey(session.sessionID, session.generation))
    if (records) {
      for (const [callbackID, state] of records) {
        if (state === "pending") records.set(callbackID, "unknown")
      }
    }
    return quarantined
  }

  const resetSession = (ref: Ref, nowMs: number): ReplSession => {
    const session = transition(ref, "reset", ["created", "active", "crashed"], (current) => {
      const generation = (generations.get(current.sessionID) ?? current.generation) + 1
      generations.set(current.sessionID, generation)
      return {
        ...current,
        generation,
        sandboxGeneration: current.sandboxGeneration + 1,
        processRef: undefined,
        state: "created",
        createdAtMs: nowMs,
        lastActivityMs: nowMs,
      }
    })
    discardOutputRefs(ref.sessionID, session.generation)
    discardCallbackRecords(ref.sessionID, session.generation)
    return session
  }

  const validateExecuteRequest = (ref: Ref, request: ExecuteRequest): ExecuteRequest => {
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
      quarantineGeneration(session)
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
      quarantineGeneration(session)
    }
    if (validated.status === "cancelled") {
      // Cancellation says the request stopped producing normal output; it
      // does not prove the persistent interpreter process exited cleanly.
      quarantineGeneration(session)
    }
    return validated
  }

  const bindOutputRef = (ref: Ref, result: ExecuteResult): OutputRef | undefined => {
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
  }

  return {
    create(input) {
      assertExactAttemptLane(input.managedAttemptScope, input.directAttemptScope)
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
      // AgentProfileV2 authority is carried by the authenticated Attempt scope.
      // The interpreter's ExecutionLaunchProfile is a separate HostKernel pin.
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
      discardCallbackRecords(input.sessionID, generation)
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
    activateOwned(ref, authority, nowMs) {
      requireScope(ref, authority)
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
      const current = lookup(ref)
      const session = transition(ref, "cancel", ["created", "active"], (value) => ({ ...value, state: "unknown" }))
      discardOutputRefs(ref.sessionID)
      const records = callbackRecords.get(generationKey(ref.sessionID, current.generation))
      if (records) for (const [callbackID, state] of records) if (state === "pending") records.set(callbackID, "unknown")
      return session
    },
    expireIdle(nowMs) {
      const expired: Ref[] = []
      for (const session of sessions.values()) {
        if (session.state !== "created" && session.state !== "active") continue
        if (nowMs - session.lastActivityMs < session.idleTtlMs) continue
        sessions.set(session.sessionID, freezeSession({ ...session, state: "expired" }))
        discardOutputRefs(session.sessionID)
        discardCallbackRecords(session.sessionID)
        expired.push({ sessionID: session.sessionID, generation: session.generation })
      }
      return expired
    },
    crash(ref) {
      const session = transition(ref, "crash", ["created", "active"], (current) => ({ ...current, state: "crashed" }))
      discardCallbackRecords(ref.sessionID)
      discardOutputRefs(ref.sessionID)
      return session
    },
    crashOwned(ref, authority) {
      requireScope(ref, authority)
      const session = transition(ref, "crash", ["created", "active"], (current) => ({ ...current, state: "crashed" }))
      discardCallbackRecords(ref.sessionID)
      discardOutputRefs(ref.sessionID)
      return session
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
      discardCallbackRecords(ref.sessionID)
      return session
    },
    stopOwned(ref, authority) {
      requireScope(ref, authority)
      const session = transition(ref, "stop", ["created", "active", "crashed", "expired"], (current) => ({
        ...current,
        state: "stopped",
      }))
      discardOutputRefs(ref.sessionID)
      discardCallbackRecords(ref.sessionID)
      return session
    },
    reconcileSettledOwned(ref, authority) {
      requireScope(ref, authority)
      return transition(ref, "reconcile_settled", ["created", "active", "crashed", "expired", "unknown"], (current) => ({
        ...current,
        state: "stopped",
      }))
    },
    markUnknownOwned(ref, authority) {
      const current = requireScope(ref, authority)
      if (current.state === "unknown") return current
      if (current.state === "stopped" || current.state === "cancelled") {
        throw new TransitionError({
          sessionID: ref.sessionID,
          generation: ref.generation,
          state: current.state,
          action: "markUnknown",
        })
      }
      return quarantineGeneration(current)
    },
    requireOwned(ref, authority) {
      return requireOwned(ref, authority)
    },
    requireScopeOwned(ref, authority) {
      return requireScope(ref, authority)
    },
    bindProcessRefOwned(ref, authority, input) {
      const current = requireScope(ref, authority)
      const processRef = supervisedProcessRef(current, input)
      if (current.processRef) {
        if (sameProcessRef(current.processRef, processRef)) return current
        throw new TransitionError({
          sessionID: ref.sessionID,
          generation: ref.generation,
          state: current.state,
          action: "replace_interpreter_process",
        })
      }
      if (current.state !== "created") {
        throw new TransitionError({
          sessionID: ref.sessionID,
          generation: ref.generation,
          state: current.state,
          action: "bind_interpreter_process",
        })
      }
      const updated = freezeSession({ ...current, processRef })
      sessions.set(ref.sessionID, updated)
      return updated
    },
    requireCallbackCapability(ref, authority, capabilityID) {
      const session = requireOwned(ref, authority)
      if (!session.callbackCapabilities.includes(capabilityID)) {
        throw new CallbackCapabilityDeniedError({ reason: "not_declared" })
      }
      return session
    },
    admitCallback(ref, authority, input) {
      const request = parseCallbackRequest(input)
      if (request.generation !== ref.generation) {
        throw new StaleRefError({ sessionID: ref.sessionID, generation: request.generation, reason: "generation_replaced", current: ref.generation })
      }
      const session = requireOwned(ref, authority)
      if (!session.callbackCapabilities.includes(request.capabilityID)) {
        throw new CallbackCapabilityDeniedError({ reason: "not_declared" })
      }
      const key = generationKey(session.sessionID, session.generation)
      let records = callbackRecords.get(key)
      if (!records) {
        records = new Map()
        callbackRecords.set(key, records)
      }
      if (records.has(request.callbackID)) throw new CallbackAdmissionError({ reason: "duplicate" })
      if (records.size >= MAX_CALLBACKS_PER_GENERATION) throw new CallbackAdmissionError({ reason: "generation_limit" })
      let inFlight = 0
      for (const state of records.values()) if (state === "pending") inFlight += 1
      if (inFlight >= MAX_CALLBACKS_IN_FLIGHT) throw new CallbackAdmissionError({ reason: "too_many_in_flight" })
      records.set(request.callbackID, "pending")
      return request
    },
    acceptCallbackResult(ref, authority, input) {
      const session = requireOwned(ref, authority)
      const key = generationKey(session.sessionID, session.generation)
      const records = callbackRecords.get(key)
      const callbackID = typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).callbackID
        : undefined
      if (typeof callbackID !== "string" || records?.get(callbackID) !== "pending") {
        throw new CallbackAdmissionError({ reason: "not_pending" })
      }
      const result = parseCallbackResult(input, { generation: session.generation, callbackID })
      if (result.status === "unknown") {
        records.set(callbackID, "unknown")
        quarantineGeneration(session)
      } else {
        records.set(callbackID, "settled")
      }
      return result
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
    validateExecuteRequest,
    validateExecuteRequestOwned(ref, authority, request) {
      requireOwned(ref, authority)
      return validateExecuteRequest(ref, request)
    },
    acceptResult,
    acceptResultOwned(ref, authority, result) {
      requireOwned(ref, authority)
      return acceptResult(ref, result)
    },
    bindOutputRef,
    bindOutputRefOwned(ref, authority, result) {
      requireOwned(ref, authority)
      return bindOutputRef(ref, result)
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
