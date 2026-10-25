/**
 * Horizon Coding Profile (DEC-V1-37) and tool/skill exposure tiers (DEC-V1-38).
 *
 * This is a pure composition/projection owner. It stores no preference, starts
 * no effect, and grants no authority: the selected Config, AgentProfileV2 and
 * canonical capability registry remain authoritative. Guard and HostKernel
 * still evaluate every effect and lease.
 */

import { Schema } from "effect"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"

export * as HorizonCodingProfile from "./coding-profile"

export type CapabilityTier = "core" | "extended" | "experimental"
export type CapabilityImplementationStatus =
  | "designed"
  | "code_present"
  | "wired"
  | "tested"
  | "verified"
  | "released"

export interface CapabilityDescriptorV1 {
  readonly id: string
  readonly implementationStatus: CapabilityImplementationStatus
  readonly supportedPlatforms?: readonly ("linux" | "windows" | "darwin")[]
  readonly disabledReason?: string
}

/** Canonical capability IDs that the Coding profile exposes through the Core tier. */
const CORE_CAPABILITIES = [
  "files.patch",
  "files.read",
  "files.write",
  "git.branch.list",
  "git.diff",
  "git.log",
  "git.show",
  "git.status",
  "glob.search",
  "question.ask",
  "skill",
  "skills.search",
  "task",
  "terminal.output_range",
  "terminal.run",
  "text.search",
  "tools.search",
  "web.search",
] as const

/** Canonical capability IDs that require the explicitly enabled Extended tier. */
const EXTENDED_CAPABILITIES = [
  "codemode.execute",
  "debug.start",
  "definitions.find",
  "history.read_range",
  "history.search",
  "references.find",
  "repo.detect",
  "repo.tree",
  "symbols.search",
  "web.search.inspect_provider",
] as const

/** Designed/post-V1 families are never executable merely because they are named. */
const EXPERIMENTAL_PREFIXES = ["browser.", "desktop.", "embeddings."] as const

const CORE = new Set<string>(CORE_CAPABILITIES)
const EXTENDED = new Set<string>(EXTENDED_CAPABILITIES)

export const defaultExposureTiers: readonly CapabilityTier[] = ["core", "extended"]

export function classifyCapability(id: string): CapabilityTier | undefined {
  if (CORE.has(id)) return "core"
  if (EXTENDED.has(id)) return "extended"
  if (EXPERIMENTAL_PREFIXES.some((prefix) => id.startsWith(prefix))) return "experimental"
  return undefined
}

export interface CapabilityExposureInputV1 {
  /** Requested tiers. Core is always enabled; Experimental is never implicit. */
  readonly requestedTiers?: readonly CapabilityTier[]
  readonly available: readonly CapabilityDescriptorV1[]
  /** Every built-in and project skill metadata entry stays catalog-visible. */
  readonly skillCatalogSize: number
  readonly platform?: "linux" | "windows" | "darwin"
}

export interface CapabilityChipsV1 {
  readonly tiers: readonly CapabilityTier[]
  readonly tools: {
    readonly effective: number
    readonly catalog: number
    readonly disabledReason?: string
  }
  readonly skills: {
    readonly listed: number
    readonly disabledReason?: string
  }
}

/**
 * Honest effective counts for the context/status bar. Discovery never broadens
 * authority: an unavailable, unclassified, platform-unsupported or
 * not-yet-wired capability is excluded and the first concrete reason is shown.
 */
function evaluateExposure(input: CapabilityExposureInputV1) {
  const requested = new Set(input.requestedTiers ?? defaultExposureTiers)
  const tiers: CapabilityTier[] = ["core"]
  if (requested.has("extended")) tiers.push("extended")
  if (requested.has("experimental")) tiers.push("experimental")
  const enabled = new Set(tiers)
  const platform = input.platform ?? "linux"
  const exposed: string[] = []
  let experimentalBlocked = 0
  let unclassified = 0
  let platformBlocked = 0
  let unwired = 0
  let capabilityDisabled = 0
  for (const capability of input.available) {
    const tier = classifyCapability(capability.id)
    if (tier === undefined) {
      unclassified += 1
      continue
    }
    if (tier === "experimental" && !enabled.has("experimental")) {
      experimentalBlocked += 1
      continue
    }
    if (!enabled.has(tier)) continue
    if (capability.supportedPlatforms !== undefined && !capability.supportedPlatforms.includes(platform)) {
      platformBlocked += 1
      continue
    }
    if (capability.implementationStatus === "designed" || capability.implementationStatus === "code_present") {
      unwired += 1
      continue
    }
    if (capability.disabledReason !== undefined) {
      capabilityDisabled += 1
      continue
    }
    exposed.push(capability.id)
  }
  const disabledReason =
    experimentalBlocked > 0
      ? "experimental_tier_off"
      : platformBlocked > 0
        ? "platform_unsupported"
        : unwired > 0
          ? "capability_not_wired"
          : capabilityDisabled > 0
            ? "capability_disabled"
            : unclassified > 0
              ? "unclassified_capability"
              : undefined
  return { tiers, exposed, disabledReason }
}

/**
 * Enforcement projection for `tools.search`/tool exposure. Only IDs returned
 * here may be described or made model-visible for the requested tiers; Guard
 * still revalidates every effect and availability remains a runtime fact.
 */
export function exposeCapabilityIDsV1(input: CapabilityExposureInputV1): readonly string[] {
  return evaluateExposure(input).exposed
}

