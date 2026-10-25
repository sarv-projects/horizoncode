import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import type * as Scope from "effect/Scope"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { tmpdir } from "./fixture/tmpdir"

/**
 * `SessionV2.revert.stage`/`clear`/`commit` are the Core seam where the server's
 * authorization middleware projects `TrustedPrincipalContext`. On the
 * unauthenticated non-loopback branches the service is genuinely absent, so the
 * seam must fail closed with a typed denial instead of demanding a
 * type-level `R` that pushes callers to fabricate authority.
 *
 * `commit` is the highest-consequence member: `SessionRevert.commit` publishes
 * `session.next.revert.committed`, whose projector deletes every message after
 * the boundary, deletes the session's inputs and nulls `SessionTable.revert`.
 *
 * Every case boots the location/snapshot services, which exceeds Bun's 5 s
 * default on a loaded host, so each case carries an explicit 60 s timeout.
 */

const appLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [[SessionExecution.node, SessionExecution.noopLayer]],
)

type AppServices = Database.Service | EventV2.Service | SessionV2.Service | Scope.Scope

/**
 * Runs one program under an exact principal — or with **no**
 * `TrustedPrincipalContext` at all when `principal` is `undefined`, mirroring
 * the unauthenticated non-loopback branches of
 * `packages/server/src/middleware/authorization.ts` where supplying `host_os`
 * (or any principal) would be a Guard bypass.
 */
const run = <A, E>(
  principal: TrustedPrincipal | undefined,
  program: Effect.Effect<A, E, AppServices>,
): Promise<Exit.Exit<A, E | SessionSupervisorError>> => {
  const authorized =
    principal === undefined ? program : Effect.provideService(program, TrustedPrincipalContext, { principal })
  return Effect.runPromise(authorized.pipe(Effect.scoped, Effect.provide(appLayer), Effect.exit))
}

const sessionID = SessionV2.ID.make("ses_revert_principal")
const messageID = SessionMessage.ID.make("msg_revert_boundary")
/** Seeded *after* the boundary so a committed revert would delete it. */
const laterMessageID = SessionMessage.ID.make("msg_revert_after_boundary")
const STAGE_REASON = "Authenticated principal required to stage a Session revert"
const CLEAR_REASON = "Authenticated principal required to clear a Session revert"
const COMMIT_REASON = "Authenticated principal required to commit a Session revert"

const seed = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory,
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        type: "user",
        seq: 1,
        time_created: 0,
        data: Schema.encodeSync(SessionMessage.Message)(
          SessionMessage.User.make({
            id: messageID,
            type: "user",
            text: "boundary",
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/**
 * A message strictly after the revert boundary. `SessionRevert.commit`'s
 * projector deletes it (`seq > boundary.seq`), so its survival proves the
 * commit was denied *before* any mutation.
 */
const seedLaterMessage = (id: SessionMessage.ID = laterMessageID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values({
        id,
        session_id: sessionID,
        type: "user",
        seq: 2,
        time_created: 0,
        data: Schema.encodeSync(SessionMessage.Message)(
          SessionMessage.User.make({
            id,
            type: "user",
            text: "after the boundary",
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const messageExists = (id: SessionMessage.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row !== undefined),
      ),
  )

/** Stages a revert directly in the store — no principal, no `revert.staged` event. */
const stageRevertDirectly = () =>
  Database.Service.use(({ db }) =>
    db
      .update(SessionTable)
      .set({ revert: { messageID, files: [] } })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie),
  )

/** Sorted durable revert event types recorded for the Session. */
const revertEvents = (id: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) =>
          rows
            .map((row) => row.type)
            .filter((type) => type.includes(".revert."))
            .sort(),
        ),
      ),
  )

const persistedRevert = (id: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ revert: SessionTable.revert })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.revert ?? null),
      ),
  )

const expectDenied = (
  outcome: Exit.Exit<{ failure: unknown; events: readonly string[]; revert: unknown }, unknown>,
  reason: string,
) => {
  if (!Exit.isSuccess(outcome)) throw new Error(`expected a typed denial, got ${Cause.pretty(outcome.cause)}`)
  const { failure, events, revert } = outcome.value
  expect(failure).toMatchObject({
    _tag: "SessionSupervisorError",
    stage: "authorization",
    reason,
  })
  return { events, revert }
}

