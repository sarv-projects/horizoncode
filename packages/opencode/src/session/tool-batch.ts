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
import {
  isNextManagedAttemptScope,
  managedAttemptScopeToWire,
  type DirectAttemptScopeV1,
  type ManagedAttemptAuthority,
  type ManagedAttemptScopeV1,
} from "./managed-control"


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

/** `question.ask` is the only user-facing control tool that can bypass effect Guard admission. */
export function isStandaloneControlTool(
  name: string,
  definition: Pick<ToolBatchDefinition, "capability" | "internal">,
): boolean {
  return (
    name === "question" &&
    definition.capability.id === "question.ask" &&
    definition.capability.effectClass === "control" &&
    definition.internal !== true
  )
}

/**
 * One member of a complete-batch admission returned by the Rust Guard path. Each member
 * carries its own one-use challenge; lease-bearing batches use the prepared_batch status.
 */
export type ToolBatchCallAdmission =
  {
    readonly callID: string
    readonly capabilityID: string
    readonly challenge: EffectChallenge
    readonly execution?: unknown
  }

export type ToolBatchAdmissionResult =
  | EffectAdmission
  | { readonly admission: EffectAdmission; readonly calls: ReadonlyArray<GuardedToolCall> }
  | { readonly status: "admitted_batch"; readonly calls: ReadonlyArray<ToolBatchCallAdmission> }

export type ToolBatchHostResult = ToolBatchAdmissionResult & {
  /** HostKernel-issued post-bind scope; callers must never synthesize or rebase it. */
  readonly directAttempt?: DirectAttemptScopeV1
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly attemptScopeTransition?: "batch_bind"
}

export type ToolCallOutcome =
  | { readonly status: "allowed"; readonly capabilityID: string }
  | { readonly status: "no_effect"; readonly capabilityID: string; readonly execution: unknown }
  | {
      readonly status: "prepared"
      readonly capabilityID: string
      readonly lease: EffectLease
      readonly execution?: unknown
      readonly directAttempt?: DirectAttemptScopeV1
    }
  | {
      readonly status: "admitted"
      readonly capabilityID: string
      readonly challenge: EffectChallenge
      readonly execution?: unknown
      readonly directAttempt?: DirectAttemptScopeV1
    }
  | { readonly status: "denied"; readonly reason: string }

export type DirectAttemptAuthority = {
  readonly currentScope: () => DirectAttemptScopeV1
  /** Accept only an exact HostKernel-issued durable transition. */
  readonly acceptRefreshedScope: (input: {
    readonly previous: DirectAttemptScopeV1
    readonly refreshed: DirectAttemptScopeV1
    readonly transition: "batch_bind" | "effect_receipt"
  }) => void
}

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
      ...("directAttempt" in value && isDirectAttemptScope(value.directAttempt)
        ? { directAttempt: value.directAttempt }
        : {}),
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
      ...("directAttempt" in value && isDirectAttemptScope(value.directAttempt)
        ? { directAttempt: value.directAttempt }
        : {}),
    }
  }
  return undefined
}

function isEffectLease(value: unknown): value is EffectLease {
  return (
    typeof value === "object" &&
    value !== null &&
    "effectID" in value &&
    isGuardIdentity(value.effectID) &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
}

function isGuardIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value)
}

function isEffectChallenge(value: unknown): value is EffectChallenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const challenge = value as Record<string, unknown>
  if (
    !isGuardIdentity(challenge.challengeID) ||
    !isGuardIdentity(challenge.effectID) ||
    typeof challenge.target !== "string" ||
    challenge.target.length === 0 ||
    Buffer.byteLength(challenge.target, "utf8") > 4096 ||
    typeof challenge.resource !== "string" ||
    challenge.resource.length === 0 ||
    Buffer.byteLength(challenge.resource, "utf8") > 4096 ||
    typeof challenge.existed !== "boolean"
  ) return false
  const targets = challenge.targets
  if (targets === undefined) return true
  if (!isEffectTargetSet(targets)) return false
  const first = targets[0]!
  return (
    first.target === challenge.target &&
    first.resource === challenge.resource &&
    first.existed === challenge.existed
  )
}

