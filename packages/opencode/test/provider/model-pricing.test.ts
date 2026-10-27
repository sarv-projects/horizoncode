import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "../../src/provider/provider"

function catalogModel(input: { id?: string; cost?: ModelsDev.Model["cost"] } = {}): ModelsDev.Model {
  return {
    id: input.id ?? "test-model",
    name: "Test Model",
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    cost: input.cost,
    limit: { context: 100_000, output: 4_096 },
  }
}

function catalog(models: Record<string, ModelsDev.Model>): ModelsDev.Provider {
  return { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"], models }
}

describe("provider pricing provenance (AN-002/AN-003)", () => {
  test("catalogue entry without a cost block keeps every rate unknown, not zero", () => {
    const provider = Provider.fromModelsDevProvider(catalog({ "mystery-model": catalogModel({ id: "mystery-model" }) }))
    const model = provider.models["mystery-model"]!
    expect(model.cost.input).toBeUndefined()
    expect(model.cost.output).toBeUndefined()
    expect(model.cost.cache.read).toBeUndefined()
    expect(model.cost.cache.write).toBeUndefined()
  })

  test("omitted rates stay unknown while explicitly declared zero rates stay zero", () => {
    const provider = Provider.fromModelsDevProvider(
      catalog({
        partial: catalogModel({ id: "partial", cost: { input: 0, output: 0 } }),
        explicit: catalogModel({ id: "explicit", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }),
      }),
    )
    expect(provider.models.partial!.cost.input).toBe(0)
    expect(provider.models.partial!.cost.output).toBe(0)
    expect(provider.models.partial!.cost.cache.read).toBeUndefined()
    expect(provider.models.partial!.cost.cache.write).toBeUndefined()
    expect(provider.models.explicit!.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })

  test("declared rates are preserved exactly without coercion", () => {
    const provider = Provider.fromModelsDevProvider(
      catalog({ "zero-input": catalogModel({ id: "zero-input", cost: { input: 0, output: 12 } }) }),
    )
    const model = provider.models["zero-input"]!
    expect(model.cost.input).toBe(0)
    expect(model.cost.output).toBe(12)
    expect(model.cost.cache.read).toBeUndefined()
  })

  test("missing tier and long-context cache rates remain unknown instead of becoming zero", () => {
    const provider = Provider.fromModelsDevProvider(
      catalog({
        tiered: catalogModel({
          id: "tiered",
          cost: {
            input: 1,
            output: 2,
            tiers: [{ tier: { type: "context", size: 100_000 }, input: 3, output: 4 }],
            context_over_200k: { input: 5, output: 6 },
          },
        }),
      }),
    )
    const cost = provider.models.tiered!.cost
    expect(cost.tiers?.[0]?.cache).toEqual({ read: undefined, write: undefined })
    expect(cost.experimentalOver200K?.cache).toEqual({ read: undefined, write: undefined })
  })

  test("provider model schema rejects negative prices instead of publishing invalid cost metadata", () => {
    const provider = Provider.fromModelsDevProvider(catalog({ model: catalogModel({ id: "model" }) }))
    const model = provider.models.model!
    expect(Schema.is(Provider.Model)({ ...model, cost: { ...model.cost, input: -0.01 } })).toBe(false)
  })
})

describe("provider list provenance privacy", () => {
  test("Provider List/OpenAPI schema does not declare the raw catalog source URL", () => {
    const fields = Provider.ListResult.fields.catalogSnapshot.fields
    expect(Object.hasOwn(fields, "sourceURL")).toBe(false)
  })
})

describe("toPublicInfo credential redaction", () => {
  test("raw provider credentials never leave the public projection", () => {
    const provider = Provider.fromModelsDevProvider(
      catalog({
        "model-a": catalogModel({
          id: "model-a",
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        }),
      }),
    )
    const publicInfo = Provider.toPublicInfo({
      ...provider,
      key: "SECRET-PROVIDER-KEY",
      options: {
        apiKey: "SECRET-OPTION-KEY",
        baseURL: "https://api.example.com",
        headers: {
          Authorization: "Bearer SECRET-BEARER",
          "x-api-key": "SECRET-HEADER-KEY",
          "x-client-tier": "pro",
        },
      },
      models: {
        "model-a": {
          ...provider.models["model-a"]!,
          options: { apiKey: "SECRET-MODEL-KEY", reasoningEffort: "low" },
        },
      },
    })

    const serialized = JSON.stringify(publicInfo)
    expect(publicInfo.key).toBeUndefined()
    expect(serialized).not.toContain("SECRET")
    expect(publicInfo.options).toEqual({
      apiKey: "[redacted]",
      baseURL: "https://api.example.com",
      headers: { Authorization: "[redacted]", "x-api-key": "[redacted]", "x-client-tier": "pro" },
    })
    expect(publicInfo.models["model-a"]!.options).toEqual({ apiKey: "[redacted]", reasoningEffort: "low" })
  })
})
