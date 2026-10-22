import { expect, test } from "bun:test"
import { createPartDeltaCursorV1 } from "../../src/session/part-delta-cursor"

test("part delta cursor emits monotonic event ordinals, edit offsets, and fresh generations", () => {
  const cursor = createPartDeltaCursorV1()
  const identity = { sessionID: "ses_cursor", messageID: "msg_cursor", partID: "prt_cursor", field: "text" }
  cursor.begin(identity)

  expect(cursor.append(identity, "🧑‍💻")).toEqual({
    sequence: 0,
    offset: 0,
    sourceGeneration: expect.any(String),
  })
  const next = cursor.append(identity, "x")
  expect(next).toEqual({
    sequence: 1,
    offset: "🧑‍💻".length,
    sourceGeneration: expect.any(String),
  })
  const generation = next?.sourceGeneration
  expect(cursor.append(identity, "y")?.sequence).toBe(2)

  cursor.end(identity)
  expect(cursor.append(identity, "late")).toBeUndefined()
  cursor.begin(identity)
  expect(cursor.append(identity, "new")?.sourceGeneration).not.toBe(generation)
})
