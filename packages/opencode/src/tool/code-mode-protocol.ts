import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1 } from "@opencode-ai/schema"
import { parseTree } from "jsonc-parser"

/**
 * Core mirror of arch_V1/contracts-v2/codemode-worker-message-v1.schema.json
 * and kernel/src/codemode_protocol.rs. This validates transport shape and
 * correlation only. It grants no authority and does not dispatch tools.
 */

export const CODE_MODE_FRAME_LIMITS_V1 = Object.freeze({
  maxFrameBytes: 2 * 1024 * 1024,
  maxSourceBytes: 65_536,
  maxCallsPerWave: 32,
  maxCallArgumentBytes: 262_144,
  maxWaveArgumentBytes: 524_288,
  maxTotalArgumentBytes: 1_048_576,
  maxTotalCalls: 64,
  maxWaves: 64,
  maxOutputBytes: 65_536,
  maxTools: 256,
} as const)

export type CodeModeToolV1 = {
  toolName: string
  capabilityId: string
  description: string
  inputSchema: Record<string, unknown>
  inputSchemaDigest: string
}

export type CodeModeCallV1 = {
  callId: string
  toolName: string
  capabilityId: string
  arguments: Record<string, unknown>
  argumentBytes: number
}

export type CodeModeCallResultV1 = {
  callId: string
  status: "settled" | "rejected" | "cancelled" | "unknown"
  receiptKind: "effect_receipt" | "host_decision" | "tool_result" | null
  output?: string
  resultDigest?: string
  outputBytes?: number
  receiptRef?: string
  receiptDigest?: string
  errorCode?: string
}

type Envelope = { schemaVersion: 1; frameType: string; requestId: string; sequence: string }
export type CodeModeStartV1 = Envelope & {
  frameType: "start"
  sequence: "0"
  code: string
  toolSetDigest: string
  /** Canonical JSON UTF-8 byte count of the exact ordered tools array. */
  toolDefinitionsBytes: number
  tools: CodeModeToolV1[]
}
export type CodeModeWaveRequestV1 = Envelope & {
  frameType: "wave_request"
  waveIndex: number
  calls: CodeModeCallV1[]
}
export type CodeModeWaveResultV1 = Envelope & {
  frameType: "wave_result"
  waveIndex: number
  batchId: string
  status: "settled" | "rejected" | "cancelled" | "unknown"
  results: CodeModeCallResultV1[]
  receiptDigest?: string
}
/** Authenticated HostKernel settlement projection; these rows are never helper input. */
export type CodeModeWaveSettlementV1 = {
  requestId: string
  waveIndex: number
  batchId: string
  status: CodeModeWaveResultV1["status"]
  results: CodeModeCallResultV1[]
  receiptDigest?: string
}
export type CodeModeCancelV1 = Envelope & { frameType: "cancel"; reason: "user_abort" | "deadline" | "parent_failure" | "shutdown" }
export type CodeModeCompletedV1 = Envelope & {
  frameType: "completed"
  status: "completed" | "failed" | "cancelled"
  output?: string
  truncated?: boolean
  errorCode?: string
}
export type CodeModeFrameV1 = CodeModeStartV1 | CodeModeWaveRequestV1 | CodeModeWaveResultV1 | CodeModeCancelV1 | CodeModeCompletedV1

const encoder = new TextEncoder()
const ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^(?:sha256|blake3):[a-f0-9]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  const shared = Math.min(a.byteLength, b.byteLength)
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.byteLength - b.byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

type JsonSyntaxNode = { type: string; value?: unknown; children?: JsonSyntaxNode[] }

