import { createMemo, createSignal, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { HorizonCodingProfile } from "@horizoncode/core/config/coding-profile"
import type { CapabilityChipsV1, CapabilityDescriptorV1, CapabilityTier } from "@horizoncode/core/config/coding-profile"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogEditorSettings } from "../../component/dialog-editor-settings"
import { DialogRepoIntelligenceSettings } from "../../component/dialog-repo-intelligence"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"

// ---------------------------------------------------------------------------
// Horizon Coding Profile capability chips (DEC-V1-37 / DEC-V1-38 exposure).
//
// This surface is a pure, read-only projection of
// `HorizonCodingProfile.projectCapabilityChips` (P6 signature, §3 of
// reports/phases/P6.md). It stores no preference, issues no config write and
// grants no authority: Guard, the selected provider/model, paid-call approval
// and the canonical capability registry remain the only authorities
// (§16.15, §17.9 A-V2-29, §33.28).
// ---------------------------------------------------------------------------

/** §16.15 release/stability class — an axis independent of implementation status. */
export type CapabilityChipStabilityV1 = "stable" | "beta" | "experimental"
export type CapabilityChipAvailabilityV1 = "available" | "unavailable" | "unknown"
export type CapabilityExposureSourceV1 = "default" | "user" | "project" | "session" | "system_policy" | "unknown"
export type CapabilityPolicyLockV1 = "locked" | "unlocked" | "unknown"

/**
 * Presentation-only release-class tag per exposure tier (§16.15 axis (b)
 * `stable | beta | experimental`). Release class never claims implementation
 * completion or authorization (§33.28): the default-ON Core tier is stable,
 * the build-profile Extended tier is tagged beta because it aggregates the
 * newer integrations documented as available only "when wired" (§33.32), and
 * Experimental is the exact opt-in class. Promotion/rollback of these tags
 * follows §16.15; changing them here changes no runtime behavior.
 */
export const capabilityTierStabilityV1: Readonly<Record<CapabilityTier, CapabilityChipStabilityV1>> = Object.freeze({
  core: "stable",
  extended: "beta",
  experimental: "experimental",
})

const TIER_ORDER: readonly CapabilityTier[] = ["core", "extended", "experimental"]
/** Bounded display; the full projection stays available in `unavailableCapabilities`. */
const MAX_UNAVAILABLE_ROWS = 12

export interface CapabilityChipRowV1 {
  readonly id: string
  readonly label: string
  readonly stability: CapabilityChipStabilityV1 | "n/a"
  readonly requested: "on" | "off" | "n/a"
  readonly effective: "on" | "off" | "unknown" | "n/a"
  readonly availability: CapabilityChipAvailabilityV1
  readonly detail?: string
  readonly reason?: string
}

export interface CapabilityChipsViewInputV1 {
  /** Explicit exposure request; omitted means the Coding profile default tiers. */
  readonly requestedTiers?: readonly CapabilityTier[]
  /**
   * Trusted runtime capability descriptors. Undefined means no descriptor
   * source exists yet: every count derived from it renders as unknown rather
   * than a fabricated zero (§16.17 "absent sampler does not show zero").
   */
  readonly available?: readonly CapabilityDescriptorV1[]
  /** Undefined means the skill catalog was not loaded; never rendered as 0. */
  readonly skillCatalogSize?: number
  readonly platform?: "linux" | "windows" | "darwin"
  /** Declared provenance of the exposure request (§16.8 source semantics). */
  readonly source: CapabilityExposureSourceV1
  readonly policyLock: CapabilityPolicyLockV1
  /** Declared precedence; unknown must be displayed as unknown, never invented. */
  readonly precedence: string
}

export interface CapabilityChipsViewV1 {
  readonly chips: CapabilityChipsV1
  readonly requested: readonly CapabilityTier[]
  readonly effective: readonly CapabilityTier[]
  readonly source: CapabilityExposureSourceV1
  readonly policyLock: CapabilityPolicyLockV1
  readonly precedence: string
  readonly descriptorSourcePresent: boolean
  readonly skillCatalogPresent: boolean
  readonly tiers: readonly CapabilityChipRowV1[]
  readonly tools: CapabilityChipRowV1
  readonly skills: CapabilityChipRowV1
  readonly unavailableCapabilities: readonly CapabilityChipRowV1[]
  readonly headerLines: readonly string[]
  readonly lines: readonly string[]
}

/**
 * Why a descriptor is not effective. Ordering deliberately surfaces the
 * strongest truth first: a design-only or code-present capability is reported
 * as not wired (and not enableable from Settings) before any tier/platform
 * reason, so a chip can never imply `designed`/`code_present` work is running.
 */
