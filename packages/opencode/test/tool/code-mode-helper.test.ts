import { expect, test } from "bun:test"
import {
  CODE_MODE_FRAME_LIMITS_V1,
  codeModeToolResultDigestV1,
  codeModeWaveReceiptDigestV2,
  decodeCodeModeFrameV1,
  encodeCodeModeFrameV1,
  makeCodeModeStartFrameV1,
  type CodeModeCallResultV1,
  type CodeModeCompletedV1,
  type CodeModeFrameV1,
  type CodeModeWaveRequestV1,
} from "@/tool/code-mode-protocol"
import { CODE_MODE_HELPER_LIMITS_V1, runCodeModeHelperV1 } from "@/tool/code-mode-helper"

test("declares the fixed helper budget and keeps it aligned with the wire codec", () => {
  const limits = CODE_MODE_HELPER_LIMITS_V1
  expect(limits).toEqual({
    maxCallsPerWave: 32,
    maxWaves: 64,
    maxCallArgumentBytes: 262_144,
    maxWaveArgumentBytes: 524_288,
    maxTotalCalls: 64,
    maxTotalArgumentBytes: 1_048_576,
    maxOutputBytes: 65_536,
    maxExecutionMs: 30_000,
  })
  // The helper must not be more permissive than the frames HostKernel accepts.
  expect(limits.maxCallsPerWave).toBe(CODE_MODE_FRAME_LIMITS_V1.maxCallsPerWave)
  expect(limits.maxWaves).toBe(CODE_MODE_FRAME_LIMITS_V1.maxWaves)
  expect(limits.maxCallArgumentBytes).toBe(CODE_MODE_FRAME_LIMITS_V1.maxCallArgumentBytes)
  expect(limits.maxWaveArgumentBytes).toBe(CODE_MODE_FRAME_LIMITS_V1.maxWaveArgumentBytes)
  expect(limits.maxTotalCalls).toBe(CODE_MODE_FRAME_LIMITS_V1.maxTotalCalls)
  expect(limits.maxTotalArgumentBytes).toBe(CODE_MODE_FRAME_LIMITS_V1.maxTotalArgumentBytes)
  expect(limits.maxOutputBytes).toBe(CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes)
  expect(Object.isFrozen(limits)).toBe(true)
})

class FramePipe {
  #frames: Uint8Array[] = []
  #waiters: ((bytes: Uint8Array) => void)[] = []

  push(bytes: Uint8Array) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter(bytes)
    else this.#frames.push(bytes)
  }

  readonly read = async (): Promise<Uint8Array> => {
    const frame = this.#frames.shift()
    if (frame) return frame
    return await new Promise<Uint8Array>((resolve) => this.#waiters.push(resolve))
  }
}

const tool = {
  toolName: "echo",
  capabilityId: "fixture.echo",
  description: "Return the supplied value",
  inputSchema: {
    type: "object",
    properties: { value: {} },
    required: ["value"],
    additionalProperties: false,
  },
}

const encode = (frame: CodeModeFrameV1) => encodeCodeModeFrameV1(frame)
const settle = (char: string) => `blake3:${char.repeat(64)}`

function resultRow(callId: string, output: string, index: number): CodeModeCallResultV1 {
  return {
    callId,
    status: "settled",
    receiptKind: "tool_result",
    output,
    resultDigest: codeModeToolResultDigestV1(output),
    outputBytes: new TextEncoder().encode(output).byteLength,
    receiptRef: `receipt-${index}`,
    receiptDigest: settle(String.fromCharCode(97 + (index % 6))),
  }
}

function waveResult(
  wave: CodeModeWaveRequestV1,
  responder: (call: CodeModeWaveRequestV1["calls"][number], index: number) => CodeModeCallResultV1,
  status: "settled" | "rejected" | "cancelled" = "settled",
) {
  const results = wave.calls.map(responder)
  return {
    schemaVersion: 1 as const,
    frameType: "wave_result" as const,
    requestId: wave.requestId,
    sequence: (BigInt(wave.sequence) + 1n).toString(),
    waveIndex: wave.waveIndex,
    batchId: `batch-${wave.waveIndex}`,
    status,
    results,
    receiptDigest: codeModeWaveReceiptDigestV2(wave.waveIndex, results),
  }
}

async function drive(
  code: string,
  respond: (wave: CodeModeWaveRequestV1) => ReturnType<typeof waveResult> | "reject",
) {
  const inbound = new FramePipe()
  const outbound = new FramePipe()
  const start = makeCodeModeStartFrameV1({ requestId: "helper-request-1", code, tools: [tool] })
  const helper = runCodeModeHelperV1(encode(start), {
    readFrame: inbound.read,
    writeFrame: async (frame) => outbound.push(encode(frame)),
  })
  const waves: CodeModeWaveRequestV1[] = []
  for (;;) {
    const frame = await deadline(outbound.read(), 5_000, "CodeMode helper timed out")
    const decoded = decodeCodeModeFrameV1(frame)
    if (decoded.frameType === "completed") {
      const result = await helper
      return { completed: decoded as CodeModeCompletedV1, waves, result }
    }
    if (decoded.frameType !== "wave_request") throw new Error("helper sent an unexpected frame")
    waves.push(decoded)
    const response = respond(decoded)
    if (response === "reject") throw new Error("fixture rejected the wave")
    inbound.push(encode(response))
  }
}

function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

