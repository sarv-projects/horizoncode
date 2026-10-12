import { Cause, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { Database } from "../../database/database"
import { SessionSupervisor, SessionSupervisorError } from "../supervisor"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const supervisor = yield* SessionSupervisor.Service
    const database = yield* Database.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionExecution.Error>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* SessionSupervisor.acquireExecutionOwner(sessionID, "core-v2")
            const turnComplete = yield* Ref.make(false)
            const supervisorReady = yield* Deferred.make<void, SessionSupervisorError>()
            const watcher = yield* supervisor
              .watchSession(sessionID, database.path, session.location.directory, turnComplete, supervisorReady)
              .pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Deferred.await(supervisorReady)
            const result = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
              Effect.provide(locations.get(session.location)),
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
              ),
              Effect.onExit(() => Ref.set(turnComplete, true)),
            )
            yield* Fiber.join(watcher)
            return result
          }),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)
export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [Database.node, SessionStore.node, LocationServiceMap.node, SessionSupervisor.node],
})

export * as SessionExecutionLocal from "./local"