describe("SessionV2.revert trusted principal boundary", () => {
  test("stage without a trusted principal is denied with the typed reason and mutates nothing", async () => {
    const tmp = await tmpdir()
    try {
      const outcome = await run(
        undefined,
        Effect.gen(function* () {
          yield* seed(tmp.path)
          const session = yield* SessionV2.Service
          const failure = yield* session.revert.stage({ sessionID, messageID }).pipe(Effect.flip)
          return { failure, events: yield* revertEvents(sessionID), revert: yield* persistedRevert(sessionID) }
        }),
      )

      const { events, revert } = expectDenied(outcome, STAGE_REASON)
      expect(events).toEqual([])
      expect(revert).toBeNull()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("clear without a trusted principal is denied with the typed reason and mutates nothing", async () => {
    const tmp = await tmpdir()
    try {
      const outcome = await run(
        undefined,
        Effect.gen(function* () {
          yield* seed(tmp.path)
          const events = yield* EventV2.Service
          yield* events.publish(SessionEvent.RevertEvent.Staged, {
            sessionID,
            timestamp: DateTime.makeUnsafe(1),
            revert: { messageID, files: [] },
          })
          const session = yield* SessionV2.Service
          const failure = yield* session.revert.clear(sessionID).pipe(Effect.flip)
          return { failure, events: yield* revertEvents(sessionID), revert: yield* persistedRevert(sessionID) }
        }),
      )

      const { events, revert } = expectDenied(outcome, CLEAR_REASON)
      // The pre-existing staged revert survives and no `cleared` event was written.
      expect(events).toEqual(["session.next.revert.staged.1"])
      expect(revert).toMatchObject({ messageID })
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("commit without a trusted principal is denied with the typed reason and mutates nothing", async () => {
    const tmp = await tmpdir()
    try {
      const outcome = await run(
        undefined,
        Effect.gen(function* () {
          yield* seed(tmp.path)
          yield* seedLaterMessage()
          // Stage straight in the store: with no principal the gated `stage`
          // seam is closed too, so a successful `commit` would be the only way
          // to add a `revert.*` event here.
          yield* stageRevertDirectly()
          const session = yield* SessionV2.Service
          // `Effect.flip` is deliberately not used here: `commit` succeeds with
          // `void`, so a flip would turn the pre-fix success into an opaque
          // `Unknown error: undefined` failure that aborts the program before
          // the durable state below can be read. Capturing the typed failure
          // keeps both outcomes observable while defects still propagate.
          const failure: unknown = yield* session.revert.commit(sessionID).pipe(
            Effect.map(() => undefined),
            Effect.catch((error) => Effect.succeed(error)),
          )
          return {
            failure,
            events: yield* revertEvents(sessionID),
            revert: yield* persistedRevert(sessionID),
            laterPresent: yield* messageExists(laterMessageID),
          }
        }),
      )

      if (!Exit.isSuccess(outcome)) throw new Error(`expected a typed denial, got ${Cause.pretty(outcome.cause)}`)
      // Durable state is asserted *first* so a pre-fix (RED) run prints the
      // actual mutation — the `revert.committed` event, the nulled revert and
      // the deleted post-boundary message — rather than stopping at the
      // missing typed denial below.
      expect(outcome.value.events).toEqual([])
      expect(outcome.value.revert).toMatchObject({ messageID })
      expect(outcome.value.laterPresent).toBe(true)
      expectDenied(outcome, COMMIT_REASON)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("stage and clear keep their existing behavior under a genuine server_auth principal", async () => {
    const tmp = await tmpdir()
    try {
      const outcome = await run(
        { kind: "server_auth", subject: "core-test-user" },
        Effect.gen(function* () {
          yield* seed(tmp.path)
          const session = yield* SessionV2.Service
          const staged = yield* session.revert.stage({ sessionID, messageID })
          const afterStage = {
            events: yield* revertEvents(sessionID),
            revert: yield* persistedRevert(sessionID),
          }
          yield* session.revert.clear(sessionID)
          const afterClear = {
            events: yield* revertEvents(sessionID),
            revert: yield* persistedRevert(sessionID),
          }
          return { staged, afterStage, afterClear }
        }),
      )

      if (!Exit.isSuccess(outcome)) throw new Error(`expected success, got ${Cause.pretty(outcome.cause)}`)
      const { staged, afterStage, afterClear } = outcome.value
      expect(staged).toMatchObject({ messageID, restoreFiles: [] })
      expect(afterStage.events).toEqual(["session.next.revert.staged.1"])
      expect(afterStage.revert).toMatchObject({ messageID })
      expect(afterClear.events).toEqual(
        ["session.next.revert.cleared.1", "session.next.revert.staged.1"].sort(),
      )
      expect(afterClear.revert).toBeNull()
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("commit keeps its existing behavior under a genuine server_auth principal", async () => {
    const tmp = await tmpdir()
    try {
      const outcome = await run(
        { kind: "server_auth", subject: "core-test-user" },
        Effect.gen(function* () {
          yield* seed(tmp.path)
          yield* seedLaterMessage()
          const session = yield* SessionV2.Service
          yield* session.revert.stage({ sessionID, messageID })
          yield* session.revert.commit(sessionID)
          return {
            events: yield* revertEvents(sessionID),
            revert: yield* persistedRevert(sessionID),
            laterPresent: yield* messageExists(laterMessageID),
          }
        }),
      )

      if (!Exit.isSuccess(outcome)) throw new Error(`expected success, got ${Cause.pretty(outcome.cause)}`)
      const { events, revert, laterPresent } = outcome.value
      // Exactly the staged event plus the one committed event — nothing else.
      expect(events).toEqual(["session.next.revert.committed.1", "session.next.revert.staged.1"].sort())
      expect(revert).toBeNull()
      // The commit's own projector effect really ran: the post-boundary
      // message is gone.
      expect(laterPresent).toBe(false)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)
})
