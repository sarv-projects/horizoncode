import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep Guard gate", () => {
  it("keeps find, glob, and grep unavailable before resolving or spawning a process", () =>
    Effect.gen(function* () {
      expect(Ripgrep.ripgrepProcessRouteAvailable()).toBe(false)
      const ripgrep = yield* Ripgrep.Service
      const outcomes = yield* Effect.all([
        Effect.either(ripgrep.find({ cwd: ".", pattern: "*", limit: 1 })),
        Effect.either(ripgrep.glob({ cwd: ".", pattern: "*", limit: 1 })),
        Effect.either(ripgrep.grep({ cwd: ".", pattern: "needle", limit: 1 })),
      ])

      for (const outcome of outcomes) {
        expect(outcome._tag).toBe("Left")
        if (outcome._tag === "Left") {
          expect(outcome.left.message).toContain("Ripgrep is unavailable until HostKernel Guarded read execution is wired")
        }
      }
    }),
  )
})
