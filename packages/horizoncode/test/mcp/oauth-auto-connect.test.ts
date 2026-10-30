import { expect } from "bun:test"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { Effect, Exit } from "effect"
import { MCP } from "@/mcp"
import { createMcpHarness, testDirectory, withMcpInstance } from "./unavailable"

const directory = testDirectory()
let remoteURL = ""
let requests = 0
const harness = createMcpHarness(
  () =>
    ({
      mcp: { remote: { type: "remote", url: remoteURL, oauth: {} } },
    }) as ConfigV1.Info,
)

harness.it.effect(
  "configured OAuth MCP servers are not contacted or authenticated during startup",
  withMcpInstance(
    directory,
    Effect.gen(function* () {
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
      remoteURL = server.url.href
      const mcp = yield* MCP.Service
      const configured = yield* mcp.status()
      expect(configured.remote?.status).toBe("failed")
      const connect = yield* mcp.connect("remote").pipe(Effect.exit)
      expect(Exit.isFailure(connect)).toBe(true)
      expect(requests).toBe(0)
      expect(yield* mcp.clients()).toEqual({})
    }),
  ),
)
