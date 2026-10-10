import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import {
  mkdtempSync,
  existsSync,
  readdirSync,
  rmSync,
  linkSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DateTime, Deferred, Effect, Fiber } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"

const rust = resolve(import.meta.dir, "../../../kernel/target/debug/session_sync_probe")
const supervisorRust = resolve(import.meta.dir, "../../../kernel/target/debug/session_supervisor")
const sessionID = SessionID.make("ses_kernel_live_producer")
const messageID = SessionMessage.ID.make("msg_kernel_live_producer")

async function publish(source: string, text: string) {
  const replacement = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(source),
    deps: [],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [[Database.node, replacement]])
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      return yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        text,
      })
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

async function admitAndPromote(source: string) {
  const replacement = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(source),
    deps: [],
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [Database.node, replacement],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/projection-test"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "projection-test",
          directory: "/projection-test",
          title: "projection test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const admitted = yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "private prompt text must never replicate" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      return admitted
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

describe("OpenCode EventV2 -> Rust read-only live projection", () => {
  test("Core Effect supervisor authenticates, negotiates, receives and ACKs real OpenCode events", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-session-supervised-"))
    const source = join(dir, "opencode.db")
    const state = join(dir, "supervisor")
    try {
      await admitAndPromote(source)
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]))
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const client = yield* supervisor.open({
              binary: supervisorRust,
              source,
              stateDirectory: state,
              sessionID,
              hostBuildDigest:
                "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            })
            const cursor = {
              ownerKind: "session",
              ownerId: sessionID,
              seq: "0",
              eventDigest: "blake3:" + "0".repeat(64),
            }
            yield* Effect.promise(() => client.subscribe(cursor))
            const first = yield* Effect.promise(() => client.receive())
            expect(first.kind).toBe("event")
            if (first.kind !== "event") return
            expect(first.eventType).toBe("session.next.prompt.admitted.1")
            expect(JSON.stringify(first.payload)).not.toContain("private prompt text")
            const rejectedOutOfOrderAck = yield* Effect.promise(() =>
              client
                .ack({
                  ...first,
                  cursor: { ...first.cursor, seq: "2" },
                })
                .then(
                  () => false,
                  (error: unknown) => error instanceof Error && error.message.includes("oldest delivered event"),
                ),
            )
            expect(rejectedOutOfOrderAck).toBe(true)
            yield* Effect.promise(() => client.ack(first))
            const second = yield* Effect.promise(() => client.receive())
            expect(second.kind).toBe("event")
            if (second.kind !== "event") return
            expect(second.eventType).toBe("session.next.prompted.1")
            yield* Effect.promise(() => client.ack(second))
            const pageEnd = yield* Effect.promise(() => client.receive())
            expect(pageEnd).toMatchObject({ kind: "page_end", through: second.cursor, hasMore: false })
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume).toEqual(second.cursor)
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const client = yield* supervisor.open({
              binary: supervisorRust,
              source,
              stateDirectory: state,
              sessionID,
              hostBuildDigest:
                "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            })
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume.seq).toBe("2")
            const rejectedCursorRollback = yield* Effect.promise(() =>
              client
                .subscribe({
                  ownerKind: "session",
                  ownerId: sessionID,
                  seq: "0",
                  eventDigest: "blake3:" + "0".repeat(64),
                })
                .then(
                  () => false,
                  (error: unknown) => error instanceof Error && error.message.includes("durable acknowledged cursor"),
                ),
            )
            expect(rejectedCursorRollback).toBe(true)
            yield* Effect.promise(() => client.subscribe())
            const pageEnd = yield* Effect.promise(() => client.receive())
            expect(pageEnd).toMatchObject({ kind: "page_end", through: resume, hasMore: false })
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      const checkpoint = join(state, `session-${sessionID}.cursor`)
      unlinkSync(checkpoint)
      symlinkSync(source, checkpoint)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const client = yield* supervisor.open({
              binary: supervisorRust,
              source,
              stateDirectory: state,
              sessionID,
              hostBuildDigest:
                "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            })
            const rejected = yield* Effect.promise(() =>
              client.resumeCursor().then(
                () => false,
                (error: unknown) => error instanceof Error && error.message.includes("cursor file is unsafe"),
              ),
            )
            expect(rejected).toBe(true)
            unlinkSync(checkpoint)
            writeFileSync(checkpoint, "{malformed", { mode: 0o600 })
            const rejectedMalformed = yield* Effect.promise(() =>
              client.resumeCursor().then(
                () => false,
                (error: unknown) => error instanceof Error && error.message.includes("cursor is malformed"),
              ),
            )
            expect(rejectedMalformed).toBe(true)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("Effect scope interruption releases the process lease and permits restart", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-session-supervisor-cancel-"))
    const source = join(dir, "opencode.db")
    const state = join(dir, "supervisor")
    try {
      await admitAndPromote(source)
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]))
      const started = await Effect.runPromise(Deferred.make<void>())
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const client = yield* supervisor.open({
              binary: supervisorRust,
              source,
              stateDirectory: state,
              sessionID,
              hostBuildDigest:
                "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            })
            yield* Effect.promise(() =>
              client.subscribe({
                ownerKind: "session",
                ownerId: sessionID,
                seq: "0",
                eventDigest: "blake3:" + "0".repeat(64),
              }),
            )
            const first = yield* Effect.promise(() => client.receive())
            expect(first.kind).toBe("event")
            if (first.kind !== "event") return
            yield* Effect.promise(() => client.ack(first))
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.provide(layer)),
        ),
      )
      await Effect.runPromise(Deferred.await(started))
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(readdirSync(state).filter((name) => name.endsWith(".sock"))).toEqual([])
      expect(await Bun.file(join(state, "supervisor.epoch")).text()).toBe("1")
      expect(existsSync(join(state, `session-${sessionID}.cursor`))).toBe(false)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const client = yield* supervisor.open({
              binary: supervisorRust,
              source,
              stateDirectory: state,
              sessionID,
              hostBuildDigest:
                "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            })
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume).toEqual({
              ownerKind: "session",
              ownerId: sessionID,
              seq: "0",
              eventDigest: "blake3:" + "0".repeat(64),
            })
            yield* Effect.promise(() => client.subscribe())
            for (const expected of ["session.next.prompt.admitted.1", "session.next.prompted.1"]) {
              const event = yield* Effect.promise(() => client.receive())
              expect(event.kind).toBe("event")
              if (event.kind !== "event") return
              expect(event.eventType).toBe(expected)
              yield* Effect.promise(() => client.ack(event))
            }
            const end = yield* Effect.promise(() => client.receive())
            expect(end.kind).toBe("page_end")
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(await Bun.file(join(state, "supervisor.epoch")).text()).toBe("2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("persists real prompt admission and promotion events with replay parity", async () => {
    expect(existsSync(rust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-prompt-live-"))
    const source = join(dir, "opencode.db")
    const target = join(dir, "projection.db")
    try {
      const admitted = await admitAndPromote(source)
      expect(admitted.admittedSeq).toBe(0)
      const child = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
      const projection = new SQLite(target, { readonly: true, strict: true })
      try {
        const events = projection
          .query("SELECT kind,message_id,seq FROM hc_session_receipts ORDER BY seq")
          .all() as Array<{ kind: string; message_id: string | null; seq: number }>
        expect(events).toEqual([
          { kind: "session.next.prompt.admitted.1", message_id: messageID, seq: 0 },
          { kind: "session.next.prompted.1", message_id: messageID, seq: 1 },
        ])
        expect(JSON.stringify(events)).not.toContain("private prompt text")
      } finally {
        projection.close()
      }
      const restart = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await restart.exited).toBe(0)
      expect(await new Response(restart.stdout).text()).toContain("imported=0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  test("streams committed OpenCode events in WAL mode, redacts content, and replays after restart", async () => {
    expect(existsSync(rust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-opencode-live-"))
    const source = join(dir, "opencode.db")
    const target = join(dir, "projection.db")
    try {
      await publish(source, "private first message must not replicate")
      const child = Bun.spawn([rust, source, target, sessionID, "--follow", "--poll-ms=50", "--max-polls=35"], {
        stdout: "pipe", stderr: "pipe",
      })
      try {
        await Bun.sleep(180)
        await publish(source, "private second message must not replicate")
        await Bun.sleep(180)
        await publish(source, "private third message must not replicate")
        expect(await child.exited).toBe(0)
        const output = await new Response(child.stdout).text()
        const errors = await new Response(child.stderr).text()
        expect(errors).toBe("")
        expect(output).toContain("imported=1")
        const db = new SQLite(target, { readonly: true, strict: true })
        try {
          const values = db.query("SELECT kind,message_id,tool_call_id,seq FROM hc_session_receipts ORDER BY seq").all() as Array<{
            kind:string; message_id:string | null; tool_call_id:string | null; seq:number
          }>
          expect(values.length).toBe(3)
          expect(values.map((v) => v.seq)).toEqual([0,1,2])
          expect(values.every((v) => v.message_id === messageID)).toBe(true)
          expect(values.every((v) => v.kind === "session.next.context.updated.1")).toBe(true)
          expect(JSON.stringify(values)).not.toContain("private")
        } finally { db.close() }
        const restart = Bun.spawn([rust,source,target,sessionID],{ stdout:"pipe", stderr:"pipe" })
        expect(await restart.exited).toBe(0)
        expect(await new Response(restart.stdout).text()).toContain("imported=0")
      } finally {
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    } finally {
      rmSync(dir,{recursive:true,force:true})
    }
  }, 20000)
})


test("refuses same file or hardlink for projection database", async () => {
  expect(existsSync(rust)).toBe(true)
  const directory = mkdtempSync(join(tmpdir(), "hc-projection-isolation-"))
  const source = join(directory, "opencode.db")
  try {
    await publish(source, "private source must be preserved")
    const alias = join(directory, "hardlink.db")
    linkSync(source, alias)
    for (const target of [source, alias]) {
      const child = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).not.toBe(0)
      const reason = await new Response(child.stderr).text()
      expect(reason).toContain("Source and destination")
    }
    const db = new SQLite(source, { readonly: true, strict: true })
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n).toBe(1)
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hc_session_receipts'").get()).toBeNull()
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
