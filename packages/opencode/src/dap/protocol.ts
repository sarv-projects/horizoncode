import { Schema } from "effect"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  validateHostProcessRef,
  validateHostProcessScope,
  type HostProcessRefV1,
} from "@/lsp/process-scope"
import { assertHostProtocolAllowed } from "@/lsp/launch"
import { guardActionID, operationForCommand } from "./session"
import {
  ProtocolDispatchUncertainError,
  validateDispatchReceiptV1,
  type HostProtocolDispatchReceiptV1,
} from "@/lsp/protocol"

/**
 * Debug Adapter Protocol (DAP) message parsing/validation — non-effectful
 * preparation for `DebugAdapterBrokerV1` (§37.7, §32.28).
 *
 * This module only parses, validates and classifies protocol messages and
 * frames. It must never spawn a debug adapter, download/install one, send a
 * `runInTerminal` command or evaluate anything; those are effects and remain
 * UNAVAILABLE until the Rust Guard/ExecutionHost mediation for this origin is
 * implemented and verified (see `./session`).
 *
 * The legacy frame codec below is kept only as a bounded parser/fixture utility. Production
 * DAP traffic must use `HostDapProtocolAdapter` and typed HostKernel operations/events; Core
 * must not own adapter stdio, encode frames for a child process, or accept raw process bytes.
 */

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_HEADER_BYTES = 8 * 1024

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("DAPProtocolError", {
  detail: Schema.String,
}) {}

/** A host page can be validly framed yet unusable for the current projection.
 * Callers must discard the partial projection and request a fresh session
 * snapshot; they must never skip the missing cursor or replace the process. */
export class ResnapshotRequiredError extends Schema.TaggedErrorClass<ResnapshotRequiredError>()(
  "DAPResnapshotRequiredError",
  {
    reason: Schema.Literals(["stale_process", "stale_workspace", "cursor_gap", "unknown_process"]),
  },
) {}

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Request = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("request"),
  command: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPRequestV1" })
export type Request = typeof Request.Type

export const Response = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("response"),
  request_seq: Seq,
  success: Schema.Boolean,
  command: Schema.String,
  message: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPResponseV1" })
export type Response = typeof Response.Type

export const Event = Schema.Struct({
  seq: Seq,
  type: Schema.Literal("event"),
  event: Schema.String,
  body: Schema.optional(Schema.Unknown),
}).annotate({ identifier: "DAPEventV1" })
export type Event = typeof Event.Type

export const Envelope = Schema.Union([Request, Response, Event]).annotate({ identifier: "DAPEnvelopeV1" })
export type Envelope = typeof Envelope.Type

/** HostKernel DAP commands use typed values over execution.v1, never Content-Length bytes. */
export const HostCommand = Schema.Literals([
  "initialize",
  "configurationDone",
  "attach",
  "setBreakpoints",
  "setFunctionBreakpoints",
  "setExceptionBreakpoints",
  "continue",
  "pause",
  "next",
  "stepIn",
  "stepOut",
  "threads",
  "stackTrace",
  "scopes",
  "evaluate",
  "disconnect",
  "terminate",
])
export type HostCommand = typeof HostCommand.Type

export type HostOperationRequestV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly effectID: string
  readonly challengeID: string
  readonly capabilityID: string
  readonly capabilityLeaseDigest: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly operation: {
    readonly requestSequence: string
    readonly requestID: number
    readonly command: HostCommand
    readonly arguments: Readonly<Record<string, unknown>>
  }
}

export const HostEventName = Schema.Literals([
  "initialized",
  "stopped",
  "continued",
  "exited",
  "terminated",
  "thread",
  "output",
  "breakpoint",
  "module",
  "loadedSource",
  "process",
  "capabilities",
  "progressStart",
  "progressUpdate",
  "progressEnd",
  "invalidated",
])
export type HostEventName = typeof HostEventName.Type

export type HostEventV1 =
  | {
      readonly protocol: "dap"
      readonly messageKind: "event"
      readonly payload: {
        readonly eventSequence: string
        readonly dapSequence: string
        readonly event: HostEventName
        readonly body?: unknown
      }
    }
  | {
      readonly protocol: "dap"
      readonly messageKind: "response"
      readonly payload: {
        readonly schemaVersion: 1
        readonly eventSequence: string
        readonly requestSequence: string
        readonly requestID: number
        readonly command: HostCommand
        readonly success: boolean
        readonly body?: unknown
        readonly message?: string
      }
    }

export type HostEventPageV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly afterEventSequence: string
  readonly processIOSequence: string
  readonly workspaceRevision: string
  readonly status: "RUNNING" | "EXITED" | "UNKNOWN"
  readonly events: readonly HostEventV1[]
}

export type HostDapEventReadRequestV1 = {
  readonly hostProcessRef: HostProcessRefV1
  readonly sessionID: string
  readonly locationID: string
  readonly workspaceRevision: string
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly directAttempt?: DirectAttemptScopeV1
  readonly afterEventSequence: string
  readonly maxEvents: 64
  readonly maxBytes: 1048576
}

export interface HostDapProtocolAdapter {
  /** Resolves only after HostKernel has durably receipted dispatch. The DAP
   * response itself arrives later through protocolRead's retained event page. */
  protocolOp(request: HostOperationRequestV1): Promise<HostProtocolDispatchReceiptV1>
  protocolRead(request: HostDapEventReadRequestV1): Promise<HostEventPageV1>
}

