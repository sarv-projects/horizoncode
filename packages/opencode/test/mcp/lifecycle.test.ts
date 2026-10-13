import { expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Exit } from "effect"
import path from "node:path"
import { MCP } from "@/mcp"
import { createMcpHarness, markerCommand, testDirectory, withMcpInstance } from "./unavailable"

const directory = testDirectory()
const marker = path.join(directory, "mcp-command-started")
const harness = createMcpHarness({
  mcp: { local: { type: "local", command: markerCommand(marker) } },
} as ConfigV1.Info)

harness.it.effect(
  "repeated MCP connect attempts remain unavailable without starting a local server",
  withMcpInstance(
    directory,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = yield* mcp.connect("local").pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect((yield* mcp.status()).local?.status).toBe("failed")
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }
      expect(yield* mcp.clients()).toEqual({})
    }),
  ),
)
