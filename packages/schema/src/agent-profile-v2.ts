/** Browser-safe AgentProfileV2 contract. Profile storage, revision creation and Guard authority remain outside Schema. */

import { Schema } from "effect"
import * as Composition from "./composition-v1"

const Identifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
const Text = Schema.String.check(Schema.isMaxLength(65_536))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const BoundedList = <S extends Schema.Top>(item: S) => Schema.Array(item).check(Schema.isMaxLength(4096))
const unique = <A>(values: readonly A[]) => new Set(values).size === values.length

export const ProfileId = Identifier.annotate({ identifier: "Horizon.AgentProfileV2.ProfileId" }).pipe(
  Schema.brand("Horizon.AgentProfileV2.ProfileId"),
)
export type ProfileId = typeof ProfileId.Type

export const Revision = PositiveInt.annotate({ identifier: "Horizon.AgentProfileV2.Revision" })
export type Revision = typeof Revision.Type

export const WireApi = Schema.Literals(["responses", "chat_completions", "anthropic_messages", "custom"])
export type WireApi = typeof WireApi.Type

export const ModelSelectionV2 = Schema.Struct({
  providerId: Identifier,
  modelId: Identifier,
  reasoningEffort: Schema.optional(Schema.String),
}).annotate({ identifier: "Horizon.AgentProfileV2.ModelSelection" })
export type ModelSelectionV2 = typeof ModelSelectionV2.Type

export const ReasoningSelection = Schema.String.annotate({ identifier: "Horizon.AgentProfileV2.ReasoningSelection" })
export type ReasoningSelection = typeof ReasoningSelection.Type

export const Adapter = Schema.Struct({
  kind: Schema.Literals(["native", "acp", "cli", "container", "remote"]),
  adapterId: Identifier,
}).annotate({ identifier: "Horizon.AgentProfileV2.Adapter" })

export const ToolRule = Schema.Struct({
  effect: Schema.Literals(["allow", "ask", "deny"]),
  toolPattern: Identifier,
  resourcePattern: Schema.optional(Schema.String),
}).annotate({ identifier: "Horizon.AgentProfileV2.ToolRule" })

export const PathRule = Schema.Struct({
  effect: Schema.Literals(["allow", "ask", "deny"]),
  operation: Schema.Literals(["read", "write", "execute", "watch"]),
  glob: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "Horizon.AgentProfileV2.PathRule" })

export const Variant = Schema.Struct({
  match: Schema.Struct({
    providerId: Schema.optional(Identifier),
    modelPattern: Schema.optional(Schema.String),
    protocol: Schema.optional(WireApi),
  }),
  instructionPatchRef: Schema.optional(Composition.ArtifactRef),
  requestOverrides: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  toolExposureProfile: Schema.optional(Identifier),
  effort: Schema.optional(ReasoningSelection),
}).annotate({ identifier: "Horizon.AgentProfileV2.Variant" })

export const LifecycleHook = Schema.Struct({
  hookId: Identifier,
  event: Identifier,
  required: Schema.Boolean,
  mode: Schema.Literals(["blocking", "advisory", "async"]),
  matcher: Schema.optional(Schema.Struct({
    toolPattern: Schema.optional(Schema.String),
    pathGlob: Schema.optional(Schema.String),
    agentPattern: Schema.optional(Schema.String),
  })),
  timeoutMs: NonNegativeInt,
  maxOutputBytes: NonNegativeInt,
}).annotate({ identifier: "Horizon.AgentProfileV2.LifecycleHook" })

export const Limits = Schema.Struct({
  maxDepth: NonNegativeInt,
  maxActiveChildren: NonNegativeInt,
  maxTotalChildren: NonNegativeInt,
  maxPendingMessages: NonNegativeInt,
  maxMessageBytes: NonNegativeInt,
  tokenBudget: Schema.optional(PositiveInt),
  wallTimeMs: Schema.optional(PositiveInt),
}).annotate({ identifier: "Horizon.AgentProfileV2.Limits" })

