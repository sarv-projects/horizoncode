import { describe, expect, test } from "bun:test"
import { hasUnadmittedCredentialProjection } from "../../src/session/llm"

const zeroCost = { input: 0, output: 0, cache: { read: 0, write: 0 } }

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "free-model",
    providerID: "opencode",
    api: { id: "free-model", url: "https://opencode.ai/inference/v1", npm: "@ai-sdk/openai-compatible" },
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

const gate = (input: { provider?: Record<string, unknown>; model?: Record<string, unknown>; env?: Record<string, string> }) =>
  hasUnadmittedCredentialProjection({
    provider: provider(input.provider) as never,
    model: model(input.model) as never,
    env: input.env ?? {},
  })

describe("llm credential gate", () => {
  test("admits only the exact anonymous offer carrying the literal public token", () => {
    expect(gate({})).toBe(false)
  })

  test("a public placeholder on a non-anonymous provider stays closed", () => {
    expect(gate({ provider: { source: "api" } })).toBe(true)
  })

  test("a real configured key stays closed", () => {
    expect(gate({ provider: { options: { apiKey: "sk-synthetic-not-a-real-key" } } })).toBe(true)
    expect(gate({ provider: { key: "sk-synthetic-not-a-real-key" } })).toBe(true)
  })

  test("a declared environment credential stays closed even on the anonymous route", () => {
    expect(gate({ provider: { env: ["OPENCODE_API_KEY"] }, env: { OPENCODE_API_KEY: "sk-synthetic-not-a-real-key" } })).toBe(true)
    expect(gate({ provider: { env: ["OPENCODE_API_KEY"] }, env: { OPENCODE_API_KEY: "" } })).toBe(false)
  })

  test("sensitive provider headers stay closed", () => {
    expect(gate({ provider: { options: { apiKey: "public", headers: { authorization: "Bearer synthetic" } } } })).toBe(true)
    expect(gate({ provider: { options: { apiKey: "public", headers: { "x-title": "HorizonCode" } } } })).toBe(false)
  })

  test("a provider with no credential projection stays open", () => {
    expect(gate({ provider: { options: {} } })).toBe(false)
  })
})
