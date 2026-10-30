import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { collectAnalytics } from "../../src/analytics/collect"
import { tmpdir } from "../fixture/fixture"

/**
 * One user prompt, one step, one tool call that succeeds — the durable
 * `session.next.*` wire shape (`packages/schema/src/session-event.ts`).
 * ttft = text.started 1250 - step.started 1100 = 150 ms
 * stepLatency = step.ended 1600 - step.started 1100 = 500 ms
 * timeToFirstAction = tool.called 1300 - prompted 1000 = 300 ms
 */
const CONTRACT_EVENTS = [
  { type: "session.next.prompted", timestamp: 1000, sessionID: "ses_test" },
  { type: "session.next.step.started", timestamp: 1100, sessionID: "ses_test", assistantMessageID: "msg_1" },
  { type: "session.next.text.started", timestamp: 1250, sessionID: "ses_test", assistantMessageID: "msg_1" },
  {
    type: "session.next.tool.called",
    timestamp: 1300,
    sessionID: "ses_test",
    callID: "call_1",
    tool: "bash",
    input: { command: "bun test" },
  },
  { type: "session.next.tool.success", timestamp: 1500, sessionID: "ses_test", callID: "call_1", structured: { exit: 0 } },
  {
    type: "session.next.step.ended",
    timestamp: 1600,
    sessionID: "ses_test",
    assistantMessageID: "msg_1",
    finish: "stop",
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } },
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n")

/**
 * The V1 SSE capture shape actually written by the e2e collector under
 * `.tmp/e2e/logs/<run>/events.jsonl`: `{ t: epochSeconds, raw: "<json>" }`.
 * Mirrors the real ordering (message.updated -> step-start -> delta -> tool ->
 * step-finish) so the normalization is exercised the way real logs exercise it.
 */
const SSE_EVENTS = [
  {
    t: 1793257982.531,
    body: {
      type: "message.updated",
      properties: {
        sessionID: "ses_sse",
        info: { id: "msg_user", role: "user", sessionID: "ses_sse", time: { created: 1793257981531 } },
      },
    },
  },
  // Non-telemetry traffic in the same capture must be ignored, not reinterpreted.
  { t: 1793257982.75, body: { type: "plugin.added", properties: { id: "core/config-reference" } } },
  // The assistant message is created when the step's request is dispatched; the
  // step-start part below only appears when the response stream opens.
  {
    t: 1793258020.05,
    body: {
      type: "message.updated",
      properties: {
        sessionID: "ses_sse",
        info: { id: "msg_assistant", role: "assistant", sessionID: "ses_sse", time: { created: 1793258020000 } },
      },
    },
  },
  {
    t: 1793258023.081,
    body: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_sse",
        part: { type: "step-start", messageID: "msg_assistant", sessionID: "ses_sse" },
        time: 1793258023081,
      },
    },
  },
  {
    t: 1793258023.125,
    body: {
      type: "message.part.delta",
      properties: { sessionID: "ses_sse", messageID: "msg_assistant", partID: "prt_1", field: "text", delta: "The" },
    },
  },
  {
    t: 1793258024.001,
    body: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_sse",
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: { status: "running", input: { command: "bun test" }, time: { start: 1793258024000 } },
        },
        time: 1793258024001,
      },
    },
  },
  {
    t: 1793258025.101,
    body: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_sse",
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: {
            status: "completed",
            input: { command: "bun test" },
            output: "ok",
            metadata: { output: "ok", status: "completed", exit: 0 },
            time: { start: 1793258024000, end: 1793258025100 },
          },
        },
        time: 1793258025101,
      },
    },
  },
  {
    t: 1793258025.3,
    body: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_sse",
        part: {
          type: "step-finish",
          messageID: "msg_assistant",
          reason: "tool-calls",
          tokens: { total: 110, input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
        time: 1793258025300,
      },
    },
  },
]
  .map((frame) => JSON.stringify({ t: frame.t, raw: JSON.stringify(frame.body), type: frame.body.type }))
  .join("\n")

describe("collectAnalytics: empty input", () => {
  test("yields UNKNOWN metrics with reasons and never throws", async () => {
    const { metrics, sources } = await collectAnalytics({})

    expect(sources.eventFiles).toBe(0)
    expect(sources.runDirs).toBe(0)
    expect(metrics.sources.events).toBe(0)
    expect(metrics.sources.sessions).toBe(0)
    expect(metrics.sources.runRecords).toBe(0)

    // No number may be manufactured when nothing was observed.
    expect(metrics.speed.ttft.status).toBe("unknown")
    expect(metrics.speed.ttft.median).toBeNull()
    expect(metrics.speed.stepLatency.status).toBe("unknown")
    expect(metrics.harness.verifiedTaskSuccessRate.status).toBe("unknown")
    expect(metrics.harness.verifiedTaskSuccessRate.value).toBeNull()
    expect(metrics.tokensCost.inputTokens.status).toBe("unknown")
    expect(metrics.toolLoop.toolCallSuccessRate.status).toBe("unknown")

    for (const reason of [metrics.speed.ttft.basis, metrics.harness.verifiedTaskSuccessRate.basis, metrics.tokensCost.inputTokens.basis]) {
      expect(reason.length).toBeGreaterThan(0)
    }
    expect(metrics.sources.notes).toContain("no session-event input supplied (--events)")
    expect(metrics.sources.notes).toContain("no run-record input supplied (--runs)")
  })

  test("unresolved paths are reported instead of guessed around", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "garbage.jsonl"), "this is not json\n")

    const { metrics, sources } = await collectAnalytics({
      eventFiles: ["/definitely-not-here/events.jsonl", path.join(tmp.path, "garbage.jsonl")],
      runDirs: [path.join(tmp.path, "missing-run-records")],
    })

    expect(sources.eventFiles).toBe(1)
    expect(sources.missing.some((entry) => entry.includes("definitely-not-here"))).toBe(true)
    expect(sources.missing.some((entry) => entry.includes("missing-run-records"))).toBe(true)
    expect(metrics.sources.events).toBe(0)
    expect(metrics.sources.malformedEvents).toBe(1)
    expect(metrics.sources.runDirMissing).toBe(true)
    expect(metrics.speed.ttft.status).toBe("unknown")
  })
})

