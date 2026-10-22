import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import { compile } from "../../src/session/context-selection"

const sessionID = SessionSchema.ID.make("ses_01J9ABCDEF0123456789ABCDEFGH")
const profile = {
  profileID: "horizon.default",
  revision: 3,
  profileDigest: `blake3:${"a".repeat(64)}`,
  trust: "system" as const,
}
const providerInput = {
  system: ["System prompt"],
  messages: [{ role: "user", content: "hello" }],
  tools: {},
}

const message = (id: string) => Schema.decodeUnknownSync(SessionMessage.User)({
  id: SessionMessage.ID.make(id),
  type: "user",
  text: id,
  files: [],
  agents: [],
  time: { created: 0 },
})

test("Core context selection pins lane, current cursor, active profile and provider input", () => {
  const selected = compile({
    sessionID,
    requestID: "req_context_1",
    mode: "conversation_slice",
    sourceRevision: "12",
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1"), message("msg_01J9ABCDEF0123456789ABCDEFG2")],
    providerInput,
    agentProfile: profile,
  })
  expect(selected.lane).toBe("direct")
  expect(selected.sourceRevision).toBe("12")
  expect(selected.sources.map((item) => `${item.kind}:${item.sourceID}`)).toEqual([
    "session-message:msg_01J9ABCDEF0123456789ABCDEFG1",
    "session-message:msg_01J9ABCDEF0123456789ABCDEFG2",
    "provider-input:req_context_1",
    "agent-profile:horizon.default",
  ])
  expect(selected.sources.find((item) => item.kind === "agent-profile")?.sourceRevision).toBe("3")
  expect(selected.sources.find((item) => item.kind === "provider-input")?.contentDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  expect(selected).not.toHaveProperty("messages")
})

test("fresh selection omits prior messages but retains the current request and active profile", () => {
  const selected = compile({
    sessionID,
    requestID: "req_context_fresh",
    mode: "fresh",
    sourceRevision: "0",
    messages: [message("msg_01J9ABCDEF0123456789ABCDEFG1")],
    providerInput,
    agentProfile: profile,
  })
  expect(selected.sources.map((item) => item.kind)).toEqual(["provider-input", "agent-profile"])
})
