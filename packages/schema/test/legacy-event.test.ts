import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { LegacyEvent } from "../src/legacy-event"
import { PermissionV1 } from "../src/permission-v1"
import { QuestionV1 } from "../src/question-v1"
import { Project } from "../src/project"
import { SessionV1 } from "../src/session-v1"

describe("legacy public event schemas", () => {
  test("owns all SessionV1 definitions", () => {
    expect(SessionV1.Event.Definitions.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "session.deleted",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "session.diff",
      "session.error",
    ])
    const durable = SessionV1.Event.Definitions.filter((event) => event.durable !== undefined)
    expect(durable).toHaveLength(7)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable.every((event) => event.durable?.version === 1)).toBe(true)
  })

  test("owns the legacy transient public definitions", () => {
    expect([
      SessionV1.PartDelta.type,
      SessionV1.Diff.type,
      SessionV1.Error.type,
      PermissionV1.Event.Asked.type,
      PermissionV1.Event.Replied.type,
      QuestionV1.Event.Asked.type,
      QuestionV1.Event.Replied.type,
      QuestionV1.Event.Rejected.type,
      Project.Event.Updated.type,
      LegacyEvent.CommandExecuted.type,
    ]).toEqual([
      "message.part.delta",
      "session.diff",
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "project.updated",
      "command.executed",
    ])
  })

  test("requires an authentic sequence and source generation on transient part deltas", () => {
    const decode = Schema.decodeUnknownSync(SessionV1.PartDelta)
    const valid = {
      id: "evt_123",
      type: "message.part.delta",
      data: {
        sessionID: "ses_123",
        messageID: "msg_123",
        partID: "prt_123",
        field: "text",
        delta: "hello",
        sequence: 0,
        offset: 0,
        sourceGeneration: "generation-123",
      },
    }
    expect(decode(valid).data).toMatchObject({ sequence: 0, offset: 0, sourceGeneration: "generation-123" })
    expect(() => decode({ ...valid, data: { ...valid.data, sequence: -1 } })).toThrow()
    expect(() => decode({ ...valid, data: { ...valid.data, offset: -1 } })).toThrow()
    expect(() => decode({ ...valid, data: { ...valid.data, sourceGeneration: "" } })).toThrow()
    expect(() => decode({ ...valid, data: { ...valid.data, sourceGeneration: "g".repeat(257) } })).toThrow()
  })
})
