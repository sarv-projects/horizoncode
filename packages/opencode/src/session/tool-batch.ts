import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import type { EffectAdmission, EffectChallenge, GuardedToolCall } from "@opencode-ai/core/session/supervisor"
import type { Capability } from "@/tool/tool"

// Bound provider-supplied tool calls at the streaming boundary, before parsing,
// asynchronous validation, Guard preparation or callback dispatch. These limits
// intentionally apply to read-only calls too, so a provider cannot build an
// unbounded pending array while waiting for a terminal tool-calls finish.
const MAX_TOOL_BATCH_CALLS = 32
const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024
const MAX_TOOL_BATCH_ARGUMENT_BYTES = 512 * 1024
const MAX_TOOL_IDENTITY_BYTES = 256

export type ToolBatchDefinition = {
  readonly capability: Capability
  readonly schema: unknown
  readonly validate: (input: unknown) => Promise<unknown>
  readonly normalize?: (input: unknown) => unknown
  readonly internal?: boolean
}

export type ToolCallOutcome =
  | { readonly status: "allowed" }
  | { readonly status: "admitted"; readonly challenge: EffectChallenge }
  | { readonly status: "denied"; readonly reason: string }

export type ToolBatchContext = {
  readonly outcomes: Map<string, ToolCallOutcome>
}

export function createToolBatchContext(): ToolBatchContext {
  return { outcomes: new Map() }
}

export function toolCallOutcome(context: unknown, callID?: string): ToolCallOutcome | undefined {
  if (!callID || typeof context !== "object" || context === null || !("outcomes" in context)) return undefined
  const outcomes = context.outcomes
  if (!(outcomes instanceof Map)) return undefined
  const value: unknown = outcomes.get(callID)
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined
  if (value.status === "allowed") return { status: "allowed" }
  if (value.status === "denied" && "reason" in value && typeof value.reason === "string")
    return { status: "denied", reason: value.reason }
  if (value.status === "admitted" && "challenge" in value && isEffectChallenge(value.challenge))
    return { status: "admitted", challenge: value.challenge }
  return undefined
}

function isEffectChallenge(value: unknown): value is EffectChallenge {
  return (
    typeof value === "object" &&
    value !== null &&
    "challengeID" in value &&
    typeof value.challengeID === "string" &&
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "target" in value &&
    typeof value.target === "string" &&
    "resource" in value &&
    typeof value.resource === "string" &&
    "existed" in value &&
    typeof value.existed === "boolean"
  )
}

export function requireToolExecution(input: {
  readonly context: unknown
  readonly callID?: string
  readonly capability: Capability
  readonly internal?: boolean
}): EffectChallenge | undefined {
  const outcome = toolCallOutcome(input.context, input.callID)
  if (outcome?.status === "denied") throw new Error(`Tool batch denied: ${outcome.reason}`)

  if (input.capability.effectClass === "effect") {
    if (outcome?.status !== "admitted") throw new Error("Tool batch denied: missing Rust Guard admission")
    return outcome.challenge
  }
  if (input.capability.effectClass === "unknown") {
    throw new Error("Tool batch denied: capability is unknown")
  }
  if (input.capability.effectClass === "control" && !input.internal) {
    throw new Error("Tool batch denied: unsupported control capability")
  }
  return undefined
}

export type ToolBatchGateInput = {
  readonly sessionID: string
  readonly turnContextDigest: string
  readonly signal: AbortSignal
  readonly definitions: Readonly<Record<string, ToolBatchDefinition>>
  readonly prepareToolBatch: (request: {
    readonly sessionID: string
    readonly batchID: string
    readonly turnContextDigest: string
    readonly calls: ReadonlyArray<GuardedToolCall>
  }) => Promise<EffectAdmission>
  readonly context: ToolBatchContext
}

export function toolBatchMiddleware(input: ToolBatchGateInput): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream }) {
      const result = await doStream()
      return { ...result, stream: gateToolCallStream(result.stream, input) }
    },
  }
}