/** Narrow adapter for the existing SessionSupervisor authenticated HostKernel RPC. */
export type ExecutionHostProtocolRequestV1 = (
  serviceID: "execution.v1",
  operation: "protocol_op" | "protocol_read",
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>

export function validateHostDapEventReadRequestV1(input: unknown): HostDapEventReadRequestV1 {
  if (!isRecord(input) || !hasExactKeys(input, [
    "hostProcessRef", "sessionID", "locationID", "workspaceRevision", "afterEventSequence", "maxEvents", "maxBytes",
  ], ["managedAttempt", "directAttempt"]) ||
    (input.managedAttempt !== undefined && input.directAttempt !== undefined)) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP event read request" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(input.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel DAP event read process reference" })
  }
  if (processRef.kind !== "debug_adapter" ||
    typeof input.sessionID !== "string" || !input.sessionID || input.sessionID.length > 160 ||
    typeof input.locationID !== "string" || !input.locationID || input.locationID.length > 160 ||
    typeof input.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(input.workspaceRevision) ||
    !isCanonicalU64(input.afterEventSequence) ||
    input.maxEvents !== 64 || input.maxBytes !== MAX_FRAME_BYTES) {
    throw new ProtocolError({ detail: "invalid HostKernel DAP event read fields" })
  }
  try {
    validateHostProcessScope({
      sessionID: input.sessionID,
      locationID: input.locationID,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: input.workspaceRevision,
      managedAttemptScope: input.managedAttempt as ManagedAttemptScopeV1 | undefined,
      directAttemptScope: input.directAttempt as DirectAttemptScopeV1 | undefined,
      workspaceID: (input.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "DAP event read Attempt scope does not match its process reference" })
  }
  return Object.freeze({
    hostProcessRef: Object.freeze({ ...processRef }),
    sessionID: input.sessionID,
    locationID: input.locationID,
    workspaceRevision: input.workspaceRevision,
    afterEventSequence: input.afterEventSequence,
    maxEvents: 64 as const,
    maxBytes: MAX_FRAME_BYTES as 1048576,
    ...(input.managedAttempt === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(input.managedAttempt as ManagedAttemptScopeV1) }),
    ...(input.directAttempt === undefined ? {} : { directAttempt: freezeDirectAttemptScope(input.directAttempt as DirectAttemptScopeV1) }),
  })
}

/**
 * Bind DAP's strict DTOs to the shared HostKernel execution dispatcher. The
 * returned adapter does not own a process or retry uncertain dispatches.
 */
export function createHostKernelDapProtocolAdapterV1(requestHostKernel: ExecutionHostProtocolRequestV1): HostDapProtocolAdapter {
  return Object.freeze({
    protocolOp: async (input: HostOperationRequestV1) => {
      assertHostProtocolAllowed()
      const request = validateHostOperationRequestV1(input)
      const response = await requestHostKernel("execution.v1", "protocol_op", request)
      try {
        return validateHostDapDispatchReceiptV1(request, response)
      } catch {
        throw new ProtocolDispatchUncertainError({ operation: request.operation.command })
      }
    },
    protocolRead: async (request) => {
      assertHostProtocolAllowed()
      const validated = validateHostDapEventReadRequestV1(request)
      const response = await requestHostKernel("execution.v1", "protocol_read", validated)
      return validateHostEventPageV1(validated, response)
    },
  })
}

/** Bind a DAP dispatch acknowledgement to the exact adapter generation and
 * shared outbound process sequence submitted by Core. */
export function validateHostDapDispatchReceiptV1(
  request: HostOperationRequestV1,
  input: unknown,
): HostProtocolDispatchReceiptV1 {
  if (request.hostProcessRef.kind !== "debug_adapter") {
    throw new ProtocolError({ detail: "DAP dispatch requires a debug adapter process" })
  }
  if (!isCanonicalU64(request.operation.requestSequence, false)) {
    throw new ProtocolError({ detail: "invalid DAP dispatch request sequence" })
  }
  return validateDispatchReceiptV1(request.hostProcessRef, request.operation.requestSequence, input)
}

/** Safe typed adapter helper: admit only the exact DAP request shape and expose
 * success only after the HostKernel dispatch receipt matches its sequence/ref. */
export async function dispatchHostDapOperationV1(
  input: unknown,
  dispatch: (request: HostOperationRequestV1) => Promise<unknown>,
): Promise<HostProtocolDispatchReceiptV1> {
  assertHostProtocolAllowed()
  const request = validateHostOperationRequestV1(input)
  const receipt = await dispatch(request)
  return validateHostDapDispatchReceiptV1(request, receipt)
}

const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/
const MAX_U64 = 18_446_744_073_709_551_615n

function isCanonicalU64(value: unknown, allowZero = true): value is string {
  if (typeof value !== "string" || !DECIMAL_U64.test(value)) return false
  try {
    const parsed = BigInt(value)
    return parsed <= MAX_U64 && (allowZero || parsed > 0n)
  } catch {
    return false
  }
}

function assertBoundedJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): void {
  budget.nodes++
  if (budget.nodes > 16_384 || depth > 24) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (value.includes("\0")) throw new ProtocolError({ detail: "DAP operation payload contains an invalid string" })
    if (value.length > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
    budget.bytes += encoder.encode(value).byteLength
    if (budget.bytes > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProtocolError({ detail: "DAP operation payload is not JSON" })
    budget.bytes += 16
    if (budget.bytes > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
    return
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some((key) => {
      if (key === "length") return false
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true
      const index = Number(key)
      return !Number.isSafeInteger(index) || index >= value.length
    })) throw new ProtocolError({ detail: "DAP operation payload is not plain JSON" })
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new ProtocolError({ detail: "DAP operation payload is not plain JSON" })
      }
      assertBoundedJson(descriptor.value, depth + 1, budget)
    }
    return
  }
  if (typeof value !== "object") throw new ProtocolError({ detail: "DAP operation payload is not JSON" })
  if (!isPlainDataRecord(value)) {
    throw new ProtocolError({ detail: "DAP operation payload is not a plain JSON object" })
  }
  for (const key of Object.keys(value)) {
    if (key.includes("\0")) throw new ProtocolError({ detail: "DAP operation payload contains an invalid field" })
    if (key.length > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
    budget.bytes += encoder.encode(key).byteLength
    if (budget.bytes > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
    assertBoundedJson(value[key], depth + 1, budget)
  }
}

/** Validate the method-tagged private HostKernel request before adapter dispatch. */
export function validateHostOperationRequestV1(input: unknown): HostOperationRequestV1 {
  if (!isPlainDataRecord(input)) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP operation" })
  }
  const record = input as Record<string, unknown>
  const required = [
    "hostProcessRef",
    "sessionID",
    "locationID",
    "workspaceRevision",
    "effectID",
    "challengeID",
    "capabilityID",
    "capabilityLeaseDigest",
    "operation",
  ]
  const allowed = new Set([...required, "managedAttempt", "directAttempt"])
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    (record.managedAttempt !== undefined && record.directAttempt !== undefined)
  ) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP operation" })
  }
  if (!isPlainDataRecord(record.operation)) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP operation payload" })
  }
  const operation = record.operation as Record<string, unknown>
  if (!hasExactKeys(operation, ["requestSequence", "requestID", "command", "arguments"])) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP operation payload" })
  }
  let hostProcessRef: HostProcessRefV1
  try {
    hostProcessRef = validateHostProcessRef(record.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel DAP process reference" })
  }
  if (hostProcessRef.kind !== "debug_adapter") {
    throw new ProtocolError({ detail: "DAP operation requires a debug adapter process" })
  }
  if (
    typeof record.sessionID !== "string" || !record.sessionID || record.sessionID.length > 160 ||
    typeof record.locationID !== "string" || !record.locationID || record.locationID.length > 160 ||
    typeof record.workspaceRevision !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(record.workspaceRevision) ||
    typeof record.effectID !== "string" || !record.effectID || record.effectID.length > 160 || record.effectID.trim() !== record.effectID ||
    typeof record.challengeID !== "string" || !record.challengeID || record.challengeID.length > 160 || record.challengeID.trim() !== record.challengeID ||
    typeof record.capabilityID !== "string" || !record.capabilityID || record.capabilityID.length > 160 || record.capabilityID.trim() !== record.capabilityID ||
    typeof record.capabilityLeaseDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(record.capabilityLeaseDigest) ||
    !isCanonicalU64(operation.requestSequence, false) ||
    typeof operation.requestID !== "number" || !Number.isSafeInteger(operation.requestID) || operation.requestID <= 0 ||
    typeof operation.command !== "string" ||
    !Schema.is(HostCommand)(operation.command)
  ) {
    throw new ProtocolError({ detail: "invalid HostKernel DAP operation fields" })
  }
  const classified = operationForCommand(operation.command as string)
  const expectedCapability = classified && guardActionID(classified)
  // A typed evaluate operation may reach HostKernel only after the trusted
  // launch profile and a fresh debug.evaluate Guard lease authorize it.
  // Attach carries only a HostKernel-minted terminal target ref.
  if (!classified || !expectedCapability || record.capabilityID !== expectedCapability) {
    throw new ProtocolError({ detail: "DAP command is unavailable or its canonical Guard capability does not match" })
  }
  try {
    validateHostProcessScope({
      sessionID: record.sessionID as string,
      locationID: record.locationID as string,
      ownerEpoch: hostProcessRef.ownerEpoch,
      workspaceRevision: record.workspaceRevision as string,
      managedAttemptScope: record.managedAttempt as ManagedAttemptScopeV1 | undefined,
      directAttemptScope: record.directAttempt as DirectAttemptScopeV1 | undefined,
      workspaceID: (record.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "DAP operation Attempt scope does not match its authenticated process scope" })
  }
  if (typeof operation.arguments !== "object" || operation.arguments === null || Array.isArray(operation.arguments)) {
    throw new ProtocolError({ detail: "DAP operation arguments must be an object" })
  }
  assertBoundedJson(operation.arguments)
  validateCommandArguments(operation.command as HostCommand, operation.arguments as Record<string, unknown>)
  if (operation.command === "attach") {
    const args = operation.arguments as Record<string, unknown>
    try {
      const target = validateHostProcessRef(args.targetHostProcessRef)
      if (target.kind !== "terminal_run" || target.ownerEpoch !== hostProcessRef.ownerEpoch) throw new Error("scope mismatch")
      validateHostProcessScope({
        sessionID: record.sessionID as string,
        locationID: record.locationID as string,
        ownerEpoch: target.ownerEpoch,
        workspaceRevision: record.workspaceRevision as string,
        managedAttemptScope: record.managedAttempt as ManagedAttemptScopeV1 | undefined,
        directAttemptScope: record.directAttempt as DirectAttemptScopeV1 | undefined,
        workspaceID: (record.directAttempt as DirectAttemptScopeV1 | undefined)?.workspaceID,
      })
    } catch {
      throw new ProtocolError({ detail: "DAP attach requires a same-scope HostKernel terminal target" })
    }
  }
  const encoded = encoder.encode(JSON.stringify(operation.arguments))
  if (encoded.byteLength > MAX_FRAME_BYTES) throw new ProtocolError({ detail: "DAP operation payload exceeds bounds" })
  return Object.freeze({
    hostProcessRef: Object.freeze({ ...hostProcessRef }),
    sessionID: record.sessionID,
    locationID: record.locationID,
    workspaceRevision: record.workspaceRevision,
    effectID: record.effectID,
    challengeID: record.challengeID,
    capabilityID: record.capabilityID,
    capabilityLeaseDigest: record.capabilityLeaseDigest,
    ...(record.managedAttempt === undefined ? {} : { managedAttempt: freezeManagedAttemptScope(record.managedAttempt as ManagedAttemptScopeV1) }),
    ...(record.directAttempt === undefined ? {} : { directAttempt: freezeDirectAttemptScope(record.directAttempt as DirectAttemptScopeV1) }),
    operation: Object.freeze({
      requestSequence: operation.requestSequence as string,
      requestID: operation.requestID as number,
      command: operation.command as HostCommand,
      arguments: freezeProtocolJson(operation.arguments) as Record<string, unknown>,
    }),
  })
}

function sameHostProcessRef(left: HostProcessRefV1, right: HostProcessRefV1): boolean {
  return (
    left.executionID === right.executionID &&
    left.generation === right.generation &&
    left.ownerEpoch === right.ownerEpoch &&
    left.kind === right.kind &&
    left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision &&
    left.profileDigest === right.profileDigest &&
    left.executableDigest === right.executableDigest
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false
  }
  return true
}

function freezeProtocolJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeProtocolJson))
  if (!isRecord(value)) return value
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeProtocolJson(item)])))
}

function exactArgumentKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isPlainDataRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function validExceptionOption(value: unknown): boolean {
  if (!exactArgumentKeys(value, ["path", "breakMode"]) || !Array.isArray(value.path) || value.path.length > 128 ||
    !["never", "always", "unhandled", "userUnhandled"].includes(String(value.breakMode))) return false
  return value.path.every((segment) => {
    if (!exactArgumentKeys(segment, ["names"], ["negate"]) || !Array.isArray(segment.names) || segment.names.length > 128) return false
    return (segment.negate === undefined || typeof segment.negate === "boolean") &&
      segment.names.every((name) => typeof name === "string" && encoder.encode(name).byteLength <= 512 && !name.includes("\0"))
  })
}

function validateCommandArguments(command: HostCommand, args: Record<string, unknown>): void {
  const reject = (): never => { throw new ProtocolError({ detail: `invalid DAP ${command} arguments` }) }
  const id = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
  const str = (value: unknown, max = 16 * 1024) => typeof value === "string" && encoder.encode(value).byteLength <= max && !value.includes("\0")
  const optionalBool = (key: string) => args[key] === undefined || typeof args[key] === "boolean"
  const optionalText = (record: Record<string, unknown>, key: string) => record[key] === undefined || str(record[key])
  switch (command) {
    case "initialize": {
      const known = ["clientID", "adapterID", "locale", "linesStartAt1", "columnsStartAt1", "pathFormat", "supportsVariableType", "supportsVariablePaging", "supportsRunInTerminalRequest", "supportsMemoryReferences", "supportsProgressReporting", "supportsInvalidatedEvent", "supportsMemoryEvent", "supportsStartDebuggingRequest", "supportsANSIStyling"]
      if (!exactArgumentKeys(args, [], known)) reject()
      for (const key of known) {
        const value = args[key]
        if (value === undefined) continue
        if (["linesStartAt1", "columnsStartAt1", "supportsVariableType", "supportsVariablePaging", "supportsRunInTerminalRequest", "supportsMemoryReferences", "supportsProgressReporting", "supportsInvalidatedEvent", "supportsMemoryEvent", "supportsStartDebuggingRequest", "supportsANSIStyling"].includes(key)) {
          if (typeof value !== "boolean") reject()
        } else if (key === "pathFormat" ? value !== "path" && value !== "uri" : !str(value, 256)) reject()
      }
      return
    }
    case "configurationDone":
    case "threads":
      if (Object.keys(args).length) reject()
      return
    case "attach":
      if (!exactArgumentKeys(args, ["targetHostProcessRef"])) reject()
      try {
        if (validateHostProcessRef(args.targetHostProcessRef).kind !== "terminal_run") reject()
      } catch {
        reject()
      }
      return
    case "setBreakpoints":
      if (!exactArgumentKeys(args, ["source"], ["breakpoints", "sourceModified"]) ||
        !exactArgumentKeys(args.source, ["name", "path"]) || !str(args.source.name, 4096) || !str(args.source.path) ||
        !optionalBool("sourceModified") || (args.breakpoints !== undefined && (!Array.isArray(args.breakpoints) || args.breakpoints.length > 2048 || args.breakpoints.some((bp) =>
          !exactArgumentKeys(bp, ["line"], ["column", "condition", "hitCondition", "logMessage"]) || !id(bp.line) ||
          (bp.column !== undefined && !id(bp.column)) || !optionalText(bp, "condition") || !optionalText(bp, "hitCondition") || !optionalText(bp, "logMessage")))) reject()
      return
    case "setFunctionBreakpoints":
      if (!exactArgumentKeys(args, ["breakpoints"]) || !Array.isArray(args.breakpoints) || args.breakpoints.length > 512 || args.breakpoints.some((bp) =>
        !exactArgumentKeys(bp, ["name"], ["condition"]) || !str(bp.name, 4096) || !optionalText(bp, "condition"))) reject()
      return
    case "setExceptionBreakpoints":
      if (!exactArgumentKeys(args, ["filters"], ["filterOptions", "exceptionOptions"]) || !Array.isArray(args.filters) || args.filters.length > 256 || args.filters.some((x) => !str(x, 512)) ||
        (args.filterOptions !== undefined && (!Array.isArray(args.filterOptions) || args.filterOptions.length > 256 || args.filterOptions.some((item) =>
          !exactArgumentKeys(item, ["filterId"], ["condition"]) || !str(item.filterId, 512) || !optionalText(item, "condition")))) ||
        (args.exceptionOptions !== undefined && (!Array.isArray(args.exceptionOptions) || args.exceptionOptions.length > 256 || args.exceptionOptions.some((option) => !validExceptionOption(option)))) reject()
      return
    case "continue":
    case "next":
    case "stepIn":
    case "stepOut":
      if (!exactArgumentKeys(args, ["threadId"], ["singleThread", "granularity"]) || !id(args.threadId) || !optionalBool("singleThread") ||
        (args.granularity !== undefined && !["statement", "line", "instruction"].includes(String(args.granularity)))) reject()
      return
    case "pause":
      if (!exactArgumentKeys(args, ["threadId"]) || !id(args.threadId)) reject()
      return
    case "stackTrace":
      if (!exactArgumentKeys(args, ["threadId"], ["startFrame", "levels", "format"]) || !id(args.threadId) ||
        (args.startFrame !== undefined && (!Number.isSafeInteger(args.startFrame) || Number(args.startFrame) < 0)) ||
        (args.levels !== undefined && (!Number.isSafeInteger(args.levels) || Number(args.levels) < 0 || Number(args.levels) > 10000)) ||
        (args.format !== undefined && (!exactArgumentKeys(args.format, [], ["parameters", "parameterNames", "parameterTypes", "parameterValues", "line", "module", "includeAll"]) || Object.values(args.format).some((x) => typeof x !== "boolean")))) reject()
      return
    case "scopes":
      if (!exactArgumentKeys(args, ["frameId"]) || !id(args.frameId)) reject()
      return
    case "evaluate":
      if (!exactArgumentKeys(args, ["expression", "deadlineMs", "maxOutputBytes"], ["frameID", "context"]) ||
        !str(args.expression, 16 * 1024) ||
        (args.frameID !== undefined && !id(args.frameID)) ||
        (args.context !== undefined && !["watch", "repl", "hover", "clipboard"].includes(String(args.context))) ||
        !Number.isSafeInteger(args.deadlineMs) || Number(args.deadlineMs) < 1 || Number(args.deadlineMs) > 30_000 ||
        !Number.isSafeInteger(args.maxOutputBytes) || Number(args.maxOutputBytes) < 1 || Number(args.maxOutputBytes) > 64 * 1024) reject()
      return
    case "disconnect":
    case "terminate":
      if (!exactArgumentKeys(args, [], ["restart", "terminateDebuggee", "suspendDebuggee"]) ||
        !optionalBool("restart") || !optionalBool("terminateDebuggee") || !optionalBool("suspendDebuggee")) reject()
      return
  }
}

/** Bound and classify a DAP request before Core opens a Guard approval.
 * Evaluate additionally requires the trusted launch profile's retained policy;
 * the lease-bearing HostKernel envelope is validated again after approval. */
export function validateDapAuthorizationArgumentsV1(
  command: string,
  input: unknown,
  dapPolicy?: { readonly allowEvaluate: boolean },
): Readonly<Record<string, unknown>> {
  if (!Schema.is(HostCommand)(command) || !operationForCommand(command) ||
    (command === "evaluate" && dapPolicy?.allowEvaluate !== true)) {
    throw new ProtocolError({ detail: "DAP command is unavailable for Guard authorization" })
  }
  if (!isPlainDataRecord(input)) throw new ProtocolError({ detail: "DAP arguments must be a plain JSON object" })
  assertBoundedJson(input)
  validateCommandArguments(command, input)
  return freezeProtocolJson(input) as Readonly<Record<string, unknown>>
}

/** Check bounded event pages and strict cursor/process/workspace fencing. */
export function validateHostEventPageV1(
  request: {
    readonly hostProcessRef: HostProcessRefV1
    readonly sessionID: string
    readonly locationID: string
    readonly workspaceRevision: string
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly directAttempt?: DirectAttemptScopeV1
    readonly afterEventSequence: string
    readonly maxEvents: number
    readonly maxBytes: number
  },
  input: unknown,
): HostEventPageV1 {
  if (!isRecord(input) || !Array.isArray(input.events)) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP event page" })
  }
  if (
    !hasExactKeys(input, ["hostProcessRef", "afterEventSequence", "processIOSequence", "workspaceRevision", "status", "events"])
  ) {
    throw new ProtocolError({ detail: "malformed HostKernel DAP event page" })
  }
  let processRef: HostProcessRefV1
  try {
    processRef = validateHostProcessRef(input.hostProcessRef)
  } catch {
    throw new ProtocolError({ detail: "invalid HostKernel DAP event process reference" })
  }
  if (processRef.kind !== "debug_adapter") {
    throw new ProtocolError({ detail: "DAP event page requires a debug adapter process" })
  }
  if (
    !isCanonicalU64(request.afterEventSequence) ||
    typeof request.sessionID !== "string" || !request.sessionID || request.sessionID.length > 160 ||
    typeof request.locationID !== "string" || !request.locationID || request.locationID.length > 160 ||
    typeof request.workspaceRevision !== "string" || !/^blake3:[0-9a-f]{64}$/.test(request.workspaceRevision) ||
    !sameHostProcessRef(request.hostProcessRef, processRef) ||
    !Number.isSafeInteger(request.maxEvents) ||
    request.maxEvents < 1 || request.maxEvents > 64 ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 || request.maxBytes > MAX_FRAME_BYTES ||
    input.workspaceRevision !== request.workspaceRevision ||
    input.afterEventSequence !== request.afterEventSequence ||
    !isCanonicalU64(input.processIOSequence) ||
    !["RUNNING", "EXITED", "UNKNOWN"].includes(String(input.status)) ||
    input.events.length > request.maxEvents
  ) {
    if (!sameHostProcessRef(request.hostProcessRef, processRef)) {
      throw new ResnapshotRequiredError({ reason: "stale_process" })
    }
    if (input.workspaceRevision !== request.workspaceRevision) {
      throw new ResnapshotRequiredError({ reason: "stale_workspace" })
    }
    if (input.afterEventSequence !== request.afterEventSequence) {
      throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    }
    throw new ProtocolError({ detail: "invalid or over-limit HostKernel DAP event page" })
  }
  try {
    validateHostProcessScope({
      sessionID: request.sessionID,
      locationID: request.locationID,
      ownerEpoch: processRef.ownerEpoch,
      workspaceRevision: request.workspaceRevision,
      managedAttemptScope: request.managedAttempt,
      directAttemptScope: request.directAttempt,
      workspaceID: request.directAttempt?.workspaceID,
    })
  } catch {
    throw new ProtocolError({ detail: "DAP event read Attempt scope does not match its process reference" })
  }
  assertBoundedJson(input)
  if (encoder.encode(JSON.stringify(input)).byteLength > request.maxBytes) {
    throw new ProtocolError({ detail: "HostKernel DAP event page exceeds bounds" })
  }
  let previous = BigInt(request.afterEventSequence)
  for (const rawEvent of input.events) {
    if (!isRecord(rawEvent) || !hasExactKeys(rawEvent, ["protocol", "messageKind", "payload"])) {
      throw new ProtocolError({ detail: "invalid HostKernel DAP event wrapper" })
    }
    const event = rawEvent.payload
    if (rawEvent.protocol !== "dap" || !isRecord(event)) {
      throw new ProtocolError({ detail: "invalid HostKernel DAP event" })
    }
    if (rawEvent.messageKind === "event") {
      if (
        !hasExactKeys(event, ["eventSequence", "dapSequence", "event"], ["body"]) ||
        !isCanonicalU64(event.eventSequence, false) ||
        !isCanonicalU64(event.dapSequence, false) ||
        !Schema.is(HostEventName)(event.event) ||
        (event.body !== undefined && !isRecord(event.body))
      ) {
        throw new ProtocolError({ detail: "invalid HostKernel DAP event" })
      }
    } else if (rawEvent.messageKind === "response") {
      if (
        !hasExactKeys(
          event,
          ["schemaVersion", "eventSequence", "requestSequence", "requestID", "command", "success"],
          ["body", "message"],
        ) ||
        event.schemaVersion !== 1 ||
        !isCanonicalU64(event.eventSequence, false) ||
        !isCanonicalU64(event.requestSequence, false) ||
        typeof event.requestID !== "number" ||
        !Number.isSafeInteger(event.requestID) ||
        event.requestID <= 0 ||
        !Schema.is(HostCommand)(event.command) ||
        typeof event.success !== "boolean" ||
        (event.success === false && typeof event.message !== "string") ||
        (event.message !== undefined &&
          (typeof event.message !== "string" ||
            encoder.encode(event.message).byteLength > 4096 ||
            /[\x00-\x1f\x7f]/.test(event.message))) ||
        (event.body !== undefined && !isRecord(event.body))
      ) {
        throw new ProtocolError({ detail: "invalid HostKernel DAP response" })
      }
    } else {
      throw new ProtocolError({ detail: "unsupported HostKernel DAP event kind" })
    }
    const current = BigInt(event.eventSequence as string)
    if (current !== previous + 1n) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
    previous = current
  }
  if (input.status === "UNKNOWN") throw new ResnapshotRequiredError({ reason: "unknown_process" })
  return freezeProtocolJson(input) as HostEventPageV1
}

/** A per-process event cursor. Any replay conflict quarantines the projection;
 * it cannot skip history or silently reconnect to another process generation. */
export class HostDapEventCursorV1 {
  #afterEventSequence = "0"
  #quarantined = false
  #lastAccepted?: { readonly requestedAfter: string; readonly serialized: string; readonly page: HostEventPageV1 }

  constructor(
    readonly hostProcessRef: HostProcessRefV1,
    readonly sessionID: string,
    readonly locationID: string,
    readonly workspaceRevision: string,
    readonly managedAttempt?: ManagedAttemptScopeV1,
    readonly directAttempt?: DirectAttemptScopeV1,
  ) {}

  get afterEventSequence(): string {
    return this.#afterEventSequence
  }

  get quarantined(): boolean {
    return this.#quarantined
  }

  readRequest() {
    if (this.#quarantined) throw new ResnapshotRequiredError({ reason: "unknown_process" })
    return {
      hostProcessRef: this.hostProcessRef,
      sessionID: this.sessionID,
      locationID: this.locationID,
      workspaceRevision: this.workspaceRevision,
      ...(this.managedAttempt === undefined ? {} : { managedAttempt: this.managedAttempt }),
      ...(this.directAttempt === undefined ? {} : { directAttempt: this.directAttempt }),
      afterEventSequence: this.#afterEventSequence,
      maxEvents: 64 as const,
      maxBytes: 1048576 as const,
    }
  }

  accept(input: unknown): HostEventPageV1 {
    if (this.#quarantined) throw new ResnapshotRequiredError({ reason: "unknown_process" })
    try {
      // Retained HostKernel pages can be replayed after a transport retry.
      // Accept only an exact replay of the last accepted page and suppress its
      // events locally so a DAP response/event is never delivered twice.
      if (
        isRecord(input) && input.afterEventSequence !== this.#afterEventSequence
      ) {
        const serialized = JSON.stringify(input)
        if (typeof serialized !== "string") throw new ProtocolError({ detail: "invalid replayed HostKernel DAP page" })
        if (
          this.#lastAccepted &&
          input.afterEventSequence === this.#lastAccepted.requestedAfter &&
          serialized === this.#lastAccepted.serialized
        ) {
          return { ...this.#lastAccepted.page, events: [] }
        }
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      const page = validateHostEventPageV1(this.readRequest(), input)
      if (page.status === "EXITED") this.#quarantined = true
      const serialized = JSON.stringify(input)
      if (typeof serialized !== "string") throw new ProtocolError({ detail: "invalid HostKernel DAP page" })
      this.#lastAccepted = {
        requestedAfter: this.#afterEventSequence,
        serialized,
        page,
      }
      const last = page.events.at(-1)
      if (last) this.#afterEventSequence = last.payload.eventSequence
      return page
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }
}

/** Core-side DAP receipt/response correlation. It consumes only the typed
 * dispatch receipt and retained protocol_read events; no process bytes or
 * adapter-originated requests enter this journal. */
export class HostDapProtocolJournalV1 {
  #lastRequestSequence = 0n
  #lastProcessIOSequence = 0n
  #lastEventSequence = 0n
  #quarantined = false
  #acceptedDispatches = new Map<string, { readonly requestFingerprint: string; readonly receipt: HostProtocolDispatchReceiptV1 }>()
  #pending = new Map<string, { readonly requestID: number; readonly command: HostCommand }>()

  readonly hostProcessRef: HostProcessRefV1

  constructor(hostProcessRef: HostProcessRefV1, readonly workspaceRevision: string) {
    const processRef = validateHostProcessRef(hostProcessRef)
    if (processRef.kind !== "debug_adapter") throw new ProtocolError({ detail: "DAP journal requires a debug adapter" })
    if (!/^blake3:[0-9a-f]{64}$/.test(workspaceRevision)) throw new ProtocolError({ detail: "DAP journal requires a workspace revision" })
    this.hostProcessRef = Object.freeze({ ...processRef })
  }

  get quarantined(): boolean {
    return this.#quarantined
  }

  acceptOperation(requestInput: unknown, receiptInput: unknown): HostProtocolDispatchReceiptV1 {
    this.#assertLive()
    try {
      const request = validateHostOperationRequestV1(requestInput)
      if (!sameHostProcessRef(this.hostProcessRef, request.hostProcessRef)) {
        throw new ResnapshotRequiredError({ reason: "stale_process" })
      }
      if (request.workspaceRevision !== this.workspaceRevision) {
        throw new ResnapshotRequiredError({ reason: "stale_workspace" })
      }
      const sequence = BigInt(request.operation.requestSequence)
      if (sequence <= this.#lastRequestSequence) {
        const accepted = this.#acceptedDispatches.get(sequence.toString(10))
        const receipt = validateHostDapDispatchReceiptV1(request, receiptInput)
        if (
          !accepted ||
          accepted.requestFingerprint !== stableFingerprint(request) ||
          !sameDapReceipt(accepted.receipt, receipt)
        ) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
        return accepted.receipt
      }
      if (sequence !== this.#lastRequestSequence + 1n) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      const receipt = validateHostDapDispatchReceiptV1(request, receiptInput)
      const ioSequence = BigInt(receipt.processIOSequence)
      if (ioSequence <= this.#lastProcessIOSequence) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      if ([...this.#pending.values()].some((pending) => pending.requestID === request.operation.requestID)) {
        throw new ProtocolError({ detail: "duplicate pending DAP request ID" })
      }
      this.#pending.set(request.operation.requestSequence, {
        requestID: request.operation.requestID,
        command: request.operation.command,
      })
      this.#lastRequestSequence = sequence
      this.#lastProcessIOSequence = ioSequence
      this.#acceptedDispatches.set(sequence.toString(10), {
        requestFingerprint: stableFingerprint(request),
        receipt: Object.freeze({ ...receipt }),
      })
      while (this.#acceptedDispatches.size > 64) {
        const oldest = this.#acceptedDispatches.keys().next().value
        if (oldest === undefined) break
        this.#acceptedDispatches.delete(oldest)
      }
      return receipt
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }

  acceptPage(page: HostEventPageV1): void {
    this.#assertLive()
    try {
      const processRef = validateHostProcessRef(page.hostProcessRef)
      if (!sameHostProcessRef(this.hostProcessRef, processRef)) throw new ResnapshotRequiredError({ reason: "stale_process" })
      if (page.workspaceRevision !== this.workspaceRevision) {
        throw new ResnapshotRequiredError({ reason: "stale_workspace" })
      }
      if (!isCanonicalU64(page.processIOSequence)) throw new ProtocolError({ detail: "invalid DAP process IO sequence" })
      const ioSequence = BigInt(page.processIOSequence)
      if (ioSequence < this.#lastProcessIOSequence) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      if (page.afterEventSequence !== this.#lastEventSequence.toString(10)) {
        const replayCursor = BigInt(page.afterEventSequence)
        if (
          page.events.length === 0 && page.status === "RUNNING" &&
          replayCursor < this.#lastEventSequence && ioSequence <= this.#lastProcessIOSequence
        ) return
        throw new ResnapshotRequiredError({ reason: "cursor_gap" })
      }
      for (const event of page.events) {
        const eventSequence = BigInt(event.payload.eventSequence)
        if (eventSequence !== this.#lastEventSequence + 1n) throw new ResnapshotRequiredError({ reason: "cursor_gap" })
        this.#lastEventSequence = eventSequence
        if (event.messageKind !== "response") continue
        const payload = event.payload
        const pending = this.#pending.get(payload.requestSequence)
        if (!pending || pending.requestID !== payload.requestID || pending.command !== payload.command) {
          throw new ResnapshotRequiredError({ reason: "cursor_gap" })
        }
        this.#pending.delete(payload.requestSequence)
      }
      if (ioSequence > this.#lastProcessIOSequence) this.#lastProcessIOSequence = ioSequence
      if (page.status === "UNKNOWN" || page.status === "EXITED") this.#quarantined = true
    } catch (error) {
      this.#quarantined = true
      throw error
    }
  }

  #assertLive() {
    if (this.#quarantined) throw new ResnapshotRequiredError({ reason: "unknown_process" })
  }
}

function stableFingerprint(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (typeof item !== "object" || item === null) return item
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(item).sort()) output[key] = normalize((item as Record<string, unknown>)[key])
    return output
  }
  return JSON.stringify(normalize(value))
}

function sameDapReceipt(left: HostProtocolDispatchReceiptV1, right: HostProtocolDispatchReceiptV1): boolean {
  return left.requestSequence === right.requestSequence &&
    left.processIOSequence === right.processIOSequence &&
    left.operationDigest === right.operationDigest &&
    left.dispatchReceiptDigest === right.dispatchReceiptDigest &&
    left.status === right.status && sameHostProcessRef(left.hostProcessRef, right.hostProcessRef)
}

const decodeEnvelope = Schema.decodeUnknownSync(Envelope)

function hasExactKeys(input: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!isPlainDataRecord(input)) return false
  const record = input as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(record)
  return required.every((key) => Object.hasOwn(record, key)) && keys.every((key) => allowed.has(key))
}

function exactEnvelopeShape(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  switch ((input as { type?: unknown }).type) {
    case "request":
      return hasExactKeys(input, ["seq", "type", "command"], ["arguments"])
    case "response":
      return hasExactKeys(input, ["seq", "type", "request_seq", "success", "command"], ["message", "body"])
    case "event":
      return hasExactKeys(input, ["seq", "type", "event"], ["body"])
    default:
      return false
  }
}

/**
 * Validate one decoded JSON value as a DAP envelope. Untrusted input never
 * leaks into the error: failures are reported as a bounded typed error.
 */
export function parseMessage(input: unknown): Envelope {
  return serializeEnvelope(input).message
}

function serializeEnvelope(input: unknown): { message: Envelope; body: Uint8Array } {
  let message: Envelope
  try {
    if (!exactEnvelopeShape(input)) throw new TypeError("unknown DAP envelope fields")
    message = decodeEnvelope(input)
  } catch {
    throw new ProtocolError({ detail: "malformed DAP message envelope" })
  }

  let serialized: string
  try {
    serialized = JSON.stringify(message)
    if (typeof serialized !== "string") throw new TypeError("DAP envelope is not JSON serializable")
  } catch {
    throw new ProtocolError({ detail: "malformed DAP message envelope" })
  }

  const body = encoder.encode(serialized)
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError({ detail: `DAP message exceeds ${MAX_FRAME_BYTES} bytes` })
  }

  try {
    message = decodeEnvelope(JSON.parse(serialized))
  } catch {
    throw new ProtocolError({ detail: "malformed DAP message envelope" })
  }

  return { message, body }
}

/**
 * Effect classification for a DAP command name. Anything unrecognized is
 * `"unknown"`, which is fail-closed: callers must not dispatch it.
 */
export const CommandClass = Schema.Literals(["read", "conditional_read", "control", "evaluate", "launch", "unknown"])
export type CommandClass = typeof CommandClass.Type

const READ_COMMANDS: ReadonlySet<string> = new Set([
  "threads",
  "stackTrace",
  "scopes",
  "source",
  "sources",
  "modules",
  "loadedSources",
  "breakpointLocations",
  "dataBreakpointInfo",
  "disassemble",
  "exceptionInfo",
  "completions",
  "gotoTargets",
])

// A variables request may cause an adapter to invoke getters, lazy evaluation,
// formatters, or target code. It is not safe to treat as passive without an
// adapter-specific guarantee.
const CONDITIONAL_READ_COMMANDS: ReadonlySet<string> = new Set(["variables"])

const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "stepBack",
  "reverseContinue",
  "pause",
  "restart",
  "restartFrame",
  "terminate",
  "terminateThreads",
  "disconnect",
  "cancel",
  "configurationDone",
  "setBreakpoints",
  "setFunctionBreakpoints",
  "setExceptionBreakpoints",
  "setDataBreakpoints",
  "setInstructionBreakpoints",
])

