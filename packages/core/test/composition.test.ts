import { describe, expect, test } from "bun:test"
import {
  resolveComposition,
  type CompositionCandidatePlugin,
  type CompositionResolution,
  type CompositionServiceOffer,
  type CompositionServiceRequirement,
  type TrustedCompositionPolicy,
} from "../src/composition"

function offer(serviceId: string, options: Partial<CompositionServiceOffer> = {}): CompositionServiceOffer {
  return {
    serviceId,
    version: "1.0.0",
    schemaDigest: "schema-v1",
    cardinality: "one",
    ...options,
  }
}

function requirement(
  serviceId: string,
  options: Partial<CompositionServiceRequirement> = {},
): CompositionServiceRequirement {
  return {
    serviceId,
    versionRange: "^1.0.0",
    cardinality: "one",
    optional: false,
    ...options,
  }
}

function trustedPolicy(options: Partial<TrustedCompositionPolicy> = {}): TrustedCompositionPolicy {
  return {
    mode: "production",
    sealedProviders: [],
    ...options,
  }
}

function resolve(
  plugins: readonly CompositionCandidatePlugin[],
  options: Partial<TrustedCompositionPolicy> = {},
): CompositionResolution {
  return resolveComposition({ plugins, trustedPolicy: trustedPolicy(options) })
}

function plugin(
  pluginId: string,
  options: Partial<Pick<CompositionCandidatePlugin, "provides" | "requires" | "packageDigest">> = {},
): CompositionCandidatePlugin {
  return {
    pluginId,
    packageDigest: options.packageDigest ?? `digest-${pluginId}`,
    provides: options.provides ?? [],
    requires: options.requires ?? [],
  }
}

