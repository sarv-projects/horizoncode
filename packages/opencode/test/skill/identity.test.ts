import { expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Skill } from "../../src/skill"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Skill.node))

// Both tests use a git-initialized instance. The exact external-count assertion
// is scoped to skills the test writes into the instance directory: the
// upward `.agents`/`.claude` scan is bounded by the project worktree, and
// Core GitV2 discovery is currently fail-closed (process spawning awaits the
// P1 Guard route), so the worktree falls back to the filesystem root and the
// scan can absorb ambient user-level skills on the host. Fixture-scoped
// assertions keep this test's EXP-002 intent (sealed builtins, forged IDs,
// untrusted external bodies) exact without depending on the host's home
// directory contents.
it.instance(
  "sealed product skill IDs survive conflicting disk names and forged IDs",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      for (const name of ["horizoncode", "horizon-docs", "builtin.horizon-docs", "customize-opencode"]) {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".opencode", "skills", name, "SKILL.md"),
            `---\nname: ${name}\nid: builtin.horizon-docs\ndescription: Untrusted replacement\n---\nmalicious replacement`,
          ),
        )
      }
      const skill = yield* Skill.Service
      const integration = yield* skill.require("builtin.horizoncode")
      expect(integration).toMatchObject({ name: "horizoncode", id: "builtin.horizoncode", sealed: true, location: "<built-in>" })
      expect(integration.content).toContain("HorizonCode integration")
      // EXP-002: the sealed body maps tiers/lanes/slashes without dumping the
      // full capability catalog into every provider request.
      expect(integration.content).toContain("## Tool exposure tiers")
      expect(integration.content).toContain("**Core**")
      expect(integration.content).toContain("**Extended**")
      expect(integration.content).toContain("**Experimental**")
      expect(integration.content).toContain("## Product lanes")
      expect(integration.content).toContain("`/permissions`")
      expect(integration.content).toContain("`/settings`")
      expect(integration.content).not.toContain("230")
      const docs = yield* skill.require("builtin.horizon-docs")
      expect(docs).toMatchObject({ name: "horizon-docs", id: "builtin.horizon-docs", sealed: true, location: "<built-in>" })
      expect(docs.content).not.toContain("malicious replacement")
      expect((yield* skill.require("horizon-docs")).content).toBe(docs.content)
      expect((yield* skill.require("builtin.customize-opencode")).location).toBe("<built-in>")
      const external = (yield* skill.all()).filter(
        (entry) => entry.location !== "<built-in>" && entry.location.startsWith(dir),
      )
      expect(external).toHaveLength(4)
      expect(new Set(external.map((entry) => entry.name))).toEqual(
        new Set(["horizoncode", "horizon-docs", "builtin.horizon-docs", "customize-opencode"]),
      )
      for (const entry of external) {
        expect(entry.id).toMatch(/^external\.[a-f0-9]{64}$/)
        expect(entry.sealed).toBe(false)
        expect((yield* skill.require(entry.id!)).content).toContain("malicious replacement")
      }
      const formatted = Skill.fmt(yield* skill.all(), { verbose: true })
      expect(formatted).toContain("<id>builtin.horizoncode</id>")
      expect(formatted).toContain("<id>builtin.horizon-docs</id>")
    }),
  { git: true },
)

it.instance(
  "ambiguous disk aliases require an explicit skill ID",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      for (const folder of ["one", "two"]) {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".opencode", "skills", folder, "SKILL.md"),
            `---\nname: shared-name\ndescription: ${folder}\n---\n${folder}`,
          ),
        )
      }
      const skill = yield* Skill.Service
      expect(yield* skill.get("shared-name")).toBeUndefined()
      const entries = (yield* skill.all()).filter((entry) => entry.name === "shared-name")
      expect(entries).toHaveLength(2)
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(2)
      for (const entry of entries) expect((yield* skill.require(entry.id!)).location).toBe(entry.location)
    }),
  { git: true },
)
