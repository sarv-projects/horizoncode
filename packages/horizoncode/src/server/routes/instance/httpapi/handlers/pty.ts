import * as InstanceState from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { TrustedPrincipalContext, type TrustedPrincipalContextValue } from "@horizoncode/core/trusted-principal"
import { SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { Pty } from "@horizoncode/core/pty"
import { PtyProtocol, withinTerminalBackpressureLimit } from "@horizoncode/core/pty/protocol"
import { Shell } from "@horizoncode/core/shell"
import { PtyID } from "@horizoncode/core/pty/schema"
import { PtyTicket } from "@horizoncode/core/pty/ticket"
import { LocationServiceMap, locationServiceMapLayer } from "@horizoncode/core/location-services"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { CorsConfig, type CorsOptions } from "@horizoncode/server/cors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@/server/shared/pty-ticket"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { CursorQuery, PtyConnectApi } from "../groups/pty"
import { WebSocketTracker } from "../websocket-tracker"

type PtyHttpError =
  | Pty.InvalidInputError
  | Pty.NotFoundError
  | Pty.ExitedError
  | Pty.UnavailableError
  | Pty.ShellProfileUnavailableError
  | SessionSupervisorError

const DEFAULT_TERMINAL_ORIGINS: Record<string, true> = {
  "oc://renderer": true,
  "tauri://localhost": true,
  "http://tauri.localhost": true,
  "https://tauri.localhost": true,
}

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  const origin = request.headers.origin
  if (!origin) return false
  if (DEFAULT_TERMINAL_ORIGINS[origin] === true) return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      (opts?.cors?.includes(origin) ?? false)
    )
  } catch {
    return false
  }
}

function principal(value: TrustedPrincipalContextValue | undefined) {
  if (!value) return undefined
  return value.principal.kind === "server_auth" ? `server-auth:${value.principal.subject}` : "host_os"
}

const ticketScope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return { directory: instance?.directory, workspaceID }
})

