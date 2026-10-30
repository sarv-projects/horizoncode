import { describe, expect, test } from "bun:test"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Database } from "@horizoncode/core/database/database"
import { EventTable } from "@horizoncode/core/event/sql"
import { PermissionSaved } from "@horizoncode/core/permission/saved"
import { Project } from "@horizoncode/core/project"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionV2 } from "@horizoncode/core/session"
import { SessionMessage } from "@horizoncode/core/session/message"
import { SessionMessageTable, SessionTable } from "@horizoncode/core/session/sql"
import { createEmbeddedRoutes, createRoutes } from "../src/routes"

/**
 * Integrated HTTP boundary for the fail-closed `SessionV2.revert` seam.
 *
 * `packages/server/src/middleware/authorization.ts` projects
 * `TrustedPrincipalContext` only on authenticated (or trusted-loopback) branches.
 * On the unauthenticated non-loopback branch it intentionally projects **nothing**
 * — fabricating `host_os`/`server_auth` there would be a Guard bypass. This suite
 * proves that the real middleware + real handlers + real Core seam deny those
 * requests with the typed reason and perform no mutation, while a request that
 * carries genuine `server_auth` credentials keeps its existing behavior.
 *
 * Each test runs one scoped route stack over its own `:memory:` database
 * (`OPENCODE_DB=:memory:`), seeded through the same `Layer.MemoMap` the route
 * layer consumes, so seeding and routing observe one database instance.
 */

const sessionID = SessionV2.ID.make("ses_revert_http")
const messageID = SessionMessage.ID.make("msg_revert_boundary")
/** Seeded *after* the boundary so a committed revert would delete it. */
const laterMessageID = SessionMessage.ID.make("msg_revert_after_boundary")
const STAGE_MESSAGE =
  "Session supervisor authorization failed: Authenticated principal required to stage a Session revert"
const CLEAR_MESSAGE =
  "Session supervisor authorization failed: Authenticated principal required to clear a Session revert"
const COMMIT_MESSAGE =
  "Session supervisor authorization failed: Authenticated principal required to commit a Session revert"

type Routes = ReturnType<typeof createRoutes>

const bootstrap = (makeRoutes: () => Routes) =>
  Effect.gen(function* () {
    const memoMap = yield* Layer.makeMemoMap
    const scope = yield* Effect.scope
    const permissions = yield* Layer.buildWithMemoMap(AppNodeBuilder.build(PermissionSaved.node), memoMap, scope)
    const saved = Context.get(permissions, PermissionSaved.Service)
    const databaseContext = yield* Layer.buildWithMemoMap(AppNodeBuilder.build(Database.node), memoMap, scope)
    const database = Context.get(databaseContext, Database.Service)
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes().pipe(
            HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, saved)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true, memoMap },
        ),
      ),
      (handler) => Effect.promise(handler.dispose),
    )
    return { web, database }
  })

const seed = (database: Database.Interface, directory: string) =>
  Effect.gen(function* () {
    const { db } = database
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
        slug: "revert-http",
        directory,
        title: "revert-http",
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
    // A message strictly after the revert boundary: `revert.committed`'s
    // projector deletes it, so its survival proves commit was denied before
    // any mutation.
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: laterMessageID,
        session_id: sessionID,
        type: "user",
        seq: 2,
        time_created: 0,
        data: Schema.encodeSync(SessionMessage.Message)(
          SessionMessage.User.make({
            id: laterMessageID,
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

const stageRequest = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/session/${sessionID}/revert/stage`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messageID }),
  })

const clearRequest = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/session/${sessionID}/revert/clear`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  })

const commitRequest = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/session/${sessionID}/revert/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  })

const basic = (credentials: string) => ({
  authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
})

/** Whether the post-boundary message survived — `revert.committed` deletes it. */
const messageExists = (database: Database.Interface, id: SessionMessage.ID) =>
  database.db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

/**
 * The three `session.revert.*` operations are one API family: they must deny
 * identically for the same "no trusted principal" condition (403) and for the
 * same bad-credential condition (401).
 */
const revertOps: ReadonlyArray<{
  readonly name: "stage" | "clear" | "commit"
  readonly request: (headers?: Record<string, string>) => Request
  readonly reason: string
}> = [
  { name: "stage", request: stageRequest, reason: STAGE_MESSAGE },
  { name: "clear", request: clearRequest, reason: CLEAR_MESSAGE },
  { name: "commit", request: commitRequest, reason: COMMIT_MESSAGE },
]

const revertEventTypes = (database: Database.Interface) =>
  database.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.type).filter((type) => type.includes(".revert.")).sort()),
    )

const persistedRevert = (database: Database.Interface) =>
  database.db
    .select({ revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.revert ?? null),
    )

const callAndObserve = (request: () => Request) =>
  Effect.gen(function* () {
    const { web, database } = yield* bootstrap(createEmbeddedRoutes)
    yield* seed(database, scratchDirectory)
    const response = yield* Effect.promise(() => web.handler(request()))
    return {
      status: response.status,
      body: yield* Effect.promise(() => response.text()),
      events: yield* revertEventTypes(database),
      revert: yield* persistedRevert(database),
    }
  })