function isEffectTargetSet(
  value: unknown,
  requirePatchExecutableMode = false,
): value is ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return false
  const paths = new Set<string>()
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false
    const target = item as Record<string, unknown>
    if (
      Object.keys(target).some((key) => !["target", "resource", "operation", "existed", "executable"].includes(key)) ||
      typeof target.target !== "string" ||
      target.target.length === 0 ||
      Buffer.byteLength(target.target, "utf8") > 4096 ||
      typeof target.resource !== "string" ||
      target.resource.length === 0 ||
      Buffer.byteLength(target.resource, "utf8") > 4096 ||
      (target.operation !== "write" && target.operation !== "delete" && target.operation !== "run") ||
      typeof target.existed !== "boolean" ||
      ("executable" in target && (typeof target.executable !== "boolean" || target.operation !== "write")) ||
      (requirePatchExecutableMode && target.operation === "write" && typeof target.executable !== "boolean") ||
      paths.has(target.target)
    ) return false
    paths.add(target.target)
  }
  return true
}

export function requireToolExecution(input: {
  readonly context: unknown
  readonly callID?: string
  readonly toolName?: string
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
  const standaloneControl =
    input.toolName !== undefined &&
    isStandaloneControlTool(input.toolName, {
      capability: input.capability,
      internal: input.internal,
    })
  if (input.capability.effectClass === "control" && !input.internal && !standaloneControl)
    throw new Error("Tool batch denied: unsupported control capability")
  if (outcome.status !== "allowed")
    throw new Error("Tool batch denied: non-effect capability lacks validated batch allowance")
  return undefined
}

export type ToolBatchGateInput = {
  readonly sessionID: string
  readonly parentSessionID?: string
  /** Trusted Attempt state injected by TaskTool, never model/provider input. */
  readonly directAttempt?: DirectAttemptAuthority
  /** Trusted managed Attempt state injected by the managed prompt owner. */
  readonly managedAttempt?: ManagedAttemptAuthority
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
    readonly directAttempt?: DirectAttemptScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly signal: AbortSignal
  }) => Promise<ToolBatchHostResult>
  readonly cancelToolBatch: (request: { readonly sessionID: string; readonly batchID: string }) => Promise<void>
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
          const batchID = `batch_${randomUUID().replaceAll("-", "")}`
          const cancellation = createBatchCancellation(input, batchID)
          try {
            await admitBatch(pending, input, batchID, cancellation)
            if (input.signal.aborted) {
              await cancellation.cancel()
              throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
            }
            for (const call of pending) controller.enqueue(call)
          } finally {
            cancellation.dispose()
          }
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
  batchID: string,
  cancellation: ReturnType<typeof createBatchCancellation>,
) {
  const deny = (reason: string) => {
    for (const call of pending) input.context.outcomes.set(call.toolCallId, { status: "denied", reason })
  }
  const denyAndCancel = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  const prepared: {
    readonly toolName: string
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
        toolName: raw.toolName,
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
    prepared.length === 1 &&
    (isStandaloneControlTool(prepared[0]!.toolName, prepared[0]!.definition) ||
      (prepared[0]!.definition.internal === true &&
        prepared[0]!.definition.capability.effectClass === "control"))
  ) {
    for (const { call } of prepared)
      input.context.outcomes.set(call.callID, { status: "allowed", capabilityID: call.capabilityID })
    return
  }
  if (prepared.some(({ definition }) => definition.capability.effectClass === "control")) {
    return deny(
      prepared.length === 1
        ? "unsupported control capability"
        : "control capability must be used in a standalone batch",
    )
  }
  if (prepared.every(({ definition }) => definition.capability.effectClass === "read_only")) {
    for (const { call } of prepared)
      input.context.outcomes.set(call.callID, { status: "allowed", capabilityID: call.capabilityID })
    return
  }

  // A child can only submit effects while its authenticated Attempt authority is
  // present and exactly scoped to this parent/child Session pair. Capture once so a
  // concurrent scope advance cannot change which envelope is sent to Rust.
  const hasEffectCalls = prepared.some(({ definition }) => definition.capability.effectClass === "effect")
  let directAttemptScope: DirectAttemptScopeV1 | undefined
  let managedAttemptScope: ManagedAttemptScopeV1 | undefined
  if (hasEffectCalls && input.directAttempt && input.managedAttempt) {
    return deny("tool batch cannot carry both direct and managed Attempt authority")
  }
  if (hasEffectCalls && input.directAttempt) {
    try {
      directAttemptScope = input.directAttempt.currentScope()
    } catch {
      return deny("child effect requires Attempt-bound Rust authority")
    }
  }
  if (hasEffectCalls && input.directAttempt && input.parentSessionID === undefined) {
    return deny("child effect requires parent Session binding")
  }
  if (hasEffectCalls && input.managedAttempt) {
    try {
      managedAttemptScope = managedAttemptScopeToWire(input.managedAttempt.currentScope())
    } catch {
      return deny("managed effect requires HostKernel-issued Attempt authority")
    }
    if (managedAttemptScope.sessionID !== input.sessionID) {
      return deny("managed effect Session does not match its Attempt authority")
    }
  }
  if (input.parentSessionID !== undefined && hasEffectCalls) {
    const scope = directAttemptScope
    if (
      !scope ||
      !isDirectAttemptScope(scope) ||
      scope.parentSessionID !== input.parentSessionID ||
      scope.childSessionID !== input.sessionID
    ) {
      return deny("child effect requires Attempt-bound Rust authority")
    }
  }

  if (!hasEffectCalls) directAttemptScope = undefined

  let admission: EffectAdmission | undefined
  let admittedCalls: ReadonlyArray<ToolBatchCallAdmission> | undefined
  try {
    cancellation.beginAdmission()
    if (input.signal.aborted) {
      await cancellation.settleAdmission()
      return deny("tool batch interrupted before Guard preparation")
    }
    const preparedBatch = await input.prepareToolBatch({
      sessionID: input.sessionID,
      locationRef: input.locationRef,
      batchID,
      turnContextDigest: input.turnContextDigest,
      calls: prepared.map(({ call }) => call),
      ...(directAttemptScope ? { directAttempt: directAttemptScope } : {}),
      ...(managedAttemptScope ? { managedAttempt: managedAttemptScope } : {}),
      signal: input.signal,
    })
    await cancellation.settleAdmission()
    if (isCompleteBatchAdmission(preparedBatch)) {
      admittedCalls = preparedBatch.calls
    } else if ("admission" in preparedBatch && "calls" in preparedBatch) {
      if (!Array.isArray(preparedBatch.calls) || preparedBatch.calls.length !== prepared.length)
        return await denyAndCancel("Rust returned a mismatched prepared tool batch")
      const callsByID = new Map<string, GuardedToolCall>()
      for (const raw of preparedBatch.calls) {
        if (
          typeof raw !== "object" ||
          raw === null ||
          !isGuardIdentity(raw.callID) ||
          !isGuardIdentity(raw.capabilityID) ||
          callsByID.has(raw.callID)
        ) {
          return await denyAndCancel("Rust returned a mismatched prepared tool call")
        }
        callsByID.set(raw.callID, raw)
      }
      const normalized: typeof prepared = []
      for (const previous of prepared) {
        const call = callsByID.get(previous.call.callID)
        if (!call || call.capabilityID !== previous.call.capabilityID)
          return await denyAndCancel("Rust returned a mismatched prepared tool call")
        const argumentsValue = cloneJson(call.arguments)
        if (
          call.capabilityID !== "terminal.run" &&
          JSON.stringify(argumentsValue) !== JSON.stringify(previous.call.arguments)
        )
          return await denyAndCancel("Rust changed arguments for an unsupported tool")
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
        return await denyAndCancel("terminal.run requires PTY host preparation")
      admission = preparedBatch
    }
  } catch (error) {
    await cancellation.settleAdmission()
    await cancellation.cancel()
    if (input.signal.aborted) {
      return deny("tool batch interrupted before execution")
    }
    console.error("ToolBatch preparation diagnostic", error)
    return deny("Rust Guard unavailable")
  }
  if (input.signal.aborted) {
    await cancellation.cancel()
    return deny("tool batch interrupted before execution")
  }

  if (admission?.status !== "denied" && (directAttemptScope || managedAttemptScope)) {
    try {
      if (directAttemptScope) {
        if (!input.directAttempt || preparedBatch.attemptScopeTransition !== "batch_bind" ||
          !isDirectAttemptScope(preparedBatch.directAttempt) ||
          !isNextDirectAttemptScope(directAttemptScope, preparedBatch.directAttempt)) {
          throw new Error("HostKernel omitted or mismatched the direct Attempt batch scope")
        }
        input.directAttempt.acceptRefreshedScope({
          previous: directAttemptScope,
          refreshed: preparedBatch.directAttempt,
          transition: "batch_bind",
        })
        directAttemptScope = preparedBatch.directAttempt
      }
      if (managedAttemptScope) {
        if (!input.managedAttempt || preparedBatch.attemptScopeTransition !== "batch_bind" ||
          !preparedBatch.managedAttempt || !isNextManagedAttemptScope(managedAttemptScope, preparedBatch.managedAttempt)) {
          throw new Error("HostKernel omitted or mismatched the managed Attempt batch scope")
        }
        input.managedAttempt.acceptRefreshedScope({
          previous: managedAttemptScope,
          refreshed: preparedBatch.managedAttempt,
          transition: "batch_bind",
        })
        managedAttemptScope = preparedBatch.managedAttempt
      }
    } catch (error) {
      console.error("Attempt batch binding diagnostic", error)
      return await denyAndCancel("HostKernel Attempt batch binding failed")
    }
  }

  if (admittedCalls) {
    return await admitCompleteBatch(admittedCalls, prepared, input, deny, cancellation, directAttemptScope)
  }

  if (!admission) return await denyAndCancel("Rust Guard returned no admission")
  if (admission.status === "denied") return deny(admission.reason)
  if (admission.status === "prepared_batch") {
    return await admitPreparedBatch(prepared, admission.calls, input, deny, cancellation, directAttemptScope)
  }
  if (
    prepared.length !== 1 ||
    !["files.write", "files.patch", "terminal.run"].includes(prepared[0]!.call.capabilityID)
  )
    return await denyAndCancel("Rust admitted an unsupported tool batch")

  const [{ call, execution }] = prepared
  if (admission.status === "prepared") {
    if (!isEffectLease(admission.lease)) return await denyAndCancel("Rust returned an invalid capability lease")
    input.context.outcomes.set(call.callID, {
      status: "prepared",
      capabilityID: call.capabilityID,
      lease: admission.lease,
      ...(execution !== undefined ? { execution } : {}),
      ...(directAttemptScope ? { directAttempt: directAttemptScope } : {}),
    })
    return
  }

  if (!isEffectChallenge(admission.challenge))
    return await denyAndCancel("Rust returned an invalid effect challenge")

  if (call.capabilityID === "terminal.run") {
    input.context.outcomes.set(call.callID, {
      status: "admitted",
      capabilityID: call.capabilityID,
      challenge: admission.challenge,
      ...(execution !== undefined ? { execution } : {}),
      ...(directAttemptScope ? { directAttempt: directAttemptScope } : {}),
    })
    return
  }

  if (call.capabilityID === "files.patch") {
    const reason = patchAdmissionMismatch(call, admission.challenge)
    if (reason) return await denyAndCancel(reason)
  }
  input.context.outcomes.set(call.callID, {
    status: "admitted",
    capabilityID: call.capabilityID,
    challenge: admission.challenge,
    ...(execution !== undefined ? { execution } : {}),
    ...(directAttemptScope ? { directAttempt: directAttemptScope } : {}),
  })
}

function createBatchCancellation(input: ToolBatchGateInput, batchID: string) {
  let armed = false
  let admissionInFlight = false
  let cancellationRequested = false
  let cancellation: Promise<void> | undefined
  const dispatchCancellation = () => {
    if (!armed || admissionInFlight || !cancellationRequested) return Promise.resolve()
    if (!cancellation) {
      try {
        cancellation = Promise.resolve(input.cancelToolBatch({ sessionID: input.sessionID, batchID })).catch(
          (error) => {
            console.error("ToolBatch cancellation diagnostic", error)
          },
        )
      } catch (error) {
        console.error("ToolBatch cancellation diagnostic", error)
        cancellation = Promise.resolve()
      }
    }
    return cancellation
  }
  const cancel = () => {
    cancellationRequested = true
    return dispatchCancellation()
  }
  const onAbort = () => {
    cancellationRequested = true
    void dispatchCancellation()
  }
  return {
    beginAdmission() {
      if (armed) return
      armed = true
      admissionInFlight = true
      input.signal.addEventListener("abort", onAbort, { once: true })
      if (input.signal.aborted) cancellationRequested = true
    },
    settleAdmission() {
      admissionInFlight = false
      return dispatchCancellation()
    },
    cancel,
    dispose() {
      input.signal.removeEventListener("abort", onAbort)
    },
  }
}

function attemptBoundEffectIDs(
  admittedCalls: ReadonlyArray<ToolBatchCallAdmission> | undefined,
  admission: EffectAdmission | undefined,
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
  }>,
): string[] | undefined {
  const effectCount = prepared.filter(({ definition }) => definition.capability.effectClass === "effect").length
  if (effectCount === 0 || effectCount !== prepared.length) return undefined
  const expected = new Map(prepared.map(({ call }) => [call.callID, call.capabilityID]))
  if (expected.size !== prepared.length) return undefined
  const supported = (capabilityID: string) => ["files.write", "files.patch", "terminal.run"].includes(capabilityID)
  const unique = (ids: readonly string[]) => new Set(ids).size === ids.length

  if (admittedCalls) {
    if (admittedCalls.length !== prepared.length || admittedCalls.length === 0) return undefined
    const seenCalls = new Set<string>()
    const challengeIDs = new Set<string>()
    const effectIDs: string[] = []
    for (const entry of admittedCalls) {
      const callID = isGuardIdentity(entry?.callID) ? entry.callID : ""
      const capabilityID = isGuardIdentity(entry?.capabilityID) ? entry.capabilityID : ""
      const expectedCapability = expected.get(callID)
      if (
        !callID ||
        !capabilityID ||
        seenCalls.has(callID) ||
        expectedCapability !== capabilityID ||
        !supported(capabilityID) ||
        !isEffectChallenge(entry.challenge)
      ) return undefined
      const call = prepared.find((candidate) => candidate.call.callID === callID)?.call
      if (!call) return undefined
      if (capabilityID === "files.patch" && patchAdmissionMismatch(call, entry.challenge)) return undefined
      if (challengeIDs.has(entry.challenge.challengeID)) return undefined
      challengeIDs.add(entry.challenge.challengeID)
      seenCalls.add(callID)
      effectIDs.push(entry.challenge.effectID)
    }
    return seenCalls.size === expected.size && unique(effectIDs) ? effectIDs : undefined
  }

  if (!admission || admission.status === "denied") return undefined
  if (admission.status === "prepared_batch") {
    if (admission.calls.length !== prepared.length || admission.calls.length === 0) return undefined
    const seenCalls = new Set<string>()
    const leaseDigests = new Set<string>()
    const effectIDs: string[] = []
    for (const entry of admission.calls) {
      const callID = isGuardIdentity(entry?.callID) ? entry.callID : ""
      const capabilityID = isGuardIdentity(entry?.capabilityID) ? entry.capabilityID : ""
      if (
        !callID ||
        !capabilityID ||
        seenCalls.has(callID) ||
        expected.get(callID) !== capabilityID ||
        !supported(capabilityID) ||
        !isEffectLease(entry.lease)
      ) return undefined
      if (leaseDigests.has(entry.lease.capabilityLeaseDigest)) return undefined
      leaseDigests.add(entry.lease.capabilityLeaseDigest)
      seenCalls.add(callID)
      effectIDs.push(entry.lease.effectID)
    }
    return seenCalls.size === expected.size && unique(effectIDs) ? effectIDs : undefined
  }

  if (prepared.length !== 1 || !supported(prepared[0]!.call.capabilityID)) return undefined
  if (admission.status === "prepared") {
    return isEffectLease(admission.lease) ? [admission.lease.effectID] : undefined
  }
  if (!isEffectChallenge(admission.challenge)) return undefined
  if (
    prepared[0]!.call.capabilityID === "files.patch" &&
    patchAdmissionMismatch(prepared[0]!.call, admission.challenge)
  )
    return undefined
  return [admission.challenge.effectID]
}

