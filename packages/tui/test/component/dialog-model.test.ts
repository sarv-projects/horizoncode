import { describe, expect, test } from "bun:test"
import { catalogProvenanceLabel, isZeroPricedModel, modelAvailabilityLabel, modelListedInV1, modelSelectableInV1, sortModelOptions } from "../../src/component/dialog-model"
import { providerAuthFailureMessage, providerProvenance } from "../../src/component/dialog-provider"
import { modelPriceLabel } from "../../src/util/model"
import { FeatureExposure } from "@horizoncode/core/v1/config/feature-exposure"
import { featureSettingIsMutable } from "../../src/component/dialog-features"

test("provider model catalog label preserves advisory provenance without implying route health", () => {
  expect(catalogProvenanceLabel({
    source: "cache",
    freshness: "stale",
    sourceURL: "https://models.opencode.ai",
    retrievedAt: 0,
    contentDigest: "abcdef0123456789",
    license: "MIT",
    attribution: "Catalog authors",
  })).toBe("Catalog cache/stale · https://models.opencode.ai · retrieved 1970-01-01T00:00:00.000Z · digest abcdef012345 · license MIT · Catalog authors")
})

test("absent catalog provenance is unknown and never crashes the model dialog", () => {
  // The contract for an absent snapshot is "unknown, never current": the label
  // must not throw, and it must not invent a source, a freshness, or a
  // success-looking default such as cache/bundled/override.
  const absent = catalogProvenanceLabel(undefined)
  expect(absent).toContain("unknown")
  expect(absent).not.toContain("undefined")
  expect(absent).not.toContain("cache")
  expect(absent).not.toContain("bundled")
  expect(absent).not.toContain("override")
  expect(absent).not.toContain("fresh")
})

test("partial catalog provenance reports the missing field as unknown", () => {
  const empty = catalogProvenanceLabel({})
  expect(empty).toContain("unknown")
  expect(empty).not.toContain("undefined")

  const sourceOnly = catalogProvenanceLabel({ source: "override" })
  expect(sourceOnly).toContain("override")
  expect(sourceOnly).toContain("unknown")
  expect(sourceOnly).not.toContain("undefined")

  const freshnessOnly = catalogProvenanceLabel({ freshness: "stale" })
  expect(freshnessOnly).toContain("stale")
  expect(freshnessOnly).toContain("unknown")
  expect(freshnessOnly).not.toContain("undefined")
})

test("malformed optional provenance fields never crash the label", () => {
  // The server schema allows any non-negative Int for retrievedAt, which is not
  // necessarily a representable Date; a renderer must not die on that value.
  const label = catalogProvenanceLabel({
    source: "cache",
    freshness: "fresh",
    retrievedAt: Number.MAX_SAFE_INTEGER,
    contentDigest: 42 as unknown as string,
    license: null as unknown as string,
  })
  expect(label).toContain("Catalog cache/fresh")
  expect(label).not.toContain("Invalid")
  expect(label).not.toContain("undefined")
})

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

describe("modelListedInV1 (picker visibility)", () => {
  test("lists priced and incomplete-price models so their status stays readable", () => {
    // arch_V1/16 §provider/model hub: incomplete/paid pricing and non-OpenCode
    // providers stay visible *only as unavailable* — hiding them would delete
    // the very rows that carry the price and dispatch status.
    expect(modelListedInV1({ cost: { input: 5, output: 15, cache: { read: 1, write: 2 } }, anonymousOffer: false })).toBe(true)
    expect(modelListedInV1({ cost: { input: 0, output: 0 }, anonymousOffer: false })).toBe(true)
    expect(modelListedInV1({ cost: undefined, anonymousOffer: false })).toBe(true)
    expect(modelListedInV1({ cost: { input: 1, output: 2, cache: { read: 0, write: 0 } }, anonymousOffer: false })).toBe(true)
  })

  test("lists the explicit anonymous zero-priced offer", () => {
    expect(
      modelListedInV1({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, anonymousOffer: true }),
    ).toBe(true)
  })

  test("does not advertise a catalog $0 model the server has not offered anonymously", () => {
    // "Listed $0" beside "Dispatch unavailable" would advertise free access
    // that does not exist; every other model keeps its truthful row instead.
    expect(
      modelListedInV1({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, anonymousOffer: false }),
    ).toBe(false)
    expect(
      modelListedInV1({
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
        anonymousOffer: undefined,
      }),
    ).toBe(false)
  })
})

