import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { legacyHostRootCompatible, ownerMatchesPrincipal } from "@opencode-ai/core/session/owner"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { eq } from "drizzle-orm"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256
const questionEventTypes = new Set([
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
])
const maxQuestionOwnerDepth = 32

function mayObserveQuestionEvent(
  event: EventV2.Payload,
  principal: TrustedPrincipal | undefined,
  db: Database.Interface["db"],
) {
  if (!questionEventTypes.has(event.type)) return Effect.succeed(true)
  if (!principal || typeof event.data !== "object" || event.data === null || Array.isArray(event.data))
    return Effect.succeed(false)
  const sessionID = (event.data as Record<string, unknown>).sessionID
  const location = event.location
  if (typeof sessionID !== "string" || sessionID.length === 0 || sessionID.length > 256 || !location)
    return Effect.succeed(false)

  return Effect.gen(function* () {
    const read = (id: string) => db
      .select({
        id: SessionTable.id,
        parentID: SessionTable.parent_id,
        directory: SessionTable.directory,
        workspaceID: SessionTable.workspace_id,
        metadata: SessionTable.metadata,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
      .get()
      .pipe(Effect.orDie)

    let current = yield* read(sessionID)
    if (!current) return false
    const seen = new Set<string>()
    let matchedOwner = false
    for (let depth = 0; depth < maxQuestionOwnerDepth; depth++) {
      if (seen.has(current.id)) return false
      if (current.directory !== location.directory || (current.workspaceID ?? undefined) !== location.workspaceID)
        return false
      seen.add(current.id)
      const owner = current.metadata?.horizonPrincipalOwner
      if (owner !== undefined) {
        if (!ownerMatchesPrincipal(principal, owner)) return false
        matchedOwner = true
      }
      if (!current.parentID) {
        if (matchedOwner) return true
        return legacyHostRootCompatible(principal, {
          directory: current.directory,
          instanceDirectory: location.directory,
          ownerMetadata: owner,
        })
      }
      current = yield* read(current.parentID)
      if (!current) return false
    }
    return false
  }).pipe(Effect.catchCause(() => Effect.succeed(false)))
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const trusted = yield* Effect.serviceOption(TrustedPrincipalContext)
        const principal = trusted._tag === "Some" ? trusted.value.principal : undefined
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            const visible = live.pipe(Stream.filterEffect((event) => mayObserveQuestionEvent(event, principal, db)))
            return Stream.make(connected).pipe(Stream.concat(visible))
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
