import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebSearchTool.node]),
    [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
  ),
)

// The legacy Core origin must remain absent until it is replaced by the
// Guarded HorizonCode WebSearchBroker. There is intentionally no HttpClient,
// credential, or provider-selection setup in this fixture.
describe("legacy Core web search origin", () => {
  it.effect("is withheld from model definitions without a Guard-mediated capability", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )
})
