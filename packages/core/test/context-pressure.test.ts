import { describe, expect, test } from "bun:test"
import type { LLMRequest, Model } from "@opencode-ai/llm"
import type { SessionMessage } from "@opencode-ai/core/session/message"
import {
  planContextPruneV1 as planPrune,
  planContextTrimV1 as planTrim,
  planPressureRecoveryV1 as planPressureRecovery,
} from "@opencode-ai/core/session/context-compile-policy"

const user = (id: string, text = "continue"): SessionMessage.Message =>
  ({ id, type: "user", text, files: [], agents: [], time: { created: 0 } }) as unknown as SessionMessage.Message

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
  structured?: Record<string, unknown>
}): SessionMessage.Message =>
  ({
    id: input.id,
    type: "assistant",
    agent: "build",
    model: {},
    content: [
      {
        type: "tool",
        id: `${input.id}_p`,
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
              ? { status: input.status, input: {}, ...(input.status === "running" ? { structured: {}, content: [] } : {}) }
              : {
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: input.text }],
                  structured: input.structured ?? {},
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

describe("§30.3 context operations", () => {
  test("trim plans only recoverable old payloads and protects the latest user turns", () => {
    const plan = planTrim({ entries: history() })
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]).toMatchObject({ messageID: "msg_a1", tool: "read", reference: "tool:read" })
    expect(plan.removableBytes).toBeGreaterThanOrEqual(4_000)
    expect(plan.candidates[0]!.placeholder).toContain("re-read on demand")
    expect(plan.protectedRefs).toContain("msg_a2:msg_a2_t")
    expect(plan.protectedRefs).toContain("msg_u3")
  })

  test("trim never removes task/question/error evidence, unsettled effects or unrecoverable output", () => {
    const entries = [
      entry(1, user("msg_u1")),
      entry(2, assistantTool({ id: "msg_task", name: "task", text: "y".repeat(4_000) })),
      entry(3, assistantTool({ id: "msg_error", name: "grep", text: "denied", status: "error" })),
      entry(4, assistantTool({ id: "msg_pending", name: "grep", text: "z".repeat(4_000), status: "pending" })),
      entry(5, assistantTool({ id: "msg_no_ref", name: "custom_write", text: "w".repeat(4_000) })),
      entry(6, user("msg_u2")),
      entry(7, user("msg_u3")),
    ]
    const plan = planTrim({ entries })
    expect(plan.candidates).toHaveLength(0)
    expect(plan.reasons.map((reason) => reason.reason)).toEqual(
      expect.arrayContaining(["protected_tool_evidence", "error_evidence", "unsettled_effect", "no_recoverable_reference"]),
    )
  })

  test("trim preserves an artifact reference when one is present", () => {
    const plan = planTrim({
      entries: [
        entry(1, user("msg_u1")),
        entry(2, assistantTool({ id: "msg_a1", name: "custom_write", text: "q".repeat(2_000), structured: { artifactRef: "artifact:abc" } })),
        entry(3, user("msg_u2")),
        entry(4, user("msg_u3")),
      ],
    })
    expect(plan.candidates[0]).toMatchObject({ reference: "artifact:abc" })
  })

  test("a protected Goal/criteria line 20 turns old is never a trim or prune candidate (CX-003)", () => {
    // Goal + criteria land on turn 1; 20 further turns follow, so the protected
    // line is far outside the recent-turn boundary.
    const goalTurns = () => {
      const turns = [
        entry(1, user("msg_u1", "Goal: finish the V1 migration — criterion: every suite stays green")),
        entry(2, assistantTool({ id: "msg_a_goal", name: "goal", text: "criteria recorded" })),
      ]
      for (let turn = 1; turn <= 20; turn += 1) {
        turns.push(entry(2 * turn + 1, assistantText(`msg_n${turn}`, `stale narration ${turn}`)))
        turns.push(entry(2 * turn + 2, user(`msg_t${turn}`, `continue ${turn}`)))
      }
      return turns
    }

    const trim = planTrim({ entries: goalTurns() })
    expect(trim.candidates.some((candidate) => candidate.messageID === "msg_a_goal")).toBe(false)
    expect(trim.reasons).toContainEqual({ ref: "msg_a_goal:msg_a_goal_p", reason: "protected_tool_evidence" })
    // The user-stated Goal line itself is never a candidate either.
    expect(trim.candidates.some((candidate) => candidate.messageID === "msg_u1")).toBe(false)

    const prune = planPrune({ entries: goalTurns() })
    expect(prune.candidates.some((candidate) => candidate.messageID === "msg_a_goal")).toBe(false)
    expect(prune.candidates.some((candidate) => candidate.messageID === "msg_u1")).toBe(false)
    // The plan is not vacuous: ordinary stale narration from the same history
    // is still eligible, so the Goal line is excluded by protection, not by an
    // empty candidate set.
    expect(prune.candidates.length).toBeGreaterThan(0)
    expect(prune.candidates.every((candidate) => candidate.messageID.startsWith("msg_n"))).toBe(true)

    // With the Goal ref pinned by the caller, prune records it as protected.
    const pinned = planPrune({ entries: goalTurns(), protectedRefs: ["msg_a_goal"] })
    expect(pinned.protectedRefs).toContain("msg_a_goal:msg_a_goal_p")
  })

  test("prune preview protects recent and pinned entries and records a recoverable range", () => {
    const plan = planPrune({ entries: history(), protectedRefs: ["msg_a2:msg_a2_t"] })
    expect(plan.candidates).toHaveLength(0)
    expect(plan.protectedRefs).toContain("msg_a2:msg_a2_t")

    const eligible = planPrune({
      entries: [
        entry(1, user("msg_u1")),
        entry(2, assistantText("msg_old", "stale narration")),
        entry(3, user("msg_u2")),
        entry(4, assistantText("msg_recent", "recent narration")),
        entry(5, user("msg_u3")),
      ],
    })
    expect(eligible.candidates).toHaveLength(1)
    expect(eligible.candidates[0]).toMatchObject({
      messageID: "msg_old",
      reason: "stale_assistant_narration",
      digest: expect.stringMatching(/^blake3:[0-9a-f]{64}$/),
    })
    expect(eligible.sourceRange).toEqual({ firstMessageID: "msg_old", lastMessageID: "msg_old" })
  })
})

describe("§30.4 pressure recovery step 0", () => {
  const model = { route: { defaults: { limits: { context: 1_000, output: 100 } } } } as unknown as Model
  const request = {
    system: ["context ".repeat(800)],
    messages: [],
    tools: [],
    generation: { maxTokens: 100 },
  } as unknown as LLMRequest

  test("auto-trims once per epoch before proposing compaction", () => {
    const first = planPressureRecovery({
      entries: history(),
      request,
      model,
      epochID: "epoch_1",
      safetyMarginTokens: 50,
    })
    expect(first.status).toBe("auto_trim")
    if (first.status !== "auto_trim") throw new Error("expected auto_trim")
    expect(first.plan.candidates).toHaveLength(1)
    expect(first.estimatedInputTokens).toBeGreaterThan(first.softPressureLimit)

    const repeated = planPressureRecovery({
      entries: history(),
      request,
      model,
      epochID: "epoch_1",
      autoTrimmedEpochIDs: ["epoch_1"],
      safetyMarginTokens: 50,
    })
    expect(repeated.status).toBe("compact")
  })

  test("reports exact budget diagnostics when no recovery remains", () => {
    const exhausted = planPressureRecovery({
      entries: [entry(1, user("msg_u1", "only the current request"))],
      request,
      model,
      epochID: "epoch_2",
      safetyMarginTokens: 50,
    })
    expect(exhausted.status).toBe("context_budget_exceeded")
    if (exhausted.status !== "context_budget_exceeded") throw new Error("expected budget exhaustion")
    expect(exhausted.diagnostics).toEqual({ contextLimit: 1_000, outputReserve: 100, toolReserve: 1, safetyMargin: 50 })
  })

  test("an unknown context limit never blocks Send and never claims recovery", () => {
    const unknown = planPressureRecovery({
      entries: history(),
      request,
      model: { route: { defaults: { limits: {} } } } as unknown as Model,
      epochID: "epoch_3",
    })
    expect(unknown.status).toBe("unknown_context_limit")
  })
})
