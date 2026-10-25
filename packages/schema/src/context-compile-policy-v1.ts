/** Models.dev-informed context compile tier for one provider request. */

import { Schema } from "effect"

export const ContextCompilePolicyRequestedV1 = Schema.Literals(["auto", "cache_anchor", "minimize_tokens"])
export const ContextCompilePolicyEffectiveV1 = Schema.Literals(["cache_anchor", "minimize_tokens"])
export const ContextCompilePolicyResolvedFromV1 = Schema.Literals([
  "profile",
  "settings",
  "route_adapter",
  "catalog_hint",
  "measured_usage",
  "conservative_default",
])
export const PrefixCacheSupportV1 = Schema.Literals(["none", "ephemeral", "explicit_breakpoints", "unknown"])
export const ModelsDevCatalogSourceV1 = Schema.Literals(["cache", "bundled", "override", "unavailable"])
export const ModelsDevCatalogFreshnessV1 = Schema.Literals(["fresh", "stale", "unknown"])

/** Canonical identifier bound: `minLength: 1, maxLength: 512` on providerID/modelID/anchorArtifactRef. */
const BoundedIdentifier = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(512))
/** Canonical token bound: `integer, minimum: 1, maximum: 100000000` on the catalog limit tokens. */
const TokenLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000_000 }))

export const ContextCompileCatalogHintsV1 = Schema.Struct({
  providerID: BoundedIdentifier,
  modelID: BoundedIdentifier,
  catalogSource: ModelsDevCatalogSourceV1,
  catalogFreshness: ModelsDevCatalogFreshnessV1,
  contextLimitTokens: Schema.optional(TokenLimit),
  outputLimitTokens: Schema.optional(TokenLimit),
  priceCacheReadKnown: Schema.optional(Schema.Boolean),
  priceCacheWriteKnown: Schema.optional(Schema.Boolean),
})

export const ContextCompilePolicyV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requested: ContextCompilePolicyRequestedV1,
  effective: ContextCompilePolicyEffectiveV1,
  resolvedFrom: ContextCompilePolicyResolvedFromV1,
  prefixCacheSupport: PrefixCacheSupportV1,
  catalogHints: Schema.optional(ContextCompileCatalogHintsV1),
  anchorArtifactRef: Schema.optional(BoundedIdentifier),
  anchorProjection: Schema.optional(Schema.Literals(["full", "compressed"])),
})

export type ContextCompilePolicyV1 = typeof ContextCompilePolicyV1.Type
