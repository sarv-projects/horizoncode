import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { WebSearchTool } from "../../src/tool/websearch"
import { Config } from "../../src/config/config"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  createProcessSearchCooldownStore,
  createProcessSearchAttemptStore,
  moveSearchRoute,
  inspectSearchProviders,
  normalizeSearchCascadeSettings,
  setSearchRouteEnabled,
  type SearchRoute,
  type SearchRouteResult,
} from "../../src/tool/websearch-broker"
import * as WebSearchBroker from "../../src/tool/websearch-broker"
import { runSearchCascade } from "./websearch-cascade.fixture"
import { createSearchInspectionRoutes, createSearchRoutePlan, parseSearchProviderResponse } from "../../src/tool/websearch-adapters"
import { assertBoundedSearchBody, decodeSuccessfulCascadeResults, parseCascadeResponse, prepareSearchEffectArguments, SearchRuntimeError, validateCascadeResponseRoutes } from "../../src/tool/websearch-runtime"
import * as WebSearchRuntime from "../../src/tool/websearch-runtime"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { WebSearchV1 } from "@opencode-ai/schema"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"

const TEST_ROUTE_PLAN_DIGEST = `blake3:${"a".repeat(64)}`

describe("websearch provider", () => {
  test("production broker exposes no raw route-callback executor", async () => {
    let routeCallbackEffects = 0
    const executor = (WebSearchBroker as unknown as Record<string, unknown>).runSearchCascade
    if (typeof executor === "function") {
      await executor({
        query: "must not dispatch",
        enabled: ["exa_keyless"],
        routes: [{
          id: "exa_keyless",
          label: "fixture",
          routeClass: "DIRECT_SEARCH",
          costClass: "FREE",
          authSource: "none",
          configured: true,
          search: async () => {
            routeCallbackEffects++
            return routeResult("exa_keyless")
          },
        }],
      })
    }
    expect(executor).toBeUndefined()
    expect(routeCallbackEffects).toBe(0)
  })

  test("remains absent from model tools until the Rust Guard gate is accepted", () => {
    // The production broker has no callback executor; only the Rust-backed
    // WebSearchRuntime can dispatch a provider effect.
    expect("runSearchCascade" in WebSearchBroker).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.opencode)).toBe(false)
    const consented = { querySharingConsent: "anonymous_free_v1" as const, enabled: ["exa_keyless" as const], order: ["exa_keyless" as const] }
    expect(webSearchEnabled(ProviderV2.ID.openai, consented)).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, consented, true)).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { enabled: [], order: [] }, true)).toBe(false)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("brave")).toBe("Brave Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel("exa_keyless")).toBe("Built-in Web Search · Exa")
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Search")
    expect(webSearchProviderLabel("tavily")).toBe("Tavily Search")
  })

  test("bounds provenance attempts and requires a HostKernel route-plan digest after dispatch", () => {
    const attempt = {
      providerId: "exa_keyless",
      routeId: "web.search.exa_keyless",
      routeIndex: 0,
      attempt: 1,
      status: "failed",
      receiptRef: "route-receipt-1",
    } as const
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "not_dispatched",
      reason: "denied before dispatch",
      routeAttempts: [],
    })).toMatchObject({ status: "not_dispatched" })
    expect(() => Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "unknown",
      reason: "outcome uncertain",
      routeAttempts: [],
    })).toThrow()
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "cancelled",
      reason: "cancelled after route admission",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [],
    })).toMatchObject({ status: "cancelled" })
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "failed",
      reason: "provider returned terminal HTTP 404",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, status: "failed", statusCode: 404 }],
    })).toMatchObject({ status: "failed" })
    expect(() => Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "cancelled",
      reason: "cancelled after route admission",
      routeAttempts: [],
    })).toThrow()
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "exhausted",
      reason: "routes exhausted",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: Array.from({ length: 20 }, () => attempt),
    })).toMatchObject({ status: "exhausted" })
    expect(() => Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "exhausted",
      reason: "routes exhausted",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: Array.from({ length: 21 }, () => attempt),
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "exhausted",
      reason: "routes exhausted",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, receiptRef: undefined }],
    })).toThrow("durable route receipt")
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "unknown",
      reason: "outcome uncertain",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, status: "unknown", receiptRef: undefined }],
    })).toMatchObject({ status: "unknown" })
    expect(() => Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "unknown",
      reason: "outcome uncertain",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, status: "unknown", receiptRef: "forged-settled-ref" }],
    })).toThrow("cannot claim a settled route receipt")
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "exhausted",
      reason: "routes exhausted",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, status: "not_dispatched", notDispatchedFailure: "transport_failure" }],
    })).toMatchObject({ status: "exhausted" })
    expect(Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
      schemaVersion: 1,
      requestId: "call-1",
      status: "exhausted",
      reason: "routes exhausted",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeAttempts: [{ ...attempt, status: "retryable_failure", statusCode: 503 }],
    })).toMatchObject({ routeAttempts: [{ status: "retryable_failure", statusCode: 503 }] })
  })
})

const webSearchRuntime = testEffect(Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])),
  Layer.mock(Config.Service, { get: () => Effect.succeed({ websearch: undefined } as any) }),
  Layer.mock(WebSearchRuntime.Service, {
    search: () => Effect.die(new Error("the disabled search gate must not dispatch")),
  }),
))
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

// Regression: `InstanceState.context` is per-directory state and may only be
// resolved inside the deferred execute path. Resolving it in the EAGER
// `Tool.define` init kills ToolRegistry layer construction whenever the layer
// is built without an InstanceRef — every `AppRuntime.runPromise` and the
// whole `test/config/config.test.ts` suite died with
// `InstanceRef not provided`.
webSearchRuntime.effect("Tool.define init constructs ToolRegistry entries without an InstanceRef", () =>
  Effect.gen(function* () {
    // This is exactly the ToolRegistry construction path: no InstanceRef is
    // bound in this (non-instance) test runtime.
    const info = yield* WebSearchTool
    const def = yield* Tool.init(info)
    expect(def.id).toBe("websearch")
    expect(typeof def.execute).toBe("function")
  }),
)

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
        expect(result.metadata.reason).toContain("Guard/SecretBroker")
        expect(result.output).toContain("Guard/SecretBroker release gate")
        expect(requests()).toBe(0)
      }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  ),
)

