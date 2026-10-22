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

export const ContextCompileCatalogHintsV1 = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  catalogSource: ModelsDevCatalogSourceV1,
  catalogFreshness: ModelsDevCatalogFreshnessV1,
  contextLimitTokens: Schema.optional(Schema.Int),
  outputLimitTokens: Schema.optional(Schema.Int),
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
  anchorArtifactRef: Schema.optional(Schema.String),
  anchorProjection: Schema.optional(Schema.Literals(["full", "compressed"])),
})

export type ContextCompilePolicyV1 = typeof ContextCompilePolicyV1.Type
