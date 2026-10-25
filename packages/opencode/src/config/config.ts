import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import * as WorkspaceCommandProfileV1 from "@opencode-ai/schema/workspace-command-profile-v1"
import * as ExternalEditorProfileV1 from "@opencode-ai/schema/external-editor-profile-v1"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (hadLegacy) {
    delete copy.theme
    delete copy.keybinds
    delete copy.tui
  }
  // Tavily's former `tavily_keyless` entry was never an approved anonymous
  // default. Drop it while loading old settings so it cannot become newly
  // executable after route-policy changes. The canonical config schema omits
  // this retired route, so a subsequent settings save persists the migration.
  if (isRecord(copy.websearch)) {
    const websearch = { ...copy.websearch }
    for (const key of ["enabled", "order"] as const) {
      if (Array.isArray(websearch[key])) {
        websearch[key] = websearch[key].filter((route) => route !== "tavily_keyless")
      }
    }
    copy.websearch = websearch
  }
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

/** A secret-free projection of config already loaded by this instance. */
export type OfflineProviderDoctorConfig = {
  enabled_providers?: string[]
  disabled_providers?: string[]
  provider?: Record<string, { models?: Record<string, unknown>; whitelist?: string[]; blacklist?: string[] }>
}

/** Trusted, global-only launch configuration consumed by the LSP/DAP profile projector. */
export type GlobalLaunchProfilesConfig = Pick<ConfigV1.Info, "lsp" | "dap">
export class FeatureSettingConflict extends Error {
  constructor() {
    super("Feature setting changed since it was read")
    this.name = "FeatureSettingConflict"
  }
}

export class FeatureSettingLocked extends Error {
  constructor() {
    super("Feature setting is locked by runtime or organization policy")
    this.name = "FeatureSettingLocked"
  }
}

export class RepoIntelProfileConflict extends Error {
  constructor() {
    super("RepoIntel profile changed since it was read")
    this.name = "RepoIntelProfileConflict"
  }
}

export class RepoIntelProfileLocked extends Error {
  constructor() {
    super("RepoIntel profile is locked by runtime or organization policy")
    this.name = "RepoIntelProfileLocked"
  }
}

export class ExternalEditorProfileConflict extends Error {
  constructor() {
    super("External editor profile selection changed since it was read")
    this.name = "ExternalEditorProfileConflict"
  }
}

export class ExternalEditorProfileInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExternalEditorProfileInvalid"
  }
}



