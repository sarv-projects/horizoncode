import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1 } from "@horizoncode/schema"
import type { Tool as AITool } from "ai"
import type {
  EffectAdmission,
  EffectChallenge,
  EffectLease,
  CodeModeGuardedToolCall,
  GuardedToolCall,
  ToolBatchCallLease,
} from "@horizoncode/core/session/supervisor"
import { Effect } from "effect"
import type { Capability } from "@/tool/tool"
import type { CodeModeDispatchWaveV1, CodeModeToolContextV1 } from "@/tool/code-mode"
import { codeModeToolResultDigestV1, codeModeWaveReceiptDigestV2, decodeCodeModeFrameV1, type CodeModeCallResultV1, type CodeModeToolV1, type CodeModeWaveRequestV1, type CodeModeWaveSettlementV1 } from "@/tool/code-mode-protocol"
import { Location } from "@horizoncode/core/location"
import {
  isNextDirectAttemptScope,
  isNextDirectTurnScope,
  isCompletedDirectTurnBatchScope,
  isNextManagedAttemptScope,
  isReceiptAdvancedDirectAttemptScope,
  isReceiptAdvancedManagedAttemptScope,
  managedAttemptScopeToWire,
  sameDirectAttemptScope,
  sameDirectTurnScope,
  sameManagedAttemptScope,
  type DirectAttemptScopeV1,
  type DirectTurnAuthority,
  type DirectTurnScopeV1,
  type ManagedAttemptAuthority,
  type ManagedAttemptScopeV1,
} from "./managed-control"


export type ToolBatchPreparation = {
  readonly arguments: unknown
  readonly execution: unknown
}

/**
 * One prepared member's position in a same-path mutation chain. The batch is
 * prepared in order, so a chained member's `expectedBeforeBase64` describes the
 * content its predecessor will have written; it must therefore also *execute*
 * after that predecessor. When the host never runs a member the chain entry is
 * never awaited, so this can only add ordering, never block admission.
 */