describe("modelAvailabilityLabel", () => {
  test("separates detected credentials, anonymous access, catalog hints and endpoint health", () => {
    expect(modelAvailabilityLabel({
      providerID: "anthropic",
      connected: true,
      status: "active",
      capabilities: { toolcall: true, reasoning: false, input: { image: true, audio: false } },
    })).toContain("Capabilities: tools yes · reasoning no · image-in yes · audio-in no · video-in unknown · pdf-in unknown")
    expect(modelAvailabilityLabel({
      providerID: "anthropic",
      connected: true,
      status: "active",
      capabilities: { toolcall: true, reasoning: false, input: { image: true, audio: false } },
    })).toContain("Price freshness unknown")
    const anonymous = modelAvailabilityLabel({
      providerID: "opencode",
      connected: false,
      anonymousOffer: true,
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limits: { context: 131072, input: 120000, output: 8192 },
    })
    expect(anonymous).toContain("Anonymous OpenCode offer · zero-priced catalog only")
    expect(anonymous).toContain("Selectable by HorizonCode V1 policy; dispatch unverified")
    expect(anonymous).toContain("Price freshness unknown")
    expect(modelAvailabilityLabel({
      connected: false,
      status: "beta",
      capabilities: { toolcall: false, reasoning: false, input: { image: false, audio: false } },
    })).toContain("No Guarded credential reference or anonymous route detected · Catalog beta")
    expect(modelAvailabilityLabel({
      connected: false,
      status: undefined,
      capabilities: undefined,
    })).toContain("No Guarded credential reference or anonymous route detected · Catalog status unknown")
    expect(modelAvailabilityLabel({
      providerID: "opencode",
      connected: false,
      anonymousOffer: true,
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limits: { context: -1, input: Number.NaN, output: Number.POSITIVE_INFINITY },
    })).toContain("Catalog limits: context unknown · input unknown · output unknown")
  })
})

describe("modelSelectableInV1", () => {
  const zeroPrice = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  test("requires the server's anonymous-offer projection and explicit zero pricing", () => {
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: false, anonymousOffer: true, status: "active", cost: zeroPrice })).toBe(true)
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: true, anonymousOffer: true, status: "active", cost: zeroPrice })).toBe(true)
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: false, status: "active", cost: zeroPrice })).toBe(false)
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: true, status: "active", cost: zeroPrice })).toBe(false)
    expect(modelSelectableInV1({ providerID: "anthropic", credentialSourceDetected: false, status: "active", cost: zeroPrice })).toBe(false)
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: false, status: "beta", cost: zeroPrice })).toBe(false)
    expect(modelSelectableInV1({ providerID: "opencode", credentialSourceDetected: false, status: "active" })).toBe(false)
  })

  test("local direct credentials unlock any connected active catalog route", () => {
    expect(
      modelSelectableInV1({
        providerID: "anthropic",
        credentialSourceDetected: true,
        localDirectCredentials: true,
        status: "active",
        cost: { input: 3, output: 15 },
      }),
    ).toBe(true)
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

    expect(message).toBe("Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch.")
    expect(message).not.toContain("sk-test-secret-value")
    expect(message).not.toContain("private provider response")
  })

  test("reports disabled OAuth credential changes without echoing details", () => {
    expect(providerAuthFailureMessage({ name: "ProviderAuthOauthCallbackFailed", message: "private detail" })).toBe(
      "Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch.",
    )
  })

  test("never echoes non-error values", () => {
    expect(providerAuthFailureMessage("private string detail")).toBe(
      "Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch.",
    )
    expect(providerAuthFailureMessage(null)).toBe(
      "Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch.",
    )
    expect(providerAuthFailureMessage(undefined)).toBe(
      "Guarded SecretBroker credential entry is unavailable. HorizonCode does not use raw environment, config, or legacy Auth credentials for provider dispatch.",
    )
  })
})

describe("providerProvenance", () => {
  test("labels legacy environment providers as detected but unused by dispatch", () => {
    expect(providerProvenance({ source: "env", env: ["OPENAI_API_KEY"], connected: true })).toBe(
      "Legacy environment source detected · provider-declared variables: OPENAI_API_KEY · not used for dispatch",
    )
    expect(providerProvenance({ source: "env", env: ["A_KEY", "B_KEY"], connected: true })).toBe(
      "Legacy environment source detected · provider-declared variables: A_KEY, B_KEY · not used for dispatch",
    )
  })

  test("distinguishes legacy auth from configuration without claiming dispatch", () => {
    expect(providerProvenance({ source: "api", env: [], connected: true })).toBe("Legacy Auth credential detected · not used for dispatch")
    expect(providerProvenance({ source: "config", env: [], connected: true })).toBe("Provider configuration present · credential status unknown; dispatch unavailable")
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
