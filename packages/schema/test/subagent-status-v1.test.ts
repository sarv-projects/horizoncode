import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as SubagentStatusV1 from "../src/subagent-status-v1"
import { SessionID } from "../src/session-id"

const child = {
  schemaVersion: 1,
  sessionId: SessionID.descending("ses_child"),
  parentSessionId: SessionID.descending("ses_parent"),
  title: "child",
  state: "running",
  activeRequest: true,
  profileId: "profile:worker",
  profileRevision: "1",
  profileDigest: `blake3:${"a".repeat(64)}`,
  permissionScopeDigest: `sha256:${"b".repeat(64)}`,
  directAttemptId: `att_${"c".repeat(16)}`,
  pendingMessages: 2,
  deliveryAckState: "acknowledged",
  lastSequence: "1",
  resultDigest: null,
  receiptDigest: null,
  failureCode: null,
  createdAt: 1,
  updatedAt: 1,
} as const

describe("SubagentStatusV1 bounded inbox projection", () => {
  test("accepts an authenticated aggregate count without exposing mailbox payloads", () => {
    expect(Schema.decodeUnknownSync(SubagentStatusV1.ChildV1, { onExcessProperty: "error" })(child)).toEqual(child)
    expect(() => Schema.decodeUnknownSync(SubagentStatusV1.ChildV1)({ ...child, pendingMessages: 33 })).toThrow()
    expect(() => Schema.decodeUnknownSync(SubagentStatusV1.ChildV1)({ ...child, payload: "private message" }, { onExcessProperty: "error" })).toThrow()
  })
})
