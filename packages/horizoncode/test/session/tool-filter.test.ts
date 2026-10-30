import { expect, test } from "bun:test"
import { tool } from "ai"
import { createToolBatchContext } from "@/session/tool-batch"
import { filterTools } from "@/session/llm"
import z from "zod"

test("LLM tool filtering exposes only the canonical standalone question control", async () => {
  let executions = 0
  const tools = {
    question: tool({
      description: "Ask the user a clarification question",
      inputSchema: z.object({ questions: z.array(z.object({ question: z.string() })) }),
      execute: async () => {
        executions++
        return { output: "answered" }
      },
    }),
    question_alias: tool({
      description: "Spoof the question control under an alias",
      inputSchema: z.object({ questions: z.array(z.object({ question: z.string() })) }),
      execute: async () => ({ output: "must not execute" }),
    }),
    write: tool({
      description: "Write a file",
      inputSchema: z.object({ filePath: z.string(), content: z.string() }),
      execute: async () => ({ output: "written" }),
    }),
  }
  const definitions = {
    question: {
      capability: { id: "question.ask", effectClass: "control" as const },
      schema: {},
      validate: async (value: unknown) => value,
    },
    question_alias: {
      capability: { id: "question.ask", effectClass: "control" as const },
      schema: {},
      validate: async (value: unknown) => value,
    },
    write: {
      capability: { id: "files.write", effectClass: "effect" as const },
      schema: {},
      validate: async (value: unknown) => value,
    },
  }
  const visible = filterTools(tools, definitions, false)

  expect(Object.keys(visible)).toEqual(["question"])
  const execute = visible.question?.execute
  if (!execute) throw new Error("question tool was filtered out")
  expect(() =>
    execute(
      { questions: [{ question: "Proceed?" }] },
      { toolCallId: "question_without_batch", messages: [], abortSignal: new AbortController().signal },
    ),
  ).toThrow("missing validated ToolBatch admission")
  const denied = createToolBatchContext()
  denied.outcomes.set("question_mixed", {
    status: "denied",
    reason: "control capability must be used in a standalone batch",
  })
  expect(() =>
    execute(
      { questions: [{ question: "Proceed?" }] },
      {
        toolCallId: "question_mixed",
        messages: [],
        abortSignal: new AbortController().signal,
        experimental_context: denied,
      },
    ),
  ).toThrow("Tool batch denied: control capability must be used in a standalone batch")
  expect(executions).toBe(0)

  const context = createToolBatchContext()
  context.outcomes.set("question_admitted", { status: "allowed", capabilityID: "question.ask" })
  await expect(
    execute(
      { questions: [{ question: "Proceed?" }] },
      {
        toolCallId: "question_admitted",
        messages: [],
        abortSignal: new AbortController().signal,
        experimental_context: context,
      },
    ),
  ).resolves.toMatchObject({ output: "answered" })
  expect(executions).toBe(1)
})
