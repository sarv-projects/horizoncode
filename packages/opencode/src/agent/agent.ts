import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { AgentProfileService } from "@opencode-ai/core/config"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { builtinHarnessProfileV1 } from "@opencode-ai/core/harness-profile"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info, SessionSupervisorError>
  readonly getProfile: (profileID: string, revision: number) => Effect.Effect<Info, SessionSupervisorError>
  readonly list: () => Effect.Effect<Info[], SessionSupervisorError>
  readonly defaultInfo: () => Effect.Effect<Info, SessionSupervisorError>
  readonly defaultAgent: () => Effect.Effect<string, SessionSupervisorError>
  /** The exact global Config-selected main profile, if explicitly configured. No display-name fallback. */
  readonly primaryProfileDefinition: () => Effect.Effect<AgentProfileV2.AgentProfileDefinitionV2 | undefined, SessionSupervisorError>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError | SessionSupervisorError
  >
}

type State = Omit<Interface, "generate" | "getProfile" | "primaryProfileDefinition">

// AgentProfileV2 uses canonical capability IDs. The direct-session permission
// engine still evaluates OpenCode tool IDs, so translate only the capability IDs
// that this native harness actually exposes. Unknown entries fail closed below.
const PROFILE_CAPABILITY_TO_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "files.read": ["read"],
  "files.write": ["write"],
  "files.patch": ["apply_patch"],
  "terminal.run": ["bash"],
  "glob.search": ["glob"],
  "text.search": ["grep"],
  "repo.tree": ["repo_tree"],
  "repo.detect": ["repo_detect"],
  "symbols.search": ["symbols_search"],
  "definitions.find": ["definitions_find"],
  "references.find": ["references_find"],
  "question.ask": ["question"],
  "tools.search": ["tools_search"],
}

