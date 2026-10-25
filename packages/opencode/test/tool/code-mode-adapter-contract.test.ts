/**
 * P5-owned adapter contract for §37.24 (CM-003/CM-005/CM-011/CM-012).
 *
 * The Core adapter (P7-owned) binds the request-scoped catalog plus the
 * prepare/settle/receipts/cancel boundary. This suite locks the two rules that
 * boundary must never violate, against the *production* dispatch path in
 * `src/session/tool-batch.ts` (which calls P1's authenticated surface at
 * `packages/core/src/session/supervisor.ts:6105-6230`: `codemode_prepare_wave`,
 * `codemode_settle_tool_results`, `codemode_wave_receipts`,
 * `codemode_cancel_wave`):
 *
 *   1. the adapter MUST call the `codemode_wave_receipts` projection for every
 *      wave before a settlement is returned, and
 *   2. the adapter MUST reject a wave whose projection is absent or mismatched.
 *
 * Every host value is an in-memory fake from `code-mode-wave-receipts.fixture`.
 * No HostKernel process, helper, provider, network or Git operation occurs, and
 * no readiness gate is enabled: the model-visible `execute` tool stays hidden.
 */

import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  codeModeToolContextFromBatchContext,
  createToolBatchContext,
  toolBatchMiddleware,
  type CodeModeToolBatchV1,
  type ToolBatchDefinition,
  type ToolBatchGateInput,
} from "../../src/session/tool-batch"
import { codeModeToolResultDigestV1 } from "../../src/tool/code-mode-protocol"
import { CODE_MODE_HELPER_RUNTIME_READY, CODE_MODE_TOOL, codeModeEnabled } from "../../src/tool/code-mode"
import {
  absentWaveProjection,
  mismatchedWaveProjection,
  orderedWaveFrame,
  projectionFromSettledResults,
  restartUnknownProjection,
  waveToolCatalog,
  type HostWaveProjectionFixture,
} from "./code-mode-wave-receipts.fixture"

const REQUEST_ID = "req_p5_wave_0"
const OUTER_CALL_ID = "call_outer_1"
const BATCH_ID = "batch_p5_wave_0"
const NESTED_OUTPUT = "nested fixture output"

const writeDefinition: ToolBatchDefinition = {
  capability: { id: "files.write", effectClass: "effect" },
  schema: {
    type: "object",
    properties: { filePath: { type: "string" }, content: { type: "string" } },
    required: ["filePath", "content"],
  },
  validate: async (value) => {
    const record = value as Record<string, unknown> | null
    if (!record || typeof record.filePath !== "string" || typeof record.content !== "string")
      throw new Error("invalid write")
    return value
  },
  normalize: (value) => {
    const record = value as { filePath: string; content: string }
    return { path: record.filePath, content: record.content }
  },
}

type Recorder = {
  readonly order: string[]
  readonly prepares: unknown[]
  readonly settles: { readonly callID: string; readonly requestID: string; readonly waveIndex: number; readonly results: readonly Record<string, unknown>[] }[]
  readonly receipts: { readonly callID: string; readonly requestID: string; readonly waveIndex: number }[]
  readonly cancels: { readonly callID: string; readonly requestID: string; readonly waveIndex: number; readonly reason: string }[]
  readonly executions: unknown[]
}

type Fixture = {
  readonly gate: ToolBatchGateInput
  readonly recorder: Recorder
}

