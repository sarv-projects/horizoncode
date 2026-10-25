import { expect, test } from "bun:test"
import {
  codeModeRunReceiptDigestV2,
  codeModeToolResultDigestV1,
  codeModeWaveReceiptDigestV2,
  makeCodeModeStartFrameV1,
  type CodeModeCallResultV1,
  type CodeModeCompletedV1,
  type CodeModeWaveRequestV1,
} from "@/tool/code-mode-protocol"
import {
  CODE_MODE_DEADLINE_MS_V1,
  runCodeModeConversationV1,
  type CodeModeHostAdapterV1,
} from "@/tool/code-mode-run"
import { CODE_MODE_HELPER_LIMITS_V1 } from "@/tool/code-mode-helper"
import type {
  CodeModeHostStateV1,
  CodeModeHostTurnV1,
  CodeModeLaneBindingV1,
} from "@/tool/code-mode"
import type { CodeModeToolV1, CodeModeWaveSettlementV1 } from "@/tool/code-mode-protocol"

const requestID = "codemode-request-1"
const executionID = "exec-1"
const binding: CodeModeLaneBindingV1 = { lane: "direct_session", sessionID: "ses_codemode_test" }
const tools: Omit<CodeModeToolV1, "inputSchemaDigest">[] = [{
  toolName: "read",
  capabilityId: "files.read",
  description: "Read a workspace file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
}]
const sha = `sha256:${"a".repeat(64)}`
const blake = (char: string) => `blake3:${char.repeat(64)}`
const settle = (char = "b") => blake(char)

const enablement = Object.freeze({
  schemaVersion: 1,
  lane: "direct_session",
  grantId: "grant-1",
  principalDigest: sha,
  sessionID: binding.lane === "direct_session" ? binding.sessionID : "ses_other",
  ownerEpoch: "1",
  capabilityId: "codemode.execute",
  helperSelector: "horizoncode:codemode:bun",
  helperDigest: sha,
  resourceProfileId: "codemode.v1",
  resourceProfileDigest: blake("c"),
  backend: "linux-cgroup-v2",
  guaranteeDigest: blake("d"),
  policyDigest: blake("e"),
  issuedAtMs: "1",
  expiresAtMs: "9999999999999",
  revocationGeneration: "1",
  enablementDigest: blake("f"),
})

function startFrame(code = "return 1") {
  return makeCodeModeStartFrameV1({ requestId: requestID, code, tools })
}

function wave(sequence: string, waveIndex: number, callIds: string[]): CodeModeWaveRequestV1 {
  return {
    schemaVersion: 1,
    frameType: "wave_request",
    requestId: requestID,
    sequence,
    waveIndex,
    calls: callIds.map((callId, index) => ({
      callId,
      toolName: "read",
      capabilityId: "files.read",
      arguments: { path: `file-${index}.txt` },
      argumentBytes: new TextEncoder().encode(JSON.stringify({ path: `file-${index}.txt` })).byteLength,
    })),
  }
}

function completed(sequence: string, status: CodeModeCompletedV1["status"] = "completed", output = "done", truncated?: boolean): CodeModeCompletedV1 {
  return {
    schemaVersion: 1,
    frameType: "completed",
    requestId: requestID,
    sequence,
    status,
    output,
    ...(truncated === undefined ? {} : { truncated }),
  }
}

function settled(frame: CodeModeWaveRequestV1, batchId = "batch-1"): CodeModeWaveSettlementV1 {
  const results: CodeModeCallResultV1[] = frame.calls.map((call, index) => {
    const output = `result-${index}`
    return {
      callId: call.callId,
      status: "settled",
      receiptKind: "tool_result",
      output,
      resultDigest: codeModeToolResultDigestV1(output),
      outputBytes: new TextEncoder().encode(output).byteLength,
      receiptRef: `receipt-${index + 1}`,
      receiptDigest: settle(String.fromCharCode(98 + index)),
    }
  })
  return {
    requestId: frame.requestId,
    waveIndex: frame.waveIndex,
    batchId,
    status: "settled",
    results,
    receiptDigest: codeModeWaveReceiptDigestV2(frame.waveIndex, results),
  }
}

