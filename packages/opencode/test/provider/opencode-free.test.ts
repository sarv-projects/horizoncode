import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (key: string) => {
  if (!originalEnv.has(key)) originalEnv.set(key, process.env[key])
}

const set = (key: string, value: string) =>
  Effect.gen(function* () {
    rememberEnv(key)
    process.env[key] = value
    yield* Env.use.set(key, value)
  })

const remove = (key: string) =>
  Effect.gen(function* () {
    rememberEnv(key)
    delete process.env[key]
    yield* Env.use.remove(key)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const catalog: Record<string, ModelsDev.Provider> = {
  opencode: {
    id: "opencode",
    name: "OpenCode Default",
    env: ["OPENCODE_API_KEY"],
    api: "https://opencode.ai/api",
    models: {
      "big-pickle": { ...catalogModel({ input: 0, output: 0, cache_read: 0, cache_write: 0 }), id: "big-pickle" },
      "mimo-v2.5-free": { ...catalogModel({ input: 0, output: 0, cache_read: 0, cache_write: 0 }), id: "mimo-v2.5-free" },
      "gpt-5": { ...catalogModel({ input: 1, output: 2 }), id: "gpt-5" },
      "claude-sonnet-4-5": { ...catalogModel({ input: 1, output: 2 }), id: "claude-sonnet-4-5" },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: [],
    models: {},
  },
}

const modelsDev = LayerNode.make({
  service: ModelsDev.Service,
  layer: Layer.succeed(
    ModelsDev.Service,
    ModelsDev.Service.of({
      get: () => Effect.succeed(catalog),
      getSnapshot: () => Effect.succeed({ providers: catalog, source: "bundled", freshness: "fresh" }),
      refresh: () => Effect.void,
    }),
  ),
  deps: [],
  tag: ModelsDev.node.tag,
})
const auth = LayerNode.make({
  service: Auth.Service,
  layer: Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({}),
      set: () => Effect.void,
      remove: () => Effect.void,
      putCredential: () => Effect.die("unused credential write in provider pricing fixture"),
      describeCredential: () => Effect.die("unused credential read in provider pricing fixture"),
      searchCredentialRefs: () => Effect.succeed({}),
      credentialRefsForProviders: () => Effect.succeed({}),
      revokeCredential: () => Effect.die("unused credential revoke in provider pricing fixture"),
      authorizeCredentialUse: () => Effect.die("unused provider credential lease in free-model fixture"),
      dispatchAuthorizedSearchRequest: () => Effect.die("unused search dispatch in free-model fixture"),
      dispatchAuthorizedManagedProviderRequest: () => Effect.die("unused managed dispatch in free-model fixture"),
      createPinnedDirectProviderFetch: () => Effect.die("unused pinned fetch in free-model fixture"),
      dispatchPinnedDirectProviderRequest: () => Effect.die("unused pinned direct dispatch in free-model fixture"),
    }),
  ),
  deps: [],
  tag: Auth.node.tag,
})
const providerLayer = LayerNode.compile(
  LayerNode.group([Provider.node, FSUtil.node, Env.node, Config.node, Auth.node, Plugin.node, ModelsDev.node, RuntimeFlags.node]),
  [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [ModelsDev.node, modelsDev],
    [Auth.node, auth],
  ],
)

const it = testEffect(providerLayer)
const list = Provider.use.list()

function catalogModel(cost: ModelsDev.Model["cost"]): ModelsDev.Model {
  return {
    id: "test-model",
    name: "Test Model",
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    cost,
    limit: { context: 100_000, output: 4_096 },
  }
}

function model(cost: ModelsDev.Model["cost"]): Provider.Model {
  return Provider.fromModelsDevProvider({
    id: "opencode",
    name: "OpenCode",
    env: ["OPENCODE_API_KEY"],
    models: { "test-model": catalogModel(cost) },
  }).models["test-model"]
}

function malformedCost(cost: Partial<NonNullable<ModelsDev.Model["cost"]>>): ModelsDev.Model["cost"] {
  // Catalog input is external; retain this deliberately incomplete runtime fixture.
  return cost as unknown as ModelsDev.Model["cost"]
}