function hasDuplicateObjectKeys(node: JsonSyntaxNode | undefined): boolean {
  if (!node?.children) return false
  if (node.type === "object") {
    const keys = new Set<string>()
    for (const property of node.children) {
      const key = property.children?.[0]?.value
      if (typeof key !== "string" || keys.has(key)) return true
      keys.add(key)
    }
  }
  return node.children.some(hasDuplicateObjectKeys)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "string") return isUnicodeScalarString(value) && encoder.encode(value).byteLength <= CODE_MODE_FRAME_LIMITS_V1.maxCallArgumentBytes
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every((item) => validJson(item, depth + 1))
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 4096 && entries.every(([key, item]) =>
    isUnicodeScalarString(key) && encoder.encode(key).byteLength <= 256 && !/[\u0000-\u001f\u007f]/.test(key) && validJson(item, depth + 1))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function expectedToolSetDigest(tools: readonly CodeModeToolV1[]): string {
  return digestBytes("horizoncode.codemode-toolset.v1", encodeCanonicalMessagePackV1(tools.map((tool) => ({
    toolName: tool.toolName,
    capabilityId: tool.capabilityId,
    description: tool.description,
    inputSchema: tool.inputSchema,
    inputSchemaDigest: tool.inputSchemaDigest,
  }))))
}

export function canonicalJsonBytesV1(value: unknown): number {
  return encoder.encode(canonicalJson(value)).byteLength
}

function toolsAreCanonicalOrder(tools: readonly CodeModeToolV1[]): boolean {
  for (let index = 1; index < tools.length; index++) {
    const previous = tools[index - 1]!
    const current = tools[index]!
    const capabilityOrder = compareUtf8(previous.capabilityId, current.capabilityId)
    if (capabilityOrder > 0 || (capabilityOrder === 0 && compareUtf8(previous.toolName, current.toolName) >= 0)) return false
  }
  return true
}

function validEnvelope(frame: Record<string, unknown>, type: string): boolean {
  return frame.schemaVersion === 1 && frame.frameType === type &&
    typeof frame.requestId === "string" && ID.test(frame.requestId) &&
    typeof frame.sequence === "string" && DECIMAL.test(frame.sequence) && BigInt(frame.sequence) <= 0xffff_ffff_ffff_ffffn
}

function validTool(value: unknown): value is CodeModeToolV1 {
  if (!isRecord(value) || !exactKeys(value, ["toolName", "capabilityId", "description", "inputSchema", "inputSchemaDigest"])) return false
  return typeof value.toolName === "string" && ID.test(value.toolName) &&
    typeof value.capabilityId === "string" && ID.test(value.capabilityId) &&
    typeof value.description === "string" && isUnicodeScalarString(value.description) && encoder.encode(value.description).byteLength <= 4096 &&
    isRecord(value.inputSchema) && Object.keys(value.inputSchema).length <= 256 && validJson(value.inputSchema) &&
    typeof value.inputSchemaDigest === "string" && DIGEST.test(value.inputSchemaDigest) &&
    value.inputSchemaDigest === domainDigest("horizon.tool-schema.v1", canonicalJson(value.inputSchema))
}

function validCall(value: unknown): value is CodeModeCallV1 {
  if (!isRecord(value) || !exactKeys(value, ["callId", "toolName", "capabilityId", "arguments", "argumentBytes"])) return false
  if (typeof value.callId !== "string" || !ID.test(value.callId) ||
    typeof value.toolName !== "string" || !ID.test(value.toolName) ||
    typeof value.capabilityId !== "string" || !ID.test(value.capabilityId) ||
    !isRecord(value.arguments) || !validJson(value.arguments) ||
    !Number.isSafeInteger(value.argumentBytes) || (value.argumentBytes as number) < 0) return false
  const bytes = encoder.encode(canonicalJson(value.arguments)).byteLength
  return bytes === value.argumentBytes && bytes <= CODE_MODE_FRAME_LIMITS_V1.maxCallArgumentBytes
}

