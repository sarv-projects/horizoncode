export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}
export class MoveChangesUnavailableError extends Schema.TaggedErrorClass<MoveChangesUnavailableError>()(
  "MoveSession.MoveChangesUnavailableError",
  { message: Schema.String },
) {}

export type Error = SessionV2.NotFoundError | DestinationProjectMismatchError | MoveChangesUnavailableError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const sessions = yield* SessionStore.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const directory = AbsolutePath.make(input.destination.directory)
      if (current.location.directory === directory) return
      if (input.moveChanges)
        return yield* new MoveChangesUnavailableError({
          message: "Moving changes is unavailable until files.patch is mediated by Rust Guard and ExecutionHost.",
        })

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      if (current.projectID !== destination.id) {
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }

      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({ directory }),
        subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
        timestamp: yield* DateTime.now,
      })
    })

    return Service.of({ moveSession })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, ProjectV2.node, SessionStore.node],
})
