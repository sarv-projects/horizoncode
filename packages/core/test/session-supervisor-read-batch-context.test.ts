import { describe, expect, test } from "bun:test"
import { validDirectReadBatchAuthenticatedRequest } from "../src/session/supervisor"

const locationID = `loc_${"a".repeat(64)}`
const sessionID = "ses_read_batch"
const context = { kind: "repo_read" as const, sessionID, locationID }

const body = {
  schemaVersion: 1,
  sessionID,
  locationID,
  calls: [{ callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 200 } }],
}

describe("direct read-batch authenticated context", () => {
  test("accepts the exact effects.v2 read operation with one to eight calls", () => {
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", body, context)).toBe(true)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      calls: Array.from({ length: 8 }, () => body.calls[0]),
    }, context)).toBe(true)
  })

  test("rejects wrong service, operation, context kind, and scope mismatch", () => {
    expect(validDirectReadBatchAuthenticatedRequest("execution.v1", "prepare_tool_batch_read", body, context)).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch", body, context)).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", body, {
      kind: "code_mode_call",
      sessionID,
      locationID,
      callID: "call_1",
      lane: "direct_session",
    })).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      sessionID: "ses_other",
    }, context)).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      locationID: `loc_${"b".repeat(64)}`,
    }, context)).toBe(false)
  })

  test("rejects empty, oversized, and malformed call waves", () => {
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      calls: [],
    }, context)).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      calls: Array.from({ length: 9 }, () => body.calls[0]),
    }, context)).toBe(false)
    expect(validDirectReadBatchAuthenticatedRequest("effects.v2", "prepare_tool_batch_read", {
      ...body,
      calls: undefined,
    }, context)).toBe(false)
  })
})
