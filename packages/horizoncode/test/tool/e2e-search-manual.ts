/**
 * Manual end-to-end check for the repaired search path.
 *
 * Builds the same layer group the tool tests use, resolves the `grep`/`glob`
 * tools from the registry, and runs them against a throwaway tree. Prints the
 * real `file:line` pairs the model would see.
 *
 *   cd packages/horizoncode && bun test/tool/e2e-search-manual.ts
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Ripgrep } from "@horizoncode/core/ripgrep"
import { Truncate } from "@/tool/truncate"
import { Git } from "@/git"
import { MessageID, SessionID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"

const toolLayer = () =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const ctx = {
  sessionID: SessionID.make("ses_e2e"),
  messageID: MessageID.make("msg_e2e"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

/** Pull `path:line` pairs back out of the rendered tool output. */
const pairs = (output: string, root: string) => {
  const found: string[] = []
  let current = ""
  for (const line of output.split("\n")) {
    if (line.endsWith(":") && !line.startsWith("  ")) {
      current = path.relative(root, line.slice(0, -1))
      continue
    }
    const match = /^ {2}Line (\d+): /u.exec(line)
    if (match?.[1]) found.push(`${current}:${match[1]}`)
  }
  return found
}

const program = Effect.gen(function* () {
  const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "hc-grep-e2e-")))
  yield* Effect.promise(() => fs.mkdir(path.join(dir, "src"), { recursive: true }))
  yield* Effect.promise(() => fs.mkdir(path.join(dir, "docs"), { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "src", "app.ts"), "// header\nexport const needle = 1\n"))
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "src", "data.json"), '{"needle": true}\n'))
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "docs", "readme.md"), "# needle docs\n"))
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "src", "haystack.ts"), "export const haystack = 2\n"))

  const scoped = provideInstance(dir)
  const grep = yield* (yield* GrepTool).init()
  const glob = yield* (yield* GlobTool).init()

  console.log(`workspace: ${dir}`)
  console.log(`backend available: ${Ripgrep.searchBackendAvailable()}`)
  console.log("")

  const filtered = yield* scoped(grep.execute({ pattern: "needle", path: dir, include: "*.ts" }, ctx))
  console.log('[1] grep "needle" include="*.ts"')
  console.log(filtered.output)
  console.log(`matches=${filtered.metadata.matches} -> ${pairs(filtered.output, dir).join(", ")}`)
  console.log("")

  const all = yield* scoped(grep.execute({ pattern: "needle.*", path: dir }, ctx))
  console.log('[2] grep regex "needle.*" (no include)')
  console.log(`matches=${all.metadata.matches} -> ${pairs(all.output, dir).join(", ")}`)
  console.log("")

  const globbed = yield* scoped(glob.execute({ pattern: "**/*.ts", path: dir }, ctx))
  console.log('[3] glob "**/*.ts"')
  console.log(`count=${globbed.metadata.count}`)
  console.log(
    globbed.output
      .split("\n")
      .map((line) => path.relative(dir, line) || line)
      .join("\n"),
  )
  console.log("")

  const none = yield* scoped(grep.execute({ pattern: "absent-needle-xyz", path: dir }, ctx))
  console.log(`[4] grep miss -> ${JSON.stringify(none.output)}`)
  yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
})

program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(toolLayer(), testInstanceStoreLayer)), Effect.runPromise).then(
  () => process.exit(0),
  (error) => {
    console.error("E2E FAILED:", error)
    process.exit(1)
  },
)
