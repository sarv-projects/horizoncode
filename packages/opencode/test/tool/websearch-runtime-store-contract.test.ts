import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as WebSearchRuntime from "../../src/tool/websearch-runtime"
import type { SearchCooldownStore, SearchAttemptStore } from "../../src/tool/websearch-broker"

const ROUTES = ["exa_keyless", "youcom_free"] as const
const WORKSPACE = "workspace-search-state-contract"
const ROUTE_PLAN_DIGEST = `blake3:${"a".repeat(64)}`
const SETTINGS = {
  querySharingConsent: "anonymous_free_v1" as const,
  enabled: [...ROUTES],
  order: [...ROUTES],
}

type SearchRuntimeStateStoresContract = WebSearchRuntime.SearchRuntimeStateStores

function makeWithStateStores(
  capability: WebSearchRuntime.WebSearchGuardedCapability,
  config: Parameters<typeof WebSearchRuntime.make>[1],
  stores?: SearchRuntimeStateStoresContract,
): WebSearchRuntime.Interface {
  return WebSearchRuntime.make(capability, config, stores)
}

function localCapability(executeSearchCascade: () => Promise<unknown>): WebSearchRuntime.WebSearchGuardedCapability {
  return {
    ready: true,
    supportedProviders: ROUTES,
    runtimeReady: { exa_keyless: true, youcom_free: true },
    credentialRefs: async () => ({}),
    executeSearchCascade: async () => executeSearchCascade() as any,
    workspace: () => WORKSPACE,
  }
}

const localConfig = {
  get: () => Effect.succeed({ websearch: SETTINGS }),
} as any

describe("WebSearch runtime state-store contract", () => {
  test("requires shared state stores before route admission or direct search", async () => {
    let dispatches = 0
    const runtime = makeWithStateStores(localCapability(async () => {
      dispatches += 1
      throw new Error("must not dispatch")
    }), localConfig, undefined)
    const execution = {
      query: "docs",
      limit: 4,
      routes: ROUTES.map((routeKey) => ({ routeKey, attemptCount: 2 as const })),
    }
    const scope = {
      sessionID: "ses_search_store",
      messageID: "msg_search_store",
      callID: "call_search_store",
      workspace: WORKSPACE,
    }

    await expect(Effect.runPromise(runtime.prepareEffectArguments({ query: "docs" })))
      .rejects.toThrow("No explicitly enabled web-search route is available for Guard admission")
    await expect(Effect.runPromise(runtime.search({ execution, scope })))
      .rejects.toThrow("The prepared web-search route plan contains a route that has not passed its Guard/SecretBroker release gate.")
    expect(dispatches).toBe(0)
  })

  test("uses injected cooldown and attempt stores for inspection and receipt projection", async () => {
    const cooldownReads: Parameters<SearchCooldownStore["get"]>[0][] = []
    const cooldownWrites: Parameters<SearchCooldownStore["set"]>[0][] = []
    const attemptListReads: Parameters<SearchAttemptStore["list"]>[0][] = []
    const failureListReads: Parameters<NonNullable<SearchAttemptStore["listFailures"]>>[0][] = []
    const attemptWrites: Parameters<SearchAttemptStore["record"]>[0][] = []
    const stores: SearchRuntimeStateStoresContract = {
      cooldownStore: {
        get: async (input) => {
          cooldownReads.push(input)
          return undefined
        },
        set: async (input) => {
          cooldownWrites.push(input)
        },
      },
      attemptStore: {
        list: async (input) => {
          attemptListReads.push(input)
          return []
        },
        listFailures: async (input) => {
          failureListReads.push(input)
          return []
        },
        record: async (input) => {
          attemptWrites.push(input)
        },
      },
    }
    const response = {
      status: "FAILED",
      routePlanDigest: ROUTE_PLAN_DIGEST,
      receiptRef: "aggregate-rate-limit-receipt",
      attempts: [
        {
          provider: "exa_keyless",
          routeId: "web.search.exa_keyless",
          routeIndex: 0,
          attempt: 1,
          status: "RATE_LIMITED",
          notDispatchedFailure: null,
          httpStatus: 429,
          retryAfterMs: 5_000,
          resultCount: null,
          observedAt: "2026-10-27T00:00:00.000Z",
          receiptRef: "route-rate-limit-receipt",
        },
        {
          provider: "youcom_free",
          routeId: "web.search.youcom_free",
          routeIndex: 1,
          attempt: 1,
          status: "FAILED",
          notDispatchedFailure: null,
          httpStatus: 400,
          retryAfterMs: null,
          resultCount: null,
          observedAt: "2026-10-27T00:00:01.000Z",
          receiptRef: "route-failure-receipt",
        },
      ],
    }
    // Local callback returns only a response fixture; no HostKernel or provider runs.
    const runtime = makeWithStateStores(localCapability(async () => response), localConfig, stores)

    await Effect.runPromise(runtime.inspect({ workspace: WORKSPACE, settings: SETTINGS }))
    await expect(Effect.runPromise(runtime.search({
      execution: {
        query: "docs",
        limit: 4,
        routes: [
          { routeKey: "exa_keyless", attemptCount: 2 },
          { routeKey: "youcom_free", attemptCount: 2 },
        ],
      },
      scope: { sessionID: "ses_search_store", messageID: "msg_search_store", callID: "call_search_store", workspace: WORKSPACE },
    }))).rejects.toBeInstanceOf(WebSearchRuntime.SearchRuntimeError)

    expect(cooldownReads).toEqual([
      { workspace: WORKSPACE, provider: "exa_keyless" },
      { workspace: WORKSPACE, provider: "youcom_free" },
    ])
    expect(attemptListReads).toEqual([{ workspace: WORKSPACE }])
    expect(failureListReads).toEqual([{ workspace: WORKSPACE }])
    expect(attemptWrites.map(({ workspace, attempt }) => ({ workspace, provider: attempt.provider, status: attempt.status }))).toEqual([
      { workspace: WORKSPACE, provider: "exa_keyless", status: "rate_limited" },
      { workspace: WORKSPACE, provider: "youcom_free", status: "failed" },
    ])
    expect(cooldownWrites).toEqual([
      expect.objectContaining({ workspace: WORKSPACE, provider: "exa_keyless", until: expect.any(Number) }),
    ])
  })
})