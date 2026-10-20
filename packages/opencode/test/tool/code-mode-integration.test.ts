import { expect, test } from "bun:test"
import { CodeModeTool } from "@/tool/code-mode"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Layer } from "effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code-mode-guard"),
  messageID: MessageID.make("msg_code-mode-guard"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode_guard",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

test("CodeMode refuses MCP dispatch before the client can observe a call", async () => {
  let dispatches = 0
  const layer = Layer.mergeAll(
    Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as any) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as any) }),
    Layer.mock(MCP.Service, {
      tools: () =>
        Effect.succeed({
          fixtures_echo: {
            def: { name: "echo", description: "test", inputSchema: { type: "object" } },
            client: {
              callTool: async () => {
                dispatches += 1
                return { content: [{ type: "text", text: "unexpected" }] }
              },
            },
          },
        } as any),
      clients: () => Effect.succeed({ fixtures: {} as any }),
    }),
  )
  const tool = await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
  const exit = await Effect.runPromise(
    tool.execute({ code: "return await tools.fixtures.echo({})" }, ctx).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect((Cause.squash(exit.cause) as Error).message).toContain("canonical Rust Guard/ExecutionHost route")
  }
  expect(dispatches).toBe(0)
})
