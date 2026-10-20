import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_websearch_test")
const requests: string[] = []
const assertions: PermissionV2.AssertInput[] = []

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push(request.url)).pipe(
      Effect.andThen(Effect.succeed(new Response("", { status: 200 }))),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
  }),
)
const websearchConfig = Layer.succeed(
  WebSearchTool.ConfigService,
  WebSearchTool.ConfigService.of({
    provider: undefined,
    enableExa: false,
    enableParallel: false,
    exaApiKey: undefined,
    parallelApiKey: undefined,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebSearchTool.configNode, WebSearchTool.node]),
    [
      [PermissionV2.node, permission],
      [LayerNodePlatform.httpClient, http],
      [WebSearchTool.configNode, websearchConfig],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

describe("WebSearchTool provider selection", () => {
  test("rejects out-of-range numeric controls", () => {
    const decode = Schema.decodeUnknownSync(WebSearchTool.Input)
    expect(() => decode({ query: "x", numResults: 0 })).toThrow()
    expect(() => decode({ query: "x", numResults: WebSearchTool.MAX_NUM_RESULTS + 1 })).toThrow()
    expect(() => decode({ query: "x", contextMaxCharacters: WebSearchTool.MAX_CONTEXT_CHARACTERS + 1 })).toThrow()
  })
  test("selects a stable provider per session", () => {
    expect(WebSearchTool.selectProvider(sessionID)).toBe(WebSearchTool.selectProvider(sessionID))
  })

  test("supports an explicit operational override", () => {
    expect(WebSearchTool.selectProvider(sessionID, { enableExa: false, enableParallel: false }, "parallel")).toBe(
      "parallel",
    )
    expect(WebSearchTool.selectProvider(sessionID, { enableExa: false, enableParallel: false }, "exa")).toBe("exa")
  })

  test("prefers Parallel when both explicit flags are enabled", () => {
    expect(WebSearchTool.selectProvider(sessionID, { enableExa: true, enableParallel: true })).toBe("parallel")
  })

  test("prefers Exa when only its explicit flag is enabled", () => {
    expect(WebSearchTool.selectProvider(sessionID, { enableExa: true, enableParallel: false })).toBe("exa")
  })
})

describe("WebSearchTool MCP response parser", () => {
  const payload = (text: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text }] },
    })

  test("parses plain JSON-RPC responses", async () => {
    expect(await Effect.runPromise(WebSearchTool.parseResponse(payload("search results")))).toBe("search results")
  })

  test("parses SSE JSON-RPC responses and ignores non-JSON frames", async () => {
    expect(
      await Effect.runPromise(
        WebSearchTool.parseResponse(`data: [DONE]\nevent: message\ndata: ${payload("search results")}\n\n`),
      ),
    ).toBe("search results")
  })
})

// V1 fail-closed contract (plan 2026-10-11, "ToolRegistry.materialize omits registrations
// whose capability effectClass is unknown"): the leaf declares no Guard-mediated capability,
// so it must be absent from model definitions and settlement. These negatives pin zero
// network traffic and zero permission requests. Re-enabling this origin requires declaring
// the mediated capability and restoring the removed leaf behavior specs.
describe("WebSearchTool fail-closed origin", () => {
  it.effect("is withheld from model definitions without a Guard-mediated capability", () =>
    Effect.gen(function* () {
      requests.length = 0
      assertions.length = 0
      const registry = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(registry)).toEqual([])
      expect(requests).toEqual([])
      expect(assertions).toEqual([])
    }),
  )

  it.effect("cannot settle, validate, or classify as anything but unknown, with zero network and zero permission", () =>
    Effect.gen(function* () {
      requests.length = 0
      assertions.length = 0
      const registry = yield* ToolRegistry.Service
      const call_ = {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call" as const,
          id: "call-websearch",
          name: "websearch",
          input: { query: "must not reach a provider" },
        },
      }

      expect(yield* executeTool(registry, call_)).toEqual({ type: "error", value: "Unknown tool: websearch" })

      const materialized = yield* registry.materialize()
      expect(yield* materialized.validate(call_.call)).toEqual("Unknown tool: websearch")
      expect(materialized.classify(call_.call)).toEqual({ id: "websearch", effectClass: "unknown" })

      expect(requests).toEqual([])
      expect(assertions).toEqual([])
    }),
  )
})