type State = {
  config: Info
  /** Provider-selection facts sourced only from local config layers, excluding well-known remote overlays. */
  offlineProviderConfig: Pick<Info, "enabled_providers" | "disabled_providers" | "provider">
  featureConfig: FeatureExposure.SourceConfig
  repoIntelProfile: ConfigV1.ConfigRepoIntelligenceV1.ProfileProjection
  resourcePolicy: ConfigV1.ConfigResourcePolicyV1.ResourcePolicyProjectionV1
  directories: string[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  /** Returns a secret-free config projection only when this instance has already loaded config. Never initializes config loading. */
  readonly getOfflineProviderDoctorConfig?: () => Effect.Effect<Option.Option<OfflineProviderDoctorConfig>>
  readonly getGlobal: () => Effect.Effect<Info>
  /** Returns only global LSP/DAP config; instance/project/plugin overlays are excluded. */
  readonly getGlobalLaunchProfiles?: () => Effect.Effect<GlobalLaunchProfilesConfig>
  /** Profiles are read only from user global config; project and remote overlays are excluded. */
  readonly getExternalEditorProfiles: () => Effect.Effect<ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1>
  /** Append one immutable global editor profile revision and CAS its selected reference. */
  readonly updateExternalEditorProfiles: (
    input: ExternalEditorProfileV1.UpdateExternalEditorProfilesV1,
  ) => Effect.Effect<ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1, Error | EffectFlock.LockError>
  /** Returns only the RepoIntel profile projection from already-loaded config; never initializes config loading. */
  readonly getRepoIntelProfile: () => Effect.Effect<ConfigV1.ConfigRepoIntelligenceV1.ProfileProjection>
  /** Returns a truthful Config-owned requested/effective resource projection; never implies OS enforcement. */
  readonly getResourcePolicy: () => Effect.Effect<ConfigV1.ConfigResourcePolicyV1.ResourcePolicyProjectionV1>
  /** Compare-and-write only repo_intelligence.profile in the current workspace config. */
  readonly updateRepoIntelProfile: (
    input: ConfigV1.ConfigRepoIntelligenceV1.UpdateProfile,
  ) => Effect.Effect<ConfigV1.ConfigRepoIntelligenceV1.ProfileProjection, Error | EffectFlock.LockError>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly getFeatures: () => Effect.Effect<FeatureExposure.Feature[]>
  readonly applyPendingFeatures: () => Effect.Effect<void>
  readonly updateFeature: (
    input: FeatureExposure.Update,
  ) => Effect.Effect<FeatureExposure.Feature[], Error | EffectFlock.LockError>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }, Error | EffectFlock.LockError>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

/** Global workspace command profiles are append-only through the config API. */
function validateWorkspaceCommandProfileAppend(existing: unknown, patch: unknown): string | undefined {
  if (!isRecord(patch) || !("workspace_command_profiles" in patch)) return undefined
  const previous = isRecord(existing) && Array.isArray(existing.workspace_command_profiles)
    ? existing.workspace_command_profiles
    : []
  const next = patch.workspace_command_profiles
  if (next === undefined) {
    return previous.length ? "workspace_command_profiles cannot be removed through the config API" : undefined
  }
  if (!Array.isArray(next)) return "workspace_command_profiles must be an array"

  const decode = Schema.decodeUnknownSync(WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1, {
    onExcessProperty: "error",
  })
  const beforeByIdentity = new Map<string, WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1>()
  const beforeLatest = new Map<string, bigint>()
  const nextByIdentity = new Map<string, WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1>()
  try {
    for (const raw of previous) {
      const profile = decode(raw)
      if (!WorkspaceCommandProfileV1.validateWorkspaceCommandProfileV1(profile)) {
        return `existing WorkspaceCommandProfileV1 ${profile.profileId}@${profile.revision} has an invalid digest`
      }
      const identity = `${profile.profileId}@${profile.revision}`
      const prior = beforeByIdentity.get(identity)
      if (prior && prior.profileDigest !== profile.profileDigest) return `conflicting existing WorkspaceCommandProfileV1 ${identity}`
      beforeByIdentity.set(identity, profile)
      const revision = BigInt(profile.revision)
      if (revision > (beforeLatest.get(profile.profileId) ?? 0n)) beforeLatest.set(profile.profileId, revision)
    }
    for (const raw of next) {
      const profile = decode(raw)
      if (!WorkspaceCommandProfileV1.validateWorkspaceCommandProfileV1(profile)) {
        return `WorkspaceCommandProfileV1 ${profile.profileId}@${profile.revision} has an invalid digest`
      }
      const identity = `${profile.profileId}@${profile.revision}`
      const prior = nextByIdentity.get(identity)
      if (prior && prior.profileDigest !== profile.profileDigest) return `conflicting WorkspaceCommandProfileV1 ${identity}`
      nextByIdentity.set(identity, profile)
    }
  } catch {
    return "workspace_command_profiles contains a malformed profile"
  }

  for (const [identity, profile] of beforeByIdentity) {
    if (nextByIdentity.get(identity)?.profileDigest !== profile.profileDigest) {
      return `WorkspaceCommandProfileV1 ${identity} is immutable and must remain in global config history`
    }
  }
  for (const [identity, profile] of nextByIdentity) {
    if (beforeByIdentity.has(identity)) continue
    const revision = BigInt(profile.revision)
    if (revision <= (beforeLatest.get(profile.profileId) ?? 0n)) {
      return `new WorkspaceCommandProfileV1 ${identity} must use a revision greater than the prior revision`
    }
    beforeLatest.set(profile.profileId, revision)
  }
  return undefined
}

function editorProfileRefEquals(
  left: ExternalEditorProfileV1.ExternalEditorProfileRefV1 | null,
  right: ExternalEditorProfileV1.ExternalEditorProfileRefV1 | null,
) {
  return left === null || right === null
    ? left === right
    : left.profileId === right.profileId && left.revision === right.revision && left.profileDigest === right.profileDigest
}

function projectExternalEditorProfiles(value: unknown): ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1 {
  const raw = isRecord(value) ? value : {}
  const definitions = Array.isArray(raw.external_editor_profiles) ? raw.external_editor_profiles : []
  const decode = Schema.decodeUnknownSync(ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1, { onExcessProperty: "error" })
  const profiles = definitions.map((item) => {
    const definition = decode(item)
    return { definition, profileRef: ExternalEditorProfileV1.externalEditorProfileRefV1(definition) }
  })
  const selection = isRecord(raw.external_editor_selection) ? raw.external_editor_selection : undefined
  const selected = selection && typeof selection.profileId === "string" && typeof selection.revision === "string"
    ? profiles.find((profile) => profile.definition.profileId === selection.profileId && profile.definition.revision === selection.revision)?.profileRef ?? null
    : null
  return Schema.decodeUnknownSync(ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1, { onExcessProperty: "error" })({
    schemaVersion: 1,
    source: "global_user_config",
    profiles,
    selected,
  })
}

function validateExternalEditorProfileHistory(existing: unknown, next: unknown): string | undefined {
  if (!Array.isArray(next)) return "external_editor_profiles must be an array"
  const decode = Schema.decodeUnknownSync(ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1, { onExcessProperty: "error" })
  const previousByIdentity = new Map<string, ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1>()
  const nextByIdentity = new Map<string, ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1>()
  const latestRevision = new Map<string, bigint>()
  try {
    for (const raw of Array.isArray(existing) ? existing : []) {
      const profile = decode(raw)
      const identity = `${profile.profileId}@${profile.revision}`
      if (previousByIdentity.has(identity)) return `duplicate ExternalEditorProfileV1 ${identity}`
      previousByIdentity.set(identity, profile)
      const revision = BigInt(profile.revision)
      if (revision > (latestRevision.get(profile.profileId) ?? 0n)) latestRevision.set(profile.profileId, revision)
      ExternalEditorProfileV1.externalEditorProfileDigestV1(profile)
    }
    for (const raw of next) {
      const profile = decode(raw)
      const identity = `${profile.profileId}@${profile.revision}`
      const prior = nextByIdentity.get(identity)
      if (prior) return `duplicate ExternalEditorProfileV1 ${identity}`
      nextByIdentity.set(identity, profile)
      ExternalEditorProfileV1.externalEditorProfileDigestV1(profile)
    }
  } catch {
    return "external_editor_profiles contains a malformed or oversized profile"
  }
  for (const [identity, profile] of previousByIdentity) {
    const replacement = nextByIdentity.get(identity)
    if (!replacement || ExternalEditorProfileV1.externalEditorProfileDigestV1(replacement) !== ExternalEditorProfileV1.externalEditorProfileDigestV1(profile)) {
      return `ExternalEditorProfileV1 ${identity} is immutable and must remain in global config history`
    }
  }
  for (const [identity, profile] of nextByIdentity) {
    if (previousByIdentity.has(identity)) continue
    const revision = BigInt(profile.revision)
    if (revision <= (latestRevision.get(profile.profileId) ?? 0n)) {
      return `new ExternalEditorProfileV1 ${identity} must use a revision greater than the prior revision`
    }
    latestRevision.set(profile.profileId, revision)
  }
  if (nextByIdentity.size > 128) return "external_editor_profiles cannot contain more than 128 immutable revisions"
  return undefined
}

function validateExternalEditorProfileGlobalPatch(existing: unknown, patch: unknown): string | undefined {
  if (!isRecord(existing) || !isRecord(patch)) return undefined
  if (Object.prototype.hasOwnProperty.call(patch, "external_editor_profiles")) {
    const error = validateExternalEditorProfileHistory(
      existing.external_editor_profiles ?? [],
      patch.external_editor_profiles,
    )
    if (error) return error
  }
  if (Object.prototype.hasOwnProperty.call(patch, "external_editor_selection")) {
    const before = isRecord(existing.external_editor_selection)
      ? `${existing.external_editor_selection.profileId}@${existing.external_editor_selection.revision}`
      : existing.external_editor_selection === null ? null : undefined
    const after = isRecord(patch.external_editor_selection)
      ? `${patch.external_editor_selection.profileId}@${patch.external_editor_selection.revision}`
      : patch.external_editor_selection === null ? null : undefined
    if (before !== after) {
      return "external_editor_selection can only be changed through the compare-and-set editor profile endpoint"
    }
  }
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const decodeConfig = Effect.fnUntraced(function* (input: unknown, source: string) {
      const result = ConfigV2Compat.lower(normalizeLoadedConfig(input), source)
      yield* Effect.forEach(result.diagnostics, (diagnostic) =>
        Effect.logWarning("configuration compatibility diagnostic", {
          source,
          path: diagnostic.path,
          kind: diagnostic.kind,
          action: diagnostic.message,
        }),
      )
      return ConfigParse.schema(ConfigV1.Info, result.value, source)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = yield* decodeConfig(parsed, source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then((mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result = mergeConfig(result, rest)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const getGlobalLaunchProfiles = Effect.fn("Config.getGlobalLaunchProfiles")(function* () {
      const config = yield* cachedGlobal
      return {
        ...(config.lsp === undefined ? {} : { lsp: structuredClone(config.lsp) }),
        ...(config.dap === undefined ? {} : { dap: structuredClone(config.dap) }),
      }
    })

    const readUserGlobalEditorConfig = Effect.fn("Config.readUserGlobalEditorConfig")(function* () {
      // Use the same single user-owned global file selected for CAS writes.
      // Merging all legacy files here would duplicate immutable profile
      // revisions after the first write copies the effective history into the
      // selected file. Account, managed and project overlays are never read.
      const file = globalConfigFile()
      const text = yield* readConfigFile(file)
      if (!text) return {}
      const parsed = ConfigParse.jsonc(text, file)
      return isRecord(parsed) ? parsed : {}
    })

    const getExternalEditorProfiles = Effect.fn("Config.getExternalEditorProfiles")(function* () {
      return projectExternalEditorProfiles(yield* readUserGlobalEditorConfig())
    })

    const updateExternalEditorProfiles = Effect.fn("Config.updateExternalEditorProfiles")(function* (
      input: ExternalEditorProfileV1.UpdateExternalEditorProfilesV1,
    ) {
      const file = globalConfigFile()
      return yield* flock.withLock(
        Effect.gen(function* () {
          const before = (yield* readConfigFile(file)) ?? "{}"
          yield* Effect.try({
            try: () => {
              const parsed = ConfigParse.jsonc(before, file)
              if (!isRecord(parsed)) throw new ExternalEditorProfileInvalid("global config root must be an object")
              return parsed
            },
            catch: (error) => error instanceof Error ? error : new ExternalEditorProfileInvalid(String(error)),
          })
          const userConfig = yield* readUserGlobalEditorConfig()
          const priorProfiles = Array.isArray(userConfig.external_editor_profiles) ? userConfig.external_editor_profiles : []
          let currentProjection: ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1
          try {
            currentProjection = projectExternalEditorProfiles(userConfig)
          } catch {
            return yield* Effect.fail(new ExternalEditorProfileInvalid("stored global editor profile history is invalid"))
          }
          if (!editorProfileRefEquals(currentProjection.selected, input.expectedSelection)) {
            return yield* Effect.fail(new ExternalEditorProfileConflict())
          }

          const nextProfiles = [...priorProfiles]
          if (input.addProfile) {
            const decode = Schema.decodeUnknownSync(ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1, { onExcessProperty: "error" })
            let profile: ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1
            try {
              profile = decode(input.addProfile)
              ExternalEditorProfileV1.externalEditorProfileDigestV1(profile)
            } catch {
              return yield* Effect.fail(new ExternalEditorProfileInvalid("new editor profile is malformed or exceeds its canonical encoding bound"))
            }
            const identity = `${profile.profileId}@${profile.revision}`
            if (nextProfiles.some((value) => isRecord(value) && value.profileId === profile.profileId && value.revision === profile.revision)) {
              return yield* Effect.fail(new ExternalEditorProfileInvalid(`ExternalEditorProfileV1 ${identity} already exists; revisions are immutable`))
            }
            nextProfiles.push(profile)
          }

          const historyError = validateExternalEditorProfileHistory(priorProfiles, nextProfiles)
          if (historyError) return yield* Effect.fail(new ExternalEditorProfileInvalid(historyError))
          let nextSelection: ExternalEditorProfileV1.ExternalEditorProfileRefV1 | null = input.select
          if (nextSelection !== null) {
            const definition = nextProfiles.find((value) => isRecord(value) && value.profileId === nextSelection!.profileId && value.revision === nextSelection!.revision)
            if (!definition) return yield* Effect.fail(new ExternalEditorProfileInvalid("selected editor profile revision is not present in global user config"))
            try {
              const decoded = Schema.decodeUnknownSync(ExternalEditorProfileV1.ExternalEditorProfileDefinitionV1, { onExcessProperty: "error" })(definition)
              const expected = ExternalEditorProfileV1.externalEditorProfileRefV1(decoded)
              if (!editorProfileRefEquals(expected, nextSelection)) return yield* Effect.fail(new ExternalEditorProfileInvalid("selected editor profile digest does not match its immutable definition"))
              nextSelection = expected
            } catch {
              return yield* Effect.fail(new ExternalEditorProfileInvalid("selected editor profile definition is invalid"))
            }
          }

          const patch = {
            external_editor_profiles: nextProfiles,
            external_editor_selection: nextSelection === null
              ? null
              : { profileId: nextSelection.profileId, revision: nextSelection.revision },
          }
          const updated = patchJsonc(before, patch)
          yield* decodeConfig(ConfigParse.jsonc(updated, file), file)
          if (updated !== before) {
            yield* fs.ensureDir(path.dirname(file))
            yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
            yield* invalidateGlobal
          }
          // Use the merged user-owned source, not Config's effective remote or
          // organization overlays, for the response and next CAS token.
          const responseConfig = mergeDeep(userConfig, patch) as Record<string, unknown>
          return projectExternalEditorProfiles(responseConfig)
        }),
        `config-global:${file}`,
      )
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        let featureConfig: FeatureExposure.SourceConfig = {}
        let offlineProviderConfig: Pick<Info, "enabled_providers" | "disabled_providers" | "provider"> = {}
        let repoIntelProfile = ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({
          requested: undefined,
          configurationSource: "default",
          policyLock: "unlocked",
        })
        let resourcePolicy = ConfigV1.ConfigResourcePolicyV1.project({})
        const resourcePolicyOrigins: Partial<Record<ConfigV1.ConfigResourcePolicyV1.Dimension, {
          configurationSource: "default" | "user" | "project" | "run" | "system_policy" | "unknown"
          policyLock: "locked" | "unlocked" | "unknown"
          reason?: string
        }>> = {}
        const captureFeatureOrigins = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          const compaction = next.compaction
          const managedDirectory = ConfigManaged.managedConfigDir()
          const managed =
            source.endsWith("/api/config") ||
            source === managedDirectory ||
            source.startsWith(`${managedDirectory}${path.sep}`) ||
            source.startsWith("/Library/Managed Preferences/")
          const valueSource = managed
            ? "system_policy"
            : kind === "global"
              ? "user"
              : kind === "local" || source === "OPENCODE_CONFIG_CONTENT" || containsPath(source, ctx)
                ? "project"
                : source === Global.Path.config || source.startsWith(`${Global.Path.config}${path.sep}`)
                  ? "user"
                  : "unknown"
          const repoProfile = next.repo_intelligence?.profile
          if (repoProfile !== undefined) {
            repoIntelProfile = ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({
              requested: repoProfile,
              configurationSource: valueSource,
              policyLock: managed ? "locked" : "unlocked",
            })
          }
          if (!/^https?:\/\//i.test(source) && next.resource_policy !== undefined) {
            for (const dimension of Object.keys(next.resource_policy.limits) as ConfigV1.ConfigResourcePolicyV1.Dimension[]) {
              resourcePolicyOrigins[dimension] = {
                configurationSource: managed ? "system_policy" : valueSource,
                policyLock: managed ? "locked" : "unlocked",
                ...(managed ? { reason: "Managed by organization or system policy" } : {}),
              }
            }
          }
          if (!compaction) return
          const origins = { ...featureConfig.origins }
          for (const key of ["auto", "prune"] as const) {
            if (compaction[key] === undefined) continue
            origins[key] = {
              valueSource,
              policyLock: managed ? "locked" : "unlocked",
              ...(managed ? { blockedReason: "Managed by organization or system policy" } : {}),
            }
          }
          featureConfig = {
            ...featureConfig,
            compaction: { ...featureConfig.compaction, ...compaction },
            origins,
          }
        }
        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          const remoteOverlay = /^https?:\/\//i.test(source)
          const mergeInput = remoteOverlay && next.resource_policy !== undefined
            ? Object.fromEntries(Object.entries(next).filter(([key]) => key !== "resource_policy")) as Info
            : next
          result = mergeConfigConcatArrays(result, mergeInput)
          // Provider Doctor's offline tier must explain local state, not remote
          // well-known overlays that happened to be loaded during startup.
          if (!remoteOverlay) offlineProviderConfig = mergeConfigConcatArrays(offlineProviderConfig, mergeInput)
          captureFeatureOrigins(source, next, kind)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.OPENCODE_CONFIG) {
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        for (const dir of directories) {
          if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            for (const file of ["opencode.json", "opencode.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        // The config.update owner persists per-instance edits here. Load that
        // document as the final workspace-local config layer so updates are
        // reflected by the runtime after instance disposal/reload.
        const instanceConfigFile = path.join(ctx.directory, "config.json")
        yield* merge(instanceConfigFile, yield* loadFile(instanceConfigFile, authEnv), "local")

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["opencode.json", "opencode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const managedConfig = yield* loadConfig(managed.text, {
            dir: path.dirname(managed.source),
            source: managed.source,
          })
          result = mergeConfigConcatArrays(result, managedConfig)
          captureFeatureOrigins(managed.source, managedConfig, "global")
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("OPENCODE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          result.permission = mergeDeep(projectToolPermissions(result.tools), result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        featureConfig.compaction = result.compaction ? { ...result.compaction } : featureConfig.compaction
        resourcePolicy = ConfigV1.ConfigResourcePolicyV1.project({
          requested: result.resource_policy,
          origins: resourcePolicyOrigins,
        })

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
          featureConfig.origins = {
            ...featureConfig.origins,
            auto: {
              ...(featureConfig.origins?.auto ?? { valueSource: "unknown" as const }),
              policyLock: "locked",
              blockedReason: "Disabled by runtime policy",
            },
          }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
          featureConfig.origins = {
            ...featureConfig.origins,
            prune: {
              ...(featureConfig.origins?.prune ?? { valueSource: "unknown" as const }),
              policyLock: "locked",
              blockedReason: "Disabled by runtime policy",
            },
          }
        }

        return {
          config: result,
          offlineProviderConfig,
          featureConfig,
          repoIntelProfile,
          resourcePolicy,
          directories,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }

      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const getRepoIntelProfile = Effect.fn("Config.getRepoIntelProfile")(function* () {
      if (!(yield* InstanceState.has(state))) {
        return ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({
          requested: undefined,
          configurationSource: "default",
          policyLock: "unlocked",
        })
      }
      return yield* InstanceState.use(state, (s) => s.repoIntelProfile)
    })

    const getResourcePolicy = Effect.fn("Config.getResourcePolicy")(function* () {
      if (!(yield* InstanceState.has(state))) return ConfigV1.ConfigResourcePolicyV1.project({})
      return yield* InstanceState.use(state, (s) => s.resourcePolicy)
    })

    const updateRepoIntelProfile = Effect.fn("Config.updateRepoIntelProfile")(function* (
      input: ConfigV1.ConfigRepoIntelligenceV1.UpdateProfile,
    ) {
      const current = yield* InstanceState.get(state)
      const file = path.join(yield* InstanceState.directory, "config.json")
      return yield* flock.withLock(
        Effect.gen(function* () {
          if (current.repoIntelProfile.policyLock === "locked") return yield* Effect.fail(new RepoIntelProfileLocked())
          yield* Effect.tryPromise({
            try: async () => {
              const text = await fsNode.readFile(file, "utf8").catch((error) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}"
                throw error
              })
              const stored: unknown = text ? ConfigParse.jsonc(text, file) : {}
              const record = isRecord(stored) ? stored : {}
              const repo = isRecord(record.repo_intelligence) ? record.repo_intelligence : {}
              const localRequested = repo.profile
              const expected = localRequested === undefined
                ? current.repoIntelProfile.requestedValue
                : typeof localRequested === "string" ? localRequested : null
              if (expected !== input.expectedProfile) throw new RepoIntelProfileConflict()

              const updated = patchJsonc(text || "{}", { repo_intelligence: { profile: input.profile } })
              await fsNode.writeFile(file, updated, "utf8")
              current.repoIntelProfile = ConfigV1.ConfigRepoIntelligenceV1.resolveProfile({
                requested: input.profile,
                configurationSource: "project",
                policyLock: "unlocked",
              })
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error), { cause: error })),
          })
          return current.repoIntelProfile
        }),
        `config-repo-intel-profile:${file}`,
      )
    })

    const getOfflineProviderDoctorConfig = Effect.fn("Config.getOfflineProviderDoctorConfig")(function* () {
      if (!(yield* InstanceState.has(state))) return Option.none()
      const config = yield* InstanceState.use(state, (s) => s.offlineProviderConfig)
      const provider = config.provider
        ? Object.fromEntries(
            Object.entries(config.provider).map(([providerID, value]) => [
              providerID,
              {
                ...(value.models ? { models: Object.fromEntries(Object.keys(value.models).map((id) => [id, {}])) } : {}),
                ...(value.whitelist ? { whitelist: [...value.whitelist] } : {}),
                ...(value.blacklist ? { blacklist: [...value.blacklist] } : {}),
              },
            ]),
          )
        : undefined
      return Option.some({
        ...(config.enabled_providers ? { enabled_providers: [...config.enabled_providers] } : {}),
        ...(config.disabled_providers ? { disabled_providers: [...config.disabled_providers] } : {}),
        ...(provider ? { provider } : {}),
      })
    })

    const getFeatures = Effect.fn("Config.getFeatures")(function* () {
      return yield* InstanceState.use(state, (s) => FeatureExposure.list(s.featureConfig, s.config))
    })

    const applyPendingFeatures = Effect.fn("Config.applyPendingFeatures")(function* () {
      const current = yield* InstanceState.get(state)
      const compaction = { ...current.config.compaction }
      for (const key of ["auto", "prune"] as const) {
        const origin = current.featureConfig.origins?.[key]
        if (origin?.pendingApplyAt !== "next_turn" || origin.policyLock !== "unlocked") continue
        const value = current.featureConfig.compaction?.[key]
        if (value !== undefined) compaction[key] = value
      }
      current.config = { ...current.config, compaction }
    })

    const updateFeature = Effect.fn("Config.updateFeature")(function* (input: FeatureExposure.Update) {
      const current = yield* InstanceState.get(state)
      if (input.featureId !== "compaction.auto" && input.featureId !== "compaction.prune")
        return yield* Effect.fail(new Error("Feature setting is unavailable"))
      const key = input.featureId === "compaction.auto" ? "auto" : "prune"
      const file = path.join(yield* InstanceState.directory, "config.json")
      return yield* flock.withLock(
        Effect.gen(function* () {
          const requestedBeforeWrite = current.featureConfig.compaction?.[key]
          const policyLock = current.featureConfig.origins?.[key]?.policyLock ??
            (requestedBeforeWrite === undefined ? "unlocked" : "unknown")
          if (
            policyLock !== "unlocked" ||
            (key === "auto" && Flag.OPENCODE_DISABLE_AUTOCOMPACT) ||
            (key === "prune" && Flag.OPENCODE_DISABLE_PRUNE)
          )
            return yield* Effect.fail(new FeatureSettingLocked())
          yield* Effect.tryPromise({
            try: async () => {
              const text = await fsNode.readFile(file, "utf8").catch((error) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}"
                throw error
              })
              const stored = text ? ConfigParse.jsonc(text, file) : {}
              const local = isRecord(stored) && isRecord(stored.compaction) ? stored.compaction[key] : undefined
              const requested = current.featureConfig.compaction?.[key] ?? null
              if (local !== undefined ? local !== input.expectedEnabled : requested !== input.expectedEnabled) {
                throw new FeatureSettingConflict()
              }
              const updated = patchJsonc(text || "{}", { compaction: { [key]: input.enabled } })
              await fsNode.writeFile(file, updated, "utf8")
              // Publish requested state with the file write under the same lock.
              // Runtime config remains pinned until its next-turn reload.
              current.featureConfig = {
                ...current.featureConfig,
                compaction: { ...current.featureConfig.compaction, [key]: input.enabled },
                origins: {
                  ...current.featureConfig.origins,
                  [key]: {
                    valueSource: "project",
                    policyLock: "unlocked",
                    pendingApplyAt: "next_turn",
                  },
                },
              }
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error), { cause: error })),
          })
          return FeatureExposure.list(current.featureConfig, current.config)
        }),
        `config-feature-setting:${file}`,
      )
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    // Retained for callers compiled against the previous config API. Config loading
    // no longer installs the external plugin package while plugin effects are disabled.
    const waitForDependencies = Effect.fn("Config.waitForDependencies")(() => Effect.void)

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      const text = yield* readConfigFile(file)
      const original = text ? ConfigParse.jsonc(text, file) : writable(existing)
      yield* fs
        .writeFileString(
          file,
          JSON.stringify(mergeDeep(isRecord(original) ? original : writable(existing), writable(config)), null, 2),
        )
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const patch = writableGlobal(config)
      return yield* flock.withLock(
        Effect.gen(function* () {
          const before = (yield* readConfigFile(file)) ?? "{}"
          let next: Info
          let changed: boolean
          if (!file.endsWith(".jsonc")) {
            const existing = ConfigParse.jsonc(before, file)
            ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(existing), file).value, file)
            const profileError = validateWorkspaceCommandProfileAppend(existing, patch)
              ?? validateExternalEditorProfileGlobalPatch(existing, patch)
            if (profileError) return yield* Effect.fail(new Error(profileError))
            const merged = mergeDeep(isRecord(existing) ? existing : {}, patch)
            const serialized = JSON.stringify(merged, null, 2)
            next = yield* decodeConfig(merged, file)
            changed = serialized !== before
            if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
          } else {
            const existing = ConfigParse.jsonc(before, file)
            ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(existing), file).value, file)
            const profileError = validateWorkspaceCommandProfileAppend(existing, patch)
              ?? validateExternalEditorProfileGlobalPatch(existing, patch)
            if (profileError) return yield* Effect.fail(new Error(profileError))
            const updated = patchJsonc(before, patch)
            next = yield* decodeConfig(ConfigParse.jsonc(updated, file), file)
            changed = updated !== before
            if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
          }

          if (changed) yield* invalidate()
          return { info: next, changed }
        }),
        `config-global:${file}`,
      )
    })

    return Service.of({
      get,
      getRepoIntelProfile,
      getResourcePolicy,
      updateRepoIntelProfile,
      getOfflineProviderDoctorConfig,
      getGlobal,
      getExternalEditorProfiles,
      updateExternalEditorProfiles,
      getGlobalLaunchProfiles,
      getConsoleState,
      update,
      getFeatures,
      applyPendingFeatures,
      updateFeature,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, EffectFlock.node, Auth.node, Account.node, Env.node, httpClient],
})

/**
 * Project the legacy `tools` on/off map into permission defaults so a
 * disabled tool is an explicit `deny` entry in the effective permission set.
 * User-written permission entries always win (they are merged on top), and
 * shared keys keep their position from this projection.
 */
export function projectToolPermissions(tools: Record<string, boolean>): Record<string, ConfigPermissionV1.Action> {
  const perms: Record<string, ConfigPermissionV1.Action> = {}
  for (const [tool, enabled] of Object.entries(tools)) {
    const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      perms.edit = action
      continue
    }
    perms[tool] = action
  }
  return perms
}

export * as Config from "./config"
