import { describe, expect, test } from "bun:test"
import { isZeroPricedModel, modelAvailabilityLabel, sortModelOptions } from "../../src/component/dialog-model"
import { providerAuthFailureMessage, providerProvenance } from "../../src/component/dialog-provider"
import { modelPriceLabel } from "../../src/util/model"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { featureSettingIsMutable } from "../../src/component/dialog-features"

describe("isZeroPricedModel (AN-002/AN-003)", () => {
  test("incomplete pricing is unknown, not zero-priced", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 0 } })).toBe(false)
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: {} } })).toBe(false)
    expect(
      isZeroPricedModel({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
    ).toBe(true)
  })

  test("missing pricing is unknown, not free", () => {
    expect(isZeroPricedModel({})).toBe(false)
    expect(isZeroPricedModel({ cost: {} })).toBe(false)
    expect(isZeroPricedModel({ cost: { input: 0 } })).toBe(false)
    expect(isZeroPricedModel({ cost: { output: 0 } })).toBe(false)
  })

  test("zero input with priced output is not free", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 9 } })).toBe(false)
  })

  test("declared non-zero cache rate is not free", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: { read: 1 } } })).toBe(false)
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: { write: 1 } } })).toBe(false)
  })

  test("non-zero tier or long-context rate is not free", () => {
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          tiers: [{ input: 2, output: 0 }],
        },
      }),
    ).toBe(false)
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          experimentalOver200K: { input: 0, output: 4 },
        },
      }),
    ).toBe(false)
  })

  test("all-zero tier and long-context rates stay free", () => {
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          tiers: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          experimentalOver200K: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      }),
    ).toBe(true)
  })
})

describe("modelPriceLabel (AN-002)", () => {
  test("shows input/output prices per million and treats incomplete prices as unknown", () => {
    expect(modelPriceLabel({ input: 5, output: 15, cache: { read: 1, write: 2 } })).toBe("$5 in / $15 out per 1M")
    expect(modelPriceLabel({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe("Listed $0")
    expect(modelPriceLabel({ input: 0, output: 0 })).toBe("Price unknown")
    expect(modelPriceLabel({ input: 5 })).toBe("Price unknown")
    expect(modelPriceLabel(undefined)).toBe("Price unknown")
  })
})

describe("modelAvailabilityLabel", () => {
  test("uses provider availability and catalog status without claiming auth or endpoint probes", () => {
    expect(modelAvailabilityLabel({
      connected: true,
      status: "active",
      capabilities: { toolcall: true, reasoning: false, input: { image: true, audio: false } },
    })).toBe("Provider available · Catalog active · Listed support: tools, image input")
    expect(modelAvailabilityLabel({
      connected: false,
      status: "beta",
      capabilities: { toolcall: false, reasoning: false, input: { image: false, audio: false } },
    })).toBe("Provider unavailable · Catalog beta")
    expect(modelAvailabilityLabel({
      connected: false,
      status: undefined,
      capabilities: undefined,
    })).toBe("Provider unavailable · Catalog status unknown")
  })
})

describe("sortModelOptions", () => {
  const options: Array<{ title: string; releaseDate: number; footer?: string }> = [
    { title: "b-model", releaseDate: 10 },
    { title: "free-new", releaseDate: 5, footer: "Free" },
    { title: "a-model", releaseDate: 10 },
    { title: "free-old", releaseDate: 1, footer: "Free" },
  ]

  test("free models sort first, then newest, then title", () => {
    expect(sortModelOptions(options, false).map((option) => option.title)).toEqual([
      "free-new",
      "free-old",
      "a-model",
      "b-model",
    ])
  })

  test("provider-scoped lists sort by newest then title only", () => {
    expect(sortModelOptions(options, true).map((option) => option.title)).toEqual([
      "a-model",
      "b-model",
      "free-new",
      "free-old",
    ])
  })
})

describe("providerAuthFailureMessage", () => {
  test("does not expose provider error details or credential-like values", () => {
    const message = providerAuthFailureMessage({
      name: "ProviderAuthError",
      message: "rejected key sk-test-secret-value",
      response: { body: "private provider response" },
    })

    expect(message).toBe("Provider credential changes are unavailable until Guarded credential-write support is enabled. Use an environment credential source instead.")
    expect(message).not.toContain("sk-test-secret-value")
    expect(message).not.toContain("private provider response")
  })

  test("reports disabled OAuth credential changes without echoing details", () => {
    expect(providerAuthFailureMessage({ name: "ProviderAuthOauthCallbackFailed", message: "private detail" })).toBe(
      "Provider credential changes are unavailable until Guarded credential-write support is enabled. Use an environment credential source instead.",
    )
  })

  test("never echoes non-error values", () => {
    expect(providerAuthFailureMessage("private string detail")).toBe(
      "Provider credential changes are unavailable until Guarded credential-write support is enabled. Use an environment credential source instead.",
    )
    expect(providerAuthFailureMessage(null)).toBe(
      "Provider credential changes are unavailable until Guarded credential-write support is enabled. Use an environment credential source instead.",
    )
    expect(providerAuthFailureMessage(undefined)).toBe(
      "Provider credential changes are unavailable until Guarded credential-write support is enabled. Use an environment credential source instead.",
    )
  })
})

describe("providerProvenance", () => {
  test("labels a connected environment provider by variable name only", () => {
    expect(providerProvenance({ source: "env", env: ["OPENAI_API_KEY"], connected: true })).toBe(
      "Environment: OPENAI_API_KEY",
    )
    expect(providerProvenance({ source: "env", env: ["A_KEY", "B_KEY"], connected: true })).toBe(
      "Environment: A_KEY, B_KEY",
    )
  })

  test("makes no provenance claim for api, config, disconnected, or empty-env providers", () => {
    expect(providerProvenance({ source: "api", env: [], connected: true })).toBeUndefined()
    expect(providerProvenance({ source: "config", env: [], connected: true })).toBeUndefined()
    expect(providerProvenance({ source: "env", env: ["KEY"], connected: false })).toBeUndefined()
    expect(providerProvenance({ source: "env", env: [], connected: true })).toBeUndefined()
    expect(providerProvenance({ source: "config", env: [], connected: false })).toBeUndefined()
  })
})

describe("feature settings policy lock", () => {
  test("a locked setting cannot be toggled even when its effective state is on", () => {
    const feature = FeatureExposure.list({})[0]!
    expect(featureSettingIsMutable(feature)).toBe(true)
    expect(featureSettingIsMutable({ ...feature, state: { ...feature.state, policyLock: "locked" } })).toBe(false)
  })
})
