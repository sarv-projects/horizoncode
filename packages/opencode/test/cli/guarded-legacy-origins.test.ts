import { expect } from "bun:test"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.concurrent("legacy CLI process and mutation routes fail closed without side effects", ({ opencode, home }) =>
  Effect.gen(function* () {
    const shareRequests: string[] = []
    const shareServer = Bun.serve({
      port: 0,
      fetch(request) {
        shareRequests.push(request.url)
        return Response.json([])
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => shareServer.stop(true)))

    const fakeBin = path.join(home, "fake-bin")
    const processLog = path.join(home, "unexpected-process.log")
    mkdirSync(fakeBin, { recursive: true })
    for (const executable of [
      "git", "gh", "opencode", "sqlite3", "npm", "pnpm", "yarn", "brew", "scoop", "choco", "less", "more", "cmd",
    ]) {
      const shim = path.join(fakeBin, executable)
      writeFileSync(
        shim,
        `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$EFFECT_ORIGIN_LOG"\nexit 0\n`,
      )
      chmodSync(shim, 0o755)
    }
    const importResult = yield* opencode.spawn(["import", `http://127.0.0.1:${shareServer.port}/share/p1_import_probe`])
    expect(importResult.exitCode).not.toBe(0)
    expect(`${importResult.stdout}\n${importResult.stderr}`).toContain(
      "Session import is unavailable until guarded execution is implemented",
    )
    expect(shareRequests).toEqual([])
    expect(existsSync(path.join(home, ".local/share/opencode/opencode.db"))).toBe(false)

    const commands = [
      ["github", "install"],
      ["github", "run", "--event", "{}", "--token", "secret-test-token"],
      ["pr", "7"],
      ["db", "CREATE TABLE p1_unguarded_probe (value TEXT)"],
      ["db"],
      ["session", "delete", "ses_p1_unguarded_probe"],
      ["agent", "create", "--path", home, "--description", "probe", "--mode", "all", "--permissions", "read"],
      ["uninstall", "--force"],
    ]

    for (const command of commands) {
      const result = yield* opencode.spawn(command, {
        env: {
          GITHUB_TOKEN: "secret-test-token",
          EFFECT_ORIGIN_LOG: processLog,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      })
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.exitCode).not.toBe(0)
      expect(output).toContain("unavailable until guarded execution is implemented")
      expect(output).not.toContain("secret-test-token")
    }

    expect(existsSync(processLog)).toBe(false)
    expect(existsSync(path.join(home, ".local/share/opencode/snapshot"))).toBe(false)
    expect(existsSync(path.join(home, ".github/workflows/opencode.yml"))).toBe(false)

    const sessions = yield* opencode.spawn(["session", "list"], {
      env: {
        EFFECT_ORIGIN_LOG: processLog,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    })
    expect(sessions.exitCode).toBe(0)
    expect(existsSync(processLog)).toBe(false)
  }),
  90_000,
)
