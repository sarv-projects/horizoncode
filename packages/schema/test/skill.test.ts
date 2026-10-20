import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Skill } from "../src/skill"

const revision = "sha256:83d9a8e079486da8b673158cf2c2527ddb690eb55e56147c75b4d6489b3bb74e"

describe("SkillV2.Identity", () => {
  test("accepts the one canonical sealed builtin identity", () => {
    expect(
      Schema.decodeUnknownSync(Skill.Identity)({
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "horizon-docs",
        source: "builtin",
        trust: "sealed_builtin",
        revision,
      }),
    ).toMatchObject({ id: "builtin.horizon-docs", source: "builtin", trust: "sealed_builtin" })
  })

  test("rejects shadowed builtin IDs, noncanonical sealed builtins, and sealed project skills", () => {
    for (const identity of [
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "horizon-docs",
        source: "project",
        trust: "untrusted",
        revision,
      },
      {
        schemaVersion: 1,
        id: "builtin.other",
        alias: "other",
        source: "builtin",
        trust: "sealed_builtin",
        revision,
      },
      {
        schemaVersion: 1,
        id: "project.abc",
        alias: "review",
        source: "project",
        trust: "sealed_builtin",
        revision,
      },
      {
        schemaVersion: 1,
        id: "builtin.horizon-docs",
        alias: "renamed-horizon-docs",
        source: "builtin",
        trust: "sealed_builtin",
        revision,
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
          revision,
        }),
      ).toMatchObject({ source, trust: "untrusted" })
    }
  })
})
