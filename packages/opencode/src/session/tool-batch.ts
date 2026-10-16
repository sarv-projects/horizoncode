import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import type {
  EffectAdmission,
  EffectChallenge,
  EffectLease,
  GuardedToolCall,
} from "@opencode-ai/core/session/supervisor"
import type { Capability } from "@/tool/tool"
import { Location } from "@opencode-ai/core/location"


export type ToolBatchPreparation = {
  readonly arguments: unknown
  readonly execution: unknown
}

// Bound provider-supplied tool calls at the streaming boundary, before parsing,
// asynchronous validation, Guard preparation or callback dispatch. These limits
// intentionally apply to read-only calls too, so a provider cannot build an
// unbounded pending array while waiting for a terminal tool-calls finish.
const MAX_TOOL_BATCH_CALLS = 32
const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024
const MAX_TOOL_BATCH_ARGUMENT_BYTES = 512 * 1024
const MAX_TOOL_IDENTITY_BYTES = 256
const MAX_TOOL_STREAM_DELTA_CHUNKS = 16_384
// Covers a silent provider that never emits another frame or terminal finish.
// This is a hard upper bound even if an internal caller requests a larger value.
const MAX_TOOL_STREAM_DURATION_MS = 10 * 60 * 1000

export type ToolBatchDefinition = {
  readonly capability: Capability
  readonly schema: unknown
  readonly validate: (input: unknown) => Promise<unknown>
  readonly normalize?: (input: unknown) => unknown
  readonly prepare?: (input: unknown) => Promise<ToolBatchPreparation>
  readonly internal?: boolean
}

export type ToolBatchAdmissionResult =
  | EffectAdmission
  | { readonly admission: EffectAdmission; readonly calls: ReadonlyArray<GuardedToolCall> }

export type ToolCallOutcome =
  | { readonly status: "allowed"; readonly capabilityID: string }
  | { readonly status: "no_effect"; readonly capabilityID: string; readonly execution: unknown }
  | { readonly status: "prepared"; readonly capabilityID: string; readonly lease: EffectLease; readonly execution?: unknown }
  | { readonly status: "admitted"; readonly capabilityID: string; readonly challenge: EffectChallenge; readonly execution?: unknown }
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
  if (
    value.status === "no_effect" &&
    "capabilityID" in value && typeof value.capabilityID === "string" &&
    "execution" in value
  ) {
    return { status: "no_effect", capabilityID: value.capabilityID, execution: value.execution }
  }
  if (value.status === "allowed" && "capabilityID" in value && typeof value.capabilityID === "string")
    return { status: "allowed", capabilityID: value.capabilityID }
  if (value.status === "denied" && "reason" in value && typeof value.reason === "string")
    return { status: "denied", reason: value.reason }
  if (
    value.status === "prepared" &&
    "capabilityID" in value && typeof value.capabilityID === "string" &&
    "lease" in value && isEffectLease(value.lease)
  ) {
    return {
      status: "prepared",
      capabilityID: value.capabilityID,
      lease: value.lease,
      ...( "execution" in value ? { execution: value.execution } : {}),
    }
  }
  if (
    value.status === "admitted" &&
    "capabilityID" in value && typeof value.capabilityID === "string" &&
    "challenge" in value && isEffectChallenge(value.challenge)
  ) {
    return {
      status: "admitted",
      capabilityID: value.capabilityID,
      challenge: value.challenge,
      ...( "execution" in value ? { execution: value.execution } : {}),
    }
  }
  return undefined
}

