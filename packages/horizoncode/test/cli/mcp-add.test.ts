import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "refuses a remote server before changing config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "MCP configuration is unavailable until guarded execution is implemented",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(home, ".config", "opencode", "opencode.json")).exists())).toBe(
          false,
        )
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses a local server before changing config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "MCP configuration is unavailable until guarded execution is implemented",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(home, ".config", "opencode", "opencode.json")).exists())).toBe(
          false,
        )
      }),
    60_000,
  )
})
