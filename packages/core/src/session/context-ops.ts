export * as SessionContextOps from "./context-ops"

import { and, desc, eq, lt, lte, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { SessionContextEpoch } from "./context-epoch"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type ContextOpResult = {
  readonly operation: "clear" | "trim" | "prune"
  readonly removedMessages: number
  readonly remainingMessages: number
  readonly epochReset: boolean
  /** Fresh baseline text created by this op (post-op epoch initialization). */
  readonly baselineReinitialized: string
  /** baseline_seq stored for the new epoch. */
  readonly baselineSeq: number
}

const DEFAULT_KEEP_MESSAGES = 20
const MIN_KEEP_MESSAGES = 1
const MAX_KEEP_MESSAGES = 500

const clampKeep = (keepMessages: number | undefined) => {
  if (keepMessages === undefined) return DEFAULT_KEEP_MESSAGES
  return Math.min(Math.max(Math.trunc(keepMessages), MIN_KEEP_MESSAGES), MAX_KEEP_MESSAGES)
}

/**
 * `SystemContext.initialize(SystemContext.empty)` renders an empty baseline
 * (`""` — the identity context has no sources), which cannot anchor a fresh
 * Context Epoch. Each op therefore seeds a deterministic single-source stub so
 * the post-op epoch always carries a non-empty baseline. The next
 * `SessionContextEpoch.prepare` with the agent's real SystemContext replaces
 * this transitional generation: the stub key is unknown to the real context,
 * so reconcile resolves to `ReplacementReady` and re-renders the real baseline.
 * The public op signatures stay the contract's exact shape by keeping this
 * source internal rather than threading a caller-supplied context effect.
 */
const stubContext = (operation: ContextOpResult["operation"]) =>
  Effect.succeed(
    SystemContext.make({
      key: SystemContext.Key.make(`horizoncode/context-ops/${operation}`),
      codec: Schema.toCodecJson(Schema.String),
      load: Effect.succeed(operation),
      baseline: (current) => `horizoncode/context-ops/${current}`,
      update: (_previous, current) => `horizoncode/context-ops/${current}`,
    }),
  )

const countMessages = Effect.fn("SessionContextOps.countMessages")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ total: sql<number>`count(*)` })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return Number(row?.total ?? 0)
})

/**
 * Starts a real Context Epoch after the op's deletions: delete the epoch row
 * so the next `SessionContextEpoch.prepare` would re-initialize, then
 * immediately insert the fresh Baseline System Context + Context Snapshot
 * against the post-delete durable sequence (mirrors `initialize()` in
 * context-epoch.ts).
 */
const startEpoch = Effect.fn("SessionContextOps.startEpoch")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  operation: ContextOpResult["operation"],
) {
  yield* SessionContextEpoch.reset(db, sessionID)
  const prepared = yield* SessionContextEpoch.initialize(db, stubContext(operation), sessionID).pipe(Effect.orDie)
  if (!prepared) return yield* Effect.die("Context Epoch did not initialize after reset")
  return prepared
})

/**
 * Deletes every SessionMessageTable row for the session (every type), then
 * starts a fresh Context Epoch so the next provider turn renders a fresh
 * Baseline System Context. `events` is part of the shared op signature; clear
 * publishes no evidence event — the epoch reset itself is the ledger record.
 */
export const clear = Effect.fn("SessionContextOps.clear")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const before = yield* countMessages(db, sessionID)
  yield* db
    .delete(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  const remaining = yield* countMessages(db, sessionID)
  const prepared = yield* startEpoch(db, sessionID, "clear")
  const result: ContextOpResult = {
    operation: "clear",
    removedMessages: before - remaining,
    remainingMessages: remaining,
    epochReset: true,
    baselineReinitialized: prepared.baseline,
    baselineSeq: prepared.baselineSeq,
  }
  return result
})

/**
 * Bounded, evidence-preserving trim: keeps the newest `keepMessages` rows
 * (default 20, clamped to [1, 500]) by sequence, deletes everything older,
 * publishes a durable `SessionEvent.ContextUpdated` describing the trim, then
 * starts a fresh Context Epoch. The evidence event is committed before the
 * epoch row, so its projected system row sits at the new `baseline_seq` and
 * stays ledger-side of the next context instead of leaking into it.
 */
export const trim = Effect.fn("SessionContextOps.trim")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  options?: { readonly keepMessages?: number },
) {
  const keep = clampKeep(options?.keepMessages)
  const before = yield* countMessages(db, sessionID)
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .offset(keep - 1)
    .get()
    .pipe(Effect.orDie)
  if (boundary) {
    yield* db
      .delete(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), lt(SessionMessageTable.seq, boundary.seq)))
      .run()
      .pipe(Effect.orDie)
  }
  const remaining = yield* countMessages(db, sessionID)
  const removed = before - remaining
  yield* events.publish(SessionEvent.ContextUpdated, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    text: `Context trim: removed ${removed} message(s), kept ${remaining}.`,
  })
  const prepared = yield* startEpoch(db, sessionID, "trim")
  const result: ContextOpResult = {
    operation: "trim",
    removedMessages: removed,
    remainingMessages: remaining,
    epochReset: true,
    baselineReinitialized: prepared.baseline,
    baselineSeq: prepared.baselineSeq,
  }
  return result
})

/**
 * Ledger prune: drops stale mid-conversation system rows at or below the
 * current `baseline_seq` (never visible in the projected context) plus durable
 * rows below the latest compaction (pre-compaction rows the projection already
 * excludes), publishes a durable `SessionEvent.ContextUpdated` describing the
 * prune, then starts a fresh Context Epoch. Evidence is committed before the
 * epoch row so it stays ledger-side of the new baseline.
 */
export const prune = Effect.fn("SessionContextOps.prune")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      SessionHistory.latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  const before = yield* countMessages(db, sessionID)
  if (epoch) {
    yield* db
      .delete(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "system"),
          lte(SessionMessageTable.seq, epoch.baselineSeq),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  }
  if (compaction) {
    yield* db
      .delete(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), lt(SessionMessageTable.seq, compaction.seq)))
      .run()
      .pipe(Effect.orDie)
  }
  const remaining = yield* countMessages(db, sessionID)
  const removed = before - remaining
  yield* events.publish(SessionEvent.ContextUpdated, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    text: `Context prune: removed ${removed} stale message(s), kept ${remaining}.`,
  })
  const prepared = yield* startEpoch(db, sessionID, "prune")
  const result: ContextOpResult = {
    operation: "prune",
    removedMessages: removed,
    remainingMessages: remaining,
    epochReset: true,
    baselineReinitialized: prepared.baseline,
    baselineSeq: prepared.baselineSeq,
  }
  return result
})