let scratchDirectory = ""

const withScratch = async <A>(body: () => Promise<A>): Promise<A> => {
  scratchDirectory = mkdtempSync(path.join(process.env.TMPDIR ?? ".", "p1-revert-http-"))
  try {
    return await body()
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true })
  }
}

describe("revert HTTP authorization boundary", () => {
  test(
    "stage without a trusted principal is denied 403 and stages nothing",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(Effect.scoped(callAndObserve(() => stageRequest())))
        expect(result.status).toBe(403)
        expect(JSON.parse(result.body)).toMatchObject({
          _tag: "ForbiddenError",
          message: STAGE_MESSAGE,
        })
        expect(result.events).toEqual([])
        expect(result.revert).toBeNull()
      }),
    400_000,
  )

  test(
    "clear without a trusted principal is denied 403 and leaves the staged revert untouched",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { web, database } = yield* bootstrap(createEmbeddedRoutes)
              yield* seed(database, scratchDirectory)
              yield* database.db
                .update(SessionTable)
                .set({ revert: { messageID, files: [] } })
                .where(eq(SessionTable.id, sessionID))
                .run()
                .pipe(Effect.orDie)
              const response = yield* Effect.promise(() => web.handler(clearRequest()))
              return {
                status: response.status,
                body: yield* Effect.promise(() => response.text()),
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
              }
            }),
          ),
        )
        expect(result.status).toBe(403)
        expect(JSON.parse(result.body)).toMatchObject({
          _tag: "ForbiddenError",
          message: CLEAR_MESSAGE,
        })
        expect(result.events).toEqual([])
        expect(result.revert).toMatchObject({ messageID })
      }),
    400_000,
  )

  test(
    "authenticated server_auth requests keep the existing stage and clear behavior",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const memoMap = yield* Layer.makeMemoMap
              const scope = yield* Effect.scope
              const permissions = yield* Layer.buildWithMemoMap(
                AppNodeBuilder.build(PermissionSaved.node),
                memoMap,
                scope,
              )
              const saved = Context.get(permissions, PermissionSaved.Service)
              const databaseContext = yield* Layer.buildWithMemoMap(
                AppNodeBuilder.build(Database.node),
                memoMap,
                scope,
              )
              const database = Context.get(databaseContext, Database.Service)
              const web = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  HttpRouter.toWebHandler(
                    createRoutes("secret").pipe(
                      HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, saved)),
                      Layer.provide(HttpServer.layerServices),
                    ),
                    { disableLogger: true, memoMap },
                  ),
                ),
                (handler) => Effect.promise(handler.dispose),
              )
              yield* seed(database, scratchDirectory)

              const anonymous = yield* Effect.promise(() => web.handler(stageRequest()))
              const wrongCredential = yield* Effect.promise(() =>
                web.handler(stageRequest(basic("opencode:wrong"))),
              )
              const authenticated = yield* Effect.promise(() =>
                web.handler(stageRequest(basic("opencode:secret"))),
              )
              const stagedBody = yield* Effect.promise(() => authenticated.text())
              const cleared = yield* Effect.promise(() => web.handler(clearRequest(basic("opencode:secret"))))

              return {
                anonymous: anonymous.status,
                wrongCredential: wrongCredential.status,
                staged: authenticated.status,
                stagedBody,
                cleared: cleared.status,
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
              }
            }),
          ),
        )
        expect(result.anonymous).toBe(401)
        expect(result.wrongCredential).toBe(401)
        expect(result.staged).toBe(200)
        expect(JSON.parse(result.stagedBody).data).toMatchObject({ messageID })
        expect(result.cleared).toBe(204)
        expect(result.events).toEqual(
          ["session.next.revert.cleared.1", "session.next.revert.staged.1"].sort(),
        )
        expect(result.revert).toBeNull()
      }),
    400_000,
  )

  test(
    "commit without a trusted principal is denied 403 and commits nothing",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { web, database } = yield* bootstrap(createEmbeddedRoutes)
              yield* seed(database, scratchDirectory)
              // Stage straight in the store: with no principal the gated
              // `stage` seam is closed too, so a successful `commit` would be
              // the only way to add a `revert.*` event here.
              yield* database.db
                .update(SessionTable)
                .set({ revert: { messageID, files: [] } })
                .where(eq(SessionTable.id, sessionID))
                .run()
                .pipe(Effect.orDie)
              const response = yield* Effect.promise(() => web.handler(commitRequest()))
              return {
                status: response.status,
                body: yield* Effect.promise(() => response.text()),
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
                laterPresent: yield* messageExists(database, laterMessageID),
              }
            }),
          ),
        )
        // 403 (not the 401 of a bad-credential rejection): the family denies
        // identically once the request reaches the ungated-but-unauthenticated
        // pass-through branch.
        expect(result.status).toBe(403)
        expect(JSON.parse(result.body)).toMatchObject({
          _tag: "ForbiddenError",
          message: COMMIT_MESSAGE,
        })
        // Zero revert events, the staged revert untouched and the post-boundary
        // message still present — `revert.committed` never ran.
        expect(result.events).toEqual([])
        expect(result.revert).toMatchObject({ messageID })
        expect(result.laterPresent).toBe(true)
      }),
    400_000,
  )

  test(
    "authenticated server_auth commit succeeds with exactly the committed event",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { web, database } = yield* bootstrap(() => createRoutes("secret"))
              yield* seed(database, scratchDirectory)

              const anonymous = yield* Effect.promise(() => web.handler(commitRequest()))
              const wrongCredential = yield* Effect.promise(() =>
                web.handler(commitRequest(basic("opencode:wrong"))),
              )
              const staged = yield* Effect.promise(() => web.handler(stageRequest(basic("opencode:secret"))))
              const committed = yield* Effect.promise(() =>
                web.handler(commitRequest(basic("opencode:secret"))),
              )

              return {
                anonymous: anonymous.status,
                wrongCredential: wrongCredential.status,
                staged: staged.status,
                committed: committed.status,
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
                laterPresent: yield* messageExists(database, laterMessageID),
              }
            }),
          ),
        )
        expect(result.anonymous).toBe(401)
        expect(result.wrongCredential).toBe(401)
        expect(result.staged).toBe(200)
        expect(result.committed).toBe(204)
        expect(result.events).toEqual(
          ["session.next.revert.committed.1", "session.next.revert.staged.1"].sort(),
        )
        expect(result.revert).toBeNull()
        // The commit's own projector really ran: the post-boundary message is gone.
        expect(result.laterPresent).toBe(false)
      }),
    400_000,
  )

  test(
    "stage, clear and commit all deny with 403 when no trusted principal is present",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { web, database } = yield* bootstrap(createEmbeddedRoutes)
              yield* seed(database, scratchDirectory)
              // Stage straight in the store so "unchanged state" is meaningful
              // for every operation: direct SQL writes no `revert.*` event, so
              // any event below is one the request itself produced.
              yield* database.db
                .update(SessionTable)
                .set({ revert: { messageID, files: [] } })
                .where(eq(SessionTable.id, sessionID))
                .run()
                .pipe(Effect.orDie)

              const observed: Array<{
                readonly name: string
                readonly reason: string
                readonly status: number
                readonly body: string
              }> = []
              for (const op of revertOps) {
                const response = yield* Effect.promise(() => web.handler(op.request()))
                observed.push({
                  name: op.name,
                  reason: op.reason,
                  status: response.status,
                  body: yield* Effect.promise(() => response.text()),
                })
              }

              return {
                observed,
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
                laterPresent: yield* messageExists(database, laterMessageID),
              }
            }),
          ),
        )

        for (const row of result.observed) {
          expect({ op: row.name, status: row.status }).toEqual({ op: row.name, status: 403 })
          expect({ op: row.name, error: JSON.parse(row.body) }).toEqual({
            op: row.name,
            error: { _tag: "ForbiddenError", message: row.reason },
          })
        }
        // Same pre-staged revert, zero revert events, post-boundary message
        // intact: none of the three mutated anything.
        expect(result.events).toEqual([])
        expect(result.revert).toMatchObject({ messageID })
        expect(result.laterPresent).toBe(true)
      }),
    400_000,
  )

  test(
    "stage, clear and commit all answer 401 for anonymous or wrong Basic credentials",
    async () =>
      await withScratch(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { web, database } = yield* bootstrap(() => createRoutes("secret"))
              yield* seed(database, scratchDirectory)
              yield* database.db
                .update(SessionTable)
                .set({ revert: { messageID, files: [] } })
                .where(eq(SessionTable.id, sessionID))
                .run()
                .pipe(Effect.orDie)

              const credentials: ReadonlyArray<{
                readonly name: string
                readonly headers: Record<string, string>
              }> = [
                { name: "anonymous", headers: {} },
                { name: "wrong-basic", headers: basic("opencode:wrong") },
              ]

              const observed: Array<{ readonly op: string; readonly credential: string; readonly status: number }> =
                []
              for (const op of revertOps) {
                for (const credential of credentials) {
                  const response = yield* Effect.promise(() => web.handler(op.request(credential.headers)))
                  observed.push({ op: op.name, credential: credential.name, status: response.status })
                }
              }

              return {
                observed,
                events: yield* revertEventTypes(database),
                revert: yield* persistedRevert(database),
                laterPresent: yield* messageExists(database, laterMessageID),
              }
            }),
          ),
        )

        for (const row of result.observed) {
          expect(row).toEqual({ op: row.op, credential: row.credential, status: 401 })
        }
        expect(result.events).toEqual([])
        expect(result.revert).toMatchObject({ messageID })
        expect(result.laterPresent).toBe(true)
      }),
    400_000,
  )
})