function isDirectAttemptScope(value: unknown): value is DirectAttemptScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  const keys = [
    "attemptID",
    "parentSessionID",
    "childSessionID",
    "ownerEpoch",
    "expectedRevision",
    "locationID",
    "workspaceID",
    "workspaceRevision",
    "capabilityDigest",
    "permissionsDigest",
    "budgetDigest",
    "scopeDigest",
  ].sort()
  if (Object.keys(scope).toSorted().join("\0") !== keys.join("\0")) return false
  const id = (key: string) => typeof scope[key] === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(scope[key] as string)
  const revision = (key: string) => typeof scope[key] === "string" && /^[1-9][0-9]{0,19}$/.test(scope[key] as string)
  const digest = (key: string, algorithm: "sha256" | "blake3") =>
    typeof scope[key] === "string" && new RegExp(`^${algorithm}:[0-9a-f]{64}$`).test(scope[key] as string)
  return id("attemptID") && id("parentSessionID") && id("childSessionID") && id("locationID") && id("workspaceID") &&
    revision("ownerEpoch") && revision("expectedRevision") && digest("workspaceRevision", "blake3") &&
    digest("capabilityDigest", "sha256") && digest("permissionsDigest", "sha256") &&
    digest("budgetDigest", "sha256") && digest("scopeDigest", "sha256")
}

