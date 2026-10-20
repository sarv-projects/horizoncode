import fs from "fs/promises"
import path from "path"
import { describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")
const skillIdentity = (name: string, location: string, content: string) =>
  SkillV2.identityFor({ source: "project", sourcePath: location, content, alias: name })

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected identity, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
            identity: skillIdentity("effect", location, "# Effect\n\nGuidance"),
          }
          let current = [info]
          const assertions: PermissionV2.AssertInput[] = []
          let deny = false
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
              policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: { structured: { id: info.identity.id, name: "effect" } },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: [info.identity.id], save: [info.identity.id] },
              { sessionID, action: "skill", resources: [info.identity.id], save: [info.identity.id] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const flat = SkillV2.Info.make({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
              identity: skillIdentity("public", path.join(tmp.path, "public.md"), "Public"),
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )

  it.live("loads a skill without spawning any process", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "zero-spawn")
          const location = path.join(directory, "SKILL.md")
          const script = path.join(directory, "scripts", "run-me.sh")
          const sentinel = path.join(tmp.path, "spawn-sentinel")
          yield* Effect.promise(() => fs.mkdir(path.dirname(script), { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(location, "# Zero\n"),
              fs.writeFile(script, `#!/bin/sh\nprintf spawned > ${JSON.stringify(sentinel)}\n`),
            ]),
          )

          const info: SkillV2.Info = {
            name: "zero-spawn",
            description: "Load without executing content",
            location: AbsolutePath.make(location),
            content: "# Zero\n\nGuidance",
            identity: skillIdentity("zero-spawn", location, "# Zero\n\nGuidance"),
          }
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: () => Effect.void,
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
              policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed([info]),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const bunSpawn = yield* Effect.sync(() => spyOn(Bun, "spawn"))
            const bunSpawnSync = yield* Effect.sync(() => spyOn(Bun, "spawnSync"))
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                bunSpawn.mockRestore()
                bunSpawnSync.mockRestore()
              }),
            )
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-zero-spawn", name: "skill", input: { name: "zero-spawn" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(info, [script]) })
            expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(false)
            expect(bunSpawn).not.toHaveBeenCalled()
            expect(bunSpawnSync).not.toHaveBeenCalled()
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
