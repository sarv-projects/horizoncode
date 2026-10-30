import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@horizoncode/core/session/message"
import {
  applyContextWindowPlanV1,
  clearContextWindowV1,
  ContextWindowPairError,
  contextWindowToolPairErrorsV1,
  planContextPruneWindowV1,
  pruneContextWindowV1,
  toolPairErrorsV1,
  trimContextWindowV1,
} from "@horizoncode/core/session/context-compile-policy"

const user = (id: string, text = "continue"): SessionMessage.Message =>
  ({ id, type: "user", text, files: [], agents: [], time: { created: 0 } }) as unknown as SessionMessage.Message

const system = (id: string, text: string): SessionMessage.Message =>
  ({ id, type: "system", text, time: { created: 0 } }) as unknown as SessionMessage.Message

const assistantText = (id: string, text: string): SessionMessage.Message =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: {},
    content: [{ type: "text", id: `${id}_t`, text }],
    time: { created: 0 },
  }) as unknown as SessionMessage.Message

const assistantTool = (input: {
  id: string
  name: string
  text: string
  status?: "completed" | "pending" | "running" | "error"
}): SessionMessage.Message =>
  ({
    id: input.id,
    type: "assistant",
    agent: "build",
    model: {},
    content: [
      {
        type: "tool",
        id: input.id + "_p",
        name: input.name,
        state:
          input.status === "error"
            ? {
                status: "error",
                input: {},
                content: [],
                structured: {},
                error: { type: "unknown", message: input.text },
              }
            : input.status === "pending" || input.status === "running"
              ? {
                  status: input.status,
                  input: {},
                  ...(input.status === "running" ? { structured: {}, content: [] } : {}),
                }
              : {
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: input.text }],
                  structured: {},
                },
        time: { created: 0 },
      },
    ],
    time: { created: 0 },
  }) as unknown as SessionMessage.Message

const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })

const history = () => [
  entry(1, user("msg_u1", "first request")),
  entry(2, assistantTool({ id: "msg_a1", name: "read", text: "x".repeat(4_000) })),
  entry(3, user("msg_u2", "second request")),
  entry(4, assistantText("msg_a2", "older narration")),
  entry(5, user("msg_u3", "latest request")),
]

const ids = (entries: ReadonlyArray<{ message: { id: string } }>) => entries.map((item) => item.message.id)

describe("A-V2-13 trim: model window only, canonical history untouched", () => {
  test("trim rewrites the oldest recoverable payload and keeps every canonical entry", () => {
    const entries = history()
    const snapshot = JSON.stringify(entries)
    const rewrite = trimContextWindowV1({ entries })

    // Canonical history is not deleted or reordered: same messages, same order.
    expect(ids(rewrite.entries)).toEqual(ids(entries))
    expect(JSON.stringify(entries)).toBe(snapshot)
    expect(rewrite.removedMessages).toEqual([])
    expect(rewrite.removedToolPairs).toEqual([])
    expect(rewrite.toolPairsIntact).toBe(true)
    expect(rewrite.removedBytes).toBeGreaterThan(1_000)

    // The payload left the model window; the tool_call/tool_result pair stayed.
    const assistant = rewrite.entries[1]!.message
    if (assistant.type !== "assistant") throw new Error("fixture is not an assistant message")
    const part = assistant.content[0]
    if (part.type !== "tool" || part.state.status !== "completed") throw new Error("tool part not rewritten")
    expect(part.state.content).toEqual([{ type: "text", text: expect.stringContaining("re-read on demand") }])
    expect(part.id).toBe("msg_a1_p")
    expect(contextWindowToolPairErrorsV1(rewrite.entries)).toEqual([])
  })

  test("trim never touches the recent protected turns or the canonical user requests", () => {
    const entries = history()
    const rewrite = trimContextWindowV1({ entries, protectRecentUserTurns: 3 })
    // All three user turns are inside the protected boundary, so nothing is eligible.
    expect(rewrite.removedBytes).toBe(0)
    expect(ids(rewrite.entries)).toEqual(ids(entries))
  })
})

