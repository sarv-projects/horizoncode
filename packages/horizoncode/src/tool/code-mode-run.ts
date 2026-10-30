/**
 * Core-side CodeMode turn loop.
 *
 * This module only sequences the bounded helper frames over the authenticated
 * HostKernel adapter and the ordinary ToolBatch wave dispatcher. It never
 * launches a process, interprets a second script, dispatches a nested tool
 * itself, or invents a receipt. HostKernel owns enablement, the fixed helper
 * launch, Guard/lease settlement, cancellation and durable outer receipts;
 * P7's dispatcher owns ordinary ToolBatch admission for each complete wave.
 */
import { Effect } from "effect"
import {
  CODE_MODE_FRAME_LIMITS_V1,
  CodeModeConversationV1,
  makeCodeModeStartFrameV1,
  type CodeModeCompletedV1,
  type CodeModeToolV1,
  type CodeModeWaveRequestV1,
} from "./code-mode-protocol"
import type {
  CodeModeDispatchWaveV1,
  CodeModeHostStateV1,
  CodeModeHostTurnV1,
  CodeModeLaneBindingV1,
} from "./code-mode"

/** §37.24: one trusted monotonic deadline shared by the whole script. */
export const CODE_MODE_DEADLINE_MS_V1 = 30_000
/** §37.24: aggregate model-facing output bound for one script. */
export const CODE_MODE_MAX_OUTPUT_BYTES_V1 = CODE_MODE_FRAME_LIMITS_V1.maxOutputBytes

export type CodeModeHostAdapterV1 = {
  enablement(input: {
    readonly binding: CodeModeLaneBindingV1
    readonly action: "inspect"
  }): Promise<Readonly<Record<string, unknown>> | null>
  start(input: {
    readonly binding: CodeModeLaneBindingV1
    readonly requestID: string
    readonly startFrame: ReturnType<typeof makeCodeModeStartFrameV1>
    readonly enablementRef: string
  }): Promise<CodeModeHostTurnV1>
  resume(input: {
    readonly binding: CodeModeLaneBindingV1
    readonly requestID: string
    readonly executionID: string
    readonly waveResult: ReturnType<CodeModeConversationV1["makeHostWaveResult"]>
  }): Promise<CodeModeHostTurnV1>
  cancel(input: {
    readonly binding: CodeModeLaneBindingV1
    readonly requestID: string
    readonly executionID: string
    readonly reason: "user_abort" | "deadline" | "parent_failure" | "shutdown"
  }): Promise<CodeModeHostStateV1>
  inspect(input: {
    readonly binding: CodeModeLaneBindingV1
    readonly requestID: string
    readonly executionID: string
  }): Promise<CodeModeHostStateV1>
}

export type CodeModeRunOutcomeV1 =
  | {
      readonly status: "completed"
      readonly output: string
      readonly truncated: boolean
      readonly executionID: string
      readonly waves: number
      readonly totalCalls: number
      /** Omitted for the zero-nested-call pure-computation case. */
      readonly nestedReceiptDigest?: string
      readonly outerReceipt: { readonly receiptRef: string; readonly receiptDigest: string }
    }
  | {
      readonly status: "failed" | "cancelled" | "unknown" | "unavailable"
      readonly output: string
      readonly errorCode?: string
      readonly executionID?: string
      readonly waves: number
      readonly totalCalls: number
      readonly nestedReceiptDigest?: string
    }

function validateEnablement(
  enablement: Readonly<Record<string, unknown>> | null,
  binding: CodeModeLaneBindingV1,
): void {
  if (enablement === null) return
  if (enablement.lane !== binding.lane || enablement.capabilityId !== "codemode.execute" ||
    enablement.helperSelector !== "horizoncode:codemode:bun" || enablement.resourceProfileId !== "codemode.v1") {
    throw new TypeError("CodeMode enablement does not match the fixed capability/helper/resource profile")
  }
  // The fixed helper manifest pin is a SHA-256 content digest. A blake3 value
  // or another algorithm is not the packaged-helper identity and cannot be
  // accepted even if the rest of the enablement claims the right selector.
  if (typeof enablement.helperDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(enablement.helperDigest)) {
    throw new TypeError("CodeMode enablement does not pin the fixed helper SHA-256 manifest digest")
  }
  if (binding.lane === "direct_session") {
    if (enablement.sessionID !== binding.sessionID) throw new TypeError("CodeMode direct enablement belongs to another Session")
  } else if (binding.lane === "managed_attempt") {
    if (enablement.runID !== binding.runID || enablement.taskID !== binding.taskID ||
      enablement.attemptID !== binding.attemptID) {
      throw new TypeError("CodeMode managed enablement belongs to another Attempt")
    }
  }
}

function boundOutput(value: string): { output: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= CODE_MODE_MAX_OUTPUT_BYTES_V1) return { output: value, truncated: false }
  // The helper protocol already bounds this field. Still fail closed rather
  // than truncating here: a host/transport that bypassed the frame codec is
  // not trusted to have preserved the exact output.
  throw new RangeError("CodeMode completed output exceeds its aggregate byte bound")
}

