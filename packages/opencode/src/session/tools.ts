import { Agent } from "@/agent/agent"
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
import { requireToolExecution, type ToolBatchDefinition } from "./tool-batch"


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
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    effect?: Tool.Context["effect"],
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
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
      (capability.effectClass === "effect" && capability.id === "files.write")
    if (!supported) continue

    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const normalize =
      item.id === "write"
        ? (value: unknown) => {
            if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
              throw new Error("Invalid files.write arguments")
            return { path: value.filePath, content: value.content }
          }
        : undefined
    definitions[item.id] = {
      capability,
      schema,
      validate: (value) => run.promise(Schema.decodeUnknownEffect(item.parameters)(value)),
      ...(normalize ? { normalize } : {}),
      ...(internal ? { internal: true } : {}),
    }
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const effect = requireToolExecution({
              context: options.experimental_context,
              callID: options.toolCallId,
              capability,
              internal,
            })
            const ctx = context(args, options, effect)
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
