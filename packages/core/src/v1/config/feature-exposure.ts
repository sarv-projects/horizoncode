import { Schema } from "effect"

export * as FeatureExposure from "./feature-exposure"

/**
 * Derived Settings metadata over the existing authoritative ConfigV1 document.
 * This module owns no preference store, tool registry, permission grant or effects.
 * The runtime's resolved config is the input; callers must not use a UI-local
 * checkbox as authorization for a backend capability.
 */
export type ReleaseClass = "stable" | "beta" | "experimental"
export type ImplementationStatus = "designed" | "code_present" | "wired" | "tested" | "verified" | "released"
export type EffectiveState = "on" | "off" | "blocked" | "pending_apply" | "unavailable"
export type FeatureId = "compaction.auto" | "compaction.prune" | "native_search" | "hashline_edit" | "cow_worktrees"

export type CatalogIssue =
  | { code: "duplicate_feature_id"; featureId: FeatureId }
  | { code: "duplicate_setting_key"; featureId: FeatureId; settingKey: string }
  | { code: "duplicate_capability_ref"; featureId: FeatureId; capabilityId: string }
  | { code: "unknown_capability"; featureId: FeatureId; capabilityId: string }
  | { code: "unwired_feature_enabled"; featureId: FeatureId }
  | { code: "default_enabled_experiment"; featureId: FeatureId }
  | { code: "default_enabled_developer_feature"; featureId: FeatureId }

export interface Feature {
  schemaVersion: 1
  featureId: FeatureId
  settingKey: string
  title: string
  description: string
  releaseClass: ReleaseClass
  optional: true
  audience: "public" | "developer"
  defaultEnabled: boolean
  supportedScopes: Array<"user" | "project" | "session">
  applyBoundary: "live" | "next_turn" | "next_session" | "restart"
  capabilityIds: string[]
  riskNotes?: string
  costNotes?: string
  state: {
    implementationStatus: ImplementationStatus
    requestedEnabled: boolean | null
    effectiveEnabled: boolean
    effectiveState: EffectiveState
    valueSource: "default" | "user" | "project" | "session" | "system_policy" | "unknown"
    policyLock: "locked" | "unlocked" | "unknown"
    blockedReason?: string
    pendingApplyAt?: "next_turn" | "next_session" | "restart"
  }
}
export const FeatureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  featureId: Schema.Literals(["compaction.auto", "compaction.prune", "native_search", "hashline_edit", "cow_worktrees"]),
  settingKey: Schema.String,
  title: Schema.String,
  description: Schema.String,
  releaseClass: Schema.Literals(["stable", "beta", "experimental"]),
  optional: Schema.Literal(true),
  audience: Schema.Literals(["public", "developer"]),
  defaultEnabled: Schema.Boolean,
  supportedScopes: Schema.Array(Schema.Literals(["user", "project", "session"])),
  applyBoundary: Schema.Literals(["live", "next_turn", "next_session", "restart"]),
  capabilityIds: Schema.Array(Schema.String),
  riskNotes: Schema.optional(Schema.String),
  costNotes: Schema.optional(Schema.String),
  state: Schema.Struct({
    implementationStatus: Schema.Literals(["designed", "code_present", "wired", "tested", "verified", "released"]),
    requestedEnabled: Schema.Union([Schema.Boolean, Schema.Null]),
    effectiveEnabled: Schema.Boolean,
    effectiveState: Schema.Literals(["on", "off", "blocked", "pending_apply", "unavailable"]),
    valueSource: Schema.Literals(["default", "user", "project", "session", "system_policy", "unknown"]),
    policyLock: Schema.Literals(["locked", "unlocked", "unknown"]),
    blockedReason: Schema.optional(Schema.String),
    pendingApplyAt: Schema.optional(Schema.Literals(["next_turn", "next_session", "restart"])),
  }),
}).annotate({ identifier: "FeatureExposure" })

export const FeatureListSchema = Schema.Array(FeatureSchema).annotate({ identifier: "FeatureExposureList" })

/**
 * Validate derived feature descriptors at the runtime boundary. The capability
 * set is provided by the canonical registry; this projection cannot create or
 * alias an authority. Keep this pure so CLI/API/TUI consumers can share it.
 */
export function validateCatalog(features: readonly Feature[], canonicalCapabilityIds: ReadonlySet<string>): CatalogIssue[] {
  const issues: CatalogIssue[] = []
  const seenFeatures = new Set<FeatureId>()
  const seenSettings = new Set<string>()
  for (const feature of features) {
    if (seenFeatures.has(feature.featureId)) issues.push({ code: "duplicate_feature_id", featureId: feature.featureId })
    seenFeatures.add(feature.featureId)
    if (seenSettings.has(feature.settingKey)) {
      issues.push({ code: "duplicate_setting_key", featureId: feature.featureId, settingKey: feature.settingKey })
    }
    seenSettings.add(feature.settingKey)

    const seenCapabilities = new Set<string>()
    for (const capabilityId of feature.capabilityIds) {
      if (seenCapabilities.has(capabilityId)) {
        issues.push({ code: "duplicate_capability_ref", featureId: feature.featureId, capabilityId })
      }
      seenCapabilities.add(capabilityId)
      if (!canonicalCapabilityIds.has(capabilityId)) {
        issues.push({ code: "unknown_capability", featureId: feature.featureId, capabilityId })
      }
    }

    if (
      feature.state.effectiveEnabled &&
      (feature.state.implementationStatus === "designed" || feature.state.implementationStatus === "code_present")
    ) {
      issues.push({ code: "unwired_feature_enabled", featureId: feature.featureId })
    }
    if (feature.releaseClass === "experimental" && feature.defaultEnabled) {
      issues.push({ code: "default_enabled_experiment", featureId: feature.featureId })
    }
    if (feature.audience === "developer" && feature.defaultEnabled) {
      issues.push({ code: "default_enabled_developer_feature", featureId: feature.featureId })
    }
  }
  return issues
}

