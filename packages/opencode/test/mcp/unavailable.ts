import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import type { InstanceContext } from "@/project/instance-context"
import { testEffect } from "../lib/effect"

export const unavailableMessage =
  "MCP connections are unavailable until the canonical Rust execution broker supports MCP process and network effects."

export function testDirectory() {
  return path.join(os.tmpdir(), `mcp-test-${crypto.randomUUID()}`)
}

export function markerCommand(marker: string) {
  return [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`]
}
export function createMcpHarness(configInfo: ConfigV1.Info | (() => ConfigV1.Info)) {
  let authRemovalCalls = 0
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      get: () => Effect.sync(() => (typeof configInfo === "function" ? configInfo() : configInfo)),
    } as Config.Interface),
  )
  const auth = Layer.succeed(
    McpAuth.Service,
    McpAuth.Service.of({
      get: () => Effect.succeed(undefined),
      getForUrl: () => Effect.succeed(undefined),
      remove: () => Effect.sync(() => authRemovalCalls++),
    } as unknown as McpAuth.Interface),
  )
  const layer = LayerNode.compile(MCP.node, [
    [Config.node, config],
    [McpAuth.node, auth],
  ])
  return {
    it: testEffect(layer),
    authRemovalCalls: () => authRemovalCalls,
  }
}

export function withMcpInstance<A, E, R>(directory: string, self: Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => mkdir(directory, { recursive: true })),
    () => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(() => self.pipe(Effect.provideService(InstanceRef, { directory } as InstanceContext))))
}
