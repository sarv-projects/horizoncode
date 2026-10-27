import { expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { debugEffectRouteAvailable } from "@/dap/session"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionStatus } from "@/session/status"
import { DAP_TOOL_ACCEPTANCE_READY } from "@/tool/dap"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

// Match the existing registry-filter fixture: avoid constructing a real
// SessionSupervisor/HostKernel client while observing the production registry.
const supervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    hostFeatureEnabled: () => Effect.succeed(false),
    queryRepoStructure: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
    discoverRepo: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
    readRepoDocument: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  }),
  deps: [],
})

const fixtureDirectory = path.resolve(import.meta.dir, "../../../../.tmp/p4-dap-registry")
const fixtureInstanceRef = Layer.succeed(InstanceRef, {
  directory: fixtureDirectory,
  worktree: fixtureDirectory,
  project: {
    id: ProjectV2.ID.make("proj_dap_surface"),
    worktree: fixtureDirectory,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})
const root = LayerNode.group([SessionStatus.node, Agent.node, ToolRegistry.node, supervisorNode])
const registryTest = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]).pipe(Layer.provide(fixtureInstanceRef)),
)

test("DAP stays outside the model-facing surface until Guarded HostKernel acceptance", () => {
  // ToolRegistry requires both gates before registering `debug`; neither is an
  // effect authorization and both remain closed until integrated acceptance.
  expect(DAP_TOOL_ACCEPTANCE_READY).toBe(false)
  expect(debugEffectRouteAvailable()).toBe(false)
})

registryTest.instance("the real ToolRegistry ids projection omits debug while DAP gates are closed", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const ids = yield* registry.ids()

    expect(DAP_TOOL_ACCEPTANCE_READY).toBe(false)
    expect(debugEffectRouteAvailable()).toBe(false)
    expect(ids).not.toContain("debug")
  }),
)