function terminalStatus(status: "COMPLETE" | "CANCELLED" | "UNKNOWN"): CodeModeHostStateV1 {
  return {
    requestId: requestID,
    executionID,
    status,
    nextWave: 1,
    pendingBatchID: null,
    outerReceipt: status === "UNKNOWN"
      ? { status: "unknown" }
      : { status: "settled", receiptRef: "outer-1", receiptDigest: settle("f") },
  }
}

function fakeHost(input: {
  turns: CodeModeHostTurnV1[]
  inspect?: CodeModeHostStateV1
  enablement?: Readonly<Record<string, unknown>> | null
}) {
  const calls = { start: 0, resume: [] as Parameters<CodeModeHostAdapterV1["resume"]>[0][], cancel: [] as Parameters<CodeModeHostAdapterV1["cancel"]>[0][] }
  const adapter: CodeModeHostAdapterV1 = {
    enablement: async () => (input.enablement === undefined ? enablement : input.enablement),
    start: async () => {
      calls.start += 1
      const turn = input.turns.shift()
      if (!turn) throw new Error("unexpected start")
      return turn
    },
    resume: async (request) => {
      calls.resume.push(request)
      const turn = input.turns.shift()
      if (!turn) throw new Error("unexpected resume")
      return turn
    },
    cancel: async (request) => {
      calls.cancel.push(request)
      return input.inspect ?? terminalStatus("CANCELLED")
    },
    inspect: async () => input.inspect ?? terminalStatus("COMPLETE"),
  }
  return { adapter, calls }
}

test("completes a zero-nested-call pure-computation run without a nested receipt", async () => {
  const host = fakeHost({ turns: [{ executionID, frame: completed("1", "completed", "42") }] })
  let dispatches = 0
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return 42",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async () => {
      dispatches += 1
      throw new Error("must not dispatch")
    },
  })

  expect(outcome).toMatchObject({
    status: "completed",
    output: "42",
    waves: 0,
    totalCalls: 0,
    executionID,
    outerReceipt: { status: "settled", receiptRef: "outer-1" },
  })
  expect("nestedReceiptDigest" in outcome && outcome.nestedReceiptDigest).toBeFalsy()
  expect(dispatches).toBe(0)
  expect(host.calls.resume).toHaveLength(0)
})

test("dispatches one complete wave, binds its batch, and returns the ordered v2 run digest", async () => {
  const frame = wave("1", 0, ["call-1", "call-2"])
  const host = fakeHost({
    turns: [
      { executionID, frame },
      { executionID, frame: completed("3") },
    ],
  })
  const seen: CodeModeWaveRequestV1[] = []
  let settlement: CodeModeWaveSettlementV1 | undefined
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => {
      seen.push(input.frame)
      settlement = settled(input.frame)
      return settlement
    },
  })

  expect(seen).toHaveLength(1)
  expect(seen[0]).toEqual(frame)
  expect(host.calls.resume).toHaveLength(1)
  expect(host.calls.resume[0]!.waveResult).toMatchObject({
    frameType: "wave_result",
    requestId: requestID,
    sequence: "2",
    waveIndex: 0,
    batchId: "batch-1",
    status: "settled",
  })
  expect(outcome.status).toBe("completed")
  if (outcome.status !== "completed") return
  expect(outcome.waves).toBe(1)
  expect(outcome.totalCalls).toBe(2)
  expect(outcome.nestedReceiptDigest).toBe(codeModeRunReceiptDigestV2([
    { waveIndex: 0, rows: settlement!.results },
  ]))
})

test("stops after a denied/rejected wave and never admits a later wave", async () => {
  const frame = wave("1", 0, ["call-denied"])
  const rejection: CodeModeWaveSettlementV1 = {
    requestId: requestID,
    waveIndex: 0,
    batchId: "batch-denied",
    status: "rejected",
    results: [{
      callId: "call-denied",
      status: "rejected",
      receiptKind: "host_decision",
      receiptRef: "decision-1",
      receiptDigest: settle("a"),
      errorCode: "GUARD_DENIED",
    }],
    receiptDigest: codeModeWaveReceiptDigestV2(0, [{
      callId: "call-denied",
      status: "rejected",
      receiptKind: "host_decision",
      receiptRef: "decision-1",
      receiptDigest: settle("a"),
      errorCode: "GUARD_DENIED",
    }]),
  }
  const host = fakeHost({
    turns: [
      { executionID, frame },
      { executionID, frame: completed("3", "failed", "denied") },
    ],
  })
  let dispatches = 0
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async () => {
      dispatches += 1
      return rejection
    },
  })

  expect(dispatches).toBe(1)
  expect(host.calls.resume).toHaveLength(1)
  expect(outcome).toMatchObject({ status: "failed", waves: 1, totalCalls: 1, output: "denied" })
})

