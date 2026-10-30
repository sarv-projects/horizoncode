import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { checkModelIdentity, modelsMatch, normalizeModelRef } from "../src/analytics/model-guard"
import { parseEventsJsonl } from "../src/analytics/events"
import { loadRunRecordsDir } from "../src/analytics/run-records"

const FIXTURES = `${import.meta.dir}/../../../scripts/eval/metrics-fixtures`
const fixtureEvents = () => parseEventsJsonl(readFileSync(`${FIXTURES}/sample_events.jsonl`, "utf8")).events
const fixtureRuns = () => loadRunRecordsDir(`${FIXTURES}/sample_runs`).records

describe("model reference normalization", () => {
  test("compares final path segments so provider prefixes do not mask identity", () => {
    expect(normalizeModelRef("openrouter/nvidia/nemotron-3-super-120b-a12b")).toBe("nemotron-3-super-120b-a12b")
    expect(modelsMatch("openrouter/nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-super-120b-a12b")).toBe(true)
    expect(modelsMatch("nemotron-3-super-120b-a12b", "openrouter/nemotron-3-super-120b-a12b")).toBe(true)
    expect(modelsMatch("nemotron-3-super", "nemotron-3-super-120b-a12b")).toBe(false)
    expect(modelsMatch("nemotron-3.5-super-vl:free", "nemotron-3.5-super-vl")).toBe(false)
  })
})

describe("model-identity guard", () => {
  test("fixture run trips on the switched model: step mismatch + switch event + record mismatch", () => {
    const guard = checkModelIdentity({
      pinned: "openrouter/nemotron-3-super-120b-a12b",
      events: fixtureEvents(),
      runRecords: fixtureRuns(),
    })
    expect(guard.pinMissing).toBe(false)
    expect(guard.checked).toBe(12) // 5 step.started models + 7 run records
    expect(guard.switches).toBe(1)
    expect(guard.mismatches.length).toBe(3)
    expect(guard.ok).toBe(false)
    const sources = guard.mismatches.map((mismatch) => mismatch.source)
    expect(sources).toContain("session.next.step.started")
    expect(sources).toContain("session.next.model.switched")
    expect(sources).toContain("run-record")
  })

  test("all-nemotron observations pass when pin matches", () => {
    const events = fixtureEvents().filter(
      (event) => event.type !== "session.next.model.switched" && event.type !== "session.next.step.started",
    )
    const steps = fixtureEvents().filter((event) => event.type === "session.next.step.started")
    const cleanSteps = steps.filter((event) => {
      const model = event.model as { id?: string } | undefined
      return model?.id === "nemotron-3-super-120b-a12b"
    })
    const guard = checkModelIdentity({ pinned: "nemotron-3-super-120b-a12b", events: [...events, ...cleanSteps] })
    expect(guard.switches).toBe(0)
    expect(guard.mismatches.length).toBe(0)
    expect(guard.ok).toBe(true)
  })

  test("run-record model mismatch alone fails the guard", () => {
    const guard = checkModelIdentity({
      pinned: "nemotron-3-super-120b-a12b",
      events: [],
      runRecords: [{ model_id: "openrouter/gpt-5.6-luna" } as never],
    })
    expect(guard.mismatches.length).toBe(1)
    expect(guard.mismatches[0]!.source).toBe("run-record")
    expect(guard.ok).toBe(false)
  })

  test("no pin => validity UNKNOWN (pinMissing), never a silent pass", () => {
    const guard = checkModelIdentity({ pinned: null, events: fixtureEvents(), runRecords: fixtureRuns() })
    expect(guard.pinMissing).toBe(true)
    expect(guard.ok).toBe(false)
    expect(guard.mismatches.length).toBe(0)
    expect(guard.switches).toBe(1) // switches still surfaced for visibility
  })
})
