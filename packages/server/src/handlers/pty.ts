import { Pty } from "@opencode-ai/core/pty"
import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { PtyProtocol, withinTerminalBackpressureLimit } from "@opencode-ai/core/pty/protocol"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Location } from "@opencode-ai/core/location"
import { Effect, Option, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { Api } from "../api"
import { CorsConfig, type CorsOptions } from "../cors"
import { ForbiddenError, InvalidRequestError, PtyNotFoundError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@opencode-ai/protocol/groups/pty"
import { response } from "../location"
import { PtyEnvironment } from "../pty-environment"

const TERMINAL_ORIGINS: Record<string, true> = {
  "oc://renderer": true,
  "tauri://localhost": true,
  "http://tauri.localhost": true,
  "https://tauri.localhost": true,
}

function validOrigin(origin: string | undefined, host: string | undefined, options: CorsOptions | undefined) {
  if (!origin) return false
  if (TERMINAL_ORIGINS[origin] === true) return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      (parsed.host === host || (options?.cors?.includes(origin) ?? false))
    )
  } catch {
    return false
  }
}
const ptyInvalid = (error: Pty.InvalidInputError) => new InvalidRequestError({ message: error.reason })
const ptyMissing = (error: Pty.NotFoundError | Pty.ExitedError) =>
  new PtyNotFoundError({ ptyID: error.ptyID, message: `PTY session not found: ${error.ptyID}` })
const ptyUnavailable = (error: Pty.UnavailableError) =>
  new ServiceUnavailableError({ message: `PTY session is unavailable: ${error.ptyID}`, service: "pty" })
