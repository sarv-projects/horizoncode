import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { Cause, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { legacyHostRootCompatible, ownerMatchesPrincipal } from "@/question/owner"
import { EventApi } from "../groups/event"
import { boundedJsonSnapshot } from "../event-payload-bounds"

const QUESTION_EVENT_TYPES = new Set([
  // The active OpenCode-derived question tool still emits the V1 names. Keep
  // those events inside the same authenticated Session-owner projection as
  // the Core QuestionV2 event family below.
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
])
const MAX_QUESTION_OWNER_DEPTH = 32
// A slow SSE consumer must not retain an unbounded number of owner events.
// Closing on overflow makes the TUI reconnect and rebuild session projections
// from canonical message state rather than silently accepting a partial stream.
const MAX_EVENT_QUEUE_ITEMS = 256
const MAX_EVENT_BYTES = 64 * 1024
const MAX_EVENT_QUEUE_NODES = 65_536
// An item count alone allows every subscriber to retain 16 MiB of serialized
// payload. Keep a tighter aggregate budget as well; overflow closes the stream
// so clients rebuild their projections from canonical owners.
const MAX_EVENT_QUEUE_BYTES = 2 * 1024 * 1024

type EventWire = { id: string; type: string; properties: unknown }
type QueuedEvent = { wire: EventWire; serialized: string; bytes: number; nodes: number }

function questionSessionID(event: EventV2.Payload): string | undefined {
  if (!QUESTION_EVENT_TYPES.has(event.type)) return undefined
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return ""
  const sessionID = (event.data as Record<string, unknown>).sessionID
  return typeof sessionID === "string" && sessionID.length > 0 && sessionID.length <= 256 ? sessionID : ""
}

function mayObserveQuestionEvent(
  event: EventV2.Payload,
  principal: TrustedPrincipal | undefined,
  sessions: Session.Interface,
  instanceDirectory: string,
  workspaceID: string | undefined,
) {
  const sessionID = questionSessionID(event)
  if (sessionID === undefined) return Effect.succeed(true)
  if (!sessionID || !principal) return Effect.succeed(false)

  return Effect.gen(function* () {
    let current: Session.Info
    try {
      current = yield* sessions.get(SessionID.make(sessionID))
    } catch {
      return false
    }
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_QUESTION_OWNER_DEPTH; depth++) {
      if (seen.has(current.id)) return false
      if (current.directory !== instanceDirectory) return false
      if (current.workspaceID !== undefined && current.workspaceID !== workspaceID) return false
      seen.add(current.id)
      const owner = current.metadata?.horizonPrincipalOwner
      if (owner !== undefined) return ownerMatchesPrincipal(principal, owner)
      if (!current.parentID) {
        return legacyHostRootCompatible(principal, {
          parentID: current.parentID,
          directory: current.directory,
          instanceDirectory,
          ownerMetadata: owner,
        })
      }
      try {
        current = yield* sessions.get(current.parentID)
      } catch {
        return false
      }
    }
    return false
  }).pipe(Effect.catchCause(() => Effect.succeed(false)))
}

function eventData(serialized: string): Sse.Event {
  // V1 SSE is live-only. The JSON payload carries an event identity, but there
  // is intentionally no SSE `id`/Last-Event-ID cursor: Session part streams use
  // their own sequence+generation, and reconnect recovery re-reads canonical
  // state from its owner instead of replaying this process-local fanout.
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: serialized,
  }
}

function snapshotOutbound(wire: EventWire): QueuedEvent | undefined {
  const snapshot = boundedJsonSnapshot(wire, MAX_EVENT_BYTES)
  if (!snapshot || typeof snapshot.value !== "object" || snapshot.value === null) return undefined
  return {
    wire: snapshot.value as EventWire,
    serialized: snapshot.json,
    bytes: snapshot.bytes,
    nodes: snapshot.nodes,
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface, sessions: Session.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const trusted = yield* Effect.serviceOption(TrustedPrincipalContext)
    const principal = trusted._tag === "Some" ? trusted.value.principal : undefined
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.bounded<QueuedEvent, Error>(MAX_EVENT_QUEUE_ITEMS)
    let overflowed = false
    let queuedBytes = 0
    let queuedNodes = 0
    const offer = (event: EventV2.Payload) => {
      if (overflowed) return false
      // Clone, preflight, and serialize synchronously before admission. Neither
      // the queue nor the later owner filter retains mutable bus-event objects.
      const queued = snapshotOutbound({ id: event.id, type: event.type, properties: event.data })
      if (!queued || queuedBytes + queued.bytes > MAX_EVENT_QUEUE_BYTES ||
          queuedNodes + queued.nodes > MAX_EVENT_QUEUE_NODES || !Queue.offerUnsafe(queue, queued)) {
        overflowed = true
        Queue.failCauseUnsafe(queue, Cause.fail(new Error("event stream backlog exceeded; reconnect to resnapshot")))
        return false
      }
      queuedBytes += queued.bytes
      queuedNodes += queued.nodes
      return true
    }
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
      // The bus is shared across locations; only this instance's events may
      // consume its bounded client backlog.
      if (event.location?.directory !== instance.directory ||
          (event.location.workspaceID !== undefined && event.location.workspaceID !== workspaceID)) return
      offer(event)
    }))
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      Stream.map((queued) => {
        queuedBytes = Math.max(0, queuedBytes - queued.bytes)
        queuedNodes = Math.max(0, queuedNodes - queued.nodes)
        return queued
      }),
      Stream.filterEffect((queued) => mayObserveQuestionEvent(
        { type: queued.wire.type, data: queued.wire.properties } as EventV2.Payload,
        principal,
        sessions,
        instance.directory,
        workspaceID,
      )),
      Stream.map((queued) => ({ ...queued.wire, serialized: queued.serialized })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown; serialized: string }, Error>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        const queued = snapshotOutbound({
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
        if (queued) Queue.offerUnsafe(queue, { ...queued.wire, serialized: queued.serialized })
        else Queue.failCauseUnsafe(queue, Cause.fail(new Error("disposed event exceeded the bounded event stream payload")))
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => snapshotOutbound({ id: eventID(), type: "server.heartbeat", properties: {} })!),
      Stream.map((queued) => ({ ...queued.wire, serialized: queued.serialized })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make(snapshotOutbound({ id: eventID(), type: "server.connected", properties: {} })!).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map((event) => eventData(event.serialized)),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events, sessions)
      }),
    )
  }),
)
