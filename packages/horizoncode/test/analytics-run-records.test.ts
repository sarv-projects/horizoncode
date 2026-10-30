import { describe, expect, test } from "bun:test"
import { loadRunRecordsDir, loadRunRecordsFromTexts, parseRunRecord } from "../src/analytics/run-records"

describe("Lead 4 run-record parsing (consume only)", () => {
  test("strict-known fields parse; missing fields stay null (UNKNOWN), never zero", () => {
    const { record } = parseRunRecord("run.json", {
      task_id: "task-1",
      model_id: "nemotron-3-super-120b-a12b",
      verified_success: true,
      duration_ms: 1234,
      tool_errors: 0,
      failure_category: "verification",
    })
    expect(record).not.toBeNull()
    expect(record!.task_id).toBe("task-1")
    expect(record!.verified_success).toBe(true)
    expect(record!.duration_ms).toBe(1234)
    expect(record!.tool_errors).toBe(0)
    expect(record!.failure_category).toBe("verification")
    expect(record!.failure_category_valid).toBe(true)
    expect(record!.cost_usd).toBeNull()
    expect(record!.input_tokens).toBeNull()
    expect(record!.turns).toBeNull()
    expect(record!.regression_free).toBeNull()
  })

  test("tolerates camelCase variants", () => {
    const { record } = parseRunRecord("run.json", {
      taskId: "task-2",
      model: "gpt-5.6-luna",
      verifiedSuccess: false,
      durationMs: 99,
      toolErrors: 4,
      failureCategory: "harness",
      costUsd: 0.5,
      tokens: { input: 10, output: 20, cache_read: 5 },
    })
    expect(record!.task_id).toBe("task-2")
    expect(record!.model_id).toBe("gpt-5.6-luna")
    expect(record!.verified_success).toBe(false)
    expect(record!.tool_errors).toBe(4)
    expect(record!.failure_category).toBe("harness")
    expect(record!.cost_usd).toBe(0.5)
    expect(record!.input_tokens).toBe(10)
    expect(record!.output_tokens).toBe(20)
    expect(record!.cached_tokens).toBe(5)
  })

  test("missing task_id is malformed with an explicit reason", () => {
    const { record, reason } = parseRunRecord("bad.json", { verified_success: true })
    expect(record).toBeNull()
    expect(reason).toContain("task_id")
  })

  test("non-canonical failure_category is normalized to unknown, not trusted", () => {
    const { record } = parseRunRecord("run.json", { task_id: "t", failure_category: "banana" })
    expect(record!.failure_category).toBe("unknown")
    expect(record!.failure_category_valid).toBe(false)
  })

  test("batch loader counts files, records and malformed inputs", () => {
    const loaded = loadRunRecordsFromTexts([
      { file: "a.json", text: JSON.stringify({ task_id: "a" }) },
      { file: "b.json", text: "{broken" },
      { file: "c.json", text: JSON.stringify({ no: "task" }) },
    ])
    expect(loaded.files).toBe(3)
    expect(loaded.records.length).toBe(1)
    expect(loaded.malformed).toBe(2)
    expect(loaded.reasons.length).toBeGreaterThan(0)
  })

  test("missing directory reports missingDir instead of fabricating an empty success", () => {
    const loaded = loadRunRecordsDir(`${import.meta.dir}/definitely-not-a-real-directory-xyz`)
    expect(loaded.missingDir).toBe(true)
    expect(loaded.records.length).toBe(0)
    expect(loaded.reasons[0]).toContain("not found")
  })
})
