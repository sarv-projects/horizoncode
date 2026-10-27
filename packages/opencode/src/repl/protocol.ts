import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

/**
 * ReplBrokerV1 message envelopes and bounds (§37.8) — non-effectful
 * preparation for a bounded, Python-first persistent REPL.
 *
 * This module only parses/validates bounded request and result envelopes. It
 * must never start an interpreter, execute code or invoke an agent-tool
 * callback; those remain UNAVAILABLE until the Rust Guard/ExecutionHost
 * mediation for this origin is implemented and verified (see `./lifecycle`).
 *
 * Every input and every worker result is bounded: code size, wall-time
 * deadline, declared resource limits, callback capability set and captured
 * output. A worker that exceeds its output budget must truncate and
 * artifactize; a result envelope that floods is rejected, never buffered.
 */

export const ReplLanguage = Schema.Literals(["python", "javascript"])
export type ReplLanguage = typeof ReplLanguage.Type

export const MAX_CODE_BYTES = 64 * 1024
export const MAX_CALLBACK_CAPABILITIES = 32
export const MAX_CALLBACK_CAPABILITY_BYTES = 128
export const MAX_SCOPE_BYTES = 4 * 1024
export const MAX_ARTIFACT_REF_BYTES = 255
export const MAX_OUTPUT_REFERENCES_PER_GENERATION = 4_096
export const MIN_DEADLINE_MS = 100
export const MAX_DEADLINE_MS = 3_600_000
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
export const MIN_IDLE_TTL_MS = 1_000
export const MAX_IDLE_TTL_MS = 60 * 60 * 1000
export const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000
export const MAX_CALLBACK_ID_BYTES = 128
export const MAX_CALLBACK_ARGUMENT_BYTES = 64 * 1024
export const MAX_CALLBACK_JSON_DEPTH = 16
export const MAX_CALLBACK_JSON_NODES = 4_096
export const MAX_CALLBACKS_IN_FLIGHT = 16
export const MAX_CALLBACKS_PER_GENERATION = 4_096

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("ReplProtocolError", {
  detail: Schema.String,
}) {}

export const ResourceLimits = Schema.Struct({
  maxMemoryBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_MEMORY_BYTES)),
  maxWallTimeMs: Schema.Int.check(Schema.isBetween({ minimum: MIN_DEADLINE_MS, maximum: MAX_DEADLINE_MS })),
  maxOutputBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
}).annotate({ identifier: "ReplResourceLimitsV1" })
export type ResourceLimits = typeof ResourceLimits.Type

export const StartRequest = Schema.Struct({
  language: ReplLanguage,
  scope: Schema.String,
  resourceLimits: ResourceLimits,
  callbackCapabilities: Schema.Array(Schema.String),
}).annotate({ identifier: "ReplStartRequestV1" })
export type StartRequest = typeof StartRequest.Type

export const ExecuteRequest = Schema.Struct({
  generation: PositiveInt,
  code: Schema.String,
  deadlineMs: Schema.Int.check(Schema.isBetween({ minimum: MIN_DEADLINE_MS, maximum: MAX_DEADLINE_MS })),
}).annotate({ identifier: "ReplExecuteRequestV1" })
export type ExecuteRequest = typeof ExecuteRequest.Type

export const ExecuteStatus = Schema.Literals(["ok", "error", "timeout", "cancelled", "unknown"])
export type ExecuteStatus = typeof ExecuteStatus.Type

export const ExecuteResult = Schema.Struct({
  generation: PositiveInt,
  status: ExecuteStatus,
  value: Schema.optional(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  artifactRef: Schema.optional(Schema.String),
}).annotate({ identifier: "ReplExecuteResultV1" })
export type ExecuteResult = typeof ExecuteResult.Type

/** Internal bounded callback envelope. It conveys no authority: Core must
 * check the generation's declared capability and invoke the ordinary
 * ActionDescriptor/Guard path before running a tool. */
export const CallbackRequest = Schema.Struct({
  generation: PositiveInt,
  callbackID: Schema.String,
  capabilityID: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "ReplCallbackRequestV1" })
export type CallbackRequest = typeof CallbackRequest.Type

export const CallbackStatus = Schema.Literals(["ok", "denied", "error", "unknown"])
export const CallbackResult = Schema.Struct({
  generation: PositiveInt,
  callbackID: Schema.String,
  status: CallbackStatus,
  result: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "ReplCallbackResultV1" })
export type CallbackResult = typeof CallbackResult.Type

const codeBytes = (code: string) => new TextEncoder().encode(code).byteLength

const decodeStart = Schema.decodeUnknownSync(StartRequest)
const decodeExecute = Schema.decodeUnknownSync(ExecuteRequest)
const decodeResult = Schema.decodeUnknownSync(ExecuteResult)
const decodeCallbackRequest = Schema.decodeUnknownSync(CallbackRequest)
const decodeCallbackResult = Schema.decodeUnknownSync(CallbackResult)

function hasExactFields(input: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const fields = input as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(fields, key)) && Object.keys(fields).every((key) => allowed.has(key))
}

