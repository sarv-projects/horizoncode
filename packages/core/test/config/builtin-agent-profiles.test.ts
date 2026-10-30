import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Global } from "@horizoncode/core/global"
import { Config } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { BuiltinAgentProfiles } from "@horizoncode/core/config/builtin-agent-profiles"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const configLayer = (input: { directory: string; global: string }) =>
  AppNodeBuilder.build(LayerNode.group([Config.agentProfileNode, LayerNodePlatform.filesystem]), [
    [FSUtil.node, LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))],
    [Global.node, Global.layerWith({ config: input.global })],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make(input.directory) }, { projectDirectory: AbsolutePath.make(input.directory) }),
        ),
      ),
    ],
  ])

const withDirs = <A, E>(run: (input: { directory: string; global: string }) => Effect.Effect<A, E>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const directory = path.join(tmp.path, "project")
        const global = path.join(tmp.path, "global")
        yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
        return yield* run({ directory, global })
      }),
    ),
  )

const userProfileFixture = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  profileId: "user.scout",
  revision: "1",
  name: "Scout",
  description: "User-owned read-only scout",
  source: "user",
  roles: ["subagent"],
  purpose: "Inspect source",
  whenToUse: "When scouting",
  whenNotToUse: "When editing",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "local", modelId: "small" },
  harness: "native-rich",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: "4096" },
  tools: [{ effect: "allow", toolPattern: "files.read" }],
  allowedSkillIds: [],
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
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
  ...overrides,
})

const MAPPABLE_CAPABILITIES = new Set([
  "files.read",
  "files.write",
  "files.patch",
  "terminal.run",
  "glob.search",
  "text.search",
  "repo.tree",
  "repo.detect",
  "symbols.search",
  "definitions.find",
  "references.find",
  "question.ask",
  "tools.search",
])

const SHIPPED_SKILL_IDS = new Set([
  "builtin.horizoncode",
  "builtin.horizon-docs",
  "builtin.repo-onboarding",
  "builtin.plan-change",
  "builtin.review-change",
  "builtin.test-debug",
  "builtin.refactor-safely",
  "builtin.dependency-migration",
  "builtin.browser-smoke-test",
  "builtin.performance-profile",
  "builtin.plugin-audit",
  "builtin.release-readiness",
  "builtin.security-review",
  "builtin.worktree-hygiene",
  "builtin.commit-pr",
  "builtin.context-recovery",
])