const EVALUATE_COMMANDS: ReadonlySet<string> = new Set(["evaluate", "setVariable", "setExpression"])

const LAUNCH_COMMANDS: ReadonlySet<string> = new Set([
  "initialize",
  "launch",
  "attach",
  "runInTerminal",
  "startDebugging",
])

export function classifyCommand(command: string): CommandClass {
  if (LAUNCH_COMMANDS.has(command)) return "launch"
  if (EVALUATE_COMMANDS.has(command)) return "evaluate"
  if (CONTROL_COMMANDS.has(command)) return "control"
  if (CONDITIONAL_READ_COMMANDS.has(command)) return "conditional_read"
  if (READ_COMMANDS.has(command)) return "read"
  return "unknown"
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const HEADER_TERMINATOR = [13, 10, 13, 10] as const

function indexOfSequence(input: Uint8Array, sequence: readonly number[], from = 0): number {
  outer: for (let i = from; i <= input.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (input[i + j] !== sequence[j]) continue outer
    }
    return i
  }
  return -1
}

export interface DecodedFrame {
  readonly message: Envelope
  readonly rest: Uint8Array
}

/**
 * Encode one envelope as a bounded DAP frame.
 */
export function encodeFrame(message: Envelope): Uint8Array {
  const { body } = serializeEnvelope(message)
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.byteLength + body.byteLength)
  frame.set(header, 0)
  frame.set(body, header.byteLength)
  return frame
}

