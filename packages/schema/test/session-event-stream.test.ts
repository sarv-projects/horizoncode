import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event"

test("every stream delta requires an event ordinal, separate text offset, and source generation", () => {
  const fixtures = [
    { schema: SessionEvent.Text.Delta, part: { textID: "part_text" } },
    { schema: SessionEvent.Reasoning.Delta, part: { reasoningID: "part_reasoning" } },
    { schema: SessionEvent.Tool.Input.Delta, part: { callID: "call_tool" } },
  ]
  for (const fixture of fixtures) {
    const decode = Schema.decodeUnknownSync(fixture.schema)
    const valid = {
      id: "evt_stream",
      type: fixture.schema.type,
      data: {
        timestamp: Date.now(),
        sessionID: "ses_stream",
        assistantMessageID: "msg_stream",
        ...fixture.part,
        delta: "value",
        sequence: 0,
        offset: 0,
        sourceGeneration: "generation-stream",
      },
    }

    expect(decode(valid).data).toMatchObject({ sequence: 0, offset: 0, sourceGeneration: "generation-stream" })
    const invalid = (patch: Record<string, unknown>) => ({ ...valid, data: { ...valid.data, ...patch } })
    expect(() => decode(invalid({ sequence: undefined }))).toThrow()
    expect(() => decode(invalid({ sequence: -1 }))).toThrow()
    expect(() => decode(invalid({ sequence: 0.5 }))).toThrow()
    expect(() => decode(invalid({ offset: -1 }))).toThrow()
    expect(() => decode(invalid({ sourceGeneration: "" }))).toThrow()
    expect(() => decode(invalid({ sourceGeneration: "g".repeat(257) }))).toThrow()
    expect(decode(invalid({ sourceGeneration: "g".repeat(256) })).data.sourceGeneration).toHaveLength(256)
  }
})
