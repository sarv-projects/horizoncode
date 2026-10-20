import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { WebSearchTool } from "../../src/tool/websearch"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  createProcessSearchCooldownStore,
  moveSearchRoute,
  inspectSearchProviders,
  normalizeSearchCascadeSettings,
  runSearchCascade,
  setSearchRouteEnabled,
  type SearchRoute,
  type SearchRouteResult,
} from "../../src/tool/websearch-broker"
import { createBYOSearchRoutes, createSearchRoutes, parseSearchProviderResponse } from "../../src/tool/websearch-adapters"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"

describe("websearch provider", () => {
  test("remains absent from model tools until the Rust Guard gate is accepted", () => {
    expect(webSearchEnabled(ProviderV2.ID.opencode)).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { enabled: ["exa_keyless"], order: ["exa_keyless"] })).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { enabled: ["exa_keyless"], order: ["exa_keyless"] }, true)).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { enabled: [], order: [] }, true)).toBe(false)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("brave")).toBe("Brave Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel("exa_keyless")).toBe("Built-in Web Search · Exa")
  })
})

const webSearchRuntime = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))
const webSearchContext = {
  sessionID: SessionID.make("ses_websearch_test"),
  messageID: MessageID.make("msg_websearch_test"),
  callID: "call-websearch-test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const executeWebSearch = Effect.fn("WebSearchToolTest.execute")(function* (args: Tool.InferParameters<typeof WebSearchTool>) {
  const info = yield* WebSearchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, webSearchContext)
})

webSearchRuntime.instance("direct tool dispatch remains unavailable and produces no outbound request", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let requests = 0
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          requests++
          return new Response("unexpected search request")
        },
      })
      return { server, requests: () => requests }
    }),
    ({ requests }) =>
      Effect.gen(function* () {
        const result = yield* executeWebSearch({ query: "repo" })
        expect(result.metadata.status).toBe("unavailable")
        expect(result.metadata.reason).toContain("Rust Guard")
        expect(result.output).toContain("unavailable")
        expect(requests()).toBe(0)
      }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  ),
)

const routeResult = (provider: SearchRouteResult["provider"]): SearchRouteResult => ({
  results: [{ title: `${provider} result`, url: `https://${provider}.example/result`, snippet: "bounded result" }],
  provider,
  routeClass: "DIRECT_SEARCH",
  costClass: provider === "exa_keyless" ? "FREE" : "UNKNOWN",
  authSource: provider === "exa_keyless" ? "none" : "saved_credential",
  freshness: "current",
  retrievedAt: "2026-10-18T00:00:00.000Z",
})

const testRoute = (id: SearchRoute["id"], search: SearchRoute["search"], configured = true): SearchRoute => ({
  id,
  label: id,
  routeClass: "DIRECT_SEARCH",
  costClass: id === "exa_keyless" ? "FREE" : "UNKNOWN",
  authSource: id === "exa_keyless" ? "none" : "saved_credential",
  configured,
  search,
})

