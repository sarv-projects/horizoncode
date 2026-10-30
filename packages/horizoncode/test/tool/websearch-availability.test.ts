import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as WebSearchRuntime from "../../src/tool/websearch-runtime"
import type { SearchAttemptStore, SearchCooldownStore, SearchRouteID } from "../../src/tool/websearch-broker"

const WORKSPACE = "workspace-websearch-availability"
const BRAVE_CONSENT = [{ route: "brave" as const, consent: "secret_broker_unknown_cost_v1" as const }]
const secretRef = {
  schemaVersion: 1,
  secretRef: "secret_route_reference_1",
  provider: "brave",
  authKind: "api_key",
} as never

function stateStores(): WebSearchRuntime.SearchRuntimeStateStores {
  const cooldownStore: SearchCooldownStore = {
    get: async () => undefined,
    set: async () => {},
  }
  const attemptStore: SearchAttemptStore = {
    list: async () => [],
    listFailures: async () => [],
    record: async () => {},
  }
  return { cooldownStore, attemptStore }
}

function config(websearch: unknown) {
  return { get: () => Effect.succeed({ websearch }) } as any
}

function capability(input: {
  credentialRefs?: Record<string, unknown>
  providers?: readonly SearchRouteID[]
  dispatch?: () => Promise<unknown>
}): WebSearchRuntime.WebSearchGuardedCapability {
  return {
    ready: true,
    supportedProviders: input.providers ?? (["brave", "exa_keyless"] as const),
    credentialRefs: async () => (input.credentialRefs ?? {}) as any,
    executeSearchCascade: async () => {
      if (input.dispatch) return (await input.dispatch()) as any
      throw new Error("host dispatch must not run in this contract")
    },
    workspace: () => WORKSPACE,
  }
}

describe("WebSearch availability reports its true state", () => {
  test("a provider-backed route with a SecretBroker reference is ready", async () => {
    const runtime = WebSearchRuntime.make(
      capability({ credentialRefs: { brave: secretRef } }),
      config({ enabled: ["brave"], order: ["brave"], byoConsents: BRAVE_CONSENT }),
      stateStores(),
    )
    const availability = await Effect.runPromise(runtime.availability())
    expect(availability.status).toBe("ready")
    expect(availability.readyRoutes).toEqual(["brave"])

    const prepared = await Effect.runPromise(runtime.prepareEffectArguments({ query: "docs", numResults: 4 }))
    expect(prepared.arguments.routes.map((route) => route.routeKey)).toEqual(["brave"])
    expect(prepared.arguments.credentialRefsByRoute?.map((entry) => entry.routeKey)).toEqual(["brave"])

    const inspected = await Effect.runPromise(runtime.inspect({ settings: undefined, workspace: WORKSPACE }))
    expect(inspected.find((route) => route.provider === "brave")?.status).toBe("ready")
  })

  test("the same route without a credential stays dormant and names the missing prerequisite", async () => {
    const runtime = WebSearchRuntime.make(
      capability({}),
      config({ enabled: ["brave"], order: ["brave"], byoConsents: BRAVE_CONSENT }),
      stateStores(),
    )
    const availability = await Effect.runPromise(runtime.availability())
    expect(availability.status).toBe("unavailable")
    expect(availability.status === "unavailable" && availability.code).toBe("missing_credential")
    expect(availability.status === "unavailable" && availability.reason).toContain("no saved credential")
    expect(availability.status === "unavailable" ? availability.missingCredentialRoutes : []).toEqual(["brave"])

    let dispatches = 0
    const guarded = WebSearchRuntime.make(
      capability({ dispatch: async () => { dispatches += 1; throw new Error("no dispatch") } }),
      config({ enabled: ["brave"], order: ["brave"], byoConsents: BRAVE_CONSENT }),
      stateStores(),
    )
    await expect(Effect.runPromise(guarded.prepareEffectArguments({ query: "docs" })))
      .rejects.toThrow("No explicitly enabled web-search route is available for Guard admission")
    expect(dispatches).toBe(0)
  })

  test("the keyless cascade stays closed at its P1 seam", async () => {
    const runtime = WebSearchRuntime.make(
      capability({}),
      config({ querySharingConsent: "anonymous_free_v1", enabled: ["exa_keyless"], order: ["exa_keyless"] }),
      stateStores(),
    )
    const availability = await Effect.runPromise(runtime.availability())
    expect(availability.status === "unavailable" && availability.code).toBe("guard_not_released")
    expect(availability.status === "unavailable" && availability.reason).toContain("P1 Guarded-acceptance")
    const inspected = await Effect.runPromise(runtime.inspect({ settings: undefined, workspace: WORKSPACE }))
    expect(inspected.find((route) => route.provider === "exa_keyless")?.status).toBe("unavailable")
    expect(inspected.find((route) => route.provider === "exa_keyless")?.available).toBe(false)
  })

  test("no consented route is reported as such", async () => {
    const runtime = WebSearchRuntime.make(capability({ credentialRefs: { brave: secretRef } }), config({}), stateStores())
    const availability = await Effect.runPromise(runtime.availability())
    expect(availability.status === "unavailable" && availability.code).toBe("no_enabled_route")
  })

  test("a runtime composed without owner-owned search-state stores reports runtime_unavailable", async () => {
    // This mirrors the production guarded layer: it passes no state stores, so
    // no route can be admitted even when a credential exists.
    const runtime = WebSearchRuntime.make(
      capability({ credentialRefs: { brave: secretRef } }),
      config({ enabled: ["brave"], order: ["brave"], byoConsents: BRAVE_CONSENT }),
    )
    const availability = await Effect.runPromise(runtime.availability())
    expect(availability.status === "unavailable")
    expect(availability.status === "unavailable" && availability.code).toBe("runtime_unavailable")
    expect(availability.status === "unavailable" && availability.reason).toContain("durable search-state store")
  })

  test("search re-derives readiness from the admitted credential references", async () => {
    let dispatches = 0
    const runtime = WebSearchRuntime.make(
      capability({ dispatch: async () => { dispatches += 1; throw new Error("host-dispatch-reached") } }),
      config({ enabled: ["brave"], order: ["brave"], byoConsents: BRAVE_CONSENT }),
      stateStores(),
    )
    const failure = await runtime.search({
      execution: {
        query: "docs",
        limit: 4,
        routes: [{ routeKey: "brave", attemptCount: 2 }],
        credentialRefsByRoute: [{ routeKey: "brave", secretRef }],
      },
      scope: { sessionID: "ses_availability", messageID: "msg_availability", callID: "call_availability", workspace: WORKSPACE },
    }).pipe(Effect.runPromise).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("host-dispatch-reached")
    expect(dispatches).toBe(1)
  })
})
