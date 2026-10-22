import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as SkillV2 from "@opencode-ai/core/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"

const digest = (content: string) => createHash("sha256").update(content).digest("hex")

describe("SkillV2 identity", () => {
  test("pins sealed built-in skills to canonical assets", () => {
    const integration = SkillV2.horizonCode()
    expect(integration.identity.id).toBe("builtin.horizoncode")
    expect(integration.location).toContain("horizon/skills/horizoncode/SKILL.md")

    const skill = SkillV2.horizonDocs()

    expect(skill.identity).toEqual({
      schemaVersion: 1,
      id: "builtin.horizon-docs",
      alias: "horizon-docs",
      source: "builtin",
      trust: "sealed_builtin",
      revision: `sha256:${digest(skill.content)}`,
    })
    expect(skill.location).toContain("horizon/skills/horizon-docs/SKILL.md")
    expect(() => SkillV2.horizonDocs({ content: skill.content, expectedRevision: "sha256:stale" })).toThrow(
      "canonical Horizon docs skill digest mismatch",
    )
  })

  test("keeps stable source identity independent of a shadowable alias and revisions content", () => {
    const base = {
      source: "project" as const,
      sourcePath: "/repo/.opencode/skills/review/SKILL.md",
      content: "review v1",
      alias: "review",
    }
    const first = SkillV2.identityFor(base)
    const renamed = SkillV2.identityFor({ ...base, alias: "renamed-review" })
    const changed = SkillV2.identityFor({ ...base, content: "review v2" })

    expect(first.id).toMatch(/^project\.[a-f0-9]{64}$/)
    expect(first.id).toBe(renamed.id)
    expect(first.alias).toBe("review")
    expect(first.trust).toBe("untrusted")
    expect(first.revision).toBe(`sha256:${digest("review v1")}`)
    expect(changed.id).toBe(first.id)
    expect(changed.revision).not.toBe(first.revision)
  })

  test("does not allow a project alias to replace the reserved skill and rejects ambiguous aliases", () => {
    const builtin = SkillV2.horizonDocs()
    const project = SkillV2.Info.make({
      name: "horizon-docs",
      location: AbsolutePath.make("/repo/skills/horizon-docs/SKILL.md"),
      content: "untrusted project content",
      identity: SkillV2.identityFor({
        source: "project",
        sourcePath: "/repo/skills/horizon-docs/SKILL.md",
        content: "untrusted project content",
        alias: "horizon-docs",
      }),
    })
    const remote = SkillV2.Info.make({
      name: "review",
      location: AbsolutePath.make("/cache/review/SKILL.md"),
      content: "remote content",
      identity: SkillV2.identityFor({
        source: "remote",
        sourcePath: "https://skills.example/review/SKILL.md",
        content: "remote content",
        alias: "review",
      }),
    })
    const other = SkillV2.Info.make({
      name: "review",
      location: AbsolutePath.make("/repo/skills/review/SKILL.md"),
      content: "project content",
      identity: SkillV2.identityFor({
        source: "project",
        sourcePath: "/repo/skills/review/SKILL.md",
        content: "project content",
        alias: "review",
      }),
    })

    expect(project.identity.trust).toBe("untrusted")
    expect(SkillV2.resolveSelection([builtin, project], "builtin.horizon-docs")?.identity.id).toBe(
      "builtin.horizon-docs",
    )
    expect(SkillV2.resolveSelection([builtin, project], "horizon-docs")).toBeUndefined()
    expect(SkillV2.resolveSelection([remote, other], "review")).toBeUndefined()
    expect(SkillV2.resolveSelection([remote, other], remote.identity.id)?.identity.id).toBe(remote.identity.id)
  })
})
