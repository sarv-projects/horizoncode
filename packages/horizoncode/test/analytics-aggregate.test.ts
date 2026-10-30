import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { aggregate } from "../src/analytics/aggregate"
import { parseEventsJsonl } from "../src/analytics/events"
import { loadRunRecordsDir } from "../src/analytics/run-records"
import { checkModelIdentity } from "../src/analytics/model-guard"

const FIXTURES = `${import.meta.dir}/../../../scripts/eval/metrics-fixtures`
const PIN = "openrouter/nemotron-3-super-120b-a12b"

function fixtureInputs() {
  const parsed = parseEventsJsonl(readFileSync(`${FIXTURES}/sample_events.jsonl`, "utf8"))
  const runs = loadRunRecordsDir(`${FIXTURES}/sample_runs`)
  return { parsed, runs }
}

describe("aggregate: honesty on empty inputs", () => {
  test("every metric is UNKNOWN with a reason and no fabricated numbers", () => {
    const metrics = aggregate({})
    expect(metrics.sources.events).toBe(0)
    expect(metrics.sources.runRecords).toBe(0)

    const scalars = [
      metrics.harness.verifiedTaskSuccessRate,
      metrics.harness.regressionFreeSuccessRate,
      metrics.harness.toolCallSuccessRate,
      metrics.harness.recoveryRate,
      metrics.harness.crashTimeoutRate,
      metrics.harness.reproducibility,
      metrics.harness.safetyViolationsBlocked,
      metrics.speed.modelTimeMs,
      metrics.speed.toolTimeMs,
      metrics.tokensCost.inputTokens,
      metrics.tokensCost.outputTokens,
      metrics.tokensCost.retryTokenOverhead,
      metrics.toolLoop.invalidToolArgs,
      metrics.toolLoop.cancellationResponsiveness,
      metrics.reliability.finishNormallyRate,
      metrics.reliability.approvalBypassAttempts,
      metrics.reliability.secretsInLogsDetected,
      metrics.reliability.patchInspectableRate,
      metrics.reliability.verificationCompletesRate,
      metrics.reliability.resumeAfterInterruptRate,
      metrics.reliability.modelIdentityViolations,
    ]
    for (const metric of scalars) {
      expect(metric.status).toBe("unknown")
      expect(metric.value).toBeNull()
      expect(metric.basis.length).toBeGreaterThan(0)
    }

    const distributions = [
      metrics.harness.taskCompletionTime,
      metrics.harness.timeToFirstAction,
      metrics.harness.modelLatency,
      metrics.harness.tokensPerTask,
      metrics.harness.costPerSuccessfulTask,
      metrics.speed.ttft,
      metrics.speed.timeToFirstUsefulAction,
      metrics.speed.timeToFirstPatch,
      metrics.speed.totalToVerifiedSuccess,
      metrics.speed.idleTimeMs,
      metrics.tokensCost.contextUtilization,
      metrics.toolLoop.testsTriggeredPerTask,
      metrics.toolLoop.turnsUntilVerifiedSuccess,
      metrics.reliability.passAt1,
    ]
    for (const metric of distributions) {
      expect(metric.status).toBe("unknown")
      expect(metric.median).toBeNull()
      expect(metric.p95).toBeNull()
      expect(metric.count).toBe(0)
    }
    expect(metrics.toolLoop.commandExitCodes.status).toBe("unknown")
    expect(metrics.failures.classifications.length).toBe(0)
    expect(metrics.sources.notes).toContain("no session-event input supplied (--events)")
    expect(metrics.sources.notes).toContain("no run-record input supplied (--runs)")
  })

  test("events without run records still yield speed metrics but UNKNOWN success rate", () => {
    const { parsed } = fixtureInputs()
    const metrics = aggregate({ parsed, runs: null })
    expect(metrics.harness.verifiedTaskSuccessRate.status).toBe("unknown")
    expect(metrics.speed.ttft.status).toBe("measured")
    expect(metrics.speed.ttft.median).toBe(300)
    expect(metrics.speed.ttft.p95).toBe(400)
    expect(metrics.sources.notes).toContain("no run-record input supplied (--runs)")
  })
})