test("an UNKNOWN nested wave stops admission, cancels the helper, and never resumes", async () => {
  const frame = wave("1", 0, ["call-unknown"])
  const unknownRows: CodeModeCallResultV1[] = [{
    callId: "call-unknown",
    status: "unknown",
    receiptKind: null,
  }]
  const host = fakeHost({
    turns: [{ executionID, frame }],
    inspect: terminalStatus("UNKNOWN"),
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => ({
      requestId: input.frame.requestId,
      waveIndex: input.frame.waveIndex,
      batchId: "batch-unknown",
      status: "unknown",
      results: unknownRows,
    }),
  })

  expect(outcome).toMatchObject({ status: "unknown", waves: 1, totalCalls: 1 })
  expect(host.calls.resume).toHaveLength(0)
  expect(host.calls.cancel).toHaveLength(1)
  expect(host.calls.cancel[0]).toMatchObject({ reason: "parent_failure", executionID })
})

test("cancellation before launch returns cancelled without starting a helper", async () => {
  const controller = new AbortController()
  controller.abort()
  const host = fakeHost({ turns: [] })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return 1",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async () => {
      throw new Error("must not dispatch")
    },
    signal: controller.signal,
  })

  expect(outcome).toMatchObject({ status: "cancelled", waves: 0, totalCalls: 0 })
  expect(host.calls.start).toBe(0)
})

test("deadline aborts an in-flight wave and requests a deadline cancellation", async () => {
  const frame = wave("1", 0, ["call-slow"])
  const host = fakeHost({
    turns: [{ executionID, frame }],
    inspect: terminalStatus("UNKNOWN"),
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: ({ signal }) => new Promise<CodeModeWaveSettlementV1>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }),
    deadlineMs: 10,
  })

  expect(outcome.status).toBe("unknown")
  expect(host.calls.cancel).toHaveLength(1)
  expect(host.calls.cancel[0]!.reason).toBe("deadline")
})

test("rejects an over-limit wave output before admitting a later wave", async () => {
  const frame = wave("1", 0, ["call-huge"])
  const huge = "x".repeat(65_537)
  const host = fakeHost({
    turns: [{ executionID, frame }],
    inspect: terminalStatus("UNKNOWN"),
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => {
      const results: CodeModeCallResultV1[] = [{
        callId: "call-huge",
        status: "settled",
        receiptKind: "tool_result",
        output: huge,
        resultDigest: settle("a"),
        outputBytes: new TextEncoder().encode(huge).byteLength,
        receiptRef: "receipt-huge",
        receiptDigest: settle("b"),
      }]
      return {
        requestId: input.frame.requestId,
        waveIndex: input.frame.waveIndex,
        batchId: "batch-huge",
        status: "settled",
        results,
        receiptDigest: codeModeWaveReceiptDigestV2(input.frame.waveIndex, results),
      }
    },
  })

  // The public wave digest matches, but the aggregate output budget is
  // enforced before any later wave is admitted.
  expect(outcome.status).toBe("unknown")
  expect(host.calls.resume).toHaveLength(0)
})

test("deadline bounds a host start that never replies", async () => {
  const host = fakeHost({ turns: [] })
  host.adapter.start = () => new Promise<CodeModeHostTurnV1>(() => {})
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return 1",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async () => {
      throw new Error("must not dispatch")
    },
    deadlineMs: 10,
  })

  expect(outcome.status).toBe("unknown")
  expect(host.calls.cancel).toHaveLength(0)
})

test("missing enablement keeps CodeMode unavailable without launch", async () => {
  const host = fakeHost({ turns: [], enablement: null })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return 1",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async () => {
      throw new Error("must not dispatch")
    },
  })

  expect(outcome.status).toBe("unavailable")
  expect(host.calls.start).toBe(0)
})