function terminalOutput(value: string | undefined): string {
  if (value === undefined) return ""
  return boundOutput(value).output
}

/** Race a host RPC against the one script-wide cancellation/deadline signal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Drive one already-authorized CodeMode run. Expected outcomes are returned as
 * typed results; malformed host evidence throws so the caller cannot mistake it
 * for success. No retry is attempted after any possibly-dispatched wave.
 */
export async function runCodeModeConversationV1(input: {
  readonly requestID: string
  readonly code: string
  readonly tools: readonly Omit<CodeModeToolV1, "inputSchemaDigest">[]
  readonly binding: CodeModeLaneBindingV1
  readonly enablementRef: string
  readonly host: CodeModeHostAdapterV1
  readonly dispatchWave: CodeModeDispatchWaveV1
  readonly signal?: AbortSignal
  /** Test-only; production callers always use CODE_MODE_DEADLINE_MS_V1. */
  readonly deadlineMs?: number
}): Promise<CodeModeRunOutcomeV1> {
  const deadlineMs = input.deadlineMs ?? CODE_MODE_DEADLINE_MS_V1
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > CODE_MODE_DEADLINE_MS_V1) {
    throw new RangeError("CodeMode deadline must be a positive value within the fixed 30s budget")
  }
  if (input.signal?.aborted) {
    return { status: "cancelled", output: "Execution cancelled.", waves: 0, totalCalls: 0 }
  }

  const startFrame = makeCodeModeStartFrameV1({
    requestId: input.requestID,
    code: input.code,
    tools: input.tools,
  })
  const conversation = new CodeModeConversationV1(startFrame)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException("CodeMode deadline exceeded", "TimeoutError")), deadlineMs)
  const signal = input.signal === undefined
    ? deadline.signal
    : AbortSignal.any([input.signal, deadline.signal])
  const abortReason = (): "user_abort" | "deadline" =>
    deadline.signal.aborted ? "deadline" : "user_abort"

  let executionID: string | undefined
  let waves = 0
  let totalCalls = 0

  const stopHost = async (reason: "user_abort" | "deadline" | "parent_failure" | "shutdown") => {
    if (executionID === undefined) return
    try {
      await input.host.cancel({ binding: input.binding, requestID: input.requestID, executionID, reason })
    } catch {
      // Core cannot manufacture settlement. HostKernel reconciliation remains
      // authoritative when its private cancel RPC is unavailable.
    }
  }

  try {
    const enablement = await abortable(input.host.enablement({ binding: input.binding, action: "inspect" }), signal)
    validateEnablement(enablement, input.binding)
    if (enablement === null) {
      return {
        status: "unavailable",
        output: "CodeMode is not enabled for this lane; no helper was launched.",
        waves: 0,
        totalCalls: 0,
      }
    }
    if (signal.aborted) {
      return { status: "cancelled", output: "Execution cancelled.", waves: 0, totalCalls: 0 }
    }

    let turn = await abortable(input.host.start({
      binding: input.binding,
      requestID: input.requestID,
      startFrame,
      enablementRef: input.enablementRef,
    }), signal)
    executionID = turn.executionID

    for (;;) {
      if (signal.aborted) {
        await stopHost(abortReason())
        const settled = await inspectHostState(input.host, input.binding, input.requestID, executionID)
        // A wave that was never admitted is a known cancellation. If one was
        // in flight or already settled, the durable state decides.
        if (waves === 0 && settled?.status === "CANCELLED" && settled.outerReceipt?.status === "settled") {
          conversation.acceptOuterExecutionReceipt(settled.outerReceipt)
          return { status: "cancelled", output: "Execution cancelled.", waves, totalCalls }
        }
        if (settled?.status === "CANCELLED" && settled.outerReceipt?.status === "settled") {
          conversation.acceptOuterExecutionReceipt(settled.outerReceipt)
          return { status: "cancelled", output: "Execution cancelled.", waves, totalCalls }
        }
        return { status: "unknown", output: "CodeMode cancellation outcome is unknown; no later wave was admitted.", waves, totalCalls }
      }

      const frame = turn.frame
      if (frame.frameType === "completed") {
        conversation.acceptHelperFrame(frame)
        totalCalls = conversation.totalCalls
        break
      }

      conversation.acceptHelperFrame(frame)
      totalCalls = conversation.totalCalls
      if (signal.aborted) {
        await stopHost(abortReason())
        return { status: "unknown", output: "CodeMode wave was not completed after cancellation.", waves, totalCalls }
      }

      let settlement
      try {
        settlement = await input.dispatchWave({ requestID: input.requestID, frame, signal })
      } catch {
        await stopHost(signal.aborted ? abortReason() : "parent_failure")
        return {
          status: "unknown",
          output: "CodeMode nested wave outcome is unknown; no later wave was admitted.",
          waves,
          totalCalls,
        }
      }
      if (signal.aborted) {
        await stopHost(abortReason())
        return {
          status: "unknown",
          output: "CodeMode nested wave completed after cancellation; its settlement must be reconciled.",
          waves,
          totalCalls,
        }
      }

      conversation.bindPreparedBatch(settlement.batchId)
      const waveResult = conversation.makeHostWaveResult(settlement)
      waves += 1
      if (waves > CODE_MODE_FRAME_LIMITS_V1.maxWaves) {
        throw new RangeError("CodeMode exceeded its script-wide wave budget")
      }
      if (settlement.status === "unknown") {
        // The helper must not receive an UNKNOWN result frame. HostKernel owns
        // reconciliation; Core stops admission and terminates the helper.
        await stopHost("parent_failure")
        const state = await inspectHostState(input.host, input.binding, input.requestID, executionID)
        if (state?.outerReceipt?.status === "unknown") {
          conversation.acceptOuterExecutionReceipt({ status: "unknown" })
        }
        return {
          status: "unknown",
          output: "CodeMode stopped after an UNKNOWN nested wave; no later wave was admitted.",
          waves,
          totalCalls,
        }
      }

      turn = await abortable(input.host.resume({
        binding: input.binding,
        requestID: input.requestID,
        executionID,
        waveResult,
      }), signal)
      if (turn.executionID !== executionID) throw new TypeError("HostKernel resumed a different CodeMode execution")
      if ((settlement.status === "rejected" || settlement.status === "cancelled") && turn.frame.frameType === "wave_request") {
        throw new TypeError("CodeMode helper requested a later wave after a terminal wave outcome")
      }
    }

    const completed = conversation.helperOutcome
    const state = await inspectHostState(input.host, input.binding, input.requestID, executionID)
    if (state?.status === "UNKNOWN" || state?.outerReceipt?.status === "unknown" || state === undefined) {
      conversation.acceptOuterExecutionReceipt({ status: "unknown" })
      return {
        status: "unknown",
        output: "CodeMode helper completed, but its durable outer receipt is UNKNOWN.",
        waves,
        totalCalls,
      }
    }
    if (state.outerReceipt?.status !== "settled" || state.status !== "COMPLETE" && state.status !== "CANCELLED") {
      // A completed helper without a settled outer process receipt is not
      // execution evidence. Preserve UNKNOWN instead of claiming completion.
      conversation.acceptOuterExecutionReceipt({ status: "unknown" })
      return {
        status: "unknown",
        output: "CodeMode helper completed without a settled outer process receipt.",
        waves,
        totalCalls,
      }
    }
    conversation.acceptOuterExecutionReceipt(state.outerReceipt)
    const output = terminalOutput((turn.frame as CodeModeCompletedV1).output)
    const truncated = (turn.frame as CodeModeCompletedV1).truncated === true
    const nestedReceiptDigest = conversation.nestedReceiptDigest
    if (completed === "cancelled" || state.status === "CANCELLED") {
      return {
        status: "cancelled",
        output,
        waves,
        totalCalls,
        ...(nestedReceiptDigest === undefined ? {} : { nestedReceiptDigest }),
      }
    }
    if (completed !== "completed") {
      return {
        status: "failed",
        output,
        waves,
        totalCalls,
        ...(nestedReceiptDigest === undefined ? {} : { nestedReceiptDigest }),
      }
    }
    return {
      status: "completed",
      output,
      truncated,
      executionID,
      waves,
      totalCalls,
      ...(nestedReceiptDigest === undefined ? {} : { nestedReceiptDigest }),
      outerReceipt: state.outerReceipt,
    }
  } catch (error) {
    await stopHost("parent_failure")
    if (error instanceof RangeError && /budget/.test(error.message)) {
      return { status: "failed", output: "CodeMode exceeded its bounded execution budget.", waves, totalCalls }
    }
    return {
      status: "unknown",
      output: "CodeMode host evidence was malformed or incomplete; no success was claimed.",
      errorCode: "CODEMODE_PROTOCOL_ERROR",
      waves,
      totalCalls,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function inspectHostState(
  host: CodeModeHostAdapterV1,
  binding: CodeModeLaneBindingV1,
  requestID: string,
  executionID: string,
): Promise<CodeModeHostStateV1 | undefined> {
  try {
    return await host.inspect({ binding, requestID, executionID })
  } catch {
    return undefined
  }
}

/** Effect wrapper for the tool boundary; the loop itself is transport-plain. */
export function runCodeModeConversationEffectV1(
  input: Parameters<typeof runCodeModeConversationV1>[0],
): Effect.Effect<CodeModeRunOutcomeV1> {
  return Effect.tryPromise({
    try: () => runCodeModeConversationV1(input),
    catch: (error) => (error instanceof Error ? error : new Error("CodeMode run failed")),
  }).pipe(Effect.catch(() => Effect.succeed({
    status: "unknown" as const,
    output: "CodeMode host evidence was malformed or incomplete; no success was claimed.",
    errorCode: "CODEMODE_PROTOCOL_ERROR",
    waves: 0,
    totalCalls: 0,
  })))
}
