import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { SessionEvent } from "@horizoncode/schema/session-event"
import { buildTraces, parseEventsJsonl, testCandidates, KNOWN_EVENT_TYPES } from "../src/analytics/events"
import { classifyCommand, extractExitCode, isFileMutatingTool, isShellTool, stableKey } from "../src/analytics/classify"

const EVENTS_FIXTURE = `${import.meta.dir}/../../../scripts/eval/metrics-fixtures/sample_events.jsonl`
const fixtureText = () => readFileSync(EVENTS_FIXTURE, "utf8")

describe("event JSONL parsing", () => {
  test("counts malformed lines, unknown types and session-less events", () => {
    const parsed = parseEventsJsonl(
      [
        '{"type":"session.next.step.started","timestamp":1,"sessionID":"ses_1"}',
        '{"type":"totally.unknown.event","timestamp":2,"sessionID":"ses_1"}',
        '{"type":"session.next.step.started","timestamp":3}',
        '{"nope":true}',
        "not json at all",
        '{"type":"session.next.step.started"}',
        "",
      ].join("\n"),
    )
    expect(parsed.lines).toBe(6)
    expect(parsed.events.length).toBe(3)
    expect(parsed.malformed).toBe(3)
    expect(parsed.unknownTypes).toBe(1)
    expect(parsed.withoutSession).toBe(1)
  })

  test("fixture parses with explicit data-quality counts", () => {
    const parsed = parseEventsJsonl(fixtureText())
    expect(parsed.lines).toBe(40)
    expect(parsed.events.length).toBe(39)
    expect(parsed.malformed).toBe(1)
    expect(parsed.unknownTypes).toBe(1)
    expect(parsed.withoutSession).toBe(1)
    expect(KNOWN_EVENT_TYPES.length).toBeGreaterThan(10)
  })

  test("canonical envelope {id,type,data} and flat exports both normalize", () => {
    const envelope = parseEventsJsonl(fixtureText())
    const first = envelope.events[0]!
    expect(first.type).toBe("session.next.prompted")
    expect(first.timestamp).toBe(1793000000000)
    expect(first.sessionID).toBe("ses_a1b2c3")
    expect(first.envelopeID).toBe("evt_sample0001")

    const flat = parseEventsJsonl(readFileSync(EVENTS_FIXTURE.replace("sample_events", "sample_events_flat"), "utf8"))
    expect(flat.events.length).toBe(envelope.events.length)
    expect(flat.events[0]!.type).toBe(first.type)
    expect(flat.events[0]!.sessionID).toBe(first.sessionID)
    expect((flat.events[0] as { envelopeID?: string }).envelopeID).toBeUndefined()
  })
})

describe("fixture events decode with the REAL session-event schemas", () => {
  const DECODERS: Record<string, unknown> = {
    "session.next.prompted": SessionEvent.Prompted,
    "session.next.step.started": SessionEvent.Step.Started,
    "session.next.step.ended": SessionEvent.Step.Ended,
    "session.next.text.started": SessionEvent.Text.Started,
    "session.next.tool.called": SessionEvent.Tool.Called,
    "session.next.tool.success": SessionEvent.Tool.Success,
    "session.next.tool.failed": SessionEvent.Tool.Failed,
    "session.next.shell.started": SessionEvent.Shell.Started,
    "session.next.shell.ended": SessionEvent.Shell.Ended,
    "session.next.retried": SessionEvent.Retried,
    "session.next.compaction.started": SessionEvent.Compaction.Started,
    "session.next.model.switched": SessionEvent.ModelSwitched,
  }

  test("every fixture event of a known type passes its contract schema", () => {
    // Decode the RAW canonical envelope lines ({id,type,data}) exactly as the
    // contract defines them, before the reader normalizes them.
    let decoded = 0
    for (const line of fixtureText().split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let raw: unknown
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
      const envelope = raw as Record<string, unknown>
      const data =
        envelope.data !== null && typeof envelope.data === "object" && !Array.isArray(envelope.data)
          ? (envelope.data as Record<string, unknown>)
          : null
      if (typeof envelope.type !== "string") continue
      const sessionID =
        typeof envelope.sessionID === "string"
          ? envelope.sessionID
          : data && typeof data.sessionID === "string"
            ? data.sessionID
            : null
      const decoder = DECODERS[envelope.type]
      if (!decoder || sessionID === null) continue
      const result = Schema.decodeUnknownSync(decoder as never)(raw)
      expect(result).toBeDefined()
      decoded++
    }
    // 35 = 40 lines − 1 garbage − 1 unknown type − 1 session-less − 2 ledger
    // events (ledger uses a heavier schema verified separately by its contract).
    expect(decoded).toBe(35)
  })
})

describe("trace reconstruction", () => {
  test("reconstructs the two fixture sessions with correct spans", () => {
    const parsed = parseEventsJsonl(fixtureText())
    const { traces, skippedNoSession } = buildTraces(parsed.events)
    expect(traces.length).toBe(2)
    expect(skippedNoSession).toBe(1)

    const sessionA = traces.find((trace) => trace.sessionID === "ses_a1b2c3")!
    const sessionB = traces.find((trace) => trace.sessionID === "ses_b4d5e6")!
    expect(sessionA.steps.length).toBe(2)
    expect(sessionB.steps.length).toBe(3)
    expect(sessionA.tools.length).toBe(2)
    expect(sessionB.tools.length).toBe(4)
    expect(sessionB.retries).toBe(1)
    expect(sessionB.compactions).toBe(1)
    expect(sessionB.modelSwitches.length).toBe(1)

    // TTFT per step: first text event minus step start.
    const ttfts = sessionA.steps.map((step) => step.firstTextAt! - step.start)
    expect(ttfts).toEqual([300, 300])

    // Usage provenance: the last fixture step reports cost but no tokens.
    const lastStep = sessionB.steps[sessionB.steps.length - 1]!
    expect(lastStep.cost).toBe(0.0005)
    expect(lastStep.tokens).toBeNull()
  })

  test("test candidates dedupe shell/tool pairs by call id", () => {
    const parsed = parseEventsJsonl(fixtureText())
    const { traces } = buildTraces(parsed.events)
    const sessionA = traces.find((trace) => trace.sessionID === "ses_a1b2c3")!
    const candidates = testCandidates(sessionA)
    expect(candidates.length).toBe(1)
    expect(candidates[0]!.passing).toBe(true)
    expect(candidates[0]!.command).toBe("bun test test/parser")
  })
})

describe("classification helpers", () => {
  test("command classes", () => {
    expect(classifyCommand("bun test test/parser")).toBe("test")
    expect(classifyCommand("go test ./...")).toBe("test")
    expect(classifyCommand("git apply fix.patch")).toBe("patch")
    expect(classifyCommand("ls -la")).toBe("other")
  })

  test("tool name helpers", () => {
    expect(isShellTool("bash")).toBe(true)
    expect(isShellTool("read")).toBe(false)
    expect(isFileMutatingTool("edit")).toBe(true)
    expect(isFileMutatingTool("read")).toBe(false)
  })

  test("exit codes read the shell tool's real structured key", () => {
    expect(extractExitCode({ exit: 2 })).toBe(2)
    expect(extractExitCode({ exitCode: "3" })).toBe(3)
    expect(extractExitCode({})).toBeNull()
    expect(extractExitCode(null)).toBeNull()
  })

  test("stable key is key-order independent", () => {
    expect(stableKey({ b: 1, a: [2, 3] })).toBe(stableKey({ a: [2, 3], b: 1 }))
  })
})