function isNextDirectAttemptScope(previous: DirectAttemptScopeV1, next: DirectAttemptScopeV1) {
  const { expectedRevision: previousRevision, ...previousFacts } = previous
  const { expectedRevision: nextRevision, ...nextFacts } = next
  if (JSON.stringify(previousFacts) !== JSON.stringify(nextFacts)) return false
  try {
    return BigInt(nextRevision) === BigInt(previousRevision) + 1n
  } catch {
    return false
  }
}

function isCompleteBatchAdmission(
  value: ToolBatchAdmissionResult,
): value is { readonly status: "admitted_batch"; readonly calls: ReadonlyArray<ToolBatchCallAdmission> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "admitted_batch" &&
    "calls" in value &&
    Array.isArray(value.calls)
  )
}

/**
 * Apply a complete-batch admission that already resolved one use-once lease per effectful
 * call (the canonical multi-call path: N approvals, N leased members). Any mismatch with
 * the prepared calls withholds the complete batch so no member runs with a wrong lease.
 */
async function admitPreparedBatch(
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly execution?: unknown
  }>,
  calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly lease: EffectLease; readonly execution?: unknown }>,
  input: ToolBatchGateInput,
  deny: (reason: string) => void,
  cancellation: ReturnType<typeof createBatchCancellation>,
  directAttempt?: DirectAttemptScopeV1,
): Promise<void> {
  const reject = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  if (calls.length !== prepared.length || calls.length === 0)
    return reject("Rust returned a mismatched prepared tool batch")
  const byCall = new Map<string, (typeof calls)[number]>()
  const effectIDs = new Set<string>()
  const leaseDigests = new Set<string>()
  for (const entry of calls) {
    if (!isGuardIdentity(entry.callID) || !isGuardIdentity(entry.capabilityID) || byCall.has(entry.callID))
      return reject("Rust returned a duplicate or invalid admitted tool call")
    if (!isEffectLease(entry.lease)) return reject("Rust returned an invalid capability lease")
    if (effectIDs.has(entry.lease.effectID)) return reject("Rust returned a duplicate effect lease")
    if (leaseDigests.has(entry.lease.capabilityLeaseDigest)) return reject("Rust returned a duplicate capability lease")
    effectIDs.add(entry.lease.effectID)
    leaseDigests.add(entry.lease.capabilityLeaseDigest)
    byCall.set(entry.callID, entry)
  }
  const outcomes: Array<[string, ToolCallOutcome]> = []
  for (const { call, execution } of prepared) {
    const entry = byCall.get(call.callID)
    if (!entry || entry.capabilityID !== call.capabilityID)
      return reject("Rust returned a mismatched prepared tool call")
    if (!["files.write", "files.patch", "terminal.run"].includes(call.capabilityID))
      return reject("Rust admitted an unsupported tool batch")
    const admittedExecution = entry.execution !== undefined ? entry.execution : execution
    outcomes.push([call.callID, {
      status: "prepared",
      capabilityID: call.capabilityID,
      lease: entry.lease,
      ...(admittedExecution !== undefined ? { execution: admittedExecution } : {}),
      ...(directAttempt ? { directAttempt } : {}),
    }])
  }
  for (const [callID, outcome] of outcomes) input.context.outcomes.set(callID, outcome)
}

