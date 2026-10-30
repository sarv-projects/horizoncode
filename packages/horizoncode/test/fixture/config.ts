import { Config } from "@/config/config"
import { emptyConsoleState } from "@horizoncode/core/v1/config/console-state"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import * as ExternalEditorProfileV1 from "@horizoncode/schema/external-editor-profile-v1"
import { Effect, Layer } from "effect"

export function make(overrides: Partial<Config.Interface> = {}) {
  const emptyEditorProfiles: ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1 = {
    schemaVersion: 1,
    source: "global_user_config",
    profiles: [],
    selected: null,
  }
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    getResourcePolicy: () => Effect.succeed(ConfigV1.ConfigResourcePolicyV1.project({})),
    getFeatures: () => Effect.succeed([]),
    updateFeature: () => Effect.succeed([]),
    applyPendingFeatures: () => Effect.void,
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
    ...overrides,
    getRepoIntelProfile: overrides.getRepoIntelProfile ?? (() =>
      Effect.succeed(ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({}))),
    updateRepoIntelProfile: overrides.updateRepoIntelProfile ?? ((input) =>
      Effect.succeed(
        ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({
          requested: input.profile,
          configurationSource: "user",
        }),
      )),
    getExternalEditorProfiles: overrides.getExternalEditorProfiles ?? (() => Effect.succeed(emptyEditorProfiles)),
    updateExternalEditorProfiles: overrides.updateExternalEditorProfiles ?? (() => Effect.succeed(emptyEditorProfiles)),
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
