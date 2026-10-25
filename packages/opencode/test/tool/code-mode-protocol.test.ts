import { expect, test } from "bun:test"
import {
  CodeModeConversationV1,
  codeModeReceiptDigestV1,
  codeModeRunReceiptDigestV2,
  codeModeToolResultDigestV1,
  codeModeWaveReceiptDigestV2,
  decodeCodeModeFrameV1,
  encodeCodeModeFrameV1,
  makeCodeModeStartFrameV1,
  type CodeModeWaveResultV1,
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

test("rejects duplicate tool names and schema digests that do not bind their catalog entry", () => {
  expect(() => makeCodeModeStartFrameV1({
    requestId: "request-duplicate-tool",
    code: "return 1",
    tools: [tool, { ...tool, capabilityId: "files.list", description: "List files" }],
  })).toThrow("Invalid CodeMode start frame")

  const start = makeCodeModeStartFrameV1({ requestId: "request-tampered-schema", code: "return 1", tools: [tool] })
  const tampered = {
    ...start,
    tools: [{ ...start.tools[0]!, inputSchemaDigest: `blake3:${"0".repeat(64)}` }],
  }
  expect(() => encodeCodeModeFrameV1(tampered)).toThrow("Invalid CodeMode start frame")
})

test("rejects unknown fields, invalid versions, malformed UTF-8 and oversized frames", () => {
  const start = makeCodeModeStartFrameV1({ requestId: "request-2", code: "return 1", tools: [tool] })
  expect(() => decodeCodeModeFrameV1(encoder.encode(JSON.stringify({ ...start, extra: true }) + "\n"))).toThrow()
  expect(() => decodeCodeModeFrameV1(encoder.encode(JSON.stringify({ ...start, schemaVersion: 2 }) + "\n"))).toThrow()
  expect(() => decodeCodeModeFrameV1(encoder.encode(`\uFEFF${JSON.stringify(start)}\n`))).toThrow()
  expect(() => decodeCodeModeFrameV1(Uint8Array.of(0xff))).toThrow()
  expect(() => decodeCodeModeFrameV1(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow()
})

test("matches Rust UNKNOWN receipt omission while retaining the internal null projection", () => {
  const wire = {
    schemaVersion: 1,
    frameType: "wave_result",
    requestId: "request-unknown",
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-unknown",
    status: "unknown",
    results: [{ callId: "call-unknown", status: "unknown" }],
  }
  const decoded = decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(wire)}\n`))
  expect(decoded).toMatchObject({
    frameType: "wave_result",
    status: "unknown",
    results: [{ callId: "call-unknown", status: "unknown", receiptKind: null }],
  })
  expect(() => decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify({
    ...wire,
    results: [{ ...wire.results[0], receiptKind: null }],
  })}\n`))).toThrow()

  const internal: CodeModeWaveResultV1 = {
    schemaVersion: 1,
    frameType: "wave_result",
    requestId: "request-unknown",
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-unknown",
    status: "unknown",
    results: [{ callId: "call-unknown", status: "unknown", receiptKind: null }],
  }
  const encoded = encodeCodeModeFrameV1(internal)
  expect(new TextDecoder().decode(encoded)).not.toContain('"receiptKind":null')
})

test("rejects settled tool-result rows whose digest or byte count differs from the exact output", () => {
  const output = "actual"
  const base = {
    callId: "call-result",
    status: "settled" as const,
    receiptKind: "tool_result" as const,
    output,
    resultDigest: codeModeToolResultDigestV1(output),
    outputBytes: encoder.encode(output).byteLength,
    receiptRef: "receipt-result",
    receiptDigest: `blake3:${"d".repeat(64)}`,
  }
  const frame = (result: typeof base) => ({
    schemaVersion: 1,
    frameType: "wave_result",
    requestId: "request-result",
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-result",
    status: "settled",
    receiptDigest: codeModeWaveReceiptDigestV2(0, [result]),
    results: [result],
  })

  expect(() => decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(frame({
    ...base,
    resultDigest: codeModeToolResultDigestV1("different"),
  }))}\n`))).toThrow()
  expect(() => decodeCodeModeFrameV1(encoder.encode(`${JSON.stringify(frame({
    ...base,
    outputBytes: base.outputBytes - 1,
  }))}\n`))).toThrow()
})

test("rejects the legacy v1 public wave digest", () => {
  const rows = [{
    callId: "call-legacy",
    status: "settled" as const,
    receiptKind: "tool_result" as const,
    output: "ok",
    resultDigest: codeModeToolResultDigestV1("ok"),
    outputBytes: 2,
    receiptRef: "receipt-legacy",
    receiptDigest: "blake3:" + "d".repeat(64),
  }]
  const legacy = {
    schemaVersion: 1,
    frameType: "wave_result",
    requestId: "request-legacy",
    sequence: "1",
    waveIndex: 0,
    batchId: "batch-legacy",
    status: "settled",
    receiptDigest: codeModeReceiptDigestV1([[0, "call-legacy", "settled", "tool_result", "receipt-legacy", rows[0]!.receiptDigest]]),
    results: rows,
  }

  expect(() => decodeCodeModeFrameV1(new TextEncoder().encode(`${JSON.stringify(legacy)}\n`))).toThrow()
})

test("run digest enforces the script-wide wave and call limits", () => {
  const row = (callId: string) => ({
    callId,
    status: "settled" as const,
    receiptKind: "effect_receipt" as const,
    receiptRef: `receipt-${callId}`,
    receiptDigest: `blake3:${"a".repeat(64)}`,
  })
  const waves = (sizes: readonly number[]) => sizes.map((size, waveIndex) => ({
    waveIndex,
    rows: Array.from({ length: size }, (_, callIndex) => row(`call-${waveIndex}-${callIndex}`)),
  }))

  expect(codeModeRunReceiptDigestV2(waves(Array.from({ length: 64 }, () => 1)))).toMatch(/^blake3:[a-f0-9]{64}$/)
  expect(() => codeModeRunReceiptDigestV2(waves(Array.from({ length: 65 }, () => 1)))).toThrow()
  expect(codeModeRunReceiptDigestV2(waves([32, 32]))).toMatch(/^blake3:[a-f0-9]{64}$/)
  expect(() => codeModeRunReceiptDigestV2(waves([32, 32, 1]))).toThrow()
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
    results: [{ callId: "call-1", status: "settled", receiptKind: "effect_receipt", receiptRef: "receipt-1", receiptDigest: "blake3:" + "b".repeat(64) }],
  })).toThrow()
  conversation.bindPreparedBatch("batch-1")
  expect(() => conversation.bindPreparedBatch("batch-2")).toThrow()
  expect(() => conversation.acceptHelperFrame({ ...wave, sequence: "2", calls: [{ ...wave.calls[0]!, capabilityId: "terminal.run" }] })).toThrow()

  const output = "read complete"
  const resultDigest = codeModeToolResultDigestV1(output)
  const receiptDigest = `blake3:${"b".repeat(64)}`
  const results = [{
    callId: "call-1",
    status: "settled" as const,
    receiptKind: "tool_result" as const,
    output,
    resultDigest,
    outputBytes: new TextEncoder().encode(output).byteLength,
    receiptRef: "receipt-1",
    receiptDigest,
  }]
  const result = {
    schemaVersion: 1 as const,
    frameType: "wave_result" as const,
    requestId: start.requestId,
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-1",
    status: "settled" as const,
    receiptDigest: codeModeWaveReceiptDigestV2(0, results),
    results,
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
