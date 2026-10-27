import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import {
  decodeCodeModeFrameV1,
  encodeCodeModeFrameV1,
  makeCodeModeStartFrameV1,
  type CodeModeCompletedV1,
  type CodeModeStartV1,
  type CodeModeToolV1,
  type CodeModeWaveResultV1,
  type CodeModeWaveRequestV1,
  type CodeModeWaveSettlementV1,
} from "./code-mode-protocol"
import { runCodeModeConversationEffectV1, type CodeModeHostAdapterV1, type CodeModeRunOutcomeV1 } from "./code-mode-run"

/** Protocol tool-definition shape re-exported for SessionTools.resolve (P7). */
export type { CodeModeToolV1 } from "./code-mode-protocol"

export const CODE_MODE_TOOL = "execute"
/** Enabled only after P1/P2's supervised helper and Guarded wave transport land. */
export const CODE_MODE_HELPER_RUNTIME_READY = false

/**
 * Registry/UI gate for `codemode.execute`. Source presence, a runtime feature
 * flag, a plugin or an MCP catalog can never enable CodeMode: the packaged
 * helper acceptance flag and an exact host-authenticated enablement are both
 * required. Callers pass `runtimeReady` only from the trusted packaged-helper
 * readiness projection, never from model arguments.
 */
export function codeModeEnabled(input: {
  readonly runtimeReady?: boolean
  readonly enablement?: unknown
} = {}): boolean {
  return CODE_MODE_HELPER_RUNTIME_READY && input.runtimeReady === true &&
    input.enablement !== undefined && input.enablement !== null
}

const DESCRIPTION = "Run a bounded orchestration script over tools available to the current session."

/**
 * One member of the current bounded SessionTools.resolve authorized catalog.
 * It includes eligible deferred candidates for CodeMode's scoped progressive
 * search, while provider exposure remains controlled by the separate active
 * tool projection. Raw ToolRegistry or MCP catalogs are not valid substitutes.
 */
export type CodeModeEffectiveToolV1 = Omit<CodeModeToolV1, "inputSchemaDigest">

/**
 * P7's shared dispatcher receives a strict helper frame from P2, then invokes
 * HostKernel's atomic CodeMode-aware ordinary ToolBatch admission exactly once
 * for that complete wave. Rust owns batch IDs/indexes, Guard decisions, leases,
 * receipts and UNKNOWN recovery; the callback returns only its typed settlement.
 */
export type CodeModeDispatchWaveV1 = (input: {
  readonly requestID: string
  readonly frame: CodeModeWaveRequestV1
  readonly signal: AbortSignal
}) => Promise<CodeModeWaveSettlementV1>

/**
 * P7 supplies this request-scoped context from SessionTools.resolve. It is
 * intentionally data plus a single shared-dispatch callback: no Tool.Def,
 * MCP client, provider, filesystem handle or alternate executor crosses into
 * CodeMode.
 */
export type CodeModeToolContextV1 = {
  readonly tools: readonly CodeModeToolV1[]
  readonly dispatchWave: CodeModeDispatchWaveV1
  /**
   * Trusted adapter bound to the exact authenticated HostKernel operation
   * surface. It is supplied outside model input; absent means CodeMode stays
   * unavailable on this lane.
   */
  readonly host?: CodeModeHostAdapterV1
  /** Exact host-authenticated lane binding captured at the request boundary. */
  readonly lane?: CodeModeLaneBindingV1
  /** Exact non-secret enablement reference resolved by the trusted caller. */
  readonly enablementRef?: string
}

export const CODE_MODE_TOOL_CONTEXT_KEY_V1 = "horizonCodeModeV1"

