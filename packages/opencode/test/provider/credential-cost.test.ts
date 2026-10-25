import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"

const zeroCost = {
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "free-model",
    providerID: "opencode",
    api: {
      id: "free-model",
      url: "https://opencode.ai/inference/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Free",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: zeroCost,
    limit: { context: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...overrides,
  }
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "opencode",
    name: "OpenCode",
    source: "custom",
    env: [],
    options: { apiKey: "public" },
    models: { "free-model": model() },
    ...overrides,
  }
}

describe("anonymous free provider eligibility", () => {
  test("accepts only the exact active zero-priced credential-free OpenCode offer", () => {
    expect(Provider.isAnonymousFreeModel(provider() as never, model() as never)).toBe(true)
  })

  test("unknown or paid price is never treated as free", () => {
    const unknownPrice = model({ cost: { input: undefined, output: undefined, cache: { read: undefined, write: undefined } } })
    expect(Provider.isFreeModel(unknownPrice as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider() as never, unknownPrice as never)).toBe(false)

    const paid = model({ cost: { ...zeroCost, output: 0.5 } })
    expect(Provider.isAnonymousFreeModel(provider() as never, paid as never)).toBe(false)

    const unknownTier = model({
      cost: { ...zeroCost, tiers: [{ input: 0, output: 0, cache: { read: 0, write: 0 }, tier: { type: "context", size: 200_000 } }, { input: 3, output: 15, cache: { read: 0, write: 0 }, tier: { type: "context", size: 400_000 } }] },
    })
    expect(Provider.isAnonymousFreeModel(provider() as never, unknownTier as never)).toBe(false)
  })

  test("credential material, custom loaders and other providers cannot inherit the free route", () => {
    expect(Provider.isAnonymousFreeModel(provider({ options: { apiKey: "public", apiKey2: "secret" } }) as never, model() as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider({ options: { apiKey: "public", headers: { "x-title": "HorizonCode" } } }) as never, model() as never)).toBe(true)
    expect(Provider.isAnonymousFreeModel(provider({ options: { apiKey: "sk-secret" } }) as never, model() as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider({ source: "env" }) as never, model() as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider({ source: "env" }) as never, model() as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider({ id: "other", name: "Other" }) as never, model({ providerID: "other" }) as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider() as never, model({ status: "deprecated" }) as never)).toBe(false)
    expect(Provider.isAnonymousFreeModel(provider() as never, model({ headers: { authorization: "Bearer secret" } }) as never)).toBe(false)
  })

  test("public projection never returns the raw key or credential-bearing options", () => {
    const publicInfo = Provider.toPublicInfo(provider({ key: "sk-live-secret", options: { apiKey: "sk-live-secret" } }) as never)
    expect(publicInfo).not.toHaveProperty("key")
    expect(JSON.stringify(publicInfo)).not.toContain("sk-live-secret")
    expect((publicInfo.options as Record<string, unknown>).apiKey).toBe("[redacted]")
  })

  test("OpenCode default selection uses only active zero-priced models and never falls back cross-provider", () => {
    const ids = Provider.defaultModelIDs({
      opencode: provider({
        models: {
          "paid-model": model({ id: "paid-model", cost: { ...zeroCost, input: 1 } }),
          "free-model": model(),
        },
      }) as never,
      other: provider({
        id: "other",
        models: { "other-free": model({ providerID: "other", id: "other-free" }) },
      }) as never,
    })
    expect(ids.opencode).toBe("free-model")
    expect(ids.other).toBe("other-free")
  })
})
