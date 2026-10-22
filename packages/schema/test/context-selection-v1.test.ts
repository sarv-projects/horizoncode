import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextSelectionV1 } from "../src/context-selection-v1"

const digest = (digit: string) => `blake3:${digit.repeat(64)}`
const sources = [
  {
    kind: "agent-profile" as const,
    sourceID: "horizon.default",
    sourceRevision: "3",
    contentDigest: digest("a"),
    sourceAuthority: "core-config" as const,
    trust: "system" as const,
    included: true as const,
    inclusionReason: "profile" as const,
  },
  {
    kind: "provider-input" as const,
    sourceID: "req_context_1",
    sourceRevision: "12",
    contentDigest: digest("b"),
    sourceAuthority: "core-prompt-compiler" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "current_request" as const,
  },
]

test("ContextSelectionV1 requires explicit direct lane, active profile and exact provider input", () => {
  const decode = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })
  const input = {
    schemaVersion: 1,
    lane: "direct" as const,
    sessionID: "ses_01J9ABCDEF0123456789ABCDEFGH",
    requestID: "req_context_1",
    mode: "fresh" as const,
    sourceRevision: "12",
    sources,
  }
  expect(decode(input)).toEqual(input)
  expect(() => decode({ ...input, lane: undefined })).toThrow()
  expect(() => decode({ ...input, sourceRevision: "18446744073709551616" })).toThrow()
  expect(() => decode({ ...input, sessionID: "session-without-prefix" })).toThrow()
  expect(() => decode({ ...input, sources: [sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [sources[0], sources[0], sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [{ ...sources[0], sourceAuthority: "session-store" }, sources[1]] })).toThrow()
  expect(() => decode({ ...input, sources: [{ ...sources[0], contentDigest: `sha256:${"c".repeat(64)}` }, sources[1]] })).toThrow()
  expect(() => decode({ ...input, untrustedSelectionDigest: digest("c") })).toThrow()
})
