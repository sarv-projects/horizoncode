import { expect } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.concurrent("legacy Git-backed snapshot debug commands are unavailable without creating snapshot state", ({
  opencode,
  home,
}) =>
  Effect.gen(function* () {
    const result = yield* opencode.spawn(["debug", "snapshot", "track"])
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.exitCode).not.toBe(0)
    expect(output).toContain("opencode debug config")
    expect(output).not.toContain("opencode debug snapshot")
    expect(existsSync(path.join(home, ".local/share/opencode/snapshot"))).toBe(false)
  }),
)