function unavailableReasonV1(
  descriptor: CapabilityDescriptorV1,
  effectiveTiers: ReadonlySet<CapabilityTier>,
  platform: "linux" | "windows" | "darwin",
): string | undefined {
  const tier = HorizonCodingProfile.classifyCapability(descriptor.id)
  if (tier === undefined) return "unclassified — outside the Coding profile tiers"
  if (descriptor.implementationStatus === "designed") {
    return "design-only — not wired and cannot be enabled from Settings"
  }
  if (descriptor.implementationStatus === "code_present") {
    return "code present but not wired — cannot be enabled from Settings"
  }
  if (!effectiveTiers.has(tier)) {
    return tier === "experimental"
      ? "no experimental opt-in in this build"
      : `tier ${tier} is not requested`
  }
  if (descriptor.supportedPlatforms !== undefined && !descriptor.supportedPlatforms.includes(platform)) {
    return `unsupported on ${platform}`
  }
  if (descriptor.disabledReason !== undefined) return descriptor.disabledReason
  return undefined
}

function rowLineV1(row: CapabilityChipRowV1): string {
  const parts: string[] = [row.stability === "n/a" ? row.label : `${row.label} [${row.stability}]`]
  if (row.requested !== "n/a") parts.push(`requested ${row.requested.toUpperCase()}`)
  if (row.effective !== "n/a") parts.push(`effective ${row.effective.toUpperCase()}`)
  if (row.detail !== undefined) parts.push(row.detail)
  parts.push(
    row.availability === "available"
      ? "available"
      : `${row.availability}${row.reason !== undefined ? ` (${row.reason})` : ""}`,
  )
  return parts.join(" · ")
}

/**
 * Compose a read-only Settings view over the P6 chip projection.
 *
 * Pure by construction: the input is never mutated and the returned value
 * contains data only — no callbacks, no update entry point, no capability or
 * config authority. When no descriptor/skill source is supplied the view still
 * reports requested/effective/source/lock/precedence and the tier chips, while
 * the missing counts stay explicitly unknown.
 */
