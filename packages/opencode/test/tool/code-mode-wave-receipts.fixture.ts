/**
 * P5 fixtures for the §37.24 CodeMode wave receipt contract (CM-003/005/006/011).
 *
 * These builders produce *host-shaped* values so a P5 test can prove the Core
 * adapter boundary fails closed: the adapter must call the
 * `codemode_wave_receipts` projection and must reject a wave whose projection
 * is absent or mismatched. Nothing here reaches HostKernel, Rust, a helper
 * process, or a provider — every value is an in-memory fake of the
 * authenticated surface at `packages/core/src/session/supervisor.ts:6105-6230`
 * (`codemode_prepare_wave`, `codemode_settle_tool_results`,
 * `codemode_wave_receipts`, `codemode_cancel_wave`).
 *
 * Fixtures:
 *   - ordered wave frames (canonical argument byte counts, contiguous call IDs)
 *   - receipt projections: present / absent / mismatched / UNKNOWN
 *   - cancellation and restart/UNKNOWN recovery inputs
 */

import { Buffer } from "node:buffer"
import {
  codeModeWaveReceiptDigestV2,
  type CodeModeCallResultV1,
  type CodeModeToolV1,
  type CodeModeWaveRequestV1,
} from "../../src/tool/code-mode-protocol"

/** One row of the authenticated `codemode_wave_receipts` projection. */
export type HostReceiptRowFixture = {
  readonly callIndex: number
  readonly callID: string
  readonly status: "settled" | "rejected" | "cancelled" | "unknown"
  readonly receiptKind: "effect_receipt" | "host_decision" | "tool_result" | null
  readonly receiptRef: string | null
  readonly receiptDigest: string | null
  readonly resultDigest: string | null
  readonly outputBytes: number | null
  readonly errorCode: string | null
}

/** Top-level shape of the `codemode_wave_receipts` projection. */
export type HostWaveProjectionFixture = {
  readonly status: "settled" | "rejected" | "cancelled" | "unknown"
  readonly requestID: string
  readonly batchID: string
  readonly waveIndex: number
  readonly results: readonly HostReceiptRowFixture[]
  readonly receiptDigest: string | null
}

const encoder = new TextEncoder()

/** Canonical JSON (sorted object keys) exactly as the frame validator computes it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries
      .map(([key, item]) => [key, item] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalArgumentBytes(argumentsValue: Record<string, unknown>): number {
  return encoder.encode(canonicalJson(argumentsValue)).byteLength
}

export type WaveFrameFixtureInput = {
  readonly requestId?: string
  readonly waveIndex?: number
  readonly callIDs?: readonly string[]
  readonly toolName?: string
  readonly capabilityId?: string
  readonly argumentsFor?: (callID: string) => Record<string, unknown>
}

/**
 * A complete, valid `wave_request` frame with contiguous, unique call IDs and
 * exact canonical `argumentBytes`, so `decodeCodeModeFrameV1` accepts it
 * without relaxing any bound.
 */
export function orderedWaveFrame(input: WaveFrameFixtureInput = {}): CodeModeWaveRequestV1 {
  const callIDs = input.callIDs ?? ["call_w0"]
  const toolName = input.toolName ?? "write"
  const capabilityId = input.capabilityId ?? "files.write"
  const waveIndex = input.waveIndex ?? 0
  if (callIDs.length === 0) throw new Error("wave frame fixture requires at least one call")
  return {
    schemaVersion: 1,
    frameType: "wave_request",
    requestId: input.requestId ?? "req_p5_wave_0",
    sequence: String(waveIndex),
    waveIndex,
    calls: callIDs.map((callId) => {
      const argumentsValue = input.argumentsFor
        ? input.argumentsFor(callId)
        : { filePath: `/workspace/${callId}.txt`, content: `body-${callId}` }
      return {
        callId,
        toolName,
        capabilityId,
        arguments: argumentsValue,
        argumentBytes: canonicalArgumentBytes(argumentsValue),
      }
    }),
  }
}

/** Bounded catalog entry matching the fixture frame's tool/capability pair. */
export function waveToolCatalog(): readonly CodeModeToolV1[] {
  return [{
    toolName: "write",
    capabilityId: "files.write",
    description: "Fixture write entry for the nested CodeMode catalog",
    inputSchema: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } } },
    inputSchemaDigest: `sha256:${"a".repeat(64)}`,
  }]
}

export function receiptRefFixture(callIndex: number): string {
  return `receipt_${callIndex}`
}

export function receiptDigestFixture(callIndex: number): string {
  return `blake3:${String((callIndex % 9) + 1).repeat(64)}`
}

