import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as AgentMessageV1 from "../src/agent-message-v1"

describe("AgentMessageV1", () => {
  test("bounds authenticated mailbox authority counts", () => {
    const base = {
      parentSessionId: "parent",
      childSessionId: "child",
      childOwnerEpoch: "1",
      profileId: "profile",
      profileRevision: "1",
      profileDigest: `blake3:${"a".repeat(64)}`,
      permissionScopeDigest: `sha256:${"b".repeat(64)}`,
      directAttemptId: `att_${"c".repeat(32)}`,
      messageId: "message",
      deliveryMode: "queued" as const,
      payloadDigest: `sha256:${"d".repeat(64)}`,
      payloadBytes: 16 * 1024,
      mailboxSequence: "1",
      mailboxCapacity: 32,
    }

    expect(Schema.decodeUnknownSync(AgentMessageV1.AuthorityPinsV1)(base)).toEqual(base)
    expect(() => Schema.decodeUnknownSync(AgentMessageV1.AuthorityPinsV1)({ ...base, payloadBytes: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(AgentMessageV1.AuthorityPinsV1)({ ...base, mailboxCapacity: 33 })).toThrow()
  })

  test("bounds projected pending message counts", () => {
    const base = {
      schemaVersion: 1 as const,
      sessionId: "child",
      state: "queued" as const,
      ownerEpoch: "1",
      profileId: "profile",
      profileRevision: "1",
      profileDigest: `blake3:${"a".repeat(64)}`,
      pendingMessages: 0,
      activeRequest: false,
      lastSequence: "0",
    }

    expect(Schema.decodeUnknownSync(AgentMessageV1.ChildStatusV1)(base)).toEqual(base)
    expect(() => Schema.decodeUnknownSync(AgentMessageV1.ChildStatusV1)({ ...base, pendingMessages: 33 })).toThrow()
  })
})
