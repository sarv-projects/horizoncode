import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@horizoncode/core/global"
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
export function createMcpHarness(
  configInfo: ConfigV1.Info | (() => ConfigV1.Info),
  options?: { global?: ConfigV1.Info | (() => ConfigV1.Info); dataDirectory?: string },
) {
  let authRemovalCalls = 0
  const read = (value: ConfigV1.Info | (() => ConfigV1.Info)) => (typeof value === "function" ? value() : value)
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      get: () => Effect.sync(() => read(configInfo)),
      // Default mirrors production intent: an entry present in the same
      // document is user-global, so existing unavailable-path assertions keep
      // their meaning. Trust tests pass an explicit empty global document.
      getGlobal: () => Effect.sync(() => read(options?.global ?? configInfo)),
    } as Config.Interface),
  )
  const globalLayer = Layer.succeed(
    Global.Service,
    Global.make({ data: options?.dataDirectory ?? path.join(os.tmpdir(), `mcp-trust-${crypto.randomUUID()}`) }),
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
    [Global.node, globalLayer],
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
