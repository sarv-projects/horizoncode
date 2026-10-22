import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Truncate } from "./truncate"
import { Config } from "@/config/config"
import { Effect, Layer, Context } from "effect"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { WebSearchInspectProviderTool } from "./websearch-inspect"
import { WebSearchRuntime } from "./websearch-runtime"
import { hasEnabledSearchRouteReady, normalizeSearchCascadeSettings, type SearchCascadeSettings } from "./websearch-broker"
import { LspTool } from "./lsp"
import { DapTool, DAP_TOOL_ACCEPTANCE_READY } from "./dap"
import { debugEffectRouteAvailable } from "@/dap/session"
import { DefinitionsFindTool, ReferencesFindTool, RepoDetectTool, RepoTreeTool, SymbolsSearchTool } from "./repo-tools"
import { ManagedArtifactSearchTool, ManagedTerminalOutputRangeTool, ManagedTerminalSearchTool } from "./managed-artifact-search"
import { HistoryReadRangeTool, HistorySearchTool } from "./history"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { hostProtocolRouteAvailable, languageServiceProcessRouteAvailable } from "@/lsp/launch"
import { Instruction } from "../session/instruction"
import { REPO_INTEL_READ_CONTEXT_FEATURE, WEB_SEARCH_CASCADE_FEATURE, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

/**
 * Source presence is not integrated acceptance. Keep RepoIntel model-visible
 * tools closed until the authenticated HostKernel paths, revision/symlink
 * behavior and end-to-end journeys have been accepted on one revision.
 */
export const REPO_INTEL_TOOL_ACCEPTANCE_READY = false
export const REPO_DISCOVERY_TOOL_ACCEPTANCE_READY = false
export function webSearchEnabled(
  _providerID: ProviderV2.ID,
  settings?: SearchCascadeSettings,
  runtimeReady?: boolean,
) {
  // Search route configuration is not execution authority. Expose the tool
  // only when an explicitly enabled route's own Guard/SecretBroker gate passed.
  if (runtimeReady === undefined) return hasEnabledSearchRouteReady(settings)
  // Explicit override is retained only for the isolated registry contract seam.
  return runtimeReady && normalizeSearchCascadeSettings(settings).enabled.length > 0
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[], SessionSupervisorError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service

    const flags = yield* RuntimeFlags.Service
    const supervisor = yield* SessionSupervisor.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const daptool = yield* DapTool
    const plan = yield* PlanExitTool
    const repoToolSymbols = yield* SymbolsSearchTool
    const repoToolReferences = yield* ReferencesFindTool
    const repoToolDefinitions = yield* DefinitionsFindTool
    const repoTree = yield* RepoTreeTool
    const repoDetect = yield* RepoDetectTool
    const managedArtifactSearch = yield* ManagedArtifactSearchTool
    const managedTerminalSearch = yield* ManagedTerminalSearchTool
    const managedTerminalOutputRange = yield* ManagedTerminalOutputRangeTool
    const historySearch = yield* HistorySearchTool
    const historyReadRange = yield* HistoryReadRangeTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const webSearchInspect = yield* WebSearchInspectProviderTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) {
          const paths = matches.slice(0, 3).map((match) => {
            const relative = path.relative(ctx.directory, match)
            return relative.length > 160 ? `${relative.slice(0, 157)}...` : relative
          })
          const omitted = matches.length - paths.length
          yield* Effect.logWarning("project tool modules are unavailable until a Guard-compatible executor exists", {
            count: matches.length,
            paths,
            omitted,
          })
        }

        // Custom project and plugin tools have no Guard-compatible executor.
        // Do not import project modules or materialize plugin tool definitions.

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          searchInspect: Tool.init(webSearchInspect),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          debug: Tool.init(daptool),
          plan: Tool.init(plan),
          symbolsSearch: Tool.init(repoToolSymbols),
          referencesFind: Tool.init(repoToolReferences),
          definitionsFind: Tool.init(repoToolDefinitions),
          repoTree: Tool.init(repoTree),
          repoDetect: Tool.init(repoDetect),
          managedArtifactSearch: Tool.init(managedArtifactSearch),
          managedTerminalSearch: Tool.init(managedTerminalSearch),
          managedTerminalOutputRange: Tool.init(managedTerminalOutputRange),
          historySearch: Tool.init(historySearch),
          historyReadRange: Tool.init(historyReadRange),
        })

        const repoReadFeatureReady =
          (REPO_INTEL_TOOL_ACCEPTANCE_READY || REPO_DISCOVERY_TOOL_ACCEPTANCE_READY) &&
          (yield* supervisor.hostFeatureEnabled(REPO_INTEL_READ_CONTEXT_FEATURE).pipe(
            Effect.catch(() => Effect.succeed(false)),
          ))
        const repoIntelHostReady = REPO_INTEL_TOOL_ACCEPTANCE_READY && repoReadFeatureReady
        const repoDiscoveryHostReady = REPO_DISCOVERY_TOOL_ACCEPTANCE_READY && repoReadFeatureReady

        return {
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.searchInspect,
            tool.managedArtifactSearch,
            tool.managedTerminalSearch,
            tool.managedTerminalOutputRange,
            tool.historySearch,
            tool.historyReadRange,
            tool.skill,
            tool.patch,
            ...(tool.execute ? [tool.execute] : []),
            ...(flags.experimentalLspTool && languageServiceProcessRouteAvailable() && hostProtocolRouteAvailable()
              ? [tool.lsp]
              : []),
            // Keep the DAP action hidden until its end-to-end Guard/HostKernel
            // acceptance gate is explicitly released. Its execute path also
            // returns the typed unavailable state, so visibility alone cannot
            // accidentally start an adapter.
            ...(DAP_TOOL_ACCEPTANCE_READY && debugEffectRouteAvailable() ? [tool.debug] : []),
            ...(flags.experimentalRepoTools && repoIntelHostReady
              ? [tool.symbolsSearch, tool.definitionsFind, tool.referencesFind]
              : []),
            ...(flags.experimentalRepoTools && repoDiscoveryHostReady
              ? [tool.repoTree, tool.repoDetect]
              : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return s.builtin
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const searchConfig = yield* config.get()
      const webSearchRouteReady = webSearchEnabled(input.providerID, searchConfig.websearch)
      const webSearchHostReady = webSearchRouteReady &&
        (yield* supervisor.hostFeatureEnabled(WEB_SEARCH_CASCADE_FEATURE).pipe(Effect.catch(() => Effect.succeed(false)))) &&
        (yield* supervisor.hostFeatureEnabled("effects.v2").pipe(Effect.catch(() => Effect.succeed(false))))
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchHostReady
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            capability: tool.capability,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Skill.node,
    Session.node,
    BackgroundJob.node,
    Provider.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    SessionSupervisor.node,
    httpClient,
    Truncate.node,
    Format.node,
    RuntimeFlags.node,
    MCP.node,
    Database.node,
    Ripgrep.node,
    locationServiceMapNode,
    WebSearchRuntime.node,
  ],
})

export * as ToolRegistry from "./registry"