function fixture(overrides?: {
  readonly projection?: (recorded: Recorder) => unknown
  readonly withoutReceipts?: boolean
  readonly failCallID?: string
  readonly abortDuringPrepare?: boolean
}): Fixture {
  const recorder: Recorder = { order: [], prepares: [], settles: [], receipts: [], cancels: [], executions: [] }
  const abort = new AbortController()

  const challengeFor = (callID: string) => ({
    challengeID: `challenge_${callID}`,
    effectID: `effect_${callID}`,
    target: `/workspace/${callID}.txt`,
    resource: `${callID}.txt`,
    existed: false,
  })

  const nested: Record<string, unknown> = {
    tools: waveToolCatalog(),
    executors: {
      write: {
        id: "write",
        description: "fixture executor",
        parameters: { type: "object" },
        execute: async (args: unknown) => {
          recorder.executions.push(args)
          recorder.order.push("execute")
          const filePath = String((args as { filePath?: string } | null)?.filePath ?? "")
          if (overrides?.failCallID && filePath === `/workspace/${overrides.failCallID}.txt`)
            throw new Error("provider transport lost after dispatch")
          return { content: [{ type: "text", text: NESTED_OUTPUT }] }
        },
      },
    },
    lane: "direct_session",
    prepare: async (request: {
      readonly callID: string
      readonly requestID: string
      readonly frame: { readonly waveIndex: number }
      readonly calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string }>
    }) => {
      recorder.order.push("prepare")
      recorder.prepares.push(request)
      // Cancellation requested while the prepare is in flight: the host
      // cancellation must be issued once the prepare resolves.
      if (overrides?.abortDuringPrepare) abort.abort(new Error("cancelled by user"))
      return {
        status: "admitted_batch",
        calls: request.calls.map((call) => ({
          callID: call.callID,
          capabilityID: call.capabilityID,
          challenge: challengeFor(call.callID),
        })),
        codeMode: {
          status: "BOUND",
          requestID: request.requestID,
          waveIndex: request.frame.waveIndex,
          batchID: BATCH_ID,
        },
      }
    },
    settleResults: async (request: {
      readonly callID: string
      readonly requestID: string
      readonly waveIndex: number
      readonly results: readonly Record<string, unknown>[]
    }) => {
      recorder.order.push("settle")
      recorder.settles.push({ callID: request.callID, requestID: request.requestID, waveIndex: request.waveIndex, results: request.results })
    },
    cancel: async (request: { readonly callID: string; readonly requestID: string; readonly waveIndex: number; readonly reason: string }) => {
      recorder.order.push("cancel")
      recorder.cancels.push({ callID: request.callID, requestID: request.requestID, waveIndex: request.waveIndex, reason: request.reason })
      const prepared = recorder.prepares.at(-1) as
        | { readonly calls: ReadonlyArray<{ readonly callID: string }> }
        | undefined
      return {
        status: "unknown",
        requestID: request.requestID,
        batchID: BATCH_ID,
        waveIndex: request.waveIndex,
        results: (prepared?.calls ?? []).map((call, index) => ({
          callIndex: index,
          callID: call.callID,
          status: "unknown",
          receiptKind: null,
          receiptRef: null,
          receiptDigest: null,
          resultDigest: null,
          outputBytes: null,
          errorCode: null,
        })),
        receiptDigest: null,
      }
    },
    receipts: async (request: { readonly callID: string; readonly requestID: string; readonly waveIndex: number }) => {
      recorder.order.push("receipts")
      recorder.receipts.push({ callID: request.callID, requestID: request.requestID, waveIndex: request.waveIndex })
      if (overrides?.projection) return overrides.projection(recorder)
      const settled = recorder.settles.at(-1)
      if (!settled) return absentWaveProjection()
      return projectionFromSettledResults({
        requestID: request.requestID,
        batchID: BATCH_ID,
        waveIndex: request.waveIndex,
        results: settled.results as never,
      })
    },
  }
  if (overrides?.withoutReceipts) delete nested.receipts

  const gate: ToolBatchGateInput = {
    sessionID: "ses_fixture_p5",
    locationRef: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
    turnContextDigest: `sha256:${"a".repeat(64)}`,
    signal: abort.signal,
    definitions: { write: writeDefinition },
    prepareToolBatch: async () => {
      throw new Error("ordinary ToolBatch admission must not run for a nested CodeMode wave")
    },
    cancelToolBatch: async () => {
      throw new Error("ordinary batch cancellation must not run for a nested CodeMode wave")
    },
    context: createToolBatchContext(),
    codeMode: nested as unknown as CodeModeToolBatchV1,
  }
  toolBatchMiddleware(gate)
  return { gate, recorder }
}

async function dispatchWave(input: Fixture, frame = orderedWaveFrame({ requestId: REQUEST_ID })) {
  const context = codeModeToolContextFromBatchContext(input.gate.context, OUTER_CALL_ID)
  if (!context) throw new Error("CodeMode dispatch context is unavailable")
  return context.dispatchWave({ requestID: REQUEST_ID, frame, signal: new AbortController().signal })
}

test("the adapter calls the codemode_wave_receipts projection exactly once per wave", async () => {
  const input = fixture()
  const settlement = await dispatchWave(input)

  expect(input.recorder.order).toEqual(["prepare", "execute", "settle", "receipts"])
  expect(input.recorder.receipts).toEqual([{ callID: OUTER_CALL_ID, requestID: REQUEST_ID, waveIndex: 0 }])
  expect(input.recorder.settles).toHaveLength(1)
  expect(input.recorder.settles[0]!.callID).toBe(OUTER_CALL_ID)
  expect(input.recorder.settles[0]!.results).toEqual([{
    callIndex: 0,
    callID: "call_w0",
    status: "settled",
    resultDigest: codeModeToolResultDigestV1(NESTED_OUTPUT),
    outputBytes: Buffer.byteLength(NESTED_OUTPUT, "utf8"),
  }])
  expect(settlement.status).toBe("settled")
  expect(settlement.batchId).toBe(BATCH_ID)
  expect(settlement.results[0]).toMatchObject({
    callId: "call_w0",
    status: "settled",
    receiptKind: "tool_result",
    output: NESTED_OUTPUT,
  })
  expect(typeof settlement.receiptDigest).toBe("string")
  expect(input.recorder.cancels).toEqual([])
})

test("an absent wave receipt projection never yields a settlement", async () => {
  const absent = fixture({ projection: () => absentWaveProjection() })
  await expect(dispatchWave(absent)).rejects.toThrow("malformed CodeMode receipt projection")
  expect(absent.recorder.order).toEqual(["prepare", "execute", "settle", "receipts", "cancel"])

  const missing = fixture({ withoutReceipts: true })
  await expect(dispatchWave(missing)).rejects.toThrow()
  expect(missing.recorder.settles).toHaveLength(1)
  expect(missing.recorder.receipts).toEqual([])
})