export type ToolBatchMemberChain = {
  readonly predecessor?: Promise<void>
  readonly settle: () => void
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

/** Paths a member will write, used to order same-path members of one batch. */
function mutationTargetPaths(capabilityID: string, execution: unknown, args: unknown): string[] {
  if (capabilityID === "files.patch" || capabilityID === "files.write") {
    const operations = capabilityID === "files.patch" ? execution : [execution]
    if (!Array.isArray(operations)) return []
    const paths: string[] = []
    for (const operation of operations) {
      if (typeof operation !== "object" || operation === null) continue
      const target = (operation as { path?: unknown }).path
      if (typeof target === "string" && target.length > 0 && !paths.includes(target)) paths.push(target)
    }
    if (paths.length > 0) return paths
  }
  if (capabilityID === "files.write" && typeof args === "object" && args !== null) {
    const target = (args as { path?: unknown }).path
    if (typeof target === "string" && target.length > 0) return [target]
  }
  return []
}

/**
 * Content an earlier member of the *same* batch has staged for a path but not yet
 * flushed to disk. A same-path successor must prepare against the stage its
 * predecessor produces: preparing every member from the pre-batch bytes leaves
 * all but the first with a stale `expectedBeforeBase64`, so the second edit is
 * denied and the file keeps only the first change. This index is batch-scoped and
 * discarded with the batch; it is never ambient cache and never crosses a turn.
 */
export type ToolBatchPrepareContext = {
  readonly sessionID?: string
  readonly pendingContent: {
    readonly read: (filePath: string) => string | undefined
    readonly write: (filePath: string, content: string) => void
  }
}

function createPendingContentIndex(): ToolBatchPrepareContext["pendingContent"] {
  const staged = new Map<string, string>()
  const key = (filePath: string) => path.resolve(filePath)
  return {
    read: (filePath: string) => staged.get(key(filePath)),
    write: (filePath: string, content: string) => {
      staged.set(key(filePath), content)
    },
  }
}

/**
 * Record every file a prepared member will write so a later member of the same
 * batch prepares against that content instead of the stale pre-batch bytes.
 */
function stagePreparedWrites(
  pendingContent: ToolBatchPrepareContext["pendingContent"],
  capabilityID: string,
  execution: unknown,
): void {
  if (capabilityID !== "files.patch" && capabilityID !== "files.write") return
  const operations = capabilityID === "files.patch" ? execution : [execution]
  if (!Array.isArray(operations)) return
  for (const operation of operations) {
    if (typeof operation !== "object" || operation === null) continue
    const target = (operation as { path?: unknown }).path
    const content = (operation as { contentBase64?: unknown }).contentBase64
    if (typeof target !== "string" || target.length === 0 || typeof content !== "string") continue
    pendingContent.write(target, Buffer.from(content, "base64").toString("utf8"))
  }
}

function isNormalizedTerminalInvocation(value: Record<string, unknown>): boolean {
  return (
    typeof value.command === "string" &&
    value.command.length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0 &&
    typeof value.timeoutMs === "number" &&
    Number.isSafeInteger(value.timeoutMs)
  )
}

/**
 * The exact object a call executes under. Guard digests the prepared, normalized
 * object, so a host echo can never replace it; at most it contributes the
 * `terminal.run` execution envelope (`mode`, shell profile, resolved environment)
 * that `Pty.runTool` requires. A raw `{command}` or `{command, workdir}` echo
 * therefore still executes the normalized `{command, cwd, timeoutMs}` instead of
 * reaching `Pty` as an incomplete invocation and failing with a bare
 * `Pty.InvalidInputError`.
 */
function resolveMemberExecution(capabilityID: string, preparedExecution: unknown, hostExecution: unknown): unknown {
  // A tool with no normalizer prepared nothing to compare against, so the host's
  // echo is the only description of what Guard admitted.
  if (capabilityID !== "terminal.run")
    return preparedExecution === undefined ? hostExecution : preparedExecution
  if (!isRecord(preparedExecution)) return hostExecution ?? preparedExecution
  const normalized = {
    command: preparedExecution.command,
    cwd: preparedExecution.cwd,
    timeoutMs: preparedExecution.timeoutMs,
  }
  if (!isNormalizedTerminalInvocation(normalized)) return preparedExecution
  if (!isRecord(hostExecution)) return preparedExecution
  // A workspace-command invocation is already a complete, separately validated
  // projection; the normalization boundary does not apply to it.
  if (hostExecution.mode === "workspace_profile") return hostExecution
  if (
    hostExecution.command !== normalized.command ||
    hostExecution.cwd !== normalized.cwd ||
    hostExecution.timeoutMs !== normalized.timeoutMs
  )
    return normalized
  if (typeof hostExecution.shellProfileID !== "string" || !isRecord(hostExecution.resolvedEnvironment))
    return normalized
  // Only the envelope is taken from the echo: the invocation itself stays the
  // normalized object Guard admitted.
  return {
    ...(hostExecution.mode === "shell" ? { mode: "shell" as const } : {}),
    ...normalized,
    shellProfileID: hostExecution.shellProfileID,
    resolvedEnvironment: hostExecution.resolvedEnvironment,
  }
}

/**
 * A host may mint ONE lease bound to the whole batch operation set and repeat it
 * on every admitted member. That is the shape the denial text names ("guarded
 * operation set"), so an identical lease on every member is this batch's single
 * lease and must never be read as two calls sharing one call's authority. Each
 * member still settles its own receipt under it.
 */
function sharedBatchLease(entries: ReadonlyArray<{ readonly lease?: EffectLease }>): EffectLease | undefined {
  if (entries.length < 2) return undefined
  const first = entries[0]?.lease
  if (!first || !isEffectLease(first)) return undefined
  for (const entry of entries) {
    const candidate = entry.lease
    if (!candidate || !isEffectLease(candidate)) return undefined
    if (candidate.effectID !== first.effectID || candidate.capabilityLeaseDigest !== first.capabilityLeaseDigest)
      return undefined
  }
  return first
}

/**
 * The prepared arguments a host echoes on its wrapper's `calls`
 * (`Pty.prepareToolBatch` returns the exact `GuardedToolCall`s it forwarded, which
 * for `terminal.run` carry the shell-profile envelope). This is the only
 * legitimate source of a member's host-supplied execution, and it may extend the
 * normalized invocation but never replace it.
 */
function wrapperPreparedExecutions(preparedBatch: ToolBatchHostResult | undefined): ReadonlyMap<string, unknown> {
  const executions = new Map<string, unknown>()
  if (typeof preparedBatch !== "object" || preparedBatch === null) return executions
  const calls = (preparedBatch as { calls?: unknown }).calls
  if (!Array.isArray(calls)) return executions
  for (const raw of calls) {
    if (typeof raw !== "object" || raw === null) continue
    const callID = (raw as { callID?: unknown }).callID
    const args = (raw as { arguments?: unknown }).arguments
    if (!isGuardIdentity(callID) || args === undefined || executions.has(callID)) continue
    try {
      executions.set(callID, cloneJson(args))
    } catch {
      // An unrepresentable echo cannot describe what Guard admitted.
    }
  }
  return executions
}

export type ToolBatchDefinition = {
  readonly capability: Capability
  readonly schema: unknown
  readonly validate: (input: unknown) => Promise<unknown>
  readonly normalize?: (input: unknown) => unknown
  readonly prepare?: (input: unknown, context?: ToolBatchPrepareContext) => Promise<ToolBatchPreparation>
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
    /** The host already minted this call's one-use lease without an approval
     * round (`admitted_batch`: a direct permission-mode candidate batch). When
     * present it must bind the same effect as `challenge` and the call is
     * admitted as `prepared`, so `terminal.run` never demands a second lease. */
    readonly lease?: EffectLease
    readonly execution?: unknown
  }

export type ToolBatchAdmissionResult =
  | EffectAdmission
  | { readonly admission: EffectAdmission; readonly calls: ReadonlyArray<GuardedToolCall> }
  | { readonly status: "admitted_batch"; readonly calls: ReadonlyArray<ToolBatchCallAdmission> }

export type ToolBatchHostResult = ToolBatchAdmissionResult & {
  /** HostKernel-issued post-bind scope; callers must never synthesize or rebase it. */
  readonly directAttempt?: DirectAttemptScopeV1
  /** HostKernel-refreshed scope for the same active direct runner cycle. */
  readonly directTurnScope?: DirectTurnScopeV1
  readonly managedAttempt?: ManagedAttemptScopeV1
  readonly attemptScopeTransition?: "batch_bind" | "batch_complete" | "effect_receipt"
}

export type DirectAttemptAuthority = {
  readonly currentScope: () => DirectAttemptScopeV1
  /** Accept only an exact HostKernel-issued durable transition. */
  readonly acceptRefreshedScope: (input: {
    readonly previous: DirectAttemptScopeV1
    readonly refreshed: DirectAttemptScopeV1
    readonly transition: "batch_bind" | "effect_receipt"
  }) => void
}

/**
 * The per-call authority handed to tool execution. It exposes the latest
 * HostKernel-issued scope and forwards only validated durable transitions to the
 * Attempt owner. `scope` is a live view, never a snapshot callers may rebase.
 */
export type ToolBatchDirectAttemptAuthority = DirectAttemptAuthority & {
  readonly scope: DirectAttemptScopeV1
  readonly directTurn?: DirectTurnAuthority
}

/**
 * Opaque handle for one member of a serial Attempt batch. The host issues the
 * underlying one-use lease only after the previous member's receipt settles.
 */
export type ToolBatchLeaseHandle = {
  readonly callID: string
  readonly capabilityID: string
}

export type ToolCallOutcome =
  | { readonly status: "allowed"; readonly capabilityID: string }
  | { readonly status: "no_effect"; readonly capabilityID: string; readonly execution: unknown }
  | {
      readonly status: "prepared"
      readonly capabilityID: string
      readonly lease: EffectLease | ToolBatchLeaseHandle
      readonly execution?: unknown
      readonly directAttempt?: ToolBatchDirectAttemptAuthority
    }
  | {
      readonly status: "admitted"
      readonly capabilityID: string
      readonly challenge: EffectChallenge
      readonly execution?: unknown
      readonly directAttempt?: ToolBatchDirectAttemptAuthority
    }
  | { readonly status: "denied"; readonly reason: string }

export type ToolBatchContext = {
  readonly outcomes: Map<string, ToolCallOutcome>
}

type CodeModeBatchBindingV1 = {
  readonly tools: readonly CodeModeToolV1[]
  readonly dispatchWave: (callID: string, input: Parameters<CodeModeDispatchWaveV1>[0]) => Promise<CodeModeWaveSettlementV1>
}

export type CodeModeToolBatchV1 = {
  readonly tools: readonly CodeModeToolV1[]
  readonly executors: Readonly<Record<string, AITool>>
  readonly lane: "direct_session" | "managed_attempt"
  readonly prepare: (request: {
    readonly callID: string
    readonly requestID: string
    readonly frame: CodeModeWaveRequestV1
    readonly calls: ReadonlyArray<CodeModeGuardedToolCall>
  }) => Promise<unknown>
  readonly receipts: (request: { readonly callID: string; readonly requestID: string; readonly waveIndex: number }) => Promise<unknown>
  readonly settleResults: (request: {
    readonly callID: string
    readonly requestID: string
    readonly waveIndex: number
    readonly results: ReadonlyArray<{
      readonly callIndex: number
      readonly callID: string
      readonly resultDigest?: string
      readonly outputBytes?: number
      readonly status: "settled" | "rejected" | "cancelled" | "unknown"
      readonly errorCode?: string
    }>
  }) => Promise<void>
  readonly cancel: (request: {
    readonly callID: string
    readonly requestID: string
    readonly waveIndex: number
    readonly reason: "user_abort" | "deadline" | "parent_cancel"
  }) => Promise<unknown>
}

// This private weak binding prevents provider/model data from supplying a
// dispatcher through the structurally open experimental_context field.
const codeModeBatchBindings = new WeakMap<object, CodeModeBatchBindingV1>()

/**
 * The normal ToolBatch boundary privately binds the exact shared dispatcher
 * for the lifetime of the request. Callers cannot provide a dispatcher through
 * the structurally open experimental_context field.
 */
export function codeModeToolContextFromBatchContext(value: unknown, callID?: string): CodeModeToolContextV1 | undefined {
  if (!callID || typeof value !== "object" || value === null) return undefined
  const binding = codeModeBatchBindings.get(value)
  if (!binding) return undefined
  return Object.freeze({
    tools: binding.tools,
    dispatchWave: (input) => binding.dispatchWave(callID, input),
  })
}

/**
 * Prepared same-path chains for the batch currently executing. Keyed by callID so
 * the tool that owns the call can wait for its predecessor and release its
 * successor without threading ordering through every admission return shape.
 */
const memberChainByCall = new Map<string, ToolBatchMemberChain>()

export function toolBatchMemberChain(callID?: string): ToolBatchMemberChain | undefined {
  if (!callID) return undefined
  return memberChainByCall.get(callID)
}

function registerMemberChains(entries: ReadonlyArray<{ readonly callID: string; readonly chain: ToolBatchMemberChain }>): void {
  if (entries.length === 0) return
  // Bounded: a chain entry for a member the host never executes must not accumulate.
  if (memberChainByCall.size > 4096) memberChainByCall.clear()
  for (const entry of entries)
    memberChainByCall.set(entry.callID, {
      ...entry.chain,
      settle: () => {
        entry.chain.settle()
        memberChainByCall.delete(entry.callID)
      },
    })
}

export function createToolBatchContext(): ToolBatchContext {
  return { outcomes: new Map<string, ToolCallOutcome>() }
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
    "lease" in value && (isEffectLease(value.lease) || isToolBatchLeaseHandle(value.lease))
  ) {
    return {
      status: "prepared",
      capabilityID: value.capabilityID,
      lease: value.lease,
      ...( "execution" in value ? { execution: value.execution } : {}),
      ...("directAttempt" in value && isToolBatchDirectAttemptAuthority(value.directAttempt)
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
      ...("directAttempt" in value && isToolBatchDirectAttemptAuthority(value.directAttempt)
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
}): EffectChallenge | EffectLease | ToolBatchLeaseHandle | undefined {
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
  /** Required alongside DirectAttempt for every direct effectful provider turn. */
  readonly directTurn?: DirectTurnAuthority
  /** Trusted managed Attempt state injected by the managed prompt owner. */
  readonly managedAttempt?: ManagedAttemptAuthority
  /** Provider-step usage must be durably accounted before managed effects reach Guard. */
  readonly beforeManagedEffects?: (input: {
    readonly finish: Extract<LanguageModelV3StreamPart, { type: "finish" }>
    readonly stepFinishIndex: number
    /** Exact bounded provider calls validated and normalized before Guard admission. */
    readonly calls: readonly {
      readonly toolCallID: string
      readonly toolName: string
      readonly capabilityID: string
      readonly arguments: Record<string, unknown>
    }[]
  }) => Promise<"ACCOUNTED" | "STOPPED">
  /** AI SDK provider V3 raw chunks carry Copilot's authoritative billing field. */
  readonly onProviderRawChunk?: (rawValue: unknown) => void
  /** Shared with the LLM event adapter so receipt keys match emitted step indexes. */
  readonly nextStepFinishIndex?: () => number
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
    readonly directTurnScope?: DirectTurnScopeV1
    readonly managedAttempt?: ManagedAttemptScopeV1
    readonly signal: AbortSignal
  }) => Promise<ToolBatchHostResult>
  readonly cancelToolBatch: (request: { readonly sessionID: string; readonly batchID: string }) => Promise<void>
  readonly context: ToolBatchContext
  /** Optional nested dispatch boundary. Runtime remains unavailable until its owner enables it. */
  readonly codeMode?: CodeModeToolBatchV1
}

export function toolBatchMiddleware(input: ToolBatchGateInput): LanguageModelV3Middleware {
  if (input.codeMode) {
    // Output is budgeted per authenticated helper request, not per Session or
    // provider turn. This map contains only small counters and is hard bounded.
    const requestOutputBytes = new Map<string, { bytes: number; touchedAt: number }>()
    codeModeBatchBindings.set(input.context, {
      tools: input.codeMode.tools,
      dispatchWave: async (callID, request) => {
        const now = Date.now()
        for (const [id, state] of requestOutputBytes) if (now - state.touchedAt > 10 * 60 * 1000) requestOutputBytes.delete(id)
        if (!requestOutputBytes.has(request.requestID) && requestOutputBytes.size >= 256) {
          throw new Error("CodeMode bounded output accounting capacity is exhausted")
        }
        const state = requestOutputBytes.get(request.requestID) ?? { bytes: 0, touchedAt: now }
        state.touchedAt = now
        requestOutputBytes.set(request.requestID, state)
        const settlement = await dispatchCodeModeWave(input, callID, request, 65_536 - state.bytes)
        const outputBytes = settlement.results.reduce((sum, result) => sum + (result.output ? Buffer.byteLength(result.output, "utf8") : 0), 0)
        if (outputBytes > 65_536 - state.bytes) throw new RangeError("CodeMode bounded output projection exceeded its request budget")
        state.bytes += outputBytes
        state.touchedAt = Date.now()
        return settlement
      },
    })
  }
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
  let finishStepIndex: number | undefined

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
          finishStepIndex = input.nextStepFinishIndex?.() ?? 0
          return
        }
        if (part.type === "raw" && "rawValue" in part) input.onProviderRawChunk?.(part.rawValue)
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
            const dispatchCalls = await admitBatch(pending, input, batchID, cancellation, finish, finishStepIndex ?? 0)
            if (input.signal.aborted) {
              await cancellation.cancel()
              throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
            }
            if (dispatchCalls !== false) for (const call of pending) controller.enqueue(call)
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

async function dispatchCodeModeWave(
  input: ToolBatchGateInput,
  callID: string,
  request: Parameters<CodeModeDispatchWaveV1>[0],
  remainingOutputBytes: number,
): Promise<CodeModeWaveSettlementV1> {
  const nested = input.codeMode
  if (!nested) throw new Error("CodeMode nested dispatch is unavailable")
  if (!isGuardIdentity(callID) || request.signal.aborted || input.signal.aborted)
    throw new Error("CodeMode wave cancelled before admission")
  const frame = decodeCodeModeFrameV1(new TextEncoder().encode(JSON.stringify(request.frame)))
  if (frame.frameType !== "wave_request" || frame.requestId !== request.requestID)
    throw new Error("CodeMode wave correlation mismatch")
  const toolByName = new Map(nested.tools.map((tool) => [tool.toolName, tool]))
  const calls = frame.calls.map((call) => {
    const descriptor = toolByName.get(call.toolName)
    if (!descriptor || descriptor.capabilityId !== call.capabilityId || !nested.executors[call.toolName]?.execute)
      throw new Error("CodeMode requested a tool outside its retained authorized catalog")
    return { type: "tool-call" as const, toolCallId: call.callId, toolName: call.toolName, input: JSON.stringify(call.arguments) }
  })
  const context: ToolBatchContext = { outcomes: new Map() }
  const signal = AbortSignal.any([input.signal, request.signal])
  const waveInput: ToolBatchGateInput = { ...input, signal, context }
  const localBatchID = `codemode_${randomUUID().replaceAll("-", "")}`
  const cancellation = createBatchCancellation(waveInput, localBatchID, () =>
    nested.cancel({
      callID,
      requestID: request.requestID,
      waveIndex: frame.waveIndex,
      reason: request.signal.aborted ? "user_abort" : "parent_cancel",
    }).then((projection) => {
      if (!isRecord(projection) || projection.requestID !== frame.requestId || projection.waveIndex !== frame.waveIndex ||
        !["cancelled", "unknown"].includes(String(projection.status))) {
        throw new Error("HostKernel returned an uncorrelated CodeMode wave cancellation")
      }
      if (projection.status === "cancelled") {
        codeModeSettlementFromPreDispatch({
          status: "pre_dispatch_terminal",
          decision: "cancelled",
          requestID: projection.requestID,
          batchID: projection.batchID,
          waveIndex: projection.waveIndex,
          results: projection.results,
          receiptDigest: projection.receiptDigest,
        }, frame)
        return
      }
      codeModeSettlementFromReceipts(projection, frame, calls.map((call) => ({ call, status: "unknown" as const })))
    }))
  let hostBinding: unknown
  try {
    await admitBatch(calls, waveInput, localBatchID, cancellation, undefined, frame.waveIndex, {
      callID,
      requestID: request.requestID,
      frame,
      prepare: async (inputCalls) => {
        hostBinding = await nested.prepare({ callID, requestID: request.requestID, frame, calls: inputCalls })
        return hostBinding as ToolBatchHostResult
      },
    })
    if (isRecord(hostBinding) && hostBinding.status === "pre_dispatch_terminal") {
      return codeModeSettlementFromPreDispatch(hostBinding, frame)
    }
    if (!hostBinding) throw new Error("HostKernel did not create a durable CodeMode wave binding")
    if (signal.aborted) {
      await cancellation.cancel()
      throw signal.reason ?? new DOMException("Aborted", "AbortError")
    }
    const rawExecutions = await Promise.all(calls.map(async (call) => {
      const outcome = context.outcomes.get(call.toolCallId)
      if (!outcome || outcome.status === "denied") return { call, status: "rejected" as const, errorCode: "GUARD_DENIED" }
      const executor = nested.executors[call.toolName] as { execute?: (args: unknown, options: unknown) => unknown }
      if (!executor.execute) return { call, status: "rejected" as const, errorCode: "TOOL_EXECUTOR_UNAVAILABLE" }
      try {
        const result = await executor.execute(JSON.parse(call.input), {
          toolCallId: call.toolCallId,
          messages: [],
          abortSignal: signal,
          experimental_context: context,
        })
        const output = codeModeOutputTextV1(result)
        return { call, status: "settled" as const, output, resultDigest: codeModeToolResultDigestV1(output), outputBytes: Buffer.byteLength(output, "utf8") }
      } catch {
        // A thrown executor may have performed an effect before losing its
        // result. Do not guess a terminal outcome; Rust fences the wave as
        // UNKNOWN unless its retained EffectHost row proves settlement.
        return { call, status: "unknown" as const }
      }
    }))
    let remaining = Math.max(0, remainingOutputBytes)
    const executions = rawExecutions.map((result) => {
      if (result.status !== "settled") return result
      const output = redactCodeModeOutputV1(result.output, remaining)
      remaining -= Buffer.byteLength(output, "utf8")
      return { ...result, output, resultDigest: codeModeToolResultDigestV1(output), outputBytes: Buffer.byteLength(output, "utf8") }
    })
    const callbackRows = executions.map((result, callIndex) => ({
      callIndex,
      callID: result.call.toolCallId,
      status: result.status,
      ...(result.status === "settled" ? { resultDigest: result.resultDigest, outputBytes: result.outputBytes } : {}),
    }))
    if (signal.aborted) await cancellation.cancel()
    await nested.settleResults({ callID, requestID: request.requestID, waveIndex: frame.waveIndex, results: callbackRows })
    const binding = hostBinding
    if (!isRecord(binding) || !isRecord(binding.codeMode) || binding.codeMode.status !== "BOUND" ||
      binding.codeMode.requestID !== request.requestID || binding.codeMode.waveIndex !== frame.waveIndex ||
      typeof binding.codeMode.batchID !== "string") {
      throw new Error("HostKernel did not return the exact durable CodeMode wave binding")
    }
    const receiptProjection = await nested.receipts({ callID, requestID: request.requestID, waveIndex: frame.waveIndex })
    return codeModeSettlementFromReceipts(receiptProjection, frame, executions)
  } catch (error) {
    await cancellation.cancel()
    throw error
  } finally {
    cancellation.dispose()
  }
}

export function codeModeSettlementFromReceipts(
  value: unknown,
  frame: CodeModeWaveRequestV1,
  callbacks: ReadonlyArray<{ readonly call: Extract<LanguageModelV3StreamPart, { type: "tool-call" }>; readonly status: "settled" | "rejected" | "cancelled" | "unknown"; readonly output?: string; readonly resultDigest?: string; readonly outputBytes?: number; readonly errorCode?: string }>,
): CodeModeWaveSettlementV1 {
  const topLevelKeys = ["status", "requestID", "batchID", "waveIndex", "results", "receiptDigest"].toSorted()
  if (!isRecord(value) || Object.keys(value).toSorted().join("\0") !== topLevelKeys.join("\0") ||
    value.requestID !== frame.requestId || value.waveIndex !== frame.waveIndex ||
    typeof value.batchID !== "string" || !Array.isArray(value.results) ||
    !["settled", "rejected", "cancelled", "unknown"].includes(String(value.status)))
    throw new Error("HostKernel returned a malformed CodeMode receipt projection")
  const rows = value.results
  if (rows.length !== frame.calls.length) throw new Error("HostKernel CodeMode receipt projection omitted or added calls")
  const results: CodeModeCallResultV1[] = rows.map((item, index) => {
    const callback = callbacks[index]
    if (!callback || !isRecord(item) || item.callIndex !== index || item.callID !== frame.calls[index]!.callId ||
      !["settled", "rejected", "cancelled", "unknown"].includes(String(item.status)))
      throw new Error("HostKernel CodeMode receipt rows are not contiguous and correlated")
    if (item.status === "unknown") {
      if (item.receiptKind !== null || item.receiptRef !== null || item.receiptDigest !== null || item.resultDigest !== null || item.outputBytes !== null || item.errorCode !== null)
        throw new Error("UNKNOWN CodeMode result included terminal evidence")
      return { callId: item.callID as string, status: "unknown" as const, receiptKind: null }
    }
    if ((item.receiptKind !== "effect_receipt" && item.receiptKind !== "host_decision" && item.receiptKind !== "tool_result") || typeof item.receiptRef !== "string" || typeof item.receiptDigest !== "string")
      throw new Error("Known CodeMode result lacks a durable receipt")
    const status = item.status as "settled" | "rejected" | "cancelled"
    const callbackOutput = status === "settled" && callback.status === "settled" ? callback.output : undefined
    if (callback.status !== "unknown" && callback.status !== status)
      throw new Error("HostKernel tool-result status differs from the exact Core callback result")
    if (item.receiptKind === "tool_result" && status === "settled" &&
      (callback.status !== "settled" || item.resultDigest !== callback.resultDigest || item.outputBytes !== callback.outputBytes))
      throw new Error("HostKernel tool-result receipt does not bind the exact Core callback result")
    if (item.receiptKind !== "tool_result" && (item.resultDigest !== null || item.outputBytes !== null))
      throw new Error("EffectHost receipt was incorrectly replaced with Core callback provenance")
    if (item.receiptKind === "host_decision" && callbackOutput !== undefined)
      throw new Error("Host decision cannot claim callback output")
    if (item.receiptKind === "tool_result" && callback.status !== "unknown" && status !== "settled" && item.errorCode !== callback.errorCode)
      throw new Error("HostKernel terminal callback receipt does not bind the callback error code")
    return {
      callId: item.callID as string,
      status,
      receiptKind: item.receiptKind,
      ...(callbackOutput === undefined ? {} : { output: callbackOutput }),
      ...(typeof item.resultDigest === "string" ? { resultDigest: item.resultDigest } : {}),
      ...(typeof item.outputBytes === "number" ? { outputBytes: item.outputBytes } : {}),
      ...(typeof item.errorCode === "string" ? { errorCode: item.errorCode } : {}),
      receiptRef: item.receiptRef,
      receiptDigest: item.receiptDigest,
    }
  })
  const status = value.status
  if (status !== "settled" && status !== "rejected" && status !== "cancelled" && status !== "unknown") {
    throw new Error("HostKernel returned an invalid CodeMode wave status")
  }
  const precedence = results.some((result) => result.status === "unknown") ? "unknown" :
    results.some((result) => result.status === "cancelled") ? "cancelled" :
      results.some((result) => result.status === "rejected") ? "rejected" : "settled"
  if (status !== precedence) throw new Error("HostKernel aggregate CodeMode status disagrees with ordered call outcomes")
  // The durable v2 contract binds the wave index plus the ordered public call
  // tuples [waveIndex, callIndex, callId, status, receiptKind, receiptRef,
  // receiptDigest]. A zero-call wave and any UNKNOWN row carry no aggregate
  // digest, so HostKernel must return null instead of a synthetic value.
  const receiptDigest = status !== "unknown" && results.length > 0
    ? codeModeWaveReceiptDigestV2(frame.waveIndex, results)
    : undefined
  if (status === "unknown") {
    if (value.receiptDigest !== null) throw new Error("UNKNOWN CodeMode wave cannot expose an aggregate receipt digest")
  } else if (results.length === 0) {
    if (value.receiptDigest !== null) throw new Error("Zero-call CodeMode wave cannot expose an aggregate receipt digest")
  } else if (!receiptDigest || value.receiptDigest !== receiptDigest) {
    throw new Error("HostKernel CodeMode aggregate receipt digest differs from its ordered rows")
  }
  return {
    requestId: frame.requestId,
    waveIndex: frame.waveIndex,
    batchId: value.batchID,
    status,
    results,
    ...(receiptDigest ? { receiptDigest } : {}),
  }
}

export function codeModeSettlementFromPreDispatch(value: Record<string, unknown>, frame: CodeModeWaveRequestV1): CodeModeWaveSettlementV1 {
  const keys = ["status", "decision", "requestID", "batchID", "waveIndex", "results", "receiptDigest"].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0") || value.status !== "pre_dispatch_terminal" ||
    (value.decision !== "rejected" && value.decision !== "cancelled") || value.requestID !== frame.requestId ||
    !isGuardIdentity(value.batchID) || value.waveIndex !== frame.waveIndex || !Array.isArray(value.results) ||
    value.results.length !== frame.calls.length || typeof value.receiptDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(value.receiptDigest)) {
    throw new Error("HostKernel returned a malformed pre-dispatch CodeMode decision")
  }
  const results = value.results.map((raw, index) => {
    if (!isRecord(raw)) throw new Error("HostKernel pre-dispatch CodeMode rows are malformed")
    const rowKeys = ["callIndex", "callID", "status", "receiptKind", "receiptRef", "receiptDigest", "resultDigest", "outputBytes", "errorCode"].toSorted()
    if (Object.keys(raw).toSorted().join("\0") !== rowKeys.join("\0") || raw.callIndex !== index ||
      raw.callID !== frame.calls[index]!.callId || (raw.status !== "rejected" && raw.status !== "cancelled") ||
      raw.receiptKind !== "host_decision" || !isGuardIdentity(raw.receiptRef) ||
      typeof raw.receiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(raw.receiptDigest) ||
      raw.resultDigest !== null || raw.outputBytes !== null ||
      (raw.errorCode !== null && (typeof raw.errorCode !== "string" || Buffer.byteLength(raw.errorCode, "utf8") > 128))) {
      throw new Error("HostKernel pre-dispatch CodeMode decision rows are malformed or miscorrelated")
    }
    return {
      callId: raw.callID as string,
      status: raw.status as "rejected" | "cancelled",
      receiptKind: "host_decision" as const,
      receiptRef: raw.receiptRef as string,
      receiptDigest: raw.receiptDigest as string,
      ...(typeof raw.errorCode === "string" ? { errorCode: raw.errorCode } : {}),
    }
  })
  if (results.length === 0) throw new Error("HostKernel pre-dispatch CodeMode decision cannot describe a zero-call wave")
  const aggregate = codeModeWaveReceiptDigestV2(frame.waveIndex, results)
  if (aggregate !== value.receiptDigest) throw new Error("HostKernel pre-dispatch aggregate receipt digest does not match its ordered rows")
  return {
    requestId: frame.requestId,
    waveIndex: frame.waveIndex,
    batchId: value.batchID as string,
    status: value.decision as "rejected" | "cancelled",
    results,
    receiptDigest: aggregate,
  }
}