const routeResult = (provider: SearchRouteResult["provider"]): SearchRouteResult => ({
  results: [{ title: `${provider} result`, url: `https://${provider}.example/result`, snippet: "bounded result" }],
  provider,
  routeClass: "DIRECT_SEARCH",
  costClass: provider.endsWith("_keyless") || provider === "youcom_free" ? "FREE" : "UNKNOWN",
  authSource: provider.endsWith("_keyless") || provider === "youcom_free" ? "none" : "saved_credential",
  freshness: "current",
  retrievedAt: "2026-10-18T00:00:00.000Z",
})

const hostAttempt = (provider: SearchRoute["id"], routeIndex: number, status: "SUCCEEDED" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "EMPTY" | "NOT_DISPATCHED" | "UNKNOWN", attempt = 1): any => ({
  provider,
  routeId: `web.search.${provider}`,
  routeIndex,
  attempt,
  status,
  notDispatchedFailure: status === "NOT_DISPATCHED" ? "transport_failure" as const : null,
  httpStatus: null,
  retryAfterMs: null,
  resultCount: null,
  observedAt: "2026-10-20T00:00:00.000Z",
  ...(status === "UNKNOWN" ? {} : { receiptRef: `route-receipt-${provider}-${attempt}` }),
})

type FixtureSearchRoute = SearchRoute & {
  search(input: { query: string; numResults: number; signal?: AbortSignal }): Promise<SearchRouteResult>
}

const testRoute = (id: SearchRoute["id"], search: FixtureSearchRoute["search"], configured = true): FixtureSearchRoute => ({
  id,
  label: id,
  routeClass: "DIRECT_SEARCH",
  costClass: id.endsWith("_keyless") || id === "youcom_free" ? "FREE" : "UNKNOWN",
  authSource: id.endsWith("_keyless") || id === "youcom_free" ? "none" : "saved_credential",
  configured,
  search,
})