describe("shipped built-in AgentProfileV2 directory", () => {
  it.live("every shipped profile is schema-valid and projects into the direct-session runtime", () =>
    Effect.gen(function* () {
      const profiles = BuiltinAgentProfiles.builtinAgentProfilesV1
      expect(profiles.length).toBeGreaterThanOrEqual(10)
      const selectors = BuiltinAgentProfiles.builtinAgentProfileSelectorsV1
      expect(selectors.length).toBe(profiles.length)
      const identities = new Set<string>()
      for (const profile of profiles) {
        const decoded = yield* Effect.promise(() =>
          Schema.decodeUnknownPromise(AgentProfileV2.AgentProfileDefinitionV2)(profile as unknown),
        )
        expect(String(decoded.profileId)).toBe(String(profile.profileId))
        identities.add(`${String(profile.profileId)}@${profile.revision}`)
        expect(profile.source).toBe("builtin")
        expect(profile.enabled).toBe(true)
        expect(profile.roles).toEqual(["subagent"])
        expect(profile.adapter).toEqual({ kind: "native", adapterId: "horizon.native" })
        expect(profile.harness).toBe("native-rich")
        expect(profile.variants).toEqual([])
        expect(profile.capabilityCeiling).toEqual([])
        expect(profile.pathRules).toEqual([])
        expect(profile.allowedSkillIds.every((id) => SHIPPED_SKILL_IDS.has(id))).toBe(true)
        expect(profile.allowedSkillIds.length).toBeLessThanOrEqual(3)
        expect(profile.allowedMcpServers).toEqual([])
        expect(profile.allowedMcpToolPatterns).toEqual([])
        expect(profile.allowedSubagentIds).toEqual([])
        expect(profile.deniedSubagentIds).toEqual([])
        expect(profile.context.isolation).toBe("fresh")
        expect(profile.context.allowImages).toBe(true)
        expect(profile.context.allowDocuments).toBe(true)
        expect(profile.context.allowArtifacts).toBe(true)
        expect(profile.memoryPolicy).toBe("none")
        expect(profile.isolation).toBe("workspace")
        expect(profile.inputMode).toBe("default")
        expect(profile.lifecycleHooks).toEqual([])
        expect(profile.limits.tokenBudget).toBeUndefined()
        expect(profile.instructions.baseRef).toBeUndefined()
        expect(profile.instructions.extraRefs).toEqual([])
        expect(profile.limits.maxPendingMessages).toBeGreaterThanOrEqual(1)
        expect(profile.limits.maxMessageBytes).toBeGreaterThan(0)
        expect(profile.maxParallelChildren).toBeLessThanOrEqual(profile.limits.maxActiveChildren)
        for (const rule of profile.tools) {
          expect(MAPPABLE_CAPABILITIES.has(rule.toolPattern)).toBe(true)
          if (rule.effect !== "deny") {
            expect(rule.toolPattern === "skill" || rule.toolPattern === "task" || rule.toolPattern === "mcp" || rule.toolPattern.startsWith("mcp.")).toBe(false)
          }
        }
      }
      for (const selector of selectors) {
        expect(identities.has(`${String(selector.profileId)}@${selector.revision}`)).toBe(true)
      }
      expect(new Set(selectors.map((item) => item.selector)).size).toBe(selectors.length)
    }),
  )

  it.live("builtin profiles and selectors resolve with zero user config", () =>
    withDirs(({ directory, global }) =>
      Effect.gen(function* () {
        const profiles = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfiles()),
          Effect.provide(configLayer({ directory, global })),
        )
        const builtinRows = profiles.filter((profile) => profile.source === "builtin")
        expect(builtinRows.length).toBe(BuiltinAgentProfiles.builtinAgentProfilesV1.length)
        const selectors = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfileSelectors()),
          Effect.provide(configLayer({ directory, global })),
        )
        expect(selectors.map((item) => item.selector).sort()).toEqual(
          BuiltinAgentProfiles.builtinAgentProfileSelectorsV1.map((item) => item.selector).sort(),
        )
        const reviewer = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfileSelector("reviewer")),
          Effect.provide(configLayer({ directory, global })),
        )
        expect(String(reviewer.profileId)).toBe("builtin.reviewer")
        expect(reviewer.revision).toBe("1")
        expect(reviewer.roles).toEqual(["subagent"])
      }),
    ),
  )

  it.live("the configured default model becomes each builtin profile's pinned model", () =>
    Effect.gen(function* () {
      const configured = BuiltinAgentProfiles.builtinAgentProfilesWithModelV1("anthropic/claude-sonnet-4-5")
      for (const profile of configured) {
        expect(profile.model).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5" })
      }
      const unparsed = BuiltinAgentProfiles.builtinAgentProfilesWithModelV1(undefined)
      const fallback = BuiltinAgentProfiles.BUILTIN_MODEL_FALLBACK_PIN
      for (const profile of unparsed) {
        expect(profile.model).toEqual(fallback)
      }
      const malformed = BuiltinAgentProfiles.builtinAgentProfilesWithModelV1("no-slash")
      for (const profile of malformed) {
        expect(profile.model).toEqual(fallback)
      }
      const openRouter = BuiltinAgentProfiles.builtinAgentProfilesWithModelV1("openrouter/openrouter/auto")
      expect(openRouter[0]!.model).toEqual({ providerId: "openrouter", modelId: "openrouter/auto" })
    }),
  )

  it.live("a user-owned selector overrides a shipped selector name without conflict", () =>
    withDirs(({ directory, global }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(global, "opencode.json"),
            JSON.stringify({
              agent_profiles: [userProfileFixture()],
              agent_profile_selectors: [{ selector: "reviewer", profileId: "user.scout", revision: "1" }],
            }),
          ),
        )
        const selected = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfileSelector("reviewer")),
          Effect.provide(configLayer({ directory, global })),
        )
        expect(String(selected.profileId)).toBe("user.scout")
        const selectors = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfileSelectors()),
          Effect.provide(configLayer({ directory, global })),
        )
        const reviewerRows = selectors.filter((item) => item.selector === "reviewer")
        expect(reviewerRows.length).toBe(1)
        expect(String(reviewerRows[0]!.profile.source)).toBe("user")
        expect(selectors.some((item) => item.selector === "explorer")).toBe(true)
      }),
    ),
  )

  it.live("a user config cannot redefine a shipped profile identity with different content", () =>
    withDirs(({ directory, global }) =>
      Effect.gen(function* () {
        const shipped = BuiltinAgentProfiles.builtinAgentProfilesV1.find(
          (profile) => profile.profileId === "builtin.reviewer",
        )!
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(global, "opencode.json"),
            JSON.stringify({ agent_profiles: [userProfileFixture({ profileId: "builtin.reviewer", revision: "1" })] }),
          ),
        )
        const conflict = yield* Config.AgentProfileService.pipe(
          Effect.flatMap((config) => config.agentProfiles()),
          Effect.flip,
          Effect.provide(configLayer({ directory, global })),
        )
        expect(conflict).toBeInstanceOf(Config.AgentProfileConflictError)
        expect(shipped.enabled).toBe(true)
      }),
    ),
  )
})