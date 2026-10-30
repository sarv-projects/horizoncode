import { describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "fs/promises"
import path from "path"
import { MAX_DOTENV_BYTES, loadProjectDotEnv, parseDotEnv } from "../../src/env/dotenv"
import { tmpdir } from "../fixture/fixture"

describe("parseDotEnv", () => {
  test("parses assignments, comments, quotes, CRLF and BOM", () => {
    const entries = parseDotEnv(
      "\uFEFF# comment\r\n\r\nexport OPENROUTER_API_KEY=sk-or-v1-secret\r\nQUOTED=\"a b\"\r\nSINGLE='c=d'\nEMPTY=\nWITH_EQUALS=a=b=c\n",
    )
    expect(entries).toEqual([
      { name: "OPENROUTER_API_KEY", value: "sk-or-v1-secret" },
      { name: "QUOTED", value: "a b" },
      { name: "SINGLE", value: "c=d" },
      { name: "EMPTY", value: "" },
      { name: "WITH_EQUALS", value: "a=b=c" },
    ])
  })

  test("skips comments, blank lines and malformed assignments", () => {
    expect(parseDotEnv("# only a comment\n\nno-equals\n=orphan\n1BAD=name\nGOOD=yes\nBAD NAME=x\n")).toEqual([
      { name: "GOOD", value: "yes" },
    ])
  })
})

describe("loadProjectDotEnv", () => {
  test("loads a project .env and reports names only", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".env"), "OPENROUTER_API_KEY=sk-or-v1-topsecret\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = {}
    const result = await loadProjectDotEnv({ directory: tmp.path, env })
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-topsecret")
    expect(result).toEqual({ applied: ["OPENROUTER_API_KEY"], skipped: [] })
    expect(JSON.stringify(result)).not.toContain("topsecret")
  })

  test("a missing .env is a silent no-op", async () => {
    await using tmp = await tmpdir()
    const env: Record<string, string | undefined> = {}
    expect(await loadProjectDotEnv({ directory: tmp.path, env })).toEqual({ applied: [], skipped: [] })
  })

  test("never overrides an already-exported variable", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".env"), "OPENROUTER_API_KEY=from-file\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "from-shell" }
    const result = await loadProjectDotEnv({ directory: tmp.path, env })
    expect(env.OPENROUTER_API_KEY).toBe("from-shell")
    expect(result).toEqual({ applied: [], skipped: ["OPENROUTER_API_KEY"] })
  })

  test.if(process.platform !== "win32")("refuses a file writable by group or others", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".env")
    await writeFile(file, "OPENROUTER_API_KEY=sk-or-v1-loose\n", { mode: 0o600 })
    await chmod(file, 0o664)
    const env: Record<string, string | undefined> = {}
    const result = await loadProjectDotEnv({ directory: tmp.path, env })
    expect(result.refused).toContain("writable by group or others")
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
  })

  test("refuses a file larger than the size cap", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, ".env"), `OPENROUTER_API_KEY=${"x".repeat(MAX_DOTENV_BYTES)}\n`, {
      mode: 0o600,
    })
    const env: Record<string, string | undefined> = {}
    const result = await loadProjectDotEnv({ directory: tmp.path, env })
    expect(result.refused).toContain("64 KiB")
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
  })

  test("refuses a directory named .env", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".env"))
    const result = await loadProjectDotEnv({ directory: tmp.path, env: {} })
    expect(result.refused).toBe("not a regular file")
  })
})