describe("collectAnalytics: durable session-event jsonl", () => {
  test("one prompt + one step + one tool success yields measured ttft and step latency", async () => {
    await using tmp = await tmpdir()
    const logs = path.join(tmp.path, "logs")
    await mkdir(path.join(logs, "run-1"), { recursive: true })
    await writeFile(path.join(logs, "run-1", "events.jsonl"), CONTRACT_EVENTS)

    // A directory expands to the events.jsonl one level down.
    const { metrics, sources } = await collectAnalytics({ eventFiles: [logs] })

    expect(sources.eventFiles).toBe(1)
    expect(sources.formats).toEqual(["session-event-jsonl"])
    expect(metrics.sources.events).toBe(6)
    expect(metrics.sources.sessions).toBe(1)
    expect(metrics.sources.malformedEvents).toBe(0)

    expect(metrics.speed.ttft.status).toBe("measured")
    expect(metrics.speed.ttft.median).toBe(150)
    expect(metrics.speed.ttft.count).toBe(1)

    expect(metrics.speed.stepLatency.status).toBe("measured")
    expect(metrics.speed.stepLatency.median).toBe(500)

    expect(metrics.harness.timeToFirstAction.median).toBe(300)
    expect(metrics.toolLoop.toolCallSuccessRate.value).toBe(100)
    expect(metrics.toolLoop.commandExitCodes.status).toBe("measured")
    expect(metrics.toolLoop.commandExitCodes.counts).toEqual({ "0": 1 })
    expect(metrics.tokensCost.inputTokens.value).toBe(10)
  })
})

describe("collectAnalytics: real V1 SSE capture shape", () => {
  test("normalizes message.* projections into measured ttft, tools and step latency", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "events.jsonl"), SSE_EVENTS)

    const { metrics, sources } = await collectAnalytics({ eventFiles: [path.join(tmp.path, "events.jsonl")] })

    expect(sources.formats).toEqual(["sse-envelope-jsonl"])
    expect(metrics.sources.events).toBe(6)
    expect(metrics.sources.sessions).toBe(1)

    // step start = dispatch 1793258020000 (assistant message created),
    // ttft = first text delta (envelope t) 1793258023125 - dispatch = 3125 ms
    expect(metrics.speed.ttft.status).toBe("measured")
    expect(metrics.speed.ttft.median).toBe(3125)
    // step latency = step-finish time 1793258025300 - dispatch 1793258020000
    expect(metrics.speed.stepLatency.median).toBe(5300)

    expect(metrics.harness.timeToFirstAction.median).toBe(42469)
    expect(metrics.toolLoop.toolCallSuccessRate.value).toBe(100)
    expect(metrics.toolLoop.commandExitCodes.counts).toEqual({ "0": 1 })
    expect(metrics.tokensCost.inputTokens.value).toBe(100)
  })
})

describe("collectAnalytics: run records", () => {
  test("counts run-record files and derives task outcomes", async () => {
    await using tmp = await tmpdir()
    const runs = path.join(tmp.path, "run-records")
    await mkdir(runs, { recursive: true })
    await writeFile(path.join(runs, "task-1.json"), JSON.stringify({ task_id: "task_1", verified_success: true, duration_ms: 1000 }))
    await writeFile(
      path.join(runs, "task-2.json"),
      JSON.stringify({ task_id: "task_2", verified_success: false, duration_ms: 2000, tool_errors: 2 }),
    )

    const { metrics, sources } = await collectAnalytics({ runDirs: [runs] })

    expect(sources.runDirs).toBe(1)
    expect(metrics.sources.runFiles).toBe(2)
    expect(metrics.sources.runRecords).toBe(2)
    expect(metrics.sources.malformedRunRecords).toBe(0)

    expect(metrics.harness.verifiedTaskSuccessRate.status).toBe("measured")
    expect(metrics.harness.verifiedTaskSuccessRate.value).toBe(50)
    // `summarize` uses nearest-rank percentiles, no interpolation: [1000, 2000] -> median 1000, p95 2000.
    expect(metrics.harness.taskCompletionTime.median).toBe(1000)
    expect(metrics.harness.taskCompletionTime.p95).toBe(2000)
    // No session events were supplied: event-derived speed stays UNKNOWN.
    expect(metrics.speed.ttft.status).toBe("unknown")
  })
})
