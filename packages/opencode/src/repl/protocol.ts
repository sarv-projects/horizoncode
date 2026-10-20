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

const codeBytes = (code: string) => new TextEncoder().encode(code).byteLength

const decodeStart = Schema.decodeUnknownSync(StartRequest)
const decodeExecute = Schema.decodeUnknownSync(ExecuteRequest)
const decodeResult = Schema.decodeUnknownSync(ExecuteResult)

function hasExactFields(input: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const fields = input as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(fields, key)) && Object.keys(fields).every((key) => allowed.has(key))
}

export function parseStartRequest(input: unknown): StartRequest {
  let request: StartRequest
  try {
    const limits =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>).resourceLimits
        : undefined
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

export function validateIdleTtl(idleTtlMs: number): number {
  if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < MIN_IDLE_TTL_MS || idleTtlMs > MAX_IDLE_TTL_MS) {
    throw new ProtocolError({ detail: `idle TTL must be between ${MIN_IDLE_TTL_MS} and ${MAX_IDLE_TTL_MS} ms` })
  }
  return idleTtlMs
}

export * as ReplProtocol from "./protocol"