export function projectCapabilityChipsViewV1(input: CapabilityChipsViewInputV1): CapabilityChipsViewV1 {
  const requested = input.requestedTiers ?? HorizonCodingProfile.defaultExposureTiers
  const platform = input.platform ?? "linux"
  const descriptorSourcePresent = input.available !== undefined
  const skillCatalogPresent = input.skillCatalogSize !== undefined
  const available = input.available ?? []
  const skillCatalogSize = input.skillCatalogSize ?? 0

  // One projection, one truth: counts and effective tiers come from the P6
  // owner. With no descriptor source the catalog argument is empty, and every
  // count derived from it is rendered as unknown below — an absent source is
  // never displayed as zero.
  const chips = HorizonCodingProfile.projectCapabilityChips({
    requestedTiers: requested,
    available,
    skillCatalogSize,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
  })

  const requestedSet = new Set<CapabilityTier>(requested)
  const effectiveSet = new Set<CapabilityTier>(chips.tiers)

  const tiers: CapabilityChipRowV1[] = TIER_ORDER.map((tier) => {
    // Core is unconditionally enabled by the profile (§33.32).
    const isRequested = tier === "core" || requestedSet.has(tier)
    const isEffective = effectiveSet.has(tier)
    const reason = isEffective
      ? undefined
      : tier === "experimental"
        ? "no experimental opt-in in this build"
        : "tier not requested"
    return {
      id: `tier.${tier}`,
      label: `Tier ${tier}`,
      stability: capabilityTierStabilityV1[tier],
      requested: isRequested ? "on" : "off",
      effective: isEffective ? "on" : "off",
      availability: isEffective ? "available" : "unavailable",
      ...(reason !== undefined ? { reason } : {}),
    }
  })

  const tools: CapabilityChipRowV1 = descriptorSourcePresent
    ? {
        id: "tools",
        label: "Tools",
        stability: "n/a",
        requested: "n/a",
        effective: "n/a",
        availability: chips.tools.effective > 0 ? "available" : "unavailable",
        detail: `effective ${chips.tools.effective} / catalog ${chips.tools.catalog}`,
        ...(chips.tools.disabledReason !== undefined ? { reason: chips.tools.disabledReason } : {}),
      }
    : {
        id: "tools",
        label: "Tools",
        stability: "n/a",
        requested: "n/a",
        effective: "unknown",
        availability: "unknown",
        detail: "effective unknown / catalog unknown",
        reason: "no runtime capability projection from Core Config",
      }

  const skills: CapabilityChipRowV1 = skillCatalogPresent
    ? {
        id: "skills",
        label: "Skills",
        stability: "n/a",
        requested: "n/a",
        effective: "n/a",
        availability: "available",
        detail: `listed ${chips.skills.listed}`,
      }
    : {
        id: "skills",
        label: "Skills",
        stability: "n/a",
        requested: "n/a",
        effective: "unknown",
        availability: "unknown",
        detail: "listed unknown",
        reason: "skill catalog not loaded",
      }

  const exposed = new Set(
    HorizonCodingProfile.exposeCapabilityIDsV1({
      requestedTiers: requested,
      available,
      skillCatalogSize,
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
    }),
  )
  const unavailableCapabilities: CapabilityChipRowV1[] = []
  for (const descriptor of available) {
    if (exposed.has(descriptor.id)) continue
    const tier = HorizonCodingProfile.classifyCapability(descriptor.id)
    const reason = unavailableReasonV1(descriptor, effectiveSet, platform)
    unavailableCapabilities.push({
      id: `capability.${descriptor.id}`,
      label: `Capability ${descriptor.id}`,
      stability: tier === undefined ? "n/a" : capabilityTierStabilityV1[tier],
      requested: "n/a",
      effective: "off",
      availability: "unavailable",
      detail: descriptor.implementationStatus,
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  const headerLines = [
    `Requested: ${requested.length > 0 ? requested.join(", ") : "none"} · Effective: ${chips.tiers.length > 0 ? chips.tiers.join(", ") : "none"}`,
    `Source: ${input.source} · Policy lock: ${input.policyLock}`,
    `Precedence: ${input.precedence}`,
  ]

  const shownUnavailable = unavailableCapabilities.slice(0, MAX_UNAVAILABLE_ROWS)
  const overflow = unavailableCapabilities.length - shownUnavailable.length
  const lines = [
    ...headerLines,
    ...tiers.map(rowLineV1),
    rowLineV1(tools),
    rowLineV1(skills),
    ...shownUnavailable.map(rowLineV1),
    ...(overflow > 0 ? [`… ${overflow} more unavailable capabilities not shown`] : []),
    "Read-only projection: no entry here changes Guard, the selected provider/model, paid-call approval, or capability authority.",
  ]

  return {
    chips,
    requested,
    effective: chips.tiers,
    source: input.source,
    policyLock: input.policyLock,
    precedence: input.precedence,
    descriptorSourcePresent,
    skillCatalogPresent,
    tiers,
    tools,
    skills,
    unavailableCapabilities,
    headerLines,
    lines,
  }
}

/** Settings surfaces available from the session-level `/settings` command. */
export function DialogSessionSettings(props: { readonly sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  // undefined = not loaded yet or load failed; both render as unknown, never 0.
  const [skillCatalogSize, setSkillCatalogSize] = createSignal<number>()

  onMount(() => {
    void sdk.client.app
      .skills({}, { throwOnError: true })
      .then((result) => setSkillCatalogSize((result.data ?? []).length))
      .catch(() => setSkillCatalogSize(undefined))
  })

  const view = createMemo(() =>
    projectCapabilityChipsViewV1({
      // Declared facts of this build: the exposure request is the builtin
      // Horizon Coding Profile default with no user/project tier setting, so
      // there is no config override that could lock or precede it. There is no
      // trusted runtime CapabilityDescriptorV1 source yet, so tool counts stay
      // unknown instead of being invented from a design-time inventory.
      source: "default",
      policyLock: "unlocked",
      precedence: "Coding profile default (no user/project tier setting)",
      skillCatalogSize: skillCatalogSize(),
    }),
  )

  return (
    <DialogSelect
      title="Settings"
      flat
      options={[
        {
          title: "Editors",
          value: "editors",
          category: "Session",
          description: "Choose a user-owned editor profile for explicit /editor actions.",
          onSelect: () => dialog.replace(() => <DialogEditorSettings sessionID={props.sessionID} />),
        },
        {
          title: "RepoIntel",
          value: "repo-intelligence",
          category: "Workspace",
          description: "Choose the requested local repository analysis profile.",
          onSelect: () => dialog.replace(() => <DialogRepoIntelligenceSettings />),
        },
      ]}
      titleView={
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Settings
          </text>
          <text fg={theme.text}>Capability exposure · Horizon Coding Profile (read-only)</text>
          <text fg={theme.textMuted} wrapMode="word">
            {view().headerLines[0]}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {view().headerLines[1]}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {view().headerLines[2]}
          </text>
          {view().lines.slice(3, -1).map((line) => (
            <text fg={line.includes("unavailable") || line.includes("unknown") ? theme.warning : theme.textMuted} wrapMode="word">
              {line}
            </text>
          ))}
          <text fg={theme.warning} wrapMode="word">
            {view().lines[view().lines.length - 1]}
          </text>
        </box>
      }
    />
  )
}
