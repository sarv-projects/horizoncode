import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
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

export type ToolBatchDefinition = {
  readonly capability: Capability
  readonly schema: unknown
  readonly validate: (input: unknown) => Promise<unknown>
  readonly normalize?: (input: unknown) => unknown
  readonly prepare?: (input: unknown) => Promise<ToolBatchPreparation>
  readonly internal?: boolean
}

export type ToolCallOutcome =
  | { readonly status: "allowed" }
  | { readonly status: "no_effect"; readonly execution: unknown }
  | { readonly status: "prepared"; readonly lease: EffectLease; readonly execution?: unknown }
  | { readonly status: "admitted"; readonly challenge: EffectChallenge; readonly execution?: unknown }
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
  if (value.status === "no_effect" && "execution" in value) {
    return { status: "no_effect", execution: value.execution }
  }
  if (value.status === "allowed") return { status: "allowed" }
  if (value.status === "denied" && "reason" in value && typeof value.reason === "string")
    return { status: "denied", reason: value.reason }
  if (value.status === "prepared" && "lease" in value && isEffectLease(value.lease)) {
    return {
      status: "prepared",
      lease: value.lease,
      ...("execution" in value ? { execution: value.execution } : {}),
    }
  }
  if (value.status === "admitted" && "challenge" in value && isEffectChallenge(value.challenge)) {
    return {
      status: "admitted",
      challenge: value.challenge,
      ...("execution" in value ? { execution: value.execution } : {}),
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

  if (input.capability.effectClass === "effect") {
    if (outcome?.status === "no_effect") return undefined
    if (outcome?.status === "prepared") return outcome.lease
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
  readonly locationRef: typeof Location.Ref.Type
  readonly turnContextDigest: string
  readonly signal: AbortSignal
  readonly definitions: Readonly<Record<string, ToolBatchDefinition>>
  readonly prepareToolBatch: (request: {
    readonly sessionID: string
    readonly locationRef: typeof Location.Ref.Type
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
  let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined

  return stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform(part, controller) {
        if (finish) throw new Error("Provider emitted data after finish")
        if (part.type === "tool-call") {
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
        execution: prepared[0]!.execution ?? [],
      })
      return
    }
  }
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
      locationRef: input.locationRef,
      batchID: `batch_${randomUUID().replaceAll("-", "")}`,
      turnContextDigest: input.turnContextDigest,
      calls: prepared.map(({ call }) => call),
    })
  } catch {
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
      lease: admission.lease,
      ...(execution !== undefined ? { execution } : {}),
    })
    return
  }

  if (call.capabilityID === "terminal.run") {
    input.context.outcomes.set(call.callID, {
      status: "admitted",
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