function isEffectLease(value: unknown): value is EffectLease {
  return (
    typeof value === "object" &&
    value !== null &&
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
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
}): EffectChallenge | EffectLease | undefined {
  const outcome = toolCallOutcome(input.context, input.callID)
  if (outcome?.status === "denied") throw new Error(`Tool batch denied: ${outcome.reason}`)
  if (!outcome) throw new Error("Tool batch denied: missing validated ToolBatch admission")
  if (outcome.capabilityID !== input.capability.id)
    throw new Error("Tool batch denied: capability does not match admitted call")

  if (input.capability.effectClass === "effect") {
    if (outcome?.status === "no_effect") return undefined
    if (outcome?.status === "prepared") return outcome.lease
    if (outcome?.status !== "admitted") throw new Error("Tool batch denied: missing Rust Guard admission")
    return outcome.challenge
  }
  if (input.capability.effectClass === "unknown") {
    throw new Error("Tool batch denied: capability is unknown")
  }
  if (input.capability.effectClass === "control" && !input.internal)
    throw new Error("Tool batch denied: unsupported control capability")
  if (outcome.status !== "allowed")
    throw new Error("Tool batch denied: non-effect capability lacks validated batch allowance")
  return undefined
}

export type ToolBatchGateInput = {
  readonly sessionID: string
  readonly locationRef: typeof Location.Ref.Type
  readonly turnContextDigest: string
  readonly signal: AbortSignal
  /** Internal test override; runtime values cannot extend the hard cap. */
  readonly maxStreamDurationMs?: number
  readonly definitions: Readonly<Record<string, ToolBatchDefinition>>
  readonly prepareToolBatch: (request: {
    readonly sessionID: string
    readonly locationRef: typeof Location.Ref.Type
    readonly batchID: string
    readonly turnContextDigest: string
    readonly calls: ReadonlyArray<GuardedToolCall>
  }) => Promise<ToolBatchAdmissionResult>
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
  // Partial arguments can arrive in thousands of provider stream frames before
  // the final tool-call event. Count bytes, IDs and frames without retaining
  // argument text: terminal parts still own complete-batch authorization.
  const partialIDs = new Set<string>()
  const partialNames = new Map<string, string>()
  const partialEnded = new Set<string>()
  const terminalIDs = new Set<string>()
  const partialBytes = new Map<string, number>()
  let partialArgumentBytes = 0
  let partialChunks = 0
  let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined

  const requestedDuration = input.maxStreamDurationMs
  const durationMs = requestedDuration === undefined
    ? MAX_TOOL_STREAM_DURATION_MS
    : Number.isFinite(requestedDuration)
      ? Math.min(MAX_TOOL_STREAM_DURATION_MS, Math.max(1, requestedDuration))
      : MAX_TOOL_STREAM_DURATION_MS
  const lifetime = AbortSignal.any([input.signal, AbortSignal.timeout(durationMs)])
  return stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        if (finish) throw new Error("Provider emitted data after finish")
        // AI SDK Provider V3 emits tool-input-start/delta/end before the
        // complete tool-call. Track partial bytes without storing or approving
        // incomplete arguments. Tool callbacks execute only after terminal
        // batch validation.
        if (
          part.type === "tool-input-start" ||
          part.type === "tool-input-delta" ||
          part.type === "tool-input-end"
        ) {
          const callID = part.id
          if (typeof callID !== "string" || Buffer.byteLength(callID, "utf8") > MAX_TOOL_IDENTITY_BYTES)
            throw new Error("Tool batch limit exceeded: tool identity")
          if (terminalIDs.has(callID))
            throw new Error("Tool batch denied: streamed input after terminal call")
          if (part.type === "tool-input-start") {
            if (partialIDs.has(callID))
              throw new Error("Tool batch denied: duplicate streaming input start")
            if (partialIDs.size >= MAX_TOOL_BATCH_CALLS)
              throw new Error("Tool batch limit exceeded: streaming call count")
            const name = part.toolName
            if (typeof name !== "string" || Buffer.byteLength(name, "utf8") > MAX_TOOL_IDENTITY_BYTES)
              throw new Error("Tool batch limit exceeded: tool identity")
            partialIDs.add(callID)
            partialNames.set(callID, name)
          } else {
            if (!partialIDs.has(callID))
              throw new Error("Tool batch denied: streamed input without start")
            if (partialEnded.has(callID))
              throw new Error("Tool batch denied: streamed input after end")
            if (part.type === "tool-input-end") partialEnded.add(callID)
          }
          if (part.type === "tool-input-delta") {
            partialChunks++
            if (partialChunks > MAX_TOOL_STREAM_DELTA_CHUNKS)
              throw new Error("Tool batch limit exceeded: streaming chunk count")
            const delta = part.delta
            if (typeof delta !== "string")
              throw new Error("Tool batch limit exceeded: invalid streamed arguments")
            if (delta.length > MAX_TOOL_CALL_ARGUMENT_BYTES)
              throw new Error("Tool batch limit exceeded: streamed argument bytes")
            const bytes = Buffer.byteLength(delta, "utf8")
            if (bytes > MAX_TOOL_CALL_ARGUMENT_BYTES - (partialBytes.get(callID) ?? 0))
              throw new Error("Tool batch limit exceeded: streamed argument bytes")
            if (bytes > MAX_TOOL_BATCH_ARGUMENT_BYTES - partialArgumentBytes)
              throw new Error("Tool batch limit exceeded: aggregate streamed argument bytes")
            partialBytes.set(callID, (partialBytes.get(callID) ?? 0) + bytes)
            partialArgumentBytes += bytes
          }
          controller.enqueue(part)
          return
        }
        if (part.type === "tool-call") {
          // A completed call is a terminal assertion for its ID. Subsequent
          // partial frames cannot mutate what was validated for this batch.
          terminalIDs.add(part.toolCallId)
          const streamedName = partialNames.get(part.toolCallId)
          if (streamedName !== undefined && streamedName !== part.toolName)
            throw new Error("Tool batch denied: streaming tool identity mismatch")
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
        if (
          (pending.length > 0 && normalizedFinishReason !== "tool-calls") ||
          [...partialIDs].some((id) => !pending.some((call) => call.toolCallId === id))
        ) throw new Error("Incomplete provider response; tool calls withheld")
        if (pending.length > 0) {
          if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
          await admitBatch(pending, input)
          if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
          for (const call of pending) controller.enqueue(call)
        }
        if (finish) controller.enqueue(finish)
      },
    }),
    { signal: lifetime },
  )
}

