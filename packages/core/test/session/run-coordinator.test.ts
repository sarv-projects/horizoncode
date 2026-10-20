import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { sameTrustedPrincipal, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"

test("an active Session coordinator rejects another principal from joining or queueing a run", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finishFirst = yield* Deferred.make<void>()
        const successorStarted = yield* Deferred.make<void>()
        const finishSuccessor = yield* Deferred.make<void>()
        const drained: TrustedPrincipal[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, TrustedPrincipal>({
          sameAuthority: sameTrustedPrincipal,
          drain: (_sessionID, _force, principal) =>
            Effect.sync(() => {
              drained.push(principal)
              return drained.length
            }).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finishFirst)))
                  : Deferred.succeed(successorStarted, undefined).pipe(Effect.andThen(Deferred.await(finishSuccessor))),
              ),
            ),
        })
        const alice = { kind: "server_auth", subject: "alice" } as const
        const bob = { kind: "server_auth", subject: "bob" } as const

        expect(yield* coordinator.wake("ses_owner_bound", alice)).toBe(true)
        yield* Deferred.await(started)
        expect(yield* coordinator.run("ses_owner_bound", bob)).toBe(false)
        expect(yield* coordinator.wake("ses_owner_bound", bob)).toBe(false)
        expect(yield* coordinator.wake("ses_owner_bound", alice)).toBe(true)
        yield* Deferred.succeed(finishFirst, undefined)
        yield* Deferred.await(successorStarted)
        expect(drained).toEqual([alice, alice])
        yield* Deferred.succeed(finishSuccessor, undefined)
      }),
    ),
  )
})