/** Host rows derived from exact settled callback results (`tool_result` kind). */
export function settledToolResultRows(
  settled: ReadonlyArray<{ readonly callID: string; readonly resultDigest: string; readonly outputBytes: number }>,
): HostReceiptRowFixture[] {
  return settled.map((row, callIndex) => ({
    callIndex,
    callID: row.callID,
    status: "settled" as const,
    receiptKind: "tool_result" as const,
    receiptRef: receiptRefFixture(callIndex),
    receiptDigest: receiptDigestFixture(callIndex),
    resultDigest: row.resultDigest,
    outputBytes: row.outputBytes,
    errorCode: null,
  }))
}

/** Host rows for UNKNOWN outcomes: receiptless by construction. */
export function unknownReceiptRows(callIDs: readonly string[]): HostReceiptRowFixture[] {
  return callIDs.map((callID, callIndex) => ({
    callIndex,
    callID,
    status: "unknown" as const,
    receiptKind: null,
    receiptRef: null,
    receiptDigest: null,
    resultDigest: null,
    outputBytes: null,
    errorCode: null,
  }))
}

/** Host rows for a durable pre-dispatch denial/cancellation (`host_decision`). */
export function hostDecisionRows(callIDs: readonly string[], status: "rejected" | "cancelled"): HostReceiptRowFixture[] {
  return callIDs.map((callID, callIndex) => ({
    callIndex,
    callID,
    status,
    receiptKind: "host_decision" as const,
    receiptRef: `host_decision_${callIndex}`,
    receiptDigest: receiptDigestFixture(callIndex),
    resultDigest: null,
    outputBytes: null,
    errorCode: null,
  }))
}

function aggregateStatus(rows: readonly HostReceiptRowFixture[]): HostWaveProjectionFixture["status"] {
  if (rows.some((row) => row.status === "unknown")) return "unknown"
  if (rows.some((row) => row.status === "cancelled")) return "cancelled"
  if (rows.some((row) => row.status === "rejected")) return "rejected"
  return "settled"
}

function publicDigestRows(rows: readonly HostReceiptRowFixture[]): CodeModeCallResultV1[] {
  return rows.map((row) => ({
    callId: row.callID,
    status: row.status,
    receiptKind: row.receiptKind,
    receiptRef: row.receiptRef ?? undefined,
    receiptDigest: row.receiptDigest ?? undefined,
    ...(row.resultDigest === null ? {} : { resultDigest: row.resultDigest }),
    ...(row.outputBytes === null ? {} : { outputBytes: row.outputBytes }),
  }))
}

/**
 * A present, internally consistent `codemode_wave_receipts` projection.
 * UNKNOWN aggregates are receiptless (`receiptDigest: null`), matching the
 * §37.24 v2 contract; terminal aggregates carry the ordered v2 wave digest.
 */
export function waveReceiptProjection(input: {
  readonly requestID: string
  readonly batchID?: string
  readonly waveIndex: number
  readonly rows: readonly HostReceiptRowFixture[]
}): HostWaveProjectionFixture {
  const status = aggregateStatus(input.rows)
  return {
    status,
    requestID: input.requestID,
    batchID: input.batchID ?? "batch_p5_wave_0",
    waveIndex: input.waveIndex,
    results: input.rows,
    receiptDigest: status === "unknown"
      ? null
      : codeModeWaveReceiptDigestV2(input.waveIndex, publicDigestRows(input.rows)),
  }
}

export type SettledCallbackRowFixture = {
  readonly callIndex: number
  readonly callID: string
  readonly status: "settled" | "rejected" | "cancelled" | "unknown"
  readonly resultDigest?: string
  readonly outputBytes?: number
  readonly errorCode?: string
}

/**
 * Present projection derived from the exact `codemode_settle_tool_results`
 * payload the adapter sent, in call order: this is how HostKernel derives the
 * receipt rows from settled results instead of trusting callback claims.
 */
export function projectionFromSettledResults(input: {
  readonly requestID: string
  readonly batchID?: string
  readonly waveIndex: number
  readonly results: readonly SettledCallbackRowFixture[]
}): HostWaveProjectionFixture {
  const rows = input.results.map((row, index): HostReceiptRowFixture => {
    if (row.callIndex !== index) throw new Error("fixture settled results must be contiguous")
    if (row.status === "unknown") {
      return { callIndex: index, callID: row.callID, status: "unknown", receiptKind: null, receiptRef: null, receiptDigest: null, resultDigest: null, outputBytes: null, errorCode: null }
    }
    if (row.status === "settled") {
      if (row.resultDigest === undefined || row.outputBytes === undefined)
        throw new Error("fixture settled row lacks its exact callback result")
      return { callIndex: index, callID: row.callID, status: "settled", receiptKind: "tool_result", receiptRef: receiptRefFixture(index), receiptDigest: receiptDigestFixture(index), resultDigest: row.resultDigest, outputBytes: row.outputBytes, errorCode: null }
    }
    return { callIndex: index, callID: row.callID, status: row.status, receiptKind: "host_decision", receiptRef: `host_decision_${index}`, receiptDigest: receiptDigestFixture(index), resultDigest: null, outputBytes: null, errorCode: row.errorCode ?? null }
  })
  return waveReceiptProjection({ requestID: input.requestID, batchID: input.batchID, waveIndex: input.waveIndex, rows })
}

