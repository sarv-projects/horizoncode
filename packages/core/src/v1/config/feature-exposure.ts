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
    blockedReason?: string
    pendingApplyAt?: "next_turn" | "next_session" | "restart"
  }
}

export interface SourceConfig {
  compaction?: {
    auto?: boolean
    prune?: boolean
  }
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

export function list(config: SourceConfig): Feature[] {
  const supported: Feature[] = compactionOptions.map((option) => {
    const requested = config.compaction?.[option.key] ?? null
    const enabled = requested ?? option.defaultEnabled
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
      supportedScopes: ["user", "project"],
      applyBoundary: "next_session",
      capabilityIds: [],
      state: {
        implementationStatus: "wired",
        requestedEnabled: requested,
        effectiveEnabled: enabled,
        effectiveState: enabled ? "on" : "off",
        // Merged ConfigV1 does not expose the winning file or policy source.
        // Never invent "user" or "project" from a merged value.
        valueSource: requested === null ? "default" : "unknown",
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
        costNotes: "Costs and resource impact have not been measured.",
        state: {
          implementationStatus: "designed",
          requestedEnabled: null,
          effectiveEnabled: false,
          effectiveState: "unavailable",
          valueSource: "default",
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
  return { compaction: { ...config.compaction, [option.key]: enabled } }
}