describe("isFreeModel pricing gate (AN-002)", () => {
  test("explicit zero pricing across every tier is free", () => {
    expect(Provider.isFreeModel(model({ input: 0, output: 0, cache_read: 0, cache_write: 0 }))).toBe(true)
    expect(Provider.isFreeModel(model({ input: 0, output: 0 }))).toBe(false)
  })

  test("absent pricing is never free", () => {
    expect(Provider.isFreeModel(model(undefined))).toBe(false)
  })

  test("missing output price, paid output, or paid cache usage is not free", () => {
    expect(Provider.isFreeModel(model(malformedCost({ input: 0 })))).toBe(false)
    expect(Provider.isFreeModel(model({ input: 0, output: 1 }))).toBe(false)
    expect(Provider.isFreeModel(model({ input: 0, output: 0, cache_read: 1 }))).toBe(false)
    expect(Provider.isFreeModel(model({ input: 0, output: 0, cache_write: 1 }))).toBe(false)
  })

  test("a paid base rate or paid tier keeps the model unavailable", () => {
    expect(Provider.isFreeModel(model({ input: 1, output: 0 }))).toBe(false)
    expect(
      Provider.isFreeModel(
        model({ input: 0, output: 0, tiers: [{ input: 5, output: 10, tier: { type: "context", size: 200_000 } }] }),
      ),
    ).toBe(false)
    expect(
      Provider.isFreeModel(
        model({ input: 0, output: 0, tiers: [{ input: 0, output: 10, tier: { type: "context", size: 200_000 } }] }),
      ),
    ).toBe(false)
    expect(Provider.isFreeModel(model({ input: 0, output: 0, context_over_200k: { input: 5, output: 10 } }))).toBe(false)
    expect(Provider.isFreeModel(model({ input: 0, output: 0, context_over_200k: { input: 0, output: 10 } }))).toBe(false)
  })
})

describe("opencode provider keyless free access", () => {
  it.instance("exposes only free models with the public token when keyless", () =>
    Effect.gen(function* () {
      yield* remove("OPENCODE_API_KEY")
      const providers = yield* list
      const provider = providers[ProviderV2.ID.opencode]

      expect(provider).toBeDefined()
      expect(provider.options.apiKey).toBe("public")
      expect(provider.key).toBeUndefined()
      expect(provider.models["big-pickle"]).toBeDefined()
      expect(provider.models["mimo-v2.5-free"]).toBeDefined()
      expect(provider.models["gpt-5"]).toBeUndefined()
      expect(provider.models["claude-sonnet-4-5"]).toBeUndefined()
      expect(Object.keys(provider.models).length).toBeGreaterThan(0)
      for (const item of Object.values(provider.models)) expect(item.cost.input).toBe(0)
    }),
  )

  it.instance(
    "hides models without explicit zero pricing",
    () =>
      Effect.gen(function* () {
        yield* remove("OPENCODE_API_KEY")
        const providers = yield* list
      const models = providers[ProviderV2.ID.opencode].models

      expect(models["injected-free"]).toBeDefined()
      expect(models["injected-beta-free"]).toBeUndefined()
      expect(models["injected-alpha-free"]).toBeUndefined()
      expect(models["injected-paid"]).toBeUndefined()
      expect(models["injected-unknown"]).toBeUndefined()
      }),
    {
      config: {
        provider: {
          opencode: {
            models: {
              "injected-free": { name: "Injected Free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
              "injected-beta-free": { name: "Injected Beta", status: "beta", cost: { input: 0, output: 0 } },
              "injected-alpha-free": { name: "Injected Alpha", status: "alpha", cost: { input: 0, output: 0 } },
              "injected-paid": { name: "Injected Paid", cost: { input: 1, output: 2 } },
              "injected-unknown": { name: "Injected Unknown" },
            },
          },
        },
      },
    },
  )

  it.instance("keeps the full catalog when an env key is set", () =>
    Effect.gen(function* () {
      yield* set("OPENCODE_API_KEY", "test-opencode-key")
      const providers = yield* list
      const provider = providers[ProviderV2.ID.opencode]

      expect(provider.options.apiKey).toBeUndefined()
      expect(provider.key).toBe("test-opencode-key")
      expect(provider.models["big-pickle"]).toBeDefined()
      expect(provider.models["gpt-5"]).toBeDefined()
      expect(provider.models["claude-sonnet-4-5"]).toBeDefined()
    }),
  )

  it.instance("labels the provider distinctly from the OpenCode Go subscription", () =>
    Effect.gen(function* () {
      const providers = yield* list

      expect(providers[ProviderV2.ID.opencode].name).toBe("OpenCode Default")
      const go = providers[ProviderV2.ID.make("opencode-go")]
      if (go) expect(go.name).toBe("OpenCode Go")
    }),
  )

  it.instance("sends the public bearer token to the model endpoint", () =>
    Effect.gen(function* () {
      yield* remove("OPENCODE_API_KEY")
      const provider = yield* Provider.Service
      const selected = yield* provider.getModel(ProviderV2.ID.opencode, ModelV2.ID.make("big-pickle"))
      // The pinned direct lane is the only sanctioned path that constructs the
      // anonymous SDK request; legacy getLanguage stays fail-closed.
      const { language, route } = yield* provider.getDirectLanguage({
        model: selected,
        harnessID: "native-rich",
        fetch: globalThis.fetch,
      })
      // §30.26.9 producer: the pinned direct route carries its route-adapter
      // prefix-cache capability (conservative "unknown" until §30.26.10
      // real-route validation) for the context-compile resolver.
      expect(route.prefixCacheSupport).toBe("unknown")
      const config = (language as unknown as {
        config: { headers: () => Record<string, string> }
      }).config
      const headers = new Headers(config.headers())

      expect(headers.get("authorization")).toBe("Bearer public")
    }),
  )
})
