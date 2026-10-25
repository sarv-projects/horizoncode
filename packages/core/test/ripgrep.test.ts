import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

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

  it.effect("keeps find, glob, and grep unavailable before resolving or spawning a process", () =>
    Effect.gen(function* () {
      expect(Ripgrep.ripgrepProcessRouteAvailable()).toBe(false)
      const ripgrep = yield* Ripgrep.Service
      const outcomes = yield* Effect.all([
        Effect.result(ripgrep.find({ cwd: ".", pattern: "*", limit: 1 })),
        Effect.result(ripgrep.glob({ cwd: ".", pattern: "*", limit: 1 })),
        Effect.result(ripgrep.grep({ cwd: ".", pattern: "needle", limit: 1 })),
      ])

      for (const outcome of outcomes) {
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure") {
          expect(outcome.failure.message).toContain(
            "Ripgrep is unavailable until HostKernel Guarded read execution is wired",
          )
        }
      }
    }),
  )
})
