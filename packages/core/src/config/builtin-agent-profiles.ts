/**
 * Shipped built-in AgentProfileV2 directory and default Task selectors (arch §33.2).
 *
 * Pure data plus one pure model-pin projection. Core Config merges these under
 * user-owned entries: a user-owned selector name overrides a shipped selector,
 * and a user profile may not redefine a shipped profile identity@revision with
 * different content (AgentProfileConflictError, fail closed).
 *
 * This module grants no authority. Guard and HostKernel still admit every
 * effect, lease and receipt at runtime.
 */

import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"

export * as BuiltinAgentProfiles from "./builtin-agent-profiles"

/** Documented fallback pin; the direct-session projection degrades to the session default model when this pin is not configured. */
export const BUILTIN_MODEL_FALLBACK_PIN = { providerId: "anthropic", modelId: "claude-sonnet-4-5" } as const

type ToolRule = AgentProfileV2.AgentProfileDefinitionV2["tools"][number]
type AgentProfileDefinitionV2 = AgentProfileV2.AgentProfileDefinitionV2

const allow = (toolPattern: string): ToolRule => ({ effect: "allow", toolPattern })
const deny = (toolPattern: string): ToolRule => ({ effect: "deny", toolPattern })

const READ_ONLY_MAPPABLE: readonly ToolRule[] = [
  allow("files.read"),
  allow("glob.search"),
  allow("text.search"),
  allow("tools.search"),
]

const REPO_INTEL: readonly ToolRule[] = [
  allow("repo.tree"),
  allow("repo.detect"),
  allow("symbols.search"),
  allow("definitions.find"),
  allow("references.find"),
]

const DENY_MUTATION: readonly ToolRule[] = [deny("files.write"), deny("files.patch")]

const DENY_MUTATION_AND_TERMINAL: readonly ToolRule[] = [...DENY_MUTATION, deny("terminal.run")]

const DEFAULT_LIMITS = {
  maxDepth: 2,
  maxActiveChildren: 4,
  maxTotalChildren: 16,
  maxPendingMessages: 8,
  maxMessageBytes: 262_144,
} as const

interface BuiltinProfileInput {
  readonly short: string
  readonly name: string
  readonly description: string
  readonly purpose: string
  readonly whenToUse: string
  readonly whenNotToUse: string
  readonly reasoning: string
  readonly tools: readonly ToolRule[]
  /**
   * Shipped builtin skill ids this profile may expose. Empty means "no skill",
   * not "unrestricted": `deriveAuthorityCandidates` intersects this list with
   * the parent and policy allowlists, so an empty list intersects to nothing.
   * A grant is candidate exposure only; Guard still admits every skill load.
   */
  readonly skills: readonly string[]
}

const profile = (input: BuiltinProfileInput): AgentProfileDefinitionV2 => ({
  schemaVersion: 2,
  profileId: `builtin.${input.short}` as AgentProfileV2.ProfileId,
  revision: "1",
  name: input.name,
  description: input.description,
  source: "builtin",
  roles: ["subagent"],
  purpose: input.purpose,
  whenToUse: input.whenToUse,
  whenNotToUse: input.whenNotToUse,
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: BUILTIN_MODEL_FALLBACK_PIN,
  harness: "native-rich",
  reasoning: input.reasoning,
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: "8192" },
  tools: input.tools,
  allowedSkillIds: [...input.skills],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [],
  context: { isolation: "fresh", allowImages: true, allowDocuments: true, allowArtifacts: true },
  inputMode: "default",
  memoryPolicy: "none",
  isolation: "workspace",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { ...DEFAULT_LIMITS },
  maxParallelChildren: 4,
  enabled: true,
})

