/**
 * CodeMode's confined helper loop. This module deliberately has no executable
 * entry point and imports no process, filesystem, network, or environment API.
 * The trusted launcher supplies bounded stdio functions; HostKernel remains
 * responsible for every nested admission, dispatch, receipt, cancel, and outer
 * process settlement.
 */
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { Effect } from "effect"
import {
  canonicalJsonBytesV1,
  decodeCodeModeFrameV1,
  encodeCodeModeFrameV1,
  type CodeModeCallV1,
  type CodeModeCompletedV1,
  type CodeModeStartV1,
  type CodeModeWaveRequestV1,
  type CodeModeWaveResultV1,
} from "./code-mode-protocol"

export type CodeModeHelperIOV1 = {
  /** Writes one complete bounded JSON-line frame to the supervised pipe. */
  writeFrame: (frame: CodeModeWaveRequestV1 | CodeModeCompletedV1) => Promise<void>
  /** Reads one complete bounded frame supplied by the trusted HostKernel. */
  readFrame: () => Promise<Uint8Array>
}

export type CodeModeHelperResultV1 = {
  totalCalls: number
  outputBytes: number
  truncated: boolean
}

const UTF8 = new TextEncoder()
/**
 * The one fixed helper budget from §37.24. It is exported as data so the
 * contract can be asserted without waiting out the 30 s interpreter deadline,
 * and so helper and wire limits cannot silently drift apart.
 */
export const CODE_MODE_HELPER_LIMITS_V1 = Object.freeze({
  maxCallsPerWave: 32,
  maxWaves: 64,
  maxCallArgumentBytes: 262_144,
  maxWaveArgumentBytes: 512 * 1024,
  maxTotalCalls: 64,
  maxTotalArgumentBytes: 1_048_576,
  maxOutputBytes: 65_536,
  maxExecutionMs: 30_000,
} as const)
const MAX_CALLS_PER_WAVE = CODE_MODE_HELPER_LIMITS_V1.maxCallsPerWave
const MAX_WAVES = CODE_MODE_HELPER_LIMITS_V1.maxWaves
const MAX_CALL_ARGUMENT_BYTES = CODE_MODE_HELPER_LIMITS_V1.maxCallArgumentBytes
const MAX_WAVE_ARGUMENT_BYTES = CODE_MODE_HELPER_LIMITS_V1.maxWaveArgumentBytes
const MAX_TOTAL_CALLS = CODE_MODE_HELPER_LIMITS_V1.maxTotalCalls
const MAX_TOTAL_ARGUMENT_BYTES = CODE_MODE_HELPER_LIMITS_V1.maxTotalArgumentBytes
const MAX_OUTPUT_BYTES = CODE_MODE_HELPER_LIMITS_V1.maxOutputBytes
const MAX_EXECUTION_MS = CODE_MODE_HELPER_LIMITS_V1.maxExecutionMs
const TRUNCATION_MARKER = "\n[output truncated]"

class CodeModeUnknownOutcome extends Error {
  constructor() {
    super("CodeMode nested effect outcome is UNKNOWN; helper must terminate")
    this.name = "CodeModeUnknownOutcome"
  }
}

function frameRoundTrip(frame: CodeModeWaveRequestV1 | CodeModeCompletedV1): void {
  decodeCodeModeFrameV1(encodeCodeModeFrameV1(frame))
}

function boundText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = UTF8.encode(value)
  if (bytes.byteLength <= limit) return { value, truncated: false }
  const marker = UTF8.encode(TRUNCATION_MARKER)
  if (limit <= marker.byteLength) {
    let end = 0
    let used = 0
    for (const character of value) {
      const width = UTF8.encode(character).byteLength
      if (used + width > limit) break
      used += width
      end += character.length
    }
    return { value: value.slice(0, end), truncated: true }
  }
  const max = Math.max(0, limit - marker.byteLength)
  let end = 0
  let used = 0
  for (const character of value) {
    const width = UTF8.encode(character).byteLength
    if (used + width > max) break
    used += width
    end += character.length
  }
  return { value: value.slice(0, end) + TRUNCATION_MARKER, truncated: true }
}

interface ToolTree {
  [name: string]: SandboxTool.Definition | ToolTree
}

function insertTool(root: ToolTree, path: string, tool: SandboxTool.Definition): void {
  const segments = path.split(".")
  if (segments.some((segment) => !segment || segment === "__proto__" || segment === "constructor" || segment === "prototype")) {
    throw new TypeError("CodeMode tool projection contains an invalid path")
  }
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment]
    if (next !== undefined && (typeof next !== "object" || next === null || "_tag" in next)) {
      throw new TypeError("CodeMode tool projection contains a path collision")
    }
    parent[segment] ??= Object.create(null) as ToolTree
    parent = parent[segment] as ToolTree
  }
  const leaf = segments[segments.length - 1]!
  if (Object.hasOwn(parent, leaf)) throw new TypeError("CodeMode tool projection contains a duplicate path")
  parent[leaf] = tool
}

