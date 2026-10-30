import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { aggregate } from "../src/analytics/aggregate"
import { parseEventsJsonl } from "../src/analytics/events"
import { loadRunRecordsDir } from "../src/analytics/run-records"
import { checkModelIdentity } from "../src/analytics/model-guard"
import { renderDashboard } from "../src/analytics/render"

const FIXTURES = `${import.meta.dir}/../../../scripts/eval/metrics-fixtures`
const PIN = "openrouter/nemotron-3-super-120b-a12b"

describe("dashboard renderer", () => {
  test("empty inputs render a fully-UNKNOWN dashboard with a guard banner", () => {
    const output = renderDashboard(aggregate({}), { runsSource: ".tmp/nemotron-bench/runs" })
    expect(output).toContain("# HorizonCode Harness Performance Dashboard")
    expect(output).toContain("MODEL IDENTITY GUARD: **NOT EVALUATED**")
    expect(output).toContain("| Verified task success | UNKNOWN |")
    expect(output).toContain("## UNKNOWN metrics")
    expect(output).toContain("no session-event input supplied (--events)")
    expect(output).not.toContain("NaN")
    expect(output).not.toContain("[object Object]")
  })

  test("missing run directory is surfaced, not silently treated as zero records", () => {
    const runs = loadRunRecordsDir(`${import.meta.dir}/no-such-runs-dir`)
    const output = renderDashboard(aggregate({ runs }), {})
    expect(output).toContain("run records directory not found")
    expect(output).toContain("| Verified task success | UNKNOWN |")
  })

  test("no pin renders an explicit validity warning instead of a pass", () => {
    const parsed = parseEventsJsonl(readFileSync(`${FIXTURES}/sample_events.jsonl`, "utf8"))
    const guard = checkModelIdentity({ pinned: null, events: parsed.events })
    const output = renderDashboard(aggregate({ parsed, options: { guard } }), { guard })
    expect(output).toContain("[MODEL GUARD WARNING] MODEL IDENTITY GUARD: **NO PIN CONFIGURED**")
    expect(output).toContain("Model validity cannot be asserted")
  })

  test("fixture dashboard shows median AND p95, UNKNOWN markers and the model warning", () => {
    const parsed = parseEventsJsonl(readFileSync(`${FIXTURES}/sample_events.jsonl`, "utf8"))
    const runs = loadRunRecordsDir(`${FIXTURES}/sample_runs`)
    const guard = checkModelIdentity({ pinned: PIN, events: parsed.events, runRecords: runs.records })
    const metrics = aggregate({ parsed, runs, options: { guard } })
    const output = renderDashboard(metrics, { guard, eventsSource: "sample_events.jsonl", runsSource: `${FIXTURES}/sample_runs` })

    expect(output).toContain("[MODEL GUARD WARNING]")
    expect(output).toContain("model switch event(s) observed")
    expect(output).toContain("session.next.model.switched")
    expect(output).toContain("median")
    expect(output).toContain("p95")
    expect(output).toContain("| Task completion time | median 71,000 ms (71.00 s) | p95")
    expect(output).toContain("| TTFT (first token) | median 300 ms | p95 400 ms | 4 |")
    expect(output).toContain("**UNKNOWN**")
    expect(output).toContain("Retry token overhead")
    expect(output).toContain("Approval-bypass attempts")
    expect(output).toContain("| harness | 1 |")
    expect(output).toContain("| verification | 2 |")
    expect(output).toContain("Classified failures: 5 / 7 records")
    expect(output).not.toContain("NaN")
    expect(output).not.toContain("[object Object]")
  })

  test("a vacuous pass (pin set, zero observations) is reported as UNKNOWN, not OK", () => {
    const guard = checkModelIdentity({ pinned: "nemotron-3-super-120b-a12b", events: [], runRecords: [] })
    expect(guard.ok).toBe(true)
    const output = renderDashboard(aggregate({}), { guard })
    expect(output).toContain("**NO OBSERVATIONS — validity UNKNOWN**")
    expect(output).not.toContain("MODEL IDENTITY GUARD: OK")
  })

  test("--strict-guard semantics: guard failure is counted and reported", () => {
    const parsed = parseEventsJsonl(readFileSync(`${FIXTURES}/sample_events.jsonl`, "utf8"))
    const runs = loadRunRecordsDir(`${FIXTURES}/sample_runs`)
    const guard = checkModelIdentity({ pinned: PIN, events: parsed.events, runRecords: runs.records })
    expect(guard.ok).toBe(false)
    const metrics = aggregate({ parsed, runs, options: { guard } })
    expect(metrics.reliability.modelIdentityViolations.value).toBe(4)
  })
})
