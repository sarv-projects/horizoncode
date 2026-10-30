import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { serviceUse } from "@horizoncode/core/effect/service-use"
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
import { ConfigMCPV1 } from "@horizoncode/core/v1/config/mcp"
import { NamedError } from "@horizoncode/core/util/error"
import { McpAuth } from "./auth"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { McpEvent } from "@horizoncode/schema/mcp-event"
import { Global } from "@horizoncode/core/global"
import path from "node:path"
import { evaluate as evaluatePermissionRule, fromConfig as permissionRuleset } from "@/permission"
import {
  approveServer,
  bindingDigest,
  decideTrust,
  readTrustApprovals,
  revokeServer,
  trustFilePath,
  type McpTrustDecision,
} from "./trust"

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

/** Typed refusal: the server is configured but not approved for this project. */
export class UntrustedError extends Schema.TaggedErrorClass<UntrustedError>()("MCP.UntrustedError", {
  name: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `MCP server ${this.name} is untrusted: ${this.reason}; no process or network start was attempted.`
  }
}

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
/**
 * Typed trust state for a configured server that project configuration
 * introduced and the user has not approved. It is deliberately distinct from
 * `failed`: nothing was started, nothing was attempted, and the fix is an
 * explicit approval, not a retry.
 */
const StatusUntrusted = Schema.Struct({
  status: Schema.Literal("mcp_untrusted"),
  server: Schema.String,
  reason: Schema.String,
  approval: Schema.String,
}).annotate({ identifier: "MCPStatusUntrusted" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
  StatusUntrusted,
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

function untrustedStatus(name: string, decision: Extract<McpTrustDecision, { status: "untrusted" }>): Status {
  return {
    status: "mcp_untrusted",
    server: name,
    reason: decision.message,
    approval: `POST /mcp/${encodeURIComponent(name)}/trust`,
  }
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
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError | MCPFailed | UntrustedError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  /** Record an explicit user approval bound to the exact project server identity. */
  readonly approve: (name: string) => Effect.Effect<Status, NotFoundError | MCPFailed>
  /** Revoke a recorded approval; the server becomes non-startable again. */
  readonly revokeApproval: (name: string) => Effect.Effect<Status, NotFoundError | MCPFailed>
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

export const stubLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const cfgSvc = yield* Config.Service
    const globals = yield* Global.Service
    const trustFile = trustFilePath(globals.data)

    /**
     * Decide trust for one configured server against the user global config,
     * the permission ruleset and the recorded approvals. Pure apart from the
     * bounded trust-file read; it never starts or contacts anything.
     */
    const trustDecision = Effect.fnUntraced(function* (name: string, mcp: ConfigMCPV1.Info, directory: string) {
      const globalConfig = yield* cfgSvc.getGlobal()
      const approvals = yield* Effect.promise(() => readTrustApprovals(trustFile))
      const candidate = globalConfig.mcp?.[name]
      const globalEntry = candidate && isMcpConfigured(candidate) ? candidate : undefined
      // Permission-rule pre-approval is read from the user-global config only.
      // A project document must never be able to approve its own server, so the
      // merged (project-overlaid) ruleset is deliberately not consulted here.
      return decideTrust({
        server: name,
        entry: mcp,
        ...(globalEntry ? { globalEntry } : {}),
        directory,
        approvals,
        rule: evaluatePermissionRule("mcp", name, permissionRuleset(globalConfig.permission ?? {})).action,
      })
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* (ctx) {
        const cfg = yield* cfgSvc.get()
        const s: State = { status: {} }
        const directory = path.resolve(ctx.directory)

        for (const [key, mcp] of Object.entries(cfg.mcp ?? {})) {
          if (!isMcpConfigured(mcp)) {
            yield* Effect.logError("Ignoring MCP config entry without type", { key })
            continue
          }

          // Trust is evaluated before any start path exists for these servers.
          const decision = yield* trustDecision(key, mcp, directory)
          s.status[key] = decision.status === "trusted" ? unavailableStatus(mcp) : untrustedStatus(key, decision)
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
      const mcp = yield* requireMcpConfig(name)
      const instance = yield* InstanceState.context
      const decision = yield* trustDecision(name, mcp, path.resolve(instance.directory))
      const s = yield* InstanceState.get(state)
      if (decision.status === "untrusted") {
        // Fail closed before any transport, process or credential path exists.
        s.status[name] = untrustedStatus(name, decision)
        return yield* Effect.fail(new UntrustedError({ name, reason: decision.message }))
      }
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

    const approve = Effect.fn("MCP.approve")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      const instance = yield* InstanceState.context
      yield* Effect.tryPromise({
        try: () => approveServer({
          file: trustFile,
          directory: path.resolve(instance.directory),
          server: name,
          binding: bindingDigest(mcp),
        }),
        catch: () => new Failed({ name: "MCP trust record could not be written" }),
      })
      yield* InstanceState.invalidate(state)
      return (yield* InstanceState.get(state)).status[name] ?? { status: "disabled" as const }
    })

    const revokeApproval = Effect.fn("MCP.revokeApproval")(function* (name: string) {
      yield* requireMcpConfig(name)
      const instance = yield* InstanceState.context
      yield* Effect.tryPromise({
        try: () => revokeServer({
          file: trustFile,
          directory: path.resolve(instance.directory),
          server: name,
        }),
        catch: () => new Failed({ name: "MCP trust record could not be revoked" }),
      })
      yield* InstanceState.invalidate(state)
      return (yield* InstanceState.get(state)).status[name] ?? { status: "disabled" as const }
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
      approve,
      revokeApproval,
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