export function parseStartRequest(input: unknown): StartRequest {
  let request: StartRequest
  try {
    assertPlainDataRecord(input)
    const limits = input.resourceLimits
    const callbackCapabilities = input.callbackCapabilities
    assertPlainDataRecord(limits)
    assertPlainDataArray(callbackCapabilities, MAX_CALLBACK_CAPABILITIES)
    if (
      !hasExactFields(input, ["language", "scope", "resourceLimits", "callbackCapabilities"]) ||
      !hasExactFields(limits, ["maxMemoryBytes", "maxWallTimeMs", "maxOutputBytes"])
    ) {
      throw new TypeError("unknown or missing repl.start fields")
    }
    request = decodeStart(input)
  } catch {
    throw new ProtocolError({ detail: "malformed repl.start request" })
  }
  if (request.callbackCapabilities.length > MAX_CALLBACK_CAPABILITIES) {
    throw new ProtocolError({ detail: `callback capability set exceeds ${MAX_CALLBACK_CAPABILITIES} entries` })
  }
  if (request.scope.trim().length === 0 || codeBytes(request.scope) > MAX_SCOPE_BYTES) {
    throw new ProtocolError({ detail: `repl.start scope must be non-empty and at most ${MAX_SCOPE_BYTES} bytes` })
  }
  if (
    request.callbackCapabilities.some(
      (capability) =>
        capability.trim() !== capability ||
        capability.length === 0 ||
        codeBytes(capability) > MAX_CALLBACK_CAPABILITY_BYTES ||
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(capability),
    )
  ) {
    throw new ProtocolError({
      detail: `each callback capability must be non-empty and at most ${MAX_CALLBACK_CAPABILITY_BYTES} bytes`,
    })
  }
  if (new Set(request.callbackCapabilities).size !== request.callbackCapabilities.length) {
    throw new ProtocolError({ detail: "callback capability set contains duplicates" })
  }
  return request
}

export function parseExecuteRequest(input: unknown): ExecuteRequest {
  let request: ExecuteRequest
  try {
    assertPlainDataRecord(input)
    if (!hasExactFields(input, ["generation", "code", "deadlineMs"])) {
      throw new TypeError("unknown or missing repl.execute fields")
    }
    request = decodeExecute(input)
  } catch {
    throw new ProtocolError({ detail: "malformed repl.execute request" })
  }
  if (codeBytes(request.code) > MAX_CODE_BYTES) {
    throw new ProtocolError({ detail: `repl.execute code exceeds ${MAX_CODE_BYTES} bytes` })
  }
  return request
}

/**
 * Validate a worker result envelope, including its output budget: captured
 * stdout/stderr must fit the bounded budget or be marked truncated (and
 * artifactized) by the worker.
 */
export function parseExecuteResult(input: unknown): ExecuteResult {
  let result: ExecuteResult
  try {
    assertPlainDataRecord(input)
    if (
      !hasExactFields(
        input,
        ["generation", "status", "stdout", "stderr", "stdoutTruncated", "stderrTruncated"],
        ["value", "artifactRef"],
      )
    ) {
      throw new TypeError("unknown or missing repl result fields")
    }
    result = decodeResult(input)
  } catch {
    throw new ProtocolError({ detail: "malformed repl.execute result" })
  }
  const outputBytes =
    codeBytes(result.value ?? "") +
    codeBytes(result.stdout) +
    codeBytes(result.stderr) +
    codeBytes(result.artifactRef ?? "")
  if (outputBytes > MAX_OUTPUT_BYTES) {
    throw new ProtocolError({ detail: `repl result output exceeds ${MAX_OUTPUT_BYTES} bytes` })
  }
  if ((result.stdoutTruncated || result.stderrTruncated) && !result.artifactRef?.trim()) {
    throw new ProtocolError({ detail: "truncated repl output requires an artifact reference" })
  }
  if (result.artifactRef !== undefined) {
    if (!result.artifactRef.trim()) throw new ProtocolError({ detail: "repl artifact reference must be non-empty" })
    if (codeBytes(result.artifactRef) > MAX_ARTIFACT_REF_BYTES) {
      throw new ProtocolError({ detail: `repl artifact reference exceeds ${MAX_ARTIFACT_REF_BYTES} bytes` })
    }
  }
  return result
}

function callbackID(value: unknown): value is string {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_CALLBACK_ID_BYTES &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function assertPlainDataRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("REPL envelope must be a plain data object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("REPL envelope must be a plain data object")
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("REPL envelope must contain only enumerable data fields")
    }
  }
}

function assertPlainDataArray(value: unknown, maximumLength: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("REPL envelope must contain a plain data array")
  }
  if (value.length > maximumLength) throw new TypeError("REPL envelope array exceeds its entry bound")
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError("REPL envelope array contains an invalid field")
    }
    const index = Number(key)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !Number.isSafeInteger(index) ||
      index >= value.length ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError("REPL envelope array must contain only indexed data fields")
    }
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("REPL envelope array must be dense and contain only data fields")
    }
  }
}

