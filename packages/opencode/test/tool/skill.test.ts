import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { Entry } from "@opencode-ai/schema/filesystem"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import type { Permission } from "../../src/permission"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { Process } from "@/util/process"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])))

/**
 * Skill origin closure (C16): loading a skill must be a pure read. The real
 * Ripgrep node is replaced with a fixture result so the only spawns the guards
 * could observe would be skill-content execution, which must never happen.
 */
const itMockedRipgrep = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node]), [
    [
      Ripgrep.node,
      Layer.succeed(
        Ripgrep.Service,
        Ripgrep.Service.of({
          find: () =>
            Effect.succeed([
              Entry.make({ path: RelativePath.make("scripts/run-me.sh"), type: "file" }),
              Entry.make({ path: RelativePath.make("reference.md"), type: "file" }),
            ]),
          glob: () => Effect.die("Ripgrep.glob must not run while loading a skill"),
          grep: () => Effect.die("Ripgrep.grep must not run while loading a skill"),
        }),
      ),
    ],
  ]),
)

describe("tool.skill", () => {
  it.instance("execute returns skill content block with files", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".opencode", "skill", "tool-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      expect(tool.description).not.toContain("tool-skill")
      expect(tool.description).not.toContain("Skill for tool tests.")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const result = yield* tool.execute({ name: "tool-skill" }, ctx)
      const file = path.resolve(skill, "scripts", "demo.txt")

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("tool-skill")
      expect(requests[0].always).toContain("tool-skill")
      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="tool-skill">`)
      expect(result.output).toContain(`Base directory for this skill: ${skill}`)
      expect(result.output).toContain(`<file>${file}</file>`)
    }),
  )

  it.instance("execute preserves not found message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) expect(error.message).toContain('Skill "missing-skill" not found.')
      }
    }),
  )

  itMockedRipgrep.instance(
    "loads a skill without spawning any process",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const skill = path.join(dir, ".opencode", "skill", "zero-spawn")
        const script = path.join(skill, "scripts", "run-me.sh")
        const sentinel = path.join(dir, "spawn-sentinel")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(skill, "SKILL.md"),
            `---
name: zero-spawn
description: Skill content must never be executed while loading.
---

# Zero Spawn

Load only.
`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(script, `#!/bin/sh\nprintf spawned > ${JSON.stringify(sentinel)}\n`),
        )

        const home = process.env.OPENCODE_TEST_HOME
        process.env.OPENCODE_TEST_HOME = dir
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            process.env.OPENCODE_TEST_HOME = home
          }),
        )

        const bunSpawn = spyOn(Bun, "spawn")
        const processSpawn = spyOn(Process, "spawn")
        try {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const result = yield* tool.execute(
            { name: "zero-spawn" },
            {
              ...baseCtx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                }),
            },
          )

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(result.output).toContain(`<skill_content name="zero-spawn">`)
          expect(result.output).toContain(`<file>${script}</file>`)
          expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(false)
          expect(bunSpawn).not.toHaveBeenCalled()
          expect(processSpawn).not.toHaveBeenCalled()
        } finally {
          bunSpawn.mockRestore()
          processSpawn.mockRestore()
        }
      }),
    30000,
  )
})
