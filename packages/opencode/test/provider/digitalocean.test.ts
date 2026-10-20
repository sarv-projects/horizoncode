import { expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Provider } from "../../src/provider/provider"

import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { cachedDigitalOceanRouters } from "../../src/provider/digitalocean-catalog"

const DIGITALOCEAN = ProviderV2.ID.make("digitalocean")
const it = testEffect(LayerNode.compile(Provider.node))

const withEnv = <A, E, R>(values: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]] as const))
      Object.assign(process.env, values)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

it.instance(
  "digitalocean provider autoloads from DIGITALOCEAN_ACCESS_TOKEN",
  () =>
    withEnv(
      { DIGITALOCEAN_ACCESS_TOKEN: "test-token" },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[DIGITALOCEAN]).toBeDefined()
        expect(providers[DIGITALOCEAN].source).toBe("env")
        const baseModel = Object.values(providers[DIGITALOCEAN].models)[0]
        expect(baseModel.api.url).toBe("https://inference.do-ai.run/v1")
        expect(baseModel.api.npm).toBe("@ai-sdk/openai-compatible")
        const routerEntries = Object.keys(providers[DIGITALOCEAN].models).filter((id) => id.startsWith("router:"))
        expect(routerEntries.length).toBe(0)
      }),
    ),
  { config: {} },
)

it.instance(
  "legacy environment auth never enables cached DigitalOcean routes",
  () =>
    withEnv(
      {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          digitalocean: {
            type: "api",
            key: "legacy-secret-must-not-be-used",
            metadata: { routers: JSON.stringify([{ name: "legacy-router" }]) },
          },
        }),
      },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[DIGITALOCEAN]).toBeUndefined()
      }),
    ),
  { config: {} },
)

// This pure projection is independently testable without re-enabling legacy auth
// reads, the DigitalOcean plugin, OAuth refresh, or a network request.
test("cached DigitalOcean router projection is bounded, inert, and price-unknown", () => {
  const models = cachedDigitalOceanRouters({
    routers: JSON.stringify([
      { name: "cached-router" },
      { name: "cached-router" },
      { name: "../bad-route" },
      { name: "router with spaces" },
    ]),
    oauth_access: "must-never-be-read-by-the-catalog-adapter",
    oauth_expires: "1",
  })
  expect(models).toHaveLength(1)
  expect(models[0].id).toBe(ModelV2.ID.make("router:cached-router"))
  expect(models[0].api.url).toBe("https://inference.do-ai.run/v1")
  expect(models[0].api.npm).toBe("@ai-sdk/openai-compatible")
  expect(models[0].cost.input).toBeUndefined()
  expect(models[0].cost.output).toBeUndefined()
})

test("cached DigitalOcean router projection rejects malformed and over-limit metadata", () => {
  expect(cachedDigitalOceanRouters({ routers: "not-json" })).toEqual([])
  expect(cachedDigitalOceanRouters({ routers: "x".repeat(65_537) })).toEqual([])
  expect(cachedDigitalOceanRouters({ routers: JSON.stringify(Array.from({ length: 129 }, (_, i) => ({ name: `r${i}` }))) })).toEqual([])
})

it.instance(
  "digitalocean provider.models passes through base models when no auth metadata",
  () =>
    withEnv(
      { DIGITALOCEAN_ACCESS_TOKEN: "test-token" },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models = providers[DIGITALOCEAN].models
        expect(Object.keys(models).length).toBeGreaterThan(0)
        expect(Object.keys(models).filter((id) => id.startsWith("router:")).length).toBe(0)
      }),
    ),
  { config: {} },
)
