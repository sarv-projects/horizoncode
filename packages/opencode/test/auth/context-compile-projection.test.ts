import { describe, expect, test } from "bun:test"
import { contextCompileCatalogSnapshot } from "@/auth/provider-transport"
import { resolveContextCompilePolicyV1 } from "@opencode-ai/core/session/context-compile-policy"

const snapshot = (overrides: { source?: string; freshness?: string; providers?: Record<string, unknown> } = {}) => ({
  source: overrides.source ?? "cache",
  freshness: overrides.freshness ?? "fresh",
  providers: (overrides.providers ?? {
    opencode: {
      models: {
        "big-pickle": {
          id: "declared-id-may-differ",
          limit: { context: 200_000, input: 100_000, output: 40_960 },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        },
        broken: { limit: { context: 0, output: 100 } },
        unknownPrices: { id: "unknownPrices", limit: { context: 100_000, output: 40_960 }, cost: { input: 1 } },
      },
    },
  }) as never,
})

const route = {
  providerID: "opencode",
  modelID: "big-pickle",
  routeRevision: `llm_${"a".repeat(64)}`,
  endpointRevision: `blake3:${"b".repeat(64)}`,
} as const

describe("context compile catalog snapshot projection (§30.26.4 step 3)", () => {
  test("projects the pinned row by key with limits and known prices", () => {
    const projected = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "big-pickle",
    })
    expect(projected.source).toBe("cache")
    expect(projected.freshness).toBe("fresh")
    expect(projected.model).toEqual({
      limit: { context: 200_000, input: 100_000, output: 40_960 },
      cost: { cache_read: 0, cache_write: 0 },
    })
  })

  test("matches a row by declared model id when the catalog key differs", () => {
    const projected = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "declared-id-may-differ",
    })
    expect(projected.model?.limit.context).toBe(200_000)
  })

  test("an unavailable or unrecognized snapshot never carries a model row", () => {
    const unavailable = contextCompileCatalogSnapshot({
      snapshot: snapshot({ source: "unavailable" }),
      providerID: "opencode",
      modelID: "big-pickle",
    })
    expect(unavailable).toEqual({ source: "unavailable", freshness: "fresh" })

    const unrecognized = contextCompileCatalogSnapshot({
      snapshot: snapshot({ source: "mystery", freshness: "brand-new" }),
      providerID: "opencode",
      modelID: "big-pickle",
    })
    expect(unrecognized).toEqual({ source: "unavailable", freshness: "unknown" })
    expect(unrecognized.model).toBeUndefined()
  })

  test("omits rather than fabricates malformed limits or unknown prices", () => {
    const malformed = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "broken",
    })
    expect(malformed.model).toBeUndefined()

    const unknownPrices = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "unknownPrices",
    })
    // Known components stay, absent prices remain unknown (AN-002): the
    // resolver derives priceCacheReadKnown from presence only.
    expect(unknownPrices.model).toEqual({ limit: { context: 100_000, output: 40_960 } })

    const missingRow = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "not-in-the-catalog",
    })
    expect(missingRow.model).toBeUndefined()
    expect(missingRow.source).toBe("cache")
  })

  test("feeds resolveContextCompilePolicyV1 without throwing (consumer contract)", () => {
    const catalogSnapshot = contextCompileCatalogSnapshot({
      snapshot: snapshot(),
      providerID: "opencode",
      modelID: "big-pickle",
    })
    const policy = resolveContextCompilePolicyV1({
      route,
      // The canonical direct-route producer's current value; readers must
      // never receive an unvalidated fabricated capability (CX-017).
      prefixCacheSupport: "unknown",
      catalogSnapshot,
    })
    expect(["cache_anchor", "minimize_tokens"]).toContain(policy.effective)
    expect(policy.prefixCacheSupport).toBe("unknown")
    // Fresh catalog with a known cache_read price resolves via the catalog hint.
    expect(policy.effective).toBe("cache_anchor")
    expect(policy.resolvedFrom).toBe("catalog_hint")
    expect(policy.catalogHints).toMatchObject({ providerID: "opencode", modelID: "big-pickle" })
  })

  test("an explicit cache_anchor request on an unvalidated route stays fail-closed for none", () => {
    expect(() =>
      resolveContextCompilePolicyV1({
        route,
        prefixCacheSupport: "none",
        requested: { value: "cache_anchor", source: "profile" },
        catalogSnapshot: { source: "unavailable", freshness: "unknown" },
      }),
    ).toThrow()
  })
})
