import { expect } from "bun:test"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { Effect, Exit } from "effect"
import { MCP } from "@/mcp"
import { createMcpHarness, testDirectory, withMcpInstance } from "./unavailable"

const directory = testDirectory()
let remoteURL = ""
const harness = createMcpHarness(
  () =>
    ({
      mcp: { remote: { type: "remote", url: remoteURL, oauth: {} } },
    }) as ConfigV1.Info,
)

harness.it.effect(
  "MCP OAuth requests do not open a browser, call the server, or accept callback credentials",
  withMcpInstance(
    directory,
    Effect.gen(function* () {
      let requests = 0
      let browserLaunches = 0
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

      const start = yield* mcp.startAuth("remote").pipe(Effect.exit)
      expect(Exit.isFailure(start)).toBe(true)
      const authenticated = yield* mcp.authenticate("remote", () => browserLaunches++).pipe(Effect.exit)
      expect(Exit.isFailure(authenticated)).toBe(true)
      const callback = yield* mcp.finishAuth("remote", "untrusted-authorization-code").pipe(Effect.exit)
      expect(Exit.isFailure(callback)).toBe(true)
      expect(browserLaunches).toBe(0)
      expect(requests).toBe(0)
    }),
  ),
)
