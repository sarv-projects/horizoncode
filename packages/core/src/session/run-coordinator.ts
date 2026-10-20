export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

type AuthorityArgs<Authority> = [Authority] extends [void] ? [] : [authority: Authority]

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Authority = void> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key, ...authority: AuthorityArgs<Authority>) => Effect.Effect<boolean, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key, ...authority: AuthorityArgs<Authority>) => Effect.Effect<boolean>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E, Authority> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
  authority: Authority
  pendingAuthority?: Authority
}

export const make = <Key, E, Authority = void>(options: {
  readonly drain: (key: Key, force: boolean, authority: Authority) => Effect.Effect<void, E>
  /** Prevents a different authenticated owner from taking over a live Session drain. */
  readonly sameAuthority?: (current: Authority, requested: Authority) => boolean
}): Effect.Effect<Coordinator<Key, E, Authority>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E, Authority>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (authority: Authority): Entry<E, Authority> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
      authority,
    })

    const start = (key: Key, entry: Entry<E, Authority>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force, entry.authority))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E, Authority>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        if (entry.pendingAuthority !== undefined) entry.authority = entry.pendingAuthority
        entry.pendingAuthority = undefined
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry(entry.pendingAuthority ?? entry.authority) : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key, ...args: AuthorityArgs<Authority>): Effect.Effect<boolean, E> =>
      Effect.uninterruptibleMask((restore) => {
        const authority = args[0] as Authority
        const entry = active.get(key)
        if (entry !== undefined) {
          if (options.sameAuthority && !options.sameAuthority(entry.authority, authority))
            return restore(Effect.succeed(false))
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key, ...args))))
          return restore(Deferred.await(entry.done).pipe(Effect.as(true)))
        }

        const next = makeEntry(authority)
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done).pipe(Effect.as(true)))
      })

    const wake = (key: Key, ...args: AuthorityArgs<Authority>) =>
      Effect.sync(() => {
        const authority = args[0] as Authority
        const entry = active.get(key)
        if (entry !== undefined) {
          if (options.sameAuthority && !options.sameAuthority(entry.authority, authority)) return false
          entry.pendingWake = true
          entry.pendingAuthority = authority
          return true
        }

        const next = makeEntry(authority)
        active.set(key, next)
        start(key, next, false)
        return true
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })
