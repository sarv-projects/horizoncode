import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextSelectionV1 } from "../src/context-selection-v1"

const source = {
  kind: "session-message" as const,
  messageID: "msg_01J9ABCDEF0123456789ABCDEFGH",
  contentDigest: `sha256:${"a".repeat(64)}`,
}

test("ContextSelectionV1 bounds and pins ordered Core message refs without carrying transcript", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const input = {
    schemaVersion: 1,
    sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
    mode: "conversation_slice" as const,
    sourceRevision: "18446744073709551615",
    sources: [source],
  }
  expect(decode(input)).toEqual(input)
  expect(input).not.toHaveProperty("messages")
  expect(() => decode({ ...input, sourceRevision: "18446744073709551616" })).toThrow()
  expect(() => decode({ ...input, sessionID: "session-without-prefix" })).toThrow()
  expect(() => decode({ ...input, mode: "fresh" })).toThrow()
  expect(() => decode({ ...input, sources: [source, source] })).toThrow()
  expect(() => decode({ ...input, untrustedSelectionDigest: "sha256:x" })).toThrow()
  expect(() => decode({ ...input, sources: [{ ...source, injected: true }] })).toThrow()
})