export function codeModeOutputTextV1(value: unknown): string {
  const blocks = isRecord(value) && Array.isArray(value.content) ? value.content : undefined
  let text = typeof value === "string" ? value : typeof (isRecord(value) ? value.output : undefined) === "string"
    ? (value as { output: string }).output : ""
  if (!text && blocks) {
    const pieces: string[] = []
    let remainingChars = 65_600
    let sourceTruncated = blocks.length > 256
    for (const item of blocks.slice(0, 256)) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue
      if (remainingChars <= 0) {
        sourceTruncated = true
        break
      }
      const piece = item.text.slice(0, remainingChars)
      pieces.push(piece)
      remainingChars -= piece.length
      if (piece.length < item.text.length) {
        sourceTruncated = true
        break
      }
    }
    text = pieces.join("\n")
    if (sourceTruncated && text) text += "\n…[truncated]"
  }
  // CodeMode is a detail projection. Do not pass raw tool output, terminal
  // controls, credentials, or unbounded bodies to the helper. The digest is
  // computed later over exactly this redacted projection.
  return redactCodeModeOutputV1(text, 65_536)
}

export function redactCodeModeOutputV1(value: string, maxBytes: number): string {
  const cap = Math.max(0, Math.min(65_536, maxBytes))
  if (cap === 0) return ""
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const first = value.charCodeAt(index)
    const second = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
    const size = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
      ? 4 : first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3
    if (bytes + size > Math.max(0, cap - 64)) break
    bytes += size
    index += size === 4 ? 2 : 1
  }
  const clipped = index < value.length
  let source = value.slice(0, index)
  if (clipped) {
    const boundary = Math.max(source.lastIndexOf(" "), source.lastIndexOf("\n"), source.lastIndexOf("\t"))
    source = boundary < 0 ? "" : source.slice(0, boundary)
  }
  let output = source
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/iu, "[REDACTED INCOMPLETE PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gu, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED JWT]")
    .replace(/(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|auth|credential|cookie|client[-_ ]?secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)?/giu, "$1[REDACTED]")
    .replace(/(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/giu, "$1[REDACTED]@")
  const marker = "…[truncated]"
  const outputClipped = clipped || Buffer.byteLength(output, "utf8") > cap
  if (outputClipped) {
    let end = 0
    let outputBytes = 0
    while (end < output.length) {
      const first = output.charCodeAt(end)
      const second = end + 1 < output.length ? output.charCodeAt(end + 1) : 0
      const size = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
        ? 4 : first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3
      if (outputBytes + size > Math.max(0, cap - Buffer.byteLength(marker, "utf8"))) break
      outputBytes += size
      end += size === 4 ? 2 : 1
    }
    output = `${output.slice(0, end)}${marker}`
    while (Buffer.byteLength(output, "utf8") > cap) output = output.slice(0, -1)
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function admitBatch(
  pending: ReadonlyArray<Extract<LanguageModelV3StreamPart, { type: "tool-call" }>>,
  input: ToolBatchGateInput,
  batchID: string,
  cancellation: ReturnType<typeof createBatchCancellation>,
  finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined,
  stepFinishIndex: number,
  codeMode?: {
    readonly callID: string
    readonly requestID: string
    readonly frame: CodeModeWaveRequestV1
    readonly prepare: (calls: ReadonlyArray<CodeModeGuardedToolCall>) => Promise<unknown>
  },
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

  // A turn with no effect calls needs no HostKernel admission at all.
  const effectMembers = pending.filter(
    (raw) => input.definitions[raw.toolName]?.capability.effectClass === "effect",
  )
  if (effectMembers.length === 0) {
    // No effect means no HostKernel admission — but every batch-surface tool
    // still needs an explicit outcome or `requireToolExecution` refuses it.
    for (const raw of pending) {
      const definition = input.definitions[raw.toolName]
      if (!definition) continue
      input.context.outcomes.set(raw.toolCallId, {
        status: "allowed",
        capabilityID: definition.capability.id,
      })
    }
    return
  }
  const pendingContent = createPendingContentIndex()
  const chainSettled = new Map<string, Promise<void>>()
  const memberChains: Array<{ readonly callID: string; readonly chain: ToolBatchMemberChain }> = []
  // A member whose arguments the tool refuses denies only itself. Every member
  // that validates and prepares still reaches Guard, so one stale oldString
  // no longer costs the model the rest of its turn. Batch-shape violations
  // (duplicate call id, unsupported tool, provider-executed call) stay
  // whole-batch denials: they are protocol faults, not model argument faults.
  const rejected: Array<{ readonly callID: string; readonly reason: string }> = []
  // Non-effect members execute locally and never reach Guard, so they are not
  // part of the admitted subset. They stay bound to the documented whole-batch
  // contract: one rejected call still withholds them for this turn, while the
  // effect members whose arguments the tool accepted are admitted.
  const localMembers: string[] = []

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

      // Only effect capabilities belong to a HostKernel ToolBatch. The kernel
      // admits exactly terminal.run | files.write | files.patch | web.search and
      // persists one challenge row per call; forwarding a read-only member
      // (files.read, git.*, glob, grep) made the kernel reject the whole batch
      // (`unsupported_capability`) or persist fewer rows than the client then
      // asked to approve (`batch_rows.len() != ordered_challenge_ids.len()`),
      // which surfaced to the model as "Tool batch denied: Rust Guard
      // unavailable" and cost the effect call in the same turn. Read-only tools
      // execute on their own local path and need no lease.
      if (definition.capability.effectClass !== "effect") {
        // A read-only member runs locally, but it still needs an explicit
        // outcome record: `requireToolExecution` treats an absent outcome as an
        // admission failure for every tool registered on the batch surface.
        input.context.outcomes.set(raw.toolCallId, {
          status: "allowed",
          capabilityID: definition.capability.id,
        })
        localMembers.push(raw.toolCallId)
        continue
      }
      let validated: unknown
      try {
        validated = await definition.validate(parseInput(raw.input))
      } catch {
        // A shape failure is the model argument error, not a domain refusal.
        if (codeMode) return deny("invalid tool arguments")
        rejected.push({ callID: raw.toolCallId, reason: "invalid tool arguments" })
        continue
      }
      let preparedInput: ToolBatchPreparation
      try {
        preparedInput = definition.prepare
          ? await definition.prepare(validated, { pendingContent, sessionID: input.sessionID })
          : {
              arguments: definition.normalize ? definition.normalize(validated) : validated,
              execution: undefined,
            }
      } catch (error) {
        // `prepare` is where a tool refuses work it cannot perform: the edit
        // preimage no longer matches, the patch is malformed, the path leaves
        // the workspace. That reason IS the denial, so it is preserved per call
        // instead of collapsing into "invalid tool arguments" (which the model
        // answered by re-sending the identical edit).
        const reason = admissionFailureReason(raw.toolName, error)
        if (codeMode) return deny(reason)
        rejected.push({ callID: raw.toolCallId, reason })
        continue
      }
      let serializable: unknown
      try {
        serializable = cloneJson(preparedInput.arguments)
      } catch {
        if (codeMode) return deny("invalid tool arguments")
        rejected.push({ callID: raw.toolCallId, reason: "invalid tool arguments" })
        continue
      }
      // Stage this member's output for any later same-path member of this batch,
      // so the successor's approved preimage is its predecessor's output.
      stagePreparedWrites(pendingContent, definition.capability.id, preparedInput.execution)
      // Chain this member behind any earlier member that owns the same path, so
      // prepared order is also execution order. The kernel revalidates every
      // approved preimage against the live file when it admits the batch, so a
      // same-path successor can never be admitted alongside a predecessor that
      // has not run yet; it has to be re-admitted alone once that receipt lands.
      const targets = mutationTargetPaths(definition.capability.id, preparedInput.execution, serializable)
      if (targets.length > 0) {
        let predecessor: Promise<void> | undefined
        for (const target of targets) {
          const previous = chainSettled.get(target)
          if (!previous) continue
          predecessor = predecessor
            ? predecessor.then(() => previous)
            : previous
        }
        let release = () => {}
        const settled = new Promise<void>((resolve) => {
          release = resolve
        })
        for (const target of targets) chainSettled.set(target, settled)
        memberChains.push({ callID: raw.toolCallId, chain: { ...(predecessor ? { predecessor } : {}), settle: release } })
      }
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
  registerMemberChains(memberChains)

  if (rejected.length > 0) {
    // A control capability is admissible only as the single call of its batch;
    // once any member is rejected the wave is no longer exactly that call.
    if (prepared.some(({ definition }) => definition.capability.effectClass === "control"))
      return deny("control capability must be used as a single CodeMode wave call")
    for (const item of rejected)
      input.context.outcomes.set(item.callID, { status: "denied", reason: item.reason })
    for (const callID of localMembers)
      input.context.outcomes.set(callID, { status: "denied", reason: "batch contained a rejected call" })
    if (prepared.length === 0) return
  }

  if (input.signal.aborted) return deny("tool batch interrupted before Guard preparation")

  if (!codeMode && prepared.length === 1 && prepared[0]!.call.capabilityID === "files.patch") {
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
  if (!codeMode && (
    prepared.length === 1 &&
    (isStandaloneControlTool(prepared[0]!.toolName, prepared[0]!.definition) ||
      (prepared[0]!.definition.internal === true &&
        prepared[0]!.definition.capability.effectClass === "control"))
  )) {
    for (const { call } of prepared)
      input.context.outcomes.set(call.callID, { status: "allowed", capabilityID: call.capabilityID })
    return
  }
  if (prepared.some(({ definition }) => definition.capability.effectClass === "control")) {
    if (!codeMode || prepared.length !== 1 || prepared[0]!.definition.capability.effectClass !== "control") {
      return deny("control capability must be used as a single CodeMode wave call")
    }
  }
  if (!codeMode && prepared.every(({ definition }) => definition.capability.effectClass === "read_only")) {
    for (const { call } of prepared)
      input.context.outcomes.set(call.callID, { status: "allowed", capabilityID: call.capabilityID })
    return
  }

  // A child can only submit effects while its authenticated Attempt authority is
  // present and exactly scoped to this parent/child Session pair. Capture once so a
  // concurrent scope advance cannot change which envelope is sent to Rust.
  const hasEffectCalls = prepared.some(({ definition }) => definition.capability.effectClass === "effect")
  if (hasEffectCalls && input.managedAttempt) {
    if (!finish || !input.beforeManagedEffects) {
      input.managedAttempt.markUsageStopped?.()
      deny("managed effect withheld: provider-step usage cannot be accounted before Guard")
      return false
    }
    const accounting = await input.beforeManagedEffects({
      finish,
      stepFinishIndex,
      calls: prepared.map(({ call, toolName }) => ({
        toolCallID: call.callID,
        toolName,
        capabilityID: call.capabilityID,
        // Arguments were validated and normalized by the tool definition before Guard.
        arguments: call.arguments as Record<string, unknown>,
      })),
    })
    if (accounting !== "ACCOUNTED") {
      input.managedAttempt.markUsageStopped?.()
      deny("managed effect withheld: usage accounting stopped or is uncertain")
      return false
    }
  }
  let directAttemptScope: DirectAttemptScopeV1 | undefined
  let directTurnScope: DirectTurnScopeV1 | undefined
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
  if (hasEffectCalls && input.directAttempt) {
    if (!input.directTurn) {
      deny("direct child effect withheld: HostKernel-issued DirectTurnScope is unavailable")
      return false
    }
    try {
      directTurnScope = input.directTurn.currentScope()
      if (!isDirectTurnScope(directTurnScope) ||
        !directAttemptScope || !sameDirectAttemptScope(directTurnScope.directAttempt, directAttemptScope)) {
        deny("direct child effect withheld: DirectTurnScope does not match the live DirectAttempt")
        return false
      }
    } catch {
      deny("direct child effect withheld: DirectTurnScope is stale or unavailable")
      return false
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
    if (managedAttemptScope.remainingTokens === "0") {
      input.managedAttempt.markUsageStopped?.()
      deny("managed effect withheld: Attempt token budget is exhausted")
      return false
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
  let preparedBatch: ToolBatchHostResult | undefined
  let hostExecutions: ReadonlyMap<string, unknown> | undefined
  try {
    cancellation.beginAdmission()
    if (input.signal.aborted) {
      await cancellation.settleAdmission()
      return deny("tool batch interrupted before Guard preparation")
    }
    if (process.env.HZ_DEBUG_PREPARE === "1")
      console.error("HZPREP calls", JSON.stringify(prepared.map(({ call, toolName }) => ({ toolName, ...call }))).slice(0, 1200))
    const preparedProjection = codeMode
      ? await codeMode.prepare(prepared.map(({ call, toolName }) => ({ ...call, toolName })))
      : await input.prepareToolBatch({
      sessionID: input.sessionID,
      locationRef: input.locationRef,
      batchID,
      turnContextDigest: input.turnContextDigest,
      calls: prepared.map(({ call }) => call),
      ...(directTurnScope ? { directTurnScope } : {}),
      ...(managedAttemptScope ? { managedAttempt: managedAttemptScope } : {}),
      signal: input.signal,
      })
    preparedBatch = preparedProjection as ToolBatchHostResult
    await cancellation.settleAdmission()
    hostExecutions = wrapperPreparedExecutions(preparedBatch)
    const wrappedAdmittedCalls = wrappedBatchAdmissionCalls(preparedBatch)
    // The CodeMode host may answer with a pre-dispatch terminal decision that is
    // outside the ordinary admission union; read it through the record view.
    const hostStatus: unknown = (preparedBatch as { status?: unknown } | undefined)?.status
    if (codeMode && hostStatus === "pre_dispatch_terminal") {
      deny("HostKernel recorded a terminal pre-dispatch CodeMode decision")
      return
    }
    if (isCompleteBatchAdmission(preparedBatch)) {
      admittedCalls = preparedBatch.calls
    } else if (wrappedAdmittedCalls) {
      // Wrapped complete-batch admission: the host answered
      // `{ admission: { status: "admitted_batch", calls: [...] }, calls: [...] }`.
      // The wrapper's own `calls` are the prepared GuardedToolCalls, so reading
      // them as admissions dropped every challenge and lease and denied the batch
      // as an invalid effect batch. Take the nested authoritative list instead.
      admittedCalls = wrappedAdmittedCalls
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
          ...(call.capabilityID === "terminal.run"
            ? { execution: resolveMemberExecution("terminal.run", previous.execution, argumentsValue) }
            : {}),
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
    if (process.env.HZ_DEBUG_PREPARE === "1")
      console.error("HZPREPERR", JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})).slice(0, 1500))
    return deny(`Rust Guard unavailable: ${describeHostFailure(error)}`)
  }
  if (input.signal.aborted) {
    await cancellation.cancel()
    return deny("tool batch interrupted before execution")
  }
  if (!preparedBatch) return await denyAndCancel("Rust Guard returned no admission")

  // Effect identity, uniqueness and patch-target checks run before the durable
  // Attempt bind so a malformed batch never advances the Attempt revision.
  if (admittedCalls && prepared.every(({ definition }) => definition.capability.effectClass === "effect")) {
    const effectBatch = checkEffectBatchAdmission(admittedCalls, undefined, prepared)
    if (effectBatch.status === "rejected")
      return await denyAndCancel(`Rust returned an invalid effect batch: ${effectBatch.reason}`)
  }

  if (admission?.status !== "denied" && (directAttemptScope || managedAttemptScope || directTurnScope)) {
    try {
      if (directTurnScope) {
        if (!input.directTurn || !isDirectTurnScope(preparedBatch.directTurnScope) ||
          preparedBatch.attemptScopeTransition !== "batch_bind" ||
          !isNextDirectTurnScope(directTurnScope, preparedBatch.directTurnScope)) {
          throw new Error("HostKernel omitted or mismatched the DirectTurnScope batch bind")
        }
        await input.directTurn.persistRefreshedScope(preparedBatch.directTurnScope)
        input.directTurn.acceptRefreshedScope({
          previous: directTurnScope,
          refreshed: preparedBatch.directTurnScope,
          transition: "batch_bind",
        })
        if (!input.directAttempt || (!sameDirectAttemptScope(directAttemptScope!, preparedBatch.directTurnScope.directAttempt) &&
          !isNextDirectAttemptScope(directAttemptScope!, preparedBatch.directTurnScope.directAttempt))) {
          throw new Error("HostKernel DirectTurnScope does not contain the exact bound DirectAttempt revision")
        }
        input.directAttempt.acceptRefreshedScope({
          previous: directAttemptScope!,
          refreshed: preparedBatch.directTurnScope.directAttempt,
          transition: "batch_bind",
        })
        directTurnScope = preparedBatch.directTurnScope
        directAttemptScope = preparedBatch.directTurnScope.directAttempt
      } else if (directAttemptScope) {
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

  const directAttemptOutcome = directAttemptScope && input.directAttempt
    ? createToolBatchDirectAttemptAuthority(input.directAttempt, input.directTurn)
    : undefined

  if (admittedCalls) {
    return await admitCompleteBatch(
      admittedCalls,
      prepared,
      input,
      deny,
      cancellation,
      directAttemptOutcome,
      hostExecutions,
    )
  }

  if (!admission) return await denyAndCancel("Rust Guard returned no admission")
  if (admission.status === "denied") return deny(admission.reason)
  if (admission.status === "prepared_batch") {
    return await admitPreparedBatch(
      prepared,
      admission.calls,
      input,
      deny,
      cancellation,
      directAttemptOutcome,
      input.managedAttempt,
      admission.leaseNext,
    )
  }
  // A complete-batch admission is settled by admitCompleteBatch above. Reaching
  // the single-call path with one means the host protocol disagreed with itself;
  // fail closed instead of reading a challenge that member does not carry.
  if (admission.status === "admitted_batch")
    return await denyAndCancel("Rust returned a batch admission outside the complete-batch path")
  if (
    prepared.length !== 1 ||
    !["files.write", "files.patch", "terminal.run", "web.search"].includes(prepared[0]!.call.capabilityID)
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
      ...(directAttemptOutcome ? { directAttempt: directAttemptOutcome } : {}),
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
      ...(directAttemptOutcome ? { directAttempt: directAttemptOutcome } : {}),
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
    ...(directAttemptOutcome ? { directAttempt: directAttemptOutcome } : {}),
  })
}

function createBatchCancellation(input: ToolBatchGateInput, batchID: string, cancelOverride?: () => Promise<void>) {
  let armed = false
  let admissionInFlight = false
  let cancellationRequested = false
  let cancellation: Promise<void> | undefined
  const dispatchCancellation = () => {
    if (!armed || admissionInFlight || !cancellationRequested) return Promise.resolve()
    if (!cancellation) {
      try {
        cancellation = Promise.resolve(cancelOverride ? cancelOverride() : input.cancelToolBatch({ sessionID: input.sessionID, batchID })).catch(
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

function looksLikeCallAdmission(value: unknown): value is ToolBatchCallAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    ("challenge" in value || "lease" in value)
  )
}

/**
 * A host may wrap a complete-batch admission as
 * `{ admission: { status: "admitted_batch", calls: [...] }, calls: [...] }`.
 * The wrapper's own `calls` are the *prepared* `GuardedToolCall`s the client sent
 * to Rust (`Pty.prepareToolBatch` returns the normalized arguments it forwarded),
 * while the admitted challenges and pre-minted leases live in `admission.calls`.
 * Reading the wrapper's `calls` as admissions discarded every challenge and denied
 * the whole batch as an "invalid effect batch": in the 2026-10-29 live run that
 * refused exactly the two messages with two `terminal.run` calls (msg 5, msg 14 —
 * four bash calls in total) while all 62 single-call messages passed, because
 * `admitted_batch` is only reachable for `calls.length >= 2`.
 *
 * Use the nested list whenever it actually carries call authority; fall back to
 * the wrapper only when it is the side holding challenges or leases.
 */
export function wrappedBatchAdmissionCalls(
  preparedBatch: ToolBatchHostResult | undefined,
): ReadonlyArray<ToolBatchCallAdmission> | undefined {
  if (typeof preparedBatch !== "object" || preparedBatch === null) return undefined
  if (!("admission" in preparedBatch) || !("calls" in preparedBatch)) return undefined
  const admission = preparedBatch.admission
  if (typeof admission !== "object" || admission === null) return undefined
  if ((admission as { status?: unknown }).status !== "admitted_batch") return undefined
  const nested = (admission as { calls?: unknown }).calls
  if (Array.isArray(nested) && nested.length > 0 && nested.every(looksLikeCallAdmission))
    return nested as ReadonlyArray<ToolBatchCallAdmission>
  const wrapper = preparedBatch.calls
  return Array.isArray(wrapper) ? (wrapper as ReadonlyArray<ToolBatchCallAdmission>) : undefined
}

type EffectBatchCheck =
  | { readonly status: "not_applicable" }
  | { readonly status: "ok"; readonly effectIDs: ReadonlyArray<string> }
  | { readonly status: "rejected"; readonly reason: string }

/** Bound, single-line rendering of the host failure that aborted preparation.
 * Collapsing every one of them into "Rust Guard unavailable" is what made the
 * 2026-10-29 transcript unactionable: the wrapper said a category, never a cause. */
function describeHostFailure(error: unknown): string {
  const raw =
    typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : typeof error === "string"
        ? error
        : "unknown host failure"
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return "unknown host failure"
  return Buffer.byteLength(collapsed, "utf8") <= 400
    ? collapsed
    : `${Buffer.from(collapsed, "utf8").subarray(0, 400).toString("utf8")}…`
}

/** Bound, single-line rendering of what a host actually supplied, so a rejection
 * is diagnosable from the transcript instead of collapsing to a bare category. */
function describeAdmissionEntry(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return `entry=${typeof entry}`
  const keys = Object.keys(entry).sort()
  const capability = (entry as { capabilityID?: unknown }).capabilityID
  return `keys=[${keys.join(",")}] capability=${typeof capability === "string" ? capability : "?"}`
}

function checkEffectBatchAdmission(
  admittedCalls: ReadonlyArray<ToolBatchCallAdmission> | undefined,
  admission: EffectAdmission | undefined,
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
  }>,
): EffectBatchCheck {
  const reject = (reason: string): EffectBatchCheck => ({ status: "rejected", reason })
  const effectCount = prepared.filter(({ definition }) => definition.capability.effectClass === "effect").length
  if (effectCount === 0 || effectCount !== prepared.length) return { status: "not_applicable" }
  const expected = new Map(prepared.map(({ call }) => [call.callID, call.capabilityID]))
  if (expected.size !== prepared.length) return reject("the prepared batch repeats a call identity")
  const supported = (capabilityID: string) => ["files.write", "files.patch", "terminal.run", "web.search"].includes(capabilityID)
  const unique = (ids: readonly string[]) => new Set(ids).size === ids.length

  if (admittedCalls) {
    if (admittedCalls.length === 0) return reject("the host admitted an empty complete batch")
    if (admittedCalls.length !== prepared.length)
      return reject(`the host admitted ${admittedCalls.length} calls for ${prepared.length} prepared effects`)
    const seenCalls = new Set<string>()
    const challengeIDs = new Set<string>()
    const leaseDigests = new Set<string>()
    const effectIDs: string[] = []
    // One lease repeated on every admitted member is this batch's lease over the
    // whole operation set, not a duplicate-call fault.
    const batchLease = sharedBatchLease(admittedCalls)
    for (const entry of admittedCalls) {
      const callID = isGuardIdentity(entry?.callID) ? entry.callID : ""
      const capabilityID = isGuardIdentity(entry?.capabilityID) ? entry.capabilityID : ""
      if (!callID || !capabilityID)
        return reject(`an admitted member has no Guard identity: ${describeAdmissionEntry(entry)}`)
      if (seenCalls.has(callID)) return reject(`admitted call ${callID} appears twice`)
      const expectedCapability = expected.get(callID)
      if (!expectedCapability) return reject(`admitted call ${callID} was never prepared in this batch`)
      if (expectedCapability !== capabilityID)
        return reject(`admitted capability ${capabilityID} does not match prepared ${expectedCapability} for ${callID}`)
      if (!supported(capabilityID)) return reject(`capability ${capabilityID} is outside the Guard effect set`)
      if (!isEffectChallenge(entry.challenge))
        return reject(`admitted call ${callID} carries no valid Guard challenge: ${describeAdmissionEntry(entry)}`)
      const call = prepared.find((candidate) => candidate.call.callID === callID)?.call
      if (!call) return reject(`admitted call ${callID} has no prepared arguments`)
      if (capabilityID === "files.patch" && patchAdmissionMismatch(call, entry.challenge))
        return reject("the Rust patch target set does not match the prepared operations")
      if (challengeIDs.has(entry.challenge.challengeID))
        return reject(`Guard challenge ${entry.challenge.challengeID} is shared by two admitted calls`)
      challengeIDs.add(entry.challenge.challengeID)
      if (entry.lease !== undefined) {
        if (!isEffectLease(entry.lease))
          return reject(`admitted call ${callID} carries an invalid capability lease`)
        if (!batchLease) {
          if (entry.lease.effectID !== entry.challenge.effectID)
            return reject(`admitted call ${callID} leases effect ${entry.lease.effectID}, not its challenge ${entry.challenge.effectID}`)
          if (leaseDigests.has(entry.lease.capabilityLeaseDigest))
            return reject("two admitted calls carry the same capability lease digest")
        }
        leaseDigests.add(entry.lease.capabilityLeaseDigest)
      }
      seenCalls.add(callID)
      effectIDs.push(entry.challenge.effectID)
    }
    if (seenCalls.size !== expected.size)
      return reject(`the host admitted ${seenCalls.size} of ${expected.size} prepared effects`)
    if (!unique(effectIDs)) return reject("two admitted calls carry the same effect identity")
    // A batch lease is minted for the whole operation set, so its effect identity
    // need not equal any single member's challenge effect: it is bound by the
    // capability lease digest every admitted member repeats.
    return { status: "ok", effectIDs }
  }

  if (!admission || admission.status === "denied") return { status: "not_applicable" }
  if (admission.status === "prepared_batch") {
    if (admission.calls.length === 0) return reject("the host prepared an empty batch")
    if (admission.calls.length !== prepared.length)
      return reject(`the host prepared ${admission.calls.length} leases for ${prepared.length} prepared effects`)
    const seenCalls = new Set<string>()
    const leaseDigests = new Set<string>()
    const effectIDs: string[] = []
    for (const entry of admission.calls) {
      const callID = isGuardIdentity(entry?.callID) ? entry.callID : ""
      const capabilityID = isGuardIdentity(entry?.capabilityID) ? entry.capabilityID : ""
      if (!callID || !capabilityID) return reject("a prepared member has no Guard identity")
      if (seenCalls.has(callID)) return reject(`prepared call ${callID} appears twice`)
      if (expected.get(callID) !== capabilityID)
        return reject(`prepared capability ${capabilityID} does not match ${expected.get(callID) ?? "no prepared call"} for ${callID}`)
      if (!supported(capabilityID)) return reject(`capability ${capabilityID} is outside the Guard effect set`)
      if (!isEffectLease(entry.lease)) return reject(`prepared call ${callID} carries an invalid capability lease`)
      if (leaseDigests.has(entry.lease.capabilityLeaseDigest))
        return reject("two prepared calls carry the same capability lease digest")
      leaseDigests.add(entry.lease.capabilityLeaseDigest)
      seenCalls.add(callID)
      effectIDs.push(entry.lease.effectID)
    }
    if (seenCalls.size !== expected.size)
      return reject(`the host prepared ${seenCalls.size} of ${expected.size} effects`)
    if (!unique(effectIDs)) return reject("two prepared calls carry the same effect identity")
    return { status: "ok", effectIDs }
  }

  if (prepared.length !== 1 || !supported(prepared[0]!.call.capabilityID)) return { status: "not_applicable" }
  if (admission.status === "prepared")
    return isEffectLease(admission.lease)
      ? { status: "ok", effectIDs: [admission.lease.effectID] }
      : reject("the host prepared an invalid capability lease")
  // Batch admissions carry no single challenge; only admitCompleteBatch may
  // validate them, so this single-call probe cannot bind their effect IDs.
  if (admission.status === "admitted_batch") return { status: "not_applicable" }
  if (!isEffectChallenge(admission.challenge))
    return reject(`the host admitted no valid Guard challenge: ${describeAdmissionEntry(admission)}`)
  if (
    prepared[0]!.call.capabilityID === "files.patch" &&
    patchAdmissionMismatch(prepared[0]!.call, admission.challenge)
  )
    return reject("the Rust patch target set does not match the prepared operations")
  return { status: "ok", effectIDs: [admission.challenge.effectID] }
}

function isDirectAttemptScope(value: unknown): value is DirectAttemptScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    return sameDirectAttemptScope(value as DirectAttemptScopeV1, value as DirectAttemptScopeV1)
  } catch {
    return false
  }
}

/** Expose the live Attempt authority without letting callers rebase its scope. */
function createToolBatchDirectAttemptAuthority(
  authority: DirectAttemptAuthority,
  directTurn?: DirectTurnAuthority,
): ToolBatchDirectAttemptAuthority {
  return Object.freeze({
    get scope() {
      return authority.currentScope()
    },
    currentScope: () => authority.currentScope(),
    acceptRefreshedScope: (input: {
      readonly previous: DirectAttemptScopeV1
      readonly refreshed: DirectAttemptScopeV1
      readonly transition: "batch_bind" | "effect_receipt"
    }) => authority.acceptRefreshedScope(input),
    ...(directTurn ? { directTurn } : {}),
  })
}

function isDirectTurnScope(value: unknown): value is DirectTurnScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    return sameDirectTurnScope(value as DirectTurnScopeV1, value as DirectTurnScopeV1)
  } catch {
    return false
  }
}

/** A member receipt may expose a refreshed turn scope only once the complete
 * batch is terminal. Persist it before accepting the in-memory transition. */
export async function acceptDirectTurnBatchReceipt(
  authority: unknown,
  receipt: { readonly directTurnScope?: unknown },
): Promise<void> {
  if (!isToolBatchDirectAttemptAuthority(authority) || !authority.directTurn) {
    throw new Error("Tool batch denied: direct turn authority is unavailable")
  }
  if (!isDirectTurnScope(receipt.directTurnScope)) {
    throw new Error("Tool batch denied: final effect receipt omitted DirectTurnScope")
  }
  const previous = authority.directTurn.currentScope()
  const refreshed = receipt.directTurnScope
  if (!isCompletedDirectTurnBatchScope(previous, refreshed)) {
    throw new Error("Tool batch denied: HostKernel returned a stale or mismatched completed DirectTurnScope")
  }
  const currentAttempt = authority.currentScope()
  if (!sameDirectAttemptScope(currentAttempt, refreshed.directAttempt)) {
    throw new Error("Tool batch denied: final DirectTurnScope differs from the settled DirectAttempt head")
  }
  await authority.directTurn.persistRefreshedScope(refreshed)
  authority.directTurn.acceptRefreshedScope({ previous, refreshed, transition: "batch_complete" })
}

export function isToolBatchDirectAttemptAuthority(value: unknown): value is ToolBatchDirectAttemptAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.currentScope !== "function" || typeof candidate.acceptRefreshedScope !== "function") return false
  try {
    return isDirectAttemptScope(candidate.scope)
  } catch {
    return false
  }
}

export function currentDirectAttemptScope(authority: unknown): DirectAttemptScopeV1 | undefined {
  return isToolBatchDirectAttemptAuthority(authority) ? authority.currentScope() : undefined
}

/**
 * Accept only the HostKernel-issued effect-receipt transition for a scope that is
 * still current. Never lets a caller skip a revision or substitute a forged scope.
 */
export function acceptDirectAttemptReceipt(
  authority: unknown,
  previous: DirectAttemptScopeV1,
  receipt: { readonly directAttempt?: unknown; readonly attemptScopeTransition?: unknown },
): void {
  if (!isToolBatchDirectAttemptAuthority(authority)) {
    throw new Error("Tool batch denied: invalid direct Attempt authority")
  }
  const current = authority.currentScope()
  if (!sameDirectAttemptScope(current, previous)) {
    throw new Error("Tool batch denied: direct Attempt scope is stale before effect receipt")
  }
  if (receipt.attemptScopeTransition !== "effect_receipt" || !isDirectAttemptScope(receipt.directAttempt)) {
    throw new Error("Tool batch denied: HostKernel omitted the direct Attempt effect receipt scope")
  }
  if (!isReceiptAdvancedDirectAttemptScope(previous, receipt.directAttempt)) {
    throw new Error("Tool batch denied: HostKernel returned a stale or mismatched direct Attempt receipt scope")
  }
  authority.acceptRefreshedScope({
    previous,
    refreshed: receipt.directAttempt,
    transition: "effect_receipt",
  })
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
 * Apply a complete-batch admission that resolved one use-once lease per effectful
 * call. A host may instead issue a serial Attempt batch: the first lease is eager
 * and every later member is leased only after the previous member's receipt
 * settles. Any mismatch with the prepared calls withholds the complete batch.
 */
async function admitPreparedBatch(
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
    readonly execution?: unknown
  }>,
  calls: ReadonlyArray<{
    readonly callID: string
    readonly capabilityID: string
    readonly kind?: "effect" | "host_callback"
    readonly challenge?: EffectChallenge
    readonly lease?: EffectLease
    readonly execution?: unknown
  }>,
  input: ToolBatchGateInput,
  deny: (reason: string) => void,
  cancellation: ReturnType<typeof createBatchCancellation>,
  directAttempt?: ToolBatchDirectAttemptAuthority,
  managedAttempt?: ManagedAttemptAuthority,
  leaseNext?: PreparedBatchLeaseNext,
): Promise<void> {
  if (input.codeMode) {
    return admitCodeModePreparedBatch(prepared, calls, input, deny, cancellation, directAttempt)
  }
  const reject = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  if (calls.length !== prepared.length || calls.length === 0)
    return reject("Rust returned a mismatched prepared tool batch")
  const byCall = new Map<string, { readonly entry: (typeof calls)[number]; readonly index: number }>()
  const effectIDs = new Set<string>()
  const leaseDigests = new Set<string>()
  // A single lease repeated on every prepared member covers the whole batch
  // operation set; it is not a duplicate lease.
  const batchLease = sharedBatchLease(calls)
  let serialIndex = -1
  for (const [index, entry] of calls.entries()) {
    if (!isGuardIdentity(entry.callID) || !isGuardIdentity(entry.capabilityID) || byCall.has(entry.callID))
      return reject("Rust returned a duplicate or invalid admitted tool call")
    if (entry.lease !== undefined) {
      if (!isEffectLease(entry.lease)) return reject("Rust returned an invalid capability lease")
      // Once the host requests a serial continuation every later member must be
      // lazy; an eager trailing lease would bypass the ordered Attempt handoff.
      if (serialIndex !== -1)
        return reject("Rust returned a prepared tool batch without a serial lease continuation")
      if (!batchLease) {
        if (effectIDs.has(entry.lease.effectID)) return reject("Rust returned a duplicate effect lease")
        if (leaseDigests.has(entry.lease.capabilityLeaseDigest)) return reject("Rust returned a duplicate capability lease")
      }
      effectIDs.add(entry.lease.effectID)
      leaseDigests.add(entry.lease.capabilityLeaseDigest)
    } else {
      if (typeof leaseNext !== "function" || index === 0)
        return reject("Rust returned a prepared tool batch without a serial lease continuation")
      if (serialIndex === -1) serialIndex = index
    }
    byCall.set(entry.callID, { entry, index })
  }

  const serial = serialIndex === -1
    ? undefined
    : createSerialLeaseChain(
        calls,
        serialIndex,
        leaseNext as PreparedBatchLeaseNext,
        effectIDs,
        leaseDigests,
        directAttempt,
        managedAttempt,
      )
  const outcomes: Array<[string, ToolCallOutcome]> = []
  for (const { call, execution } of prepared) {
    const matched = byCall.get(call.callID)
    if (!matched || matched.entry.capabilityID !== call.capabilityID)
      return reject("Rust returned a mismatched prepared tool call")
    if (!["files.write", "files.patch", "terminal.run", "web.search"].includes(call.capabilityID))
      return reject("Rust admitted an unsupported tool batch")
    const admittedExecution = resolveMemberExecution(call.capabilityID, execution, matched.entry.execution)
    const lease = batchLease ?? (serial && matched.index >= serialIndex
      ? serial.handles[matched.index]
      : matched.entry.lease)
    if (!lease) return reject("Rust returned a prepared tool batch without a serial lease continuation")
    outcomes.push([call.callID, {
      status: "prepared",
      capabilityID: call.capabilityID,
      lease,
      ...(admittedExecution !== undefined ? { execution: admittedExecution } : {}),
      ...(directAttempt ? { directAttempt } : {}),
    }])
  }
  for (const [callID, outcome] of outcomes) input.context.outcomes.set(callID, outcome)
}

/**
 * Consume the HostKernel's atomic CodeMode wave projection. Ordinary callbacks
 * receive only a local allowed outcome; effect members require the exact
 * HostKernel challenge or one-use lease. No callback is given synthetic effect
 * authority, and no CodeMode member bypasses whole-wave identity validation.
 */
async function admitCodeModePreparedBatch(
  prepared: ReadonlyArray<{
    readonly call: GuardedToolCall
    readonly definition: ToolBatchDefinition
    readonly execution?: unknown
  }>,
  calls: ReadonlyArray<{
    readonly callID: string
    readonly capabilityID: string
    readonly kind?: "effect" | "host_callback"
    readonly challenge?: EffectChallenge
    readonly lease?: EffectLease
    readonly execution?: unknown
  }>,
  input: ToolBatchGateInput,
  deny: (reason: string) => void,
  cancellation: ReturnType<typeof createBatchCancellation>,
  directAttempt?: ToolBatchDirectAttemptAuthority,
): Promise<void> {
  const reject = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  if (calls.length !== prepared.length || calls.length === 0) return reject("HostKernel returned a mismatched CodeMode wave")
  const controlCount = prepared.filter(({ definition }) => definition.capability.effectClass === "control").length
  if (controlCount > 1 || (controlCount === 1 && prepared.length !== 1)) {
    return reject("CodeMode control calls must be admitted as a single-call wave")
  }

  const effectIDs = new Set<string>()
  const challengeIDs = new Set<string>()
  const leaseDigests = new Set<string>()
  const outcomes: Array<[string, ToolCallOutcome]> = []
  for (const [index, { call, definition, execution }] of prepared.entries()) {
    const member = calls[index]
    if (!member || member.callID !== call.callID || member.capabilityID !== call.capabilityID) {
      return reject("HostKernel CodeMode rows differ from the exact ordered normalized wave")
    }
    if (member.kind === "host_callback") {
      if (member.lease !== undefined || member.challenge !== undefined ||
        (definition.capability.effectClass !== "read_only" && definition.capability.effectClass !== "control")) {
        return reject("HostKernel issued a callback row for a non-callback capability")
      }
      outcomes.push([call.callID, { status: "allowed", capabilityID: call.capabilityID }])
      continue
    }
    if (!["files.write", "files.patch", "terminal.run", "web.search"].includes(call.capabilityID) ||
      member.kind !== "effect" || definition.capability.effectClass !== "effect" ||
      (member.lease === undefined) === (member.challenge === undefined)) {
      return reject("HostKernel CodeMode effect row has an invalid capability or authority kind")
    }
    if (member.challenge !== undefined) {
      if (!isEffectChallenge(member.challenge) || effectIDs.has(member.challenge.effectID) ||
        challengeIDs.has(member.challenge.challengeID)) return reject("HostKernel returned an invalid or duplicate CodeMode challenge")
      effectIDs.add(member.challenge.effectID)
      challengeIDs.add(member.challenge.challengeID)
      if (call.capabilityID === "files.patch") {
        const reason = patchAdmissionMismatch(call, member.challenge)
        if (reason) return reject(reason)
      }
      outcomes.push([call.callID, {
        status: "admitted",
        capabilityID: call.capabilityID,
        challenge: member.challenge,
        ...(execution !== undefined ? { execution } : {}),
        ...(directAttempt ? { directAttempt } : {}),
      }])
      continue
    }
    if (!isEffectLease(member.lease)) return reject("HostKernel returned an invalid CodeMode effect lease")
    if (effectIDs.has(member.lease.effectID) || leaseDigests.has(member.lease.capabilityLeaseDigest)) {
      return reject("HostKernel returned a duplicate CodeMode effect lease")
    }
    effectIDs.add(member.lease.effectID)
    leaseDigests.add(member.lease.capabilityLeaseDigest)
    outcomes.push([call.callID, {
      status: "prepared",
      capabilityID: call.capabilityID,
      lease: member.lease,
      ...(execution !== undefined ? { execution } : {}),
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
  directAttempt?: ToolBatchDirectAttemptAuthority,
  hostExecutions?: ReadonlyMap<string, unknown>,
): Promise<void> {
  const reject = async (reason: string) => {
    await cancellation.cancel()
    deny(reason)
  }
  if (admitted.length !== prepared.length || admitted.length === 0)
    return reject("Rust returned a mismatched prepared tool batch")
  // One ToolBatch is one Guard admission over one operation set. A host that
  // repeats the same lease on every member is describing that single lease.
  const batchLease = sharedBatchLease(admitted)
  const byCall = new Map<string, ToolBatchCallAdmission>()
  const effectIDs = new Set<string>()
  const challengeIDs = new Set<string>()
  const leaseDigests = new Set<string>()
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
    // A mode-approved member is executed under this exact one-use lease; it must be
    // a real capability lease, bound to the member's own effect, and never reused.
    if (entry.lease !== undefined) {
      if (!isEffectLease(entry.lease))
        return reject("Rust returned an admitted tool call with an invalid capability lease")
      if (!batchLease) {
        if (entry.lease.effectID !== entry.challenge.effectID)
          return reject("Rust returned an admitted tool call lease for another effect")
        if (leaseDigests.has(entry.lease.capabilityLeaseDigest))
          return reject("Rust returned a duplicate admitted capability lease")
      }
      leaseDigests.add(entry.lease.capabilityLeaseDigest)
    }
    byCall.set(entry.callID, entry)
  }
  const outcomes: Array<[string, ToolCallOutcome]> = []
  for (const { call, execution } of prepared) {
    const entry = byCall.get(call.callID)
    if (!entry || entry.capabilityID !== call.capabilityID)
      return reject("Rust returned a mismatched prepared tool call")
    if (!["files.write", "files.patch", "terminal.run", "web.search"].includes(call.capabilityID))
      return reject("Rust admitted an unsupported tool batch")
    if (call.capabilityID === "files.patch") {
      const reason = patchAdmissionMismatch(call, entry.challenge)
      if (reason) return reject(reason)
    }
    const hostExecution = entry.execution !== undefined ? entry.execution : hostExecutions?.get(call.callID)
    const admittedExecution = resolveMemberExecution(call.capabilityID, execution, hostExecution)
    // A mode-approved batch already holds this call's one-use lease (or one batch
    // lease covering every member): admit it as `prepared`, which is the only
    // outcome `terminal.run` can execute without a second approval round. Without
    // this the call was withheld with "Shell denied: missing Rust Guard lease"
    // even though Rust had minted it.
    const effectiveLease = batchLease ?? entry.lease
    if (effectiveLease !== undefined) {
      outcomes.push([call.callID, {
        status: "prepared",
        capabilityID: call.capabilityID,
        lease: effectiveLease,
        ...(admittedExecution !== undefined ? { execution: admittedExecution } : {}),
        ...(directAttempt ? { directAttempt } : {}),
      }])
      continue
    }
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

/** Turn a prepare-stage refusal into the reason the model is shown for that call. */
function admissionFailureReason(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const detail = message.replace(/\s+/g, " ").trim()
  if (detail.length === 0) return "invalid tool arguments"
  return `${toolName} could not be prepared: ${detail.slice(0, 400)}`
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

type PreparedBatchLeaseNext = (request: {
  readonly callID: string
  readonly previousEffectID: string
}) => Effect.Effect<ToolBatchCallLease, unknown>

type SerialLeaseMember = {
  readonly index: number
  readonly callID: string
  readonly capabilityID: string
  lease?: EffectLease
  handle?: ToolBatchLeaseHandle
  promise?: Promise<EffectLease>
  resolve?: (lease: EffectLease) => void
  reject?: (error: unknown) => void
  started: boolean
  settled: boolean
}

type SerialLeaseChain = {
  readonly members: SerialLeaseMember[]
  readonly leaseNext: PreparedBatchLeaseNext
  readonly effectIDs: Set<string>
  readonly leaseDigests: Set<string>
  readonly directAttempt?: ToolBatchDirectAttemptAuthority
  readonly managedAttempt?: ManagedAttemptAuthority
}

// The link from an outcome lease (or the raw lease a tool received) back to its
// ordered batch member. WeakMaps keep the handles opaque and collectible.
const serialLeaseStates = new WeakMap<object, { readonly chain: SerialLeaseChain; readonly member: SerialLeaseMember }>()
const serialLeaseHandles = new WeakSet<object>()
const serialLeasePromises = new WeakMap<object, Promise<EffectLease>>()

function isToolBatchLeaseHandle(value: unknown): value is ToolBatchLeaseHandle {
  return typeof value === "object" && value !== null && serialLeaseHandles.has(value)
}

function createSerialLeaseChain(
  calls: ReadonlyArray<{
    readonly callID: string
    readonly capabilityID: string
    readonly lease?: EffectLease
  }>,
  serialIndex: number,
  leaseNext: PreparedBatchLeaseNext,
  effectIDs: Set<string>,
  leaseDigests: Set<string>,
  directAttempt?: ToolBatchDirectAttemptAuthority,
  managedAttempt?: ManagedAttemptAuthority,
): { readonly handles: ReadonlyArray<ToolBatchLeaseHandle | undefined>; readonly members: SerialLeaseMember[] } {
  const members: SerialLeaseMember[] = calls.map((entry, index) => ({
    index,
    callID: entry.callID,
    capabilityID: entry.capabilityID,
    ...(entry.lease !== undefined ? { lease: entry.lease } : {}),
    started: false,
    settled: false,
  }))
  const chain: SerialLeaseChain = { members, leaseNext, effectIDs, leaseDigests, directAttempt, managedAttempt }
  const handles: Array<ToolBatchLeaseHandle | undefined> = []
  for (const [index, entry] of calls.entries()) {
    if (index < serialIndex) {
      serialLeaseStates.set(entry.lease!, { chain, member: members[index]! })
      handles.push(undefined)
      continue
    }
    const member = members[index]!
    let resolve!: (lease: EffectLease) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<EffectLease>((accept, refuse) => {
      resolve = accept
      reject = refuse
    })
    // The continuation can fail before a caller attaches; keep the rejection
    // handled while still surfacing it through resolveToolBatchLease.
    promise.catch(() => {})
    const handle: ToolBatchLeaseHandle = Object.freeze({
      callID: entry.callID,
      capabilityID: entry.capabilityID,
    })
    serialLeaseHandles.add(handle)
    serialLeasePromises.set(handle, promise)
    serialLeaseStates.set(handle, { chain, member })
    member.handle = handle
    member.promise = promise
    member.resolve = resolve
    member.reject = reject
    handles.push(handle)
  }
  return { handles, members }
}

function isManagedAttemptScope(value: unknown): value is ManagedAttemptScopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    return sameManagedAttemptScope(value as ManagedAttemptScopeV1, value as ManagedAttemptScopeV1)
  } catch {
    return false
  }
}

function validateSerialLease(
  chain: SerialLeaseChain,
  member: SerialLeaseMember,
  candidate: ToolBatchCallLease,
): EffectLease {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Tool batch denied: serial lease continuation returned an invalid call")
  }
  if (candidate.callID !== member.callID || candidate.capabilityID !== member.capabilityID) {
    throw new Error("Tool batch denied: serial lease continuation returned a mismatched call")
  }
  if (!isEffectLease(candidate.lease)) {
    throw new Error("Tool batch denied: serial lease continuation returned an invalid capability lease")
  }
  if (chain.effectIDs.has(candidate.lease.effectID)) {
    throw new Error("Tool batch denied: serial lease continuation returned a duplicate effect lease")
  }
  if (chain.leaseDigests.has(candidate.lease.capabilityLeaseDigest)) {
    throw new Error("Tool batch denied: serial lease continuation returned a duplicate capability lease")
  }
  if (candidate.lease.directAttempt !== undefined) {
    if (!isDirectAttemptScope(candidate.lease.directAttempt)) {
      throw new Error("Tool batch denied: serial lease continuation returned an invalid Attempt scope")
    }
    const current = chain.directAttempt?.currentScope()
    if (current && !sameDirectAttemptScope(current, candidate.lease.directAttempt)) {
      if (!isReceiptAdvancedDirectAttemptScope(current, candidate.lease.directAttempt)) {
        throw new Error("Tool batch denied: serial lease continuation returned a stale Attempt scope")
      }
      chain.directAttempt!.acceptRefreshedScope({
        previous: current,
        refreshed: candidate.lease.directAttempt,
        transition: "effect_receipt",
      })
    }
  }
  if (candidate.lease.managedAttempt !== undefined) {
    if (!isManagedAttemptScope(candidate.lease.managedAttempt)) {
      throw new Error("Tool batch denied: serial lease continuation returned an invalid managed Attempt scope")
    }
    const current = chain.managedAttempt?.currentScope()
    if (current && !sameManagedAttemptScope(current, candidate.lease.managedAttempt)) {
      if (!isReceiptAdvancedManagedAttemptScope(current, candidate.lease.managedAttempt)) {
        throw new Error("Tool batch denied: serial lease continuation returned a stale managed Attempt scope")
      }
      chain.managedAttempt!.acceptRefreshedScope({
        previous: current,
        refreshed: candidate.lease.managedAttempt,
        transition: "effect_receipt",
      })
    }
  }
  chain.effectIDs.add(candidate.lease.effectID)
  chain.leaseDigests.add(candidate.lease.capabilityLeaseDigest)
  return candidate.lease
}

function serialLeaseError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === "string" ? reason : "Tool batch denied: serial lease member failed")
}

/** Reject every not-yet-leased successor so a failed member cannot deadlock the batch. */
function abortSerialSuccessors(chain: SerialLeaseChain, index: number, error: Error): void {
  for (const successor of chain.members) {
    if (successor.index <= index || successor.settled || successor.lease !== undefined) continue
    successor.settled = true
    successor.reject?.(error)
  }
}

function requestSerialLease(chain: SerialLeaseChain, index: number): Promise<void> {
  const member = chain.members[index]
  if (!member || member.lease !== undefined || member.started || member.settled || !member.handle) {
    return Promise.resolve()
  }
  const previous = chain.members[index - 1]
  if (!previous?.lease) {
    return Promise.reject(new Error("Tool batch denied: serial lease continuation has no previous receipt"))
  }
  member.started = true
  let pending: Promise<ToolBatchCallLease>
  try {
    pending = Effect.runPromise(chain.leaseNext({
      callID: member.callID,
      previousEffectID: previous.lease.effectID,
    }))
  } catch (error) {
    const failure = serialLeaseError(error)
    member.reject?.(failure)
    abortSerialSuccessors(chain, member.index, failure)
    return Promise.reject(failure)
  }
  return pending.then(
    (candidate) => {
      try {
        const lease = validateSerialLease(chain, member, candidate)
        member.lease = lease
        serialLeaseStates.set(lease, { chain, member })
        member.resolve?.(lease)
      } catch (error) {
        const failure = serialLeaseError(error)
        member.settled = true
        member.reject?.(failure)
        abortSerialSuccessors(chain, member.index, failure)
        throw failure
      }
    },
    (error) => {
      const failure = serialLeaseError(error)
      member.settled = true
      member.reject?.(failure)
      abortSerialSuccessors(chain, member.index, failure)
      throw failure
    },
  )
}

/**
 * Resolve the one-use lease for a prepared ToolBatch member. Serial Attempt members
 * stay pending until the previous member's receipt settles and the host issues the
 * next lease exactly once.
 */
export async function resolveToolBatchLease(lease: unknown): Promise<EffectLease> {
  if (typeof lease === "object" && lease !== null) {
    const pending = serialLeasePromises.get(lease)
    if (pending) return await pending
  }
  if (isEffectLease(lease)) return lease
  throw new Error("Tool batch denied: invalid capability lease")
}

/**
 * Record a successful effect receipt for a prepared member. This is a no-op for
 * ordinary (non-serial) batches; a serial member triggers exactly one continuation.
 */
export async function settleToolBatchLease(
  lease: unknown,
  receipt: { readonly effectID: string },
): Promise<void> {
  if (typeof receipt !== "object" || receipt === null || !isGuardIdentity(receipt.effectID)) {
    throw new Error("Tool batch denied: invalid effect receipt for the capability lease")
  }
  if (typeof lease !== "object" || lease === null) return
  const state = serialLeaseStates.get(lease)
  if (!state) return
  const { chain, member } = state
  if (member.settled) return
  if (member.lease === undefined) {
    throw new Error("Tool batch denied: serial lease settled before its continuation resolved")
  }
  if (member.lease.effectID !== receipt.effectID) {
    throw new Error("Tool batch denied: effect receipt does not match the serial lease")
  }
  member.settled = true
  if (member.index + 1 < chain.members.length) await requestSerialLease(chain, member.index + 1)
}

/**
 * Record a failed effect for a prepared serial member. No receipt exists, so the
 * host must not issue the next lease: every later member is rejected immediately
 * instead of awaiting a continuation that can never arrive.
 */
export function failToolBatchLease(lease: unknown, reason: unknown): void {
  if (typeof lease !== "object" || lease === null) return
  const state = serialLeaseStates.get(lease)
  if (!state) return
  const { chain, member } = state
  if (member.settled) return
  member.settled = true
  abortSerialSuccessors(chain, member.index, serialLeaseError(reason))
}
