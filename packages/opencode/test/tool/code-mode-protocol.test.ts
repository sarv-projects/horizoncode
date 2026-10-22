import { expect, test } from "bun:test"
import {
  CodeModeConversationV1,
  codeModeReceiptDigestV1,
  decodeCodeModeFrameV1,
  encodeCodeModeFrameV1,
  makeCodeModeStartFrameV1,
} from "@/tool/code-mode-protocol"

const encoder = new TextEncoder()
const tool = {
  toolName: "read",
  capabilityId: "files.read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}

test("builds deterministic start frames with canonical tool ordering and digests", () => {
  const first = makeCodeModeStartFrameV1({
    requestId: "request-1",
    code: "return await tools.read({ path: 'README.md' })",
    tools: [tool],
  })
  const second = makeCodeModeStartFrameV1({
    requestId: "request-1",
    code: "return await tools.read({ path: 'README.md' })",
    tools: [{ ...tool, inputSchema: { properties: tool.inputSchema.properties, type: "object" } }],
  })

  expect(first.toolSetDigest).toBe(second.toolSetDigest)
  expect(first.toolDefinitionsBytes).toBe(new TextEncoder().encode(JSON.stringify(first.tools)).byteLength)
  expect(first.tools[0]?.inputSchemaDigest).toBe(second.tools[0]?.inputSchemaDigest)
  expect(decodeCodeModeFrameV1(encodeCodeModeFrameV1(first)).frameType).toBe("start")
})

test("accepts a zero-tool start frame for pure computation", () => {
  const start = makeCodeModeStartFrameV1({ requestId: "request-no-tools", code: "return 1", tools: [] })

  expect(start.tools).toEqual([])
  expect(start.toolDefinitionsBytes).toBe(2)
  expect(decodeCodeModeFrameV1(encodeCodeModeFrameV1(start))).toMatchObject({
    frameType: "start",
    tools: [],
    toolDefinitionsBytes: 2,
  })
})

test("uses UTF-8 canonical key ordering and rejects lone surrogate values", () => {
  const unicodeTool = {
    ...tool,
    inputSchema: { type: "object", properties: { "\uE000": { type: "string" }, "😀": { type: "number" } } },
  }
  const frame = makeCodeModeStartFrameV1({ requestId: "request-unicode", code: "return 1", tools: [unicodeTool] })
  expect(decodeCodeModeFrameV1(encodeCodeModeFrameV1(frame)).frameType).toBe("start")
  expect(() => makeCodeModeStartFrameV1({ requestId: "request-surrogate", code: "\ud800", tools: [tool] })).toThrow()
})

test("rejects unknown fields, invalid versions, malformed UTF-8 and oversized frames", () => {
  const start = makeCodeModeStartFrameV1({ requestId: "request-2", code: "return 1", tools: [tool] })
  expect(() => decodeCodeModeFrameV1(encoder.encode(JSON.stringify({ ...start, extra: true }) + "\n"))).toThrow()
  expect(() => decodeCodeModeFrameV1(encoder.encode(JSON.stringify({ ...start, schemaVersion: 2 }) + "\n"))).toThrow()
  expect(() => decodeCodeModeFrameV1(encoder.encode(`\uFEFF${JSON.stringify(start)}\n`))).toThrow()
  expect(() => decodeCodeModeFrameV1(Uint8Array.of(0xff))).toThrow()
  expect(() => decodeCodeModeFrameV1(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow()
})

test("fences helper sequences, authorized tool identity, and correlated wave results", () => {
  const start = makeCodeModeStartFrameV1({ requestId: "request-3", code: "return 1", tools: [tool] })
  const conversation = new CodeModeConversationV1(start)
  const args = { path: "README.md" }
  const argumentBytes = encoder.encode(JSON.stringify(args)).byteLength
  const wave = {
    schemaVersion: 1 as const,
    frameType: "wave_request" as const,
    requestId: start.requestId,
    sequence: "1",
    waveIndex: 0,
    calls: [{ callId: "call-1", toolName: "read", capabilityId: "files.read", arguments: args, argumentBytes }],
  }
  conversation.acceptHelperFrame(wave)
  expect(() => conversation.acceptHostWaveResult({
    schemaVersion: 1,
    frameType: "wave_result",
    requestId: start.requestId,
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-1",
    status: "settled",
    receiptDigest: "blake3:" + "a".repeat(64),
    results: [{ callId: "call-1", status: "settled", receiptRef: "receipt-1", receiptDigest: "blake3:" + "b".repeat(64) }],
  })).toThrow()
  conversation.bindPreparedBatch("batch-1")
  expect(() => conversation.bindPreparedBatch("batch-2")).toThrow()
  expect(() => conversation.acceptHelperFrame({ ...wave, sequence: "2", calls: [{ ...wave.calls[0]!, capabilityId: "terminal.run" }] })).toThrow()

  const result = {
    schemaVersion: 1 as const,
    frameType: "wave_result" as const,
    requestId: start.requestId,
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-1",
    status: "settled" as const,
    receiptDigest: codeModeReceiptDigestV1([["call-1", "receipt-1", "blake3:" + "b".repeat(64)]]),
    results: [{
      callId: "call-1",
      status: "settled" as const,
      output: "read complete",
      receiptRef: "receipt-1",
      receiptDigest: "blake3:" + "b".repeat(64),
    }],
  }
  conversation.acceptHostWaveResult(result)
  expect(() => conversation.acceptOuterExecutionReceipt({ status: "settled", receiptRef: "outer", receiptDigest: "blake3:" + "c".repeat(64) })).toThrow()
  conversation.acceptHelperFrame({
    schemaVersion: 1,
    frameType: "completed",
    requestId: start.requestId,
    sequence: "3",
    status: "completed",
    output: "done",
  })
  expect(conversation.terminal).toBe(false)
  conversation.acceptOuterExecutionReceipt({
    status: "settled",
    receiptRef: "outer-receipt",
    receiptDigest: "blake3:" + "c".repeat(64),
  })
  expect(conversation.terminal).toBe(true)
  expect(() => conversation.acceptHelperFrame({ ...wave, sequence: "4", waveIndex: 1 })).toThrow()
})

test("does not partially consume call IDs when a complete wave fails authorization", () => {
  const start = makeCodeModeStartFrameV1({ requestId: "request-atomic", code: "return 1", tools: [tool] })
  const conversation = new CodeModeConversationV1(start)
  const arguments_ = { path: "README.md" }
  const argumentBytes = encoder.encode(JSON.stringify(arguments_)).byteLength
  const invalidWave = {
    schemaVersion: 1 as const,
    frameType: "wave_request" as const,
    requestId: start.requestId,
    sequence: "1",
    waveIndex: 0,
    calls: [
      { callId: "call-atomic", toolName: "read", capabilityId: "files.read", arguments: arguments_, argumentBytes },
      { callId: "call-forged", toolName: "read", capabilityId: "terminal.run", arguments: arguments_, argumentBytes },
    ],
  }
  expect(() => conversation.acceptHelperFrame(invalidWave)).toThrow()
  expect(() => conversation.acceptHelperFrame({ ...invalidWave, calls: invalidWave.calls.slice(0, 1) })).not.toThrow()
})
