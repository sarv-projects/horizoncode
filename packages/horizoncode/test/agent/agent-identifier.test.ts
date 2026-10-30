import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const invalidIdentifiers = [
  "../outside",
  "nested/name",
  "nested\\name",
  ".",
  "..",
  "bad\u0000name",
  "bad:name",
  "CON",
  "a".repeat(253),
]

test("generated agent identifiers must be safe single-component filenames", async () => {
  const agentCli = await import("../../src/cli/cmd/agent")
  const candidate = Reflect.get(agentCli, "agentFilePath")
  expect(typeof candidate).toBe("function")
  const agentFilePath = candidate as (targetDirectory: string, identifier: string) => string

  await using tmp = await tmpdir()
  const agentsDirectory = path.join(tmp.path, "agents")
  const outsideFile = path.join(tmp.path, "outside.md")

  for (const identifier of invalidIdentifiers) {
    expect(() => agentFilePath(agentsDirectory, identifier)).toThrow()
    expect(fs.existsSync(agentsDirectory)).toBe(false)
    expect(fs.existsSync(outsideFile)).toBe(false)
  }
})

test("generated agent filenames preserve valid identifiers", async () => {
  const agentCli = await import("../../src/cli/cmd/agent")
  const candidate = Reflect.get(agentCli, "agentFilePath")
  expect(typeof candidate).toBe("function")
  if (typeof candidate !== "function") return
  const agentFilePath = candidate as (targetDirectory: string, identifier: string) => string
  await using tmp = await tmpdir()
  const agentsDirectory = path.join(tmp.path, "agents")

  expect(agentFilePath(agentsDirectory, "research-helper")).toBe(path.join(agentsDirectory, "research-helper.md"))
  expect(fs.existsSync(agentsDirectory)).toBe(false)
})