export function gateToolCallStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  input: ToolBatchGateInput,
): ReadableStream<LanguageModelV3StreamPart> {
  const pending: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>[] = []
  let pendingArgumentBytes = 0
  let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined

  return stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        if (finish) throw new Error("Provider emitted data after finish")
        if (part.type === "tool-call") {
          if (pending.length >= MAX_TOOL_BATCH_CALLS)
            throw new Error("Tool batch limit exceeded: call count")
          // The provider protocol defines input as JSON text. Reject malformed
          // runtime shapes rather than allowing an object to evade byte caps.
          if (typeof part.toolCallId !== "string" || typeof part.toolName !== "string")
            throw new Error("Tool batch limit exceeded: tool identity")
          if (
            Buffer.byteLength(part.toolCallId, "utf8") > MAX_TOOL_IDENTITY_BYTES ||
            Buffer.byteLength(part.toolName, "utf8") > MAX_TOOL_IDENTITY_BYTES
          ) throw new Error("Tool batch limit exceeded: tool identity")
          if (typeof part.input !== "string")
            throw new Error("Tool batch limit exceeded: invalid argument representation")
          // Fast character-count rejection avoids scanning huge ASCII payloads.
          // Byte length is authoritative for non-ASCII JSON text.
          if (part.input.length > MAX_TOOL_CALL_ARGUMENT_BYTES)
            throw new Error("Tool batch limit exceeded: argument bytes")
          const bytes = Buffer.byteLength(part.input, "utf8")
          if (bytes > MAX_TOOL_CALL_ARGUMENT_BYTES)
            throw new Error("Tool batch limit exceeded: argument bytes")
          if (bytes > MAX_TOOL_BATCH_ARGUMENT_BYTES - pendingArgumentBytes)
            throw new Error("Tool batch limit exceeded: aggregate argument bytes")
          pendingArgumentBytes += bytes
          pending.push(part)
          return
        }
        if (part.type === "finish") {
          finish = part
          return
        }
        controller.enqueue(part)
      },
      async flush(controller) {
        const rawFinishReason: unknown = finish?.finishReason
        const normalizedFinishReason =
          typeof rawFinishReason === "string"
            ? rawFinishReason
            : rawFinishReason !== null && typeof rawFinishReason === "object" && "unified" in rawFinishReason
              ? rawFinishReason.unified
              : undefined
        if (pending.length > 0 && normalizedFinishReason !== "tool-calls")
          throw new Error("Incomplete provider response; tool calls withheld")
        if (pending.length > 0) {
          if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
          await admitBatch(pending, input)
          if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
          for (const call of pending) controller.enqueue(call)
        }
        if (finish) controller.enqueue(finish)
      },
    }),
  )
}

async function admitBatch(
  pending: ReadonlyArray<Extract<LanguageModelV3StreamPart, { type: "tool-call" }>>,
  input: ToolBatchGateInput,
) {
  const deny = (reason: string) => {
    for (const call of pending) input.context.outcomes.set(call.toolCallId, { status: "denied", reason })
  }
  const prepared: { readonly call: GuardedToolCall; readonly definition: ToolBatchDefinition }[] = []
  const seen = new Set<string>()

  try {
    for (const raw of pending) {
      if (seen.has(raw.toolCallId)) return deny("duplicate call ID")
      seen.add(raw.toolCallId)
      if ("providerExecuted" in raw && raw.providerExecuted === true)
        return deny("provider-executed tools are unsupported")

      if (!Object.prototype.hasOwnProperty.call(input.definitions, raw.toolName))
        return deny(`unsupported tool: ${raw.toolName}`)
      const definition = input.definitions[raw.toolName]
      if (!definition) return deny(`unsupported tool: ${raw.toolName}`)

      const parsed = parseInput(raw.input)
      const decoded = await definition.validate(parsed)
      const args = definition.normalize ? definition.normalize(decoded) : decoded
      const serializable = cloneJson(args)
      prepared.push({
        call: {
          callID: raw.toolCallId,
          capabilityID: definition.capability.id,
          arguments: serializable,
        },
        definition,
      })
    }
  } catch {
    return deny("invalid tool arguments")
  }

  if (input.signal.aborted) return deny("tool batch interrupted before Guard preparation")

  if (
    prepared.every(({ definition }) => definition.capability.effectClass === "read_only") ||
    (prepared.length === 1 && prepared[0]!.definition.internal === true)
  ) {
    for (const { call } of prepared) input.context.outcomes.set(call.callID, { status: "allowed" })
    return
  }

  let admission: EffectAdmission
  try {
    admission = await input.prepareToolBatch({
      sessionID: input.sessionID,
      batchID: `batch_${randomUUID().replaceAll("-", "")}`,
      turnContextDigest: input.turnContextDigest,
      calls: prepared.map(({ call }) => call),
    })
  } catch {
    return deny("Rust Guard unavailable")
  }
  if (input.signal.aborted) return deny("tool batch interrupted before execution")
  if (admission.status === "denied") return deny(admission.reason)
  if (prepared.length !== 1 || prepared[0]!.call.capabilityID !== "files.write")
    return deny("Rust admitted an unsupported tool batch")

  const [{ call }] = prepared
  input.context.outcomes.set(call.callID, { status: "admitted", challenge: admission.challenge })
}

function parseInput(input: unknown) {
  if (typeof input !== "string") return input
  if (input.trim() === "") return {}
  return JSON.parse(input)
}

function cloneJson(value: unknown) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Tool arguments are not JSON serializable")
  return JSON.parse(encoded)
}