test("refuses enablement whose fixed helper/resource pins or lane do not match", async () => {
  const cases: Array<Readonly<Record<string, unknown>>> = [
    { ...enablement, helperSelector: "horizoncode:codemode:node" },
    { ...enablement, helperDigest: blake("a") },
    { ...enablement, resourceProfileId: "codemode.v2" },
    { ...enablement, capabilityId: "codemode.exec" },
    { ...enablement, sessionID: "ses_a_different_session" },
    { ...enablement, lane: "managed_attempt" },
  ]
  for (const candidate of cases) {
    const host = fakeHost({ turns: [], enablement: candidate })
    const outcome = await runCodeModeConversationV1({
      requestID,
      code: "return 1",
      tools,
      binding,
      enablementRef: "grant-1",
      host: host.adapter,
      dispatchWave: async () => {
        throw new Error("must not dispatch")
      },
    })
    // Mismatched enablement is malformed host evidence, not an execution
    // claim: no helper is started and no success is reported.
    expect(outcome.status).toBe("unknown")
    expect(host.calls.start).toBe(0)
  }
})

test("refuses a settlement substituted for another wave or call ordering", async () => {
  const frame = wave("1", 0, ["call-1", "call-2"])
  const host = fakeHost({
    turns: [{ executionID, frame }, { executionID, frame: completed("3") }],
    inspect: terminalStatus("UNKNOWN"),
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => {
      const genuine = settled(input.frame)
      // HostKernel evidence issued for a different wave cannot be presented
      // for this pending one, and row order cannot be permuted.
      return { ...genuine, waveIndex: genuine.waveIndex + 1 }
    },
  })

  expect(outcome.status).toBe("unknown")
  expect(host.calls.resume).toHaveLength(0)
  expect(host.calls.cancel).toHaveLength(1)
})

test("rejects reused durable batch ids and receipt references across waves", async () => {
  const first = wave("1", 0, ["call-1"])
  const second = wave("3", 1, ["call-2"])
  const run = async (reuse: "batch" | "receipt") => {
    const host = fakeHost({
      turns: [{ executionID, frame: first }, { executionID, frame: second }, { executionID, frame: completed("5") }],
      inspect: terminalStatus("UNKNOWN"),
    })
    let dispatches = 0
    const outcome = await runCodeModeConversationV1({
      requestID,
      code: "return 1",
      tools,
      binding,
      enablementRef: "grant-1",
      host: host.adapter,
      dispatchWave: async (input) => {
        dispatches += 1
        const genuine = settled(input.frame, reuse === "batch" ? "batch-shared" : `batch-${input.frame.waveIndex}`)
        if (reuse === "batch") return genuine
        // Internally consistent rows that reuse one durable receipt reference
        // must still be refused: the aggregate digest alone is not authority.
        const results = genuine.results.map((row) => ({ ...row, receiptRef: "receipt-shared" }))
        return {
          ...genuine,
          results,
          receiptDigest: codeModeWaveReceiptDigestV2(input.frame.waveIndex, results),
        }
      },
    })
    return { outcome, dispatches, resumes: host.calls.resume.length }
  }

  for (const reuse of ["batch", "receipt"] as const) {
    const { outcome, dispatches, resumes } = await run(reuse)
    // A durable batch/receipt binding may not stand in for a second wave.
    expect(outcome.status).toBe("unknown")
    expect(dispatches).toBe(2)
    expect(resumes).toBe(1)
  }
})

test("keeps success unavailable when the settlement lacks authenticated receipt evidence", async () => {
  const frame = wave("1", 0, ["call-1"])
  const host = fakeHost({
    turns: [{ executionID, frame }, { executionID, frame: completed("3") }],
    inspect: terminalStatus("UNKNOWN"),
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => ({
      requestId: input.frame.requestId,
      waveIndex: input.frame.waveIndex,
      batchId: "batch-unreceipted",
      status: "settled",
      results: [{
        callId: "call-1",
        status: "settled",
        // The ordinary Core ToolBatch callback row carries only callID,
        // status, receiptRef and receiptDigest. It has no authenticated
        // receipt kind, so it cannot become a CodeMode receipt on its own.
        receiptKind: null,
        receiptRef: "receipt-1",
        receiptDigest: settle("b"),
      }],
    }),
  })

  expect(outcome.status).toBe("unknown")
  expect(host.calls.resume).toHaveLength(0)
  expect(host.calls.cancel).toHaveLength(1)
})

