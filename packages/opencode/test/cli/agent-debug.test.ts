import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

cliIt.concurrent("debug agent ask permission cannot perform webfetch", ({ opencode }) =>
  Effect.gen(function* () {
    let requests = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            requests++
            return new Response("debug tool reached server", { headers: { "content-type": "text/plain" } })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const result = yield* opencode.spawn(
      ["debug", "agent", "debug_probe", "--tool", "webfetch", "--params", JSON.stringify({ url: server.url.href })],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(server.url.href),
            agent: { debug_probe: { mode: "subagent", model: "test/test-model", permission: { webfetch: "ask" } } },
          }),
        },
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.exitCode).not.toBe(0)
    expect(requests).toBe(0)
    // A boot/graph failure also exits non-zero; require the permission path to be reached.
    expect(output).not.toContain("Service not found")
    expect(output).not.toContain("Unbound layer node")
  }),
)

cliIt.concurrent("debug agent deny permission cannot perform webfetch", ({ opencode }) =>
  Effect.gen(function* () {
    let requests = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            requests++
            return new Response("debug tool reached server", { headers: { "content-type": "text/plain" } })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const result = yield* opencode.spawn(
      ["debug", "agent", "debug_probe", "--tool", "webfetch", "--params", JSON.stringify({ url: server.url.href })],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(server.url.href),
            agent: { debug_probe: { mode: "subagent", model: "test/test-model", permission: { webfetch: "deny" } } },
          }),
        },
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.exitCode).not.toBe(0)
    expect(requests).toBe(0)
    // A boot/graph failure also exits non-zero; require the permission path to be reached.
    expect(output).not.toContain("Service not found")
    expect(output).not.toContain("Unbound layer node")
  }),
)

cliIt.concurrent("debug agent explicit allow permission performs webfetch", ({ opencode }) =>
  Effect.gen(function* () {
    let requests = 0
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            requests++
            return new Response("debug tool reached server", { headers: { "content-type": "text/plain" } })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const result = yield* opencode.spawn(
      ["debug", "agent", "debug_probe", "--tool", "webfetch", "--params", JSON.stringify({ url: server.url.href })],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(server.url.href),
            agent: { debug_probe: { mode: "subagent", model: "test/test-model", permission: { webfetch: "allow" } } },
          }),
        },
      },
    )

    opencode.expectExit(result, 0, "debug agent webfetch allow")
    expect(requests).toBe(1)
    expect(result.stdout).toContain("debug tool reached server")
  }),
)
