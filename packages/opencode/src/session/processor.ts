import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { SessionMessage as SessionMessageSchema } from "@opencode-ai/schema/session-message"

import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import * as ManagedControl from "./managed-control"
import { managedProviderStepFinish } from "./managed-provider-entry"
const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result, SessionSupervisorError>
  /** No-dispatch managed request compilation using the same LLMRequestPrep path. */
  readonly prepareManagedRequest: (streamInput: LLM.StreamInput) => Effect.Effect<LLM.ManagedProviderInputV1, unknown>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle, SessionSupervisorError>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  blocked: boolean
  needsCompaction: boolean
  managedUsageStopped: boolean
  /** Usage receipts staged before ToolBatch Guard admission, keyed by provider step. */
  managedUsageReceipts: Map<number, ManagedControl.ManagedAttemptUsageReceiptV1 | null>
  /** Dispatch receipts are correlated by the provider SDK's stable finish index. */
  managedProviderDispatches: Map<number, LLM.ManagedProviderDispatchHandoffV1>
  managedProviderSettledIndices: Set<number>
  /** Tool calls emitted by the currently streaming provider step. */
  managedProviderStepToolCallIDs: Set<string>
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        blocked: false,
        needsCompaction: false,
        managedUsageStopped: false,
        managedUsageReceipts: new Map(),
        managedProviderDispatches: new Map(),
        managedProviderSettledIndices: new Set(),
        managedProviderStepToolCallIDs: new Set(),
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false
      let activeManagedAttempt: ManagedControl.ManagedAttemptAuthority | undefined

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const persistAndSettleManagedStep = Effect.fn("SessionProcessor.persistAndSettleManagedStep")(function* (input: {
        stepFinishIndex: number
        finishReason: SessionV1.Assistant["finish"]
        cost: number
        tokens: SessionV1.Assistant["tokens"]
        usageProvenance: SessionMessageSchema.UsageProvenance
        usageReceipt: ManagedControl.ManagedAttemptUsageReceiptV1
        calls: readonly {
          toolCallID: string
          toolName: string
          capabilityID: string
          arguments: Record<string, unknown>
        }[]
        authority: ManagedControl.ManagedAttemptAuthority
      }) {
        const handoff = ctx.managedProviderDispatches.get(input.stepFinishIndex)
        if (!handoff) return yield* new SessionSupervisorError({
          stage: "managed_provider_settlement",
          reason: "effectful provider step has no matching one-use HostKernel dispatch receipt",
        })
        const allowed = new Set<string>()
        for (const call of input.calls) {
          if (!call.toolCallID || !call.toolName || allowed.has(call.toolCallID)) {
            return yield* new SessionSupervisorError({
              stage: "managed_provider_settlement",
              reason: "validated ToolBatch calls have malformed or duplicate identities",
            })
          }
          allowed.add(call.toolCallID)
          const existing = yield* ensureToolCall({ id: call.toolCallID, name: call.toolName })
          if (existing.part.state.status !== "pending") {
            return yield* new SessionSupervisorError({
              stage: "managed_provider_settlement",
              reason: "provider call is already running or terminal before its effect admission",
            })
          }
          yield* session.updatePart({
            ...existing.part,
            state: {
              status: "pending",
              input: call.arguments,
              raw: JSON.stringify(call.arguments),
            },
          })
          ctx.managedProviderStepToolCallIDs.add(call.toolCallID)
        }

        ctx.assistantMessage.finish = input.finishReason
        ctx.assistantMessage.cost += input.cost
        ctx.assistantMessage.tokens = input.tokens
        ;(ctx.assistantMessage as typeof ctx.assistantMessage & { usageProvenance?: typeof input.usageProvenance }).usageProvenance = input.usageProvenance
        yield* session.updatePart({
          id: PartID.ascending(),
          reason: input.finishReason,
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "step-finish",
          tokens: input.tokens,
          cost: input.cost,
          usageProvenance: input.usageProvenance,
          stepFinishIndex: input.stepFinishIndex,
          managedUsageReceipt: input.usageReceipt,
        } as SessionV1.StepFinishPart & {
          usageProvenance: SessionMessageSchema.UsageProvenance
          stepFinishIndex: number
          managedUsageReceipt: ManagedControl.ManagedAttemptUsageReceiptV1
        })
        yield* session.updateMessage(ctx.assistantMessage)

        const persisted = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id }).pipe(
          Effect.provideService(Database.Service, database),
        )
        const matchingSteps = persisted.parts.filter((part) =>
          part.type === "step-finish" && (part as SessionV1.StepFinishPart & { stepFinishIndex?: number }).stepFinishIndex === input.stepFinishIndex)
        if (matchingSteps.length !== 1) {
          return yield* new SessionSupervisorError({
            stage: "managed_provider_settlement",
            reason: "persisted transcript does not contain exactly one indexed step-finish part",
          })
        }
        const unresolved = persisted.parts.filter((part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))
        if (unresolved.length !== allowed.size || unresolved.some((part) => !allowed.has(part.callID))) {
          return yield* new SessionSupervisorError({
            stage: "managed_provider_settlement",
            reason: "persisted provider snapshot contains missing or unrelated unresolved tool work",
          })
        }
        const receipt = managedProviderStepFinish({
          info: persisted.info,
          stepFinishPart: matchingSteps[0],
          stepFinishIndex: input.stepFinishIndex,
        })
        const previous = input.authority.currentScope()
        const settlement = yield* ManagedControl.settleManagedProviderRequest({
          authority: input.authority,
          scope: previous,
          providerRequestID: handoff.providerRequestID,
          prepareDigest: handoff.prepareDigest,
          dispatchDigest: handoff.dispatchDigest,
          transportRequestDigest: handoff.requestPins.transportRequestDigest,
          operationDigest: handoff.requestPins.operationDigest,
          assistantEntryID: persisted.info.id,
          responseDigest: receipt.responseDigest,
          usageProvenance: receipt.usageProvenance,
          stepFinishIndex: input.stepFinishIndex,
        })
        input.authority.acceptRefreshedScope({
          previous,
          refreshed: settlement.managedAttempt,
          transition: "provider_settlement",
        })
        ctx.managedProviderDispatches.delete(input.stepFinishIndex)
        ctx.managedProviderSettledIndices.add(input.stepFinishIndex)
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (
        value: StreamEvent,
        managedAttempt?: LLM.StreamInput["managedAttempt"],
      ) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            if (managedAttempt) ctx.managedProviderStepToolCallIDs.add(value.id)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "step-start",
            })
            return

          case "step-finish": {
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            const alreadySettledBeforeEffects = ctx.managedProviderSettledIndices.has(value.index)
            let managedUsageReceipt: ManagedControl.ManagedAttemptUsageReceiptV1 | undefined
            if (managedAttempt) {
              if (ctx.managedUsageReceipts.has(value.index)) {
                managedUsageReceipt = ctx.managedUsageReceipts.get(value.index) ?? undefined
                ctx.managedUsageReceipts.delete(value.index)
                ctx.managedUsageStopped ||= managedUsageReceipt?.status === "STOPPED" || managedUsageReceipt === undefined
                if (ctx.managedUsageStopped) managedAttempt.markUsageStopped?.()
              } else {
                const previous = managedAttempt.currentScope()
                managedUsageReceipt = yield* ManagedControl.recordAttemptUsage({
                  scope: previous,
                  assistantMessageID: ctx.assistantMessage.id,
                  stepFinishIndex: value.index,
                  usageProvenance: usage.usageProvenance,
                })
                managedAttempt.acceptRefreshedScope({
                  previous,
                  refreshed: managedUsageReceipt.managedAttempt,
                  transition: "usage_accounting",
                })
                ctx.managedUsageStopped = managedUsageReceipt.status === "STOPPED"
                if (ctx.managedUsageStopped) managedAttempt.markUsageStopped?.()
              }
            }
            if (!alreadySettledBeforeEffects) {
              ctx.assistantMessage.finish = value.reason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              ;(ctx.assistantMessage as typeof ctx.assistantMessage & { usageProvenance?: typeof usage.usageProvenance }).usageProvenance = usage.usageProvenance
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: value.reason,
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
                usageProvenance: usage.usageProvenance,
                stepFinishIndex: value.index,
                ...(managedUsageReceipt ? { managedUsageReceipt } : {}),
              } as SessionV1.StepFinishPart & { usageProvenance: typeof usage.usageProvenance; stepFinishIndex: number; managedUsageReceipt?: ManagedControl.ManagedAttemptUsageReceiptV1 })
              yield* session.updateMessage(ctx.assistantMessage)
            }
            if (managedAttempt) {
              if (alreadySettledBeforeEffects) {
                ctx.managedProviderSettledIndices.delete(value.index)
                ctx.managedProviderStepToolCallIDs.clear()
              } else {
              const handoff = ctx.managedProviderDispatches.get(value.index)
              if (!handoff) {
                managedAttempt.markUsageStopped?.()
                return yield* new SessionSupervisorError({
                  stage: "managed_provider_settlement",
                  reason: "persisted provider step has no matching one-use HostKernel dispatch receipt",
                })
              }
              const persisted = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id }).pipe(
                Effect.provideService(Database.Service, database),
              )
              const matchingSteps = persisted.parts.filter((part) =>
                part.type === "step-finish" && (part as SessionV1.StepFinishPart & { stepFinishIndex?: number }).stepFinishIndex === value.index)
              if (matchingSteps.length !== 1) {
                managedAttempt.markUsageStopped?.()
                return yield* new SessionSupervisorError({
                  stage: "managed_provider_settlement",
                  reason: "persisted transcript does not contain exactly one indexed step-finish part",
                })
              }
              const pending = persisted.parts.filter((part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))
              if (pending.some((part) => !ctx.managedProviderStepToolCallIDs.has(part.callID))) {
                managedAttempt.markUsageStopped?.()
                return yield* new SessionSupervisorError({
                  stage: "managed_provider_settlement",
                  reason: "persisted provider snapshot contains unrelated unresolved tool work",
                })
              }
              let receipt: ReturnType<typeof managedProviderStepFinish>
              try {
                receipt = managedProviderStepFinish({
                  info: persisted.info,
                  stepFinishPart: matchingSteps[0],
                  stepFinishIndex: value.index,
                })
              } catch {
                managedAttempt.markUsageStopped?.()
                return yield* new SessionSupervisorError({
                  stage: "managed_provider_settlement",
                  reason: "persisted provider response snapshot failed strict receipt decoding",
                })
              }
              const previous = managedAttempt.currentScope()
              const settlement = yield* Effect.exit(ManagedControl.settleManagedProviderRequest({
                authority: managedAttempt,
                scope: previous,
                providerRequestID: handoff.providerRequestID,
                prepareDigest: handoff.prepareDigest,
                dispatchDigest: handoff.dispatchDigest,
                transportRequestDigest: handoff.requestPins.transportRequestDigest,
                operationDigest: handoff.requestPins.operationDigest,
                assistantEntryID: persisted.info.id,
                responseDigest: receipt.responseDigest,
                usageProvenance: receipt.usageProvenance,
                stepFinishIndex: value.index,
              }))
              if (Exit.isFailure(settlement)) {
                const unknown = yield* ManagedControl.markManagedProviderRequestUnknown({
                  scope: managedAttempt.currentScope(),
                  providerRequestID: handoff.providerRequestID,
                  prepareDigest: handoff.prepareDigest,
                  dispatchDigest: handoff.dispatchDigest,
                  transportRequestDigest: handoff.requestPins.transportRequestDigest,
                  operationDigest: handoff.requestPins.operationDigest,
                  reasonCode: "settlement_unknown",
                })
                managedAttempt.acceptRefreshedScope({
                  previous: managedAttempt.currentScope(),
                  refreshed: unknown.managedAttempt,
                  transition: "provider_settlement",
                })
                return yield* new SessionSupervisorError({
                  stage: "managed_provider_settlement",
                  reason: "provider response settlement is ambiguous; the exact dispatch is fenced UNKNOWN",
                })
              }
              managedAttempt.acceptRefreshedScope({
                previous,
                refreshed: settlement.value.managedAttempt,
                transition: "provider_settlement",
              })
              ctx.managedProviderDispatches.delete(value.index)
              ctx.managedProviderStepToolCallIDs.clear()
              }
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        if (activeManagedAttempt) {
          for (const handoff of ctx.managedProviderDispatches.values()) {
            const previous = activeManagedAttempt.currentScope()
            const unknown = yield* Effect.exit(ManagedControl.markManagedProviderRequestUnknown({
              scope: previous,
              providerRequestID: handoff.providerRequestID,
              prepareDigest: handoff.prepareDigest,
              dispatchDigest: handoff.dispatchDigest,
              transportRequestDigest: handoff.requestPins.transportRequestDigest,
              operationDigest: handoff.requestPins.operationDigest,
              reasonCode: aborted ? "stream_interrupted_unknown" : "stream_failure_unknown",
            }))
            if (Exit.isSuccess(unknown)) {
              try {
                activeManagedAttempt.acceptRefreshedScope({
                  previous,
                  refreshed: unknown.value.managedAttempt,
                  transition: "provider_settlement",
                })
                ctx.managedProviderDispatches.delete(handoff.stepFinishIndex)
              } catch {
                // Preserve the local dispatch record; recovery will inspect its durable HostKernel state.
              }
            }
          }
        }
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.managedUsageReceipts.clear()
        ctx.managedProviderDispatches.clear()
        ctx.managedProviderStepToolCallIDs.clear()
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            const managedAttempt = streamInput.managedAttempt
            activeManagedAttempt = managedAttempt
            const stream = llm.stream({
              ...streamInput,
              ...(managedAttempt
                ? {
                    authorizeManagedProviderRequest: (selection) =>
                      Effect.gen(function* () {
                        const previous = managedAttempt.currentScope()
                        const context = streamInput.managedContext
                        if (!context || !context.initialSelection) {
                          return yield* new SessionSupervisorError({
                            stage: "managed_context",
                            reason: "managed request has no frozen sequence-1 ContextSelection",
                          })
                        }
                        const pin = managedAttempt.contextSelectionPin()
                        if (selection.requestSequence === context.requestSequence) {
                          if (selection.requestID !== context.requestID ||
                            JSON.stringify(selection) !== JSON.stringify(context.initialSelection) ||
                            pin.requestSequence !== selection.requestSequence ||
                            pin.requestID !== selection.requestID ||
                            pin.contextSelectionDigest !== context.contextSelectionDigest ||
                            previous.contextSelectionDigest !== context.contextSelectionDigest) {
                            return yield* new SessionSupervisorError({
                              stage: "managed_context",
                              reason: "prepared sequence-1 request differs from the HostKernel admission pin",
                            })
                          }
                          return
                        }
                        const exit = yield* Effect.exit(ManagedControl.advanceManagedContext({
                          scope: previous,
                          contextSelection: selection,
                        }))
                        if (Exit.isFailure(exit)) {
                          return yield* new SessionSupervisorError({
                            stage: "managed_context",
                            reason: "HostKernel did not admit the exact next managed provider request",
                          })
                        }
                        try {
                          managedAttempt.acceptRefreshedScope({
                            previous,
                            refreshed: exit.value.managedAttempt,
                            transition: "context_selection",
                          })
                        } catch {
                          return yield* new SessionSupervisorError({
                            stage: "managed_context",
                            reason: "HostKernel context receipt did not advance the current Attempt scope",
                          })
                        }
                      }),
                    onManagedProviderDispatch: (handoff) =>
                      Effect.gen(function* () {
                        const scope = managedAttempt.currentScope()
                        const pin = managedAttempt.contextSelectionPin()
                        if (handoff.status !== "DISPATCHING" ||
                          !Number.isSafeInteger(handoff.stepFinishIndex) || handoff.stepFinishIndex < 0 ||
                          handoff.contextSelection.sessionID !== streamInput.managedContext?.selectionSessionID ||
                          handoff.contextSelection.attemptID !== scope.attemptID ||
                          handoff.contextSelection.requestID !== pin.requestID ||
                          handoff.contextSelection.requestSequence !== pin.requestSequence ||
                          handoff.requestPins.requestID !== pin.requestID ||
                          handoff.requestPins.requestSequence !== pin.requestSequence ||
                          handoff.requestPins.contextSelectionDigest !== pin.contextSelectionDigest ||
                          handoff.providerRequestID !== `mpr_${scope.attemptID}_${pin.requestSequence}` ||
                          !/^blake3:[0-9a-f]{64}$/.test(handoff.prepareDigest) ||
                          !/^blake3:[0-9a-f]{64}$/.test(handoff.dispatchDigest)) {
                          return yield* new SessionSupervisorError({
                            stage: "managed_provider_dispatch",
                            reason: "HostKernel dispatch handoff does not match the current managed ContextSelection and Attempt",
                          })
                        }
                        if (ctx.managedProviderDispatches.has(handoff.stepFinishIndex)) {
                          return yield* new SessionSupervisorError({
                            stage: "managed_provider_dispatch",
                            reason: "a provider dispatch already occupies this persisted step-finish index",
                          })
                        }
                        ctx.managedProviderDispatches.set(handoff.stepFinishIndex, handoff)
                      }),
                    beforeManagedEffects: ({ stepFinishIndex, usageProvenance, finishReason, cost, tokens, calls }) =>
                      Effect.gen(function* () {
                        const previous = managedAttempt.currentScope()
                        const handoff = ctx.managedProviderDispatches.get(stepFinishIndex)
                        const fenceUnknown = Effect.fn("SessionProcessor.fenceUnknownManagedProviderStep")(function* (reasonCode: string) {
                          if (!handoff) return false
                          const scope = managedAttempt.currentScope()
                          const exit = yield* Effect.exit(ManagedControl.markManagedProviderRequestUnknown({
                            scope,
                            providerRequestID: handoff.providerRequestID,
                            prepareDigest: handoff.prepareDigest,
                            dispatchDigest: handoff.dispatchDigest,
                            transportRequestDigest: handoff.requestPins.transportRequestDigest,
                            operationDigest: handoff.requestPins.operationDigest,
                            reasonCode,
                          }))
                          if (Exit.isFailure(exit)) return false
                          try {
                            managedAttempt.acceptRefreshedScope({
                              previous: scope,
                              refreshed: exit.value.managedAttempt,
                              transition: "provider_settlement",
                            })
                            return true
                          } catch {
                            return false
                          }
                        })
                        if (!handoff || handoff.stepFinishIndex !== stepFinishIndex) {
                          ctx.managedUsageReceipts.set(stepFinishIndex, null)
                          ctx.managedUsageStopped = true
                          managedAttempt.markUsageStopped?.()
                          return "STOPPED" as const
                        }
                        const exit = yield* Effect.exit(
                          ManagedControl.recordAttemptUsage({
                            scope: previous,
                            assistantMessageID: ctx.assistantMessage.id,
                            stepFinishIndex,
                            usageProvenance,
                          }),
                        )
                        if (Exit.isFailure(exit)) {
                          ctx.managedUsageReceipts.set(stepFinishIndex, null)
                          ctx.managedUsageStopped = true
                          managedAttempt.markUsageStopped?.()
                          yield* fenceUnknown("usage_accounting_unknown")
                          yield* Effect.logError("managed usage could not be accounted before Guard admission", {
                            sessionID: ctx.sessionID,
                            messageID: ctx.assistantMessage.id,
                            stepFinishIndex,
                            cause: Cause.pretty(exit.cause),
                          })
                          return "STOPPED" as const
                        }
                        try {
                          managedAttempt.acceptRefreshedScope({
                            previous,
                            refreshed: exit.value.managedAttempt,
                            transition: "usage_accounting",
                          })
                        } catch (error) {
                          ctx.managedUsageReceipts.set(stepFinishIndex, null)
                          ctx.managedUsageStopped = true
                          managedAttempt.markUsageStopped?.()
                          yield* fenceUnknown("usage_scope_unknown")
                          yield* Effect.logError("managed usage receipt scope was stale before Guard admission", {
                            sessionID: ctx.sessionID,
                            messageID: ctx.assistantMessage.id,
                            stepFinishIndex,
                            error,
                          })
                          return "STOPPED" as const
                        }
                        ctx.managedUsageReceipts.set(stepFinishIndex, exit.value)
                        ctx.managedUsageStopped = exit.value.status === "STOPPED"
                        if (ctx.managedUsageStopped) managedAttempt.markUsageStopped?.()
                        const persisted = yield* Effect.exit(persistAndSettleManagedStep({
                          stepFinishIndex,
                          finishReason,
                          cost,
                          tokens,
                          usageProvenance,
                          usageReceipt: exit.value,
                          calls,
                          authority: managedAttempt,
                        }))
                        if (Exit.isFailure(persisted)) {
                          ctx.managedUsageStopped = true
                          managedAttempt.markUsageStopped?.()
                          yield* fenceUnknown("provider_settlement_unknown")
                          yield* Effect.logError("managed provider step could not be durably persisted and settled before Guard admission", {
                            sessionID: ctx.sessionID,
                            messageID: ctx.assistantMessage.id,
                            stepFinishIndex,
                            cause: Cause.pretty(persisted.cause),
                          })
                          return "STOPPED" as const
                        }
                        if (exit.value.status === "STOPPED") {
                          for (const call of calls) {
                            const existing = yield* readToolCall(call.toolCallID)
                            if (existing?.part.state.status === "pending") {
                              const now = Date.now()
                              yield* session.updatePart({
                                ...existing.part,
                                state: {
                                  status: "error",
                                  input: call.arguments,
                                  error: "Managed Attempt budget is exhausted; the guarded action was not dispatched",
                                  time: { start: now, end: now },
                                },
                              })
                              yield* settleToolCall(call.toolCallID)
                            }
                          }
                          return "STOPPED" as const
                        }
                        return exit.value.status
                      }),
                  }
                : {}),
            })

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event, streamInput.managedAttempt)),
              Stream.takeUntil(() => ctx.needsCompaction || ctx.managedUsageStopped),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          // Rust durably marks the managed Attempt STOPPED when its token/cost
          // ceiling is reached or usage cannot be accounted safely. The stream
          // has already been cut at that step-finish, so do not re-enter the
          // prompt loop and start another provider request under the stopped
          // Attempt. Returning "continue" here would turn the accounting
          // boundary into a local UI hint instead of a dispatch fence.
          if (ctx.blocked || ctx.assistantMessage.error || ctx.managedUsageStopped) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
        prepareManagedRequest: (streamInput) => llm.prepareManagedRequest(streamInput),
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
