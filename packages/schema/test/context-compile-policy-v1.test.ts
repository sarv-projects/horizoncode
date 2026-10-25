import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextCompilePolicyV1 } from "../src/context-compile-policy-v1"

/**
 * Strict-decode parity with the canonical
 * `arch_V1/contracts-v2/context-compile-policy-v1.schema.json`. Every bound the
 * JSON schema states (identifier 1..512, token limits 1..100000000,
 * anchorArtifactRef 1..512, closed enums, additionalProperties:false) must be
 * enforced by the TS mirror under the strict decode mode typed consumers use.
 */
const policyBase = {
  schemaVersion: 1 as const,
  requested: "auto" as const,
  effective: "cache_anchor" as const,
  resolvedFrom: "route_adapter" as const,
  prefixCacheSupport: "explicit_breakpoints" as const,
  catalogHints: {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
    catalogSource: "bundled" as const,
    catalogFreshness: "fresh" as const,
    contextLimitTokens: 200_000,
    outputLimitTokens: 8_192,
    priceCacheReadKnown: true,
    priceCacheWriteKnown: true,
  },
  anchorArtifactRef: "artifact:repo-anchor-1",
  anchorProjection: "full" as const,
}

const decode = (value: unknown) => Schema.decodeUnknownSync(ContextCompilePolicyV1, { onExcessProperty: "error" })(value)

test("canonical bounds: catalogHints providerID/modelID are 1..512 identifiers", () => {
  expect(decode(policyBase)).toEqual(policyBase)
  const withHints = (patch: Partial<typeof policyBase.catalogHints>) => ({
    ...policyBase,
    catalogHints: { ...policyBase.catalogHints, ...patch },
  })
  expect(() => decode(withHints({ providerID: "" }))).toThrow()
  expect(() => decode(withHints({ modelID: "" }))).toThrow()
  expect(() => decode(withHints({ providerID: "p".repeat(513) }))).toThrow()
  expect(() => decode(withHints({ modelID: "m".repeat(513) }))).toThrow()
  // The exact canonical boundary stays accepted.
  expect(decode(withHints({ providerID: "p".repeat(512), modelID: "m".repeat(512) }))).toMatchObject({
    catalogHints: { providerID: "p".repeat(512), modelID: "m".repeat(512) },
  })
})

test("canonical bounds: contextLimitTokens/outputLimitTokens are integers in 1..100000000", () => {
  const withTokens = (patch: { contextLimitTokens?: number; outputLimitTokens?: number }) => ({
    ...policyBase,
    catalogHints: { ...policyBase.catalogHints, ...patch },
  })
  expect(() => decode(withTokens({ contextLimitTokens: 0 }))).toThrow()
  expect(() => decode(withTokens({ contextLimitTokens: -1 }))).toThrow()
  expect(() => decode(withTokens({ contextLimitTokens: 100_000_001 }))).toThrow()
  expect(() => decode(withTokens({ outputLimitTokens: 0 }))).toThrow()
  expect(() => decode(withTokens({ outputLimitTokens: -5 }))).toThrow()
  expect(() => decode(withTokens({ outputLimitTokens: 100_000_001 }))).toThrow()
  expect(() => decode(withTokens({ contextLimitTokens: 1.5 }))).toThrow()
  // Exact canonical boundary values stay accepted.
  expect(decode(withTokens({ contextLimitTokens: 1, outputLimitTokens: 100_000_000 }))).toMatchObject({
    catalogHints: { contextLimitTokens: 1, outputLimitTokens: 100_000_000 },
  })
})

test("canonical bounds: anchorArtifactRef is a 1..512 string", () => {
  expect(() => decode({ ...policyBase, anchorArtifactRef: "" })).toThrow()
  expect(() => decode({ ...policyBase, anchorArtifactRef: "a".repeat(513) })).toThrow()
  expect(decode({ ...policyBase, anchorArtifactRef: "a".repeat(512) })).toMatchObject({ anchorArtifactRef: "a".repeat(512) })
  const { anchorArtifactRef: _omitted, ...withoutRef } = policyBase
  expect(decode(withoutRef)).toEqual(withoutRef)
})

test("canonical closed enums and required keys stay enforced", () => {
  expect(() => decode({ ...policyBase, requested: "force" })).toThrow()
  expect(() => decode({ ...policyBase, effective: "cache_aggressive" })).toThrow()
  expect(() => decode({ ...policyBase, resolvedFrom: "telemetry" })).toThrow()
  expect(() => decode({ ...policyBase, prefixCacheSupport: "sometimes" })).toThrow()
  expect(() => decode({ ...policyBase, anchorProjection: "partial" })).toThrow()
  expect(() => decode({ ...policyBase, catalogHints: { ...policyBase.catalogHints, catalogSource: "network" } })).toThrow()
  expect(() => decode({ ...policyBase, catalogHints: { ...policyBase.catalogHints, catalogFreshness: "ancient" } })).toThrow()
  expect(() => decode({ ...policyBase, cacheTier: "aggressive" })).toThrow()
  const { prefixCacheSupport: _missing, ...withoutSupport } = policyBase
  expect(() => decode(withoutSupport)).toThrow()
  const { catalogHints: _noHints, ...minimal } = policyBase
  expect(decode(minimal)).toEqual(minimal)
})
