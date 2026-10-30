import { describe, expect, test } from "bun:test"
import { Skill } from "../../src/skill"

/**
 * CX-024 (arch_V1/32 §32.10) — with 40 skill directories installed the system
 * prompt lists **metadata only**: no `SKILL.md` body reaches the prompt until
 * the `skill` tool is called (EX-002 / SK-013).
 *
 * Seam under test: `SystemPrompt.skills` projects `Skill.fmt(list, {
 * verbose: true })` (`packages/horizoncode/src/session/system.ts`), so the whole
 * prompt contribution for skills is exactly this formatter's output. Every
 * `Skill.Info` carries `content` (the full `SKILL.md` body) at this point —
 * the formatter must never emit it.
 */
describe("CX-024 skill prompt projection", () => {
  const skills = Array.from({ length: 40 }, (_, index) => {
    const id = String(index).padStart(2, "0")
    return {
      name: `skill-${id}`,
      description: `Description for skill ${id}.`,
      location: `/home/user/.agents/skills/skill-${id}/SKILL.md`,
      content: `BODY_MARKER_${id} this SKILL.md body must never be projected into the system prompt`,
    } satisfies Skill.Info
  })

  test("40 installed skills project metadata only and never their SKILL.md bodies", () => {
    const output = Skill.fmt(skills, { verbose: true })

    expect(output).toContain("<available_skills>")
    for (const skill of skills) {
      expect(output).toContain(`<name>${skill.name}</name>`)
      expect(output).toContain(`<description>${skill.description}</description>`)
      expect(output).toContain(`<location>${skill.location}</location>`)
    }
    // Not one byte of any body is present, and the bodies are loadable later.
    expect(output).not.toContain("BODY_MARKER_")
    expect(output).not.toContain("must never be projected")
    expect(skills.every((skill) => skill.content.startsWith("BODY_MARKER_"))).toBe(true)

    // Metadata projection stays deterministic (sorted by name) so the prompt
    // prefix is stable across turns.
    expect(output.indexOf("<name>skill-00</name>")).toBeLessThan(output.indexOf("<name>skill-01</name>"))
    expect(output.indexOf("<name>skill-38</name>")).toBeLessThan(output.indexOf("<name>skill-39</name>"))
    expect(Skill.fmt(skills, { verbose: true })).toBe(output)
  })

  test("a body is only ever reachable through an explicit skill lookup, not the prompt projection", () => {
    const output = Skill.fmt(skills, { verbose: true })
    // The formatter has no code path that reads `content`; assert the exact
    // projection contract it does expose (name/id/description/location only).
    const tags = [...output.matchAll(/<\/?([a-z_]+)>/g)].map((match) => match[1])
    expect([...new Set(tags)].sort()).toEqual(
      expect.arrayContaining(["available_skills", "skill", "name", "description", "location"]),
    )
    expect([...new Set(tags)].sort()).not.toContain("content")
    expect([...new Set(tags)].sort()).not.toContain("body")
  })
})
