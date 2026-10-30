import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@horizoncode/core/agent"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { SkillV2 } from "@horizoncode/core/skill"
import { SkillGuidance } from "@horizoncode/core/skill/guidance"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SystemContext } from "@horizoncode/core/system-context"
import { it } from "./lib/effect"

const builtin = SkillV2.horizonDocs()
const external = (sourcePath: string, alias: string) => {
  const content = `# ${alias}`
  return SkillV2.Info.make({
    name: alias,
    description: `${alias} instructions`,
    location: AbsolutePath.make(sourcePath),
    content,
    identity: SkillV2.identityFor({ source: "project", sourcePath, content, alias }),
  })
}

const ids = new Set([external("/workspace/a/SKILL.md", "review"), external("/workspace/b/SKILL.md", "review")])
const skills = Layer.succeed(
  SkillV2.Service,
  SkillV2.Service.of({
    transform: () => Effect.die("unused"),
    reload: () => Effect.die("unused"),
    sources: () => Effect.succeed([]),
    list: () => Effect.succeed([builtin, ...ids]),
  }),
)
const layer = AppNodeBuilder.build(SkillGuidance.node, [[SkillV2.node, skills]])

describe("SkillGuidance", () => {
  it.effect("projects stable IDs, aliases, and trust source into available skill guidance", () =>
    Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const agentID = AgentV2.ID.make("build")
      const agent = AgentV2.Info.empty(agentID)
      const generation = yield* SystemContext.initialize(
        yield* guidance.load({ id: agentID, info: agent }),
      )

      expect(generation.baseline).toContain(`<id>${builtin.identity.id}</id>`)
      expect(generation.baseline).toContain(`<alias>${builtin.identity.alias}</alias>`)
      expect(generation.baseline).toContain("<source>builtin</source>")
      for (const skill of ids) {
        expect(generation.baseline).toContain(`<id>${skill.identity.id}</id>`)
        expect(generation.baseline).toContain(`<alias>${skill.identity.alias}</alias>`)
        expect(generation.baseline).toContain("<source>project</source>")
      }
      expect(generation.baseline).not.toContain("<id>review</id>")
    }).pipe(Effect.provide(layer)),
  )
})
