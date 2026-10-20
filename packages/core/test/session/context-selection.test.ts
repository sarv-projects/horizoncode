import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import { compile } from "../../src/session/context-selection"

const message = (id: string) => Schema.decodeUnknownSync(SessionMessage.User)({
  id: SessionMessage.ID.make(id),
  type: "user",
  text: id,
  files: [],
  agents: [],
  time: { created: 0 },
})

test("Core context selection pins a bounded ordered source set and current durable cursor", () => {
  const selected = compile({
    sessionID: SessionSchema.ID.make("ses_01J9ABCDEF0123456789ABCDEFGH"),
    mode: "conversation_slice",
    sourceRevision: 12,
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1"), message("msg_01J9ABCDEF0123456789ABCDEFG2")],
  })
  expect(selected.sourceRevision).toBe("12")
  expect(selected.sources.map((item) => String(item.messageID))).toEqual([
    "msg_01J9ABCDEF0123456789ABCDEFG1",
    "msg_01J9ABCDEF0123456789ABCDEFG2",
  ])
  expect(selected.sources[0]?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(selected).not.toHaveProperty("messages")
  expect(compile({ ...{
    sessionID: selected.sessionID,
    mode: "fresh",
    sourceRevision: 12,
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1")],
  } }).sources).toEqual([])
})