test("treats a cancelled wave as terminal and refuses a later helper wave", async () => {
  const frame = wave("1", 0, ["call-1"])
  const later = wave("3", 1, ["call-2"])
  const host = fakeHost({
    turns: [{ executionID, frame }, { executionID, frame: later }],
    inspect: terminalStatus("CANCELLED"),
  })
  let dispatches = 0
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return await tools.read({ path: 'file-0.txt' })",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => {
      dispatches += 1
      const results: CodeModeCallResultV1[] = [{
        callId: "call-1",
        status: "cancelled",
        receiptKind: "host_decision",
        receiptRef: "receipt-cancelled",
        receiptDigest: settle("a"),
        errorCode: "CANCELLED",
      }]
      return {
        requestId: input.frame.requestId,
        waveIndex: input.frame.waveIndex,
        batchId: "batch-cancelled",
        status: "cancelled",
        results,
        receiptDigest: codeModeWaveReceiptDigestV2(input.frame.waveIndex, results),
      }
    },
  })

  // A known cancellation is still settled with the helper, but it cannot buy
  // admission of another wave.
  expect(dispatches).toBe(1)
  expect(host.calls.resume).toHaveLength(1)
  expect(outcome.status).toBe("unknown")
})

// CM-003/CM-008: the script-wide wave budget is 64. A host that keeps offering
// waves must never get a 65th wave admitted or dispatched, and the run must not
// claim success once the bound is reached.
test("stops at the 64-wave script budget without admitting a 65th wave", async () => {
  const turns: CodeModeHostTurnV1[] = []
  for (let index = 0; index <= CODE_MODE_HELPER_LIMITS_V1.maxWaves; index++) {
    turns.push({ executionID, frame: wave(String(index * 2 + 1), index, [`call-${index}`]) })
  }
  turns.push({ executionID, frame: completed(String((CODE_MODE_HELPER_LIMITS_V1.maxWaves + 1) * 2 + 1)) })
  const host = fakeHost({ turns, inspect: terminalStatus("UNKNOWN") })
  const dispatched: number[] = []
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "for (;;) { await tools.read({ path: 'file-0.txt' }) }",
    tools,
    binding,
    enablementRef: "grant-1",
    host: host.adapter,
    dispatchWave: async (input) => {
      dispatched.push(input.frame.waveIndex)
      // Every wave needs its own durable batch and receipt bindings, so the
      // bound under test is the wave budget rather than a reused-id rejection.
      const results: CodeModeCallResultV1[] = input.frame.calls.map((call, index) => {
        const output = `result-${index}`
        return {
          callId: call.callId,
          status: "settled",
          receiptKind: "tool_result",
          output,
          resultDigest: codeModeToolResultDigestV1(output),
          outputBytes: new TextEncoder().encode(output).byteLength,
          receiptRef: `receipt-${input.frame.waveIndex}-${index}`,
          receiptDigest: settle((input.frame.waveIndex % 16).toString(16)),
        }
      })
      return {
        requestId: input.frame.requestId,
        waveIndex: input.frame.waveIndex,
        batchId: `batch-${input.frame.waveIndex}`,
        status: "settled",
        results,
        receiptDigest: codeModeWaveReceiptDigestV2(input.frame.waveIndex, results),
      }
    },
  })

  // Exactly 64 waves are admitted and settled; the 65th wave frame from the
  // host is refused as invalid helper evidence, so it is never dispatched.
  expect(dispatched).toHaveLength(CODE_MODE_HELPER_LIMITS_V1.maxWaves)
  expect(dispatched.at(-1)).toBe(CODE_MODE_HELPER_LIMITS_V1.maxWaves - 1)
  expect(host.calls.resume).toHaveLength(CODE_MODE_HELPER_LIMITS_V1.maxWaves)
  expect(host.calls.resume.every((request) => request.waveResult.waveIndex < CODE_MODE_HELPER_LIMITS_V1.maxWaves)).toBe(true)
  expect(outcome.status).not.toBe("completed")
  expect(outcome.waves).toBe(CODE_MODE_HELPER_LIMITS_V1.maxWaves)
  expect(outcome.totalCalls).toBe(CODE_MODE_HELPER_LIMITS_V1.maxWaves)
  expect(host.calls.cancel).toHaveLength(1)
  expect(host.calls.cancel[0]!.reason).toBe("parent_failure")
})