test("runs one nested tool call through a complete correlated wave", async () => {
  const run = await drive(
    "return await tools.echo({ value: 7 })",
    (wave) => waveResult(wave, (call) => resultRow(call.callId, "7", 1)),
  )

  expect(run.waves).toHaveLength(1)
  expect(run.waves[0]!.calls).toHaveLength(1)
  expect(run.waves[0]!.sequence).toBe("1")
  expect(run.completed).toMatchObject({ status: "completed", output: "7" })
  expect(run.result.totalCalls).toBe(1)
})

test("keeps every admitted wave within the 32-call bound for 33 parallel calls", async () => {
  const run = await drive(
    "const results = await Promise.all(Array.from({ length: 33 }).map((_, i) => tools.echo({ value: i }))); return results.length",
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, JSON.stringify(index), index)),
  )

  expect(run.waves.length).toBeGreaterThan(1)
  expect(run.waves.every((wave) => wave.calls.length >= 1 && wave.calls.length <= 32)).toBe(true)
  expect(run.waves.reduce((sum, wave) => sum + wave.calls.length, 0)).toBe(33)
  expect(run.completed.status).toBe("completed")
  expect(run.completed.output).toBe("33")
  expect(run.result.totalCalls).toBe(33)
})

test("a rejected wave stops later nested dispatch and completes as failed", async () => {
  const run = await drive(
    `let denied = false
try { await tools.echo({ value: 1 }) } catch { denied = true }
try { await tools.echo({ value: 2 }) } catch {}
return denied`,
    (wave) => {
      const results: CodeModeCallResultV1[] = [{
        callId: wave.calls[0]!.callId,
        status: "rejected",
        receiptKind: "host_decision",
        receiptRef: "decision-1",
        receiptDigest: settle("f"),
        errorCode: "GUARD_DENIED",
      }]
      return waveResult(wave, () => results[0]!, "rejected")
    },
  )

  // The second call may not produce a wave after the rejected batch.
  expect(run.waves).toHaveLength(1)
  expect(run.completed.status).toBe("failed")
  expect(run.completed.output ?? "").toContain("true")
})

test("truncates model-facing output at 65,536 UTF-8 bytes", async () => {
  const run = await drive(
    'return "x".repeat(70000)',
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, "unused", index)),
  )

  expect(run.waves).toHaveLength(0)
  expect(run.completed.status).toBe("completed")
  expect(run.completed.truncated).toBe(true)
  expect(new TextEncoder().encode(run.completed.output ?? "").byteLength).toBeLessThanOrEqual(65_536)
})

test("enforces the 64-call script budget before a 65th nested dispatch", async () => {
  const run = await drive(
    'for (let i = 0; i < 65; i++) { await tools.echo({ value: i }) }\nreturn "unreachable"',
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, "1", index)),
  )

  expect(run.waves.reduce((sum, wave) => sum + wave.calls.length, 0)).toBeLessThanOrEqual(64)
  expect(run.completed.status).toBe("failed")
})

test("rejects an oversized single-call argument locally without a wave", async () => {
  const run = await drive(
    'await tools.echo({ value: "x".repeat(300000) })',
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, "unused", index)),
  )

  expect(run.waves).toHaveLength(0)
  expect(run.completed.status).toBe("failed")
})

test("keeps every admitted wave within the 512 KiB wave argument bound", async () => {
  const run = await drive(
    `const s = "x".repeat(200000)
     const results = await Promise.all([
       tools.echo({ value: s }),
       tools.echo({ value: s }),
       tools.echo({ value: s }),
     ])
     return results.length`,
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, JSON.stringify(index), index)),
  )

  expect(run.waves.length).toBeGreaterThan(1)
  expect(run.waves.every((wave) => wave.calls.reduce((sum, call) => sum + call.argumentBytes, 0) <= 524_288)).toBe(true)
  expect(run.waves.reduce((sum, wave) => sum + wave.calls.length, 0)).toBe(3)
  expect(run.completed.status).toBe("completed")
})

test("enforces the 1 MiB script-wide argument budget before dispatch", async () => {
  const run = await drive(
    `const s = "x".repeat(250000)
     const results = await Promise.all([
       tools.echo({ value: s }),
       tools.echo({ value: s }),
       tools.echo({ value: s }),
       tools.echo({ value: s }),
       tools.echo({ value: s }),
     ])
     return results.length`,
    (wave) => waveResult(wave, (call, index) => resultRow(call.callId, JSON.stringify(index), index)),
  )

  expect(run.waves.reduce((sum, wave) => sum + wave.calls.reduce((bytes, call) => bytes + call.argumentBytes, 0), 0))
    .toBeLessThanOrEqual(1_048_576)
  expect(run.result.totalCalls).toBe(4)
  expect(run.completed.status).toBe("failed")
})

test("a cancelled wave is terminal for later nested dispatch and completes cancelled", async () => {
  const run = await drive(
    `let cancelled = false
try { await tools.echo({ value: 1 }) } catch { cancelled = true }
try { await tools.echo({ value: 2 }) } catch {}
return cancelled`,
    (wave) => {
      const result: CodeModeCallResultV1 = {
        callId: wave.calls[0]!.callId,
        status: "cancelled",
        receiptKind: "host_decision",
        receiptRef: "cancel-decision-1",
        receiptDigest: settle("e"),
        errorCode: "CANCELLED",
      }
      return waveResult(wave, () => result, "cancelled")
    },
  )

  // The interpreter may observe the cancellation, but it cannot turn that into
  // authority for another wave, and the run must not report completion.
  expect(run.waves).toHaveLength(1)
  expect(run.completed.status).toBe("cancelled")
})