/** Exact existing authenticated SessionSupervisor RPC surface; no socket/runtime is added. */
export type CodeModeHostKernelRequestV1 = (
  serviceID: "execution.v1",
  operation: "codemode_enablement" | "codemode_start" | "codemode_resume" | "codemode_cancel" | "codemode_inspect",
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>

export type CodeModeLaneBindingV1 =
  | { readonly lane: "direct_session"; readonly sessionID: string }
  | { readonly lane: "managed_attempt"; readonly runID: string; readonly taskID: string; readonly attemptID: string }

export type CodeModeHostTurnV1 = {
  readonly executionID: string
  readonly frame: CodeModeWaveRequestV1 | CodeModeCompletedV1
}

export type CodeModeHostStateV1 = {
  readonly requestId: string
  readonly executionID: string
  readonly status: "READY" | "WAVE_PENDING" | "COMPLETE" | "CANCELLED" | "UNKNOWN"
  readonly nextWave: number
  readonly pendingBatchID: string | null
  readonly outerReceipt: { readonly status: "settled"; readonly receiptRef: string; readonly receiptDigest: string } | { readonly status: "unknown" } | null
}

function hostRecord(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} is not an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== expected.length || expected.some((key) => !Object.hasOwn(result, key))) {
    throw new TypeError(`${label} has an unsupported or incomplete shape`)
  }
  return result
}

function hostID(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new TypeError(`${label} is invalid`)
}

