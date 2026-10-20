import { expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.concurrent("effectful MCP, auth, console, and plugin CLI routes fail closed", ({ opencode, home }) =>
  Effect.gen(function* () {
    const fakeBin = path.join(home, "fake-bin")
    const processLog = path.join(home, "unexpected-effect-process.log")
    mkdirSync(fakeBin, { recursive: true })
    for (const executable of [
      "npm",
      "pnpm",
      "bun",
      "yarn",
      "git",
      "node",
      "open",
      "xdg-open",
      "cmd",
      "powershell",
    ]) {
      const shim = path.join(fakeBin, executable)
      writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$EFFECT_ORIGIN_LOG"\nexit 0\n`)
      chmodSync(shim, 0o755)
    }

    const commands = [
      ["mcp", "add", "guard-probe", "--url", "https://example.invalid/mcp"],
      ["mcp", "auth", "guard-probe"],
      ["mcp", "logout", "guard-probe"],
      ["mcp", "debug", "guard-probe"],
      ["plugin", "@example/guard-probe"],
      ["providers", "login", "--provider", "openai"],
      ["providers", "logout", "openai"],
      ["auth", "login", "--provider", "openai"],
      ["auth", "logout", "openai"],
      ["console", "login", "https://example.invalid"],
      ["console", "logout", "account@example.invalid"],
      ["console", "switch"],
      ["console", "orgs"],
      ["console", "open"],
    ]

    for (const command of commands) {
      const result = yield* opencode.spawn(command, {
        env: {
          EFFECT_ORIGIN_LOG: processLog,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      })
      const output = `${result.stdout}\n${result.stderr}`
      if (result.exitCode === 0) throw new Error(`Expected denial for ${command.join(" ")}: ${output}`)
      expect(result.exitCode).not.toBe(0)
      expect(output).toContain("unavailable until guarded execution is implemented")
    }

    expect(existsSync(processLog)).toBe(false)
    expect(existsSync(path.join(home, ".config/opencode/opencode.json"))).toBe(false)
    expect(existsSync(path.join(home, ".local/share/opencode/auth.json"))).toBe(false)
  }),
  120_000,
)

cliIt.concurrent(
  "providers list is unavailable before ModelsDev network and cache effects",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const requests: string[] = []
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.url)
          return Response.json({})
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

      const result = yield* opencode.spawn(["providers", "list"], {
        env: {
          OPENCODE_DISABLE_MODELS_FETCH: "0",
          OPENCODE_MODELS_URL: `http://127.0.0.1:${server.port}`,
        },
      })
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.exitCode).not.toBe(0)
      expect(output).toContain("unavailable until guarded execution is implemented")
      expect(requests).toEqual([])

      const cacheDir = path.join(home, ".cache", "opencode")
      const modelCaches = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => /^models(?:-|\\.)/.test(name)) : []
      expect(modelCaches).toEqual([])
    }),
  120_000,
)