test("a mismatched wave receipt projection is rejected, never downgraded", async () => {
  const expectations: Record<string, string> = {
    wrong_request_id: "malformed CodeMode receipt projection",
    wrong_wave_index: "malformed CodeMode receipt projection",
    foreign_call_id: "not contiguous and correlated",
    missing_row: "omitted or added calls",
    reordered_rows: "not contiguous and correlated",
    forged_aggregate_digest: "aggregate receipt digest differs",
    substituted_tool_result_digest: "does not bind the exact Core callback result",
  }

  for (const [kind, message] of Object.entries(expectations)) {
    const input = fixture({
      projection: (recorded) => {
        const settled = recorded.settles.at(-1)!
        const base: HostWaveProjectionFixture = projectionFromSettledResults({
          requestID: REQUEST_ID,
          batchID: BATCH_ID,
          waveIndex: 0,
          results: settled.results as never,
        })
        return mismatchedWaveProjection(kind as never, base)
      },
    })
    await expect(dispatchWave(input)).rejects.toThrow(message)
    expect(input.recorder.receipts).toHaveLength(1)
    expect(input.recorder.settles).toHaveLength(1)
  }
})

test("a restart/UNKNOWN recovery projection stays receiptless", async () => {
  // The host lost the outcome of one nested call: dispatch may have happened,
  // so the wave must reconcile as UNKNOWN and must not claim an aggregate digest.
  const input = fixture({ failCallID: "call_w1" })
  const frame = orderedWaveFrame({ requestId: REQUEST_ID, callIDs: ["call_w0", "call_w1"] })
  const settlement = await dispatchWave(input, frame)

  expect(input.recorder.settles[0]!.results.map((row) => row.status)).toEqual(["settled", "unknown"])
  expect(settlement.status).toBe("unknown")
  expect(settlement.receiptDigest).toBeUndefined()
  expect(settlement.results.map((row) => row.status)).toEqual(["settled", "unknown"])
  expect(settlement.results[1]).toEqual({ callId: "call_w1", status: "unknown", receiptKind: null })
})

test("an UNKNOWN-only projection from a lost response is equally receiptless", async () => {
  const input = fixture({
    failCallID: "call_w0",
    projection: (recorded) => restartUnknownProjection({
      requestID: REQUEST_ID,
      batchID: BATCH_ID,
      waveIndex: 0,
      results: recorded.settles.at(-1)!.results as never,
    }),
  })
  const settlement = await dispatchWave(input)
  expect(settlement.status).toBe("unknown")
  expect(settlement.receiptDigest).toBeUndefined()
  expect(settlement.results).toEqual([{ callId: "call_w0", status: "unknown", receiptKind: null }])
})

test("cancellation stops undispatched work through the exact wave selector", async () => {
  const input = fixture({ abortDuringPrepare: true })
  await expect(dispatchWave(input)).rejects.toThrow("cancelled by user")

  expect(input.recorder.cancels).toEqual([{
    callID: OUTER_CALL_ID,
    requestID: REQUEST_ID,
    waveIndex: 0,
    reason: "parent_cancel",
  }])
  expect(input.recorder.executions).toEqual([])
  expect(input.recorder.settles).toEqual([])
  expect(input.recorder.receipts).toEqual([])
})

test("the wave dispatch boundary is unavailable without the nested adapter", () => {
  const abort = new AbortController()
  const gate: ToolBatchGateInput = {
    sessionID: "ses_fixture_p5",
    locationRef: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
    turnContextDigest: `sha256:${"a".repeat(64)}`,
    signal: abort.signal,
    definitions: { write: writeDefinition },
    prepareToolBatch: async () => {
      throw new Error("unreachable")
    },
    cancelToolBatch: async () => {},
    context: createToolBatchContext(),
  }
  toolBatchMiddleware(gate)
  expect(codeModeToolContextFromBatchContext(gate.context, OUTER_CALL_ID)).toBeUndefined()
  expect(codeModeToolContextFromBatchContext(createToolBatchContext(), OUTER_CALL_ID)).toBeUndefined()
})

test("CM-001: flags, enablement input and the tool name cannot enable CodeMode by themselves", () => {
  // The packaged-helper readiness gate is the only switch, and it is false.
  expect(CODE_MODE_HELPER_RUNTIME_READY).toBe(false)
  expect(CODE_MODE_TOOL).toBe("execute")
  expect(codeModeEnabled()).toBe(false)
  expect(codeModeEnabled({ runtimeReady: true })).toBe(false)
  expect(codeModeEnabled({ enablement: { granted: true } })).toBe(false)
  // Enablement-shaped model input can never satisfy the gate either.
  expect(codeModeEnabled({ runtimeReady: true, enablement: { from: "model arguments" } })).toBe(false)
})
