import { expect } from "bun:test"
import path from "node:path"
import { Buffer } from "node:buffer"
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { exposeCodingProfileToolIDsV1, SessionTools } from "@/session/tools"
import { createToolBatchContext } from "@/session/tool-batch"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { FSUtil } from "@horizoncode/core/fs-util"
import { TestInstance } from "../fixture/fixture"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  LayerNode.compile(FSUtil.node),
  LayerNode.compile(WebSearchRuntime.node),
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed<Tool.Def[]>([
          {
            id: "timing",
            // This synthetic timing tool exercises tool-call state handling while
            // using an existing canonical capability accepted by the Coding tier.
            capability: { id: "tools.search", effectClass: "read_only" },
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          {
            id: "edit",
            capability: { id: "files.patch", effectClass: "effect" },
            description: "prepares a guarded file edit",
            parameters: Schema.Struct({
              filePath: Schema.String,
              oldString: Schema.String,
              newString: Schema.String,
              replaceAll: Schema.optional(Schema.Boolean),
            }),
            execute: () => Effect.succeed({ title: "edit", metadata: {}, output: "done" }),
          } satisfies Tool.Def,
          {
            id: "custom-plugin-shell",
            description: "runs an unclassified plugin effect",
            parameters: Schema.Struct({}),
            execute: () => Effect.succeed({ title: "", metadata: {}, output: "must not execute" }),
          } satisfies Tool.Def,
          {
            id: "question",
            capability: { id: "question.ask", effectClass: "control" },
            description: "asks the user a clarification question",
            parameters: Schema.Struct({ questions: Schema.Array(Schema.String) }),
            jsonSchema: { type: "object", properties: { questions: { type: "array" } } },
            execute: () => Effect.succeed({ title: "Asked 1 question", metadata: {}, output: "answered" }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("does not expose unclassified registry capabilities through the Coding profile", () =>
  Effect.sync(() => {
    expect(exposeCodingProfileToolIDsV1({
      capabilities: [
        { id: "diagnostic.timing", effectClass: "read_only" },
        { id: "tools.search", effectClass: "read_only" },
      ],
    })).toEqual(["tools.search"])
  }),
)

it.instance("projects the canonical question control without granting effect authority", () =>
  Effect.gen(function* () {
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: () => Effect.succeed({} as SessionV1.ToolPart),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const resolved = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })

    expect(resolved.tools.question).toBeDefined()
    expect(resolved.definitions.question?.capability).toEqual({ id: "question.ask", effectClass: "control" })
    expect(resolved.definitions.question?.internal).toBeUndefined()

    const batch = createToolBatchContext()
    batch.outcomes.set(callID, { status: "allowed", capabilityID: "question.ask" })
    const execute = resolved.tools.question?.execute
    if (!execute) throw new Error("question tool is missing execute")
    const result = yield* Effect.promise(() =>
      execute(
        { questions: ["Where should we look?"] },
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
          experimental_context: batch,
        },
      ),
    )
    expect(result).toMatchObject({ output: "answered" })
  }),
)

it.instance("prepares Edit calls as Guarded files.patch without writing", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const fs = yield* FSUtil.Service
    const target = path.join(test.directory, "edit-preflight.txt")
    const before = "before\n"
    const after = "after\n"
    yield* fs.writeWithDirs(target, before)
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: test.directory, root: test.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: () => Effect.succeed({} as SessionV1.ToolPart),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const resolved = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const definition = resolved.definitions.edit
    expect(definition?.capability).toEqual({ id: "files.patch", effectClass: "effect" })
    if (!definition?.prepare) throw new Error("edit Guard preparation is missing")

    const prepared = yield* Effect.promise(() =>
      definition.prepare!({ filePath: target, oldString: "before", newString: "after" }),
    )
    const operations = [
      {
        operation: "write" as const,
        path: target,
        expectedBeforeBase64: Buffer.from(before).toString("base64"),
        contentBase64: Buffer.from(after).toString("base64"),
      },
    ]
    expect(prepared.arguments).toEqual({ operations })
    expect(prepared.execution).toEqual(operations)
    expect(yield* fs.readFileString(target)).toBe(before)
  }),
)

it.instance(
  "preserves running tool start time across metadata updates",
  () =>
    Effect.gen(function* () {
      const state: SessionV1.ToolPart = {
        id: partID,
        sessionID,
        messageID,
        type: "tool",
        tool: "timing",
        callID,
        state: {
          status: "running",
          input: {},
          time: { start: 100 }
        },
      }
      const updates: number[] = []
      const processor = {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: (_toolCallID, update) =>
          Effect.sync(() => {
            const next = update(state)
            state.state = next.state
            if (state.state.status === "running") updates.push(state.state.time.start)
            return state
          }),
        completeToolCall: () => Effect.void,
      } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      })
      expect(tools.tools["custom-plugin-shell"]).toBeUndefined()
      expect(tools.definitions["custom-plugin-shell"]).toBeUndefined()
      const execute = tools.tools.timing?.execute
      if (!execute) throw new Error("timing tool is missing execute")

      const batch = createToolBatchContext()
      batch.outcomes.set(callID, { status: "allowed", capabilityID: "tools.search" })

      yield* Effect.promise(() =>
        execute(
          {},
          {
            toolCallId: callID,
            abortSignal: new AbortController().signal,
            messages: [],
            experimental_context: batch,
          },
        ),
      )

      expect(updates).toEqual([100, 100])
      expect(state.state.status).toBe("running")
      if (state.state.status === "running") {
        expect(state.state.time.start).toBe(100)
      }
    }),
  { git: true },
)
