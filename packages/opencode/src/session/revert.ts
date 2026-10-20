import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>
export class FileChangesUnavailableError extends Schema.TaggedErrorClass<FileChangesUnavailableError>()(
  "SessionRevert.FileChangesUnavailableError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<
    Session.Info,
    FileChangesUnavailableError
  >
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, FileChangesUnavailableError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const unavailable = () =>
      new FileChangesUnavailableError({
        message: "Legacy session file rewind is unavailable until checkpoint restore is Guard mediated.",
      })
    const revert = Effect.fn("SessionRevert.revert")(function* (_input: RevertInput) {
      return yield* unavailable()
    })
    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (_input: { sessionID: SessionID }) {
      return yield* unavailable()
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = index < 0 ? undefined : msgs[index]
      const remove = index < 0 ? [] : msgs.slice(index + (session.revert.partID ? 1 : 0))
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
  ],
})

export * as SessionRevert from "./revert"
