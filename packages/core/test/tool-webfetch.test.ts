import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { PermissionV2 } from "@horizoncode/core/permission"
import { SessionV2 } from "@horizoncode/core/session"
import { ToolRegistry } from "@horizoncode/core/tool/registry"
import { WebFetchTool } from "@horizoncode/core/tool/webfetch"
import { ToolOutputStore } from "@horizoncode/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: string[] = []
const assertions: PermissionV2.AssertInput[] = []

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push(request.url)).pipe(
      Effect.andThen(Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))),
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
const toolLayer = () =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [LayerNodePlatform.httpClient, http],
  ])
const it = testEffect(toolLayer())

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

const reset = () => {
  requests.length = 0
  assertions.length = 0
}

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })
})

// V1 fail-closed contract (plan 2026-10-11, "ToolRegistry.materialize omits registrations
// whose capability effectClass is unknown"): the leaf declares no Guard-mediated capability,
// so it must be absent from model definitions and settlement. These negatives pin zero
// network traffic and zero permission requests. Re-enabling this origin requires declaring
// the mediated capability and restoring the removed leaf behavior specs.
describe("WebFetchTool fail-closed origin", () => {
  it.effect("is withheld from model definitions without a Guard-mediated capability", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(registry)).toEqual([])
      expect(requests).toEqual([])
      expect(assertions).toEqual([])
    }),
  )

  it.effect("cannot settle, validate, or classify as anything but unknown, with zero network and zero permission", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const call_ = call({ url: "https://1.1.1.1/blocked", format: "text" })

      expect(yield* executeTool(registry, call_)).toEqual({ type: "error", value: "Unknown tool: webfetch" })

      const materialized = yield* registry.materialize()
      expect(yield* materialized.validate(call_.call)).toEqual("Unknown tool: webfetch")
      expect(materialized.classify(call_.call)).toEqual({ id: "webfetch", effectClass: "unknown" })

      expect(requests).toEqual([])
      expect(assertions).toEqual([])
    }),
  )
})
