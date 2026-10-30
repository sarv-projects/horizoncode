import { MCP } from "@/mcp"
import { ConfigMCPV1 } from "@horizoncode/core/v1/config/mcp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { McpServerNotFoundError, ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const AddPayload = Schema.Struct({
  name: Schema.String,
  config: ConfigMCPV1.Info,
})

export const StatusMap = Schema.Record(Schema.String, MCP.Status)
export const AuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})
export const AuthCallbackPayload = Schema.Struct({
  code: Schema.String,
})
export const AuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})
export class UnsupportedOAuthError extends Schema.ErrorClass<UnsupportedOAuthError>("McpUnsupportedOAuthError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export const McpPaths = {
  status: "/mcp",
  auth: "/mcp/:name/auth",
  authCallback: "/mcp/:name/auth/callback",
  authAuthenticate: "/mcp/:name/auth/authenticate",
  connect: "/mcp/:name/connect",
  disconnect: "/mcp/:name/disconnect",
  trust: "/mcp/:name/trust",
} as const

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("status", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Status), "MCP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.status",
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
          }),
        ),
        HttpApiEndpoint.post("add", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          payload: AddPayload,
          success: described(StatusMap, "MCP server status"),
          error: [HttpApiError.BadRequest, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description:
              "MCP server registration is unavailable until the Rust execution broker can mediate transport startup.",
          }),
        ),
        HttpApiEndpoint.post("authStart", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthStartResponse, "OAuth authorization response"),
          error: [UnsupportedOAuthError, McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.start",
            summary: "Start MCP OAuth",
            description: "MCP OAuth startup is unavailable until the Rust execution broker supports the connection.",
          }),
        ),
        HttpApiEndpoint.post("authCallback", McpPaths.authCallback, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AuthCallbackPayload,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [HttpApiError.BadRequest, McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "MCP OAuth callback processing is unavailable until the Rust execution broker supports credential effects.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", McpPaths.authAuthenticate, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [UnsupportedOAuthError, McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.authenticate",
            summary: "Authenticate MCP OAuth",
            description:
              "MCP OAuth startup and browser authorization are unavailable until the Rust execution broker supports the connection.",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthRemoveResponse, "OAuth credential removal result"),
          error: [McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.remove",
            summary: "Remove MCP OAuth",
            description: "MCP credential removal is unavailable until it is mediated by the Rust execution broker.",
          }),
        ),
        HttpApiEndpoint.post("connect", McpPaths.connect, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "MCP connection result"),
          error: [McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.connect",
            description:
              "MCP connection startup is unavailable until the Rust execution broker supports the transport.",
          }),
        ),
        HttpApiEndpoint.post("trust", McpPaths.trust, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "MCP server trust recorded"),
          error: [McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.trust.approve",
            summary: "Approve an MCP server",
            description:
              "Record an explicit, per-project user approval bound to the exact configured server identity (command, cwd, environment, URL and headers). A project-introduced server is never started before this approval exists.",
          }),
        ),
        HttpApiEndpoint.delete("untrust", McpPaths.trust, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "MCP server trust revoked"),
          error: [McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.trust.revoke",
            summary: "Revoke MCP server approval",
            description:
              "Delete the recorded approval for this project and server. The server returns to the typed mcp_untrusted state and is not startable.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", McpPaths.disconnect, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "MCP server disconnected successfully"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.disconnect",
            description: "Disconnect an MCP server.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "mcp",
          description: "Experimental HttpApi MCP routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