/**
 * Apply a complete-batch admission: every prepared call must have exactly one admitted
 * member with its own challenge, and the whole batch is withheld on any mismatch. This is
 * the multi-call consumer for the Rust atomic ToolBatch path; a single admitted member for
 * a multi-call batch (or the reverse) is always refused.
 */
async function admitCompleteBatch(
  admitted: ReadonlyArray<ToolBatchCallAdmission>,
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
    readonly execution?: unknown
  }>,
  input: ToolBatchGateInput,
  deny: (reason: string) => void,
  cancellation: ReturnType<typeof createBatchCancellation>,
  directAttempt?: DirectAttemptScopeV1,
): Promise<void> {
  const reject = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  if (admitted.length !== prepared.length || admitted.length === 0)
    return reject("Rust returned a mismatched prepared tool batch")
  const byCall = new Map<string, ToolBatchCallAdmission>()
  const effectIDs = new Set<string>()
  const challengeIDs = new Set<string>()
  for (const entry of admitted) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isGuardIdentity(entry.callID) ||
      !isGuardIdentity(entry.capabilityID) ||
      !isEffectChallenge(entry.challenge) ||
      byCall.has(entry.callID)
    ) {
      return reject("Rust returned an invalid admitted tool call")
    }
    if (effectIDs.has(entry.challenge.effectID)) return reject("Rust returned a duplicate effect challenge")
    if (challengeIDs.has(entry.challenge.challengeID)) return reject("Rust returned a duplicate Guard challenge")
    effectIDs.add(entry.challenge.effectID)
    challengeIDs.add(entry.challenge.challengeID)
    byCall.set(entry.callID, entry)
  }
  const outcomes: Array<[string, ToolCallOutcome]> = []
  for (const { call, execution } of prepared) {
    const entry = byCall.get(call.callID)
    if (!entry || entry.capabilityID !== call.capabilityID)
      return reject("Rust returned a mismatched prepared tool call")
    if (!["files.write", "files.patch", "terminal.run"].includes(call.capabilityID))
      return reject("Rust admitted an unsupported tool batch")
    if (call.capabilityID === "files.patch") {
      const reason = patchAdmissionMismatch(call, entry.challenge)
      if (reason) return reject(reason)
    }
    const admittedExecution = entry.execution !== undefined ? entry.execution : execution
    outcomes.push([call.callID, {
      status: "admitted",
      capabilityID: call.capabilityID,
      challenge: entry.challenge,
      ...(admittedExecution !== undefined ? { execution: admittedExecution } : {}),
      ...(directAttempt ? { directAttempt } : {}),
    }])
  }
  for (const [callID, outcome] of outcomes) input.context.outcomes.set(callID, outcome)
}

/**
 * The Rust patch challenge must describe exactly the prepared operations, including
 * per-target operation and executable state. Returns a denial reason, or undefined.
 */
function patchAdmissionMismatch(call: GuardedToolCall, challenge: EffectChallenge): string | undefined {
  const args = call.arguments as { operations?: unknown }
  const operations = args.operations
  const targets = challenge.targets
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > 64 ||
    !isEffectTargetSet(targets, true) ||
    targets.length > 64 ||
    operations.length !== targets.length
  )
    return "Rust patch target set does not match the prepared operations"
  const targetByPath = new Map(targets.map((target) => [target.target, target]))
  const seenPaths = new Set<string>()
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
      return "Malformed files.patch operation"
    }
    if (seenPaths.has(item.path)) return "Malformed files.patch operation"
    seenPaths.add(item.path)
    const target = targetByPath.get(item.path)
    if (
      !target ||
      target.operation !== item.operation ||
      (item.operation === "write" && typeof target.executable !== "boolean") ||
      ("executable" in item && target.executable !== item.executable)
    ) {
      return "Rust patch target set does not match the prepared operations"
    }
  }
  return undefined
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
