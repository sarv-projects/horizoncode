import { describe, expect, test } from "bun:test"
import { ProviderDoctor } from "../../src/provider/doctor"

const request = {
  schemaVersion: 1,
  doctorRunId: "pdr_offline_1",
  tier: "offline",
  selection: {
    providerRef: "provider:opencode",
    modelRef: "model:opencode/big-pickle",
  },
  deadlineMs: 5_000,
  maxNetworkRequests: 0,
} as const

describe("ProviderDoctor.inspectOffline", () => {
  const auth = { principal: { kind: "host_os" as const } }

  test("does not trust caller configuration claims and keeps remote state unchecked", () => {
    const result = ProviderDoctor.inspectOffline(request, auth)

    expect(result.localReadiness).toBe("UNKNOWN")
    expect(result.selection.configurationStatus).toBe("UNKNOWN")
    expect(result.remoteChecks).toEqual({ entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" })
    expect(result.credentialAccess).toBe("NOT_READ")
    expect(result.networkRequestCount).toBe(0)
    expect(result.costStatus).toBe("NOT_APPLICABLE")
    expect(result.probes.find((probe) => probe.phase === "auth")).toMatchObject({
      outcome: "SKIPPED",
      code: "offline_credentials_not_read",
    })
  })

  test("reports a missing model as locally incomplete without checking remote state", () => {
    const result = ProviderDoctor.inspectOffline({
      ...request,
      selection: { providerRef: "provider:opencode" },
    }, auth)

    expect(result.localReadiness).toBe("INCOMPLETE")
    expect(result.remoteChecks).toEqual({ entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" })
  })

  test("rejects contradictory local provider/model references without a provider lookup", () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      throw new Error("offline inspection attempted network access")
    }) as unknown as typeof fetch
    try {
      const result = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:alpha", modelRef: "model:beta/model-id" },
      }, auth)
      expect(result.localReadiness).toBe("INVALID")
      expect(result.selection.configurationStatus).toBe("INVALID")
      expect(result.probes.find((probe) => probe.phase === "config")).toMatchObject({
        outcome: "FAIL",
        code: "selected_model_provider_mismatch",
      })
      expect(result.networkRequestCount).toBe(0)
      expect(result.credentialAccess).toBe("NOT_READ")
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("marks malformed selection references invalid but keeps unavailable catalog facts unknown", () => {
    const malformed = ProviderDoctor.inspectOffline({
      ...request,
      selection: { providerRef: "provider:alpha", modelRef: "model:missing-separator" },
    }, auth)
    expect(malformed.localReadiness).toBe("INVALID")
    expect(malformed.probes.find((probe) => probe.phase === "config")?.code).toBe("invalid_selection_reference")

    const validButUnresolved = ProviderDoctor.inspectOffline(request, auth)
    expect(validButUnresolved.localReadiness).toBe("UNKNOWN")
    expect(validButUnresolved.selection.configurationStatus).toBe("UNKNOWN")
  })

  test("resolves only exact local catalog/config models without reading credentials or networking", () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      throw new Error("offline inspection attempted network access")
    }) as unknown as typeof fetch
    try {
      const facts = {
        catalog: { alpha: { models: { "model-id": {} } } },
        config: {
          disabled_providers: [],
          provider: { custom: { models: { "custom-id": {} }, options: { apiKey: "must-not-escape" } } },
        },
      }
      const catalogModel = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:alpha", modelRef: "model:alpha/model-id" },
      }, auth, facts)
      expect(catalogModel.localReadiness).toBe("READY")
      expect(catalogModel.selection.configurationStatus).toBe("VALID")
      expect(catalogModel.probes.find((probe) => probe.phase === "config")).toMatchObject({ outcome: "PASS" })

      const configuredModel = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:custom", modelRef: "model:custom/custom-id" },
      }, auth, facts)
      expect(configuredModel.localReadiness).toBe("READY")
      expect(JSON.stringify(configuredModel)).not.toContain("must-not-escape")

      const missingModel = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:alpha", modelRef: "model:alpha/missing" },
      }, auth, facts)
      expect(missingModel.localReadiness).toBe("INVALID")
      expect(missingModel.probes.find((probe) => probe.phase === "config")?.code).toBe("selected_model_unavailable")

      const staleCatalog = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:alpha", modelRef: "model:alpha/model-id" },
      }, auth, { ...facts, catalogFreshness: "stale" })
      expect(staleCatalog.localReadiness).toBe("UNKNOWN")
      expect(staleCatalog.selection.configurationStatus).toBe("UNKNOWN")
      expect(staleCatalog.probes.find((probe) => probe.phase === "config")?.code).toBe("catalog_snapshot_not_fresh")

      const missingFromStaleCatalog = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:custom", modelRef: "model:custom/not-in-old-catalog" },
      }, auth, {
        catalog: {},
        catalogFreshness: "stale",
        config: { provider: { custom: { models: {} } } },
      })
      expect(missingFromStaleCatalog.localReadiness).toBe("UNKNOWN")
      expect(missingFromStaleCatalog.selection.configurationStatus).toBe("UNKNOWN")
      expect(missingFromStaleCatalog.probes.find((probe) => probe.phase === "config")?.code).toBe("catalog_snapshot_not_fresh")

      const disabled = ProviderDoctor.inspectOffline({
        ...request,
        selection: { providerRef: "provider:alpha", modelRef: "model:alpha/model-id" },
      }, auth, {
        ...facts,
        config: { ...facts.config, disabled_providers: ["alpha"] },
      })
      expect(disabled.localReadiness).toBe("INVALID")
      expect(disabled.probes.find((probe) => probe.phase === "config")?.code).toBe("provider_disabled")
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects credential-bearing or network-enabled input rather than inspecting it", () => {
    expect(() => ProviderDoctor.inspectOffline({ ...request, apiKey: "must-not-be-read" }, auth)).toThrow()
    expect(() => ProviderDoctor.inspectOffline({ ...request, maxNetworkRequests: 1 }, auth)).toThrow()
  })

  test("rejects caller-supplied configuration status without touching the provider route", () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      throw new Error("offline inspection attempted network access")
    }) as unknown as typeof fetch

    try {
      expect(() =>
        ProviderDoctor.inspectOffline({
          ...request,
          selection: { ...request.selection, configurationStatus: "INVALID" },
        }, auth),
      ).toThrow()
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("requires trusted context instead of accepting caller identity as authentication", () => {
    expect(() => ProviderDoctor.inspectOffline(request, undefined as never)).toThrow(/trusted authenticated principal/)
  })

  test("keeps a catalog request unavailable until a pre-dispatch Guard verifies its network grant", () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      throw new Error("catalog probe must remain pre-dispatch unavailable")
    }) as unknown as typeof fetch

    try {
      const result = ProviderDoctor.inspectCatalog({
        ...request,
        tier: "catalog",
        maxNetworkRequests: 1,
        networkGrantRef: "grant:caller-asserted",
      }, auth)
      expect(result).toMatchObject({
        tier: "catalog",
        networkRequestCount: 0,
        credentialAccess: "NOT_READ",
        costStatus: "NOT_INCURRED",
      })
      expect(result.remoteChecks).toEqual({ entitlement: "UNKNOWN", quota: "UNKNOWN", service: "UNKNOWN" })
      expect(result.probes.find((probe) => probe.phase === "catalog")).toMatchObject({
        outcome: "SKIPPED",
        code: "catalog_pre_dispatch_guard_unavailable",
      })
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reports local catalog selection truth while keeping remote catalog probes unavailable", () => {
    const result = ProviderDoctor.inspectCatalog({
      ...request,
      tier: "catalog",
      maxNetworkRequests: 1,
      networkGrantRef: "grant:caller-asserted",
    }, auth, {
      catalog: { opencode: { models: { "big-pickle": {} } } },
      catalogFreshness: "fresh",
      config: {},
    })

    expect(result.localReadiness).toBe("READY")
    expect(result.selection.configurationStatus).toBe("VALID")
    expect(result.remoteChecks).toEqual({ entitlement: "UNKNOWN", quota: "UNKNOWN", service: "UNKNOWN" })
    expect(result.credentialAccess).toBe("NOT_READ")
    expect(result.networkRequestCount).toBe(0)
    expect(result.costStatus).toBe("NOT_INCURRED")
    expect(result.probes.find((probe) => probe.phase === "catalog")).toMatchObject({
      outcome: "SKIPPED",
      code: "catalog_pre_dispatch_guard_unavailable",
    })
  })
})