function hostDigest(value: unknown, prefix: "sha256" | "blake3", label: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}:[a-f0-9]{64}$`).test(value)) throw new TypeError(`${label} is invalid`)
}

function hostDecimal(value: unknown, label: string, positive = false): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n || (positive && BigInt(value) === 0n)) {
    throw new TypeError(`${label} is not a decimal unsigned 64-bit value`)
  }
}

function validateLaneBindingV1(value: CodeModeLaneBindingV1): CodeModeLaneBindingV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("CodeMode lane binding is malformed")
  if (value.lane === "direct_session") {
    const binding = hostRecord(value, ["lane", "sessionID"], "direct CodeMode lane binding")
    if (typeof binding.sessionID !== "string" || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(binding.sessionID)) {
      throw new TypeError("CodeMode lane binding sessionID is invalid")
    }
    return Object.freeze({ lane: "direct_session", sessionID: binding.sessionID })
  }
  if (value.lane === "managed_attempt") {
    const binding = hostRecord(value, ["lane", "runID", "taskID", "attemptID"], "managed CodeMode lane binding")
    hostID(binding.runID, "runID")
    hostID(binding.taskID, "taskID")
    hostID(binding.attemptID, "attemptID")
    return Object.freeze({ lane: "managed_attempt", runID: binding.runID, taskID: binding.taskID, attemptID: binding.attemptID })
  }
  throw new TypeError("CodeMode lane binding has an unsupported lane")
}

/** Strict mirror of CodeModeEnablementV1; HostKernel still authenticates and derives its claims. */
export function validateCodeModeEnablementV1(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null) return null
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("CodeMode enablement is not an object")
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || input.capabilityId !== "codemode.execute" ||
    input.helperSelector !== "horizoncode:codemode:bun" || input.resourceProfileId !== "codemode.v1") {
    throw new TypeError("CodeMode enablement has unsupported fixed profile pins")
  }
  if (input.lane === "direct_session") {
    const keys = ["schemaVersion", "lane", "grantId", "principalDigest", "sessionID", "ownerEpoch", "capabilityId", "helperSelector", "helperDigest", "resourceProfileId", "resourceProfileDigest", "backend", "guaranteeDigest", "policyDigest", "issuedAtMs", "expiresAtMs", "revocationGeneration", "enablementDigest"]
    hostRecord(input, keys, "Direct CodeModeEnablementV1")
    hostID(input.grantId, "grantId")
    hostDigest(input.principalDigest, "sha256", "principalDigest")
    if (typeof input.sessionID !== "string" || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID)) throw new TypeError("CodeMode sessionID is invalid")
    hostDecimal(input.ownerEpoch, "ownerEpoch", true)
    hostDigest(input.helperDigest, "sha256", "helperDigest")
    hostDigest(input.resourceProfileDigest, "blake3", "resourceProfileDigest")
    hostDigest(input.guaranteeDigest, "blake3", "guaranteeDigest")
    hostDigest(input.policyDigest, "blake3", "policyDigest")
    hostDecimal(input.issuedAtMs, "issuedAtMs")
    hostDecimal(input.expiresAtMs, "expiresAtMs")
    hostDecimal(input.revocationGeneration, "revocationGeneration", true)
    hostDigest(input.enablementDigest, "blake3", "enablementDigest")
    if (input.backend !== "linux-cgroup-v2") throw new TypeError("CodeMode backend is not accepted")
  } else if (input.lane === "managed_attempt") {
    const keys = ["schemaVersion", "lane", "runID", "taskID", "attemptID", "ownerEpoch", "acceptedSpecVersionID", "acceptedSpecDigest", "profileID", "profileRevision", "profileDigest", "capabilityId", "helperSelector", "helperDigest", "resourceProfileId", "resourceProfileDigest"]
    hostRecord(input, keys, "Managed CodeModeEnablementV1")
    for (const key of ["runID", "taskID", "attemptID", "acceptedSpecVersionID", "profileID"]) hostID(input[key], key)
    hostDecimal(input.ownerEpoch, "ownerEpoch", true)
    hostDecimal(input.profileRevision, "profileRevision", true)
    hostDigest(input.acceptedSpecDigest, "sha256", "acceptedSpecDigest")
    hostDigest(input.profileDigest, "blake3", "profileDigest")
    hostDigest(input.helperDigest, "sha256", "helperDigest")
    hostDigest(input.resourceProfileDigest, "blake3", "resourceProfileDigest")
  } else {
    throw new TypeError("CodeMode enablement lane is invalid")
  }
  return Object.freeze({ ...input })
}

function decodeHelperTurn(value: unknown, expectedRequestID: string): CodeModeHostTurnV1 {
  const result = hostRecord(value, ["executionID", "frame"], "HostKernel CodeMode turn")
  hostID(result.executionID, "executionID")
  if (typeof result.frame !== "object" || result.frame === null || Array.isArray(result.frame)) {
    throw new TypeError("HostKernel CodeMode frame must be a strict versioned frame object")
  }
  const frame = decodeCodeModeFrameV1(new TextEncoder().encode(`${JSON.stringify(result.frame)}\n`))
  if ((frame.frameType !== "wave_request" && frame.frameType !== "completed") || frame.requestId !== expectedRequestID) {
    throw new TypeError("HostKernel returned an uncorrelated or non-helper CodeMode frame")
  }
  return { executionID: result.executionID, frame }
}

function decodeHostState(value: unknown, expectedRequestID: string, expectedExecutionID: string): CodeModeHostStateV1 {
  const result = hostRecord(value, ["requestId", "executionID", "status", "nextWave", "pendingBatchID", "outerReceipt"], "HostKernel CodeMode state")
  if (result.requestId !== expectedRequestID || result.executionID !== expectedExecutionID ||
    (result.status !== "READY" && result.status !== "WAVE_PENDING" && result.status !== "COMPLETE" && result.status !== "CANCELLED" && result.status !== "UNKNOWN") ||
    typeof result.nextWave !== "number" || !Number.isSafeInteger(result.nextWave) || result.nextWave < 0 || result.nextWave > 64 ||
    !(result.pendingBatchID === null || (typeof result.pendingBatchID === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(result.pendingBatchID)))) {
    throw new TypeError("HostKernel CodeMode state has invalid identity or cursor")
  }
  let outerReceipt: CodeModeHostStateV1["outerReceipt"]
  if (result.outerReceipt === null) {
    outerReceipt = null
  } else {
    const receipt = result.outerReceipt
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) throw new TypeError("HostKernel CodeMode outer receipt is malformed")
    const record = receipt as Record<string, unknown>
    if (record.status === "unknown") {
      hostRecord(record, ["status"], "UNKNOWN CodeMode outer receipt")
      outerReceipt = { status: "unknown" }
    } else if (record.status === "settled") {
      hostRecord(record, ["status", "receiptRef", "receiptDigest"], "settled CodeMode outer receipt")
      hostID(record.receiptRef, "receiptRef")
      hostDigest(record.receiptDigest, "blake3", "receiptDigest")
      outerReceipt = { status: "settled", receiptRef: record.receiptRef, receiptDigest: record.receiptDigest }
    } else {
      throw new TypeError("HostKernel CodeMode outer receipt status is invalid")
    }
  }
  if ((result.status === "UNKNOWN") !== (outerReceipt?.status === "unknown") ||
    ((result.status === "COMPLETE" || result.status === "CANCELLED") && outerReceipt?.status !== "settled") ||
    // An active execution has no terminal outer receipt yet; a settled or
    // UNKNOWN receipt on READY/WAVE_PENDING is a contradictory host state.
    ((result.status === "READY" || result.status === "WAVE_PENDING") && outerReceipt !== null) ||
    (result.status === "WAVE_PENDING" && result.pendingBatchID === null) ||
    ((result.status === "READY" || result.status === "COMPLETE" || result.status === "CANCELLED" || result.status === "UNKNOWN") && result.pendingBatchID !== null)) {
    throw new TypeError("HostKernel CodeMode state conflicts with its receipt or pending wave")
  }
  return {
    requestId: result.requestId,
    executionID: result.executionID,
    status: result.status,
    nextWave: result.nextWave,
    pendingBatchID: result.pendingBatchID,
    outerReceipt,
  }
}

/**
 * Thin Core adapter over SessionSupervisor.requestHostKernel. It only forwards
 * authenticated lane bindings and validates the existing bounded worker codec;
 * HostKernel remains the sole enablement, launch, receipt and recovery authority.
 * The operations stay unavailable until their Rust handlers are feature-negotiated.
 */
export function createCodeModeHostKernelAdapterV1(requestHostKernel: CodeModeHostKernelRequestV1) {
  const request = (operation: Parameters<CodeModeHostKernelRequestV1>[1], body: Readonly<Record<string, unknown>>) =>
    requestHostKernel("execution.v1", operation, body)
  return Object.freeze({
    async enablement(input: {
      readonly binding: CodeModeLaneBindingV1
      readonly action: "inspect" | "enable" | "revoke"
      readonly approvalRef?: string
    }) {
      const binding = validateLaneBindingV1(input.binding)
      if (input.action !== "inspect" && input.action !== "enable" && input.action !== "revoke") {
        throw new TypeError("CodeMode enablement action is invalid")
      }
      if ((binding.lane === "managed_attempt" && input.action !== "inspect") ||
        (binding.lane === "direct_session" && input.action === "enable" && input.approvalRef === undefined) ||
        (input.action !== "enable" && input.approvalRef !== undefined)) {
        throw new TypeError("CodeMode enablement requires the exact direct-session UserAction reference")
      }
      if (input.approvalRef !== undefined) hostID(input.approvalRef, "approvalRef")
      const result = await request("codemode_enablement", {
        schemaVersion: 1,
        ...binding,
        action: input.action,
        ...(input.approvalRef === undefined ? {} : { approvalRef: input.approvalRef }),
      })
      return validateCodeModeEnablementV1(result)
    },
    async start(input: {
      readonly binding: CodeModeLaneBindingV1
      readonly requestID: string
      readonly startFrame: CodeModeStartV1
      readonly enablementRef: string
    }): Promise<CodeModeHostTurnV1> {
      const binding = validateLaneBindingV1(input.binding)
      hostID(input.requestID, "requestID")
      hostID(input.enablementRef, "enablementRef")
      const bytes = encodeCodeModeFrameV1(input.startFrame)
      const frame = decodeCodeModeFrameV1(bytes)
      if (frame.frameType !== "start" || frame.requestId !== input.requestID) {
        throw new TypeError("CodeMode start frame does not match its host request identity")
      }
      const raw = await request("codemode_start", {
        schemaVersion: 1,
        ...binding,
        requestId: input.requestID,
        enablementRef: input.enablementRef,
        startFrame: frame,
      })
      return decodeHelperTurn(raw, input.requestID)
    },
    async resume(input: {
      readonly binding: CodeModeLaneBindingV1
      readonly requestID: string
      readonly executionID: string
      readonly waveResult: CodeModeWaveResultV1
    }): Promise<CodeModeHostTurnV1> {
      const binding = validateLaneBindingV1(input.binding)
      hostID(input.requestID, "requestID")
      hostID(input.executionID, "executionID")
      const bytes = encodeCodeModeFrameV1(input.waveResult)
      const frame = decodeCodeModeFrameV1(bytes)
      if (frame.frameType !== "wave_result" || frame.requestId !== input.requestID) {
        throw new TypeError("CodeMode wave result does not match its host request identity")
      }
      const raw = await request("codemode_resume", {
        schemaVersion: 1,
        ...binding,
        requestId: input.requestID,
        executionID: input.executionID,
        waveIndex: frame.waveIndex,
        waveResult: frame,
      })
      const turn = decodeHelperTurn(raw, input.requestID)
      if (turn.executionID !== input.executionID) throw new TypeError("HostKernel resumed a different CodeMode execution")
      return turn
    },
    async cancel(input: {
      readonly binding: CodeModeLaneBindingV1
      readonly requestID: string
      readonly executionID: string
      readonly reason: "user_abort" | "deadline" | "parent_failure" | "shutdown"
    }): Promise<CodeModeHostStateV1> {
      const binding = validateLaneBindingV1(input.binding)
      hostID(input.requestID, "requestID")
      hostID(input.executionID, "executionID")
      if (input.reason !== "user_abort" && input.reason !== "deadline" &&
        input.reason !== "parent_failure" && input.reason !== "shutdown") {
        throw new TypeError("CodeMode cancellation reason is invalid")
      }
      const result = await request("codemode_cancel", {
        schemaVersion: 1,
        ...binding,
        requestId: input.requestID,
        executionID: input.executionID,
        reason: input.reason,
      })
      return decodeHostState(result, input.requestID, input.executionID)
    },
    async inspect(input: {
      readonly binding: CodeModeLaneBindingV1
      readonly requestID: string
      readonly executionID: string
    }): Promise<CodeModeHostStateV1> {
      const binding = validateLaneBindingV1(input.binding)
      hostID(input.requestID, "requestID")
      hostID(input.executionID, "executionID")
      const result = await request("codemode_inspect", {
        schemaVersion: 1,
        ...binding,
        requestId: input.requestID,
        executionID: input.executionID,
      })
      return decodeHostState(result, input.requestID, input.executionID)
    },
  })
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = Object.create(null)
    for (const [key, child] of Object.entries(value)) copy[key] = freezeJson(child)
    return Object.freeze(copy)
  }
  return value
}

/** Pure projection helper. It carries no dispatcher or execution authority. */
export function canonicalizeCodeModeToolSetV1(tools: readonly CodeModeEffectiveToolV1[]): readonly CodeModeToolV1[] {
  const detached = tools.map((tool) => ({
    toolName: tool.toolName,
    capabilityId: tool.capabilityId,
    description: tool.description,
    inputSchema: freezeJson(tool.inputSchema) as Record<string, unknown>,
  }))
  // Reuse the strict start-frame validator for bounds, canonical schemas,
  // duplicate names and capability/tool ordering before retaining the set.
  const canonical = makeCodeModeStartFrameV1({ requestId: "codemode-context", code: "context", tools: detached })
  if (canonical.tools.some((tool) => tool.capabilityId === "codemode.execute" || tool.toolName === CODE_MODE_TOOL)) {
    throw new TypeError("CodeMode cannot recursively include its own capability")
  }
  return Object.freeze(canonical.tools.map((tool) => Object.freeze({
    toolName: tool.toolName,
    capabilityId: tool.capabilityId,
    description: tool.description,
    inputSchema: tool.inputSchema,
    inputSchemaDigest: tool.inputSchemaDigest,
  })))
}

/**
 * Project definitions only after SessionTools.resolve has selected the tools
 * visible to this provider request. Unsupported or internal definitions make
 * the projection invalid instead of silently widening/narrowing the catalog.
 */
export function projectCodeModeEffectiveToolsV1(input: readonly {
  readonly toolName: string
  readonly capabilityId: string
  readonly effectClass: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly internal?: boolean
}[]): readonly CodeModeEffectiveToolV1[] {
  const tools: CodeModeEffectiveToolV1[] = []
  for (const item of input) {
    if (item.internal || item.toolName === CODE_MODE_TOOL || item.capabilityId === "codemode.execute") continue
    // SessionTools.resolve is the authority for the exact currently visible
    // definitions. Do not duplicate its capability allowlist here: doing so
    // would silently exclude newly accepted guarded tools (including adapted
    // MCP/plugin tools) even though each call still passes through the shared
    // dispatcher and Rust Guard. Reject only effect classes that the shared
    // ToolBatch boundary does not define.
    if (item.effectClass !== "read_only" && item.effectClass !== "effect" && item.effectClass !== "control") {
      throw new TypeError(`CodeMode cannot project unsupported effect class for ${item.capabilityId}`)
    }
    tools.push({
      toolName: item.toolName,
      capabilityId: item.capabilityId,
      description: item.description,
      inputSchema: item.inputSchema,
    })
  }
  return canonicalizeCodeModeToolSetV1(tools).map(({ inputSchemaDigest: _digest, ...tool }) => tool)
}

export const Parameters = Schema.Struct({
  code: Schema.String
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(65_536))
    .check(Schema.makeFilter((code) =>
      new TextEncoder().encode(code).byteLength <= 65_536
        ? undefined
        : "CodeMode source exceeds its 65,536-byte limit",
    ))
    .annotate({ description: "Script body executed by the confined interpreter (maximum 65,536 UTF-8 bytes)." }),
})

type Metadata = {
  toolCalls: []
  status?: "completed" | "failed" | "cancelled" | "unknown" | "unavailable"
  waves?: number
  totalCalls?: number
  truncated?: boolean
  errorCode?: string
  error?: boolean
}

function codeModeToolContext(value: unknown): CodeModeToolContextV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.tools) || typeof input.dispatchWave !== "function") return undefined
  return value as CodeModeToolContextV1
}

function outcomeMessage(outcome: CodeModeRunOutcomeV1): string {
  switch (outcome.status) {
    case "completed":
      return outcome.output
    case "cancelled":
      return outcome.output || "Execution cancelled."
    case "failed":
      return outcome.output || "CodeMode execution failed."
    case "unknown":
      return outcome.output || "CodeMode outcome is unknown; no later wave was admitted."
    case "unavailable":
      return outcome.output || "CodeMode is unavailable."
    default:
      return "CodeMode is unavailable."
  }
}

const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
  description: DESCRIPTION,
  parameters: Parameters,
  capability: { id: "codemode.execute", effectClass: "effect" },
  execute: (params, ctx) => {
    if (ctx.abort.aborted) {
      return Effect.succeed({
        title: CODE_MODE_TOOL,
        metadata: { toolCalls: [], status: "cancelled" as const, error: true },
        output: "Execution cancelled.",
      } satisfies Tool.ExecuteResult<Metadata>)
    }
    if (!CODE_MODE_HELPER_RUNTIME_READY) {
      return Effect.succeed({
        title: CODE_MODE_TOOL,
        metadata: { toolCalls: [], status: "unavailable" as const, error: true },
        output: "CodeMode is unavailable until its supervised helper and authenticated Guarded wave transport are accepted.",
      } satisfies Tool.ExecuteResult<Metadata>)
    }
    const context = codeModeToolContext(ctx.extra?.[CODE_MODE_TOOL_CONTEXT_KEY_V1])
    if (!context?.host || !context.lane || !context.enablementRef || !ctx.callID) {
      return Effect.succeed({
        title: CODE_MODE_TOOL,
        metadata: { toolCalls: [], status: "unavailable" as const, error: true },
        output: "CodeMode is unavailable for this request: no authenticated helper lane, enablement reference or bounded wave dispatcher was bound.",
      } satisfies Tool.ExecuteResult<Metadata>)
    }
    if (context.lane.lane === "direct_session" && context.lane.sessionID !== ctx.sessionID) {
      return Effect.succeed({
        title: CODE_MODE_TOOL,
        metadata: { toolCalls: [], status: "unavailable" as const, error: true },
        output: "CodeMode lane binding does not match the authenticated Session.",
      } satisfies Tool.ExecuteResult<Metadata>)
    }
    return runCodeModeConversationEffectV1({
      requestID: ctx.callID,
      code: params.code,
      tools: context.tools,
      binding: context.lane,
      enablementRef: context.enablementRef,
      host: context.host,
      dispatchWave: context.dispatchWave,
      signal: ctx.abort,
    }).pipe(Effect.map((outcome) => ({
      title: CODE_MODE_TOOL,
      metadata: {
        toolCalls: [] as [],
        status: outcome.status,
        waves: outcome.waves,
        totalCalls: outcome.totalCalls,
        ...("truncated" in outcome ? { truncated: outcome.truncated } : {}),
        ...("errorCode" in outcome && outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        error: outcome.status !== "completed",
      } satisfies Metadata,
      output: outcomeMessage(outcome),
    })))
  },
}

export const CodeModeTool = Tool.define(CODE_MODE_TOOL, Effect.succeed(init))
