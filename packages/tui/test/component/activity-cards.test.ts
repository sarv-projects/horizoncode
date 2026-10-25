import { expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { projectActivityCards, projectProgressCard } from "../../src/component/activity-cards"

const tool = (input: {
  id: string
  name: string
  state: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}) => ({
  type: "tool",
  id: input.id,
  callID: input.id,
  name: input.name,
  tool: input.name,
  state: {
    status: input.state,
    input: input.input ?? {},
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.time === undefined ? {} : { time: input.time }),
  },
}) as unknown as Part

test("projects canonical tool kinds and never turns UNKNOWN receipts into success", () => {
  const cards = projectActivityCards([
    tool({ id: "edit-1", name: "files.patch", state: "completed", input: { filePath: "src/app.ts" } }),
    tool({ id: "shell-1", name: "terminal.run", state: "running", input: { command: "bun test" } }),
    tool({ id: "unknown-1", name: "read", state: "error", metadata: { receiptState: "unknown" } }),
    tool({ id: "custom-1", name: "unsafe tool \u001b[31m", state: "completed" }),
  ])

  expect(cards.map((card) => [card.kind, card.state])).toEqual([
    ["file_edit", "succeeded"],
    ["shell", "running"],
    ["file_read", "unknown"],
    ["generic_tool", "succeeded"],
  ])
  expect(cards[0]?.titleLine).toContain("src/app.ts")
  expect(cards[1]?.titleLine).toContain("bun")
  expect(cards[3]?.titleLine).not.toContain("\u001b")
})

test("coalesces only adjacent bounded reads and preserves chronological source ids", () => {
  const cards = projectActivityCards([
    tool({ id: "read-1", name: "read", state: "completed", input: { filePath: "a.ts" }, time: { start: 1_000, end: 1_000 } }),
    tool({ id: "read-2", name: "repo.tree", state: "completed", input: { path: "src" }, time: { start: 20_000, end: 20_000 } }),
    tool({ id: "edit-1", name: "write", state: "completed", input: { filePath: "b.ts" }, time: { start: 25_000, end: 25_000 } }),
    tool({ id: "read-3", name: "read", state: "completed", input: { filePath: "c.ts" }, time: { start: 26_000, end: 26_000 } }),
  ])

  expect(cards.map((card) => [card.kind, card.sourcePartIds])).toEqual([
    ["read_group", ["read-1", "read-2"]],
    ["file_edit", ["edit-1"]],
    ["file_read", ["read-3"]],
  ])
  expect(cards[0]?.titleLine).toContain("Read 2 paths")
})

test("caps the activity digest and marks an omitted prefix", () => {
  const cards = projectActivityCards(Array.from({ length: 100 }, (_, index) =>
    tool({ id: `tool-${index}`, name: "custom", state: "completed" }),
  ))

  expect(cards.length).toBeLessThanOrEqual(64)
  expect(cards.at(-1)?.kind).toBe("limit_marker")
  expect(cards.at(-1)?.titleLine).toContain("earlier actions omitted")
  expect(cards.at(-1)?.collapsedPreviewLines).toEqual([])
  expect(cards.at(-1)?.truncatedLineCount).toBe(0)
  expect(cards.at(-1)?.expandable).toBe(false)
  expect(cards.at(-1)?.reviewable).toBe(false)
})

test("projects bounded edit, receipt, fidelity, subagent, and timing metadata", () => {
  const [edit, unknown, subagent] = projectActivityCards([
    tool({
      id: "edit-1",
      name: "files.patch",
      state: "completed",
      input: { filePath: "src/app.ts" },
      metadata: {
        lineStats: { added: 48, removed: 2 },
        receiptState: "settled",
        artifactRef: "artifact://terminal/edit-1",
        artifactFidelity: "FULL",
      },
      time: { start: 1_000, end: 2_250 },
    }),
    tool({
      id: "write-1",
      name: "files.write",
      state: "error",
      input: { path: "src/unknown.ts" },
      metadata: { receiptState: "unknown", artifactRef: "artifact://terminal/write-1", artifactFidelity: "SAMPLE" },
    }),
    tool({
      id: "task-1",
      name: "task",
      state: "running",
      input: { description: "Audit subagents", subagent_type: "general" },
      metadata: { sessionId: "ses_child_123", agent: "general" },
    }),
  ])

  expect(edit?.pathRef).toBe("src/app.ts")
  expect(edit?.lineStats).toEqual({ added: 48, removed: 2 })
  expect(edit?.durationMs).toBe(1_250)
  expect(edit?.receiptState).toBe("settled")
  expect(edit?.fidelity).toBe("FULL")
  expect(edit?.artifactRef).toBe("artifact://terminal/edit-1")
  expect(edit?.titleLine).toContain("src/app.ts")
  expect(edit?.titleLine).toContain("+48")

  expect(unknown?.state).toBe("unknown")
  expect(unknown?.receiptState).toBe("unknown")
  expect(unknown?.fidelity).toBe("SAMPLE")

  expect(subagent?.kind).toBe("subagent")
  expect(subagent?.titleLine).toContain("ses_child_123")
  expect(subagent?.titleLine).toContain("general")
  expect(subagent?.titleLine).toContain("running")
})

test("projects reasoning as a redacted progress card with elapsed time", () => {
  const card = projectProgressCard({
    type: "reasoning",
    id: "reason-1",
    text: "private chain of thought",
    time: { start: 1_000, end: 3_450 },
  } as unknown as Parameters<typeof projectProgressCard>[0])

  expect(card.kind).toBe("progress")
  expect(card.state).toBe("succeeded")
  expect(card.durationMs).toBe(2_450)
  expect(card.titleLine).toBe("Reasoning · 2.5s")
  expect(card.titleLine).not.toContain("private chain of thought")
  expect(card.sourcePartIds).toEqual(["reason-1"])
  expect(card.collapsedPreviewLines).toEqual([])
  expect(card.expandable).toBe(false)
  expect(card.reviewable).toBe(false)
})

test("every card has a bounded, redacted expandable preview projection", () => {
  const [card] = projectActivityCards([
    tool({
      id: "output-1",
      name: "files.read",
      state: "completed",
      output: "line one\nline two\nline three\nline four\nline five\nline six\nline seven\napi_key=sk-secret-value",
    }),
  ])

  expect(card?.collapsedPreviewLines).toHaveLength(6)
  expect(card?.truncatedLineCount).toBe(2)
  expect(card?.expandable).toBe(true)
  expect(card?.reviewable).toBe(true)
  expect(card?.collapsedPreviewLines.join("\n")).not.toContain("sk-secret-value")
})