function validCallResult(value: unknown): value is CodeModeCallResultV1 {
  if (!isRecord(value) || !exactKeys(value, ["callId", "status", "receiptKind"], ["output", "resultDigest", "outputBytes", "receiptRef", "receiptDigest", "errorCode"])) return false
  const valid = typeof value.callId === "string" && ID.test(value.callId) &&
    ["settled", "rejected", "cancelled", "unknown"].includes(String(value.status)) &&
    (value.receiptKind === null || value.receiptKind === "effect_receipt" || value.receiptKind === "host_decision" || value.receiptKind === "tool_result") &&
    (value.output === undefined || (typeof value.output === "string" && isUnicodeScalarString(value.output) && encoder.encode(value.output).byteLength <= CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes)) &&
    (value.resultDigest === undefined || (typeof value.resultDigest === "string" && /^blake3:[a-f0-9]{64}$/.test(value.resultDigest))) &&
    (value.outputBytes === undefined || (Number.isSafeInteger(value.outputBytes) && (value.outputBytes as number) >= 0 && (value.outputBytes as number) <= CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes)) &&
    (value.receiptRef === undefined || (typeof value.receiptRef === "string" && ID.test(value.receiptRef))) &&
    (value.receiptDigest === undefined || (typeof value.receiptDigest === "string" && DIGEST.test(value.receiptDigest))) &&
    (value.errorCode === undefined || (typeof value.errorCode === "string" && isUnicodeScalarString(value.errorCode) && encoder.encode(value.errorCode).byteLength <= 128))
  if (!valid) return false
  if (value.status === "unknown") return value.receiptKind === null && value.receiptRef === undefined && value.receiptDigest === undefined && value.output === undefined && value.resultDigest === undefined && value.outputBytes === undefined && value.errorCode === undefined
  if (value.receiptKind === null || typeof value.receiptRef !== "string" || typeof value.receiptDigest !== "string") return false
  if ((value.receiptKind === "effect_receipt" || value.receiptKind === "host_decision") && (value.resultDigest !== undefined || value.outputBytes !== undefined)) return false
  if (value.receiptKind === "effect_receipt" && value.status !== "settled") return false
  if (value.receiptKind === "host_decision" && (value.status === "settled" || value.output !== undefined || value.resultDigest !== undefined || value.outputBytes !== undefined)) return false
  if (value.receiptKind === "tool_result" && value.status === "settled" && (typeof value.resultDigest !== "string" || typeof value.outputBytes !== "number")) return false
  if (value.receiptKind === "tool_result" && value.status !== "settled" && (value.resultDigest !== undefined || value.outputBytes !== undefined || typeof value.errorCode !== "string")) return false
  return true
}

export function codeModeReceiptDigestV1(entries: readonly (readonly [number, string, "settled" | "rejected" | "cancelled", "effect_receipt" | "host_decision" | "tool_result", string, string])[]): string {
  return digestBytes("horizoncode.codemode-receipts.v1", encodeCanonicalMessagePackV1(entries))
}

/** Digest the exact bounded text projection that Core sends to the helper. */
export function codeModeToolResultDigestV1(output: string): string {
  if (encoder.encode(output).byteLength > CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes) throw new RangeError("CodeMode tool result exceeds its output bound")
  return digestBytes("horizoncode.codemode-tool-result.v1", encodeCanonicalMessagePackV1({ output }))
}