/** The shipped subagent roster (arch §29/§33.2). Immutable data; revisions bump only with a governance decision. */
export const builtinAgentProfilesV1: readonly AgentProfileDefinitionV2[] = [
  profile({
    short: "explorer",
    skills: ["builtin.repo-onboarding", "builtin.horizon-docs", "builtin.context-recovery"],
    name: "explorer",
    description: "Fast repository discovery: locate files, symbols, dependencies and answer codebase questions. Read-only; no source writes.",
    purpose: "Locate code and answer structural questions about the repository as fast as possible.",
    whenToUse: "When you need files found by pattern, symbol/definition/reference lookup, or a quick answer about how the codebase is organized.",
    whenNotToUse: "When the task requires editing files, running builds, or judgment-heavy analysis.",
    reasoning: "low",
    tools: [...READ_ONLY_MAPPABLE, ...REPO_INTEL, allow("terminal.run"), ...DENY_MUTATION],
  }),
  profile({
    short: "architect",
    skills: ["builtin.plan-change", "builtin.repo-onboarding", "builtin.horizon-docs"],
    name: "architect",
    description: "Architecture, impact and migration analysis over the repository. Read-only; produces design findings, not edits.",
    purpose: "Analyze impact, boundaries and migration paths before a large change.",
    whenToUse: "When a change needs blast-radius analysis, interface design, or a migration strategy before implementation.",
    whenNotToUse: "When the work is a routine edit, a test run, or a mechanical refactor.",
    reasoning: "high",
    tools: [...READ_ONLY_MAPPABLE, ...REPO_INTEL, ...DENY_MUTATION_AND_TERMINAL],
  }),
  profile({
    short: "librarian",
    skills: ["builtin.horizon-docs", "builtin.horizoncode"],
    name: "librarian",
    description: "Documentation and research agent: retrieval-first, provenance required, no code writes.",
    purpose: "Research documentation, standards and prior art, citing the sources actually read.",
    whenToUse: "When the task needs official docs, library semantics, standards research or cross-referencing external material.",
    whenNotToUse: "When repository code or local execution is the authority.",
    reasoning: "medium",
    tools: [...READ_ONLY_MAPPABLE, ...DENY_MUTATION_AND_TERMINAL],
  }),
  profile({
    short: "looker",
    skills: ["builtin.horizon-docs"],
    name: "looker",
    description: "Visual and document inspection agent: screenshots, UI states, PDFs and images. Read-only.",
    purpose: "Inspect visual or document artifacts and report what is actually in them.",
    whenToUse: "When a screenshot, rendered page, PDF or image must be read and described accurately.",
    whenNotToUse: "When the task needs code changes or terminal execution.",
    reasoning: "low",
    tools: [...READ_ONLY_MAPPABLE, ...DENY_MUTATION_AND_TERMINAL],
  }),
  profile({
    short: "reviewer",
    skills: ["builtin.review-change", "builtin.security-review"],
    name: "reviewer",
    description: "Independent code review: correctness, regressions, security and maintainability findings with file:line evidence. Read-only.",
    purpose: "Review a diff or changed area and return prioritized, evidence-backed findings.",
    whenToUse: "Before merging phase output or at a final verification boundary, with a different context from the author when possible.",
    whenNotToUse: "When the reviewer would also author the change under review.",
    reasoning: "high",
    tools: [...READ_ONLY_MAPPABLE, ...REPO_INTEL, allow("terminal.run"), ...DENY_MUTATION],
  }),
  profile({
    short: "test-debugger",
    skills: ["builtin.test-debug", "builtin.refactor-safely", "builtin.review-change"],
    name: "test-debugger",
    description: "Reproduce, classify and fix failing tests: root cause first, failing-to-passing evidence, never weaken assertions.",
    purpose: "Own test and runtime failure diagnosis through to a verified fix.",
    whenToUse: "When a test fails, behavior is unexpected, or a regression needs root-causing and a scoped fix.",
    whenNotToUse: "When no reproduction exists yet and the failure mode is still undefined.",
    reasoning: "medium",
    tools: [
      allow("files.read"),
      allow("files.write"),
      allow("files.patch"),
      allow("glob.search"),
      allow("text.search"),
      allow("definitions.find"),
      allow("references.find"),
      allow("repo.detect"),
      allow("tools.search"),
      allow("terminal.run"),
    ],
  }),
  profile({
    short: "system-operator",
    skills: ["builtin.worktree-hygiene"],
    name: "system-operator",
    description: "Bounded local system operations: service, process and environment diagnosis and repair under the Guard. No source writes.",
    purpose: "Diagnose and repair local system state (services, processes, environment, resources) with terminal evidence.",
    whenToUse: "When the blocker is environmental: a dead service, a stuck process, a missing toolchain, resource pressure.",
    whenNotToUse: "When the fix belongs in repository source code.",
    reasoning: "medium",
    tools: [...READ_ONLY_MAPPABLE, allow("terminal.run"), ...DENY_MUTATION],
  }),
  profile({
    short: "browser-qa",
    skills: ["builtin.browser-smoke-test"],
    name: "browser-qa",
    description: "Browser/DOM functional and visual verification through available browser tooling; console/network evidence. No source writes.",
    purpose: "Run a browser journey and collect pass/fail evidence per step.",
    whenToUse: "When a user-facing flow must be verified in a real browser session with console and network evidence.",
    whenNotToUse: "When no browser tooling is available in this session, or when source edits are the deliverable.",
    reasoning: "medium",
    tools: [...READ_ONLY_MAPPABLE, allow("terminal.run"), ...DENY_MUTATION],
  }),
  profile({
    short: "history-search",
    skills: ["builtin.context-recovery"],
    name: "history-search",
    description: "Prior conversation and artifact retrieval with bounded synthesis. Read-only.",
    purpose: "Recover facts from earlier sessions and artifacts without re-deriving them.",
    whenToUse: "When a decision, blocker or artifact from an earlier session must be recovered and cited.",
    whenNotToUse: "When the answer must come from current source or live tool output.",
    reasoning: "low",
    tools: [...READ_ONLY_MAPPABLE, ...DENY_MUTATION_AND_TERMINAL],
  }),
  profile({
    short: "verifier",
    skills: ["builtin.release-readiness"],
    name: "verifier",
    description: "Acceptance verification: produces verification evidence under a permit; never edits the subject under test.",
    purpose: "Independently verify that acceptance criteria hold, producing evidence a separate service can validate.",
    whenToUse: "At a final verification boundary, once, over a bounded deliverable.",
    whenNotToUse: "To award PASS on your own say-so; the model's self-report is not completion evidence.",
    reasoning: "medium",
    tools: [...READ_ONLY_MAPPABLE, allow("repo.detect"), allow("terminal.run"), ...DENY_MUTATION],
  }),
]

/** Shipped Task selectors, one per shipped subagent profile (arch §33.2 stable IDs). */
export const builtinAgentProfileSelectorsV1: readonly { selector: string; profileId: AgentProfileV2.ProfileId; revision: AgentProfileV2.Revision }[] =
  builtinAgentProfilesV1.map((item) => ({ selector: String(item.profileId).slice("builtin.".length), profileId: item.profileId, revision: item.revision }))

/**
 * Pin every shipped profile to the configured default model when it names one
 * ("provider/model"; model IDs may contain "/"), otherwise to the documented
 * fallback pin. The direct-session projection degrades a builtin pin that is
 * not configured in this environment to the session default model.
 */
export function builtinAgentProfilesWithModelV1(configuredModel: string | undefined): AgentProfileDefinitionV2[] {
  const pin = (() => {
    if (!configuredModel) return BUILTIN_MODEL_FALLBACK_PIN
    const split = configuredModel.indexOf("/")
    if (split <= 0 || split === configuredModel.length - 1) return BUILTIN_MODEL_FALLBACK_PIN
    return { providerId: configuredModel.slice(0, split), modelId: configuredModel.slice(split + 1) }
  })()
  return builtinAgentProfilesV1.map((item) => ({ ...item, model: pin }))
}