export interface AgentProfileV2 extends Schema.Schema.Type<typeof AgentProfileV2> {}
export const AgentProfileV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  profileId: ProfileId,
  revision: Revision,
  name: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(512)),
  description: Text,
  source: Schema.Literals(["builtin", "user", "project", "plugin", "external"]),
  roles: BoundedList(Schema.Literals(["main", "subagent"])),
  purpose: Text,
  whenToUse: Text,
  whenNotToUse: Text,
  adapter: Adapter,
  model: ModelSelectionV2,
  harness: Identifier,
  reasoning: ReasoningSelection,
  variants: BoundedList(Variant),
  instructions: Schema.Struct({
    baseRef: Schema.optional(Composition.ArtifactRef),
    extraRefs: BoundedList(Composition.ArtifactRef),
    maxCompiledTokens: PositiveInt,
  }),
  tools: BoundedList(ToolRule),
  allowedSkillIds: BoundedList(Identifier),
  deniedSkillIds: BoundedList(Identifier),
  allowedMcpServers: BoundedList(Identifier),
  allowedMcpToolPatterns: BoundedList(Identifier),
  allowedSubagentIds: BoundedList(Identifier),
  deniedSubagentIds: BoundedList(Identifier),
  pathRules: BoundedList(PathRule),
  context: Schema.Struct({
    isolation: Schema.Literals(["fresh", "conversation_slice", "fork"]),
    maxParentHistoryTokens: Schema.optional(PositiveInt),
    allowImages: Schema.Boolean,
    allowDocuments: Schema.Boolean,
    allowArtifacts: Schema.Boolean,
  }),
  inputMode: Schema.Literals(["default", "read_only", "careful", "sandbox_auto"]),
  memoryPolicy: Schema.Literals(["none", "project_read", "profile_read", "reviewed_write"]),
  isolation: Schema.Literals(["read_only", "workspace", "worktree", "external"]),
  lifecycleHooks: BoundedList(LifecycleHook),
  permissionCeilingDigest: Composition.Digest,
  limits: Limits,
  maxParallelChildren: NonNegativeInt,
  enabled: Schema.Boolean,
  definitionDigest: Composition.Digest,
})
  .annotate({ identifier: "Horizon.AgentProfileV2.AgentProfileV2" })
  .check(
    Schema.makeFilter((profile) => {
      if (profile.roles.length === 0 || !unique(profile.roles)) return "roles must be non-empty and unique"
      if (!unique(profile.allowedSkillIds) || !unique(profile.deniedSkillIds)) return "skill IDs must be unique"
      if (!unique(profile.allowedMcpServers) || !unique(profile.allowedMcpToolPatterns)) return "MCP entries must be unique"
      if (!unique(profile.allowedSubagentIds) || !unique(profile.deniedSubagentIds)) return "subagent IDs must be unique"
      if (profile.maxParallelChildren > profile.limits.maxActiveChildren) return "parallel children exceed active-child limit"
      return undefined
    }),
  )


export const ProfileRevisionRef = Schema.Struct({
  profileId: ProfileId,
  revision: Revision,
  definitionDigest: Composition.Digest,
}).annotate({ identifier: "Horizon.AgentProfileV2.ProfileRevisionRef" })
export type ProfileRevisionRef = typeof ProfileRevisionRef.Type

export interface SelectedRuntime {
  readonly providerId: string
  readonly modelId: string
  readonly harness: string
  readonly wireApi: WireApi
}

export type ProfileResolution =
  | { readonly status: "available"; readonly profile: AgentProfileV2; readonly selection: SelectedRuntime }
  | {
      readonly status: "unavailable"
      readonly reason:
        | "disabled"
        | "revision_mismatch"
        | "digest_mismatch"
        | "selection_mismatch"
        | "wire_unsupported"
        | "adapter_unavailable"
        | "sandbox_unavailable"
    }

/**
 * Checks a pinned tuple against caller-provided evidence. The caller must obtain
 * `trustedRevision` from a trusted store that verified the profile content digest;
 * this schema helper compares the pinned metadata and does not hash profile content
 * or verify that evidence's provenance.
 */
export const resolveProfile = (input: {
  readonly profile: AgentProfileV2
  readonly trustedRevision: ProfileRevisionRef
  readonly selected: SelectedRuntime
  readonly supportedWireApis: readonly WireApi[]
  readonly supportedAdapters: readonly (typeof Adapter.Type)[]
  readonly sandboxEnforced: boolean
}): ProfileResolution => {
  const { profile, trustedRevision, selected } = input
  if (profile.profileId !== trustedRevision.profileId || profile.revision !== trustedRevision.revision) {
    return { status: "unavailable", reason: "revision_mismatch" }
  }
  if (profile.definitionDigest !== trustedRevision.definitionDigest) return { status: "unavailable", reason: "digest_mismatch" }
  if (!profile.enabled) return { status: "unavailable", reason: "disabled" }
  if (
    selected.providerId !== profile.model.providerId ||
    selected.modelId !== profile.model.modelId ||
    selected.harness !== profile.harness
  ) {
    return { status: "unavailable", reason: "selection_mismatch" }
  }
  if (!input.supportedWireApis.includes(selected.wireApi)) return { status: "unavailable", reason: "wire_unsupported" }
  if (
    !input.supportedAdapters.some(
      (adapter) => adapter.kind === profile.adapter.kind && adapter.adapterId === profile.adapter.adapterId,
    )
  ) {
    return { status: "unavailable", reason: "adapter_unavailable" }
  }
  if (profile.inputMode === "sandbox_auto" && !input.sandboxEnforced) {
    return { status: "unavailable", reason: "sandbox_unavailable" }
  }
  return { status: "available", profile, selection: selected }
}