/** Reject malformed, oversized, unknown-field, or non-JSON-line frames. */
export function decodeCodeModeFrameV1(bytes: Uint8Array): CodeModeFrameV1 {
  const limits = CODE_MODE_FRAME_LIMITS_V1
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxFrameBytes) throw new RangeError("CodeMode frame exceeds its byte bound")
  // Preserve a leading BOM so the explicit check below rejects it exactly as
  // Rust's strict JSON-line decoder does.
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw
  if (!line || line.startsWith("\uFEFF") || /[\r\n]/.test(line)) throw new TypeError("CodeMode frame must contain exactly one JSON line")
  const syntaxErrors: { error: number; offset: number; length: number }[] = []
  const syntaxTree = parseTree(line, syntaxErrors, { disallowComments: true, allowTrailingComma: false })
  if (syntaxErrors.length || hasDuplicateObjectKeys(syntaxTree as JsonSyntaxNode | undefined)) {
    throw new TypeError("CodeMode frame has invalid JSON syntax or duplicate object fields")
  }
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { throw new TypeError("CodeMode frame is not valid JSON") }
  if (!isRecord(parsed)) throw new TypeError("CodeMode frame must be an object")

  const f = parsed
  switch (f.frameType) {
    case "start": {
      if (!exactKeys(f, ["schemaVersion", "frameType", "requestId", "sequence", "code", "toolSetDigest", "toolDefinitionsBytes", "tools"]) ||
        !validEnvelope(f, "start") || f.sequence !== "0" || typeof f.code !== "string" || !f.code ||
        !isUnicodeScalarString(f.code) || encoder.encode(f.code).byteLength > limits.maxSourceBytes || typeof f.toolSetDigest !== "string" || !DIGEST.test(f.toolSetDigest) ||
        !Array.isArray(f.tools) || f.tools.length > limits.maxTools || !f.tools.every(validTool) ||
        !Number.isSafeInteger(f.toolDefinitionsBytes) || (f.toolDefinitionsBytes as number) < 0 || (f.toolDefinitionsBytes as number) > 1_048_576 ||
        canonicalJsonBytesV1(f.tools) !== f.toolDefinitionsBytes ||
        !toolsAreCanonicalOrder(f.tools as CodeModeToolV1[]) ||
        new Set(f.tools.map((tool) => tool.toolName)).size !== f.tools.length ||
        f.toolSetDigest !== expectedToolSetDigest(f.tools as CodeModeToolV1[])) throw new TypeError("Invalid CodeMode start frame")
      break
    }
    case "wave_request": {
      if (!exactKeys(f, ["schemaVersion", "frameType", "requestId", "sequence", "waveIndex", "calls"]) ||
        !validEnvelope(f, "wave_request") || !Number.isSafeInteger(f.waveIndex) || (f.waveIndex as number) < 0 || (f.waveIndex as number) >= limits.maxWaves ||
        !Array.isArray(f.calls) || f.calls.length < 1 || f.calls.length > limits.maxCallsPerWave || !f.calls.every(validCall) ||
        new Set(f.calls.map((call) => call.callId)).size !== f.calls.length ||
        f.calls.reduce((sum, call) => sum + call.argumentBytes, 0) > limits.maxWaveArgumentBytes) throw new TypeError("Invalid CodeMode wave request")
      break
    }
    case "wave_result": {
      if (!exactKeys(f, ["schemaVersion", "frameType", "requestId", "sequence", "waveIndex", "batchId", "status", "results"], ["receiptDigest"]) ||
        !validEnvelope(f, "wave_result") || !Number.isSafeInteger(f.waveIndex) || (f.waveIndex as number) < 0 || (f.waveIndex as number) >= limits.maxWaves ||
        typeof f.batchId !== "string" || !ID.test(f.batchId) || !["settled", "rejected", "cancelled", "unknown"].includes(String(f.status)) ||
        !Array.isArray(f.results) || f.results.length < 1 || f.results.length > limits.maxCallsPerWave || !f.results.every(validCallResult) ||
        new Set(f.results.map((result) => result.callId)).size !== f.results.length ||
        (f.receiptDigest !== undefined && (typeof f.receiptDigest !== "string" || !DIGEST.test(f.receiptDigest)))) throw new TypeError("Invalid CodeMode wave result")
      if (f.status === "unknown") {
        if (f.receiptDigest !== undefined || !f.results.some((result) => result.status === "unknown") ||
          f.results.some((result) => result.status !== "unknown" && result.status !== "settled")) {
          throw new TypeError("Invalid CodeMode UNKNOWN wave result")
        }
      } else {
        if (f.results.some((result) => result.status === "unknown") || typeof f.receiptDigest !== "string") {
          throw new TypeError("Invalid CodeMode terminal wave result status")
        }
        if ((f.status === "settled" && f.results.some((result) => result.status !== "settled")) ||
          (f.status === "rejected" && f.results.some((result) => result.status !== "rejected")) ||
          (f.status === "cancelled" && (!f.results.some((result) => result.status === "cancelled") ||
            f.results.some((result) => result.status !== "settled" && result.status !== "cancelled")))) {
          throw new TypeError("CodeMode wave status conflicts with its exact per-call outcome rows")
        }
        const expectedDigest = codeModeReceiptDigestV1((f.results as CodeModeCallResultV1[]).map((result) => [result.callId, result.receiptRef!, result.receiptDigest!] as const))
        if (f.receiptDigest !== expectedDigest) throw new TypeError("CodeMode wave digest does not match the ordered public call receipt tuples")
      }
      break
    }
    case "cancel":
      if (!exactKeys(f, ["schemaVersion", "frameType", "requestId", "sequence", "reason"]) || !validEnvelope(f, "cancel") ||
        !["user_abort", "deadline", "parent_failure", "shutdown"].includes(String(f.reason))) throw new TypeError("Invalid CodeMode cancellation frame")
      break
    case "completed":
      if (!exactKeys(f, ["schemaVersion", "frameType", "requestId", "sequence", "status"], ["output", "truncated", "errorCode"]) || !validEnvelope(f, "completed") ||
        !["completed", "failed", "cancelled"].includes(String(f.status)) ||
        (f.output !== undefined && (typeof f.output !== "string" || !isUnicodeScalarString(f.output) || encoder.encode(f.output).byteLength > limits.maxOutputBytes)) ||
        (f.truncated !== undefined && typeof f.truncated !== "boolean") ||
        (f.errorCode !== undefined && (typeof f.errorCode !== "string" || !isUnicodeScalarString(f.errorCode) || encoder.encode(f.errorCode).byteLength > 128))) throw new TypeError("Invalid CodeMode completion frame")
      break
    default:
      throw new TypeError("Unknown CodeMode frame type")
  }
  return f as unknown as CodeModeFrameV1
}

