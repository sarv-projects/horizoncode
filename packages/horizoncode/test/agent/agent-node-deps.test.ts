import { afterEach, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { AgentProfileService } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { LocationServiceMap } from "@horizoncode/core/location-service-map"
import {
  locationServiceMapNode,
  type LocationError,
  type LocationServices,
} from "@horizoncode/core/location-services"
import { PluginV2 } from "@horizoncode/core/plugin"
import { Reference } from "@horizoncode/core/reference"
import { AbsolutePath } from "@horizoncode/core/schema"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * `Agent.node` builds its state cache once per instance and looks it up later
 * from the caller's context (`requireServicesAt: "lookup"`). The initializer
 * additionally walks the configured `references` — a path that reads
 * `PluginV2` and `Reference`, both of which are only reachable through the
 * location service map. A consumer graph is therefore correct as long as its
 * `LocationServiceMap` replacement is honoured; it must not also have to
 * restate location-scoped services as `Agent.node` graph deps (those nodes are
 * `Location`-bound and would make every root compile unbound).
 *
 * These tests pin both halves of that contract:
 *  1. a location map that exposes only what the caller needs still has to let
 *     `Agent.get` build its state — today it dies with
 *     `Service not found: @opencode/v2/Plugin`;
 *  2. when the location map *does* expose `PluginV2`/`Reference`, the
 *     reference directory is still whitelisted for `external_directory`.
 */

const profilesStub = Layer.succeed(AgentProfileService, AgentProfileService.of({
  agentProfiles: () => Effect.succeed([]),
  agentProfileSelectors: () => Effect.succeed([]),
  agentProfile: () => Effect.die("agentProfile is not expected in this graph"),
  agentProfileSelector: () => Effect.die("agentProfileSelector is not expected in this graph"),
  primaryAgentProfile: () => Effect.die("primaryAgentProfile is not expected in this graph"),
}))

const locationNodeFor = (locationLayer: Layer.Layer<any, unknown, unknown>) =>
  LayerNode.make({
    service: LocationServiceMap.Service,
    layer: Layer.succeed(
      LocationServiceMap.Service,
      { get: (_ref: Location.Ref) => locationLayer } as unknown as LayerMap.LayerMap<
        Location.Ref,
        LocationServices,
        LocationError
      >,
    ),
    deps: [],
  })

const agentGraph = (locationLayer: Layer.Layer<any, unknown, unknown>) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      locationServiceMapNode,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({})],
      [locationServiceMapNode, locationNodeFor(locationLayer)],
    ],
  )

const referenceDir = "/tmp/p7-agent-node-deps/reference-docs"

const itBareLocation = testEffect(agentGraph(profilesStub))

const itFullLocation = testEffect(
  agentGraph(
    Layer.mergeAll(
      profilesStub,
      Layer.mock(PluginV2.Service, { wait: () => Effect.void }),
      Layer.mock(Reference.Service, {
        list: () =>
          Effect.succeed([
            new Reference.Info({
              name: "reference-docs",
              path: AbsolutePath.make(referenceDir),
              source: { type: "local", path: AbsolutePath.make(referenceDir) },
            }),
          ]),
      }),
    ),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

itBareLocation.instance(
  "Agent.state builds when the location map does not expose PluginV2/Reference",
  () =>
    Effect.gen(function* () {
      const build = yield* Agent.Service.use((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(build.name).toBe("build")
    }),
  {
    config: {
      references: {
        "reference-docs": referenceDir,
      },
    },
  },
)

itFullLocation.instance(
  "Agent.state whitelists reference directories when the location map exposes Reference",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const build = yield* Agent.Service.use((svc) => svc.get("build"))
      const target = path.join(referenceDir, "notes.md")
      expect(Permission.evaluate("external_directory", target, build.permission).action).toBe("allow")
      // The instance's own project directory must stay "ask" — only the
      // materialized reference directory is added to the whitelist.
      expect(
        Permission.evaluate("external_directory", path.join(test.directory, "unlisted.md"), build.permission).action,
      ).toBe("ask")
    }),
  {
    config: {
      references: {
        "reference-docs": referenceDir,
      },
    },
  },
)
