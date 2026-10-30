import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@horizoncode/core/database/database"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { EventV2 } from "@horizoncode/core/event"
import { Location } from "@horizoncode/core/location"
import { ModelV2 } from "@horizoncode/core/model"
import { Project } from "@horizoncode/core/project"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { ProviderV2 } from "@horizoncode/core/provider"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionContextOps } from "@horizoncode/core/session/context-ops"
import { SessionEvent } from "@horizoncode/core/session/event"
import { SessionHistory } from "@horizoncode/core/session/history"
import { SessionMessage } from "@horizoncode/core/session/message"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { SessionSchema } from "@horizoncode/core/session/schema"
import { SessionContextEpochTable, SessionMessageTable, SessionTable } from "@horizoncode/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

type SeedMessage = {
  readonly id: string
  readonly seq: number
  readonly kind: "user" | "assistant" | "system"
  readonly text: string
}

const messageRow = (sessionID: SessionSchema.ID, input: SeedMessage) => {
  const id = SessionMessage.ID.make(input.id)
  const message =
    input.kind === "user"
      ? SessionMessage.User.make({ id, type: "user", text: input.text, time: { created } })
      : input.kind === "system"
        ? SessionMessage.System.make({ id, type: "system", text: input.text, time: { created } })
        : SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time: { created } })
  const { id: _encodedID, type, ...data } = encodeMessage(message)
  return { id, session_id: sessionID, type, seq: input.seq, time_created: DateTime.toEpochMillis(created), data }
}

/** Seeds the Session plus a durable aggregate sequence that projects no message row. */
const seedSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* events.publish(SessionEvent.Moved, {
      sessionID,
      timestamp: created,
      location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
    })
  })

const insertMessages = (sessionID: SessionSchema.ID, messages: readonly SeedMessage[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values(messages.map((message) => messageRow(sessionID, message)))
      .run()
      .pipe(Effect.orDie)
  })

const seedEpoch = (sessionID: SessionSchema.ID, baseline: string, baselineSeq: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionContextEpochTable)
      .values({ session_id: sessionID, baseline, snapshot: {}, baseline_seq: baselineSeq })
      .run()
      .pipe(Effect.orDie)
  })

const findEpoch = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const rawMessages = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({
        id: SessionMessageTable.id,
        type: SessionMessageTable.type,
        seq: SessionMessageTable.seq,
        data: SessionMessageTable.data,
      })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
  })

const history = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* SessionHistory.load(db, sessionID)
  })

const containsText = (rows: ReadonlyArray<{ readonly data: unknown }>, text: string) =>
  rows.some((row) => JSON.stringify(row.data).includes(text))