function boundedCallbackJson(value: unknown, maxBytes = MAX_CALLBACK_ARGUMENT_BYTES): void {
  let count = 0
  const visit = (item: unknown, depth: number): void => {
    count++
    if (count > MAX_CALLBACK_JSON_NODES || depth > MAX_CALLBACK_JSON_DEPTH) {
      throw new TypeError("REPL callback value exceeds structural bounds")
    }
    if (item === null || typeof item === "boolean") return
    if (typeof item === "string") {
      if (item.includes("\0")) throw new TypeError("REPL callback value contains NUL")
      return
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("REPL callback value is not JSON")
      return
    }
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).some((key) => {
        if (key === "length") return false
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true
        const index = Number(key)
        return !Number.isSafeInteger(index) || index >= item.length
      })) throw new TypeError("REPL callback arrays must be dense plain JSON arrays")
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("REPL callback arrays must contain only dense data values")
        }
      }
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (typeof item !== "object") throw new TypeError("REPL callback value is not JSON")
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("REPL callback objects must be plain JSON values")
    }
    const entries: [string, unknown][] = []
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("REPL callback objects must contain only enumerable data fields")
      }
      if (key.includes("\0") || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new TypeError("REPL callback object contains an invalid key")
      }
      entries.push([key, descriptor.value])
    }
    for (const [key, child] of entries) visit(child, depth + 1)
  }
  visit(value, 0)
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    throw new TypeError("REPL callback value is not serializable JSON")
  }
  if (bytes > maxBytes) throw new TypeError("REPL callback value exceeds byte bounds")
}

function freezeCallbackJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCallbackJson))
  if (typeof value !== "object" || value === null) return value
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeCallbackJson(child)])))
}

export function parseCallbackRequest(input: unknown): CallbackRequest {
  let request: CallbackRequest
  try {
    assertPlainDataRecord(input)
    if (!hasExactFields(input, ["generation", "callbackID", "capabilityID", "arguments"])) {
      throw new TypeError("unknown or missing callback fields")
    }
    boundedCallbackJson(input.arguments)
    request = decodeCallbackRequest(input)
  } catch {
    throw new ProtocolError({ detail: "malformed repl.callback request" })
  }
  if (!callbackID(request.callbackID)) throw new ProtocolError({ detail: "invalid repl.callback ID" })
  if (
    request.capabilityID.trim() !== request.capabilityID ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(request.capabilityID) ||
    new TextEncoder().encode(request.capabilityID).byteLength > MAX_CALLBACK_CAPABILITY_BYTES
  ) {
    throw new ProtocolError({ detail: "invalid repl.callback capability ID" })
  }
  return Object.freeze({ ...request, arguments: freezeCallbackJson(request.arguments) as Record<string, unknown> })
}

export function parseCallbackResult(input: unknown, expected: Pick<CallbackRequest, "generation" | "callbackID">): CallbackResult {
  let result: CallbackResult
  try {
    assertPlainDataRecord(input)
    if (!hasExactFields(input, ["generation", "callbackID", "status"], ["result", "message"])) {
      throw new TypeError("unknown or missing callback result fields")
    }
    if (Object.hasOwn(input, "result")) boundedCallbackJson(input.result)
    result = decodeCallbackResult(input)
  } catch {
    throw new ProtocolError({ detail: "malformed repl.callback result" })
  }
  if (result.generation !== expected.generation || result.callbackID !== expected.callbackID) {
    throw new ProtocolError({ detail: "repl.callback result does not match its request" })
  }
  if (!callbackID(result.callbackID)) throw new ProtocolError({ detail: "invalid repl.callback result ID" })
  if (result.status === "ok") {
    if (!Object.hasOwn(input as object, "result") || Object.hasOwn(input as object, "message")) {
      throw new ProtocolError({ detail: "successful repl.callback result must contain only a result value" })
    }
    try {
      boundedCallbackJson(result.result)
    } catch (error) {
      throw new ProtocolError({ detail: error instanceof Error ? error.message : "invalid repl.callback result value" })
    }
  } else if (typeof result.message !== "string" || !result.message.trim() ||
    result.message.includes("\0") || new TextEncoder().encode(result.message).byteLength > MAX_CALLBACK_ARGUMENT_BYTES ||
    Object.hasOwn(input as object, "result")) {
    throw new ProtocolError({ detail: "failed repl.callback result requires a bounded message" })
  }
  return Object.freeze({ ...result, ...(result.status === "ok" ? { result: freezeCallbackJson(result.result) } : {}) })
}

export function validateIdleTtl(idleTtlMs: number): number {
  if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < MIN_IDLE_TTL_MS || idleTtlMs > MAX_IDLE_TTL_MS) {
    throw new ProtocolError({ detail: `idle TTL must be between ${MIN_IDLE_TTL_MS} and ${MAX_IDLE_TTL_MS} ms` })
  }
  return idleTtlMs
}

export * as ReplProtocol from "./protocol"