export function encodeCodeModeFrameV1(frame: CodeModeFrameV1): Uint8Array {
  const json = JSON.stringify(frame)
  const bytes = encoder.encode(`${json}\n`)
  if (bytes.byteLength > CODE_MODE_FRAME_LIMITS_V1.maxFrameBytes) throw new RangeError("CodeMode frame exceeds its byte bound")
  // Round-trip through the strict decoder so host-authored frames obey the
  // exact same schema, byte and unknown-field rules as helper-authored frames.
  decodeCodeModeFrameV1(bytes)
  return bytes
}

function domainDigest(domain: string, value: string): string {
  return `blake3:${bytesToHex(blake3(encoder.encode(`${domain}\0${value}`)))}`
}

function digestBytes(domain: string, value: Uint8Array): string {
  const prefix = encoder.encode(`${domain}\0`)
  const bytes = new Uint8Array(prefix.byteLength + value.byteLength)
  bytes.set(prefix)
  bytes.set(value, prefix.byteLength)
  return `blake3:${bytesToHex(blake3(bytes))}`
}

/** Build the exact trusted tool projection used by the helper start frame. */
export function makeCodeModeStartFrameV1(input: {
  requestId: string
  code: string
  tools: readonly Omit<CodeModeToolV1, "inputSchemaDigest">[]
}): CodeModeStartV1 {
  const tools = input.tools.map((tool) => ({
    ...tool,
    inputSchemaDigest: domainDigest("horizon.tool-schema.v1", canonicalJson(tool.inputSchema)),
  })).toSorted((left, right) =>
    compareUtf8(left.capabilityId, right.capabilityId) || compareUtf8(left.toolName, right.toolName))
  const toolSetDigest = expectedToolSetDigest(tools)
  const toolDefinitionsBytes = canonicalJsonBytesV1(tools)
  const frame: CodeModeStartV1 = {
    schemaVersion: 1,
    frameType: "start",
    requestId: input.requestId,
    sequence: "0",
    code: input.code,
    toolSetDigest,
    toolDefinitionsBytes,
    tools,
  }
  decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(frame)}${String.fromCharCode(10)}`))
  return frame
}

/** Stateful Core-side conversation fence; it does not admit or execute calls. */
export class CodeModeConversationV1 {
  readonly requestId: string
  #allowed = new Map<string, string>()
  #nextSequence = 1n
  #nextWave = 0
  #totalCalls = 0
  #totalArgsBytes = 0
  #totalOutputBytes = 0
  #seenCalls = new Set<string>()
  #pending?: { waveIndex: number; callIds: string[]; batchId?: string }
  #receiptTuples: (readonly [string, string, string])[] = []
  #helperOutcome?: CodeModeCompletedV1["status"] | "unknown"
  #hasUnknown = false
  #helperCompletionAllowed = false
  #outerReceipt?: { receiptRef: string; receiptDigest: string }
  #terminal = false

  constructor(start: CodeModeStartV1) {
    const encoded = encodeCodeModeFrameV1(start)
    decodeCodeModeFrameV1(encoded)
    this.requestId = start.requestId
    for (const tool of start.tools) this.#allowed.set(tool.toolName, tool.capabilityId)
  }

  acceptHelperFrame(frame: CodeModeWaveRequestV1 | CodeModeCompletedV1): void {
    decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(frame)}\n`))
    if (this.#terminal || this.#pending || (this.#helperOutcome !== undefined && !this.#helperCompletionAllowed)) throw new TypeError("CodeMode helper sent a frame while a wave is pending or after a terminal outcome")
    if (frame.requestId !== this.requestId || BigInt(frame.sequence) !== this.#nextSequence) throw new TypeError("CodeMode helper frame has stale or out-of-order correlation")
    if (this.#helperCompletionAllowed && frame.frameType !== "completed") throw new TypeError("CodeMode helper may only complete after a known terminal wave")
    if (frame.frameType === "wave_request") {
      if (this.#nextWave >= CODE_MODE_FRAME_LIMITS_V1.maxWaves || frame.waveIndex !== this.#nextWave) throw new TypeError("CodeMode helper skipped, exceeded or replayed a wave")
      const total = this.#totalCalls + frame.calls.length
      const argsBytes = this.#totalArgsBytes + frame.calls.reduce((sum, call) => sum + call.argumentBytes, 0)
      if (total > CODE_MODE_FRAME_LIMITS_V1.maxTotalCalls || argsBytes > CODE_MODE_FRAME_LIMITS_V1.maxTotalArgumentBytes) throw new RangeError("CodeMode script-wide call or argument budget exceeded")
      // Validate the whole wave before changing correlation state. Admission is
      // atomic: one forged member cannot consume IDs from otherwise unadmitted
      // calls or leave a partially updated script budget.
      for (const call of frame.calls) {
        if (this.#allowed.get(call.toolName) !== call.capabilityId || this.#seenCalls.has(call.callId)) throw new TypeError("CodeMode helper requested an unlisted or duplicate tool call")
      }
      for (const call of frame.calls) this.#seenCalls.add(call.callId)
      this.#totalCalls = total
      this.#totalArgsBytes = argsBytes
      this.#pending = { waveIndex: frame.waveIndex, callIds: frame.calls.map((call) => call.callId) }
    } else {
      if (this.#hasUnknown) throw new TypeError("CodeMode helper cannot complete after a nested UNKNOWN outcome")
      if (this.#helperCompletionAllowed && frame.status !== this.#helperOutcome) {
        throw new TypeError("CodeMode helper completion status differs from the known terminal wave")
      }
      if (frame.frameType === "completed" && frame.output) {
        this.#totalOutputBytes += encoder.encode(frame.output).byteLength
        if (this.#totalOutputBytes > CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes) throw new RangeError("CodeMode script-wide output budget exceeded")
      }
      this.#helperOutcome = frame.status
      this.#helperCompletionAllowed = false
    }
    this.#nextSequence += 1n
  }

  acceptHostWaveResult(frame: CodeModeWaveResultV1): void {
    decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(frame)}\n`))
    const pending = this.#pending
    if (this.#terminal || !pending || frame.requestId !== this.requestId || BigInt(frame.sequence) !== this.#nextSequence ||
      frame.waveIndex !== pending.waveIndex || pending.batchId !== frame.batchId || frame.results.length !== pending.callIds.length ||
      frame.results.some((result, index) => result.callId !== pending.callIds[index])) throw new TypeError("CodeMode host wave result does not match the pending helper request")
    const waveOutputBytes = frame.results.reduce((sum, result) => sum + (result.output ? encoder.encode(result.output).byteLength : 0), 0)
    if (this.#totalOutputBytes + waveOutputBytes > CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes) throw new RangeError("CodeMode script-wide output budget exceeded")
    if (frame.status !== "unknown") {
      this.#receiptTuples.push(...frame.results.map((result) => [result.callId, result.receiptRef!, result.receiptDigest!] as const))
    } else {
      this.#helperOutcome = "unknown"
      this.#hasUnknown = true
    }
    this.#totalOutputBytes += waveOutputBytes
    this.#pending = undefined
    if (frame.status !== "unknown") this.#nextWave += 1
    if (frame.status === "cancelled") {
      this.#helperOutcome = "cancelled"
      this.#helperCompletionAllowed = true
    } else if (frame.status === "rejected") {
      this.#helperOutcome = "failed"
      this.#helperCompletionAllowed = true
    }
    this.#nextSequence += 1n
  }

  /** Pin the fresh ordinary ToolBatch admitted for the pending complete wave. */
  bindPreparedBatch(batchId: string): void {
    if (!this.#pending || this.#pending.batchId !== undefined || !ID.test(batchId)) {
      throw new TypeError("CodeMode batch binding is missing, duplicated, or malformed")
    }
    this.#pending.batchId = batchId
  }

  /**
   * Build the public helper frame from authenticated HostKernel receipt rows.
   * The public aggregate is recomputed here and compared with HostKernel's
   * projection; P1's private batch/effect digest is intentionally not part of
   * this DTO or frame.
   */
  makeHostWaveResult(settlement: CodeModeWaveSettlementV1): CodeModeWaveResultV1 {
    const pending = this.#pending
    if (!pending || settlement.requestId !== this.requestId || settlement.waveIndex !== pending.waveIndex ||
      pending.batchId !== settlement.batchId || !ID.test(settlement.batchId) || settlement.results.length !== pending.callIds.length ||
      !settlement.results.every(validCallResult) ||
      settlement.results.some((result, index) => result.callId !== pending.callIds[index])) {
      throw new TypeError("HostKernel CodeMode settlement does not match the exact pending wave")
    }
    const receiptDigest = settlement.status === "unknown"
      ? undefined
      : codeModeReceiptDigestV1(settlement.results.map((result, callIndex) => [callIndex, result.callId, result.status, result.receiptKind!, result.receiptRef!, result.receiptDigest!] as const))
    if (receiptDigest !== settlement.receiptDigest) {
      throw new TypeError("HostKernel CodeMode settlement digest differs from its exact ordered receipt rows")
    }
    const frame: CodeModeWaveResultV1 = {
      schemaVersion: 1,
      frameType: "wave_result",
      requestId: this.requestId,
      sequence: this.#nextSequence.toString(),
      waveIndex: settlement.waveIndex,
      batchId: settlement.batchId,
      status: settlement.status,
      results: settlement.results,
      ...(receiptDigest === undefined ? {} : { receiptDigest }),
    }
    this.acceptHostWaveResult(frame)
    return frame
  }

  /**
   * The helper's `completed` frame is not execution settlement. The caller may
   * mark the run terminal only after HostKernel returns the durable outer
   * StdioExecution receipt; ambiguous recovery remains UNKNOWN.
   */
  acceptOuterExecutionReceipt(receipt: {
    status: "settled" | "unknown"
    receiptRef?: string
    receiptDigest?: string
  }): void {
    if (receipt.status === "unknown") {
      if (receipt.receiptRef !== undefined || receipt.receiptDigest !== undefined) {
        throw new TypeError("CodeMode UNKNOWN outer receipt cannot carry settlement evidence")
      }
      if (this.#terminal) throw new TypeError("CodeMode outer receipt was already recorded")
      // A crash, cancellation, or lost response can leave a request or wave
      // pending. The host's durable UNKNOWN is authoritative and must fence
      // all future helper frames without manufacturing completion.
      this.#pending = undefined
      this.#helperOutcome = "unknown"
      this.#hasUnknown = true
    } else {
      if (typeof receipt.receiptRef !== "string" || !ID.test(receipt.receiptRef) ||
        typeof receipt.receiptDigest !== "string" || !DIGEST.test(receipt.receiptDigest) ||
        this.#terminal || this.#pending || this.#helperOutcome === undefined || this.#helperOutcome === "unknown") {
        throw new TypeError("CodeMode outer settlement receipt is missing, malformed, or conflicts with UNKNOWN")
      }
      this.#outerReceipt = { receiptRef: receipt.receiptRef, receiptDigest: receipt.receiptDigest }
    }
    this.#terminal = true
  }

  get terminal() { return this.#terminal }
  get helperOutcome() { return this.#helperOutcome }
  get outerReceipt() { return this.#outerReceipt }
  get pendingWave() { return this.#pending?.waveIndex }
  get nestedReceiptDigest() { return this.#receiptTuples.length && !this.#hasUnknown ? codeModeReceiptDigestV1(this.#receiptTuples) : undefined }
  get totalCalls() { return this.#totalCalls }
  get totalArgumentBytes() { return this.#totalArgsBytes }
  get totalOutputBytes() { return this.#totalOutputBytes }
}