// Legacy surface compatibility: before exited-session retention, sessions vanished the moment
// their process exited. These routes preserve that observable behavior — exited sessions are
// invisible here — while the canonical /api/pty surface exposes them until removal.
export const ptyHandlers = HttpApiBuilder.group(InstanceHttpApi, "pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const locations = yield* LocationServiceMap.Service
    const unregister = registerDisposer((directory) =>
      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    const ptyInvalid = (error: Pty.InvalidInputError) => new ApiError.InvalidRequestError({ message: error.reason })
    const ptyMissing = (error: Pty.NotFoundError | Pty.ExitedError) =>
      new ApiError.PtyNotFoundError({ ptyID: error.ptyID, message: `PTY session not found: ${error.ptyID}` })
    const ptyUnavailable = (error: Pty.UnavailableError) =>
      new ApiError.ServiceUnavailableError({
        message: `PTY session is unavailable: ${error.ptyID}`,
        service: "pty",
      })
    const shellUnavailable = () =>
      new ApiError.ServiceUnavailableError({ message: "Shell profile is unavailable", service: "pty" })
    const hostUnavailable = (error: SessionSupervisorError) =>
      new ApiError.ServiceUnavailableError({ message: error.message, service: "host-kernel" })

    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const shells = Effect.fn("PtyHttpApi.shells")(function* () {
      return yield* Effect.promise(() => Shell.list())
    })

    const list = Effect.fn("PtyHttpApi.list")(function* () {
      const sessions = yield* pty(Pty.Service.use((service) => service.list())).pipe(Effect.catchTag("SessionSupervisorError", hostUnavailable))
      return sessions.filter((info) => info.status === "running")
    })

    const create = Effect.fn("PtyHttpApi.create")(function* (ctx: { payload: typeof Pty.CreateInput.Type }) {
      const cwd = ctx.payload.cwd || (yield* InstanceState.context).directory
      const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(principalContext))
        return yield* new ApiError.PtyForbiddenError({ message: "PTY creation requires a trusted principal" })
      return yield* pty(
        Pty.Service.use((service) =>
          service.create({
            ...ctx.payload,
            args: ctx.payload.args ? [...ctx.payload.args] : undefined,
            cwd,
            env: ctx.payload.env ? { ...ctx.payload.env } : undefined,
          }),
        ).pipe(Effect.provideService(TrustedPrincipalContext, principalContext.value)),
      )
        .pipe(
          Effect.catchTag("Pty.InvalidInputError", ptyInvalid),
          Effect.catchTag("Pty.ShellProfileUnavailableError", shellUnavailable),
          Effect.catchTag("Pty.UnavailableError", ptyUnavailable),
          Effect.catchTag("SessionSupervisorError", hostUnavailable),
        )
    })

    const get = Effect.fn("PtyHttpApi.get")(function* (ctx: { params: { ptyID: PtyID } }) {
      const info = yield* pty(Pty.Service.use((service) => service.get(ctx.params.ptyID))).pipe(
        Effect.catchTag("Pty.NotFoundError", ptyMissing),
        Effect.catchTag("SessionSupervisorError", hostUnavailable),
      )
      if (info.status !== "running")
        return yield* new ApiError.PtyNotFoundError({
          ptyID: ctx.params.ptyID,
          message: `PTY session not found: ${ctx.params.ptyID}`,
        })
      return info
    })

    const update = Effect.fn("PtyHttpApi.update")(function* (ctx: {
      params: { ptyID: PtyID }
      payload: typeof Pty.UpdateInput.Type
    }) {
      yield* get(ctx)
      return yield* pty(
        Pty.Service.use((service) =>
          service.update(ctx.params.ptyID, {
            ...ctx.payload,
            size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
          }),
        ),
      ).pipe(
        Effect.catchTag("Pty.NotFoundError", ptyMissing),
        Effect.catchTag("Pty.ExitedError", ptyMissing),
        Effect.catchTag("Pty.InvalidInputError", ptyInvalid),
        Effect.catchTag("Pty.UnavailableError", ptyUnavailable),
        Effect.catchTag("SessionSupervisorError", hostUnavailable),
      )
    })

    const remove = Effect.fn("PtyHttpApi.remove")(function* (ctx: { params: { ptyID: PtyID } }) {
      yield* get(ctx)
      yield* pty(Pty.Service.use((service) => service.remove(ctx.params.ptyID)))
        .pipe(
          Effect.catchTag("Pty.NotFoundError", ptyMissing),
          Effect.catchTag("SessionSupervisorError", hostUnavailable),
        )
      return true
    })

    const connectToken = Effect.fn("PtyHttpApi.connectToken")(function* (ctx: { params: { ptyID: PtyID } }) {
      yield* get(ctx)
      const request = yield* HttpServerRequest.HttpServerRequest
      const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
      const identity = Option.isSome(principalContext) ? principal(principalContext.value) : undefined
      if (
        !identity ||
        request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
        !validOrigin(request, cors)
      )
        return yield* new ApiError.PtyForbiddenError({ message: "Invalid PTY connect token request" })
      return yield* tickets.issue({
        ptyID: ctx.params.ptyID,
        ...(yield* ticketScope),
        principal: identity,
        origin: request.headers.origin!,
      })
    })

    return handlers
      .handle("shells", shells)
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("connectToken", connectToken)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>

  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const locations = yield* LocationServiceMap.Service

    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    return handlers.handleRaw(
      "connect",
      Effect.fn("PtyHttpApi.connect")(function* (ctx: {
        params: { ptyID: PtyID }
        request: HttpServerRequest.HttpServerRequest
      }) {
        const reachable = yield* pty(Pty.Service.use((service) => service.get(ctx.params.ptyID))).pipe(
          Effect.map((info) => info.status === "running"),
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
          Effect.catchTag("SessionSupervisorError", () => Effect.succeed("unavailable" as const)),
        )
        if (reachable === "unavailable") return HttpServerResponse.empty({ status: 503 })
        if (!reachable) return HttpServerResponse.empty({ status: 404 })

        const query = Schema.decodeUnknownOption(CursorQuery)(yield* HttpServerRequest.ParsedSearchParams)
        if (Option.isNone(query)) return HttpServerResponse.empty({ status: 400 })
        const url = new URL(ctx.request.url, "http://localhost")
        const ticketValues = url.searchParams.getAll(PTY_CONNECT_TICKET_QUERY)
        const origin = ctx.request.headers.origin
        const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
        const identity = Option.isSome(principalContext) ? principal(principalContext.value) : undefined
        if (!origin || !validOrigin(ctx.request, cors) || !identity) return HttpServerResponse.empty({ status: 403 })
        if (ticketValues.length > 1 || (ticketValues.length === 1 && ticketValues[0] === ""))
          return HttpServerResponse.empty({ status: 403 })
        const requestedProtocols = ctx.request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((value) => value.trim())
        if (
          requestedProtocols &&
          (requestedProtocols.length !== 1 || requestedProtocols[0] !== "horizon.terminal.v1")
        )
          return HttpServerResponse.empty({ status: 400 })
        if (requestedProtocols) return HttpServerResponse.empty({ status: 403 })
        if (ticketValues.length === 1) {
          const valid = yield* tickets.consume({
            ticket: ticketValues[0],
            ptyID: ctx.params.ptyID,
            ...(yield* ticketScope),
            principal: identity,
            origin,
          })
          if (!valid) return HttpServerResponse.empty({ status: 403 })
        }
        const parsedCursor = query.value.cursor === undefined ? undefined : Number(query.value.cursor)
        const cursor =
          parsedCursor !== undefined && Number.isSafeInteger(parsedCursor) && parsedCursor >= -1
            ? parsedCursor
            : undefined
        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const write = yield* socket.writer
        const closeAccepted = (event: Socket.CloseEvent) =>
          socket
            .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
            .pipe(
              Effect.timeout("1 second"),
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.catch(() => Effect.void),
            )
        const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
        if (!registered) {
          yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
          return HttpServerResponse.empty()
        }

        // Outbound frames flow through one queue drained by a single writer so replay, live
        // output, and the close frame keep their order.
        const outbox = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
        let queuedBytes = 0
        let overflowed = false
        const enqueue = (item: string | Uint8Array) => {
          if (overflowed) return
          const size = typeof item === "string" ? Buffer.byteLength(item, "utf8") : item.byteLength
          if (!withinTerminalBackpressureLimit(queuedBytes, size)) {
            overflowed = true
            Queue.offerUnsafe(outbox, new Socket.CloseEvent(1013, "terminal output backlog exceeded"))
            return
          }
          queuedBytes += size
          Queue.offerUnsafe(outbox, item)
        }
        const replayDecoder = new TextDecoder()
        const attachment = yield* pty(
          Pty.Service.use((service) =>
            service.attach(ctx.params.ptyID, {
              cursor,
              origin,
              protocol: "legacy",
              onData: (chunk) => enqueue(replayDecoder.decode(chunk, { stream: true })),
              onEnd: () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000)),
            }),
          ),
        ).pipe(
          Effect.catchTags({
            "Pty.NotFoundError": () =>
              closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
            "Pty.ExitedError": () =>
              closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
            "Pty.InvalidInputError": () =>
              closeAccepted(new Socket.CloseEvent(4403, "invalid terminal connection")).pipe(Effect.as(undefined)),
            "Pty.UnavailableError": () =>
              closeAccepted(new Socket.CloseEvent(4403, "terminal connection unavailable")).pipe(Effect.as(undefined)),
            SessionSupervisorError: () =>
              closeAccepted(new Socket.CloseEvent(4403, "terminal connection unavailable")).pipe(Effect.as(undefined)),
          }),
        )
        if (!attachment) return HttpServerResponse.empty()

        for (const event of attachment.replay) {
          if (event.kind !== "output" || !(event.payload instanceof Uint8Array)) continue
          const text = replayDecoder.decode(event.payload, { stream: true })
          for (const part of PtyProtocol.chunks(text)) enqueue(part)
        }
        enqueue(new Uint8Array(PtyProtocol.metaFrame(attachment.cursor)))
        attachment.activate()

        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            if (typeof item === "string") queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(item, "utf8"))
            else if (!(item instanceof Socket.CloseEvent)) queuedBytes = Math.max(0, queuedBytes - item.byteLength)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })

        // The reader runs concurrently with the writer; whichever finishes first ends the
        // connection and the attachment is always released.
        yield* Effect.race(
          drain,
          socket.runRaw((message) => {
            const decoded = PtyProtocol.decodeInput(message)
            if (decoded !== undefined) attachment.write(decoded)
          }),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(Effect.sync(() => attachment.detach())),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
).pipe(Layer.provide(locationServiceMapLayer))
