import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Effect, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

// This provider-projection test uses the shared production HTTP route graph
// (`httpapi-layer`), which now resolves the real guarded WebSearchRuntime from
// the app LayerNode group; no test here invokes web search.
const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(ModelsDev.node),
    httpApiLayer,
  ),
)
const projectOptions = { config: { formatter: false, lsp: false } }
const providerID = "test-oauth-parity"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function expectUnavailable(body: string, message: string, service: string) {
  const value: unknown = JSON.parse(body)
  if (!isRecord(value)) throw new Error("HTTP error response was not a JSON object")
  expect(value).toEqual({ _tag: "ServiceUnavailableError", message, service })
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-function-options.ts"),
      [
        "export default {",
        '  id: "test.provider-function-options",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-models-mutation.ts"),
      [
        "export default {",
        '  id: "test.provider-models-mutation",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-opencode-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "denies API and OAuth authorization before provider hooks or credential storage",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const availableMethods = yield* request("/provider/auth", { headers })
      expect(availableMethods.status).toBe(200)
      expect(yield* availableMethods.json).toEqual({})
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      expect(api.status).toBe(503)
      expectUnavailable(
        api.body,
        "Provider credential entry is unavailable until Guarded SecretBroker input is integrated",
        "provider-credential-write",
      )

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(oauth.status).toBe(503)
      expectUnavailable(
        oauth.body,
        "Provider credential entry is unavailable until Guarded SecretBroker input is integrated",
        "provider-credential-write",
      )
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(503)
      expectUnavailable(
        response.body,
        "Provider credential entry is unavailable until Guarded SecretBroker input is integrated",
        "provider-credential-write",
      )
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(503)
      expectUnavailable(
        response.body,
        "Provider credential callbacks are unavailable until Guarded SecretBroker input is integrated",
        "provider-credential-write",
      )
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "keeps auth loader functions private and the config provider list scoped",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "OPENCODE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      if (!isRecord(providerBody)) throw new Error("provider endpoint returned a non-object JSON body")
      const snapshot = yield* ModelsDev.Service.use((service) => service.getSnapshot())
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      const catalogSnapshot = providerBody.catalogSnapshot
      if (!isRecord(catalogSnapshot)) throw new Error("provider endpoint omitted its catalog snapshot")
      expect(catalogSnapshot).toEqual({
        source: snapshot.source,
        freshness: snapshot.freshness,
        ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
        ...(snapshot.provenance?.sourceURL === undefined ? {} : { sourceURL: snapshot.provenance.sourceURL }),
        ...(snapshot.provenance?.retrievedAt === undefined ? {} : { retrievedAt: snapshot.provenance.retrievedAt }),
        ...(snapshot.provenance?.contentDigest === undefined ? {} : { contentDigest: snapshot.provenance.contentDigest }),
        ...(snapshot.provenance?.license === undefined ? {} : { license: snapshot.provenance.license }),
        ...(snapshot.provenance?.attribution === undefined ? {} : { attribution: snapshot.provenance.attribution }),
      })
      expect(providerByID(configBody, "providers", "google")).toBeUndefined()
    }),
    { ...projectOptions, init: writeFunctionOptionsPlugin },
  )

  it.instance(
    "reports configured provider state independently from model pricing",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", "{}")
      const response = yield* request("/provider", { headers: { "x-opencode-directory": directory } })
      expect(response.status).toBe(200)

      const body = yield* response.json
      expect(isRecord(body) && Array.isArray(body.connected) ? body.connected : []).toContain("test-configured")

      const configured = providerByID(body, "all", "test-configured")
      expect(isRecord(configured) && isRecord(configured.models) ? configured.models.uncosted : undefined).toBeDefined()
      const model = isRecord(configured) && isRecord(configured.models) ? configured.models.uncosted : undefined
      expect(isRecord(model) && isRecord(model.cost) ? model.cost.input : undefined).toBeUndefined()

      const opencode = providerByID(body, "all", "opencode")
      if (isRecord(opencode) && opencode.source === "custom") {
        const anonymous = isRecord(body) && Array.isArray(body.anonymousFreeProviders)
          ? body.anonymousFreeProviders.includes("opencode")
          : false
        const connected = isRecord(body) && Array.isArray(body.connected) ? body.connected : []
        expect(connected.includes("opencode")).toBe(anonymous)
      }
    }),
    {
      ...projectOptions,
      config: {
        ...projectOptions.config,
        provider: {
          "test-configured": {
            name: "Configured without pricing",
            npm: "@ai-sdk/openai-compatible",
            api: "http://127.0.0.1:1/v1",
            env: [],
            models: {
              uncosted: {
                name: "Uncosted model",
                tool_call: true,
                limit: { context: 128_000, output: 16_000 },
              },
            },
            options: { baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    },
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeProviderModelsMutationPlugin },
  )
})