/**
 * Run one CodeMode source in the already-launched, resource-limited helper.
 * The injected pipe is intentionally transport-only: nested calls can only
 * cross it as complete waves and never invoke an MCP/provider implementation.
 */
export async function runCodeModeHelperV1(startInput: Uint8Array, io: CodeModeHelperIOV1): Promise<CodeModeHelperResultV1> {
  const start = decodeCodeModeFrameV1(startInput)
  if (start.frameType !== "start") throw new TypeError("CodeMode helper requires a trusted start frame")

  let nextSequence = 1n
  let nextWave = 0
  let nextCall = 0
  let totalCalls = 0
  let totalArgumentBytes = 0
  let totalOutputBytes = 0
  let nestedOutputTruncated = false
  let terminalFailure = false
  let flushQueued = false
  let waveInFlight = false
  let terminalReason: "rejected" | "cancelled" | "unknown" | "limit" | undefined
  const pending: Array<{
    call: CodeModeCallV1
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }> = []

  const readWaveResult = async (wave: CodeModeWaveRequestV1): Promise<CodeModeWaveResultV1> => {
    const frame = decodeCodeModeFrameV1(await io.readFrame())
    if (frame.frameType !== "wave_result" || frame.requestId !== start.requestId ||
      BigInt(frame.sequence) !== nextSequence || frame.waveIndex !== wave.waveIndex ||
      frame.results.length !== wave.calls.length ||
      frame.results.some((row, index) => row.callId !== wave.calls[index]!.callId)) {
      throw new TypeError("HostKernel CodeMode wave result is stale or differs from the exact requested wave")
    }
    const statuses = new Set(frame.results.map((row) => row.status))
    if ((frame.status === "settled" && frame.results.some((row) => row.status !== "settled")) ||
      (frame.status === "rejected" && !statuses.has("rejected")) ||
      (frame.status === "cancelled" && !statuses.has("cancelled")) ||
      (frame.status === "unknown" && !statuses.has("unknown"))) {
      throw new TypeError("HostKernel CodeMode aggregate status conflicts with its per-call outcome rows")
    }
    return frame
  }

  const flush = async () => {
    flushQueued = false
    if (waveInFlight || pending.length === 0) return
    if (nextWave >= MAX_WAVES) {
      terminalFailure = true
      terminalReason = "limit"
      const failure = toolError("CodeMode wave budget exceeded.")
      for (const item of pending.splice(0)) item.reject(failure)
      return
    }
    if (terminalFailure) {
      const failure = terminalReason === "unknown" ? new CodeModeUnknownOutcome() : new Error(`CodeMode wave ended with ${terminalReason ?? "failure"}`)
      for (const item of pending.splice(0)) item.reject(failure)
      return
    }
    waveInFlight = true
    const items = [] as typeof pending
    let waveArgumentBytes = 0
    while (items.length < MAX_CALLS_PER_WAVE && pending.length > 0) {
      const next = pending[0]!
      if (waveArgumentBytes + next.call.argumentBytes > MAX_WAVE_ARGUMENT_BYTES) break
      items.push(pending.shift()!)
      waveArgumentBytes += next.call.argumentBytes
    }
    const wave: CodeModeWaveRequestV1 = {
      schemaVersion: 1,
      frameType: "wave_request",
      requestId: start.requestId,
      sequence: nextSequence.toString(),
      waveIndex: nextWave,
      calls: items.map((item) => item.call),
    }
    try {
      frameRoundTrip(wave)
      // The helper and HostKernel share one monotonically increasing sequence.
      // Accepting the wave consumes its sequence; the host's wave_result must
      // therefore use the next number, and the following helper frame uses
      // the number after that.
      nextSequence++
      await io.writeFrame(wave)
      const result = await readWaveResult(wave)
      nextSequence++
      if (result.status === "unknown" || result.results.some((row) => row.status === "unknown")) {
        terminalFailure = true
        terminalReason = "unknown"
      } else if (result.status === "cancelled" || result.results.some((row) => row.status === "cancelled")) {
        // A known cancellation has receipts and may be returned to the
        // interpreter for ordinary error handling, but it closes admission of
        // all later nested calls. The interpreter still sends `completed` so
        // the outer supervised process can settle normally.
        terminalFailure = true
        terminalReason = "cancelled"
      } else if (result.status === "rejected" || result.results.some((row) => row.status === "rejected")) {
        // A known rejected batch is terminal for this script's dispatch
        // authority. The interpreter may catch the returned tool errors, but
        // it cannot use that control flow to authorize a later wave.
        terminalFailure = true
        terminalReason = "rejected"
      } else {
        nextWave++
      }
      for (const [index, item] of items.entries()) {
        const row = result.results[index]!
        if (row.status !== "settled") {
          item.reject(row.status === "unknown" ? new CodeModeUnknownOutcome() : toolError(row.errorCode ?? `Nested tool call ${row.status}.`))
          continue
        }
        const text = row.output ?? ""
        const bounded = boundText(text, Math.max(0, MAX_OUTPUT_BYTES - totalOutputBytes))
        totalOutputBytes += UTF8.encode(bounded.value).byteLength
        nestedOutputTruncated ||= bounded.truncated
        let value: unknown = bounded.value
        try { value = JSON.parse(bounded.value) } catch { /* Plain tool output stays a string. */ }
        item.resolve(value)
      }
    } catch (error) {
      terminalFailure = true
      terminalReason = "unknown"
      for (const item of items) item.reject(error)
      for (const item of pending.splice(0)) item.reject(new CodeModeUnknownOutcome())
    } finally {
      waveInFlight = false
      if (pending.length > 0 && !flushQueued) {
        flushQueued = true
        queueMicrotask(() => void flush())
      }
    }
  }

  // The interpreter validates its plain-data boundaries; HostKernel validates
  // each canonical name/capability pair and Guard/lease/receipt transition.
  const transportTree: ToolTree = Object.create(null)
  for (const definition of start.tools) {
    const tool = SandboxTool.make({
      description: definition.description,
      input: definition.inputSchema as SandboxTool.JsonSchema,
      run: (input) => Effect.callback<unknown, unknown>((resume) => {
        if (terminalFailure || totalCalls >= MAX_TOTAL_CALLS) {
          resume(Effect.fail(terminalReason === "unknown" ? new CodeModeUnknownOutcome() : toolError("CodeMode nested execution is terminal.")))
          return
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          resume(Effect.fail(toolError("CodeMode nested tool arguments must be a JSON object.")))
          return
        }
        let argumentBytes: number
        try { argumentBytes = canonicalJsonBytesV1(input) } catch (error) {
          resume(Effect.fail(toolError(error instanceof Error ? error.message : "Invalid nested arguments.")))
          return
        }
        if (argumentBytes > MAX_CALL_ARGUMENT_BYTES || totalArgumentBytes + argumentBytes > MAX_TOTAL_ARGUMENT_BYTES) {
          resume(Effect.fail(toolError("CodeMode serialized argument budget exceeded.")))
          return
        }
        totalCalls++
        totalArgumentBytes += argumentBytes
        const callId = `call-${nextCall++}`
        const call: CodeModeCallV1 = {
          callId,
          toolName: definition.toolName,
          capabilityId: definition.capabilityId,
          arguments: input as Record<string, unknown>,
          argumentBytes,
        }
        pending.push({ call, resolve: (value) => resume(Effect.succeed(value)), reject: (error) => resume(Effect.fail(error)) })
        if (!flushQueued) {
          flushQueued = true
          queueMicrotask(() => void flush())
        }
      }),
    })
    insertTool(transportTree, definition.toolName, tool)
  }

  const helper = CodeMode.make({
    tools: transportTree,
    limits: { timeoutMs: MAX_EXECUTION_MS, maxToolCalls: MAX_TOTAL_CALLS, maxOutputBytes: MAX_OUTPUT_BYTES },
  })
  const result = await Effect.runPromise(helper.execute(start.code))
  if (waveInFlight || pending.length > 0) {
    throw new CodeModeUnknownOutcome()
  }
  if (terminalReason === "unknown") throw new CodeModeUnknownOutcome()

  const resultText = result.ok ? (typeof result.value === "string" ? result.value : JSON.stringify(result.value) ?? "null") : result.error.message
  const logs = result.logs ?? []
  const rawOutput = logs.length === 0
    ? resultText
    : resultText.length > 0 ? `${resultText}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
  const bounded = boundText(rawOutput, Math.max(0, MAX_OUTPUT_BYTES - totalOutputBytes))
  totalOutputBytes += UTF8.encode(bounded.value).byteLength
  const completed: CodeModeCompletedV1 = {
    schemaVersion: 1,
    frameType: "completed",
    requestId: start.requestId,
    sequence: nextSequence.toString(),
    // Cancellation is a known terminal outcome even when the interpreter
    // catches the rejected nested call and returns a value. Preserve it in the
    // helper completion so Core cannot mistake the run for success.
    status: terminalReason === "cancelled" ? "cancelled"
      : terminalReason === "rejected" || terminalReason === "limit" ? "failed"
        : result.ok ? "completed" : "failed",
    output: bounded.value,
    truncated: nestedOutputTruncated || bounded.truncated || Boolean(result.truncated),
  }
  frameRoundTrip(completed)
  await io.writeFrame(completed)
  return { totalCalls, outputBytes: totalOutputBytes, truncated: nestedOutputTruncated || bounded.truncated || Boolean(result.truncated) }
}