function success(result: CompositionResolution) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Expected successful resolution: ${JSON.stringify(result.diagnostics)}`)
  return result
}

function failure(result: CompositionResolution) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("Expected resolution failure")
  return result.diagnostics
}

describe("resolveComposition", () => {
  test("produces stable providers, edges, and activation order independent of input order", () => {
    const consumer = plugin("consumer", {
      requires: [requirement("service.z"), requirement("service.a")],
    })
    const providerZ = plugin("provider-z", { provides: [offer("service.z")] })
    const providerA = plugin("provider-a", { provides: [offer("service.a")] })

    const forward = success(resolve([consumer, providerZ, providerA]))
    const reversed = success(resolve([providerA, providerZ, consumer]))

    expect(forward).toEqual(reversed)
    expect(forward.activationOrder).toEqual(["provider-a", "provider-z", "consumer"])
    expect(forward.dependencyEdges).toEqual([
      { consumerPluginId: "consumer", serviceId: "service.a", providerPluginId: "provider-a" },
      { consumerPluginId: "consumer", serviceId: "service.z", providerPluginId: "provider-z" },
    ])
  })

  test("reports a missing required service", () => {
    const diagnostics = failure(resolve([plugin("consumer", { requires: [requirement("missing")] })]))

    expect(diagnostics).toContainEqual({
      code: "missing_required_service",
      consumerPluginId: "consumer",
      serviceId: "missing",
    })
  })

  test("allows absent optional services without creating a dependency edge", () => {
    const resolved = success(
      resolve([
        plugin("consumer", {
          requires: [requirement("optional.missing", { optional: true })],
        }),
      ]),
    )

    expect(resolved.dependencyEdges).toEqual([])
    expect(resolved.activationOrder).toEqual(["consumer"])
  })

  test("rejects ambiguous singleton providers unless a trusted selection picks one", () => {
    const consumer = plugin("consumer", { requires: [requirement("store")] })
    const providerA = plugin("provider-a", { provides: [offer("store")] })
    const providerB = plugin("provider-b", { provides: [offer("store")] })
    const candidates = [consumer, providerA, providerB]

    expect(failure(resolve(candidates))).toContainEqual({
      code: "singleton_ambiguity",
      serviceId: "store",
      providerPluginIds: ["provider-a", "provider-b"],
    })

    const resolved = success(
      resolve(candidates, {
        singletonSelections: [{ serviceId: "store", pluginId: "provider-b" }],
      }),
    )
    expect(resolved.providers).toEqual([
      { serviceId: "store", pluginId: "provider-b", packageDigest: "digest-provider-b", priority: 0 },
    ])
    expect(resolved.dependencyEdges).toEqual([
      { consumerPluginId: "consumer", serviceId: "store", providerPluginId: "provider-b" },
    ])
  })

  test("orders many providers by priority, then plugin ID", () => {
    const consumer = plugin("consumer", {
      requires: [requirement("hooks", { cardinality: "many" })],
    })
    const providerZ = plugin("provider-z", {
      packageDigest: "digest-a",
      provides: [offer("hooks", { cardinality: "many" })],
    })
    const providerA = plugin("provider-a", {
      packageDigest: "digest-z",
      provides: [offer("hooks", { cardinality: "many" })],
    })
    const providerB = plugin("provider-b", {
      provides: [offer("hooks", { cardinality: "many" })],
    })

    const resolved = success(
      resolve([providerB, providerZ, consumer, providerA], {
        providerPriorities: [
          { serviceId: "hooks", pluginId: "provider-z", packageDigest: "digest-a", priority: 0 },
          { serviceId: "hooks", pluginId: "provider-a", packageDigest: "digest-z", priority: 0 },
          { serviceId: "hooks", pluginId: "provider-b", packageDigest: "digest-provider-b", priority: 2 },
        ],
      }),
    )
    expect(resolved.providers.map((provider) => provider.pluginId)).toEqual(["provider-a", "provider-z", "provider-b"])
    expect(resolved.dependencyEdges.map((edge) => edge.providerPluginId)).toEqual([
      "provider-a",
      "provider-z",
      "provider-b",
    ])
  })

  test("accepts safe-integer provider priorities and rejects invalid numeric values", () => {
    const provider = plugin("provider", {
      provides: [offer("hooks", { cardinality: "many" })],
    })
    const resolveWithPriority = (priority: number) =>
      resolve([provider], {
        providerPriorities: [{ serviceId: "hooks", pluginId: "provider", packageDigest: "digest-provider", priority }],
      })

    expect(success(resolveWithPriority(Number.MAX_SAFE_INTEGER)).providers[0]?.priority).toBe(Number.MAX_SAFE_INTEGER)

    for (const priority of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(failure(resolveWithPriority(priority))).toContainEqual({
        code: "invalid_provider_priority",
        pluginId: "provider",
        serviceId: "hooks",
      })
    }
  })

  test("reports SemVer range and schema digest incompatibilities", () => {
    const diagnostics = failure(
      resolve([
        plugin("consumer", {
          requires: [requirement("store", { versionRange: "^2.0.0", schemaDigest: "schema-v2" })],
        }),
        plugin("provider", {
          provides: [offer("store", { version: "1.0.0", schemaDigest: "schema-v1" })],
        }),
      ]),
    )

    expect(diagnostics).toContainEqual({
      code: "service_version_mismatch",
      consumerPluginId: "consumer",
      serviceId: "store",
      providerPluginId: "provider",
      expectedRange: "^2.0.0",
      actual: "1.0.0",
    })
    expect(diagnostics).toContainEqual({
      code: "schema_mismatch",
      consumerPluginId: "consumer",
      serviceId: "store",
      providerPluginId: "provider",
      expected: "schema-v2",
      actual: "schema-v1",
    })
  })

  test("validates strict SemVer and range syntax, with prereleases excluded by default", () => {
    expect(
      success(
        resolve([
          plugin("consumer", { requires: [requirement("store", { versionRange: ">=1.2.0 <2.0.0" })] }),
          plugin("provider", { provides: [offer("store", { version: "1.9.4" })] }),
        ]),
      ).activationOrder,
    ).toEqual(["provider", "consumer"])

    const invalid = failure(
      resolve([
        plugin("consumer", { requires: [requirement("store", { versionRange: "not a range" })] }),
        plugin("provider", { provides: [offer("store", { version: "1.02.0" })] }),
      ]),
    )
    expect(invalid).toContainEqual({
      code: "invalid_requirement_range",
      consumerPluginId: "consumer",
      serviceId: "store",
      versionRange: "not a range",
    })
    expect(invalid).toContainEqual({
      code: "invalid_provider_version",
      pluginId: "provider",
      serviceId: "store",
      version: "1.02.0",
    })

    const prerelease = failure(
      resolve([
        plugin("consumer", { requires: [requirement("store", { versionRange: "^1.0.0" })] }),
        plugin("provider", { provides: [offer("store", { version: "1.0.0-beta.1" })] }),
      ]),
    )
    expect(prerelease).toContainEqual({
      code: "service_version_mismatch",
      consumerPluginId: "consumer",
      serviceId: "store",
      providerPluginId: "provider",
      expectedRange: "^1.0.0",
      actual: "1.0.0-beta.1",
    })
  })

  test("rejects unauthorized sealed provider replacement and allows only explicit test replacement", () => {
    const sealed = {
      serviceId: "hz.guard",
      pluginId: "builtin.guard",
      packageDigest: "digest-builtin.guard",
      testReplacements: [{ pluginId: "test.guard", packageDigest: "digest-test.guard" }],
    }
    const testProvider = plugin("test.guard", {
      packageDigest: "digest-test.guard",
      provides: [offer("hz.guard")],
    })

    const productionDiagnostics = failure(resolve([testProvider], { sealedProviders: [sealed] }))
    expect(productionDiagnostics).toContainEqual({
      code: "missing_sealed_provider",
      serviceId: "hz.guard",
      pluginId: "builtin.guard",
    })
    expect(productionDiagnostics).toContainEqual({
      code: "unauthorized_sealed_provider_replacement",
      serviceId: "hz.guard",
      pluginId: "test.guard",
    })

    expect(success(resolve([testProvider], { mode: "test", sealedProviders: [sealed] })).providers).toEqual([
      {
        serviceId: "hz.guard",
        pluginId: "test.guard",
        packageDigest: "digest-test.guard",
        priority: 0,
      },
    ])
  })

  test("reports the same closed cycle path regardless of input order", () => {
    const pluginA = plugin("a", {
      provides: [offer("service.a")],
      requires: [requirement("service.b")],
    })
    const pluginB = plugin("b", {
      provides: [offer("service.b")],
      requires: [requirement("service.a")],
    })

    const first = failure(resolve([pluginA, pluginB]))
    const second = failure(resolve([pluginB, pluginA]))

    expect(first).toEqual(second)
    expect(first).toContainEqual({ code: "dependency_cycle", path: ["a", "b", "a"] })
  })

  test("resolves deep graphs iteratively without recursive stack growth", () => {
    const size = 8_000
    const plugins = Array.from({ length: size }, (_, index) =>
      plugin(`plugin-${String(index).padStart(5, "0")}`, {
        provides: [offer(`service-${index}`)],
        requires: index === 0 ? [] : [requirement(`service-${index - 1}`)],
      }),
    )

    const resolved = success(resolve(plugins))
    expect(resolved.activationOrder).toHaveLength(size)
    expect(resolved.activationOrder[0]).toBe("plugin-00000")
    expect(resolved.activationOrder[size - 1]).toBe("plugin-07999")
  })

  test("orders wide independent graphs deterministically using the ready-set priority", () => {
    const size = 5000
    const plugins = Array.from({ length: size }, (_, index) =>
      plugin(`plugin-${String(size - index).padStart(5, "0")}`, {
        provides: [offer(`service-${index}`)],
      }),
    )
    const resolved = success(resolve(plugins))

    expect(resolved.activationOrder).toHaveLength(size)
    expect(resolved.activationOrder[0]).toBe("plugin-00001")
    expect(resolved.activationOrder[size - 1]).toBe("plugin-05000")
  })
})