describe("SessionContextOps", () => {
  it.effect("clear deletes every message and starts a fresh context epoch", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_ops_clear")
      yield* seedSession(sessionID)
      yield* insertMessages(sessionID, [
        { id: "msg_ops_c1", seq: 1, kind: "user", text: "hello" },
        { id: "msg_ops_c2", seq: 2, kind: "assistant", text: "hi" },
        { id: "msg_ops_c3", seq: 3, kind: "system", text: "context note" },
        { id: "msg_ops_c4", seq: 4, kind: "user", text: "next" },
        { id: "msg_ops_c5", seq: 5, kind: "assistant", text: "on it" },
        { id: "msg_ops_c6", seq: 6, kind: "system", text: "more context" },
      ])
      yield* seedEpoch(sessionID, "old-baseline", 0)

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const beforeRows = yield* rawMessages(sessionID)
      expect(beforeRows.length).toBeGreaterThan(0)
      expect((yield* findEpoch(sessionID))?.baseline).toBe("old-baseline")
      expect(yield* history(sessionID)).toHaveLength(beforeRows.length)

      const result = yield* SessionContextOps.clear(db, events, sessionID)

      expect(result.operation).toBe("clear")
      expect(result.removedMessages).toBe(beforeRows.length)
      expect(result.remainingMessages).toBe(0)
      expect(result.epochReset).toBe(true)
      expect(result.baselineReinitialized.length).toBeGreaterThan(0)
      expect(result.baselineSeq).toBeGreaterThanOrEqual(0)

      expect(yield* rawMessages(sessionID)).toHaveLength(0)
      expect(yield* history(sessionID)).toEqual([])

      const epoch = yield* findEpoch(sessionID)
      expect(epoch?.baseline).toBe(result.baselineReinitialized)
      expect(epoch?.baseline).not.toBe("old-baseline")
      expect(epoch?.baseline_seq).toBe(result.baselineSeq)

      // The subsequent provider turn reads the new epoch without throwing.
      const entries = yield* SessionHistory.entriesForRunner(db, sessionID, result.baselineSeq)
      expect(entries).toEqual([])

      yield* insertMessages(sessionID, [
        { id: "msg_ops_c_after_user", seq: result.baselineSeq + 1, kind: "user", text: "fresh user" },
        { id: "msg_ops_c_after_assistant", seq: result.baselineSeq + 2, kind: "assistant", text: "fresh assistant" },
      ])
      expect((yield* history(sessionID)).map((message) => message.id)).toEqual([
        SessionMessage.ID.make("msg_ops_c_after_user"),
        SessionMessage.ID.make("msg_ops_c_after_assistant"),
      ])
    }),
  )

  it.effect("trim keeps the newest messages and starts a fresh context epoch", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_ops_trim")
      yield* seedSession(sessionID)
      yield* insertMessages(
        sessionID,
        Array.from({ length: 30 }, (_, index) => ({
          id: `msg_ops_trim_${String(index + 1).padStart(2, "0")}`,
          seq: index + 1,
          kind: index % 7 === 3 ? "system" : index % 2 === 0 ? "user" : "assistant",
          text: `message ${index + 1}`,
        })),
      )
      yield* seedEpoch(sessionID, "old-trim-baseline", 0)

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      expect(yield* history(sessionID)).toHaveLength(30)

      const result = yield* SessionContextOps.trim(db, events, sessionID)

      expect(result.operation).toBe("trim")
      expect(result.removedMessages).toBe(10)
      expect(result.remainingMessages).toBe(20)
      expect(result.epochReset).toBe(true)

      const after = yield* history(sessionID)
      expect(after).toHaveLength(20)
      // Newest 20 survive: the oldest remaining row is the 11th original message.
      expect(after[0]?.id).toBe(SessionMessage.ID.make("msg_ops_trim_11"))

      const epoch = yield* findEpoch(sessionID)
      expect(epoch?.baseline).toBe(result.baselineReinitialized)
      expect(epoch?.baseline).not.toBe("old-trim-baseline")

      expect(
        containsText(yield* rawMessages(sessionID), "Context trim: removed 10 message(s), kept 20."),
      ).toBe(true)
    }),
  )

  it.effect("prune drops stale system rows below the ledger baseline", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_ops_prune")
      yield* seedSession(sessionID)
      // Seq 1 stays free: the prune evidence event commits at durable seq 1.
      yield* insertMessages(sessionID, [
        { id: "msg_ops_pr_u1", seq: 2, kind: "user", text: "one" },
        { id: "msg_ops_pr_a1", seq: 3, kind: "assistant", text: "two" },
        { id: "msg_ops_pr_s1", seq: 4, kind: "system", text: "stale system one" },
        { id: "msg_ops_pr_s2", seq: 6, kind: "system", text: "stale system two" },
        { id: "msg_ops_pr_u2", seq: 8, kind: "user", text: "three" },
        { id: "msg_ops_pr_a2", seq: 10, kind: "assistant", text: "four" },
        { id: "msg_ops_pr_s3", seq: 13, kind: "system", text: "live system" },
        { id: "msg_ops_pr_u3", seq: 15, kind: "user", text: "five" },
      ])
      yield* seedEpoch(sessionID, "mid-history-baseline", 10)

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const beforeRows = yield* rawMessages(sessionID)
      const nonSystemBefore = beforeRows.filter((row) => row.type !== "system").map((row) => row.id)
      // The ledger already hides system rows at or below the baseline.
      expect(
        (yield* history(sessionID)).filter((message) => message.type === "system").map((message) => message.id),
      ).toEqual([SessionMessage.ID.make("msg_ops_pr_s3")])

      const result = yield* SessionContextOps.prune(db, events, sessionID)

      expect(result.operation).toBe("prune")
      expect(result.removedMessages).toBe(2)
      expect(result.remainingMessages).toBe(6)
      expect(result.epochReset).toBe(true)

      const afterRows = yield* rawMessages(sessionID)
      expect(afterRows.filter((row) => row.type !== "system").map((row) => row.id)).toEqual(nonSystemBefore)
      const systemIDs = afterRows.filter((row) => row.type === "system").map((row) => row.id)
      expect(systemIDs).not.toContain(SessionMessage.ID.make("msg_ops_pr_s1"))
      expect(systemIDs).not.toContain(SessionMessage.ID.make("msg_ops_pr_s2"))
      expect(systemIDs).toContain(SessionMessage.ID.make("msg_ops_pr_s3"))

      // Only the above-baseline system row remains in the projected context.
      expect(
        (yield* history(sessionID)).filter((message) => message.type === "system").map((message) => message.id),
      ).toEqual([SessionMessage.ID.make("msg_ops_pr_s3")])
      expect(containsText(afterRows, "Context prune: removed 2 stale message(s), kept 6.")).toBe(true)

      const epoch = yield* findEpoch(sessionID)
      expect(epoch?.baseline).toBe(result.baselineReinitialized)
      expect(epoch?.baseline).not.toBe("mid-history-baseline")
      expect(epoch?.baseline_seq).toBe(result.baselineSeq)
    }),
  )

  it.effect("clear and trim shrink the serialized session context", () =>
    Effect.gen(function* () {
      const clearID = SessionSchema.ID.make("ses_ops_evidence_clear")
      yield* seedSession(clearID)
      yield* insertMessages(
        clearID,
        Array.from({ length: 12 }, (_, index) => ({
          id: `msg_ops_ev_c${index + 1}`,
          seq: index + 1,
          kind: index % 3 === 2 ? "system" : index % 2 === 0 ? "user" : "assistant",
          text: `clear message ${index + 1}`,
        })),
      )
      const trimID = SessionSchema.ID.make("ses_ops_evidence_trim")
      yield* seedSession(trimID)
      yield* insertMessages(
        trimID,
        Array.from({ length: 30 }, (_, index) => ({
          id: `msg_ops_ev_t${index + 1}`,
          seq: index + 1,
          kind: index % 3 === 2 ? "system" : index % 2 === 0 ? "user" : "assistant",
          text: `trim message ${index + 1}`,
        })),
      )

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service

      const clearBefore = JSON.stringify(yield* history(clearID))
      expect(clearBefore.length).toBeGreaterThan(0)
      yield* SessionContextOps.clear(db, events, clearID)
      const clearAfter = JSON.stringify(yield* history(clearID))
      expect(clearAfter.length).toBeLessThan(clearBefore.length)

      const trimBefore = JSON.stringify(yield* history(trimID))
      expect(trimBefore.length).toBeGreaterThan(0)
      yield* SessionContextOps.trim(db, events, trimID)
      const trimAfter = JSON.stringify(yield* history(trimID))
      expect(trimAfter.length).toBeLessThan(trimBefore.length)
    }),
  )

  it.effect("context ops succeed on a session with no messages", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service

      const clearID = SessionSchema.ID.make("ses_ops_empty_clear")
      yield* seedSession(clearID)
      expect(yield* history(clearID)).toEqual([])
      const cleared = yield* SessionContextOps.clear(db, events, clearID)
      expect(cleared.removedMessages).toBe(0)
      expect(cleared.remainingMessages).toBe(0)
      expect(cleared.epochReset).toBe(true)
      expect((yield* findEpoch(clearID))?.baseline).toBe(cleared.baselineReinitialized)

      const trimID = SessionSchema.ID.make("ses_ops_empty_trim")
      yield* seedSession(trimID)
      const trimmed = yield* SessionContextOps.trim(db, events, trimID)
      expect(trimmed.removedMessages).toBe(0)
      expect(trimmed.remainingMessages).toBe(0)
      expect(trimmed.epochReset).toBe(true)
      expect((yield* findEpoch(trimID))?.baseline).toBe(trimmed.baselineReinitialized)

      const pruneID = SessionSchema.ID.make("ses_ops_empty_prune")
      yield* seedSession(pruneID)
      const pruned = yield* SessionContextOps.prune(db, events, pruneID)
      expect(pruned.removedMessages).toBe(0)
      expect(pruned.remainingMessages).toBe(0)
      expect(pruned.epochReset).toBe(true)
      expect((yield* findEpoch(pruneID))?.baseline).toBe(pruned.baselineReinitialized)
      // The evidence event stays ledger-side of the fresh baseline.
      expect(yield* history(pruneID)).toEqual([])
    }),
  )

  it.effect("trim clamps keepMessages to the [1, 500] bounds", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service

      const lowID = SessionSchema.ID.make("ses_ops_clamp_low")
      yield* seedSession(lowID)
      yield* insertMessages(
        lowID,
        Array.from({ length: 5 }, (_, index) => ({
          id: `msg_ops_clamp_low_${index + 1}`,
          seq: index + 1,
          kind: "user" as const,
          text: `low ${index + 1}`,
        })),
      )
      const low = yield* SessionContextOps.trim(db, events, lowID, { keepMessages: 0 })
      expect(low.removedMessages).toBe(4)
      expect(low.remainingMessages).toBe(1)
      expect(yield* history(lowID)).toHaveLength(1)

      const highID = SessionSchema.ID.make("ses_ops_clamp_high")
      yield* seedSession(highID)
      yield* insertMessages(
        highID,
        Array.from({ length: 505 }, (_, index) => ({
          id: `msg_ops_clamp_high_${index + 1}`,
          seq: index + 1,
          kind: "user" as const,
          text: `high ${index + 1}`,
        })),
      )
      const high = yield* SessionContextOps.trim(db, events, highID, { keepMessages: 9999 })
      expect(high.removedMessages).toBe(5)
      expect(high.remainingMessages).toBe(500)
      expect(yield* history(highID)).toHaveLength(500)
    }),
  )
})