/**
 * Decode the first complete frame from a buffer. Returns `null` when more
 * bytes are required (incomplete header or body) and throws `ProtocolError`
 * when the stream cannot be a valid bounded DAP frame.
 */
export function decodeFrame(input: Uint8Array): DecodedFrame | null {
  const headerEnd = indexOfSequence(input, HEADER_TERMINATOR)
  if (headerEnd === -1) {
    if (input.byteLength > MAX_HEADER_BYTES) {
      throw new ProtocolError({ detail: `DAP header exceeds ${MAX_HEADER_BYTES} bytes` })
    }
    return null
  }
  if (headerEnd > MAX_HEADER_BYTES) {
    throw new ProtocolError({ detail: `DAP header exceeds ${MAX_HEADER_BYTES} bytes` })
  }

  let header: string
  try {
    header = decoder.decode(input.subarray(0, headerEnd))
  } catch {
    throw new ProtocolError({ detail: "DAP frame header is not valid UTF-8" })
  }
  const contentLengthHeaders = header.split("\r\n").filter((line) => /^content-length:/i.test(line))
  if (contentLengthHeaders.length === 0) {
    throw new ProtocolError({ detail: "DAP frame is missing a Content-Length header" })
  }
  if (contentLengthHeaders.length !== 1) {
    throw new ProtocolError({ detail: "DAP frame has duplicate Content-Length headers" })
  }
  if (header.split("\r\n").length !== 1) {
    throw new ProtocolError({ detail: "DAP frame contains unsupported header fields" })
  }
  const match = /^content-length:\s*(\d+)\s*$/i.exec(contentLengthHeaders[0]!)
  if (!match) {
    throw new ProtocolError({ detail: "DAP frame has an invalid Content-Length header" })
  }
  const length = Number.parseInt(match[1]!, 10)
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
    throw new ProtocolError({ detail: `DAP Content-Length exceeds ${MAX_FRAME_BYTES} bytes` })
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length
  if (input.byteLength - bodyStart < length) return null

  const bodyEnd = bodyStart + length
  let body: string
  try {
    body = decoder.decode(input.subarray(bodyStart, bodyEnd))
  } catch {
    throw new ProtocolError({ detail: "DAP frame body is not valid UTF-8" })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ProtocolError({ detail: "DAP frame body is not valid JSON" })
  }

  return { message: parseMessage(parsed), rest: input.subarray(bodyEnd) }
}

export * as DapProtocol from "./protocol"
