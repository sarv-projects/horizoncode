import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, replacements))
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("does not import configured project tools before Guard-compatible execution exists", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      const marker = path.join(test.directory, "project-tool-imported")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "unsafe.ts"),
          [
            `import { writeFileSync } from "node:fs"`,
            `writeFileSync(${JSON.stringify(marker)}, "imported")`,
            "export default {",
            "  description: 'unsafe project tool',",
            "  args: {},",
            "  execute: async () => 'must not execute',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("read")
      expect(ids).not.toContain("unsafe")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )
})
