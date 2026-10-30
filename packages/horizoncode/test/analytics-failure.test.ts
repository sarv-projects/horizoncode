import { describe, expect, test } from "bun:test"
import { classifyFailure } from "../src/analytics/failure-category"
import type { RunRecord } from "../src/analytics/run-records"

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    file: "run.json",
    task_id: "task-1",
    model_id: "nemotron-3-super-120b-a12b",
    verified_success: false,
    duration_ms: 1000,
    tool_errors: 0,
    failure_category: null,
    failure_category_valid: false,
    session_id: null,
    turns: null,
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    cost_usd: null,
    regression_free: null,
    raw: {},
    ...overrides,
  }
}

describe("failure classification", () => {
  test("verified successes have no failure to classify", () => {
    expect(classifyFailure(record({ verified_success: true }))).toBeNull()
  })

  test("a canonical run-record category is consumed as primary (Lead 4 alignment)", () => {
    const result = classifyFailure(record({ failure_category: "budget", failure_category_valid: true }), {
      errorMessages: ["segfault in worker"],
    })
    expect(result!.failure_category).toBe("budget")
    expect(result!.source).toBe("run-record")
    expect(result!.task_id).toBe("task-1")
    expect(result!.model_id).toBe("nemotron-3-super-120b-a12b")
    expect(result!.verified_success).toBe(false)
    expect(result!.duration_ms).toBe(1000)
    expect(result!.tool_errors).toBe(0)
    expect(result!.contributing).toContain("timeout_or_crash")
  })

  test("an invalid recorded category is downgraded to unknown, flagged record-invalid", () => {
    const result = classifyFailure(record({ failure_category: "unknown", failure_category_valid: false }))
    expect(result!.failure_category).toBe("unknown")
    expect(result!.source).toBe("record-invalid")
  })

  test("derived categories from trace messages", () => {
    expect(classifyFailure(record(), { errorMessages: ["worker segfault"] })!.failure_category).toBe("infrastructure")
    expect(classifyFailure(record(), { errorMessages: ["command not found: pytest"] })!.failure_category).toBe("environment")
    expect(classifyFailure(record(), { errorMessages: ["AssertionError: tests failed"] })!.failure_category).toBe("verification")
    expect(classifyFailure(record(), { errorMessages: ["context length exceeded for request"] })!.failure_category).toBe("budget")
    expect(classifyFailure(record(), { errorMessages: ["invalid arguments: filePath missing"] })!.failure_category).toBe("harness")
    expect(classifyFailure(record(), { errorMessages: ["provider error: malformed json"] })!.failure_category).toBe("model")
  })

  test("fallbacks: tool errors => harness, clean failure => verification, nothing => unknown", () => {
    const withErrors = classifyFailure(record({ tool_errors: 5 }))
    expect(withErrors!.failure_category).toBe("harness")
    expect(withErrors!.contributing).toContain("tool_errors")

    const clean = classifyFailure(record({ verified_success: false, tool_errors: 0 }))
    expect(clean!.failure_category).toBe("verification")
    expect(clean!.contributing).toContain("no_tool_errors")

    const unknown = classifyFailure(record({ verified_success: null, tool_errors: null }))
    expect(unknown!.failure_category).toBe("unknown")
    expect(unknown!.contributing).toContain("success-unknown")
  })

  test("duration at/over the task ceiling without other signals derives budget exhaustion", () => {
    const result = classifyFailure(record({ duration_ms: 600_000, failure_category: null }), { timeoutMs: 300_000 })
    expect(result!.failure_category).toBe("budget")
    expect(result!.contributing).toContain("budget_exhausted")
  })

  test("contributing causes accumulate multiple signals", () => {
    const result = classifyFailure(record({ tool_errors: 3, failure_category: "harness", failure_category_valid: true }), {
      errorMessages: ["invalid arguments: oldString did not match"],
      retries: 2,
      modelSwitch: true,
    })
    expect(result!.failure_category).toBe("harness")
    expect(result!.contributing).toEqual(expect.arrayContaining(["tool_errors", "provider_retries", "model_switch", "invalid_tool_args"]))
  })
})
