import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Queue } from "effect"
import { Config } from "@horizoncode/core/config"
import { EventV2 } from "@horizoncode/core/event"
import { Pty } from "@horizoncode/core/pty"
import type { PtyID } from "@horizoncode/core/pty/schema"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { probeStartApproval, withLivePty } from "./live-host-kernel"

type PtyEvent = { type: "created" | "exited" | "deleted"; id: PtyID }

// `pty.create` treats `command` as the shell-profile selector, and Linux discovery
// only registers the local bash, so live cases select it by executable path.
const bash = Bun.which("bash")

// Positive lifecycle cases require an approvable `terminal.start` challenge. The kernel
// consent projection currently reports `allowEnabled=false` for start (no argument summary
// is rendered for it yet), so those cases are skipped with this probe instead of passing
// vacuously; they activate automatically once the kernel can approve a start.
const startApproval = await probeStartApproval()
// PTY-006: native Windows ConPTY is unavailable here, and no case may pretend otherwise.
const hostTest = process.platform === "win32" ? test.skip : test.skipIf(startApproval === "no-kernel")
const startTest = process.platform === "win32" ? test.skip : test.skipIf(startApproval !== "eligible")

const subscribePtyEvents = Effect.fn("PtySessionTest.subscribePtyEvents")(function* () {
  const source = yield* EventV2.Service
  const events = yield* Queue.unbounded<PtyEvent>()
  const unsubscribe = yield* source.listen((event) => {
    if (event.type === Pty.Event.Created.type)
      Queue.offerUnsafe(events, { type: "created", id: (event.data as typeof Pty.Event.Created.data.Type).info.id })
    if (event.type === Pty.Event.Exited.type)
      Queue.offerUnsafe(events, { type: "exited", id: (event.data as typeof Pty.Event.Exited.data.Type).id })
    if (event.type === Pty.Event.Deleted.type)
      Queue.offerUnsafe(events, { type: "deleted", id: (event.data as typeof Pty.Event.Deleted.data.Type).id })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return events
})

const createPty = Effect.fn("PtySessionTest.createPty")(function* (workspace: string, command: string, args: string[] = []) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command, args, cwd: workspace, env: { TERM: "xterm-256color", OPENCODE_TERMINAL: "1" } }),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const waitForEvents = (events: Queue.Queue<PtyEvent>, id: PtyID, count: number) =>
  Effect.gen(function* () {
    const picked: Array<PtyEvent["type"]> = []
    while (picked.length < count) {
      const evt = yield* Queue.take(events)
      if (evt.id === id) picked.push(evt.type)
    }
    return picked
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timeout waiting for pty events")),
    }),
  )

const attachCollecting = Effect.fn("PtySessionTest.attachCollecting")(function* (id: PtyID, cursor?: number) {
  const pty = yield* Pty.Service
  const output = yield* Queue.unbounded<string>()
  const ended = yield* Deferred.make<{ exitCode?: number }>()
  const attachment = yield* pty.attach(id, {
    origin: "oc://renderer",
    protocol: "legacy",
    cursor,
    onData: (chunk) => Queue.offerUnsafe(output, new TextDecoder().decode(chunk)),
    onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
  })
  attachment.activate()
  return { attachment, output, ended }
})

const waitForOutput = (output: Queue.Queue<string>, text: string) =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

