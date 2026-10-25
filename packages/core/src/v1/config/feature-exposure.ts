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
const FeatureRef = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))
const PrerequisiteRef = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128))

export type CatalogIssue =
  | { code: "duplicate_feature_id"; featureId: FeatureId }
  | { code: "duplicate_setting_key"; featureId: FeatureId; settingKey: string }
  | { code: "duplicate_capability_ref"; featureId: FeatureId; capabilityId: string }
  | { code: "duplicate_prerequisite"; featureId: FeatureId; prerequisite: string }
  | { code: "duplicate_supported_target"; featureId: FeatureId; target: string }
  | { code: "unknown_capability"; featureId: FeatureId; capabilityId: string }
  | { code: "unwired_feature_enabled"; featureId: FeatureId }
  | { code: "inconsistent_effect_state"; featureId: FeatureId }
  | { code: "missing_blocked_reason"; featureId: FeatureId }
  | { code: "missing_pending_apply_at"; featureId: FeatureId }
  | { code: "default_enabled_experiment"; featureId: FeatureId }
  | { code: "default_enabled_developer_feature"; featureId: FeatureId }

export interface Feature {
  schemaVersion: 1
  featureId: FeatureId
  settingKey: string
  /** Existing owner that persists requested state and owns effective resolution. */
  owner: { config: string; runtime: string }
  title: string
  description: string
  releaseClass: ReleaseClass
  optional: true
  audience: "public" | "developer"
  defaultEnabled: boolean
  supportedScopes: ReadonlyArray<"user" | "project" | "session">
  /** Runtime prerequisites are descriptive gates; they never grant authority. */
  prerequisites: readonly string[]
  /** Empty model/harness lists mean there is no additional restriction. */
  supportedPlatforms: ReadonlyArray<"linux" | "windows" | "darwin">
  supportedModelRefs: readonly string[]
  supportedHarnessRefs: readonly string[]
  applyBoundary: "live" | "next_turn" | "next_session" | "restart"
  capabilityIds: readonly string[]
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

/** Field bounds mirrored from `arch_V1/contracts-v2/feature-exposure-v1.schema.json`. */
const DescriptorText = Schema.String.check(Schema.isNonEmpty())
const OwnerRef = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128))
const CapabilityRef = Schema.String.check(Schema.isNonEmpty())