function profileAgent(profile: AgentProfileV2.AgentProfileDefinitionV2): Info {
  return {
    name: profile.name,
    description: profile.description,
    mode: "subagent",
    permission: profile.tools.flatMap((rule) =>
      (PROFILE_CAPABILITY_TO_TOOLS[rule.toolPattern] ?? []).map((toolID) => ({
        permission: toolID,
        pattern: rule.resourcePattern ?? "*",
        action: rule.effect,
      })),
    ),
    model: {
      providerID: ProviderV2.ID.make(profile.model.providerId),
      modelID: ModelV2.ID.make(profile.model.modelId),
    },
    prompt: [
      profile.purpose,
      profile.whenToUse ? `When to use: ${profile.whenToUse}` : "",
      profile.whenNotToUse ? `When not to use: ${profile.whenNotToUse}` : "",
    ].filter(Boolean).join("\n\n"),
    options: {
      horizonHarness: profile.harness,
      reasoning: profile.reasoning,
      ...(profile.model.reasoningEffort ? { reasoningEffort: profile.model.reasoningEffort } : {}),
      horizonAgentProfile: {
        profileId: profile.profileId,
        revision: profile.revision,
        harness: profile.harness,
        allowedSkillIds: profile.allowedSkillIds,
        deniedSkillIds: profile.deniedSkillIds,
        allowedMcpServers: profile.allowedMcpServers,
        allowedMcpToolPatterns: profile.allowedMcpToolPatterns,
        allowedSubagentIds: profile.allowedSubagentIds,
        deniedSubagentIds: profile.deniedSubagentIds,
        context: profile.context,
        memoryPolicy: profile.memoryPolicy,
        isolation: profile.isolation,
        inputMode: profile.inputMode,
        lifecycleHooks: profile.lifecycleHooks,
        limits: profile.limits,
      },
    },
    native: false,
    hidden: false,
    topP: undefined,
    temperature: undefined,
    color: undefined,
    variant: undefined,
    steps: undefined,
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State, SessionSupervisorError>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const selectedHarness = cfg.harness ?? "native-rich"
        if (!builtinHarnessProfileV1(selectedHarness)) {
          throw new SessionSupervisorError({ stage: "agent-profile", reason: `selected harness ${selectedHarness} is unavailable` })
        }
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const agent of Object.values(agents)) {
          if (agent.mode !== "subagent" && agent.options.horizonHarness === undefined) {
            agent.options.horizonHarness = selectedHarness
          }
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      getProfile: Effect.fn("Agent.getProfile")(function* (profileID: string, revision: number) {
        const ctx = yield* InstanceState.context
        return yield* Effect.gen(function* () {
          const profiles = yield* AgentProfileService
          const profile = yield* profiles.agentProfile(profileID, revision).pipe(
            Effect.mapError((error) => new SessionSupervisorError({
              stage: "agent-profile",
              reason: `pinned profile ${profileID}@${revision} is unavailable: ${error.message}`,
            })),
          )
          if (!profile.enabled || !profile.roles.includes("subagent")) {
            return yield* new SessionSupervisorError({
              stage: "agent-profile",
              reason: `pinned profile ${profileID}@${revision} is disabled or is not a subagent profile`,
            })
          }
          if (profile.instructions.baseRef || profile.instructions.extraRefs.length > 0) {
            return yield* new SessionSupervisorError({
              stage: "agent-profile",
              reason: `pinned profile ${profileID}@${revision} references instructions that the direct-session artifact resolver cannot load`,
            })
          }
          if (profile.adapter.kind !== "native" || profile.adapter.adapterId !== "horizon.native" || !builtinHarnessProfileV1(profile.harness)) {
            return yield* new SessionSupervisorError({
              stage: "agent-profile",
              reason: `adapter ${profile.adapter.kind}/${profile.adapter.adapterId} with harness ${profile.harness} is not available in the direct-session runtime`,
            })
          }
          if (
            profile.tools.some((rule) => PROFILE_CAPABILITY_TO_TOOLS[rule.toolPattern] === undefined) ||
            profile.variants.length > 0 ||
            profile.capabilityCeiling.length > 0 ||
            profile.pathRules.length > 0 ||
            profile.allowedSkillIds.length > 0 ||
            profile.deniedSkillIds.length > 0 ||
            profile.allowedMcpServers.length > 0 ||
            profile.allowedMcpToolPatterns.length > 0 ||
            profile.allowedSubagentIds.length > 0 ||
            profile.deniedSubagentIds.length > 0 ||
            profile.tools.some((rule) =>
              rule.effect !== "deny" &&
              (rule.toolPattern === "skill" || rule.toolPattern === "task" || rule.toolPattern === "mcp" || rule.toolPattern.startsWith("mcp.")),
            ) ||
            profile.context.isolation !== "fresh" ||
            profile.context.maxParentHistoryTokens !== undefined ||
            !profile.context.allowImages ||
            !profile.context.allowDocuments ||
            !profile.context.allowArtifacts ||
            profile.memoryPolicy !== "none" ||
            profile.isolation !== "workspace" ||
            profile.inputMode !== "default" ||
            profile.lifecycleHooks.length > 0 ||
            profile.limits.tokenBudget !== undefined
          ) {
            return yield* new SessionSupervisorError({
              stage: "agent-profile",
              reason: `pinned profile ${profileID}@${revision} requests an unsupported tool capability, variant, capability ceiling, context, memory, isolation, hook, skill, MCP, subagent, path or token-budget control that the direct-session runtime cannot enforce`,
            })
          }
          return profileAgent(profile)
        }).pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
        )
      }),
      list: Effect.fn("Agent.list")(function* () {
        const ordinary = yield* InstanceState.useEffect(state, (s) => s.list())
        const primary = ordinary.filter((item) => item.mode !== "subagent")
        const ctx = yield* InstanceState.context
        const profileSelectors = yield* Effect.gen(function* () {
          const profiles = yield* AgentProfileService
          return yield* profiles.agentProfileSelectors()
        }).pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
        )
        const configured: Info[] = []
        for (const selection of profileSelectors) {
          if (!selection.profile.enabled || !selection.profile.roles.includes("subagent")) continue
          const projection = yield* (yield* Service).getProfile(selection.profile.profileId, selection.profile.revision).pipe(
            Effect.option,
          )
          if (Option.isSome(projection)) configured.push({ ...projection.value, name: selection.selector })
        }
        return [...primary, ...configured]
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      primaryProfileDefinition: Effect.fn("Agent.primaryProfileDefinition")(function* () {
        const ctx = yield* InstanceState.context
        return yield* Effect.gen(function* () {
          const profiles = yield* AgentProfileService
          return yield* profiles.primaryAgentProfile().pipe(
            Effect.mapError((error) => new SessionSupervisorError({
              stage: "agent-profile",
              reason: `primary AgentProfileV2 selection is unavailable: ${error.message}`,
            })),
          )
        }).pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
        )
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"
