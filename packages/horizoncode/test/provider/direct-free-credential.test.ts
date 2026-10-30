import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ModelsDev } from "@horizoncode/core/models-dev"
import { FSUtil } from "@horizoncode/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"

// Synthetic credential fixture. It is never supplied to production transport.
const KEY = `sk-or-v1-${"a".repeat(64)}`
const FREE = "nvidia/nemotron-3.5-super-vl:free"
const PAID = "openai/gpt-5-paid"
const UNKNOWN = "unknown-price-free"

afterEach(async () => {
  await disposeAllInstances()
})

function catalogModel(cost: ModelsDev.Model["cost"] | undefined, id: string): ModelsDev.Model {
  return {
    id,
    name: id,
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    ...(cost === undefined ? {} : { cost }),
    limit: { context: 100_000, output: 4_096 },
  }
}

const zeros = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

const catalog: Record<string, ModelsDev.Provider> = {
  opencode: {
    id: "opencode",
    name: "OpenCode Default",
    env: ["OPENCODE_API_KEY"],
    api: "https://opencode.ai/api",
    models: { "big-pickle": catalogModel(zeros, "big-pickle") },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    models: {
      [FREE]: catalogModel(zeros, FREE),
      [PAID]: catalogModel({ input: 1, output: 2, cache_read: 0, cache_write: 0 }, PAID),
      [UNKNOWN]: catalogModel(undefined, UNKNOWN),
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    api: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
    models: { "claude-free": catalogModel(zeros, "claude-free") },
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
      issueCredentialHandle: () => Effect.die("unused credential handle"),
      credentialMutationAvailable: () => Effect.succeed(false),
      putCredential: () => Effect.die("unused credential write"),
      describeCredential: () => Effect.die("unused credential read"),
      searchCredentialRefs: () => Effect.succeed({}),
      credentialRefsForProviders: () => Effect.succeed({ openrouter: "secret_openrouter_1" as SecretBrokerV1.SecretRef }),
      revokeCredential: () => Effect.die("unused credential revoke"),
      authorizeCredentialUse: () => Effect.die("unused credential lease"),
      dispatchAuthorizedSearchRequest: () => Effect.die("unused search dispatch"),
      dispatchAuthorizedManagedProviderRequest: () => Effect.die("unused managed dispatch"),
      createPinnedDirectProviderFetch: () => Effect.die("unused pinned fetch"),
      dispatchPinnedDirectProviderRequest: () => Effect.die("unused pinned direct dispatch"),
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

const configured = { config: {} }
const configuredWithRawKey = { config: { provider: { openrouter: { options: { apiKey: KEY } } } } }

it.instance(
  "exposes the exact direct free-route adapter",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect("getDirectFreeLanguage" in provider).toBe(true)
    }),
  configured,
)

describe("P6 OpenRouter free credential route", () => {
  it.instance(
    "fails closed before constructing the OpenRouter SDK or invoking raw fetch",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const selected = yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(FREE))
        let rawFetchCalls = 0
        const error = yield* Effect.flip(provider.getDirectFreeLanguage({
          model: selected,
          harnessID: "native-rich",
          fetch: Object.assign(
            async () => {
              rawFetchCalls++
              throw new Error("raw SDK fetch must not run")
            },
            { preconnect: () => undefined },
          ) satisfies typeof fetch,
        }))
        expect(String(error)).toContain("Core RequestExecutor")
        expect(String(error)).not.toContain(KEY)
        expect(rawFetchCalls).toBe(0)
      }),
    configured,
  )

  it.instance(
    "refuses all configured raw credential values",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const selected = yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(FREE))
        const error = yield* Effect.flip(provider.getDirectFreeLanguage({
          model: selected,
          harnessID: "native-rich",
          fetch: globalThis.fetch,
        }))
        expect(String(error)).not.toContain(KEY)
      }),
    configuredWithRawKey,
  )

  it.instance(
    "refuses a paid price on the allowlisted model",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const selected = yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(FREE))
        const error = yield* Effect.flip(provider.getDirectFreeLanguage({ model: selected, harnessID: "native-rich", fetch: globalThis.fetch }))
        expect(String(error)).toContain("Core RequestExecutor")
      }),
    {
      config: {
        provider: {
          openrouter: {
            options: {},
            models: { [FREE]: { cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } } },
          },
        },
      },
    },
  )

  it.instance(
    "never exposes an unallowlisted paid model on the credentialed provider",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const error = yield* Effect.flip(provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(PAID)))
        expect(String(error)).toContain(PAID)
        expect(String(error)).not.toContain(KEY)
      }),
    configured,
  )

  it.instance(
    "never exposes a provider model whose price is unknown",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const error = yield* Effect.flip(provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(UNKNOWN)))
        expect(String(error)).toContain(UNKNOWN)
        expect(String(error)).not.toContain(KEY)
      }),
    configured,
  )

  it.instance("refuses a provider the user did not explicitly configure", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const error = yield* Effect.flip(provider.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-free")))
      expect(String(error)).toContain("anthropic")
    }),
  )

  it.instance(
    "managed routing projects only the opaque credential reference",
    () =>
      Effect.gen(function* () {
        const projection = yield* Provider.managedRouteProjection({
          providerID: ProviderV2.ID.openrouter,
          modelID: ModelV2.ID.make(FREE),
          harnessID: "native-rich",
        })
        expect(projection.providerID).toBe(ProviderV2.ID.openrouter)
        expect(projection.modelID).toBe(ModelV2.ID.make(FREE))
        expect(projection.credentialLeaseRef).toBe("secret_openrouter_1")
        expect(JSON.stringify(projection)).not.toContain(KEY)
      }),
    configured,
  )
})