/** Decode the wire shape and enforce cross-entry/catalog rules in one call. */
export function decodeCatalog(input: unknown, canonicalCapabilityIds: ReadonlySet<string>): Feature[] {
  const features = Schema.decodeUnknownSync(FeatureListSchema)(input, { onExcessProperty: "error" })
  const issues = validateCatalog(features, canonicalCapabilityIds)
  if (issues.length > 0) throw new Error(`FeatureExposure catalog is invalid: ${issues.map((issue) => issue.code).join(", ")}`)
  return features
}

export const UpdateSchema = Schema.Struct({
  featureId: Schema.Literals(["compaction.auto", "compaction.prune"]),
  expectedEnabled: Schema.Union([Schema.Boolean, Schema.Null]),
  enabled: Schema.Boolean,
}).annotate({ identifier: "FeatureExposureUpdate" })

export type Update = Schema.Schema.Type<typeof UpdateSchema>

export interface SourceConfig {
  compaction?: {
    auto?: boolean
    prune?: boolean
  }
  /** Winning source and policy state captured while the layered config is merged. */
  origins?: Partial<Record<"auto" | "prune", {
    valueSource: "user" | "project" | "system_policy" | "unknown"
    policyLock?: "locked" | "unlocked" | "unknown"
    blockedReason?: string
    pendingApplyAt?: "next_turn" | "next_session" | "restart"
  }>>
}

type StableSetting = "auto" | "prune"
type StableOption = {
  id: FeatureId
  key: StableSetting
  title: string
  description: string
  defaultEnabled: boolean
}

// Only known, wired options are actionable here. Add an option only after
// its executing backend and the config read/write route have been tested.
const compactionOptions: readonly StableOption[] = [
  {
    id: "compaction.auto",
    key: "auto",
    title: "Automatic context compaction",
    description: "Automatically compact conversation context when needed.",
    defaultEnabled: true,
  },
  {
    id: "compaction.prune",
    key: "prune",
    title: "Prune older tool outputs",
    description: "Remove eligible old tool results from active model context.",
    defaultEnabled: false,
  },
]

type PlannedOption = {
  id: FeatureId
  title: string
  description: string
}
const experiments: readonly PlannedOption[] = [
  {
    id: "native_search",
    title: "Native repository search",
    description: "Audited in-process lexical and Git query backend.",
  },
  {
    id: "hashline_edit",
    title: "Hashline edit dialect",
    description: "Source-revision-safe content-anchored edit syntax.",
  },
  {
    id: "cow_worktrees",
    title: "Copy-on-write worktrees",
    description: "Optional accelerated leased worktree provisioning.",
  },
]

export function list(config: SourceConfig, effective: SourceConfig = config): Feature[] {
  const supported: Feature[] = compactionOptions.map((option) => {
    const requested = config.compaction?.[option.key] ?? null
    const wanted = requested ?? option.defaultEnabled
    const enabled = effective.compaction?.[option.key] ?? option.defaultEnabled
    const origin = config.origins?.[option.key]
    const pending = origin?.policyLock !== "locked" && origin?.pendingApplyAt && requested !== null && requested !== enabled
    const blocked = wanted && !enabled && (origin?.policyLock === "locked" || !pending)
    return {
      schemaVersion: 1,
      featureId: option.id,
      settingKey: `compaction.${option.key}`,
      title: option.title,
      description: option.description,
      releaseClass: "stable",
      optional: true,
      audience: "public",
      defaultEnabled: option.defaultEnabled,
      supportedScopes: ["project"],
      applyBoundary: "next_turn",
      capabilityIds: [],
      state: {
        implementationStatus: "wired",
        requestedEnabled: requested,
        effectiveEnabled: enabled,
        effectiveState: pending ? "pending_apply" : blocked ? "blocked" : enabled ? "on" : "off",
        // Merged ConfigV1 does not expose the winning file or policy source.
        // Never invent "user" or "project" from a merged value.
        valueSource: requested === null ? "default" : (origin?.valueSource ?? "unknown"),
        policyLock: origin?.policyLock ?? "unknown",
        ...((blocked || origin?.blockedReason) ? { blockedReason: origin?.blockedReason ?? "A runtime disable override is active" } : {}),
        ...(pending ? { pendingApplyAt: origin.pendingApplyAt } : {}),
      },
    }
  })
  return [
    ...supported,
    ...experiments.map(
      (option): Feature => ({
        schemaVersion: 1,
        featureId: option.id,
        settingKey: `horizon.experimental.${option.id}`,
        title: option.title,
        description: option.description,
        releaseClass: "experimental",
        optional: true,
        audience: "public",
        defaultEnabled: false,
        supportedScopes: ["user", "project"],
        applyBoundary: "next_session",
        capabilityIds: [],
        riskNotes: "Experimental: not enabled in this build.",
        state: {
          implementationStatus: "designed",
          requestedEnabled: null,
          effectiveEnabled: false,
          effectiveState: "unavailable",
          valueSource: "default",
          policyLock: "unknown",
          blockedReason: "Not implemented or release-verified",
        },
      }),
    ),
  ]
}

/**
 * Only a known, already-wired configuration option may be toggled.
 * Proposed experimental backends have no write route and cannot be turned on.
 */
export function updateCompaction(config: SourceConfig, featureId: FeatureId, enabled: boolean): SourceConfig | undefined {
  const option = compactionOptions.find((candidate) => candidate.id === featureId)
  if (!option) return undefined
  return { compaction: { [option.key]: enabled } }
}
