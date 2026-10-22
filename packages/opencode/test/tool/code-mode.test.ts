import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { CodeModeTool, Parameters } from "@/tool/code-mode"
import { Tool } from "@/tool/tool"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code_mode_fail_closed"),
  messageID: MessageID.make("msg_code_mode_fail_closed"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode_fail_closed",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

test("defines a script body with the Effect schema", async () => {
  const decode = Schema.decodeUnknownEffect(Parameters)
  await expect(Effect.runPromise(decode({ code: "return 1" }))).resolves.toEqual({ code: "return 1" })
  await expect(Effect.runPromise(decode({}))).rejects.toThrow()
})

test("does not evaluate source before the supervised helper is accepted", async () => {
  let dispatches = 0
  const metadata: unknown[] = []
  const tool = {
    def: { name: "echo", description: "test", inputSchema: { type: "object" } } as MCPToolDef,
    client: {
      callTool: async () => {
        dispatches += 1
        return { content: [{ type: "text", text: "unexpected" }] }
      },
    } as any,
  }
  const layer = Layer.mergeAll(
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed({ fixture_echo: tool }),
      clients: () => Effect.succeed({ fixture: {} as any }),
    }),
  )
  const operation = CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer))
  const initialized = await Effect.runPromise(operation)
  const result = await Effect.runPromise(
    initialized.execute(
      { code: "return await tools.fixture.echo({ token: 'must-not-leak' })" },
      { ...ctx, metadata: (value) => Effect.sync(() => metadata.push(value)) },
    ),
  )

  expect(result.output).toContain("supervised helper")
  expect(result.metadata).toMatchObject({ error: true, toolCalls: [] })
  expect(dispatches).toBe(0)
  expect(JSON.stringify(metadata)).not.toContain("must-not-leak")
})

test("does not perform setup or dispatch after cancellation", async () => {
  let mcpReads = 0
  const controller = new AbortController()
  controller.abort()
  const layer = Layer.mergeAll(
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.sync(() => { mcpReads += 1; return {} }),
      clients: () => Effect.succeed({}),
    }),
  )
  const initialized = await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
  const result = await Effect.runPromise(
    initialized.execute({ code: "throw new Error('must not run')" }, { ...ctx, abort: controller.signal }),
  )

  expect(result.output).toBe("Execution cancelled.")
  expect(mcpReads).toBe(0)
})