describe("websearch ordered cascade", () => {
  test("projects the exact opaque BYO references into the admitted HostKernel request", () => {
    const secretRef = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref")
    expect(WebSearchRuntime.webSearchCascadeRequestV1({
      sessionID: "ses_websearch_test",
      effectID: "effect-search-1",
      capabilityLeaseDigest: TEST_ROUTE_PLAN_DIGEST,
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "brave", attemptCount: 2 }],
      credentialRefsByRoute: [{ routeKey: "brave", secretRef }],
    })).toEqual({
      sessionID: "ses_websearch_test",
      effectID: "effect-search-1",
      capabilityLeaseDigest: TEST_ROUTE_PLAN_DIGEST,
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "brave", attemptCount: 2 }],
      credentialRefsByRoute: [{ routeKey: "brave", secretRef }],
    })
  })

  test("rejects credential references, routes and attempt counts outside the admitted plan", () => {
    const secretRef = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref")
    type Request = Parameters<typeof WebSearchRuntime.webSearchCascadeRequestV1>[0]
    const base: Request = {
      sessionID: "ses_websearch_test",
      effectID: "effect-search-1",
      capabilityLeaseDigest: TEST_ROUTE_PLAN_DIGEST,
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "brave", attemptCount: 2 }],
    }
    // Runtime-negative cases deliberately pass untrusted shapes.
    const invoke = (input: unknown) => WebSearchRuntime.webSearchCascadeRequestV1(input as Request)

    // A reference for a route the admitted plan never included cannot ride along.
    expect(() => invoke({
      ...base,
      credentialRefsByRoute: [{ routeKey: "exa", secretRef }],
    })).toThrow("admitted route")
    // The trusted projection stays closed: unsupported route IDs, duplicates,
    // a reduced per-route attempt count and a malformed lease digest all fail.
    expect(() => invoke({
      ...base,
      routes: [{ routeKey: "google", attemptCount: 2 }],
    })).toThrow("unsupported route")
    expect(() => invoke({
      ...base,
      routes: [...base.routes, { routeKey: "brave", attemptCount: 2 }],
    })).toThrow("duplicate route")
    expect(() => invoke({
      ...base,
      routes: [{ routeKey: "brave", attemptCount: 1 }],
    })).toThrow("attempt count")
    expect(() => invoke({
      ...base,
      capabilityLeaseDigest: "not-a-digest",
    })).toThrow("capability lease digest")
    // Unknown-cost credentialed routes keep their opaque reference; the
    // projection never drops it to make a route look free or anonymous.
    expect(WebSearchRuntime.webSearchCascadeRequestV1(base).credentialRefsByRoute).toBeUndefined()
    expect(WebSearchRuntime.webSearchCascadeRequestV1({
      ...base,
      credentialRefsByRoute: [{ routeKey: "brave", secretRef }],
    }).credentialRefsByRoute).toEqual([{ routeKey: "brave", secretRef }])
  })

  test("bounds nested provider wrappers before normalizing result rows", () => {
    let payload: unknown = { results: [{ title: "result", url: "https://example.test" }] }
    for (let index = 0; index < 6; index++) payload = { result: { structuredContent: payload } }
    expect(parseSearchProviderResponse("exa_keyless", payload, 8)).toEqual([])
  })

  test("requires first-use query-sharing consent for defaults and separate per-route BYO consent", () => {
    expect(normalizeSearchCascadeSettings()).toEqual({
      querySharingConsent: undefined,
      byoConsents: [],
      enabled: [],
      order: ["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless", "brave", "exa", "youcom", "tavily", "firecrawl", "parallel"],
    })
    const defaults = normalizeSearchCascadeSettings({ querySharingConsent: "anonymous_free_v1" })
    expect(defaults.enabled).toEqual(["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless"])
    const consented = { ...defaults, byoConsents: [{ route: "brave" as const, consent: "secret_broker_unknown_cost_v1" as const }] }
    const enabled = setSearchRouteEnabled(consented, "brave", true)
    expect(enabled.enabled).toEqual([...defaults.enabled, "brave"])
    expect(moveSearchRoute(enabled, "brave", -1).order).toEqual(["exa_keyless", "youcom_free", "firecrawl_keyless", "brave", "parallel_keyless", "exa", "youcom", "tavily", "firecrawl", "parallel"])
    const disabled = setSearchRouteEnabled(enabled, "brave", false)
    expect(disabled.enabled).toEqual(defaults.enabled)
    expect(disabled.byoConsents).toEqual([{ route: "brave", consent: "secret_broker_unknown_cost_v1" }])
  })

  test("executes the built-in default chain in its approved order and attributes the winning route", async () => {
    const defaults = normalizeSearchCascadeSettings({ querySharingConsent: "anonymous_free_v1" })
    const calls: string[] = []
    const routes = defaults.enabled.map((id, index) => testRoute(id, async () => {
      calls.push(id)
      if (index < defaults.enabled.length - 1) throw Object.assign(new Error("temporary route failure"), { status: 503 })
      return routeResult(id)
    }))

    const outcome = await runSearchCascade({
      query: "HorizonCode docs",
      enabled: defaults.enabled,
      order: defaults.order,
      routes,
    })

    expect(calls).toEqual(["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless"])
    expect(outcome.result).toMatchObject({
      provider: "parallel_keyless",
      costClass: "FREE",
      authSource: "none",
      routeClass: "DIRECT_SEARCH",
    })
  })

  test("persists only supported route ids and keeps credentials out of config", () => {
    const decode = Schema.decodeUnknownSync(ConfigV1.Info)
    const value = decode({ websearch: { enabled: ["exa_keyless", "brave"], order: ["brave", "exa_keyless", "exa"] } })
    expect(value.websearch).toEqual({ enabled: ["exa_keyless", "brave"], order: ["brave", "exa_keyless", "exa"] })
    expect(() => decode({ websearch: { enabled: ["exa_keyless", "google"] } })).toThrow()
    expect(() => decode({ websearch: { enabled: ["exa_keyless", "youcom_free", "tavily_keyless", "firecrawl_keyless", "parallel_keyless", "brave", "exa", "youcom", "tavily", "firecrawl", "parallel", "brave"] } })).toThrow()
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
      settings: {
        querySharingConsent: "anonymous_free_v1",
        byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
        enabled: ["exa_keyless", "brave"],
        order: ["exa_keyless", "brave"],
      },
      routes,
      attempts: [
        { provider: "brave", attempt: 1, status: "succeeded", observedAt: "2026-10-20T00:00:00.000Z" },
      ],
      failures: [
        { provider: "brave", attempt: 1, status: "rate_limited", reason: "provider rate limit", statusCode: 429, retryAfterMs: 4_000 },
      ],
      cooldownUntil: { brave: 50_000 },
      now: 10_000,
      runtimeReady: true,
    })

    expect(providers.find((item) => item.provider === "exa_keyless")).toMatchObject({
      enabled: true, configured: true, status: "ready", costClass: "FREE", authSource: "none",
    })
    expect(providers.find((item) => item.provider === "brave")).toMatchObject({
      provider: "brave", enabled: true, configured: true, status: "rate_limited", available: false,
      providerHealth: "not_probed", lastAttemptStatus: "succeeded", costClass: "UNKNOWN",
      authSource: "secret_broker", lastError: "provider rate limit", lastStatusCode: 429, retryAfterMs: 40_000,
    })
    expect(providers.find((item) => item.provider === "exa")).toMatchObject({
      provider: "exa", enabled: false, configured: false, status: "disabled", costClass: "UNKNOWN",
      authSource: "secret_broker",
    })
  })

  test("inspection reports disabled routes as configured when their local SecretBroker reference exists", () => {
    const secretRef = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref")
    const supported = [...ConfigV1.WEB_SEARCH_ROUTE_IDS]
    const routes = createSearchInspectionRoutes({
      supportedProviders: supported,
      credentialRefs: { brave: secretRef },
    })
    const statuses = inspectSearchProviders({
      settings: { querySharingConsent: "anonymous_free_v1", enabled: ["exa_keyless"], order: ["exa_keyless"] },
      routes,
      runtimeReady: true,
    })

    expect(statuses.find((route) => route.provider === "brave")).toMatchObject({
      enabled: false,
      configured: true,
      status: "disabled",
      authSource: "secret_broker",
      costClass: "UNKNOWN",
    })
    expect(statuses.find((route) => route.provider === "exa")).toMatchObject({
      enabled: false,
      configured: false,
      status: "disabled",
    })
    expect(JSON.stringify(statuses)).not.toContain(secretRef)
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

  test("inspection keeps last attempt separate from historical failure and never infers provider health", () => {
    const provider = inspectSearchProviders({
      settings: {
        byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
        enabled: ["brave"],
        order: ["brave"],
      },
      routes: [testRoute("brave", async () => routeResult("brave"))],
      attempts: [{ provider: "brave", attempt: 2, status: "succeeded", observedAt: "2026-10-20T00:00:00.000Z" }],
      failures: [{ provider: "brave", attempt: 1, status: "failed", reason: "provider authentication rejected", statusCode: 401 }],
      runtimeReady: false,
    }).find((item) => item.provider === "brave")
    expect(provider).toMatchObject({
      status: "unavailable",
      available: false,
      providerHealth: "not_probed",
      lastAttemptStatus: "succeeded",
      lastError: "provider authentication rejected",
      lastStatusCode: 401,
    })
  })

  test("attempt state retains sanitized last failure after a later success", async () => {
    const attemptStore = createProcessSearchAttemptStore()
    await runSearchCascade({
      query: "repo",
      enabled: ["brave", "exa_keyless"],
      order: ["brave", "exa_keyless"],
      workspace: "inspection-workspace",
      attemptStore,
      routes: [
        testRoute("brave", async () => { throw Object.assign(new Error("private provider response"), { status: 403 }) }),
        testRoute("exa_keyless", async () => routeResult("exa_keyless")),
      ],
    })
    expect(await attemptStore.list({ workspace: "inspection-workspace" })).toMatchObject([
      { provider: "brave", status: "failed", reason: "provider authentication rejected" },
      { provider: "exa_keyless", status: "succeeded" },
    ])
    expect(await attemptStore.listFailures?.({ workspace: "inspection-workspace" })).toMatchObject([
      { provider: "brave", status: "failed", reason: "provider authentication rejected", statusCode: 403 },
    ])
  })

  test("aggregate projection includes only enabled, supported routes and opaque BYO references", () => {
    const secretRef = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref")
    const projected = prepareSearchEffectArguments({
      modelArgs: { query: "  docs  ", numResults: 4, provider: "paid-hidden-provider" },
      settings: {
        querySharingConsent: "anonymous_free_v1",
        byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
        enabled: ["exa_keyless", "brave"],
        order: ["brave", "exa_keyless"],
      },
      supportedProviders: ["exa_keyless", "brave"],
      runtimeReady: { exa_keyless: true, brave: true },
      credentialRefs: { brave: secretRef },
    })
    expect(projected.arguments).toEqual({
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "brave", attemptCount: 2 }, { routeKey: "exa_keyless", attemptCount: 2 }],
      credentialRefsByRoute: [{ routeKey: "brave", secretRef }],
    })
    expect(projected.execution).toBe(projected.arguments)
  })

  test("aggregate projection rejects an empty HostKernel-supported route plan", () => {
    expect(() => prepareSearchEffectArguments({
      modelArgs: { query: "docs", numResults: 4 },
      settings: { enabled: ["exa_keyless"], order: ["exa_keyless"] },
      supportedProviders: [],
    })).toThrow("No explicitly enabled web-search route")
  })

  test("preserves omitted versus empty domain filters and rejects unsafe domain syntax", () => {
    const base = {
      settings: {
        querySharingConsent: "anonymous_free_v1" as const,
        enabled: ["exa_keyless" as const],
        order: ["exa_keyless" as const],
      },
      supportedProviders: ["exa_keyless" as const],
      runtimeReady: { exa_keyless: true },
    }
    const omitted = prepareSearchEffectArguments({ ...base, modelArgs: { query: "docs" } })
    const empty = prepareSearchEffectArguments({ ...base, modelArgs: { query: "docs", domains: [] } })
    const filtered = prepareSearchEffectArguments({
      ...base,
      modelArgs: { query: "docs", domains: ["example.org", "*.docs.example.com"] },
    })
    expect(Object.hasOwn(omitted.arguments, "domains")).toBe(false)
    expect(empty.arguments.domains).toEqual([])
    expect(filtered.arguments.domains).toEqual(["example.org", "*.docs.example.com"])
    expect(() => prepareSearchEffectArguments({
      ...base,
      modelArgs: { query: "docs", domains: ["example.org", "example.org"] },
    })).toThrow("domain filters")
    expect(() => prepareSearchEffectArguments({
      ...base,
      modelArgs: { query: "docs", domains: ["example.org."] },
    })).toThrow("domain filters")
  })

  test("maps an empty domain filter to an authenticated pre-dispatch outcome", () => {
    const response = parseCascadeResponse({
      status: "NOT_DISPATCHED",
      attempts: [],
    })
    expect(validateCascadeResponseRoutes(response, {
      query: "docs",
      limit: 4,
      domains: [],
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).toBe(response)
    expect(() => validateCascadeResponseRoutes({
      ...response,
      attempts: [hostAttempt("exa_keyless", 0, "FAILED")],
    }, {
      query: "docs",
      limit: 4,
      domains: [],
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).toThrow("dispatch evidence")
  })

  test("accepts EMPTY only for a complete successful zero-result route receipt", () => {
    const response = parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "EMPTY"),
        httpStatus: 200,
        resultCount: 0,
      }],
    })
    expect(response.attempts[0]).toMatchObject({ status: "EMPTY", httpStatus: 200, resultCount: 0 })
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "EMPTY"),
        httpStatus: 500,
        resultCount: 0,
      }],
    })).toThrow("empty-result route outcome")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "EMPTY"),
        httpStatus: 200,
        resultCount: 1,
      }],
    })).toThrow("empty-result route outcome")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        httpStatus: 200,
        resultCount: 0,
      }],
    })).toThrow("status does not match")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "SUCCEEDED"),
        httpStatus: 200,
        resultCount: 0,
      }],
    })).toThrow("status does not match")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        httpStatus: 200,
        resultCount: 1,
      }],
    })).toThrow("status does not match")
  })

  test("terminal non-authentication 4xx is FAILED and cannot be mislabeled exhausted or fall through", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "youcom_free" as const, attemptCount: 2 as const },
      ],
    }
    const failed = parseCascadeResponse({
      status: "FAILED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "search-failed-receipt",
      attempts: [{ ...hostAttempt("exa_keyless", 0, "FAILED"), httpStatus: 404 }],
    })
    expect(validateCascadeResponseRoutes(failed, execution)).toBe(failed)
    expect(() => validateCascadeResponseRoutes({ ...failed, status: "EXHAUSTED" }, execution))
      .toThrow("before every approved route was consumed")
    expect(() => validateCascadeResponseRoutes({
      ...failed,
      status: "EXHAUSTED",
      attempts: [failed.attempts[0]!, hostAttempt("youcom_free", 1, "FAILED")],
    }, execution)).toThrow("continued after a terminal non-rate-limit HTTP 4xx")

    const authExhausted = parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "search-auth-exhausted",
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "FAILED"), httpStatus: 401 },
        { ...hostAttempt("youcom_free", 1, "FAILED"), httpStatus: 401 },
      ],
    })
    expect(validateCascadeResponseRoutes(authExhausted, execution)).toBe(authExhausted)
    expect(() => validateCascadeResponseRoutes({ ...authExhausted, status: "FAILED" }, execution))
      .toThrow("settled terminal non-authentication 4xx")

    const retryable408 = parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "search-retryable-408",
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "RETRYABLE_FAILURE"), httpStatus: 408 },
        { ...hostAttempt("exa_keyless", 0, "FAILED", 2), httpStatus: 408 },
        { ...hostAttempt("youcom_free", 1, "FAILED"), httpStatus: 401 },
      ],
    })
    expect(validateCascadeResponseRoutes(retryable408, execution)).toBe(retryable408)
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "search-invalid-408",
      attempts: [{ ...hostAttempt("exa_keyless", 0, "FAILED"), httpStatus: 408 }],
    })).toThrow("retryable HTTP status")
  })

  test("requires durable per-route receipts for known outcomes but not UNKNOWN", () => {
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        receiptRef: undefined,
        httpStatus: 400,
      }],
    })).toThrow("omitted the durable receipt")
    expect(parseCascadeResponse({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "UNKNOWN"),
        httpStatus: 0,
      }],
    }).attempts[0]?.status).toBe("UNKNOWN")
    expect(() => parseCascadeResponse({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "UNKNOWN"),
        receiptRef: "forged-settled-ref",
      }],
    })).toThrow("settled receipt to an unknown route outcome")
  })

  test("rejects empty aggregate and per-route receipt references", () => {
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        httpStatus: 400,
      }],
    })).toThrow("invalid aggregate receipt reference")

    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        receiptRef: "",
        httpStatus: 400,
      }],
    })).toThrow("invalid route receipt reference")
  })

  test("rejects whitespace-only durable receipt references", () => {
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: " \t\n",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        receiptRef: "route-receipt-exa_keyless-1",
        httpStatus: 400,
      }],
    })).toThrow("invalid aggregate receipt reference")

    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        receiptRef: "  ",
        httpStatus: 400,
      }],
    })).toThrow("invalid route receipt reference")
  })

  test("rejects reused per-route receipt references across distinct attempts", () => {
    const response = parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "FAILED"), httpStatus: 401 },
        { ...hostAttempt("youcom_free", 1, "FAILED"), receiptRef: "route-receipt-exa_keyless-1", httpStatus: 401 },
      ],
    })
    expect(() => validateCascadeResponseRoutes(response, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }, { routeKey: "youcom_free", attemptCount: 2 }],
    })).toThrow("reused a web-search route receipt reference")
  })

  test("rejects route receipts with an empty observation timestamp", () => {
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "search-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        observedAt: " \t",
        httpStatus: 400,
      }],
    })).toThrow("invalid route receipt")
  })

  test("rejects an empty or whitespace-only BYO continuation reference", () => {
    const base = {
      status: "WAITING_SECRET",
      cascadeDigest: `blake3:${"a".repeat(64)}`,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      routeIndex: 1,
      nextRoute: { routeKey: "brave", attempt: 1 },
      attempts: [],
    }
    for (const cascadeRef of ["", " \t\n"]) {
      expect(() => parseCascadeResponse({ ...base, cascadeRef })).toThrow("BYO web-search continuation")
    }
    expect(parseCascadeResponse({ ...base, cascadeRef: "search_cascade_abc" })).toMatchObject({
      status: "WAITING_SECRET",
      cascadeRef: "search_cascade_abc",
    })
  })

  test("rejects non-string and over-limit aggregate and route receipt references", () => {
    const routeReceipt = {
      ...hostAttempt("exa_keyless", 0, "FAILED"),
      httpStatus: 400,
    }
    const base = {
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [routeReceipt],
    }
    const oversized = "r".repeat(257)

    for (const receiptRef of [42, oversized]) {
      expect(() => parseCascadeResponse({ ...base, receiptRef })).toThrow("invalid aggregate receipt reference")
      expect(() => parseCascadeResponse({
        ...base,
        receiptRef: "aggregate-receipt",
        attempts: [{ ...routeReceipt, receiptRef }],
      })).toThrow("invalid route receipt reference")
    }
  })

  test("turns a stale approved route-plan digest into UNKNOWN without retry", async () => {
    let dispatches = 0
    const runtime = WebSearchRuntime.make({
      ready: true,
      supportedProviders: ["exa_keyless"],
      runtimeReady: { exa_keyless: true },
      credentialRefs: async () => ({}),
      executeSearchCascade: async () => {
        dispatches++
        return parseCascadeResponse({
          status: "SUCCEEDED",
          selectedProvider: "exa_keyless",
          body: { results: [{ title: "result", url: "https://example.test/" }] },
          attempts: [{ ...hostAttempt("exa_keyless", 0, "SUCCEEDED"), httpStatus: 200, resultCount: 1 }],
          receiptRef: "aggregate-receipt",
          routePlanDigest: `blake3:${"b".repeat(64)}`,
        })
      },
      workspace: () => "/workspace",
    } as any, { get: async () => ({ websearch: undefined }) } as any)

    let failure: unknown
    try {
      await Effect.runPromise(runtime.search({
        execution: { query: "docs", limit: 1, routes: [{ routeKey: "exa_keyless", attemptCount: 2 }] },
        scope: { sessionID: "ses_test", messageID: "msg_test", callID: "call_test", workspace: "/workspace" },
        challenge: { approval: { consent: { routePlanDigest: TEST_ROUTE_PLAN_DIGEST } } } as any,
      }))
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(SearchRuntimeError)
    expect(failure).toMatchObject({ outcome: "UNKNOWN", routePlanDigest: TEST_ROUTE_PLAN_DIGEST })
    expect(dispatches).toBe(1)
  })

  test("keeps anonymous and credentialed routes behind independent runtime acceptance gates", () => {
    const projected = prepareSearchEffectArguments({
      modelArgs: { query: "docs" },
      settings: {
        querySharingConsent: "anonymous_free_v1",
        byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
        enabled: ["exa_keyless", "brave"],
        order: ["brave", "exa_keyless"],
      },
      supportedProviders: ["exa_keyless", "brave"],
      runtimeReady: { exa_keyless: true, brave: false },
      credentialRefs: { brave: Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_ref") },
    })
    expect(projected.arguments.routes).toEqual([{ routeKey: "exa_keyless", attemptCount: 2 }])
    expect(projected.arguments.credentialRefsByRoute).toBeUndefined()
  })

  test("HostKernel search receipts cannot select or report routes outside the approved ordered plan", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless" as const, attemptCount: 2 as const }],
    }
    const succeeded = {
      status: "SUCCEEDED" as const,
      selectedProvider: "exa_keyless" as const,
      body: { results: [] },
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [hostAttempt("exa_keyless", 0, "SUCCEEDED")],
    }
    expect(validateCascadeResponseRoutes(succeeded, execution)).toBe(succeeded)
    expect(() => validateCascadeResponseRoutes({
      ...succeeded,
      selectedProvider: "brave" as const,
      attempts: [hostAttempt("brave", 0, "SUCCEEDED")],
    }, execution)).toThrow("outside the approved route order")
  })

  test("HostKernel search receipts cannot claim an unapproved retry or route order", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "youcom_free" as const, attemptCount: 2 as const },
      ],
    }
    const base = { status: "EXHAUSTED" as const, routePlanDigest: TEST_ROUTE_PLAN_DIGEST, attempts: [] as const }
    expect(() => validateCascadeResponseRoutes({
      ...base,
      attempts: [hostAttempt("exa_keyless", 0, "FAILED", 2)],
    }, execution)).toThrow("without its first attempt")
    expect(() => validateCascadeResponseRoutes({
      ...base,
      attempts: [
        hostAttempt("youcom_free", 1, "FAILED"),
        hostAttempt("exa_keyless", 0, "FAILED"),
      ],
    }, execution)).toThrow("outside the approved route order")
  })

  // DEC-V1-20/26: 429 is failover-only. HostKernel receipt evidence must show
  // exactly HTTP 429, keep a bounded Retry-After, advance to the next approved
  // route, and never claim a same-route retry after a rate limit.
  test("a rate-limited route receipt is 429-only failover and is never retried on that route", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "brave" as const, attemptCount: 2 as const },
      ],
    }
    const base = {
      status: "EXHAUSTED" as const,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "aggregate-receipt-rate-limit",
      attempts: [] as const,
    }
    const rateLimitedThenNext = {
      ...base,
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "RATE_LIMITED"), httpStatus: 429, retryAfterMs: 5_000 },
        hostAttempt("brave", 1, "FAILED"),
      ],
    }
    expect(validateCascadeResponseRoutes(rateLimitedThenNext, execution)).toBe(rateLimitedThenNext)
    expect(parseCascadeResponse(rateLimitedThenNext)).toMatchObject({
      status: "EXHAUSTED",
      attempts: [
        { provider: "exa_keyless", status: "RATE_LIMITED", httpStatus: 429, retryAfterMs: 5_000 },
        { provider: "brave", status: "FAILED" },
      ],
    })

    // A rate-limit classification must be backed by HTTP 429.
    expect(() => parseCascadeResponse({
      ...base,
      attempts: [{ ...hostAttempt("exa_keyless", 0, "RATE_LIMITED"), httpStatus: 503 }],
    })).toThrow("rate-limit outcome without HTTP 429")

    // 429 never buys a second attempt on the rate-limited route.
    expect(() => validateCascadeResponseRoutes({
      ...base,
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "RATE_LIMITED"), httpStatus: 429, retryAfterMs: 5_000 },
        hostAttempt("exa_keyless", 0, "FAILED", 2),
        hostAttempt("brave", 1, "FAILED"),
      ],
    }, execution)).toThrow("invalid same-route retry sequence")
  })

  // Only durable transient statuses may claim the bounded same-route retry.
  test("a bounded transient retry receipt is accepted and non-transient statuses are not", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "brave" as const, attemptCount: 2 as const },
      ],
    }
    const base = {
      status: "EXHAUSTED" as const,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "aggregate-receipt-transient",
      attempts: [] as const,
    }
    const transientThenAdvance = {
      ...base,
      attempts: [
        { ...hostAttempt("exa_keyless", 0, "RETRYABLE_FAILURE"), httpStatus: 503 },
        hostAttempt("exa_keyless", 0, "FAILED", 2),
        hostAttempt("brave", 1, "FAILED"),
      ],
    }
    expect(validateCascadeResponseRoutes(transientThenAdvance, execution)).toBe(transientThenAdvance)
    expect(parseCascadeResponse(transientThenAdvance)).toMatchObject({
      status: "EXHAUSTED",
      attempts: [
        { provider: "exa_keyless", status: "RETRYABLE_FAILURE", httpStatus: 503 },
        { provider: "exa_keyless", status: "FAILED", attempt: 2 },
        { provider: "brave", status: "FAILED", attempt: 1 },
      ],
    })

    expect(() => parseCascadeResponse({
      ...base,
      attempts: [{ ...hostAttempt("exa_keyless", 0, "RETRYABLE_FAILURE"), httpStatus: 400 }],
    })).toThrow("retryable outcome outside the bounded transient policy")

    expect(() => parseCascadeResponse({
      ...base,
      attempts: [{ ...hostAttempt("exa_keyless", 0, "FAILED"), httpStatus: 408 }],
    })).toThrow("retryable HTTP status without its required same-route retry")
  })

  test("an empty successful route result advances without retrying that route", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "youcom_free" as const, attemptCount: 2 as const },
      ],
    }
    const emptyThenNext = {
      status: "EXHAUSTED" as const,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [
        hostAttempt("exa_keyless", 0, "EMPTY"),
        hostAttempt("youcom_free", 1, "FAILED"),
      ],
    }
    expect(validateCascadeResponseRoutes(emptyThenNext, execution)).toBe(emptyThenNext)
    expect(() => validateCascadeResponseRoutes({
      ...emptyThenNext,
      attempts: [
        hostAttempt("exa_keyless", 0, "EMPTY"),
        hostAttempt("exa_keyless", 0, "FAILED", 2),
      ],
    }, execution)).toThrow("invalid same-route retry")
  })

  test("HostKernel search receipts cannot continue after an unknown route outcome", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "youcom_free" as const, attemptCount: 2 as const },
      ],
    }
    expect(() => validateCascadeResponseRoutes({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [
        hostAttempt("exa_keyless", 0, "UNKNOWN"),
        hostAttempt("youcom_free", 1, "FAILED"),
      ],
    }, execution)).toThrow("after a terminal route outcome")
    expect(() => validateCascadeResponseRoutes({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [
        hostAttempt("exa_keyless", 0, "SUCCEEDED"),
      ],
    }, execution)).toThrow("after a successful route")
    expect(() => validateCascadeResponseRoutes({
      status: "UNKNOWN",
      attempts: [hostAttempt("exa_keyless", 0, "UNKNOWN")],
    }, execution)).toThrow("route-plan digest")
  })

  test("a durable pre-dispatch connection failure retries the same route once, then advances", () => {
    const execution = {
      query: "docs",
      limit: 4,
      routes: [
        { routeKey: "exa_keyless" as const, attemptCount: 2 as const },
        { routeKey: "youcom_free" as const, attemptCount: 2 as const },
      ],
    }
    const exhausted = {
      status: "EXHAUSTED" as const,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [
        hostAttempt("exa_keyless", 0, "NOT_DISPATCHED"),
        hostAttempt("exa_keyless", 0, "NOT_DISPATCHED", 2),
        hostAttempt("youcom_free", 1, "FAILED"),
      ],
    }
    expect(validateCascadeResponseRoutes(exhausted, execution)).toBe(exhausted)
    expect(() => validateCascadeResponseRoutes({
      ...exhausted,
      attempts: [hostAttempt("exa_keyless", 0, "NOT_DISPATCHED"), hostAttempt("youcom_free", 1, "FAILED")],
    }, execution)).toThrow("bounded same-route retry")
    expect(() => parseCascadeResponse({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{ ...hostAttempt("exa_keyless", 0, "NOT_DISPATCHED"), httpStatus: 502 }],
    })).toThrow("pre-dispatch connection failure with response evidence")
  })

  test("NOT_DISPATCHED retry requires the host reason and exact empty-response proof", () => {
    const retryable = hostAttempt("exa_keyless", 0, "NOT_DISPATCHED")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{ ...retryable, notDispatchedFailure: undefined }],
    })).toThrow("invalid route receipt")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{ ...retryable, notDispatchedFailure: "cancelled", httpStatus: undefined }],
    })).toThrow("exact empty-response proof")

    const cancelled = parseCascadeResponse({
      status: "CANCELLED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "cancelled-before-send-receipt",
      attempts: [{ ...retryable, notDispatchedFailure: "cancelled" }],
    })
    expect(cancelled.attempts[0]?.notDispatchedFailure).toBe("cancelled")
    expect(() => validateCascadeResponseRoutes({
      ...cancelled,
      status: "EXHAUSTED",
      attempts: [cancelled.attempts[0]!, hostAttempt("youcom_free", 1, "FAILED")],
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }, { routeKey: "youcom_free", attemptCount: 2 }],
    })).toThrow("terminal route outcome")
  })

  test("aggregate cancellation is terminal after route admission and retains exact receipt pins", () => {
    const cancelled = parseCascadeResponse({
      status: "CANCELLED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      receiptRef: "search-cancelled-receipt",
      attempts: [{ ...hostAttempt("exa_keyless", 0, "NOT_DISPATCHED", 1), notDispatchedFailure: "cancelled" as const }],
    })
    expect(cancelled.status).toBe("CANCELLED")
    expect(validateCascadeResponseRoutes(cancelled, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).toBe(cancelled)
    expect(() => parseCascadeResponse({
      status: "CANCELLED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [],
    })).toThrow("durable web-search aggregate receipt")
    expect(() => validateCascadeResponseRoutes({
      ...cancelled,
      status: "EXHAUSTED",
      attempts: [cancelled.attempts[0]!, hostAttempt("youcom_free", 1, "FAILED")],
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }, { routeKey: "youcom_free", attemptCount: 2 }],
    })).toThrow("terminal route outcome")
  })

  test("a retryable route receipt cannot be exhausted before its one same-route retry", () => {
    expect(() => validateCascadeResponseRoutes({
      status: "EXHAUSTED",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        status: "RETRYABLE_FAILURE",
        attempt: 1,
        httpStatus: 503,
      }],
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).toThrow("before the required bounded same-route retry")
    expect(() => validateCascadeResponseRoutes({
      status: "UNKNOWN",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [{
        ...hostAttempt("exa_keyless", 0, "FAILED"),
        status: "RETRYABLE_FAILURE",
        attempt: 1,
        httpStatus: 503,
      }],
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).not.toThrow()
  })

  test("result-unavailable reconciliation requires a successful final route receipt", () => {
    expect(() => validateCascadeResponseRoutes({
      status: "RECONCILED_RESULT_UNAVAILABLE",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [hostAttempt("exa_keyless", 0, "FAILED")],
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }],
    })).toThrow("without a successful route receipt")
  })

  test("bounds the HostKernel search body before retaining provider data", () => {
    expect(() => assertBoundedSearchBody({ results: [{ title: "ok" }] })).not.toThrow()
    expect(() => assertBoundedSearchBody({ nested: { payload: "x".repeat(2 * 1024 * 1024 + 1) } })).toThrow("oversized string")
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => assertBoundedSearchBody(cycle)).toThrow("cycle")
    expect(() => assertBoundedSearchBody({ value: Number.NaN })).toThrow("non-finite")
  })

  test("accepts only an exact bounded BYO cascade continuation envelope", () => {
    const continuation = parseCascadeResponse({
      status: "WAITING_SECRET",
      cascadeRef: "search_cascade_abc",
      cascadeDigest: `blake3:${"a".repeat(64)}`,
      routePlanDigest: `blake3:${"b".repeat(64)}`,
      routeIndex: 2,
      nextRoute: { attemptRef: "attempt_1" },
      attempts: [],
    })
    expect(continuation).toMatchObject({ status: "WAITING_SECRET", routeIndex: 2 })
    expect(() => parseCascadeResponse({
      status: "WAITING_SECRET",
      cascadeRef: "search_cascade_abc",
      cascadeDigest: `blake3:${"a".repeat(64)}`,
      routePlanDigest: `blake3:${"b".repeat(64)}`,
      routeIndex: 11,
      nextRoute: {},
      attempts: [],
    })).toThrow("invalid BYO web-search continuation")
    expect(() => parseCascadeResponse({
      status: "EXHAUSTED",
      receiptRef: "aggregate-receipt",
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [],
      nextRoute: {},
    })).toThrow("orphaned BYO")
    expect(() => validateCascadeResponseRoutes({
      ...continuation,
      nextRoute: { routeKey: "brave", attempt: 1 },
    }, {
      query: "docs",
      limit: 4,
      routes: [{ routeKey: "exa_keyless", attemptCount: 2 }, { routeKey: "brave", attemptCount: 2 }],
    })).toThrow("next approved route")
  })

  test("a settled success with an absent or unusable body is result-unavailable, not exhaustion", () => {
    const response = {
      status: "SUCCEEDED" as const,
      selectedProvider: "exa_keyless" as const,
      body: { results: [] },
      receiptRef: `blake3:${"a".repeat(64)}`,
      routePlanDigest: TEST_ROUTE_PLAN_DIGEST,
      attempts: [hostAttempt("exa_keyless", 0, "SUCCEEDED")],
    }
    for (const body of [undefined, { results: [] }, { malformed: true }]) {
      let failure: unknown
      try {
        decodeSuccessfulCascadeResults({ ...response, body }, 4, [])
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(SearchRuntimeError)
      expect(failure).toMatchObject({ outcome: "RESULT_UNAVAILABLE", receiptRef: response.receiptRef })
    }
  })

  test("route plan omits BYO routes without an opaque SecretBroker reference", () => {
    expect(createSearchRoutePlan({
      enabled: ["exa_keyless", "brave"],
      order: ["brave", "exa_keyless"],
      supportedProviders: ["exa_keyless", "brave"],
      credentialRefs: {},
    }).routes).toEqual(["exa_keyless"])
  })

  test("provider parsers reject non-web URLs and enforce result and text bounds", () => {
    expect(parseSearchProviderResponse("exa", {
      results: [
        { title: "x".repeat(300), url: "javascript:alert(1)", text: "unsafe" },
        { title: "valid", url: "https://example.com", text: "y".repeat(2_000) },
      ],
    }, 1)).toEqual([{ title: "valid", url: "https://example.com/", snippet: "y".repeat(1_200) }])
  })

  test("parses the documented response shapes for each fixed BYO provider adapter", () => {
    const row = { title: "Docs", url: "https://example.com/docs", description: "Relevant snippet" }
    expect(parseSearchProviderResponse("youcom", { results: { web: [row] } }, 1)).toHaveLength(1)
    expect(parseSearchProviderResponse("tavily", { results: [{ ...row, content: "Relevant snippet" }] }, 1)).toHaveLength(1)
    expect(parseSearchProviderResponse("firecrawl", { data: { web: [row] } }, 1)).toHaveLength(1)
    expect(parseSearchProviderResponse("parallel", { results: [{ ...row, excerpts: ["Relevant snippet"] }] }, 1)).toHaveLength(1)
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
    expect(result.result.routeAttempts).toEqual(result.attempts)
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
      { provider: "exa_keyless", attempt: 1, status: "failed", reason: "provider request failed" },
      { provider: "brave", attempt: 1, status: "failed", statusCode: 503 },
      { provider: "exa_keyless", attempt: 2, status: "failed", reason: "provider request failed" },
      { provider: "brave", attempt: 2, status: "succeeded" },
    ])
  })

  // DEC-V1-20/26: BYO/paid routes join only after explicit per-route
  // enablement + consent. A free route failing must never auto-upgrade the
  // cascade to a configured-but-not-enabled paid route.
  test("a configured but non-enabled paid route is never called when the enabled free routes fail", async () => {
    const calls: string[] = []
    const routes = [
      testRoute("exa_keyless", async () => {
        calls.push("exa_keyless")
        throw Object.assign(new Error("offline"), { status: 503 })
      }),
      testRoute("youcom_free", async () => {
        calls.push("youcom_free")
        throw Object.assign(new Error("offline"), { status: 503 })
      }),
      // Reachable and locally configured BYO routes, but never enabled or
      // consented for this cascade — they must stay untouched.
      testRoute("brave", async () => {
        calls.push("brave")
        return routeResult("brave")
      }),
      testRoute("tavily", async () => {
        calls.push("tavily")
        return routeResult("tavily")
      }),
    ]

    await expect(
      runSearchCascade({
        query: "repo",
        enabled: ["exa_keyless", "youcom_free"],
        order: ["exa_keyless", "youcom_free"],
        routes,
      }),
    ).rejects.toMatchObject({ code: "SEARCH_CASCADE_EXHAUSTED" })

    expect(calls).toEqual(["exa_keyless", "youcom_free", "exa_keyless", "youcom_free"])
    expect(calls).not.toContain("brave")
    expect(calls).not.toContain("tavily")
  })

  // 429 is failover-only: it applies a bounded Retry-After cooldown for that
  // route, never retries the rate-limited route, and later routes still run.
  test("an explicit Retry-After bounds the 429 cooldown and the rate-limited route is not retried", async () => {
    let now = 10_000
    const cooldowns = createProcessSearchCooldownStore(() => now)
    const calls: string[] = []
    const result = await runSearchCascade({
      query: "repo",
      enabled: ["exa_keyless", "brave"],
      order: ["exa_keyless", "brave"],
      routes: [
        testRoute("exa_keyless", async () => {
          calls.push("exa_keyless")
          throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 5_000 })
        }),
        testRoute("brave", async () => {
          calls.push("brave")
          return routeResult("brave")
        }),
      ],
      cooldownStore: cooldowns,
      workspace: "workspace-retry-after",
      now: () => now,
    })

    expect(result.result.provider).toBe("brave")
    // One pass only: 429 never triggers the bounded same-route retry.
    expect(calls).toEqual(["exa_keyless", "brave"])
    expect(result.attempts[0]).toMatchObject({
      provider: "exa_keyless",
      status: "rate_limited",
      statusCode: 429,
      retryAfterMs: 5_000,
    })
    expect(await cooldowns.get({ workspace: "workspace-retry-after", provider: "exa_keyless" })).toBe(15_000)
    now = 15_000
    expect(await cooldowns.get({ workspace: "workspace-retry-after", provider: "exa_keyless" })).toBeUndefined()
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
      { provider: "exa_keyless", status: "rate_limited", retryAfterMs: 60_000 },
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
      { provider: "brave", status: "failed", statusCode: 401, reason: "provider authentication rejected" },
      { provider: "exa_keyless", status: "succeeded" },
    ])
    expect(calls).toEqual(["brave", "exa_keyless"])
  })

  test("auth 403 and 407 are route-local and fall through without retrying the failed route", async () => {
    for (const status of [403, 407]) {
      const calls: string[] = []
      const result = await runSearchCascade({
        query: "repo",
        enabled: ["brave", "exa_keyless"],
        order: ["brave", "exa_keyless"],
        routes: [
          testRoute("brave", async () => {
            calls.push("brave")
            throw Object.assign(new Error(`HTTP ${status}`), { status })
          }),
          testRoute("exa_keyless", async () => {
            calls.push("exa_keyless")
            return routeResult("exa_keyless")
          }),
        ],
      })
      expect(result.result.provider).toBe("exa_keyless")
      expect(calls).toEqual(["brave", "exa_keyless"])
      expect(result.attempts[0]).toMatchObject({ provider: "brave", attempt: 1, statusCode: status })
    }
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
      attempts: [{ provider: "brave", status: "failed", statusCode: 400, reason: "provider returned HTTP 400" }],
    })
    expect(calls).toEqual(["brave"])
  })

  test("does not retain raw provider error strings in route failure provenance", async () => {
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
        { reason: "provider request failed" },
        { reason: "provider request failed" },
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