describe("aggregate: strict token/cost coverage", () => {
  const started = (t: number, msg: string) =>
    JSON.stringify({
      type: "session.next.step.started",
      timestamp: 1000 + t,
      sessionID: "ses_1",
      assistantMessageID: msg,
      agent: "build",
      model: { id: "nemotron-3-super-120b-a12b", providerID: "openrouter" },
    })
  const ended = (t: number, msg: string, tokens?: Record<string, unknown>) =>
    JSON.stringify({
      type: "session.next.step.ended",
      timestamp: 1000 + t,
      sessionID: "ses_1",
      assistantMessageID: msg,
      finish: "stop",
      ...(tokens ? { tokens } : {}),
    })

  test("partial usage coverage yields UNKNOWN totals, never a partial sum", () => {
    const text = [
      started(0, "msg_1"),
      ended(100, "msg_1", { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } }),
      started(200, "msg_2"),
      ended(300, "msg_2", { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }),
      started(400, "msg_3"),
      ended(500, "msg_3"),
    ].join("\n")
    const metrics = aggregate({ parsed: parseEventsJsonl(text) })
    expect(metrics.tokensCost.inputTokens.status).toBe("unknown")
    expect(metrics.tokensCost.inputTokens.value).toBeNull()
    expect(metrics.tokensCost.inputTokens.basis).toContain("partial coverage 2/3")
  })

  test("full usage coverage yields the measured total", () => {
    const text = [
      started(0, "msg_1"),
      ended(100, "msg_1", { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } }),
      started(200, "msg_2"),
      ended(300, "msg_2", { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }),
    ].join("\n")
    const metrics = aggregate({ parsed: parseEventsJsonl(text) })
    expect(metrics.tokensCost.inputTokens.status).toBe("measured")
    expect(metrics.tokensCost.inputTokens.value).toBe(150)
    expect(metrics.tokensCost.outputTokens.value).toBe(15)
    expect(metrics.tokensCost.cacheReadTokens.value).toBe(5)
  })
})

