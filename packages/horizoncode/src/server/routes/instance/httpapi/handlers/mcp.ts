import { MCP } from "@/mcp"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError, ServiceUnavailableError } from "../errors"
import { AddPayload, AuthCallbackPayload, StatusMap, UnsupportedOAuthError } from "../groups/mcp"

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = yield* mcp
        .add(ctx.payload.name, ctx.payload.config)
        .pipe(
          Effect.catchIf(MCP.Failed.isInstance, (error) =>
            Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
          ),
        )
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp.finishAuth(ctx.params.name, ctx.payload.code).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp
        .removeAuth(ctx.params.name)
        .pipe(
          Effect.catchIf(MCP.Failed.isInstance, (error) =>
            Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
          ),
        )
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp.connect(ctx.params.name).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        // A project-introduced server that the user has not approved refuses
        // before any start path. The typed mcp_untrusted status carries the
        // actionable reason; the transport error stays unavailable.
        Effect.catchTag("MCP.UntrustedError", (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.message, service: "mcp" })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const trust = Effect.fn("McpHttpApi.trust")(function* (ctx: { params: { name: string } }) {
      return yield* mcp.approve(ctx.params.name).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
    })

    const untrust = Effect.fn("McpHttpApi.untrust")(function* (ctx: { params: { name: string } }) {
      return yield* mcp.revokeApproval(ctx.params.name).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
        Effect.catchIf(MCP.Failed.isInstance, (error) =>
          Effect.fail(new ServiceUnavailableError({ message: error.data.name, service: "mcp" })),
        ),
      )
    })

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
      .handle("trust", trust)
      .handle("untrust", untrust)
  }),
)
