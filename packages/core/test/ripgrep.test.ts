import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Ripgrep } from "@horizoncode/core/ripgrep"
import { RipgrepBinary } from "@horizoncode/core/ripgrep/binary"
import { AbsolutePath, RelativePath } from "@horizoncode/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep Guard gate", () => {
  test("keeps archive extraction unavailable without a Guarded HostKernel process route", () => {
    expect(RipgrepBinary.extractionRouteAvailable()).toBe(false)
    const source = readFileSync(new URL("../src/ripgrep/binary.ts", import.meta.url), "utf8")
    expect(source).not.toContain("ChildProcessSpawner")
    expect(source).not.toContain("spawner.spawn")
    expect(source).not.toContain("powershell.exe")
    expect(source).not.toContain('run("tar"')
    expect(source).not.toContain("HttpClientRequest")
  })

  test("keeps the search adapter free of any child-process route", () => {
    const source = readFileSync(new URL("../src/ripgrep.ts", import.meta.url), "utf8")
    expect(source).not.toContain("ChildProcess")
    expect(source).not.toContain("spawn(")
    expect(source).not.toContain("AppProcess")
    expect(source).not.toContain("powershell.exe")
  })

  test("reports availability from the in-process backend instead of an unconditional false", () => {
    // The old fail-closed stub returned false no matter what; availability now
    // mirrors whether a backend can actually answer a query.
    expect(Ripgrep.ripgrepProcessRouteAvailable()).toBe(Ripgrep.searchBackendAvailable())
    expect(Ripgrep.searchBackendAvailable()).toBe(true)
  })

  it.live("serves grep, glob, and find from a temp tree in-process", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "a.ts"), "export const needle = 1\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "b.txt"), "needle\n"))
        const ripgrep = yield* Ripgrep.Service

        const grepped = yield* ripgrep.grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(grepped.map((match) => `${match.entry.path}:${match.line}`)).toEqual(["src/a.ts:1"])
        expect(grepped[0]?.submatches[0]?.text).toBe("needle")

        const globbed = yield* ripgrep.glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(globbed.map((entry) => entry.path)).toEqual([RelativePath.make("src/a.ts")])

        const found = yield* ripgrep.find({ cwd, pattern: "!**/a.ts", limit: 10 })
        expect(found.map((entry) => entry.path)).toEqual([RelativePath.make("src/b.txt")])
      }),
    ),
  )

  it.live("never returns a path outside the searched root", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "inside.ts"), "needle\n"))
        const ripgrep = yield* Ripgrep.Service
        const globbed = yield* ripgrep.glob({ cwd, pattern: "**/*.ts", limit: 10 })
        for (const entry of globbed) {
          expect(path.isAbsolute(entry.path)).toBe(false)
          expect(entry.path.startsWith("..")).toBe(false)
        }
        expect(globbed.map((entry) => entry.path)).toEqual([RelativePath.make("inside.ts")])
      }),
    ),
  )
})
