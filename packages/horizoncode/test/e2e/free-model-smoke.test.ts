import { describe, expect, test } from "bun:test"
import {
  collectProvenanceCandidates,
  evaluateFreeRouteGate,
  evaluateProvenance,
  type FreeRouteGateInput,
} from "./free-model-smoke"

/**
 * Offline unit coverage for the free-model E2E smoke gate (LM-018 preparation).
 *
 * Everything here is pure: no server boot, no provider/network request, no
 * credential material. The executable script reuses these exact functions
 * before it is allowed to create a session or send a prompt, so a refusal
 * proven here is a refusal of the real journey.
 */

const cleanList = {
  all: [
    { id: "opencode", source: "custom", name: "OpenCode Default", env: ["OPENCODE_API_KEY"], options: {}, models: {} },
    { id: "openai", source: "custom", name: "OpenAI", env: ["OPENAI_API_KEY"], options: {}, models: {} },
    { id: "anthropic", source: "custom", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], options: {}, models: {} },
  ],
  default: { opencode: "big-pickle" },
  anonymousFreeProviders: ["opencode"],
  anonymousFreeModels: ["opencode/big-pickle", "opencode/mimo-v2.5-free"],
  connected: ["opencode"],
  catalogSnapshot: {
    source: "cache",
    freshness: "fresh",
    updatedAt: 1_700_000_000_000,
    retrievedAt: 1_700_000_000_000,
    contentDigest: `sha256:${"a".repeat(64)}`,
    license: "CC0-1.0",
    attribution: "models.dev",
  },
} as const

const cleanConfig = {} as const

const input = (overrides: Partial<FreeRouteGateInput> = {}): FreeRouteGateInput => ({
  providerList: { ...cleanList, ...((overrides.providerList as object) ?? {}) } as FreeRouteGateInput["providerList"],
  config: { ...cleanConfig, ...((overrides.config as object) ?? {}) } as FreeRouteGateInput["config"],
  env: { PATH: "/usr/bin", ...overrides.env },
  cliModel: overrides.cliModel,
  serverPasswordConfigured: overrides.serverPasswordConfigured,
})

const codes = (result: ReturnType<typeof evaluateFreeRouteGate>) =>
  result.ok ? [] : result.refusals.map((refusal) => refusal.code)

