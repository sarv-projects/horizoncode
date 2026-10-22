/** Bounded SQL projections for canonical Session history; never hydrate whole text Parts. */
import { Effect } from "effect"
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { MessageV2 } from "../session/message-v2"
import type { MessageID, SessionID } from "../session/schema"

export const MAX_HISTORY_PART_PREFIX_CHARS = 16_384
export const MAX_HISTORY_PARTS_PER_MESSAGE = 16
/** Serialized Part rows above this limit are never JSON-decoded into text. */
export const MAX_HISTORY_PART_ENCODED_BYTES = 65_536

export interface HistoryTextPartProjection {
  readonly partID: string
  /** SQL returns only a bounded prefix, never the stored text field in full. */
  readonly textPrefix: string
  readonly totalChars: number
  readonly prefixTruncated: boolean
  /** Explicitly unavailable because the stored Part exceeds the encoded-size bound. */
  readonly oversized: boolean
  /** Exact candidate changed or disappeared between size projection and bounded read. */
  readonly unavailable: boolean
}

export interface HistoryMessageProjection {
  readonly messageID: MessageID
  readonly role: string
  readonly timeCreated: number
  readonly parts: ReadonlyArray<HistoryTextPartProjection>
  readonly partsTruncated: boolean
  readonly before: string
}

export const page = Effect.fn("HistoryProjection.page")(function* (input: {
  readonly sessionID: SessionID
  readonly before?: string
}) {
  const { db } = yield* Database.Service
  const cursor = input.before ? MessageV2.cursor.decode(input.before) : undefined
  const boundary = cursor
    ? or(
        lt(MessageTable.time_created, cursor.time),
        and(eq(MessageTable.time_created, cursor.time), lt(MessageTable.id, cursor.id)),
      )
    : undefined
  const where = boundary
    ? and(eq(MessageTable.session_id, input.sessionID), boundary)
    : eq(MessageTable.session_id, input.sessionID)
  const message = yield* db
    .select({
      id: MessageTable.id,
      timeCreated: MessageTable.time_created,
      role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
    })
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!message) return undefined

  const encodedBytes = sql<number>`length(CAST(${PartTable.data} AS BLOB))`
  // Phase one returns only IDs and encoded lengths. No Part JSON or text is
  // selected until its serialized row has passed the hard byte cap.
  const summaryRows = yield* db
    .select({ id: PartTable.id, encodedBytes })
    .from(PartTable)
    .where(and(eq(PartTable.session_id, input.sessionID), eq(PartTable.message_id, message.id)))
    .orderBy(PartTable.id)
    .limit(MAX_HISTORY_PARTS_PER_MESSAGE + 1)
    .all()
    .pipe(Effect.orDie)

  const summaries = summaryRows.slice(0, MAX_HISTORY_PARTS_PER_MESSAGE)
  const candidates = summaries.filter((row) => row.encodedBytes <= MAX_HISTORY_PART_ENCODED_BYTES)
  const candidateIDs = candidates.map((row) => row.id)
  const textType = sql<string>`json_extract(${PartTable.data}, '$.type')`
  const textValue = sql<string>`json_extract(${PartTable.data}, '$.text')`
  const boundedRows = candidateIDs.length === 0 ? [] : yield* db
    .select({
      id: PartTable.id,
      encodedBytes,
      type: textType,
      textPrefix: sql<string>`substr(${textValue}, 1, ${MAX_HISTORY_PART_PREFIX_CHARS})`,
      totalChars: sql<number>`length(${textValue})`,
    })
    .from(PartTable)
    .where(and(
      eq(PartTable.session_id, input.sessionID),
      eq(PartTable.message_id, message.id),
      inArray(PartTable.id, candidateIDs),
      sql`${encodedBytes} <= ${MAX_HISTORY_PART_ENCODED_BYTES}`,
    ))
    .orderBy(PartTable.id)
    .all()
    .pipe(Effect.orDie)
  const boundedByID = new Map(boundedRows.map((row) => [row.id, row]))
  const parts = summaries.flatMap((summary): HistoryTextPartProjection[] => {
    if (summary.encodedBytes > MAX_HISTORY_PART_ENCODED_BYTES) {
      return [{ partID: summary.id, textPrefix: "", totalChars: 0, prefixTruncated: false, oversized: true, unavailable: false }]
    }
    const row = boundedByID.get(summary.id)
    if (!row || row.encodedBytes !== summary.encodedBytes) {
      return [{ partID: summary.id, textPrefix: "", totalChars: 0, prefixTruncated: false, oversized: false, unavailable: true }]
    }
    if (row.type !== "text") return []
    return [{
      partID: summary.id,
      textPrefix: row.textPrefix,
      totalChars: row.totalChars,
      prefixTruncated: row.totalChars > MAX_HISTORY_PART_PREFIX_CHARS,
      oversized: false,
      unavailable: false,
    }]
  })
  return {
    messageID: message.id as MessageID,
    role: message.role,
    timeCreated: message.timeCreated,
    parts,
    partsTruncated: summaryRows.length > MAX_HISTORY_PARTS_PER_MESSAGE,
    before: MessageV2.cursor.encode({ id: message.id, time: message.timeCreated }),
  } satisfies HistoryMessageProjection
})

export const readRange = Effect.fn("HistoryProjection.readRange")(function* (input: {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly partID: string
  readonly offset: number
  readonly length: number
}) {
  const { db } = yield* Database.Service
  const encodedBytes = sql<number>`length(CAST(${PartTable.data} AS BLOB))`
  const where = and(
    eq(PartTable.session_id, input.sessionID),
    eq(PartTable.message_id, input.messageID),
    eq(PartTable.id, input.partID),
    eq(MessageTable.session_id, input.sessionID),
  )
  // Do not even JSON-decode the Part discriminator until its serialized UTF-8
  // size has been checked in a projection that returns only the length.
  const summary = yield* db
    .select({ encodedBytes })
    .from(PartTable)
    .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
    .where(where)
    .get()
    .pipe(Effect.orDie)
  if (!summary) return undefined
  if (summary.encodedBytes > MAX_HISTORY_PART_ENCODED_BYTES) {
    return { status: "oversized" as const }
  }

  const textType = sql<string>`json_extract(${PartTable.data}, '$.type')`
  const textValue = sql<string>`json_extract(${PartTable.data}, '$.text')`
  const row = yield* db
    .select({
      id: PartTable.id,
      encodedBytes,
      type: textType,
      text: sql<string | null>`CASE WHEN ${textType} = 'text' THEN substr(${textValue}, ${input.offset + 1}, ${input.length}) ELSE NULL END`,
      totalChars: sql<number | null>`CASE WHEN ${textType} = 'text' THEN length(${textValue}) ELSE NULL END`,
    })
    .from(PartTable)
    .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
    .where(and(where, sql`${encodedBytes} <= ${MAX_HISTORY_PART_ENCODED_BYTES}`))
    .get()
    .pipe(Effect.orDie)
  if (!row || row.encodedBytes !== summary.encodedBytes) return { status: "unavailable" as const }
  if (row.type !== "text" || row.text === null || row.totalChars === null) {
    return { status: "unavailable" as const }
  }
  return { status: "text" as const, text: row.text, totalChars: row.totalChars }
})
