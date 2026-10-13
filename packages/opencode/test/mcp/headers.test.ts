import { expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Exit } from "effect"
import { MCP } from "@/mcp"
import { createMcpHarness, testDirectory, withMcpInstance } from "./unavailable"

const directory = testDirectory()
const harness = createMcpHarness({ mcp: {} } as ConfigV1.Info)

harness.it.effect(
  "MCP registration never forwards configured headers to a remote server",
  withMcpInstance(
    directory,
    Effect.gen(function* () {
      let requests = 0
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => {
              requests++
              return new Response("unexpected MCP request")
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const mcp = yield* MCP.Service
      const result = yield* mcp
        .add("remote", {
          type: "remote",
          url: server.url.href,
          headers: { authorization: "Bearer test-secret" },
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(requests).toBe(0)
    }),
  ),
)
