import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.concurrent("MCP debug rejects before sending a request to the configured server", ({ opencode }) =>
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
    const result = yield* opencode.spawn(["mcp", "debug", "remote"], {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: { remote: { type: "remote", url: server.url.href, enabled: true, oauth: {} } },
        }),
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("MCP connections are unavailable")
    expect(requests).toBe(0)
  }),
)
cliIt.concurrent("MCP auth reports unavailability and exits unsuccessfully without sending a request", ({ opencode }) =>
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
    const result = yield* opencode.spawn(["mcp", "auth", "remote"], {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: { remote: { type: "remote", url: server.url.href, enabled: true, oauth: {} } },
        }),
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("MCP connections are unavailable")
    expect(requests).toBe(0)
  }),
)