export interface AuthorityRules {
  readonly tools: readonly { readonly effect: "allow" | "ask" | "deny"; readonly toolPattern: string; readonly resourcePattern?: string }[]
  readonly paths: readonly { readonly effect: "allow" | "ask" | "deny"; readonly operation: "read" | "write" | "execute" | "watch"; readonly glob: string }[]
  readonly skills: readonly string[]
  readonly mcpServers: readonly string[]
  readonly mcpToolPatterns: readonly string[]
  readonly subagentIds: readonly string[]
}

/**
 * Returns descriptive candidates only. Exact text equality is not a permission
 * matcher: glob overlap and Guard policy semantics are intentionally not resolved
 * here. Every candidate must be re-evaluated by Guard before use; this output must
 * never be consumed as an effective permission or execution grant.
 */
export interface AuthorityCandidates {
  readonly status: "candidate_exposure"
  readonly toolCandidates: readonly { readonly toolPattern: string; readonly resourcePattern?: string }[]
  readonly pathCandidates: readonly { readonly operation: "read" | "write" | "execute" | "watch"; readonly glob: string }[]
  readonly skillCandidates: readonly string[]
  readonly mcpServerCandidates: readonly string[]
  readonly mcpToolPatternCandidates: readonly string[]
  readonly subagentCandidates: readonly string[]
}

export const deriveAuthorityCandidates = (
  profile: AgentProfileV2,
  parent: AuthorityRules,
  currentPolicy: AuthorityRules,
): AuthorityCandidates => {
  const profileToolAllows = profile.tools.filter((rule) => rule.effect === "allow")
  const toolCandidates = profileToolAllows.filter(
    (rule) =>
      !profile.tools.some((candidate) => candidate.effect !== "allow" && candidate.toolPattern === rule.toolPattern && candidate.resourcePattern === rule.resourcePattern) &&
      parent.tools.some((candidate) => candidate.effect === "allow" && candidate.toolPattern === rule.toolPattern && candidate.resourcePattern === rule.resourcePattern) &&
      currentPolicy.tools.some((candidate) => candidate.effect === "allow" && candidate.toolPattern === rule.toolPattern && candidate.resourcePattern === rule.resourcePattern) &&
      !parent.tools.some((candidate) => candidate.effect !== "allow" && candidate.toolPattern === rule.toolPattern && candidate.resourcePattern === rule.resourcePattern) &&
      !currentPolicy.tools.some((candidate) => candidate.effect !== "allow" && candidate.toolPattern === rule.toolPattern && candidate.resourcePattern === rule.resourcePattern),
  ).map(({ toolPattern, resourcePattern }) => ({ toolPattern, resourcePattern }))
  const pathCandidates = profile.pathRules.filter(
    (rule) =>
      rule.effect === "allow" &&
      !profile.pathRules.some((candidate) => candidate.effect !== "allow" && candidate.operation === rule.operation && candidate.glob === rule.glob) &&
      parent.paths.some((candidate) => candidate.effect === "allow" && candidate.operation === rule.operation && candidate.glob === rule.glob) &&
      currentPolicy.paths.some((candidate) => candidate.effect === "allow" && candidate.operation === rule.operation && candidate.glob === rule.glob) &&
      !parent.paths.some((candidate) => candidate.effect !== "allow" && candidate.operation === rule.operation && candidate.glob === rule.glob) &&
      !currentPolicy.paths.some((candidate) => candidate.effect !== "allow" && candidate.operation === rule.operation && candidate.glob === rule.glob),
  ).map(({ operation, glob }) => ({ operation, glob }))
  const intersectIds = (profileIds: readonly string[], denied: readonly string[], parentIds: readonly string[], policyIds: readonly string[]) =>
    profileIds.filter((id) => !denied.includes(id) && parentIds.includes(id) && policyIds.includes(id))
  const skillCandidates = intersectIds(profile.allowedSkillIds, profile.deniedSkillIds, parent.skills, currentPolicy.skills)
  const mcpServerCandidates = intersectIds(profile.allowedMcpServers, [], parent.mcpServers, currentPolicy.mcpServers)
  const mcpToolPatternCandidates = intersectIds(profile.allowedMcpToolPatterns, [], parent.mcpToolPatterns, currentPolicy.mcpToolPatterns)
  const subagentCandidates = intersectIds(profile.allowedSubagentIds, profile.deniedSubagentIds, parent.subagentIds, currentPolicy.subagentIds)
  return {
    status: "candidate_exposure",
    toolCandidates,
    pathCandidates,
    skillCandidates,
    mcpServerCandidates,
    mcpToolPatternCandidates,
    subagentCandidates,
  }
}
