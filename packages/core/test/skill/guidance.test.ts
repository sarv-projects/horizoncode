import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@horizoncode/core/agent"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SkillV2 } from "@horizoncode/core/skill"
import { SystemContext } from "@horizoncode/core/system-context"
import { SkillGuidance } from "@horizoncode/core/skill/guidance"
import { it } from "../lib/effect"

const build = AgentV2.ID.make("build")
const makeSkill = (name: string, description: string | undefined, content: string) => {
  const sourcePath = path.resolve(`/skills/${name}/SKILL.md`)
  return SkillV2.Info.make({
    name,
    ...(description === undefined ? {} : { description }),
    location: AbsolutePath.make(sourcePath),
    content,
    identity: SkillV2.identityFor({ source: "project", sourcePath, content, alias: name }),
  })
}
const effect = makeSkill("effect", "Build applications with Effect", "Effect guidance")
const hidden = makeSkill("hidden", undefined, "Undescribed guidance")
const denied = makeSkill("denied", "Must not be advertised", "Denied guidance")

const layer = (list: () => SkillV2.Info[]) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed(list()) })],
  ])

describe("SkillGuidance", () => {
  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: denied.identity.id, effect: "deny" }],
    })
    let skills = [hidden, denied, effect]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(initialized.baseline).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          `    <id>${effect.identity.id}</id>`,
          "    <alias>effect</alias>",
          "    <source>project</source>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      skills = []
      expect(
        yield* guidance
          .load({ id: agent.id, info: agent })
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: effect.identity.id, effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: effect.identity.id, effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain(`<id>${effect.identity.id}</id>`)
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: effect.identity.id, effect: "allow" },
        { action: "skill", resource: effect.identity.id, effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })
})