export function projectCapabilityChips(input: CapabilityExposureInputV1): CapabilityChipsV1 {
  const { tiers, exposed, disabledReason } = evaluateExposure(input)
  return {
    tiers,
    tools: {
      effective: exposed.length,
      catalog: input.available.length,
      ...(disabledReason !== undefined ? { disabledReason } : {}),
    },
    skills: {
      listed: Math.max(0, input.skillCatalogSize),
    },
  }
}

export type HarnessID = "native-rich" | "native-minimal" | "bash-only"

export interface ModelHarnessFactsV1 {
  readonly toolCall: boolean
  /** Catalog context limit, unknown stays undefined rather than a guessed value. */
  readonly contextWindow?: number
}

export type HarnessSelectionV1 =
  | { readonly harnessId: HarnessID; readonly automatic: boolean }
  | { readonly unavailable: string }

const HARNESSES = new Set<string>(["native-rich", "native-minimal", "bash-only"])

/**
 * Pick a harness without silently switching either side of the pairing.
 *
 * `native-rich` is the default for compatible native-tool models. An explicit
 * `native-minimal` (or `bash-only`) choice is honored only when the model can
 * call tools; otherwise the pairing stays unavailable until the user changes
 * the harness or model. A low context window does not silently downgrade.
 */
export function selectHarnessV1(input: {
  readonly requested?: string
  readonly model: ModelHarnessFactsV1
}): HarnessSelectionV1 {
  if (input.requested !== undefined && !HARNESSES.has(input.requested)) {
    return { unavailable: "unknown_harness" }
  }
  if (!input.model.toolCall) return { unavailable: "model_lacks_native_tool_calling" }
  return {
    harnessId: (input.requested ?? "native-rich") as HarnessID,
    automatic: input.requested === undefined,
  }
}

export interface HorizonCodingProfileSettingsV1 {
  readonly profileId: "builtin.horizon-coding"
  readonly revision: 1
  readonly sandboxMode: "workspace-write"
  readonly approvalPolicy: "on-request"
  readonly goal: "off"
  readonly firstBoundaryGrant: "allow_session"
  readonly goalCopy: string
  readonly fullAccessWarning: string
}

/** The composed default preset. It is a settings/UX binding, not authority. */
export const settings: HorizonCodingProfileSettingsV1 = Object.freeze({
  profileId: "builtin.horizon-coding",
  revision: 1,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
  goal: "off",
  firstBoundaryGrant: "allow_session",
  goalCopy: "You do not need a Goal to code. Managed goals are for multi-step verified automation.",
  fullAccessWarning:
    "Full access disables the HorizonCode filesystem and network sandbox and never asks for approval; workspace files, external files, destructive commands and network become reachable.",
})

export interface ComposeHorizonCodingProfileInputV1 {
  readonly providerId: string
  readonly modelId: string
  readonly model: ModelHarnessFactsV1
  /** Explicit user harness choice; omit to use the compatible default. */
  readonly harnessId?: string
  readonly reasoning?: string
  readonly tokenBudget?: string
}

/**
 * Compose the single default AgentProfileV2. The caller must still persist it
 * through the owning Config path and pass its exact revision/digest to the
 * HostKernel-backed lane; composition does not activate a profile.
 */
export function composeHorizonCodingProfileV1(input: ComposeHorizonCodingProfileInputV1): AgentProfileV2.AgentProfileDefinitionV2 {
  const harness = selectHarnessV1({ requested: input.harnessId, model: input.model })
  if ("unavailable" in harness) throw new TypeError(`Horizon Coding Profile harness is unavailable: ${harness.unavailable}`)
  const allowed = [...CORE_CAPABILITIES, ...EXTENDED_CAPABILITIES].toSorted()
  return Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, {
    onExcessProperty: "error",
  })({
    schemaVersion: 2,
    profileId: "builtin.horizon-coding",
    revision: "1",
    name: "Coding (recommended)",
    description:
      "Default direct-session profile: workspace write, approval on boundary, rich native tools, Core and Extended capability tiers, Goal off.",
    source: "builtin",
    roles: ["main"],
    purpose: "Pair-programming and repository changes inside one direct Session.",
    whenToUse: "Default for ordinary coding, review and build/test work.",
    whenNotToUse: "Use an accepted managed Run for multi-step verified automation.",
    adapter: { kind: "native", adapterId: "horizon.native" },
    model: { providerId: input.providerId, modelId: input.modelId },
    harness: harness.harnessId,
    reasoning: input.reasoning ?? "medium",
    variants: [],
    instructions: { extraRefs: [], maxCompiledTokens: "65536" },
    tools: allowed.map((toolPattern) => ({ effect: "allow" as const, toolPattern })),
    allowedSkillIds: [],
    deniedSkillIds: [],
    allowedMcpServers: [],
    allowedMcpToolPatterns: [],
    allowedSubagentIds: [],
    deniedSubagentIds: [],
    pathRules: [],
    context: {
      isolation: "conversation_slice",
      maxParentHistoryTokens: "32768",
      allowImages: true,
      allowDocuments: true,
      allowArtifacts: true,
    },
    inputMode: "default",
    memoryPolicy: "none",
    isolation: "workspace",
    lifecycleHooks: [],
    capabilityCeiling: allowed,
    limits: {
      maxDepth: 1,
      maxActiveChildren: 1,
      maxTotalChildren: 4,
      maxPendingMessages: 16,
      maxMessageBytes: 65_536,
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    },
    maxParallelChildren: 1,
    enabled: true,
  })
}