export const FeatureSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  featureId: Schema.Literals(["compaction.auto", "compaction.prune", "native_search", "hashline_edit", "cow_worktrees"]),
  settingKey: FeatureRef,
  owner: Schema.Struct({ config: OwnerRef, runtime: OwnerRef }),
  title: DescriptorText,
  description: DescriptorText,
  releaseClass: Schema.Literals(["stable", "beta", "experimental"]),
  optional: Schema.Literal(true),
  audience: Schema.Literals(["public", "developer"]),
  defaultEnabled: Schema.Boolean,
  supportedScopes: Schema.Array(Schema.Literals(["user", "project", "session"])).check(Schema.isMinLength(1)),
  prerequisites: Schema.Array(PrerequisiteRef),
  supportedPlatforms: Schema.Array(Schema.Literals(["linux", "windows", "darwin"])).check(Schema.isMinLength(1)),
  supportedModelRefs: Schema.Array(FeatureRef),
  supportedHarnessRefs: Schema.Array(FeatureRef),
  applyBoundary: Schema.Literals(["live", "next_turn", "next_session", "restart"]),
  capabilityIds: Schema.Array(CapabilityRef),
  riskNotes: Schema.optional(DescriptorText),
  costNotes: Schema.optional(DescriptorText),
  state: Schema.Struct({
    implementationStatus: Schema.Literals(["designed", "code_present", "wired", "tested", "verified", "released"]),
    requestedEnabled: Schema.Union([Schema.Boolean, Schema.Null]),
    effectiveEnabled: Schema.Boolean,
    effectiveState: Schema.Literals(["on", "off", "blocked", "pending_apply", "unavailable"]),
    valueSource: Schema.Literals(["default", "user", "project", "session", "system_policy", "unknown"]),
    policyLock: Schema.Literals(["locked", "unlocked", "unknown"]),
    blockedReason: Schema.optional(DescriptorText),
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

    const duplicate = (values: readonly string[]) => values.find((value, index) => values.indexOf(value) !== index)
    const duplicatePrerequisite = duplicate(feature.prerequisites)
    if (duplicatePrerequisite) issues.push({ code: "duplicate_prerequisite", featureId: feature.featureId, prerequisite: duplicatePrerequisite })
    for (const values of [feature.supportedScopes, feature.supportedPlatforms, feature.supportedModelRefs, feature.supportedHarnessRefs]) {
      const repeated = duplicate(values)
      if (repeated) issues.push({ code: "duplicate_supported_target", featureId: feature.featureId, target: repeated })
    }

    if (
      feature.state.effectiveEnabled &&
      (feature.state.implementationStatus === "designed" || feature.state.implementationStatus === "code_present")
    ) {
      issues.push({ code: "unwired_feature_enabled", featureId: feature.featureId })
    }
    // Conditional rules from the canonical contract's `state.allOf`: the
    // effective flag and the projected state must never contradict each
    // other, a blocked/unavailable state always carries its concrete reason,
    // and a pending apply always names the boundary it waits for.
    const { effectiveEnabled, effectiveState, blockedReason, pendingApplyAt } = feature.state
    const contradictory =
      effectiveState === "on" ? !effectiveEnabled : effectiveState === "pending_apply" ? false : effectiveEnabled
    if (contradictory) issues.push({ code: "inconsistent_effect_state", featureId: feature.featureId })
    if (
      (effectiveState === "blocked" || effectiveState === "unavailable") &&
      (blockedReason === undefined || blockedReason.length === 0)
    ) {
      issues.push({ code: "missing_blocked_reason", featureId: feature.featureId })
    }
    if (effectiveState === "pending_apply" && pendingApplyAt === undefined) {
      issues.push({ code: "missing_pending_apply_at", featureId: feature.featureId })
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
export function decodeCatalog(input: unknown, canonicalCapabilityIds: ReadonlySet<string>): readonly Feature[] {
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

export type CapabilityStatus = {
  readonly effective: boolean
  readonly reason?: string
}

/**
 * Tie a feature's effective state to the canonical capability owner's live
 * status. A requested-but-missing capability is BLOCKED; a feature that is
 * merely unavailable stays UNAVAILABLE. This projection never enables a
 * capability and never grants authority.
 */
export function applyCapabilityStatus(
  features: readonly Feature[],
  statuses: ReadonlyMap<string, CapabilityStatus>,
): Feature[] {
  return features.map((feature) => {
    if (!feature.state.effectiveEnabled || feature.capabilityIds.length === 0) return feature
    const missing = feature.capabilityIds.find((capabilityId) => statuses.get(capabilityId)?.effective !== true)
    if (missing === undefined) return feature
    const reason = statuses.get(missing)?.reason ?? `${missing} is not effective`
    const { pendingApplyAt: _pending, ...state } = feature.state
    return {
      ...feature,
      state: {
        ...state,
        effectiveEnabled: false,
        effectiveState: feature.state.requestedEnabled === true ? "blocked" : "unavailable",
        blockedReason: reason,
      },
    }
  })
}

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
    // A pending apply is only authoritative when the winning policy state is
    // known to permit it. Unknown lock state must not be projected as an
    // accepted deferred write.
    const pending = origin?.policyLock === "unlocked" && origin.pendingApplyAt && requested !== null && requested !== enabled
    const blocked = wanted !== enabled && !pending
    return {
      schemaVersion: 1,
      featureId: option.id,
      settingKey: `compaction.${option.key}`,
      owner: { config: "HorizonCode Config", runtime: "Session Compaction" },
      title: option.title,
      description: option.description,
      releaseClass: "stable",
      optional: true,
      audience: "public",
      defaultEnabled: option.defaultEnabled,
      supportedScopes: ["project"],
      prerequisites: option.key === "auto" ? ["session.state", "selected.provider.model"] : ["session.state", "eligible.tool_output"],
      supportedPlatforms: ["linux"],
      supportedModelRefs: [],
      supportedHarnessRefs: [],
      applyBoundary: "next_turn",
      capabilityIds: [],
      riskNotes: option.key === "auto"
        ? "May summarize active prompt context using the selected model; canonical Session history remains unchanged."
        : "Removes eligible older tool output from active model context; canonical Session history remains unchanged.",
      costNotes: option.key === "auto"
        ? "May use the selected provider/model and its published or unknown price; never changes routes."
        : "No separate provider request; reduces context supplied to a later selected-model request.",
      state: {
        implementationStatus: "wired",
        requestedEnabled: requested,
        effectiveEnabled: enabled,
        effectiveState: pending ? "pending_apply" : blocked ? "blocked" : enabled ? "on" : "off",
        // Merged ConfigV1 does not expose the winning file or policy source.
        // Never invent "user" or "project" from a merged value.
        valueSource: requested === null ? "default" : (origin?.valueSource ?? "unknown"),
        // An absent requested value is the known built-in default, with no
        // user/project/system override to lock. An explicit value without a
        // captured winning source remains unknown and must not be presented as
        // safely mutable.
        policyLock: origin?.policyLock ?? (requested === null ? "unlocked" : "unknown"),
        ...((blocked || origin?.blockedReason) ? {
          blockedReason: origin?.blockedReason ?? (origin?.policyLock === "locked"
            ? "Effective state is constrained by policy"
            : (origin === undefined || origin.policyLock === "unknown") && requested !== null
              ? "Effective state differs from the request; policy status is unknown"
              : wanted && !enabled
                ? "A runtime disable override is active"
                : "Effective state differs from the requested setting"),
        } : {}),
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
        owner: {
          config: "HorizonCode Config",
          runtime: option.id === "native_search"
            ? "HostKernel RepoIntel"
            : option.id === "hashline_edit"
              ? "Guarded Files Patch"
              : "Leased Workspace",
        },
        title: option.title,
        description: option.description,
        releaseClass: "experimental",
        optional: true,
        audience: "public",
        defaultEnabled: false,
        supportedScopes: ["user", "project"],
        prerequisites: option.id === "native_search"
          ? ["hostkernel.guard", "repo_intel.authenticated_query"]
          : option.id === "hashline_edit"
            ? ["files.patch", "workspace.revision_guard"]
            : ["workspace.lease", "hostkernel.guard"],
        supportedPlatforms: ["linux"],
        supportedModelRefs: [],
        supportedHarnessRefs: [],
        applyBoundary: "next_session",
        capabilityIds: [],
        riskNotes: "Experimental: not enabled in this build.",
        costNotes: "No effect while unavailable. Any future provider or workspace cost requires its existing explicit approval path.",
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