describe("free-model smoke gate — pass cases", () => {
  test("clean anonymous-only environment passes with the default free model", () => {
    const result = evaluateFreeRouteGate(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.route).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
      ref: "opencode/big-pickle",
      source: "default",
    })
    expect(result.freeModels).toEqual(["opencode/big-pickle", "opencode/mimo-v2.5-free"])
    expect(result.catalog).toEqual(cleanList.catalogSnapshot)
  })

  test("explicit free CLI selection wins over the default", () => {
    const result = evaluateFreeRouteGate(input({ cliModel: "opencode/mimo-v2.5-free" }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.route.ref).toBe("opencode/mimo-v2.5-free")
    expect(result.route.source).toBe("cli")
  })

  test("config-pinned free model is accepted and labelled as config-sourced", () => {
    const result = evaluateFreeRouteGate(input({ config: { model: "opencode/big-pickle" } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.route.source).toBe("config")
  })

  test("catalog snapshot provenance is passed through as journey evidence", () => {
    const result = evaluateFreeRouteGate(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.catalog?.source).toBe("cache")
    expect(result.catalog?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe("free-model smoke gate — refusal matrix", () => {
  test("OPENCODE_API_KEY in env refuses with an exact reason", () => {
    const result = evaluateFreeRouteGate(input({ env: { OPENCODE_API_KEY: "sk-live" } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("ENV_OPENSEL_CREDENTIAL")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "ENV_OPENSEL_CREDENTIAL")
    expect(refusal?.reason).toContain("OPENCODE_API_KEY")
    expect(refusal?.reason).toContain("anonymous")
  })

  test("any connected provider other than opencode refuses (paid/BYO route enabled)", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { connected: ["opencode", "openai", "anthropic"] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("PAID_ROUTE_CONNECTED")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "PAID_ROUTE_CONNECTED")
    expect(refusal?.reason).toContain("openai")
    expect(refusal?.reason).toContain("anthropic")
    expect(refusal?.reason).not.toContain("opencode,")
  })

  test("opencode-go (subscription) connected refuses even though it is OpenCode-branded", () => {
    const result = evaluateFreeRouteGate(input({ providerList: { connected: ["opencode", "opencode-go"] } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("PAID_ROUTE_CONNECTED")
  })

  test("opencode provider source changed from custom refuses (credentialed or config-sourced)", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { all: [{ id: "opencode", source: "env" }] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("OPENSEL_NOT_ANONYMOUS")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "OPENSEL_NOT_ANONYMOUS")
    expect(refusal?.reason).toContain("env")
  })

  test("empty anonymous free projection refuses with NO_FREE_MODEL", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { anonymousFreeModels: [], anonymousFreeProviders: [] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("NO_FREE_MODEL")
  })

  test("missing anonymous projection (policy fail-closed) refuses too", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { anonymousFreeModels: undefined, anonymousFreeProviders: undefined } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("NO_FREE_MODEL")
  })

  test("config model pinned to a paid route refuses with CONFIG_MODEL_NOT_FREE", () => {
    const result = evaluateFreeRouteGate(input({ config: { model: "openai/gpt-5" } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CONFIG_MODEL_NOT_FREE")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "CONFIG_MODEL_NOT_FREE")
    expect(refusal?.reason).toContain("openai/gpt-5")
  })

  test("config model pinned outside the free set (same provider, paid model) refuses", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { anonymousFreeModels: ["opencode/big-pickle"] }, config: { model: "opencode/gpt-5" } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CONFIG_MODEL_NOT_FREE")
  })

  test("explicit CLI model outside the free set refuses with CLI_MODEL_NOT_FREE", () => {
    const result = evaluateFreeRouteGate(input({ cliModel: "anthropic/claude-sonnet-4-5" }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CLI_MODEL_NOT_FREE")
  })

  test("free CLI selection when the free set is empty still refuses (NO_FREE_MODEL)", () => {
    const result = evaluateFreeRouteGate(
      input({ cliModel: "opencode/big-pickle", providerList: { anonymousFreeModels: [], anonymousFreeProviders: [] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("NO_FREE_MODEL")
  })

  test("paid small_model refuses because background dispatch could leave the free route", () => {
    const result = evaluateFreeRouteGate(input({ config: { small_model: "openai/gpt-4.1-mini" } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CONFIG_SMALL_MODEL_NOT_FREE")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "CONFIG_SMALL_MODEL_NOT_FREE")
    expect(refusal?.reason).toContain("small_model")
  })

  test("any config-declared provider refuses (BYO/paid configuration present)", () => {
    const result = evaluateFreeRouteGate(
      input({ config: { provider: { openai: { options: { baseURL: "http://gateway.local" } } } } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CUSTOM_PROVIDER_CONFIG")
    if (result.ok) return
    const refusal = result.refusals.find((item) => item.code === "CUSTOM_PROVIDER_CONFIG")
    expect(refusal?.reason).toContain("openai")
  })

  test("config provider entry on opencode itself refuses (source would leave custom)", () => {
    const result = evaluateFreeRouteGate(input({ config: { provider: { opencode: { models: {} } } } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("CUSTOM_PROVIDER_CONFIG")
  })

  test("enabled_providers naming a paid provider refuses", () => {
    const result = evaluateFreeRouteGate(input({ config: { enabled_providers: ["opencode", "openai"] } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("PAID_PROVIDER_ENABLED")
  })

  test("disabled_providers disabling opencode refuses", () => {
    const result = evaluateFreeRouteGate(input({ config: { disabled_providers: ["opencode"] } }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("OPENSEL_DISABLED")
  })

  test("no resolvable selection refuses with SELECTION_UNRESOLVED", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { default: {}, anonymousFreeModels: ["opencode/big-pickle"] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("SELECTION_UNRESOLVED")
  })

  test("default model missing from the free set refuses with DEFAULT_MODEL_NOT_FREE", () => {
    const result = evaluateFreeRouteGate(
      input({ providerList: { default: { opencode: "gpt-5" }, anonymousFreeModels: ["opencode/big-pickle"] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("DEFAULT_MODEL_NOT_FREE")
  })

  test("turn mode without a server password refuses with SERVER_AUTH_UNCONFIGURED", () => {
    const result = evaluateFreeRouteGate(input({ serverPasswordConfigured: false }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals.map((item) => item.code)).toContain("SERVER_AUTH_UNCONFIGURED")
    const refusal = result.refusals.find((item) => item.code === "SERVER_AUTH_UNCONFIGURED")
    expect(refusal?.reason).toContain("OPENCODE_SERVER_PASSWORD")
  })

  test("check mode (password check omitted) still passes on a clean environment", () => {
    const result = evaluateFreeRouteGate(input({ serverPasswordConfigured: undefined }))
    expect(result.ok).toBe(true)
  })

  test("all applicable refusals are collected together, not first-fail", () => {
    const result = evaluateFreeRouteGate(
      input({
        env: { OPENCODE_API_KEY: "sk-live" },
        providerList: { connected: ["opencode", "openai"], anonymousFreeModels: [] },
        config: { model: "openai/gpt-5", small_model: "openai/gpt-4.1-mini" },
      }),
    )
    expect(result.ok).toBe(false)
    const found = codes(result)
    expect(found).toContain("ENV_OPENSEL_CREDENTIAL")
    expect(found).toContain("PAID_ROUTE_CONNECTED")
    expect(found).toContain("NO_FREE_MODEL")
    expect(found).toContain("CONFIG_MODEL_NOT_FREE")
    expect(found).toContain("CONFIG_SMALL_MODEL_NOT_FREE")
    expect(found.length).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// Provenance capture
// ---------------------------------------------------------------------------

const freeProvenance = {
  providerID: "opencode",
  modelID: "big-pickle",
  operationID: "op_1",
  requestID: "req_0abc123",
  cost: { status: "unknown" as const },
  tokens: {
    input: { status: "provider-reported" as const, value: 42 },
    output: { status: "provider-reported" as const, value: 17 },
    reasoning: { status: "unknown" as const },
    cache: {
      read: { status: "unknown" as const },
      write: { status: "unknown" as const },
    },
  },
}

describe("free-model smoke provenance capture", () => {
  test("assistant message with unknown-cost provenance passes as UNKNOWN", () => {
    const candidates = collectProvenanceCandidates({
      messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", usageProvenance: freeProvenance } }],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.cost.verdict).toBe("UNKNOWN")
    expect(result.capture.requestID).toBe("req_0abc123")
    expect(result.capture.source).toBe("message")
  })

  test("provider-reported zero cost passes as FREE", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
            usageProvenance: { ...freeProvenance, cost: { status: "provider-reported" as const, value: 0 } },
          },
        },
      ],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.cost.verdict).toBe("FREE")
  })

  test("estimated zero cost (zero-priced catalog, pricing revision present) passes as FREE", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
            usageProvenance: {
              ...freeProvenance,
              cost: {
                status: "estimated" as const,
                value: 0,
                priceSource: "selected-model-catalog",
                pricingRevision: `sha256:${"b".repeat(64)}`,
                pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                algorithm: "per-million-linear-v1" as const,
                tokenInputs: { input: 42, output: 17, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
              },
            },
          },
        },
      ],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.cost.verdict).toBe("FREE")
  })

  test("nonzero cost is refused as paid-route evidence (PAID_COST_EVIDENCE)", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
            usageProvenance: { ...freeProvenance, cost: { status: "provider-reported" as const, value: 0.021 } },
          },
        },
      ],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures.map((item) => item.code)).toContain("PAID_COST_EVIDENCE")
  })

  test("a differing model on an assistant message is a fallback and refuses", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        { info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", usageProvenance: freeProvenance } },
        { info: { role: "assistant", providerID: "openai", modelID: "gpt-5" } },
      ],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const failure = result.failures.find((item) => item.code === "FALLBACK_DETECTED")
    expect(failure?.reason).toContain("openai/gpt-5")
  })

  test("a same-provider model switch on a step-finish part is also a fallback", () => {
    const candidates = collectProvenanceCandidates({
      events: [
        {
          type: "message.part.updated",
          properties: {
            part: {
              type: "step-finish",
              usageProvenance: { ...freeProvenance, modelID: "mimo-v2.5-free" },
            },
          },
        },
      ],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures.map((item) => item.code)).toContain("FALLBACK_DETECTED")
  })

  test("no provenance anywhere refuses with PROVENANCE_MISSING (never invented)", () => {
    const candidates = collectProvenanceCandidates({
      messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "big-pickle" } }],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures.map((item) => item.code)).toContain("PROVENANCE_MISSING")
  })

  test("provenance without a request ID still passes, recording requestIDKnown=false (never invented)", () => {
    const { requestID: _drop, operationID: _drop2, ...withoutRequest } = freeProvenance
    const candidates = collectProvenanceCandidates({
      messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", usageProvenance: withoutRequest } }],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.requestID).toBeNull()
    expect(result.capture.requestIDKnown).toBe(false)
  })

  test("step-finish part provenance is collected from the event stream", () => {
    const candidates = collectProvenanceCandidates({
      events: [
        {
          type: "message.part.updated",
          properties: { part: { type: "step-finish", usageProvenance: freeProvenance } },
        },
      ],
    })
    expect(candidates.length).toBe(1)
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.source).toBe("event")
    expect(result.capture.cost.verdict).toBe("UNKNOWN")
  })

  test("token statuses are captured verbatim, unknown stays unknown", () => {
    const candidates = collectProvenanceCandidates({
      messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", usageProvenance: freeProvenance } }],
    })
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.tokens?.input).toEqual({ status: "provider-reported", value: 42 })
    expect(result.capture.tokens?.reasoning).toEqual({ status: "unknown" })
    expect(result.capture.tokens?.cache).toEqual({ read: { status: "unknown" }, write: { status: "unknown" } })
  })

  test("multiple consistent provenance candidates resolve to one capture", () => {
    const candidates = collectProvenanceCandidates({
      events: [
        { type: "message.part.updated", properties: { part: { type: "step-finish", usageProvenance: freeProvenance } } },
      ],
      messages: [{ info: { role: "assistant", providerID: "opencode", modelID: "big-pickle", usageProvenance: freeProvenance } }],
    })
    expect(candidates.length).toBe(2)
    const result = evaluateProvenance({ expected: { providerID: "opencode", modelID: "big-pickle" }, candidates })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.capture.requestID).toBe("req_0abc123")
  })
})

describe("free-model smoke candidate collection", () => {
  test("ignores user messages and unrelated parts", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        { info: { role: "user", parts: [] } },
        { info: { role: "assistant", providerID: "opencode", modelID: "big-pickle" }, parts: [{ type: "text" }] },
      ],
      events: [
        { type: "message.part.updated", properties: { part: { type: "text", text: "hello" } } },
        { type: "session.status", properties: { status: { type: "idle" } } },
      ],
    })
    // The assistant message without provenance still yields a route candidate
    // (so fallback detection can see it), but nothing else does.
    expect(candidates.length).toBe(1)
    expect(candidates[0]?.usageProvenance).toBeUndefined()
    expect(candidates[0]?.providerID).toBe("opencode")
  })

  test("finds provenance nested in message parts", () => {
    const candidates = collectProvenanceCandidates({
      messages: [
        {
          info: { role: "assistant", providerID: "opencode", modelID: "big-pickle" },
          parts: [{ type: "step-finish", usageProvenance: freeProvenance }],
        },
      ],
    })
    expect(candidates.length).toBe(2)
    expect(candidates.some((item) => item.usageProvenance !== undefined)).toBe(true)
  })
})