describe("websearch ordered cascade", () => {
  test("defaults to the built-in route, enables BYO routes only by explicit setting, and supports route ordering", () => {
    expect(normalizeSearchCascadeSettings()).toEqual({
      enabled: ["exa_keyless", "youcom_free", "firecrawl_keyless"],
      order: ["exa_keyless", "youcom_free", "firecrawl_keyless"],
    })
    const enabled = setSearchRouteEnabled(undefined, "brave", true)
    expect(enabled.enabled).toEqual(["exa_keyless", "brave"])
    expect(moveSearchRoute(enabled, "brave", -1).order).toEqual(["brave", "exa_keyless"])
    expect(setSearchRouteEnabled(enabled, "brave", false).enabled).toEqual(["exa_keyless"])
  })

  test("persists only supported route ids and keeps credentials out of config", () => {
    const decode = Schema.decodeUnknownSync(ConfigV1.Info)
    const value = decode({ websearch: { enabled: ["exa_keyless", "brave"], order: ["brave", "exa_keyless", "exa"] } })
    expect(value.websearch).toEqual({ enabled: ["exa_keyless", "brave"], order: ["brave", "exa_keyless", "exa"] })
    expect(() => decode({ websearch: { enabled: ["exa_keyless", "google"] } })).toThrow()
    expect(() => decode({ websearch: { enabled: ["exa_keyless", "youcom_free", "firecrawl_keyless", "brave", "exa", "brave"] } })).toThrow()
  })

  test("provider inspection reports effective auth, cost, status, and rate-limit provenance", () => {
    const routes = [
      testRoute("exa_keyless", async () => routeResult("exa_keyless")),
      {
        ...testRoute("brave", async () => routeResult("brave")),
        authSource: "secret_broker" as const,
        configured: true,
      },
    ]
    const providers = inspectSearchProviders({
      settings: { enabled: ["exa_keyless", "brave"], order: ["exa_keyless", "brave"] },
      routes,
      attempts: [
        { provider: "brave", attempt: 1, status: "rate_limited", reason: "provider limit", statusCode: 429, retryAfterMs: 4_000 },
      ],
    })

    expect(providers).toMatchObject([
      { provider: "exa_keyless", enabled: true, configured: true, status: "ready", costClass: "FREE", authSource: "none" },
      {
        provider: "brave",
        enabled: true,
        configured: true,
        status: "rate_limited",
        costClass: "UNKNOWN",
        authSource: "secret_broker",
        lastError: "provider limit",
        lastStatusCode: 429,
        retryAfterMs: 4_000,
      },
      { provider: "exa", enabled: false, configured: false, status: "disabled", costClass: "UNKNOWN", authSource: "unknown" },
    ])
  })

  test("429 falls through, records a shared workspace cooldown, and skips the cooled route next time", async () => {
    let now = 10_000
    const cooldowns = createProcessSearchCooldownStore(() => now)
    const calls: string[] = []
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        throw Object.assign(new Error("rate limited"), { status: 429 })
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        return routeResult("brave")
      }),
    ]
    const first = await runSearchCascade({
      query: "repo",
      enabled: ["exa_keyless", "brave"],
      order: ["exa_keyless", "brave"],
      routes,
      cooldownStore: cooldowns,
      workspace: "workspace-a",
      now: () => now,
    })
    expect(first.result.provider).toBe("brave")
    expect(await cooldowns.get({ workspace: "workspace-a", provider: "exa_keyless" })).toBe(70_000)

    calls.length = 0
    const second = await runSearchCascade({
      query: "repo",
      enabled: ["exa_keyless", "brave"],
      order: ["exa_keyless", "brave"],
      routes,
      cooldownStore: cooldowns,
      workspace: "workspace-a",
      now: () => now,
    })
    expect(second.result.provider).toBe("brave")
    expect(calls).toEqual(["brave"])
    now = 70_000
    expect(await cooldowns.get({ workspace: "workspace-a", provider: "exa_keyless" })).toBeUndefined()
  })

  test("BYO adapters require both explicit enablement and a SecretBroker reference", async () => {
    const secretRef = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref")
    let request: unknown
    const transport = {
      async dispatch(input: unknown) {
        request = input
        return { status: 200, headers: {}, body: { web: { results: [{ title: "Docs", url: "https://example.com", description: "Snippet" }] } } }
      },
    }
    expect(createBYOSearchRoutes({ enabled: ["brave"], credentialRefs: {} })).toEqual([])
    expect(createBYOSearchRoutes({ enabled: [], credentialRefs: { brave: secretRef }, transport })).toEqual([])
    const [route] = createBYOSearchRoutes({ enabled: ["brave"], credentialRefs: { brave: secretRef }, transport })
    expect(route).toMatchObject({ id: "brave", configured: true, authSource: "secret_broker", costClass: "UNKNOWN" })
    await expect(route!.search({ query: "docs", numResults: 4 })).resolves.toMatchObject({
      provider: "brave",
      results: [{ title: "Docs", url: "https://example.com/", snippet: "Snippet" }],
    })
    expect(request).toMatchObject({ provider: "brave", destination: "https://api.search.brave.com/res/v1/web/search", secretRef })
  })

  test("route composition never substitutes a BYO provider for the default route", () => {
    const builtin = { configured: true, search: async () => routeResult("exa_keyless") }
    expect(createSearchRoutes({ enabled: ["exa_keyless"], credentialRefs: {}, builtin }).map((route) => route.id)).toEqual(["exa_keyless"])
    expect(createSearchRoutes({ enabled: ["exa_keyless"], credentialRefs: {} })).toEqual([])
    expect(createSearchRoutes({ enabled: ["brave"], credentialRefs: {}, builtin }).map((route) => route.id)).toEqual([])
  })

  test("provider parsers reject non-web URLs and enforce result and text bounds", () => {
    expect(parseSearchProviderResponse("exa", {
      results: [
        { title: "x".repeat(300), url: "javascript:alert(1)", text: "unsafe" },
        { title: "valid", url: "https://example.com", text: "y".repeat(2_000) },
      ],
    }, 1)).toEqual([{ title: "valid", url: "https://example.com/", snippet: "y".repeat(1_200) }])
  })

  test("uses only configured enabled routes in settings order and skips disabled routes", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        throw Object.assign(new Error("offline"), { status: 503 })
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        return routeResult("brave")
      }),
      testRoute("exa", async () => {
        calls.push("exa")
        return routeResult("exa")
      }, false),
    ]

    const result = await runSearchCascade({ query: "repo", enabled: ["brave", "exa_keyless", "exa"], order: ["exa_keyless", "exa", "brave"], routes })

    expect(calls).toEqual(["exa_keyless", "brave"])
    expect(result.result.provider).toBe("brave")
    expect(result.result).toMatchObject({
      routeClass: "DIRECT_SEARCH",
      costClass: "UNKNOWN",
      authSource: "saved_credential",
      freshness: "current",
    })
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
      ["exa_keyless", "failed"],
      ["brave", "succeeded"],
    ])
  })

  test("a user-selected session route moves first but never removes enabled fallback routes", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        return routeResult("exa_keyless")
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        throw Object.assign(new Error("offline"), { status: 503 })
      }),
    ]
    const result = await runSearchCascade({
      query: "repo",
      enabled: ["exa_keyless", "brave"],
      order: ["exa_keyless", "brave"],
      sessionProvider: "brave",
      routes,
    })
    expect(calls).toEqual(["brave", "exa_keyless"])
    expect(result.result.provider).toBe("exa_keyless")
  })

  test("tries the whole cascade before one bounded retry pass and preserves per-route reasons", async () => {
    const calls: string[] = []
    let braveCalls = 0
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        throw new Error("temporary timeout")
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        braveCalls++
        if (braveCalls === 1) throw Object.assign(new Error("temporarily unavailable"), { status: 503 })
        return routeResult("brave")
      }),
    ]

    const result = await runSearchCascade({ query: "repo", enabled: ["exa_keyless", "brave"], order: ["exa_keyless", "brave"], routes })

    expect(calls).toEqual(["exa_keyless", "brave", "exa_keyless", "brave"])
    expect(result.result.provider).toBe("brave")
    expect(result.attempts).toMatchObject([
      { provider: "exa_keyless", attempt: 1, status: "failed", reason: "temporary timeout" },
      { provider: "brave", attempt: 1, status: "failed", statusCode: 503 },
      { provider: "exa_keyless", attempt: 2, status: "failed", reason: "temporary timeout" },
      { provider: "brave", attempt: 2, status: "succeeded" },
    ])
  })

  test("returns bounded exhaustion details and never calls disabled routes", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 2 * 60 * 60 * 1_000 })
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        throw Object.assign(new Error("bad credentials"), { status: 401 })
      }),
      testRoute("exa", async () => {
        calls.push("exa")
        return routeResult("exa")
      }, false),
    ]

    await expect(
      runSearchCascade({ query: "repo", enabled: ["exa_keyless", "brave", "exa"], order: ["exa_keyless", "brave", "exa"], routes }),
    ).rejects.toMatchObject({
      code: "SEARCH_CASCADE_EXHAUSTED",
      attempts: [
        { provider: "exa_keyless", status: "rate_limited", retryAfterMs: 60 * 60 * 1_000 },
        { provider: "brave", status: "failed", statusCode: 401 },
      ],
    })
    expect(calls).toEqual(["exa_keyless", "brave"])
  })

  test("records auth 4xx per route and falls through only to explicitly enabled routes", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("brave", async () => {
        calls.push("brave")
        throw Object.assign(new Error("invalid credential"), { status: 401 })
      }),
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        return routeResult("exa_keyless")
      }),
    ]
    const result = await runSearchCascade({
      query: "repo",
      enabled: ["brave", "exa_keyless"],
      order: ["brave", "exa_keyless"],
      routes,
    })
    expect(result.result.provider).toBe("exa_keyless")
    expect(result.attempts).toMatchObject([
      { provider: "brave", status: "failed", statusCode: 401, reason: "invalid credential" },
      { provider: "exa_keyless", status: "succeeded" },
    ])
    expect(calls).toEqual(["brave", "exa_keyless"])
  })

  test("stops on non-auth client errors without trying later routes", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("brave", async () => {
        calls.push("brave")
        throw Object.assign(new Error("invalid query"), { status: 400 })
      }),
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        return routeResult("exa_keyless")
      }),
    ]
    await expect(
      runSearchCascade({ query: "repo", enabled: ["brave", "exa_keyless"], order: ["brave", "exa_keyless"], routes }),
    ).rejects.toMatchObject({
      code: "SEARCH_CASCADE_EXHAUSTED",
      attempts: [{ provider: "brave", status: "failed", statusCode: 400, reason: "invalid query" }],
    })
    expect(calls).toEqual(["brave"])
  })

  test("redacts credentials from route failure provenance", async () => {
    await expect(
      runSearchCascade({
        query: "repo",
        enabled: ["brave"],
        routes: [
          testRoute("brave", async () => {
            throw new Error("x-subscription-token=secret123 Authorization: Bearer abc.def")
          }),
        ],
      }),
    ).rejects.toMatchObject({
      attempts: [
        { reason: "x-subscription-token=[redacted] Authorization: [redacted]" },
        { reason: "x-subscription-token=[redacted] Authorization: [redacted]" },
      ],
    })
  })

  test("bounds search input and artifacts and rejects malformed result items", async () => {
    let receivedQuery = ""
    let receivedLimit = 0
    const result = await runSearchCascade({
      query: `  ${"q".repeat(2_100)}  `,
      numResults: 99,
      enabled: ["exa_keyless"],
      order: ["exa_keyless"],
      routes: [
        testRoute("exa_keyless", async (input) => {
          receivedQuery = input.query
          receivedLimit = input.numResults
          return {
            ...routeResult("exa_keyless"),
            results: [
              { title: "t".repeat(300), url: "https://example.test/ok", snippet: "s".repeat(1_300) },
              { title: "bad scheme", url: "file:///tmp/no" },
              { title: "too long URL", url: `https://example.test/${"x".repeat(2_100)}` },
              { title: 10 as unknown as string, url: "https://example.test/malformed" },
            ],
          }
        }),
      ],
    })

    expect(receivedQuery).toHaveLength(2_000)
    expect(receivedLimit).toBe(10)
    expect(result.result.results).toEqual([
      { title: "t".repeat(240), url: "https://example.test/ok", snippet: "s".repeat(1_200) },
    ])
  })

  test("does not call any route for a whitespace-only query", async () => {
    let calls = 0
    await expect(
      runSearchCascade({
        query: "   ",
        enabled: ["exa_keyless"],
        routes: [testRoute("exa_keyless", async () => {
          calls++
          return routeResult("exa_keyless")
        })],
      }),
    ).rejects.toThrow("Search query is required")
    expect(calls).toBe(0)
  })

  test("bounds each provider request, aborts its signal, and falls through", async () => {
    let slowSignal: AbortSignal | undefined
    const result = await runSearchCascade({
      query: "repo",
      enabled: ["exa_keyless", "brave"],
      order: ["exa_keyless", "brave"],
      routeTimeoutMs: 5,
      routes: [
        testRoute("exa_keyless", async (input) => {
          slowSignal = input.signal
          return await new Promise<SearchRouteResult>(() => {})
        }),
        testRoute("brave", async () => routeResult("brave")),
      ],
    })
    expect(slowSignal?.aborted).toBe(true)
    expect(result.result.provider).toBe("brave")
    expect(result.attempts).toMatchObject([
      { provider: "exa_keyless", status: "failed", statusCode: 408 },
      { provider: "brave", status: "succeeded" },
    ])
  })

  test("does not retry or fail over after cancellation", async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        controller.abort(new Error("cancelled by user"))
        throw new DOMException("Aborted", "AbortError")
      }),
      testRoute("brave", async () => {
        calls.push("brave")
        return routeResult("brave")
      }),
    ]

    await expect(
      runSearchCascade({
        query: "repo",
        enabled: ["exa_keyless", "brave"],
        order: ["exa_keyless", "brave"],
        routes,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled by user")
    expect(calls).toEqual(["exa_keyless"])
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
