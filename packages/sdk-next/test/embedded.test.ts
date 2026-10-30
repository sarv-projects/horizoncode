import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@horizoncode/core/flag/flag"
import { Deferred, Effect, Latch, Option, Schema, Stream } from "effect"
import type { OpenCodeEvent } from "../src"

// The embedded Database node resolves `Flag.OPENCODE_DB` when the module graph is
// first built, so every test in this file shares the first scratch directory's
// database file. Removing a directory inside an individual test's `finally`
// therefore breaks every later test with `SQLITE_CANTOPEN`; cleanup is deferred to
// `afterAll` so the file stays reachable for the whole file run.
const scratchDirectories: string[] = []

test("embedded client uses the real router and handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      yield* opencode.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* opencode.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* opencode.sessions.switchModel({ sessionID, model })
      const selected = yield* opencode.sessions.get({ sessionID })
      const page = yield* opencode.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* opencode.sessions.active()
      // Input admission is deliberately allowed without a principal: with
      // `resume: false` the server records the user turn but never wakes
      // execution (Core `V2Session.prompt`).
      const admitted = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })

      // Fail-closed boundary (parent ruling 2026-10-25). `HttpRouter.toWebHandler`
      // builds its `HttpServerRequest` with `Request.fromWeb(...)`, which carries
      // no socket peer (`remoteAddress` is `Option.none()`), so
      // `ServerAuth.isTrustedLoopbackPeer` is false. `createEmbeddedRoutes` runs
      // auth-not-required with no configured password, so the request is
      // unauthenticated and no principal may be minted: this transport genuinely
      // has no peer address to thread into the authorization layer, and fabricating
      // `host_os` for an unauthenticated branch is forbidden. Resuming execution is
      // therefore refused by Core's resume guard.
      const denial = yield* opencode.sessions
        .prompt({ sessionID, prompt: Prompt.make({ text: "Promote this input" }) })
        .pipe(Effect.flip)
      expect(denial).toHaveProperty("_tag", "ForbiddenError")
      expect(JSON.stringify(denial, Object.getOwnPropertyNames(denial))).toContain(
        "Authenticated principal required to resume Session execution",
      )

      // The denied turn left no trace in the model-facing context: input admission
      // recorded the request, but because resume/execution was refused no `user`
      // turn was ever projected, while the non-guarded `switchModel` projection
      // still resolves through the real router and handlers.
      const context = yield* opencode.sessions.context({ sessionID })
      const other = yield* opencode.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          opencode.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
          opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          opencode.sessions.get({ sessionID: missingSessionID }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        opencode.sessions.message({ sessionID: other.id, messageID: admitted.id }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(context.filter((message) => message.type === "user")).toHaveLength(0)
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.OPENCODE_DB = database
    scratchDirectories.push(directory)
  }
})

test("Location-owned events reach the ready global client and an unauthenticated turn is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-events-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Location, OpenCode, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      const connected = yield* Latch.make(false)
      const prompted = yield* Deferred.make<OpenCodeEvent>()
      yield* opencode.events.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "server.connected"
            ? connected.open
            : event.type === "session.next.prompted" && event.data.sessionID === sessionID
              ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* connected.await
      yield* opencode.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })

      // Fail-closed boundary (parent ruling 2026-10-25): the embedded web handler
      // has no socket peer, so no principal exists and Core's resume guard refuses
      // the turn. A denied turn must therefore never produce a runner notification —
      // `server.connected` above still proves the Location-owned event stream
      // reaches the ready global client.
      const denial = yield* opencode.sessions
        .prompt({ sessionID, prompt: Prompt.make({ text: "Observe this input" }) })
        .pipe(Effect.flip)
      expect(denial).toHaveProperty("_tag", "ForbiddenError")
      expect(JSON.stringify(denial, Object.getOwnPropertyNames(denial))).toContain(
        "Authenticated principal required to resume Session execution",
      )
      const runnerEvent = yield* Deferred.await(prompted).pipe(
        Effect.map(() => "prompted" as const),
        Effect.timeoutOrElse({ duration: "500 millis", orElse: () => Effect.succeed("none" as const) }),
      )
      expect(runnerEvent).toBe("none")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.OPENCODE_DB = database
    scratchDirectories.push(directory)
  }
}, 10_000)

test("independent embedded hosts do not share live notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-hosts-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Agent, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const first = yield* OpenCode.create()
      const second = yield* OpenCode.create()
      const firstReady = yield* Latch.make(false)
      const secondReady = yield* Latch.make(false)
      const firstEvent = yield* Latch.make(false)
      const secondEvent = yield* Latch.make(false)
      const observe = (ready: Latch.Latch, event: Latch.Latch) =>
        Stream.runForEach((notification: OpenCodeEvent) =>
          notification.type === "server.connected"
            ? ready.open
            : notification.type === "session.next.agent.switched" && notification.data.sessionID === sessionID
              ? event.open
              : Effect.void,
        )

      yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
      yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
      yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
      yield* first.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

      yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
      expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.OPENCODE_DB = database
    scratchDirectories.push(directory)
  }
}, 10_000)

test("embedded client is available as a Layer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-layer-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        return yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(OpenCode.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {
    Flag.OPENCODE_DB = database
    scratchDirectories.push(directory)
  }
})

afterAll(async () => {
  for (const directory of scratchDirectories) {
    await rm(directory, { recursive: true, force: true })
  }
})
