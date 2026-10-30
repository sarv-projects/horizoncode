import { describe, expect, test } from "bun:test"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import {
  ManagedArtifactSearchTool,
  ManagedTerminalOutputRangeTool,
  ManagedTerminalSearchTool,
} from "@/tool/managed-artifact-search"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

// Tool definitions are materialized by ToolRegistry while the AppRuntime layer
// graph is still being constructed, i.e. with no per-directory `InstanceRef`.
// Their init effect must therefore never resolve `InstanceState.context`;
// per-instance state belongs in the deferred execute path only.
const stubs = Layer.mergeAll(
  Layer.succeed(SessionSupervisor.Service, {} as never),
  Layer.succeed(Agent.Service, {} as never),
  Layer.succeed(Truncate.Service, {} as never),
)

const initialize = async (tool: { readonly id: string } & Effect.Effect<unknown, never, never>) => {
  const info = await Effect.runPromise(tool.pipe(Effect.provide(stubs)))
  return Effect.runPromise(Tool.init(info as never).pipe(Effect.provide(stubs)))
}

describe("managed artifact tool definitions", () => {
  test("initialize without an InstanceRef", async () => {
    for (const tool of [ManagedArtifactSearchTool, ManagedTerminalSearchTool, ManagedTerminalOutputRangeTool]) {
      const definition = await initialize(tool as never)
      expect(definition.id).toBe(tool.id)
      expect(typeof definition.execute).toBe("function")
    }
  })
})