describe("pty", () => {
  hostTest("returns typed not found errors for missing sessions", () =>
    withLivePty(({ pty }) =>
      Effect.gen(function* () {
        const id = "pty_missing" as PtyID

        for (const result of [
          yield* pty.get(id).pipe(Effect.asVoid, Effect.exit),
          yield* pty.update(id, { title: "missing" }).pipe(Effect.asVoid, Effect.exit),
          yield* pty.remove(id).pipe(Effect.exit),
          yield* pty.write(id, "input").pipe(Effect.exit),
          yield* pty
            .attach(id, { origin: "oc://renderer", protocol: "legacy", onData: () => {}, onEnd: () => {} })
            .pipe(Effect.asVoid, Effect.exit),
        ]) {
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
        }
      }),
    ),
  30_000)

  hostTest("denies an unapproved start without launching a process", () => {
    if (!bash) return
    return withLivePty(
      ({ pty, workspace }) =>
        Effect.gen(function* () {
          const marker = join(workspace, "denied-start-marker")
          const result = yield* pty
            .create({ command: bash, args: ["-c", `touch '${marker}'`], cwd: workspace, env: {} })
            .pipe(Effect.exit)

          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({ _tag: "SessionSupervisorError", stage: "authorization" })
          }
          expect(yield* pty.list()).toEqual([])
          expect(existsSync(marker)).toBe(false)
        }),
      { decide: () => "deny" },
    )
  }, 60_000)

  startTest("retains exited sessions until removed", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const events = yield* subscribePtyEvents()
        const info = yield* createPty(workspace, bash, ["-c", "exit 3"])

        expect(info.command).toBe(bash)
        // Tool execution is non-login by default, so no `-l` is appended.
        expect(info.args).toEqual(["-c", "exit 3"])
        expect(info.cwd).toBe(workspace)

        expect(yield* waitForEvents(events, info.id, 2)).toEqual(["created", "exited"])
        const exited = yield* pty.get(info.id)
        expect(exited.status).toBe("exited")
        expect(exited.exitCode).toBe(3)

        yield* pty.remove(info.id)
        expect(yield* waitForEvents(events, info.id, 1)).toEqual(["deleted"])
        const missing = yield* pty.get(info.id).pipe(Effect.exit)
        expect(Exit.isFailure(missing)).toBe(true)
      }),
    )
  }, 60_000)

  startTest("replays buffered output and streams live output to attachments", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createPty(workspace, bash, ["-c", "exec cat"])
        yield* pty.write(info.id, "AAA\n")

        const first = yield* attachCollecting(info.id)
        expect(yield* waitForOutput(first.output, "AAA")).toContain("AAA")

        first.attachment.write("BBB\n")
        yield* waitForOutput(first.output, "BBB")

        // A later attachment replays everything already buffered, as ordered stream events.
        const replayed = yield* attachCollecting(info.id)
        const replayedText = replayed.attachment.replay
          .filter((event) => event.kind === "output")
          .map((event) => new TextDecoder().decode(event.payload as Uint8Array))
          .join("")
        expect(replayedText).toContain("AAA")
        expect(replayedText).toContain("BBB")
        expect(replayed.attachment.cursor).toBeGreaterThan(0)

        // Tail attachments skip the buffer and only see subsequent output.
        const tail = yield* attachCollecting(info.id, -1)
        expect(tail.attachment.replay).toEqual([])
        expect(tail.attachment.cursor).toBe(replayed.attachment.cursor)
      }),
    )
  }, 60_000)

  startTest("stops delivering output after detach", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createPty(workspace, bash, ["-c", "exec cat"])
        const attached = yield* attachCollecting(info.id, -1)

        attached.attachment.detach()
        yield* pty.write(info.id, "AAA\n")

        const verify = yield* attachCollecting(info.id)
        yield* waitForOutput(verify.output, "AAA")
        const leaked = yield* Queue.poll(attached.output)
        expect(leaked._tag).toBe("None")
      }),
    )
  }, 60_000)

  startTest("isolates output between sessions", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const a = yield* createPty(workspace, bash, ["-c", "exec cat"])
        const b = yield* createPty(workspace, bash, ["-c", "exec cat"])
        const attachedA = yield* attachCollecting(a.id)
        const attachedB = yield* attachCollecting(b.id)

        yield* pty.write(a.id, "AAA\n")
        yield* waitForOutput(attachedA.output, "AAA")

        const leaked = yield* Queue.poll(attachedB.output)
        expect(leaked._tag).toBe("None")
      }),
    )
  }, 60_000)

  startTest("notifies attachments with the exit code and rejects attach after exit", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const events = yield* subscribePtyEvents()
        const info = yield* createPty(workspace, bash, ["-c", "exec cat"])
        const attached = yield* attachCollecting(info.id)

        yield* pty.write(info.id, "\u0004")
        expect(yield* Deferred.await(attached.ended).pipe(Effect.timeout("10 seconds"))).toEqual({ exitCode: 0 })
        yield* waitForEvents(events, info.id, 2)

        const result = yield* pty
          .attach(info.id, { origin: "oc://renderer", protocol: "legacy", onData: () => {}, onEnd: () => {} })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.ExitedError", ptyID: info.id })
      }),
    )
  }, 60_000)
})

describe("pty create defaults", () => {
  startTest("defaults command, non-login args, and cwd from config and location", () => {
    if (!bash) return
    return withLivePty(
      ({ pty, workspace }) =>
        Effect.gen(function* () {
          const info = yield* Effect.acquireRelease(pty.create({ title: "configured" }), (created) =>
            pty.remove(created.id).pipe(Effect.ignore),
          )
          expect(info.command).toBe(bash)
          expect(info.args).toEqual([])
          expect(info.cwd).toBe(workspace)
          expect(info.title).toBe("configured")
        }),
      {
        config: Layer.mock(Config.Service)({
          entries: () =>
            Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ shell: bash }) })]),
        }),
      },
    )
  })
})
