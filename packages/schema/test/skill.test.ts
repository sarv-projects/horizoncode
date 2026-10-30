import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Skill } from "../src/skill"

const docsRevision = "sha256:28fb74ebf91729f5f62f6342bcd0c21f25fbb72487afdaba239317d215526fee"
const horizoncodeRevision = "sha256:b784cb02d1655c7606bfc6548d17de2b237ca28e02c7e58b0f57c1c5ffece90f"

describe("SkillV2.Identity", () => {
  test("accepts canonical sealed builtin identities", () => {
    for (const identity of [
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "horizon-docs",
        source: "builtin",
        trust: "sealed_builtin",
        revision: docsRevision,
      },
      {
        schemaVersion: 1,
        id: "builtin.horizoncode",
        alias: "horizoncode",
        source: "builtin",
        trust: "sealed_builtin",
        revision: horizoncodeRevision,
      },
    ]) {
      expect(Schema.decodeUnknownSync(Skill.Identity)(identity)).toMatchObject({
        id: identity.id,
        source: "builtin",
        trust: "sealed_builtin",
      })
    }
  })

  test("rejects shadowed builtin IDs, noncanonical sealed builtins, and sealed project skills", () => {
    for (const identity of [
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "horizon-docs",
        source: "project",
        trust: "untrusted",
        revision: docsRevision,
      },
      {
        schemaVersion: 1,
        id: "builtin.other",
        alias: "other",
        source: "builtin",
        trust: "sealed_builtin",
        revision: docsRevision,
      },
      {
        schemaVersion: 1,
        id: "project.abc",
        alias: "review",
        source: "project",
        trust: "sealed_builtin",
        revision: docsRevision,
      },
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "renamed-horizon-docs",
        source: "builtin",
        trust: "sealed_builtin",
        revision: docsRevision,
      },
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "horizon-docs",
        source: "builtin",
        trust: "sealed_builtin",
        revision: "sha256:" + "0".repeat(64),
      },
    ]) {
      expect(() => Schema.decodeUnknownSync(Skill.Identity)(identity)).toThrow()
    }
  })

  test("accepts only untrusted, nonreserved identities from external sources", () => {
    for (const source of ["project", "user", "remote"] as const) {
      expect(
        Schema.decodeUnknownSync(Skill.Identity)({
          schemaVersion: 1,
          id: `${source}.${"a".repeat(64)}`,
          alias: "review",
          source,
          trust: "untrusted",
          revision: docsRevision,
        }),
      ).toMatchObject({ source, trust: "untrusted" })
    }
  })
})

describe("SkillV2 builtin roster", () => {
  test("accepts every canonical shipped builtin identity", () => {
    const entries = Object.entries(Skill.SealedBuiltinIdentitiesV1)
    expect(entries.length).toBe(16)
    for (const [id, identity] of entries) {
      expect(
        Schema.decodeUnknownSync(Skill.Identity)({
          schemaVersion: 1,
          id,
          alias: identity.alias,
          source: "builtin",
          trust: "sealed_builtin",
          revision: identity.revision,
        }),
      ).toMatchObject({ id, source: "builtin", trust: "sealed_builtin" })
    }
  })

  test("rejects unshipped builtin IDs, wrong aliases and noncanonical revisions", () => {
    for (const identity of [
      {
        schemaVersion: 1,
        id: "builtin.mystery",
        alias: "mystery",
        source: "builtin",
        trust: "sealed_builtin",
        revision: Skill.SealedBuiltinIdentitiesV1["builtin.test-debug"].revision,
      },
      {
        schemaVersion: 1,
        id: "builtin.test-debug",
        alias: "wrong-alias",
        source: "builtin",
        trust: "sealed_builtin",
        revision: Skill.SealedBuiltinIdentitiesV1["builtin.test-debug"].revision,
      },
      {
        schemaVersion: 1,
        id: "builtin.test-debug",
        alias: "test-debug",
        source: "builtin",
        trust: "sealed_builtin",
        revision: docsRevision,
      },
    ]) {
      expect(() => Schema.decodeUnknownSync(Skill.Identity)(identity)).toThrow()
    }
  })
})
