import { afterEach, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { AgentProfileService } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { LocationServiceMap } from "@horizoncode/core/location-service-map"
import { locationServiceMapNode, type LocationError, type LocationServices } from "@horizoncode/core/location-services"
import { ModelV2 } from "@horizoncode/core/model"
import { ProviderV2 } from "@horizoncode/core/provider"
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FALLBACK_MODEL = { providerID: ProviderV2.ID.make("fallback"), modelID: ModelV2.ID.make("fallback-model") }

const probeProfile = (source: "builtin" | "user") =>
  ({
    schemaVersion: 2,
    profileId: source === "builtin" ? "builtin.probe" : "user.probe",
    revision: "1",
    name: "probe",
    description: "Projection probe profile",
    source,
    roles: ["subagent"],
    purpose: "Probe the model pin projection",
    whenToUse: "In this test only",
    whenNotToUse: "Never",
    adapter: { kind: "native", adapterId: "horizon.native" },
    model: { providerId: "missing", modelId: "missing-model" },
    harness: "native-rich",
    reasoning: "low",
    variants: [],
    instructions: { extraRefs: [], maxCompiledTokens: "4096" },
    tools: [{ effect: "allow", toolPattern: "files.read" }],
    allowedSkillIds: [],
    deniedSkillIds: [],
    allowedMcpServers: [],
    allowedMcpToolPatterns: [],
    allowedSubagentIds: [],
    deniedSubagentIds: [],
    pathRules: [],
    context: { isolation: "fresh", allowImages: true, allowDocuments: true, allowArtifacts: true },
    inputMode: "default",
    memoryPolicy: "none",
    isolation: "workspace",
    lifecycleHooks: [],
    capabilityCeiling: [],
    limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
    maxParallelChildren: 1,
    enabled: true,
  }) as unknown as AgentProfileV2.AgentProfileDefinitionV2

const profilesStub = (profile: AgentProfileV2.AgentProfileDefinitionV2) =>
  Layer.succeed(
    AgentProfileService,
    AgentProfileService.of({
      agentProfiles: () => Effect.succeed([profile]),
      agentProfileSelectors: () => Effect.succeed([{ selector: "probe", profile }]),
      agentProfile: () => Effect.succeed(profile),
      agentProfileSelector: () => Effect.succeed(profile),
      primaryAgentProfile: () => Effect.succeed(undefined),
    }),
  )

const providerMock = Layer.mock(Provider.Service, {
  getModel: () =>
    Effect.fail(
      new Provider.ModelNotFoundError({
        providerID: ProviderV2.ID.make("missing"),
        modelID: ModelV2.ID.make("missing-model"),
      }),
    ),
  defaultModel: () => Effect.succeed(FALLBACK_MODEL),
})

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
      [Provider.node, providerMock],
      [locationServiceMapNode, locationNodeFor(locationLayer)],
    ],
  )

afterEach(async () => {
  await disposeAllInstances()
})

const itBuiltin = testEffect(agentGraph(profilesStub(probeProfile("builtin"))))
const itUser = testEffect(agentGraph(profilesStub(probeProfile("user"))))

itBuiltin.instance(
  "a builtin profile pin that is not configured degrades to the session default model",
  () =>
    Effect.gen(function* () {
      const projected = yield* Agent.Service.use((svc) => svc.getProfile("builtin.probe", "1"))
      expect(projected.model?.providerID).toBe(FALLBACK_MODEL.providerID)
      expect(projected.model?.modelID).toBe(FALLBACK_MODEL.modelID)
    }),
)

itUser.instance(
  "a user-owned profile pin never silently falls back to another model",
  () =>
    Effect.gen(function* () {
      const projected = yield* Agent.Service.use((svc) => svc.getProfile("user.probe", "1"))
      expect(projected.model?.providerID).toBe(ProviderV2.ID.make("missing"))
      expect(projected.model?.modelID).toBe(ModelV2.ID.make("missing-model"))
    }),
)