describe("aggregate: fixture telemetry (synthetic sample)", () => {
  const { parsed, runs } = fixtureInputs()
  const guard = checkModelIdentity({ pinned: PIN, events: parsed.events, runRecords: runs.records })
  const metrics = aggregate({ parsed, runs, options: { guard } })

  test("sources report data-quality counts", () => {
    expect(metrics.sources.events).toBe(39)
    expect(metrics.sources.sessions).toBe(2)
    expect(metrics.sources.malformedEvents).toBe(1)
    expect(metrics.sources.unknownEventTypes).toBe(1)
    expect(metrics.sources.eventsWithoutSession).toBe(1)
    expect(metrics.sources.runRecords).toBe(7)
    expect(metrics.sources.malformedRunRecords).toBe(1)
  })

  test("harness family: median + p95 over run records", () => {
    expect(metrics.harness.verifiedTaskSuccessRate.status).toBe("measured")
    expect(metrics.harness.verifiedTaskSuccessRate.value).toBeCloseTo((2 / 7) * 100, 9)
    expect(metrics.harness.taskCompletionTime.median).toBe(71000)
    expect(metrics.harness.taskCompletionTime.p95).toBe(300000)
    expect(metrics.harness.taskCompletionTime.count).toBe(7)
    expect(metrics.harness.regressionFreeSuccessRate.value).toBe(100)
    expect(metrics.harness.crashTimeoutRate.value).toBeCloseTo((1 / 7) * 100, 9)
    expect(metrics.harness.reproducibility.status).toBe("measured")
    expect(metrics.harness.reproducibility.value).toBe(0)
    expect(metrics.harness.safetyViolationsBlocked.status).toBe("estimated")
    expect(metrics.harness.safetyViolationsBlocked.value).toBe(3)
  })

  test("harness family: event-derived distributions", () => {
    expect(metrics.harness.timeToFirstAction.median).toBe(900)
    expect(metrics.harness.timeToFirstAction.p95).toBe(1000)
    expect(metrics.harness.modelLatency.median).toBe(1400)
    expect(metrics.harness.modelLatency.p95).toBe(1600)
    expect(metrics.harness.toolCallSuccessRate.value).toBe(50)
    expect(metrics.harness.toolCallSuccessRate.samples).toBe(6)
    expect(metrics.harness.recoveryRate.value).toBeCloseTo((1 / 3) * 100, 9)
    expect(metrics.harness.tokensPerTask.median).toBe(6950)
    expect(metrics.harness.tokensPerTask.p95).toBe(9320)
    expect(metrics.harness.tokensPerTask.count).toBe(5)
    expect(metrics.harness.tokensPerTask.basis).toContain("5/7")
    expect(metrics.harness.costPerSuccessfulTask.median).toBeCloseTo(0.0142, 6)
    expect(metrics.harness.costPerSuccessfulTask.count).toBe(2)
  })

  test("speed timeline", () => {
    expect(metrics.speed.ttft.median).toBe(300)
    expect(metrics.speed.ttft.p95).toBe(400)
    expect(metrics.speed.timeToFirstUsefulAction.median).toBe(1000)
    expect(metrics.speed.timeToFirstUsefulAction.p95).toBe(2900)
    expect(metrics.speed.modelTimeMs.value).toBe(6350)
    expect(metrics.speed.toolTimeMs.value).toBe(1900)
    expect(metrics.speed.timeToFirstPatch.median).toBe(2000)
    expect(metrics.speed.timeToFirstPassingTest.median).toBe(1800)
    expect(metrics.speed.totalToVerifiedSuccess.median).toBe(42000)
    expect(metrics.speed.totalToVerifiedSuccess.p95).toBe(64000)
    expect(metrics.speed.idleTimeMs.median).toBe(260)
    expect(metrics.speed.idleTimeMs.p95).toBe(1100)
  })

  test("tokens and cost", () => {
    // One fixture step reports no usage: totals stay UNKNOWN (partial coverage).
    expect(metrics.tokensCost.inputTokens.status).toBe("unknown")
    expect(metrics.tokensCost.inputTokens.value).toBeNull()
    expect(metrics.tokensCost.inputTokens.basis).toContain("4/5")
    expect(metrics.tokensCost.retryCount.value).toBe(1)
    expect(metrics.tokensCost.retryTokenOverhead.status).toBe("unknown")
    expect(metrics.tokensCost.contextIncludedTokens.median).toBe(3500)
    expect(metrics.tokensCost.contextIncludedTokens.p95).toBe(5200)
    expect(metrics.tokensCost.requestBytes.median).toBe(39000)
    expect(metrics.tokensCost.contextUtilization.status).toBe("unknown")
    expect(metrics.tokensCost.compactionsPerSession.median).toBe(0)
    expect(metrics.tokensCost.compactionsPerSession.p95).toBe(1)
    expect(metrics.tokensCost.costPerTask.count).toBe(7)
    expect(metrics.tokensCost.costPerTask.median).toBeCloseTo(0.0201, 6)
    expect(metrics.tokensCost.costPerTask.p95).toBeCloseTo(0.041, 6)
    expect(metrics.tokensCost.tokensPerSuccessfulTask.median).toBe(6950)
    expect(metrics.tokensCost.costPerVerifiedSolve.count).toBe(2)
  })

  test("context utilization becomes measurable only with an explicit model window", () => {
    const withWindow = aggregate({ parsed, runs, options: { modelWindowTokens: 262144 } })
    expect(withWindow.tokensCost.contextUtilization.status).toBe("measured")
    expect(withWindow.tokensCost.contextUtilization.median).toBeCloseTo((3500 / 262144) * 100, 6)
    expect(withWindow.tokensCost.contextUtilization.p95).toBeCloseTo((5200 / 262144) * 100, 6)
  })

  test("tool loop", () => {
    expect(metrics.toolLoop.invalidToolArgs.value).toBe(2)
    expect(metrics.toolLoop.commandExitCodes.status).toBe("measured")
    expect(metrics.toolLoop.commandExitCodes.counts).toEqual({ "0": 1 })
    expect(metrics.toolLoop.commandExitCodes.shellCalls).toBe(2)
    expect(metrics.toolLoop.fileOpFailureRate.value).toBeCloseTo((2 / 3) * 100, 9)
    expect(metrics.toolLoop.patchApplyFailureRate.status).toBe("unknown")
    expect(metrics.toolLoop.duplicateCalls.value).toBe(1)
    expect(metrics.toolLoop.noProgressLoops.value).toBe(1)
    expect(metrics.toolLoop.recoveryAfterError.value).toBe(100)
    expect(metrics.toolLoop.testsTriggeredPerTask.count).toBe(7)
    expect(metrics.toolLoop.testsTriggeredPerTask.median).toBe(1)
    expect(metrics.toolLoop.testsTriggeredPerSession.median).toBe(0)
    expect(metrics.toolLoop.testsTriggeredPerSession.p95).toBe(1)
    expect(metrics.toolLoop.turnsUntilFirstToolSuccess.median).toBe(1)
    expect(metrics.toolLoop.turnsUntilVerifiedSuccess.median).toBe(6)
    expect(metrics.toolLoop.turnsUntilVerifiedSuccess.p95).toBe(11)
    expect(metrics.toolLoop.cancellationResponsiveness.status).toBe("unknown")
  })

  test("reliability and safety", () => {
    expect(metrics.reliability.finishNormallyRate.value).toBe(100)
    expect(metrics.reliability.finishNormallyRate.samples).toBe(5)
    expect(metrics.reliability.passAt1.median).toBe(50)
    expect(metrics.reliability.passAt1.count).toBe(1)
    expect(metrics.reliability.blockedUnauthorizedWrites.status).toBe("estimated")
    expect(metrics.reliability.blockedUnauthorizedWrites.value).toBe(1)
    expect(metrics.reliability.blockedDestructiveCommands.status).toBe("estimated")
    expect(metrics.reliability.blockedDestructiveCommands.value).toBe(1)
    expect(metrics.reliability.approvalBypassAttempts.status).toBe("unknown")
    expect(metrics.reliability.secretsInLogsDetected.status).toBe("unknown")
    expect(metrics.reliability.patchInspectableRate.status).toBe("unknown")
    expect(metrics.reliability.verificationCompletesRate.status).toBe("unknown")
    expect(metrics.reliability.resumeAfterInterruptRate.status).toBe("unknown")
    // 2 mismatches + 1 switch event counted as safety/validity failures.
    expect(metrics.reliability.modelIdentityViolations.value).toBe(4)
    expect(metrics.reliability.modelIdentityViolations.status).toBe("measured")
  })

  test("failure classification consumes Lead 4 categories and derives the rest", () => {
    expect(metrics.failures.classified).toBe(5)
    expect(metrics.failures.unclassified).toBe(2)
    expect(metrics.failures.primaryCounts.harness).toBe(1)
    expect(metrics.failures.primaryCounts.verification).toBe(2)
    expect(metrics.failures.primaryCounts.infrastructure).toBe(1)
    expect(metrics.failures.primaryCounts.model).toBe(1)
    expect(metrics.failures.primaryCounts.unknown).toBe(0)
    expect(metrics.failures.contributingCounts.tool_errors).toBe(2)
    expect(metrics.failures.contributingCounts.no_tool_errors).toBe(1)
    expect(metrics.failures.contributingCounts.invalid_tool_args).toBe(2)
    expect(metrics.failures.contributingCounts.provider_retries).toBe(2)
    expect(metrics.failures.contributingCounts.model_switch).toBe(2)
    const sources = new Set(metrics.failures.classifications.map((entry) => entry.source))
    expect(sources.has("run-record")).toBe(true)
    expect(sources.has("derived")).toBe(true)
  })
})
