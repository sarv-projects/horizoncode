import { expect } from "bun:test"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { Effect, Exit } from "effect"
import path from "node:path"
import { MCP } from "@/mcp"
import { createMcpHarness, markerCommand, testDirectory, unavailableMessage, withMcpInstance } from "./unavailable"

const directory = testDirectory()
const marker = path.join(directory, "mcp-command-started")
const command = markerCommand(marker)
const harness = createMcpHarness({
  mcp: {
    marker: { type: "local", command },
    disabled: { type: "local", command, enabled: false },
  },
} as ConfigV1.Info)

harness.it.effect(
  "MCP service rejects configured, local, remote, and credential effects",
  withMcpInstance(
    directory,
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      const configuredStatuses = yield* mcp.status()
      expect(configuredStatuses.marker?.status).toBe("failed")
      expect(configuredStatuses.marker?.status === "failed" && configuredStatuses.marker.error).toBe(unavailableMessage)
      expect(configuredStatuses.disabled?.status).toBe("disabled")

      const connectExit = yield* mcp.connect("marker").pipe(Effect.exit)
      expect(Exit.isFailure(connectExit)).toBe(true)
      expect((yield* mcp.status()).marker?.status).toBe("failed")

      const localAddExit = yield* mcp.add("added", { type: "local", command }).pipe(Effect.exit)
      expect(Exit.isFailure(localAddExit)).toBe(true)
      expect((yield* mcp.status()).added).toBeUndefined()

      let remoteRequests = 0
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => {
              remoteRequests++
              return new Response("unexpected MCP request")
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const remoteAddExit = yield* mcp
        .add("remote-added", {
          type: "remote",
          url: new URL("/mcp", server.url).href,
          headers: { "x-mcp-test": "offline" },
          oauth: false,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(remoteAddExit)).toBe(true)
      expect(remoteRequests).toBe(0)
      expect((yield* mcp.status())["remote-added"]).toBeUndefined()

      const removeAuthExit = yield* mcp.removeAuth("marker").pipe(Effect.exit)
      expect(Exit.isFailure(removeAuthExit)).toBe(true)
      expect(harness.authRemovalCalls()).toBe(0)

      expect(yield* mcp.tools()).toEqual({})
      expect(yield* mcp.clients()).toEqual({})
      expect(yield* mcp.prompts()).toEqual({})
      expect(yield* mcp.resourceTemplates()).toEqual({})
      expect(yield* mcp.resources()).toEqual({})
      expect(yield* mcp.readResource("marker", "file:///not-readable")).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  ),
)
