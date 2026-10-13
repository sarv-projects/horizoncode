import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"

import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Effect, Schema } from "effect"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import type { EffectLease } from "@opencode-ai/core/session/supervisor"
import path from "node:path"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { requireToolExecution, type ToolBatchDefinition, toolCallOutcome } from "./tool-batch"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { preparePatchBatch } from "@/tool/apply_patch"


export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const definitions: Record<string, ToolBatchDefinition> = {}
  const run = yield* EffectBridge.make()
  const instance = yield* InstanceState.context
  const fs = yield* FSUtil.Service
  const flags = yield* RuntimeFlags.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    effect?: Tool.Context["effect"],
    guardedPatch?: unknown,
    guardedLease?: EffectLease,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(guardedPatch !== undefined ? { guardedPatch } : {}),
      ...(guardedLease !== undefined ? { guardedLease } : {}),
    },
    effect,
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const internal = item.id === "invalid"
    const capability: Tool.Capability = internal
      ? { id: "tool.invalid", effectClass: "control" }
      : (item.capability ?? { id: item.id, effectClass: "unknown" })
    const supported =
      internal ||
      capability.effectClass === "read_only" ||
      (capability.effectClass === "effect" && ["files.write", "files.patch", "terminal.run"].includes(capability.id))

    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const normalize =
      item.id === "write"
        ? (value: unknown) => {
            if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
              throw new Error("Invalid files.write arguments")
            return { path: value.filePath, content: value.content }
          }
        : undefined
    const prepare =
      item.id === "apply_patch"
        ? async (value: unknown) => {
            if (!isRecord(value) || typeof value.patchText !== "string") throw new Error("Invalid apply_patch arguments")
            const prepared = await run.promise(preparePatchBatch(value.patchText, instance.directory, fs))
            return { arguments: { operations: prepared.operations }, execution: prepared.operations }
          }
        : item.id === "bash"
          ? async (value: unknown) => {
              if (
                !isRecord(value) ||
                typeof value.command !== "string" ||
                (value.workdir !== undefined && typeof value.workdir !== "string") ||
                (value.timeout !== undefined &&
                  (typeof value.timeout !== "number" || !Number.isSafeInteger(value.timeout) || value.timeout <= 0))
              )
                throw new Error("Invalid terminal.run arguments")
              const execution = {
                command: value.command,
                cwd: path.resolve(instance.directory, value.workdir ?? "."),
                timeoutMs: value.timeout ?? flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000,
              }
              return { arguments: execution, execution }
            }
          : undefined
    definitions[item.id] = {
      capability,
      schema,
      validate: (value) => run.promise(Schema.decodeUnknownEffect(item.parameters)(value)),
      ...(normalize ? { normalize } : {}),
      ...(prepare ? { prepare } : {}),
      ...(internal ? { internal: true } : {}),
    }
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const outcome = toolCallOutcome(options.experimental_context, options.toolCallId)
            const effect = requireToolExecution({
              context: options.experimental_context,
              callID: options.toolCallId,
              capability,
              internal,
            })
            const guardedPatch =
              outcome?.status === "prepared" || outcome?.status === "admitted" || outcome?.status === "no_effect"
                ? outcome.execution
                : undefined
            const guardedLease = outcome?.status === "prepared" ? outcome.lease : undefined
            const ctx = context(
              args,
              options,
              effect && "challengeID" in effect ? effect : undefined,
              guardedPatch,
              guardedLease,
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  return { tools, definitions }
})


export * as SessionTools from "./tools"