// CM-008: one trusted finite deadline (30s) is shared by the whole script and
// a caller can neither extend nor zero it.
test("keeps the trusted deadline inside the fixed 30-second script budget", async () => {
  expect(CODE_MODE_DEADLINE_MS_V1).toBe(30_000)
  expect(CODE_MODE_DEADLINE_MS_V1).toBe(CODE_MODE_HELPER_LIMITS_V1.maxExecutionMs)
  const host = fakeHost({ turns: [] })
  for (const deadlineMs of [30_001, 60_000, Number.MAX_SAFE_INTEGER, 0, -1, 1.5]) {
    await expect(runCodeModeConversationV1({
      requestID,
      code: "return 1",
      tools,
      binding,
      enablementRef: "grant-1",
      host: host.adapter,
      dispatchWave: async () => {
        throw new Error("must not dispatch")
      },
      deadlineMs,
    })).rejects.toThrow("fixed 30s budget")
  }
  // The deadline is validated before any host interaction.
  expect(host.calls.start).toBe(0)
})

// CM-012: the fixed helper manifest pin is an exact lowercase `sha256:` digest;
// no other algorithm, case, length or prefix may start the helper.
test("refuses enablement whose helper digest is not the exact sha256 manifest pin", async () => {
  const candidates = [
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `SHA256:${"a".repeat(64)}`,
    `blake3:${"a".repeat(64)}`,
    `"${"a".repeat(64)}"`,
    `sha256:`,
  ]
  for (const helperDigest of candidates) {
    const host = fakeHost({ turns: [], enablement: { ...enablement, helperDigest } })
    const outcome = await runCodeModeConversationV1({
      requestID,
      code: "return 1",
      tools,
      binding,
      enablementRef: "grant-1",
      host: host.adapter,
      dispatchWave: async () => {
        throw new Error("must not dispatch")
      },
    })
    expect(outcome.status).toBe("unknown")
    expect(host.calls.start).toBe(0)
  }
})

// CM-012: managed-lane enablement is bound to the exact Run/Task/Attempt, and a
// matching binding must still be able to run — so the negatives are not vacuous.
test("binds managed-lane enablement to the exact Run, Task and Attempt", async () => {
  const managedBinding: CodeModeLaneBindingV1 = {
    lane: "managed_attempt",
    runID: "run_1",
    taskID: "task_1",
    attemptID: "attempt_1",
  }
  const managedEnablement = {
    ...enablement,
    lane: "managed_attempt",
    runID: "run_1",
    taskID: "task_1",
    attemptID: "attempt_1",
  }

  const matching = fakeHost({
    turns: [{ executionID, frame: completed("1", "completed", "managed") }],
    enablement: managedEnablement,
  })
  const outcome = await runCodeModeConversationV1({
    requestID,
    code: "return 'managed'",
    tools,
    binding: managedBinding,
    enablementRef: "grant-1",
    host: matching.adapter,
    dispatchWave: async () => {
      throw new Error("must not dispatch")
    },
  })
  expect(outcome).toMatchObject({ status: "completed", output: "managed" })
  expect(matching.calls.start).toBe(1)

  for (const drift of [
    { runID: "run_2" },
    { taskID: "task_2" },
    { attemptID: "attempt_2" },
    { lane: "direct_session" },
  ]) {
    const host = fakeHost({ turns: [], enablement: { ...managedEnablement, ...drift } })
    const refused = await runCodeModeConversationV1({
      requestID,
      code: "return 1",
      tools,
      binding: managedBinding,
      enablementRef: "grant-1",
      host: host.adapter,
      dispatchWave: async () => {
        throw new Error("must not dispatch")
      },
    })
    expect(refused.status).toBe("unknown")
    expect(host.calls.start).toBe(0)
  }
})
