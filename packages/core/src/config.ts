export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import * as WorkspaceCommandProfileV1 from "@opencode-ai/schema/workspace-command-profile-v1"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  git_executable: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Absolute path to the trusted Git executable used by guarded managed worktree operations. HorizonCode reads this only from the global user config and never resolves Git from PATH.",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  agent_profiles: Schema.Array(AgentProfileV2.AgentProfileDefinitionV2).pipe(Schema.optional).annotate({
    description:
      "Versioned AgentProfileV2 definitions. Managed V1 resolves only explicitly user-owned profiles from the global user config; project/plugin/external sources are unavailable until trust resolution exists.",
  }),
  agent_profile_selectors: Schema.Array(Schema.Struct({
    selector: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)).check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
    profileId: AgentProfileV2.ProfileId.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
    revision: AgentProfileV2.Revision,
  })).pipe(Schema.optional).annotate({
    description:
      "Explicit compatibility selectors for Task subagents. Each selector binds one immutable user-owned AgentProfileV2 ID and revision; names and newest-revision lookup are not authority.",
  }),
  primary_agent_profile_selector: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))
    .check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)).pipe(Schema.optional).annotate({
      description:
        "Explicit global-user-config selector for the primary direct-session AgentProfileV2. The selected immutable profile must have the main role; legacy agent names are never resolved as profile authority.",
    }),
  workspace_command_profiles: Schema.Array(WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1).pipe(Schema.optional).annotate({
    description:
      "Immutable, versioned user-owned workspace build/test profiles. Only global user config is authoritative; project, plugin and model sources are ignored. A profile never authorizes execution by itself.",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export class AgentProfileConflictError extends Schema.TaggedErrorClass<AgentProfileConflictError>()(
  "Config.AgentProfileConflictError",
  { profileID: Schema.String, revision: AgentProfileV2.Revision },
) {}

export class AgentProfileNotFoundError extends Schema.TaggedErrorClass<AgentProfileNotFoundError>()(
  "Config.AgentProfileNotFoundError",
  { profileID: Schema.String, revision: AgentProfileV2.Revision },
) {}

export class AgentProfileSelectorConflictError extends Schema.TaggedErrorClass<AgentProfileSelectorConflictError>()(
  "Config.AgentProfileSelectorConflictError",
  { selector: Schema.String },
) {}

export class AgentProfileRoleError extends Schema.TaggedErrorClass<AgentProfileRoleError>()(
  "Config.AgentProfileRoleError",
  { profileID: Schema.String, revision: AgentProfileV2.Revision, role: Schema.String },
) {}

export class AgentProfileSelectorNotFoundError extends Schema.TaggedErrorClass<AgentProfileSelectorNotFoundError>()(
  "Config.AgentProfileSelectorNotFoundError",
  { selector: Schema.String },
) {}

export type AgentProfileSelector = {
  readonly selector: string
  readonly profile: AgentProfileV2.AgentProfileDefinitionV2
}

/** Read-only projection of the instance-local next-turn Settings write. */
export type TurnSnapshot = {
  readonly compaction?: {
    readonly auto?: boolean
    readonly prune?: boolean
  }
}

const TurnSnapshotSchema = Schema.Struct({
  compaction: Schema.Struct({
    auto: Schema.Boolean.pipe(Schema.optional),
    prune: Schema.Boolean.pipe(Schema.optional),
  }).pipe(Schema.optional),
})

const decodeTurnSnapshot = Schema.decodeUnknownOption(TurnSnapshotSchema, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

export function parseTurnSnapshot(text: string): TurnSnapshot {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return {}
  const projection = Option.getOrUndefined(decodeTurnSnapshot(input))?.compaction
  if (!projection) return {}
  return {
    compaction: {
      ...(projection.auto === undefined ? {} : { auto: projection.auto }),
      ...(projection.prune === undefined ? {} : { prune: projection.prune }),
    },
  }
}

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Returns the single global user-owned Git executable path, if explicitly configured. */
  readonly trustedGitExecutable: () => Effect.Effect<string | undefined>
  /** Lists only verified immutable command profiles from global user config. */
  readonly workspaceCommandProfiles: () => Effect.Effect<WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1[], Error>
  /** Resolves one exact enabled user-owned command profile revision and action from global config. */
  readonly workspaceCommandProfile: (
    profileID: string,
    revision: string,
    action: "build" | "test",
  ) => Effect.Effect<WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1, Error>
  /** Reads only the existing instance-local next-turn compaction toggles. */
  readonly turnSnapshot?: () => Effect.Effect<TurnSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Config") {}

export interface AgentProfileInterface {
  readonly agentProfiles: () => Effect.Effect<AgentProfileV2.AgentProfileDefinitionV2[], AgentProfileConflictError>
  readonly agentProfileSelectors: () => Effect.Effect<AgentProfileSelector[], AgentProfileConflictError | AgentProfileNotFoundError | AgentProfileSelectorConflictError>
  readonly agentProfile: (profileID: string, revision: AgentProfileV2.Revision) => Effect.Effect<AgentProfileV2.AgentProfileDefinitionV2, AgentProfileConflictError | AgentProfileNotFoundError>
  readonly agentProfileSelector: (selector: string) => Effect.Effect<AgentProfileV2.AgentProfileDefinitionV2, AgentProfileConflictError | AgentProfileNotFoundError | AgentProfileSelectorConflictError | AgentProfileSelectorNotFoundError>
  /** Resolves the explicitly configured global primary profile; undefined means no primary selector is configured. */
  readonly primaryAgentProfile: () => Effect.Effect<AgentProfileV2.AgentProfileDefinitionV2 | undefined, AgentProfileConflictError | AgentProfileNotFoundError | AgentProfileSelectorConflictError | AgentProfileRoleError>
}

export class AgentProfileService extends Context.Service<AgentProfileService, AgentProfileInterface>()(
  "@opencode/v2/Config.AgentProfiles",
) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["opencode.json", "opencode.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)
    const decodeProfileDefinition = Schema.decodeUnknownOption(AgentProfileV2.AgentProfileDefinitionV2, {
      errors: "all",
      onExcessProperty: "error",
      propertyOrder: "original",
    })
    const decodeWorkspaceCommandProfile = Schema.decodeUnknownOption(WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1, {
      errors: "all",
      onExcessProperty: "error",
      propertyOrder: "original",
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return
      if (
        typeof input === "object" && input !== null && "agent_profiles" in input &&
        Array.isArray(input.agent_profiles) &&
        input.agent_profiles.some((profile) => Option.isNone(decodeProfileDefinition(profile)))
      ) return
      if (typeof input === "object" && input !== null && "workspace_command_profiles" in input &&
        Array.isArray(input.workspace_command_profiles) &&
        input.workspace_command_profiles.some((profile) => {
          const decoded = Option.getOrUndefined(decodeWorkspaceCommandProfile(profile))
          return !decoded || !WorkspaceCommandProfileV1.validateWorkspaceCommandProfileV1(decoded)
        })) return

      const info = Option.getOrUndefined(
        ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
          : decodeInfo(input),
      )
      if (!info) return
      return new Document({ type: "document", path: filepath, info })
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".opencode", ...names.toReversed()],
            start: location.directory,
            stop: location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".opencode")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".opencode").toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.opencode` files.
    const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    const workspaceCommandProfiles = Effect.fn("Config.workspaceCommandProfiles")(function* () {
      const userConfigDirectory = path.resolve(global.config)
      const configured = configs
        .filter((entry): entry is Document => entry.type === "document" && typeof entry.path === "string" &&
          path.resolve(path.dirname(entry.path)) === userConfigDirectory)
        .flatMap((entry) => entry.info.workspace_command_profiles ?? [])
      const byIdentity = new Map<string, WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1>()
      for (const raw of configured) {
        const profile = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(WorkspaceCommandProfileV1.WorkspaceCommandProfileDefinitionV1, { onExcessProperty: "error" })(raw),
          catch: () => new Error("global WorkspaceCommandProfileV1 is malformed"),
        })
        if (!WorkspaceCommandProfileV1.validateWorkspaceCommandProfileV1(profile)) {
          return yield* Effect.fail(new Error(`WorkspaceCommandProfileV1 ${profile.profileId}@${profile.revision} digest mismatch`))
        }
        const identity = `${profile.profileId}@${profile.revision}`
        const prior = byIdentity.get(identity)
        if (prior && prior.profileDigest !== profile.profileDigest) {
          return yield* Effect.fail(new Error(`conflicting WorkspaceCommandProfileV1 ${identity}`))
        }
        byIdentity.set(identity, profile)
      }
      const profiles = [...byIdentity.values()].sort((left, right) => left.profileId.localeCompare(right.profileId) ||
        (BigInt(left.revision) < BigInt(right.revision) ? -1 : BigInt(left.revision) > BigInt(right.revision) ? 1 : 0))
      const latest = new Map<string, bigint>()
      for (const profile of profiles) {
        const revision = BigInt(profile.revision)
        if (revision <= (latest.get(profile.profileId) ?? 0n)) {
          return yield* Effect.fail(new Error(`WorkspaceCommandProfileV1 ${profile.profileId} revisions are not strictly increasing`))
        }
        latest.set(profile.profileId, revision)
      }
      return profiles
    })

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
      trustedGitExecutable: Effect.fn("Config.trustedGitExecutable")(function* () {
        const userConfigDirectory = path.resolve(global.config)
        const configured = configs
          .filter(
            (entry): entry is Document =>
              entry.type === "document" &&
              typeof entry.path === "string" &&
              path.resolve(path.dirname(entry.path)) === userConfigDirectory,
          )
          .map((entry) => entry.info.git_executable)
          .filter((value): value is string => value !== undefined)
        if (configured.length === 0) return undefined
        if (
          configured.length !== 1 ||
          configured[0].length > 4096 ||
          !path.isAbsolute(configured[0]) ||
          configured[0].includes("\\0")
        ) {
          return undefined
        }
        return configured[0]
      }),
      workspaceCommandProfiles,
      workspaceCommandProfile: Effect.fn("Config.workspaceCommandProfile")(function* (
        profileID: string,
        revision: string,
        action: "build" | "test",
      ) {
        const profile = (yield* workspaceCommandProfiles())
          .find((candidate) => candidate.profileId === profileID && candidate.revision === revision)
        if (!profile || !profile.enabled || !profile.actions.includes(action)) {
          return yield* Effect.fail(new Error(`WorkspaceCommandProfileV1 ${profileID}@${revision} is unavailable for ${action}`))
        }
        return profile
      }),
      turnSnapshot: Effect.fn("Config.turnSnapshot")(function* () {
        const text = yield* fs
          .readFileStringSafe(path.join(location.directory, "config.json"))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!text) return {}
        return parseTurnSnapshot(text)
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})

const agentProfileLayer = Layer.effect(
  AgentProfileService,
  Effect.gen(function* () {
    const config = yield* Service
    const global = yield* Global.Service
    const profiles = Effect.fn("Config.AgentProfiles.list")(function* () {
      const userConfigDirectory = path.resolve(global.config)
      const entries = yield* config.entries()
      const configured = entries
        .filter(
          (entry): entry is Document =>
            entry.type === "document" &&
            typeof entry.path === "string" &&
            path.resolve(path.dirname(entry.path)) === userConfigDirectory,
        )
        .flatMap((entry) => entry.info.agent_profiles ?? [])
        .filter((profile) => profile.source === "user")
      const byIdentity = new Map<string, AgentProfileV2.AgentProfileDefinitionV2>()
      for (const profile of configured) {
        const identity = `${profile.profileId}@${profile.revision}`
        const prior = byIdentity.get(identity)
        if (prior && JSON.stringify(prior) !== JSON.stringify(profile)) {
          return yield* Effect.fail(new AgentProfileConflictError({ profileID: profile.profileId, revision: profile.revision }))
        }
        byIdentity.set(identity, profile)
      }
      return [...byIdentity.values()].sort((left, right) => left.profileId.localeCompare(right.profileId) || (BigInt(left.revision) < BigInt(right.revision) ? -1 : BigInt(left.revision) > BigInt(right.revision) ? 1 : 0))
    })
    const selectors = Effect.fn("Config.AgentProfiles.selectors")(function* () {
      const userConfigDirectory = path.resolve(global.config)
      const entries = yield* config.entries()
      const configured = entries
        .filter(
          (entry): entry is Document =>
            entry.type === "document" &&
            typeof entry.path === "string" &&
            path.resolve(path.dirname(entry.path)) === userConfigDirectory,
        )
        .flatMap((entry) => entry.info.agent_profile_selectors ?? [])
      const bySelector = new Map<string, { profileId: string; revision: AgentProfileV2.Revision }>()
      for (const item of configured) {
        if (bySelector.has(item.selector)) {
          return yield* Effect.fail(new AgentProfileSelectorConflictError({ selector: item.selector }))
        }
        bySelector.set(item.selector, { profileId: item.profileId, revision: item.revision })
      }
      return bySelector
    })
    return AgentProfileService.of({
      agentProfiles: profiles,
      agentProfileSelectors: Effect.fn("Config.AgentProfiles.listSelectors")(function* () {
        const configured = yield* selectors()
        const definitions = yield* profiles()
        const result: AgentProfileSelector[] = []
        for (const [selector, selection] of configured) {
          const profile = definitions.find(
            (candidate) => candidate.profileId === selection.profileId && candidate.revision === selection.revision,
          )
          if (!profile) {
            return yield* Effect.fail(new AgentProfileNotFoundError({ profileID: selection.profileId, revision: selection.revision }))
          }
          result.push({ selector, profile })
        }
        return result.sort((left, right) => left.selector.localeCompare(right.selector))
      }),
      agentProfile: Effect.fn("Config.AgentProfiles.get")(function* (profileID: string, revision: AgentProfileV2.Revision) {
        const profile = (yield* profiles()).find(
          (candidate) => candidate.profileId === profileID && candidate.revision === revision,
        )
        if (profile) return profile
        return yield* Effect.fail(new AgentProfileNotFoundError({ profileID, revision }))
      }),
      agentProfileSelector: Effect.fn("Config.AgentProfiles.resolveSelector")(function* (selector: string) {
        const selection = (yield* selectors()).get(selector)
        if (!selection) return yield* Effect.fail(new AgentProfileSelectorNotFoundError({ selector }))
        const profile = (yield* profiles()).find(
          (candidate) => candidate.profileId === selection.profileId && candidate.revision === selection.revision,
        )
        if (profile) return profile
        return yield* Effect.fail(new AgentProfileNotFoundError({ profileID: selection.profileId, revision: selection.revision }))
      }),
      primaryAgentProfile: Effect.fn("Config.AgentProfiles.resolvePrimary")(function* () {
        const userConfigDirectory = path.resolve(global.config)
        const entries = yield* config.entries()
        const configuredSelectors = entries
          .filter(
            (entry): entry is Document =>
              entry.type === "document" &&
              typeof entry.path === "string" &&
              path.resolve(path.dirname(entry.path)) === userConfigDirectory,
          )
          .map((entry) => entry.info.primary_agent_profile_selector)
          .filter((selector): selector is string => selector !== undefined)
        const distinct = [...new Set(configuredSelectors)]
        if (distinct.length === 0) return undefined
        if (distinct.length !== 1) {
          return yield* Effect.fail(new AgentProfileSelectorConflictError({ selector: "primary" }))
        }
        const selection = (yield* selectors()).get(distinct[0]!)
        if (!selection) {
          return yield* Effect.fail(new AgentProfileSelectorConflictError({ selector: distinct[0]! }))
        }
        const profile = (yield* profiles()).find(
          (candidate) => candidate.profileId === selection.profileId && candidate.revision === selection.revision,
        )
        if (!profile) {
          return yield* Effect.fail(new AgentProfileNotFoundError({ profileID: selection.profileId, revision: selection.revision }))
        }
        if (!profile.enabled || !profile.roles.includes("main")) {
          return yield* Effect.fail(new AgentProfileRoleError({
            profileID: profile.profileId,
            revision: profile.revision,
            role: "main",
          }))
        }
        return profile
      }),
    })
  }),
)

export const agentProfileNode = makeLocationNode({
  service: AgentProfileService,
  layer: agentProfileLayer,
  deps: [node, Global.node],
})
