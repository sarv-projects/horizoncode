import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@horizoncode/core/database/database"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@horizoncode/core/session/sql"
import {
  MAX_HISTORY_PART_ENCODED_BYTES,
  MAX_HISTORY_PART_PREFIX_CHARS,
  page,
  readRange,
} from "../../src/tool/history-projection"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Database.node))

const sessionID = "ses_history_bounded" as never
const projectID = "project_history_bounded" as never

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: "/project" as never, sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: "history-bounded",
      directory: "/project" as never,
      title: "History bounded",
      version: "test",
      time_created: 1,
      time_updated: 1,
    })
    .onConflictDoNothing()
    .run()
})

const insertMessage = (id: string, createdAt: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(MessageTable)
      .values({
        id: id as never,
        session_id: sessionID,
        time_created: createdAt,
        time_updated: createdAt,
        data: { role: "assistant" } as never,
      })
      .run()
  })

const insertPart = (input: { id: string; messageID: string; data: Record<string, unknown>; createdAt: number }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(PartTable)
      .values({
        id: input.id as never,
        message_id: input.messageID as never,
        session_id: sessionID,
        time_created: input.createdAt,
        time_updated: input.createdAt,
        data: input.data as never,
      })
      .run()
  })

describe("bounded current-Session history projections (P3-08)", () => {
  it.effect("returns only a bounded text prefix and flags an oversized Part", () =>
    Effect.gen(function* () {
      yield* seed
      yield* insertMessage("msg_history_prefix", 10)
      const longText = `${"a".repeat(MAX_HISTORY_PART_PREFIX_CHARS)}${"b".repeat(32)}`
      yield* insertPart({ id: "prt_history_prefix", messageID: "msg_history_prefix", data: { type: "text", text: longText }, createdAt: 10 })
      yield* insertPart({
        id: "prt_history_oversized",
        messageID: "msg_history_prefix",
        data: { type: "text", text: "c".repeat(MAX_HISTORY_PART_ENCODED_BYTES + 1_024) },
        createdAt: 11,
      })
      yield* insertPart({ id: "prt_history_tool", messageID: "msg_history_prefix", data: { type: "tool", tool: "read" }, createdAt: 12 })

      const projected = yield* page({ sessionID })
      expect(String(projected?.messageID)).toBe("msg_history_prefix")
      const prefix = projected?.parts.find((part) => part.partID === "prt_history_prefix")
      expect(prefix).toMatchObject({
        prefixTruncated: true,
        oversized: false,
        unavailable: false,
        totalChars: longText.length,
      })
      expect(prefix!.textPrefix.length).toBe(MAX_HISTORY_PART_PREFIX_CHARS)
      expect(prefix!.textPrefix).not.toContain("b")

      const oversized = projected?.parts.find((part) => part.partID === "prt_history_oversized")
      expect(oversized).toMatchObject({ oversized: true, textPrefix: "" })
      // Non-text parts are not searchable and expose no stored payload.
      expect(projected?.parts.some((part) => part.partID === "prt_history_tool")).toBe(false)
    }),
  )

  it.effect("refuses an oversized range and returns only a bounded exact-key substring", () =>
    Effect.gen(function* () {
      yield* seed
      yield* insertMessage("msg_history_range", 20)
      yield* insertPart({ id: "prt_history_range", messageID: "msg_history_range", data: { type: "text", text: "😀abcde" }, createdAt: 20 })
      yield* insertPart({
        id: "prt_history_range_oversized",
        messageID: "msg_history_range",
        data: { type: "text", text: "x".repeat(MAX_HISTORY_PART_ENCODED_BYTES + 1) },
        createdAt: 21,
      })

      const bounded = yield* readRange({
        sessionID,
        messageID: "msg_history_range" as never,
        partID: "prt_history_range" as never,
        offset: 1,
        length: 3,
      })
      expect(bounded).toEqual({ status: "text", text: "abc", totalChars: 6 })

      const oversized = yield* readRange({
        sessionID,
        messageID: "msg_history_range" as never,
        partID: "prt_history_range_oversized" as never,
        offset: 0,
        length: 8,
      })
      expect(oversized).toEqual({ status: "oversized" })

      const foreign = yield* readRange({
        sessionID: "ses_other" as never,
        messageID: "msg_history_range" as never,
        partID: "prt_history_range" as never,
        offset: 0,
        length: 8,
      })
      expect(foreign).toBeUndefined()
    }),
  )

  it.effect("walks messages newest-first with a bounded per-message part count", () =>
    Effect.gen(function* () {
      yield* seed
      yield* insertMessage("msg_history_old", 30)
      yield* insertPart({ id: "prt_history_old", messageID: "msg_history_old", data: { type: "text", text: "old" }, createdAt: 30 })
      yield* insertMessage("msg_history_new", 40)
      for (let index = 0; index < 20; index += 1) {
        yield* insertPart({
          id: `prt_history_new_${index.toString().padStart(2, "0")}`,
          messageID: "msg_history_new",
          data: { type: "text", text: `part ${index}` },
          createdAt: 40 + index,
        })
      }

      const newest = yield* page({ sessionID })
      expect(String(newest?.messageID)).toBe("msg_history_new")
      expect(newest?.partsTruncated).toBe(true)
      expect(newest?.parts.length).toBe(16)

      const older = yield* page({ sessionID, before: newest!.before })
      expect(String(older?.messageID)).toBe("msg_history_old")
      expect(older?.parts.map((part) => part.partID)).toEqual(["prt_history_old"])
    }),
  )
})