/** Present projection for an explicitly ordered settled/unknown call list. */
export function settledWaveProjection(input: {
  readonly requestID: string
  readonly batchID?: string
  readonly waveIndex: number
  readonly settled: ReadonlyArray<{ readonly callID: string; readonly resultDigest: string; readonly outputBytes: number }>
  readonly unknown?: readonly string[]
}): HostWaveProjectionFixture {
  const rows = [
    ...settledToolResultRows(input.settled),
    ...unknownReceiptRows(input.unknown ?? []),
  ].map((row, index) => ({ ...row, callIndex: index }))
  return waveReceiptProjection({ requestID: input.requestID, batchID: input.batchID, waveIndex: input.waveIndex, rows })
}

/** Absent projection: the adapter asked and the host answered with nothing. */
export function absentWaveProjection(): undefined {
  return undefined
}

/**
 * Restart/UNKNOWN recovery input: dispatch may have happened, the host lost the
 * outcome. Mixed settled/unknown rows aggregate as UNKNOWN with no digest, so
 * no caller can promote a partially recovered wave to success.
 */
export function restartUnknownProjection(input: {
  readonly requestID: string
  readonly batchID?: string
  readonly waveIndex: number
  readonly results: readonly SettledCallbackRowFixture[]
}): HostWaveProjectionFixture {
  return projectionFromSettledResults(input)
}

/** Mismatched projection variants — each violates exactly one correlation rule. */
export function mismatchedWaveProjection(
  kind: "wrong_request_id"
    | "wrong_wave_index"
    | "foreign_call_id"
    | "missing_row"
    | "reordered_rows"
    | "forged_aggregate_digest"
    | "substituted_tool_result_digest"
    | "unknown_claims_receipt",
  base: HostWaveProjectionFixture,
): HostWaveProjectionFixture {
  switch (kind) {
    case "wrong_request_id":
      return { ...base, requestID: "req_p5_other_wave" }
    case "wrong_wave_index":
      return { ...base, waveIndex: base.waveIndex + 1 }
    case "foreign_call_id":
      return {
        ...base,
        results: base.results.map((row, index) => (index === 0 ? { ...row, callID: "call_foreign" } : row)),
      }
    case "missing_row":
      return { ...base, results: base.results.slice(0, Math.max(0, base.results.length - 1)) }
    case "reordered_rows":
      // Row order no longer matches its contiguous call index.
      return { ...base, results: base.results.map((row) => ({ ...row, callIndex: row.callIndex + 1 })) }
    case "forged_aggregate_digest":
      return { ...base, receiptDigest: `blake3:${"f".repeat(64)}` }
    case "substituted_tool_result_digest":
      return {
        ...base,
        results: base.results.map((row, index) =>
          index === 0 ? { ...row, resultDigest: `blake3:${"c".repeat(64)}` } : row),
      }
    case "unknown_claims_receipt":
      return {
        ...base,
        results: base.results.map((row, index) =>
          index === 0 && row.status === "unknown"
            ? { ...row, receiptKind: "effect_receipt" as const, receiptRef: "receipt_0", receiptDigest: receiptDigestFixture(0) }
            : row),
      }
  }
}

/**
 * Pre-dispatch terminal cancellation projection returned by the adapter's
 * `codemode_cancel_wave` boundary (durable `host_decision` rows).
 */
export function preDispatchCancelledProjection(input: {
  readonly requestID: string
  readonly batchID?: string
  readonly waveIndex: number
  readonly callIDs: readonly string[]
}): Record<string, unknown> {
  const rows = hostDecisionRows(input.callIDs, "cancelled")
  return {
    status: "pre_dispatch_terminal",
    decision: "cancelled",
    requestID: input.requestID,
    batchID: input.batchID ?? "batch_p5_wave_0",
    waveIndex: input.waveIndex,
    results: rows,
    receiptDigest: codeModeWaveReceiptDigestV2(input.waveIndex, publicDigestRows(rows)),
  }
}