const shellUnavailable = () => new ServiceUnavailableError({ message: "Shell profile is unavailable", service: "pty" })
const hostUnavailable = (error: SessionSupervisorError) =>
  new ServiceUnavailableError({ message: error.message, service: "host-kernel" })

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const cors = yield* CorsConfig
    const environment = yield* PtyEnvironment.Service

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* () {
          return yield* response((yield* Pty.Service).list())
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          const cwd = ctx.payload.cwd || location.directory
          const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(principalContext))
            return yield* new ForbiddenError({ message: "PTY creation requires a trusted principal" })
          return yield* response(
            pty.create({
              ...ctx.payload,
              args: ctx.payload.args ? [...ctx.payload.args] : undefined,
              cwd,
              env: {
                ...ctx.payload.env,
                ...(yield* environment.get({ directory: location.directory, cwd })),
              },
            })
              .pipe(
                Effect.provideService(TrustedPrincipalContext, principalContext.value),
                Effect.catchTag("Pty.InvalidInputError", ptyInvalid),
                Effect.catchTag("Pty.ShellProfileUnavailableError", shellUnavailable),
                Effect.catchTag("Pty.UnavailableError", ptyUnavailable),
                Effect.catchTag("SessionSupervisorError", hostUnavailable),
              ),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty.get(ctx.params.ptyID).pipe(Effect.catchTag("Pty.NotFoundError", ptyMissing)),
          )
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty
              .update(ctx.params.ptyID, {
                ...ctx.payload,
                size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
              })
              .pipe(
                Effect.catchTag("Pty.NotFoundError", ptyMissing),
                Effect.catchTag("Pty.ExitedError", ptyMissing),
                Effect.catchTag("Pty.InvalidInputError", ptyInvalid),
                Effect.catchTag("Pty.UnavailableError", ptyUnavailable),
                Effect.catchTag("SessionSupervisorError", hostUnavailable),
              ),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          yield* pty
            .remove(ctx.params.ptyID)
            .pipe(
              Effect.catchTag("Pty.NotFoundError", ptyMissing),
              Effect.catchTag("SessionSupervisorError", hostUnavailable),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          const origin = request.headers.origin
          const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(principalContext))
            return yield* new ForbiddenError({ message: "PTY connect requires a trusted principal" })
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !validOrigin(origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          const pty = yield* Pty.Service
          yield* pty.get(ctx.params.ptyID).pipe(
            Effect.catchTag(
              "Pty.NotFoundError",
              () =>
                new PtyNotFoundError({
                  ptyID: ctx.params.ptyID,
                  message: `PTY session not found: ${ctx.params.ptyID}`,
                }),
            ),
          )
          const issued = yield* pty
            .acquireTicket({
              terminalID: ctx.params.ptyID,
              origin: origin!,
              protocol: "horizon.terminal.v1",
            })
            .pipe(
              Effect.provideService(TrustedPrincipalContext, principalContext.value),
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
              Effect.catchTags({
                "Pty.InvalidInputError": () => new ForbiddenError({ message: "Invalid PTY connect token request" }),
                "Pty.UnavailableError": () => new ForbiddenError({ message: "PTY connect ticket is unavailable" }),
                SessionSupervisorError: () => new ForbiddenError({ message: "PTY connect ticket is unavailable" }),
              }),
            )
          return yield* response(
            Effect.succeed({
              ticket: issued.ticket,
              expires_in: Math.max(1, Math.ceil((issued.expiresAtUnixMs - Date.now()) / 1000)),
            }),
          )
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          const pty = yield* Pty.Service
          const exists = yield* pty.get(ctx.params.ptyID).pipe(
            Effect.as(true),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
          )
          if (!exists) return HttpServerResponse.empty({ status: 404 })
          const principalContext = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(principalContext)) return HttpServerResponse.empty({ status: 403 })

          const requestOrigin = ctx.request.headers.origin
          if (requestOrigin && !validOrigin(requestOrigin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })
          const url = new URL(ctx.request.url, "http://localhost")
          const ticketValues = url.searchParams.getAll(PTY_CONNECT_TICKET_QUERY)
          const requestedProtocols = ctx.request.headers["sec-websocket-protocol"]
            ?.split(",")
            .map((value) => value.trim())
          if (
            requestedProtocols &&
            (requestedProtocols.length !== 1 || requestedProtocols[0] !== "horizon.terminal.v1")
          )
            return HttpServerResponse.empty({ status: 400 })
          const protocol = requestedProtocols ? "horizon.terminal.v1" : "legacy"
          if (protocol === "horizon.terminal.v1" && !requestOrigin) return HttpServerResponse.empty({ status: 403 })
          const origin = requestOrigin ?? "http://localhost"
          if (ticketValues.length > 1 || ticketValues.some((ticket) => ticket.length === 0))
            return HttpServerResponse.empty({ status: 403 })

          let consumed: Pty.TicketConsumption | undefined
          if (protocol === "horizon.terminal.v1") {
            const ticket = ticketValues[0]
            if (ticket === undefined) return HttpServerResponse.empty({ status: 403 })
            consumed = yield* pty
              .consumeTicket({
                ticket,
                terminalID: ctx.params.ptyID,
                origin,
                protocol,
              })
              .pipe(
                Effect.provideService(TrustedPrincipalContext, principalContext.value),
                Effect.catchTags({
                  "Pty.NotFoundError": () => Effect.succeed(undefined),
                  "Pty.InvalidInputError": () => Effect.succeed(undefined),
                  "Pty.UnavailableError": () => Effect.succeed(undefined),
                  SessionSupervisorError: () => Effect.succeed(undefined),
                }),
              )
            if (!consumed) return HttpServerResponse.empty({ status: 403 })
          } else if (ticketValues.length !== 0) {
            return HttpServerResponse.empty({ status: 403 })
          }

          let attachment: Pty.Attachment | undefined
          const cleanup = Effect.gen(function* () {
            if (attachment) yield* Effect.sync(() => attachment?.detach())
            if (!consumed) return
            yield* pty
              .revokeTicket({
                terminalID: consumed.terminalID,
                ticketID: consumed.ticketID,
                attachmentID: consumed.attachmentID,
              })
              .pipe(Effect.provideService(TrustedPrincipalContext, principalContext.value), Effect.orDie)
          })
          const cursorNumber = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : undefined
          const cursor =
            cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
              ? cursorNumber
              : undefined

          const serve = Effect.gen(function* () {
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

            // One bounded queue drained by a single writer keeps replay, live output and the
            // close frame ordered while capping memory for a stalled client.
            const outbox = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
            let queuedBytes = 0
            let overflowed = false
            const frameBytes = (item: string | Uint8Array | ArrayBuffer) =>
              typeof item === "string" ? Buffer.byteLength(item, "utf8") : item.byteLength
            const enqueue = (item: string | Uint8Array | ArrayBuffer | Socket.CloseEvent) => {
              if (item instanceof Socket.CloseEvent) {
                Queue.offerUnsafe(outbox, item)
                return
              }
              if (overflowed) return
              const size = frameBytes(item)
              if (!withinTerminalBackpressureLimit(queuedBytes, size)) {
                overflowed = true
                Queue.offerUnsafe(outbox, new Socket.CloseEvent(1013, "terminal output backlog exceeded"))
                return
              }
              queuedBytes += size
              Queue.offerUnsafe(outbox, typeof item === "string" ? item : item instanceof Uint8Array ? item : new Uint8Array(item))
            }
            const legacyDecoder = new TextDecoder()
            let streamSequence = 0
            let streamCursor = 0
            const encodeLegacy = (chunk: Uint8Array) => {
              const text = legacyDecoder.decode(chunk, { stream: true })
              for (const part of PtyProtocol.chunks(text)) enqueue(part)
            }
            const encodeFramed = (event: { sequence: number; byteCursor: number; kind: string; payload: unknown }) => {
              streamSequence = event.sequence
              streamCursor = event.byteCursor
              if (event.kind === "output") {
                const payload = event.payload instanceof Uint8Array ? event.payload : new Uint8Array()
                enqueue(PtyProtocol.outputFrame({ sequence: event.sequence, cursor: event.byteCursor, payload }))
                return
              }
              if (event.kind === "gap") {
                enqueue(
                  PtyProtocol.gapFrame({
                    sequence: event.sequence,
                    cursor: event.byteCursor,
                    payload: new TextEncoder().encode(JSON.stringify(event.payload ?? {})),
                  }),
                )
                return
              }
              if (event.kind === "exit" || event.kind === "error") {
                enqueue(
                  PtyProtocol.exitFrame({
                    sequence: event.sequence,
                    cursor: event.byteCursor,
                    ended: true,
                    payload: new TextEncoder().encode(JSON.stringify(event.payload ?? {})),
                  }),
                )
              }
            }

            const attached = yield* pty
              .attach(ctx.params.ptyID, {
                cursor,
                origin,
                protocol,
                ...(consumed ? { attachmentID: consumed.attachmentID } : {}),
                onData: (chunk, meta) => {
                  if (protocol === "legacy") {
                    encodeLegacy(chunk)
                    return
                  }
                  encodeFramed({ sequence: meta.sequence, byteCursor: meta.byteCursor, kind: "output", payload: chunk })
                },
                onGap: (gap) => {
                  if (protocol !== "legacy") {
                    encodeFramed({
                      sequence: gap.lastSequenceExclusive,
                      byteCursor: gap.lastByteCursorExclusive,
                      kind: "gap",
                      payload: gap,
                    })
                    return
                  }
                  // The legacy text protocol cannot express a gap, so the client is told to
                  // reconnect from its own cursor instead of silently missing output.
                  enqueue(new Socket.CloseEvent(4000, "terminal output gap"))
                },
                onEnd: (event) => {
                  if (protocol !== "legacy") {
                    encodeFramed({
                      sequence: streamSequence + 1,
                      byteCursor: streamCursor,
                      kind: "exit",
                      payload: event.unknown ? { code: "UNKNOWN" } : { ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) },
                    })
                  }
                  enqueue(new Socket.CloseEvent(1000))
                },
              })
              .pipe(
                Effect.provideService(TrustedPrincipalContext, principalContext.value),
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
            attachment = attached
            if (!attached) return HttpServerResponse.empty()

            for (const event of attached.replay) {
              if (protocol === "legacy") {
                if (event.kind === "output" && event.payload instanceof Uint8Array) encodeLegacy(event.payload)
                continue
              }
              encodeFramed(event)
            }
            if (protocol === "legacy") enqueue(PtyProtocol.metaFrame(attached.cursor))
            // Activation flushes buffered live events and any recorded end; the single outbox
            // keeps replay, live output and the closing frame in order.
            attached.activate()

            const drain = Effect.gen(function* () {
              while (true) {
                const item = yield* Queue.take(outbox)
                if (typeof item !== "string" && !(item instanceof Socket.CloseEvent)) {
                  queuedBytes = Math.max(0, queuedBytes - item.byteLength)
                } else if (typeof item === "string") {
                  queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(item, "utf8"))
                }
                yield* write(item)
                if (item instanceof Socket.CloseEvent) return
              }
            })

            yield* Effect.race(
              drain,
              socket.runRaw((message) => {
                const decoded = PtyProtocol.decodeInput(message)
                if (decoded !== undefined) attached.write(decoded)
              }),
            ).pipe(
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.orDie,
            )
            return HttpServerResponse.empty()
          })
          return yield* serve.pipe(Effect.ensuring(cleanup))
        }),
      )
  }),
)
