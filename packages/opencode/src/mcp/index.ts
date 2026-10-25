import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type {
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { NamedError } from "@opencode-ai/core/util/error"
import { McpAuth } from "./auth"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { McpEvent } from "@opencode-ai/schema/mcp-event"

const CONNECTION_UNAVAILABLE =
  "MCP connections are unavailable until the canonical Rust execution broker supports MCP process and network effects."

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged
export const BrowserOpenFailed = McpEvent.BrowserOpenFailed
export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})
type MCPFailed = InstanceType<typeof Failed>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

type PromptInfo = ListPromptsResult["prompts"][number]
type ResourceInfo = ListResourcesResult["resources"][number]
type ResourceTemplateInfo = ListResourceTemplatesResult["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function unavailableStatus(mcp: ConfigMCPV1.Info): Status {
  return mcp.enabled === false ? { status: "disabled" } : { status: "failed", error: CONNECTION_UNAVAILABLE }
}

interface State {
  status: Record<string, Status>
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

/** An MCP tool in its native shape; consumers adapt it to their own tool format. */
export interface McpTool {
  /** Shared cached definition; consumers must copy rather than mutate it. */
  readonly def: MCPToolDef
  readonly client: MCPClient
  readonly timeout?: number
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpTool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (
    name: string,
    mcp: ConfigMCPV1.Info,
  ) => Effect.Effect<{ status: Record<string, Status> | Status }, MCPFailed>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError | MCPFailed>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<GetPromptResult | undefined>
  readonly readResource: (clientName: string, resourceUri: string) => Effect.Effect<ReadResourceResult | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError | MCPFailed>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError | MCPFailed>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError | MCPFailed>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void, MCPFailed>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/MCP") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const cfgSvc = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const s: State = { status: {} }

        for (const [key, mcp] of Object.entries(cfg.mcp ?? {})) {
          if (!isMcpConfigured(mcp)) {
            yield* Effect.logError("Ignoring MCP config entry without type", { key })
            continue
          }

          s.status[key] = unavailableStatus(mcp)
        }

        return s
      }),
    )

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)
      const config = (yield* cfgSvc.get()).mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      return {}
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      return []
    })

    const add = Effect.fn("MCP.add")(function* (_name: string, _mcp: ConfigMCPV1.Info) {
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      s.status[name] = { status: "failed", error: CONNECTION_UNAVAILABLE }
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      return {}
    })

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return {}
    })

    const resources = Effect.fn("MCP.resources")(function* (_clientName?: string) {
      return {}
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (_clientName?: string) {
      return {}
    })
    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      _name: string,
      _args?: Record<string, string>,
    ) {
      yield* Effect.logWarning("MCP prompt unavailable without a connected server", { clientName })
      return undefined
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      yield* Effect.logWarning("MCP resource unavailable without a connected server", { clientName, resourceUri })
      return undefined
    })
    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcp = yield* requireMcpConfig(mcpName)
      if (mcp.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcp.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      _onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const mcp = yield* requireMcpConfig(mcpName)
      const s = yield* InstanceState.get(state)
      s.status[mcpName] = unavailableStatus(mcp)
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, _authorizationCode: string) {
      const mcp = yield* requireMcpConfig(mcpName)
      const s = yield* InstanceState.get(state)
      s.status[mcpName] = unavailableStatus(mcp)
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (_mcpName: string) {
      return yield* Effect.fail(new Failed({ name: CONNECTION_UNAVAILABLE }))
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const mcpConfig = (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      prompts,
      resources,
      resourceTemplates,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [McpAuth.node, Config.node],
})

export * as MCP from "."