async function admitBatch(
  pending: ReadonlyArray<Extract<LanguageModelV3StreamPart, { type: "tool-call" }>>,
  input: ToolBatchGateInput,
) {
  const deny = (reason: string) => {
    for (const call of pending) input.context.outcomes.set(call.toolCallId, { status: "denied", reason })
  }
  const prepared: {
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
    readonly execution?: unknown
  }[] = []
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
      const preparedInput = definition.prepare
        ? await definition.prepare(decoded)
        : {
            arguments: definition.normalize ? definition.normalize(decoded) : decoded,
            execution: undefined,
          }
      const serializable = cloneJson(preparedInput.arguments)
      prepared.push({
        call: {
          callID: raw.toolCallId,
          capabilityID: definition.capability.id,
          arguments: serializable,
        },
        definition,
        execution: preparedInput.execution === undefined ? undefined : cloneJson(preparedInput.execution),
      })
    }
  } catch {
    return deny("invalid tool arguments")
  }

  if (input.signal.aborted) return deny("tool batch interrupted before Guard preparation")

  if (prepared.length === 1 && prepared[0]!.call.capabilityID === "files.patch") {
    const args = prepared[0]!.call.arguments
    if (
      typeof args === "object" &&
      args !== null &&
      "operations" in args &&
      Array.isArray(args.operations) &&
      args.operations.length === 0
    ) {
      input.context.outcomes.set(prepared[0]!.call.callID, {
        status: "no_effect",
        capabilityID: prepared[0]!.call.capabilityID,
        execution: prepared[0]!.execution ?? [],
      })
      return
    }
  }
  if (
    prepared.every(({ definition }) => definition.capability.effectClass === "read_only") ||
    (prepared.length === 1 &&
      prepared[0]!.definition.internal === true &&
      prepared[0]!.definition.capability.effectClass === "control")
  ) {
    for (const { call } of prepared)
      input.context.outcomes.set(call.callID, { status: "allowed", capabilityID: call.capabilityID })
    return
  }

  let admission: EffectAdmission
  try {
    const preparedBatch = await input.prepareToolBatch({
      sessionID: input.sessionID,
      locationRef: input.locationRef,
      batchID: `batch_${randomUUID().replaceAll("-", "")}`,
      turnContextDigest: input.turnContextDigest,
      calls: prepared.map(({ call }) => call),
    })
    if ("admission" in preparedBatch && "calls" in preparedBatch) {
      if (!Array.isArray(preparedBatch.calls) || preparedBatch.calls.length !== prepared.length)
        return deny("Rust returned a mismatched prepared tool batch")
      const normalized: typeof prepared = []
      for (const [index, call] of preparedBatch.calls.entries()) {
        const previous = prepared[index]!
        if (call.callID !== previous.call.callID || call.capabilityID !== previous.call.capabilityID)
          return deny("Rust returned a mismatched prepared tool call")
        const argumentsValue = cloneJson(call.arguments)
        if (
          call.capabilityID !== "terminal.run" &&
          JSON.stringify(argumentsValue) !== JSON.stringify(previous.call.arguments)
        )
          return deny("Rust changed arguments for an unsupported tool")
        normalized.push({
          ...previous,
          call: { ...call, arguments: argumentsValue },
          ...(call.capabilityID === "terminal.run" ? { execution: argumentsValue } : {}),
        })
      }
      prepared.splice(0, prepared.length, ...normalized)
      admission = preparedBatch.admission
    } else {
      if (prepared.some(({ call }) => call.capabilityID === "terminal.run"))
        return deny("terminal.run requires PTY host preparation")
      admission = preparedBatch
    }
  } catch (error) {
    console.error("ToolBatch preparation diagnostic", error)
    return deny("Rust Guard unavailable")
  }
  if (input.signal.aborted) return deny("tool batch interrupted before execution")
  if (admission.status === "denied") return deny(admission.reason)
  if (
    prepared.length !== 1 ||
    !["files.write", "files.patch", "terminal.run"].includes(prepared[0]!.call.capabilityID)
  )
    return deny("Rust admitted an unsupported tool batch")

  const [{ call, execution }] = prepared
  if (admission.status === "prepared") {
    if (!isEffectLease(admission.lease)) return deny("Rust returned an invalid capability lease")
    input.context.outcomes.set(call.callID, {
      status: "prepared",
      capabilityID: call.capabilityID,
      lease: admission.lease,
      ...(execution !== undefined ? { execution } : {}),
    })
    return
  }

  if (call.capabilityID === "terminal.run") {
    input.context.outcomes.set(call.callID, {
      status: "admitted",
      capabilityID: call.capabilityID,
      challenge: admission.challenge,
      ...(execution !== undefined ? { execution } : {}),
    })
    return
  }

  if (call.capabilityID === "files.patch") {
    const args = call.arguments as { operations?: unknown }
    const operations = args.operations
    const targets = admission.challenge.targets
    if (!Array.isArray(operations) || !Array.isArray(targets) || operations.length !== targets.length)
      return deny("Rust patch target set does not match the prepared operations")
    const targetByPath = new Map(targets.map((target) => [target.target, target]))
    for (const item of operations) {
      if (
        typeof item !== "object" ||
        item === null ||
        !("path" in item) ||
        typeof item.path !== "string" ||
        !("operation" in item) ||
        (item.operation !== "write" && item.operation !== "delete") ||
        ("executable" in item && (item.operation !== "write" || typeof item.executable !== "boolean"))
      ) {
        return deny("Malformed files.patch operation")
      }
      const target = targetByPath.get(item.path)
      if (
        !target ||
        target.operation !== item.operation ||
        (item.operation === "write" && typeof target.executable !== "boolean") ||
        ("executable" in item && target.executable !== item.executable)
      ) {
        return deny("Rust patch target set does not match the prepared operations")
      }
    }
  }
  input.context.outcomes.set(call.callID, {
    status: "admitted",
    capabilityID: call.capabilityID,
    challenge: admission.challenge,
    ...(execution !== undefined ? { execution } : {}),
  })
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
