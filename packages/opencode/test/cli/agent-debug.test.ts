import { expect } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

cliIt.concurrent("debug agent tool mode fails closed before ask permission can perform webfetch", ({ opencode }) =>
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
    expect(output).toContain("Debug agent tool execution is unavailable until guarded execution is implemented")
  }),
)

cliIt.concurrent("debug agent tool mode fails closed before deny permission can perform webfetch", ({ opencode }) =>
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
    expect(output).toContain("Debug agent tool execution is unavailable until guarded execution is implemented")
  }),
)

cliIt.concurrent("debug agent tool mode does not turn explicit permission allow into Guard bypass", ({ opencode }) =>
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

    expect(result.exitCode).not.toBe(0)
    expect(requests).toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Debug agent tool execution is unavailable until guarded execution is implemented",
    )
  }),
)

cliIt.concurrent("debug agent tool mode rejects executable params without evaluating them", ({ opencode }) =>
  Effect.gen(function* () {
    const directory = mkdtempSync(path.join(tmpdir(), "horizoncode-debug-agent-params-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
    const marker = path.join(directory, "params-evaluated")
    const expression = `(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"executed");return {}})()`
    const result = yield* opencode.spawn(
      ["debug", "agent", "debug_probe", "--tool", "webfetch", "--params", expression],
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig("http://127.0.0.1:1/v1"),
            agent: { debug_probe: { mode: "subagent", model: "test/test-model", permission: { webfetch: "allow" } } },
          }),
        },
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Debug agent tool execution is unavailable until guarded execution is implemented",
    )
  }),
)