describe("A-V2-13 prune: tool result and its assistant tool_call leave together", () => {
  test("prune drops the whole tool part so no orphaned tool_call survives", () => {
    const entries = history()
    const snapshot = JSON.stringify(entries)
    const rewrite = pruneContextWindowV1({ entries })

    expect(rewrite.removedToolPairs).toHaveLength(1)
    expect(rewrite.removedToolPairs[0]).toMatchObject({
      messageID: "msg_a1",
      partID: "msg_a1_p",
      tool: "read",
      callRef: "msg_a1:msg_a1_p#call",
      resultRef: "msg_a1:msg_a1_p#result",
    })
    // The assistant message carried only that tool part, so it leaves the window
    // whole rather than becoming an empty provider turn.
    expect(rewrite.removedMessages).toEqual(["msg_a1"])
    expect(ids(rewrite.entries)).toEqual(["msg_u1", "msg_u2", "msg_a2", "msg_u3"])
    expect(contextWindowToolPairErrorsV1(rewrite.entries)).toEqual([])
    // Canonical rows are still in the store; only the projection changed.
    expect(JSON.stringify(entries)).toBe(snapshot)
  })

  test("the pairing guard detects a result whose call is gone", () => {
    // This is the exact 400-risk shape: the tool_result is retained while the
    // assistant tool_call is not.
    const errors = toolPairErrorsV1({
      calls: [{ callID: "call_1", messageID: "msg_a1" }],
      results: [
        { callID: "call_1", messageID: "msg_a1" },
        { callID: "call_2", messageID: "msg_a2" },
      ],
    })
    expect(errors).toEqual([{ callID: "call_2", messageID: "msg_a2", reason: "orphan_tool_result" }])

    expect(toolPairErrorsV1({ calls: [{ callID: "call_9", messageID: "msg_a9" }], results: [] })).toEqual([
      { callID: "call_9", messageID: "msg_a9", reason: "orphan_tool_call" },
    ])
  })

  test("a plan that separates a call from its result is rejected before dispatch", () => {
    const entries = history()
    const plan = planContextPruneWindowV1({ entries })
    expect(plan.excludedToolPairs).toHaveLength(1)
    const broken = {
      ...plan,
      excludedToolPairs: [
        { ...plan.excludedToolPairs[0]!, resultRef: "msg_a1:msg_a1_p#call" },
      ],
    }
    expect(() => applyContextWindowPlanV1({ entries, plan: broken })).toThrow(ContextWindowPairError)
  })

  test("prune protects error evidence, unsettled effects and caller-pinned evidence", () => {
    const entries = [
      entry(1, user("msg_u1")),
      entry(2, assistantTool({ id: "msg_err", name: "grep", text: "denied", status: "error" })),
      entry(3, assistantTool({ id: "msg_run", name: "read", text: "y".repeat(4_000), status: "running" })),
      entry(4, assistantTool({ id: "msg_pin", name: "read", text: "z".repeat(4_000) })),
      entry(5, user("msg_u2")),
      entry(6, user("msg_u3")),
    ]
    const rewrite = pruneContextWindowV1({ entries, protectedRefs: ["msg_pin:msg_pin_p"], minimumBytes: 0 })
    expect(rewrite.removedToolPairs).toEqual([])
    expect(ids(rewrite.entries)).toEqual(ids(entries))
  })
})

describe("A-V2-13 clear: reset to system plus pinned context", () => {
  test("clear keeps system and pinned context and drops the rest of the window", () => {
    const entries = [
      entry(1, system("msg_sys", "baseline system context")),
      entry(2, user("msg_u1", "first request")),
      entry(3, assistantTool({ id: "msg_a1", name: "read", text: "x".repeat(2_000) })),
      entry(4, user("msg_pin", "pinned instruction")),
      entry(5, assistantText("msg_a2", "latest answer")),
    ]
    const snapshot = JSON.stringify(entries)
    const rewrite = clearContextWindowV1({ entries, pinnedRefs: ["msg_pin"] })

    expect(ids(rewrite.entries)).toEqual(["msg_sys", "msg_pin"])
    expect(rewrite.retainedRefs).toEqual(["msg_sys", "msg_pin"])
    expect(rewrite.removedMessages).toEqual(["msg_u1", "msg_a1", "msg_a2"])
    expect(rewrite.toolPairsIntact).toBe(true)
    expect(JSON.stringify(entries)).toBe(snapshot)
  })

  test("clear rejects a malformed pin list instead of silently ignoring it", () => {
    expect(() =>
      clearContextWindowV1({
        entries: history(),
        pinnedRefs: "msg_u1" as unknown as readonly string[],
      }),
    ).toThrow("protectedRefs must be an array")
  })
})
