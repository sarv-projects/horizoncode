import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Global } from "@horizoncode/core/global"
import { Config } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
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

const userProfile = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  profileId: "user.reader",
  revision: "1",
  name: "Reader",
  description: "Read-only profile",
  source: "user",
  roles: ["subagent"],
  purpose: "Inspect source",
  whenToUse: "When reviewing",
  whenNotToUse: "When editing",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "local", modelId: "small" },
  harness: "native-minimal",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: "4096" },
  tools: [],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [],
  context: { isolation: "fresh", allowImages: false, allowDocuments: false, allowArtifacts: false },
  inputMode: "read_only",
  memoryPolicy: "none",
  isolation: "read_only",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
  ...overrides,
})

describe("Core Config AgentProfileV2 owner", () => {
  it.live("resolves only globally configured user-owned profiles and preserves pinned versions", () =>
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
          yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({
            agent_profiles: [userProfile(), userProfile({ revision: "2", name: "Reader v2" })],
            agent_profile_selectors: [{ selector: "reader-v1", profileId: "user.reader", revision: "1" }],
          })))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({ agent_profiles: [userProfile({ profileId: "repo.fake", source: "user" })] })))

          const profiles = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfiles()),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(profiles.filter((profile) => profile.source === "user").map((profile) => [String(profile.profileId), profile.revision])).toEqual([
            ["user.reader", "1"],
            ["user.reader", "2"],
          ])
          expect(profiles.filter((profile) => profile.source === "builtin").length).toBeGreaterThanOrEqual(10)
          const firstUser = profiles.find((profile) => profile.source === "user")!
          expect(firstUser).not.toHaveProperty("definitionDigest")
          expect(firstUser).not.toHaveProperty("permissionCeilingDigest")
          const pinned = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfile("user.reader", "1")),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(pinned.revision).toBe("1")
          const selectors = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfileSelectors()),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(selectors.filter((item) => item.selector === "reader-v1").map((item) => [item.selector, item.profile.profileId, item.profile.revision])).toEqual([
            ["reader-v1", "user.reader", "1"],
          ])
          expect(selectors.some((item) => item.selector === "explorer")).toBe(true)
          const selected = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfileSelector("reader-v1")),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(selected.revision).toBe("1")
          const implicitName = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfileSelector("Reader")),
            Effect.option,
            Effect.provide(configLayer({ directory, global })),
          )
          expect(Option.isNone(implicitName)).toBe(true)

          yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.jsonc"), JSON.stringify({
            agent_profile_selectors: [{ selector: "reader-v1", profileId: "user.reader", revision: "2" }],
          })))
          const conflictingSelector = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfileSelectors()),
            Effect.exit,
            Effect.provide(configLayer({ directory, global })),
          )
          expect(Exit.isFailure(conflictingSelector)).toBe(true)
          yield* Effect.promise(() => fs.rm(path.join(global, "opencode.jsonc")))

          yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({
            agent_profiles: [userProfile({ definitionDigest: `blake3:${"f".repeat(64)}` })],
          })))
          const forgedDigestConfig = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfiles()),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(forgedDigestConfig.filter((profile) => profile.source === "user")).toEqual([])

          // A config-supplied "builtin" label is not trust. Built-ins must be
          // compiled into the owning registry, so this row stays invisible.
          yield* Effect.promise(() => fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({
            agent_profiles: [userProfile({ profileId: "builtin.fake", source: "builtin" })],
          })))
          const forgedBuiltin = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfiles()),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(forgedBuiltin.filter((profile) => profile.source === "user")).toEqual([])
          expect(forgedBuiltin.some((profile) => String(profile.profileId) === "builtin.fake")).toBe(false)
        }),
      ),
    ),
  )

  it.live("a stale or absent profile revision pin fails closed instead of resolving another revision", () =>
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
          yield* Effect.promise(() =>
            fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ agent_profiles: [userProfile()] })),
          )

          const stale = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfile("user.reader", "999")),
            Effect.flip,
            Effect.provide(configLayer({ directory, global })),
          )
          expect(stale).toBeInstanceOf(Config.AgentProfileNotFoundError)

          const absent = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfile("user.ghost", "1")),
            Effect.flip,
            Effect.provide(configLayer({ directory, global })),
          )
          expect(absent).toBeInstanceOf(Config.AgentProfileNotFoundError)

          // The existing pin still resolves to its exact revision afterwards.
          const pinned = yield* Config.AgentProfileService.pipe(
            Effect.flatMap((config) => config.agentProfile("user.reader", "1")),
            Effect.provide(configLayer({ directory, global })),
          )
          expect(pinned.revision).toBe("1")
          expect(String(pinned.profileId)).toBe("user.reader")
        }),
      ),
    ),
  )
})
