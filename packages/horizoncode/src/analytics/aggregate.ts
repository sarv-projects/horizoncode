/**
 * Aggregation over REAL session telemetry (packages/schema session events) and
 * Lead 4's per-task run records.
 *
 * Honesty rules enforced here:
 *  - distributions always expose median AND p95 (never an average-only view);
 *  - a metric with no observations is `unknown` with value null and a reason;
 *  - summed totals (tokens, cost) require FULL coverage of the samples they
 *    sum — partial coverage yields UNKNOWN instead of a fabricated partial total;
 *  - pattern-derived safety counts are `estimated`, never `measured`.
 */

import { summarize } from "./percentile"
import { measured, estimated, unknownValue, unknownDistribution, measuredDistribution } from "./types"
import type { MetricValue, MetricDistribution } from "./types"
import { buildTraces, testCandidates } from "./events"
import type { ParsedEvents, SessionTrace, WireEvent } from "./events"
import {
  extractExitCode,
  isDestructiveCommand,
  isFileMutatingTool,
  isInvalidArgsMessage,
  isPatchTool,
  isShellTool,
  isUnsafeDenialMessage,
  stableKey,
} from "./classify"
import type { LoadedRuns, RunRecord } from "./run-records"
import { classifyFailure } from "./failure-category"
import type { FailureCategory, FailureClassification } from "./failure-category"
import type { ModelGuardReport } from "./model-guard"

export interface AggregateOptions {
  /** Model context window (tokens) when known; context utilization stays UNKNOWN without it. */
  readonly modelWindowTokens?: number | null
  /** Task wall-time ceiling used to flag budget exhaustion in derived classifications. */
  readonly timeoutMs?: number | null
  /** Pre-computed model guard; injected so guard violations count as safety/validity failures. */
  readonly guard?: ModelGuardReport | null
}

export interface SourceSummary {
  readonly events: number
  readonly sessions: number
  readonly malformedEvents: number
  readonly unknownEventTypes: number
  readonly eventsWithoutSession: number
  readonly runFiles: number
  readonly runRecords: number
  readonly malformedRunRecords: number
  readonly runDirMissing: boolean
  readonly notes: readonly string[]
}

export interface ExitCodeDistribution {
  readonly status: MetricValue["status"]
  readonly counts: Record<string, number>
  readonly reported: number
  readonly shellCalls: number
  readonly basis: string
}

export interface HarnessFamily {
  verifiedTaskSuccessRate: MetricValue
  regressionFreeSuccessRate: MetricValue
  taskCompletionTime: MetricDistribution
  timeToFirstAction: MetricDistribution
  modelLatency: MetricDistribution
  tokensPerTask: MetricDistribution
  costPerSuccessfulTask: MetricDistribution
  toolCallSuccessRate: MetricValue
  recoveryRate: MetricValue
  crashTimeoutRate: MetricValue
  reproducibility: MetricValue
  safetyViolationsBlocked: MetricValue
}

export interface SpeedFamily {
  ttft: MetricDistribution
  timeToFirstUsefulAction: MetricDistribution
  modelTimeMs: MetricValue
  toolTimeMs: MetricValue
  timeToFirstPatch: MetricDistribution
  timeToFirstPassingTest: MetricDistribution
  totalToVerifiedSuccess: MetricDistribution
  idleTimeMs: MetricDistribution
  stepLatency: MetricDistribution
}

export interface TokensCostFamily {
  inputTokens: MetricValue
  outputTokens: MetricValue
  reasoningTokens: MetricValue
  cacheReadTokens: MetricValue
  cacheWriteTokens: MetricValue
  tokensPerSuccessfulTask: MetricDistribution
  retryCount: MetricValue
  retryTokenOverhead: MetricValue
  contextIncludedTokens: MetricDistribution
  requestBytes: MetricDistribution
  contextUtilization: MetricDistribution
  compactionsPerSession: MetricDistribution
  costPerTask: MetricDistribution
  costPerVerifiedSolve: MetricDistribution
}

export interface ToolLoopFamily {
  toolCallSuccessRate: MetricValue
  invalidToolArgs: MetricValue
  commandExitCodes: ExitCodeDistribution
  fileOpFailureRate: MetricValue
  patchApplyFailureRate: MetricValue
  duplicateCalls: MetricValue
  noProgressLoops: MetricValue
  recoveryAfterError: MetricValue
  testsTriggeredPerTask: MetricDistribution
  testsTriggeredPerSession: MetricDistribution
  turnsUntilFirstToolSuccess: MetricDistribution
  turnsUntilVerifiedSuccess: MetricDistribution
  cancellationResponsiveness: MetricValue
}

export interface ReliabilityFamily {
  finishNormallyRate: MetricValue
  patchInspectableRate: MetricValue
  verificationCompletesRate: MetricValue
  resumeAfterInterruptRate: MetricValue
  passAt1: MetricDistribution
  blockedUnauthorizedWrites: MetricValue
  blockedDestructiveCommands: MetricValue
  approvalBypassAttempts: MetricValue
  secretsInLogsDetected: MetricValue
  blockedUnsafeAttempts: MetricValue
  modelIdentityViolations: MetricValue
}

export interface FailureSummary {
  readonly classifications: readonly FailureClassification[]
  readonly primaryCounts: Record<FailureCategory, number>
  readonly contributingCounts: Record<string, number>
  readonly classified: number
  readonly unclassified: number
}

export interface AggregatedMetrics {
  readonly generatedAt: string
  readonly sources: SourceSummary
  readonly harness: HarnessFamily
  readonly speed: SpeedFamily
  readonly tokensCost: TokensCostFamily
  readonly toolLoop: ToolLoopFamily
  readonly reliability: ReliabilityFamily
  readonly failures: FailureSummary
}

const NORMAL_FINISH = new Set(["stop", "tool-calls", "tool_calls", "end_turn"])

function rate(numerator: number, denominator: number, unit: string, basis: string): MetricValue {
  if (denominator <= 0) return unknownValue(unit, `${basis}: no observations`)
  return measured((numerator / denominator) * 100, unit, basis, denominator)
}

function dist(values: readonly number[], unit: string, basis: string): MetricDistribution {
  const summary = summarize(values)
  if (!summary) return unknownDistribution(unit, basis)
  return measuredDistribution(summary, unit, basis)
}

function coverage(values: number[], total: number): string {
  return values.length === total ? `${total} samples` : `partial coverage: ${values.length}/${total} reported`
}

function promptAnchor(trace: SessionTrace): number | null {
  return trace.promptTimes.length > 0 ? trace.promptTimes[0]! : null
}

function nonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function push(list: number[], value: number | null | undefined): void {
  if (value !== null && value !== undefined && Number.isFinite(value)) list.push(value)
}

interface EventStats {
  ttft: number[]
  firstAction: number[]
  firstUseful: number[]
  firstPatch: number[]
  firstPassingTest: number[]
  stepLatency: number[]
  modelTimeMs: number
  toolTimeMs: number
  idle: number[]
  toolOk: number
  toolFail: number
  invalidArgs: number
  exitCounts: Record<string, number>
  exitReported: number
  shellCalls: number
  fileOps: number
  fileOpFail: number
  patchCalls: number
  patchFail: number
  duplicates: number
  noProgressLoops: number
  sessionsWithFailures: number
  recoveredSessions: number
  testsPerSession: number[]
  turnsToFirstSuccess: number[]
  compactionsPerSession: number[]
  contextTokens: number[]
  requestBytes: number[]
  contextUtilization: number[]
  finishes: number
  normalFinishes: number
  blockedUnsafe: number
  blockedDestructive: number
  blockedUnauthorizedWrites: number
  sessions: number
  retries: number
  modelSwitches: number
}

function computeEventStats(traces: readonly SessionTrace[], modelWindowTokens: number | null | undefined): EventStats {
  const stats: EventStats = {
    ttft: [],
    firstAction: [],
    firstUseful: [],
    firstPatch: [],
    firstPassingTest: [],
    stepLatency: [],
    modelTimeMs: 0,
    toolTimeMs: 0,
    idle: [],
    toolOk: 0,
    toolFail: 0,
    invalidArgs: 0,
    exitCounts: {},
    exitReported: 0,
    shellCalls: 0,
    fileOps: 0,
    fileOpFail: 0,
    patchCalls: 0,
    patchFail: 0,
    duplicates: 0,
    noProgressLoops: 0,
    sessionsWithFailures: 0,
    recoveredSessions: 0,
    testsPerSession: [],
    turnsToFirstSuccess: [],
    compactionsPerSession: [],
    contextTokens: [],
    requestBytes: [],
    contextUtilization: [],
    finishes: 0,
    normalFinishes: 0,
    blockedUnsafe: 0,
    blockedDestructive: 0,
    blockedUnauthorizedWrites: 0,
    sessions: traces.length,
    retries: 0,
    modelSwitches: 0,
  }

  for (const trace of traces) {
    const anchor = promptAnchor(trace)

    for (const step of trace.steps) {
      if (step.firstTextAt !== null) push(stats.ttft, nonNegative(step.firstTextAt - step.start))
      if (step.end !== null) {
        const duration = nonNegative(step.end - step.start)
        if (duration !== null) {
          stats.stepLatency.push(duration)
          stats.modelTimeMs += duration
        }
      }
      if (step.finish !== null) {
        stats.finishes++
        if (NORMAL_FINISH.has(step.finish)) stats.normalFinishes++
      }
    }

    const orderedTools = [...trace.tools].sort((a, b) => a.start - b.start)
    const keyCounts = new Map<string, { total: number; failures: number }>()
    for (const tool of orderedTools) {
      const duration = tool.end !== null ? nonNegative(tool.end - tool.start) : null
      if (duration !== null) stats.toolTimeMs += duration

      if (tool.ok === true) stats.toolOk++
      else if (tool.ok === false) {
        stats.toolFail++
        if (tool.error) {
          if (isInvalidArgsMessage(tool.error)) stats.invalidArgs++
          if (isUnsafeDenialMessage(tool.error)) stats.blockedUnauthorizedWrites++
        }
      }

      const key = `${tool.tool}:${stableKey(tool.input ?? null)}`
      const entry = keyCounts.get(key) ?? { total: 0, failures: 0 }
      entry.total++
      if (tool.ok === false) entry.failures++
      keyCounts.set(key, entry)

      if (isShellTool(tool.tool)) {
        stats.shellCalls++
        const exit = extractExitCode(tool.structured)
        if (exit !== null) {
          stats.exitReported++
          const bucket = String(exit)
          stats.exitCounts[bucket] = (stats.exitCounts[bucket] ?? 0) + 1
        }
        const command = tool.input && typeof tool.input.command === "string" ? tool.input.command : ""
        if (command && isDestructiveCommand(command) && tool.ok === false) stats.blockedDestructive++
      }
      if (isFileMutatingTool(tool.tool)) {
        stats.fileOps++
        if (tool.ok === false) stats.fileOpFail++
      }
      if (isPatchTool(tool.tool)) {
        stats.patchCalls++
        if (tool.ok === false) stats.patchFail++
      }
    }

    for (const entry of keyCounts.values()) {
      if (entry.total >= 2) stats.duplicates += entry.total - 1
      if (entry.failures >= 2) stats.noProgressLoops++
    }

    const firstTool = orderedTools[0]
    if (anchor !== null && firstTool) push(stats.firstAction, nonNegative(firstTool.start - anchor))
    const firstSuccess = orderedTools.find((tool) => tool.ok === true)
    if (anchor !== null && firstSuccess) push(stats.firstUseful, nonNegative((firstSuccess.end ?? firstSuccess.start) - anchor))
    const firstPatchTool = orderedTools.find((tool) => isFileMutatingTool(tool.tool))
    if (anchor !== null && firstPatchTool) push(stats.firstPatch, nonNegative(firstPatchTool.start - anchor))

    const candidates = testCandidates(trace)
    stats.testsPerSession.push(candidates.length)
    const passing = candidates.find((candidate) => candidate.passing)
    if (anchor !== null && passing) push(stats.firstPassingTest, nonNegative(passing.at - anchor))

    if (firstSuccess) {
      const turns = trace.steps.filter((step) => step.start <= firstSuccess.start).length
      stats.turnsToFirstSuccess.push(Math.max(1, turns))
    }

    const failedTools = orderedTools.filter((tool) => tool.ok === false)
    if (failedTools.length > 0) {
      stats.sessionsWithFailures++
      const firstFailureAt = Math.min(...failedTools.map((tool) => tool.end ?? tool.start))
      if (orderedTools.some((tool) => tool.ok === true && tool.start >= firstFailureAt)) stats.recoveredSessions++
    }

    // Idle time = session span minus the union of measurable model/tool intervals.
    if (trace.lastEventAt > trace.firstEventAt) {
      const intervals: [number, number][] = []
      for (const step of trace.steps) if (step.end !== null && step.end >= step.start) intervals.push([step.start, step.end])
      for (const tool of trace.tools) if (tool.end !== null && tool.end >= tool.start) intervals.push([tool.start, tool.end])
      intervals.sort((a, b) => a[0] - b[0])
      let covered = 0
      let cursorStart: number | null = null
      let cursorEnd = 0
      for (const [start, end] of intervals) {
        if (cursorStart === null) {
          cursorStart = start
          cursorEnd = end
          continue
        }
        if (start <= cursorEnd) cursorEnd = Math.max(cursorEnd, end)
        else {
          covered += cursorEnd - cursorStart
          cursorStart = start
          cursorEnd = end
        }
      }
      if (cursorStart !== null) covered += cursorEnd - cursorStart
      const span = trace.lastEventAt - trace.firstEventAt
      push(stats.idle, Math.max(0, span - Math.min(covered, span)))
    }

    stats.compactionsPerSession.push(trace.compactions)
    stats.retries += trace.retries
    stats.blockedUnsafe += trace.blockedUnsafeAttempts
    stats.modelSwitches += trace.modelSwitches.length

    const latestLedger = trace.ledgers.length > 0 ? trace.ledgers[trace.ledgers.length - 1]! : null
    if (latestLedger) {
      if (latestLedger.requestBytes !== null) stats.requestBytes.push(latestLedger.requestBytes)
      const included = latestLedger.includedTokens.reduce((sum, entry) => sum + entry.value, 0)
      stats.contextTokens.push(included)
      if (modelWindowTokens !== null && modelWindowTokens !== undefined && modelWindowTokens > 0) {
        stats.contextUtilization.push((included / modelWindowTokens) * 100)
      }
    }
  }
  return stats
}

function sessionTokenTotals(trace: SessionTrace): { present: boolean; value: number } {
  const closed = trace.steps.filter((step) => step.end !== null)
  const present = closed.length > 0 && closed.every((step) => step.tokens !== null)
  return {
    present,
    value: closed.reduce((sum, step) => sum + (step.tokens ? step.tokens.input + step.tokens.output + step.tokens.cacheRead + step.tokens.cacheWrite : 0), 0),
  }
}

function sessionCostTotals(trace: SessionTrace): { present: boolean; value: number; estimated: boolean } {
  const closed = trace.steps.filter((step) => step.end !== null)
  const present = closed.length > 0 && closed.every((step) => step.cost !== null)
  return {
    present,
    value: closed.reduce((sum, step) => sum + (step.cost ?? 0), 0),
    estimated: closed.some((step) => step.costStatus === "estimated"),
  }
}

function sessionUsageTokens(trace: SessionTrace): number | null {
  const totals = sessionTokenTotals(trace)
  return totals.present ? totals.value : null
}

export function aggregate(input: {
  parsed?: ParsedEvents | null
  runs?: LoadedRuns | null
  options?: AggregateOptions
}): AggregatedMetrics {
  const parsed = input.parsed ?? null
  const runs = input.runs ?? null
  const options = input.options ?? {}
  const notes: string[] = []
  if (!parsed) notes.push("no session-event input supplied (--events)")
  if (!runs) notes.push("no run-record input supplied (--runs)")
  if (runs?.missingDir) notes.push(...runs.reasons)
  if (parsed && parsed.malformed > 0) notes.push(`malformed event lines: ${parsed.malformed}`)
  if (runs && runs.malformed > 0) notes.push(`malformed run records: ${runs.malformed}`)

  const events: WireEvent[] = parsed?.events ?? []
  const built = buildTraces(events)
  const traces = built.traces
  const stats = computeEventStats(traces, options.modelWindowTokens)
  const records = runs?.records ?? []
  const guard = options.guard ?? null

  if (parsed && parsed.withoutSession > 0) notes.push(`events without sessionID (skipped): ${parsed.withoutSession}`)
  if (parsed && parsed.unknownTypes > 0) notes.push(`unrecognized event types (ignored): ${parsed.unknownTypes}`)

  // ---- session <-> task linkage (only when Lead 4 records carry session_id)
  const traceBySession = new Map(traces.map((trace) => [trace.sessionID, trace]))
  const linkable = (record: RunRecord): SessionTrace | null => (record.session_id ? traceBySession.get(record.session_id) ?? null : null)
  const linkageAvailable = records.length > 0 && records.every((record) => linkable(record) !== null)
  if (records.length > 0 && !linkageAvailable) {
    notes.push("run records carry no session_id linkage: session telemetry cannot be attributed to tasks")
  }

  // ---- run-record derived -------------------------------------------------
  const knownOutcomes = records.filter((record) => record.verified_success !== null)
  const successes = knownOutcomes.filter((record) => record.verified_success === true)
  const durations = records.map((record) => record.duration_ms).filter((value): value is number => value !== null)
  const verifiedDurations = records
    .filter((record) => record.verified_success === true)
    .map((record) => record.duration_ms)
    .filter((value): value is number => value !== null)
  const toolErrorCounts = records.map((record) => record.tool_errors).filter((value): value is number => value !== null)

  const regressionBearing = successes.filter((record) => record.regression_free !== null)
  const regressionClean = regressionBearing.filter((record) => record.regression_free === true)

  const byTask = new Map<string, RunRecord[]>()
  for (const record of records) {
    const bucket = byTask.get(record.task_id)
    if (bucket) bucket.push(record)
    else byTask.set(record.task_id, [record])
  }
  const repeatedTasks = [...byTask.values()].filter((group) => group.length >= 2 && group.every((record) => record.verified_success !== null))
  const passRates = repeatedTasks.map((group) => (group.filter((record) => record.verified_success === true).length / group.length) * 100)
  const consistent = repeatedTasks.filter((group) => new Set(group.map((record) => record.verified_success)).size === 1).length

  const crashTimeout = records.filter((record) => {
    const classification = classifyFailure(record, { timeoutMs: options.timeoutMs ?? null })
    return classification !== null && classification.failure_category === "infrastructure"
  }).length

  const turns = records.map((record) => record.turns).filter((value): value is number => value !== null)

  const perRecordTokens = records.map((record) => {
    if (record.input_tokens !== null && record.output_tokens !== null) {
      return record.input_tokens + record.output_tokens + (record.cached_tokens ?? 0)
    }
    const linked = linkageAvailable ? linkable(record) : null
    return linked ? sessionUsageTokens(linked) : null
  })
  const perRecordCosts = records.map((record) => {
    if (record.cost_usd !== null) return { value: record.cost_usd, estimated: false }
    const linked = linkageAvailable ? linkable(record) : null
    if (!linked) return null
    const totals = sessionCostTotals(linked)
    return totals.present ? { value: totals.value, estimated: totals.estimated } : null
  })

  const errored = records.filter((record) => record.tool_errors !== null && record.tool_errors > 0)
  const recoveredRecords = errored.filter((record) => record.verified_success === true)

  const allCostValues = perRecordCosts.filter((entry): entry is { value: number; estimated: boolean } => entry !== null).map((entry) => entry.value)
  const verifiedCostValues: number[] = []
  const verifiedTokenValues: number[] = []
  records.forEach((record, index) => {
    if (record.verified_success !== true) return
    const cost = perRecordCosts[index]
    if (cost) verifiedCostValues.push(cost.value)
    const tokens = perRecordTokens[index]
    if (tokens !== null) verifiedTokenValues.push(tokens)
  })

  // ---- event-derived token totals (strict coverage) -----------------------
  const stepBuckets = { input: [] as number[], output: [] as number[], reasoning: [] as number[], cacheRead: [] as number[], cacheWrite: [] as number[] }
  const stepPresence = { input: [] as boolean[], output: [] as boolean[], reasoning: [] as boolean[], cacheRead: [] as boolean[], cacheWrite: [] as boolean[] }
  for (const trace of traces) {
    for (const step of trace.steps) {
      if (step.end === null) continue
      const present = step.tokens !== null
      stepPresence.input.push(present)
      stepPresence.output.push(present)
      stepPresence.reasoning.push(present)
      stepPresence.cacheRead.push(present)
      stepPresence.cacheWrite.push(present)
      stepBuckets.input.push(step.tokens?.input ?? 0)
      stepBuckets.output.push(step.tokens?.output ?? 0)
      stepBuckets.reasoning.push(step.tokens?.reasoning ?? 0)
      stepBuckets.cacheRead.push(step.tokens?.cacheRead ?? 0)
      stepBuckets.cacheWrite.push(step.tokens?.cacheWrite ?? 0)
    }
  }
  const usageTotal = (values: number[], present: boolean[], what: string): MetricValue => {
    if (values.length === 0) return unknownValue("tokens", `${what}: no closed steps with usage`)
    if (present.some((flag) => !flag)) {
      const observed = present.filter(Boolean).length
      return unknownValue("tokens", `${what}: partial coverage ${observed}/${values.length} — refusing to fabricate a total`)
    }
    return measured(values.reduce((sum, value) => sum + value, 0), "tokens", `${what}: full coverage over ${values.length} steps`, values.length)
  }

  const noRunReason = runs?.missingDir ? `run records unavailable (${runs.reasons[0] ?? "directory missing"})` : runs ? "no run records" : "no run-record input"
  const noEventReason = parsed ? "no session events with this signal" : "no session-event input"

  // ---- failure classification --------------------------------------------
  const classifications: FailureClassification[] = []
  for (const record of records) {
    const linkedTrace = linkable(record)
    const errorMessages = [
      ...(linkedTrace?.stepFailures ?? []),
      ...(linkedTrace?.tools.filter((tool) => tool.ok === false && tool.error).map((tool) => tool.error!) ?? []),
    ]
    const classification = classifyFailure(record, {
      errorMessages,
      retries: linkedTrace?.retries,
      modelSwitch: (linkedTrace?.modelSwitches.length ?? 0) > 0,
      timeoutMs: options.timeoutMs ?? null,
    })
    if (classification) classifications.push(classification)
  }
  const primaryCounts: Record<FailureCategory, number> = {
    model: 0,
    harness: 0,
    environment: 0,
    verification: 0,
    infrastructure: 0,
    budget: 0,
    unknown: 0,
  }
  const contributingCounts: Record<string, number> = {}
  for (const classification of classifications) {
    primaryCounts[classification.failure_category]++
    for (const cause of classification.contributing) contributingCounts[cause] = (contributingCounts[cause] ?? 0) + 1
  }

  const guardViolations = guard && !guard.pinMissing ? guard.mismatches.length + guard.switches : 0
  const testsPerSession = stats.testsPerSession

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      events: events.length,
      sessions: traces.length,
      malformedEvents: parsed?.malformed ?? 0,
      unknownEventTypes: parsed?.unknownTypes ?? 0,
      eventsWithoutSession: parsed?.withoutSession ?? 0,
      runFiles: runs?.files ?? 0,
      runRecords: records.length,
      malformedRunRecords: runs?.malformed ?? 0,
      runDirMissing: runs?.missingDir ?? false,
      notes,
    },
    harness: {
      verifiedTaskSuccessRate: rate(successes.length, knownOutcomes.length, "%", "run records: verified_success"),
      regressionFreeSuccessRate:
        regressionBearing.length > 0
          ? rate(regressionClean.length, regressionBearing.length, "%", "run records: regression_free among verified successes")
          : unknownValue("%", "run records expose no regression_free field (regression evidence not emitted)"),
      taskCompletionTime: dist(durations, "ms", "run records: duration_ms (all runs)"),
      timeToFirstAction: dist(stats.firstAction, "ms", "session events: prompt -> first tool call"),
      modelLatency: dist(stats.stepLatency, "ms", "session events: step.started -> step.ended"),
      tokensPerTask:
        perRecordTokens.some((value) => value !== null)
          ? dist(
              perRecordTokens.filter((value): value is number => value !== null),
              "tokens",
              `run records/session linkage: input+output+cached per task (${coverage(perRecordTokens.filter((value) => value !== null), records.length)})`,
            )
          : unknownDistribution("tokens", records.length === 0 ? noRunReason : "run records report no token fields and carry no session_id linkage"),
      costPerSuccessfulTask:
        verifiedCostValues.length > 0
          ? dist(verifiedCostValues, "USD", "run records/session linkage: reported cost of verified runs")
          : unknownDistribution("USD", records.length === 0 ? noRunReason : "no cost evidence for verified runs (records or linked sessions) — refusing to fabricate cost"),
      toolCallSuccessRate: rate(stats.toolOk, stats.toolOk + stats.toolFail, "%", "session events: tool.success vs tool.failed"),
      recoveryRate:
        errored.length > 0
          ? rate(recoveredRecords.length, errored.length, "%", "run records: runs with tool_errors>0 that still verified")
          : rate(stats.recoveredSessions, stats.sessionsWithFailures, "%", "session events: sessions recovering after a tool failure"),
      crashTimeoutRate: rate(crashTimeout, records.length, "%", "run records: failure_category=infrastructure (derived classifier)"),
      reproducibility:
        repeatedTasks.length > 0
          ? rate(consistent, repeatedTasks.length, "%", "run records: repeated tasks with identical outcomes across runs")
          : unknownValue("%", `${noRunReason}: reproducibility requires >=2 runs of the same task`),
      safetyViolationsBlocked:
        stats.blockedUnsafe + stats.blockedDestructive + stats.blockedUnauthorizedWrites > 0
          ? estimated(
              stats.blockedUnsafe + stats.blockedDestructive + stats.blockedUnauthorizedWrites,
              "count",
              "session events: denial/destructive pattern matches (heuristic)",
              stats.sessions,
            )
          : unknownValue("count", "no Guard/approval telemetry in the session event stream; no denial-shaped failures observed"),
    },
    speed: {
      ttft: dist(stats.ttft, "ms", "session events: step.started -> first text.started/delta"),
      timeToFirstUsefulAction: dist(stats.firstUseful, "ms", "session events: prompt -> first tool.success"),
      modelTimeMs:
        stats.modelTimeMs > 0 ? measured(stats.modelTimeMs, "ms", "sum of closed step durations", stats.stepLatency.length) : unknownValue("ms", noEventReason),
      toolTimeMs:
        stats.toolTimeMs > 0 ? measured(stats.toolTimeMs, "ms", "sum of closed tool-call durations", stats.toolOk + stats.toolFail) : unknownValue("ms", noEventReason),
      timeToFirstPatch: dist(stats.firstPatch, "ms", "session events: prompt -> first file-mutating tool call"),
      timeToFirstPassingTest: dist(stats.firstPassingTest, "ms", "session events: prompt -> first test-classified command with exit 0/tool success"),
      totalToVerifiedSuccess: dist(verifiedDurations, "ms", "run records: duration_ms of verified runs"),
      idleTimeMs: dist(stats.idle, "ms", "session events: span minus union of model/tool intervals"),
      stepLatency: dist(stats.stepLatency, "ms", "session events: step.started -> step.ended"),
    },
    tokensCost: {
      inputTokens: usageTotal(stepBuckets.input, stepPresence.input, "sum of step usage (session events)"),
      outputTokens: usageTotal(stepBuckets.output, stepPresence.output, "sum of step usage (session events)"),
      reasoningTokens: usageTotal(stepBuckets.reasoning, stepPresence.reasoning, "sum of step usage (session events)"),
      cacheReadTokens: usageTotal(stepBuckets.cacheRead, stepPresence.cacheRead, "sum of step usage (session events)"),
      cacheWriteTokens: usageTotal(stepBuckets.cacheWrite, stepPresence.cacheWrite, "sum of step usage (session events)"),
      tokensPerSuccessfulTask:
        verifiedTokenValues.length > 0
          ? dist(verifiedTokenValues, "tokens", "run records/session linkage: tokens of verified runs")
          : unknownDistribution("tokens", records.length === 0 ? noRunReason : "no token evidence for verified runs (records or linked sessions)"),
      retryCount: parsed ? measured(stats.retries, "count", "session events: session.next.retried", stats.sessions) : unknownValue("count", noEventReason),
      retryTokenOverhead: unknownValue("tokens", "per-retry token attribution is not emitted by the session event contract"),
      contextIncludedTokens: dist(stats.contextTokens, "tokens", "session.context_ledger: latest ledger included-entry tokens"),
      requestBytes: dist(stats.requestBytes, "bytes", "session.context_ledger: requestBytes (payload bytes, not tokens)"),
      contextUtilization:
        stats.contextUtilization.length > 0
          ? dist(stats.contextUtilization, "%", "context ledger tokens / provided model window")
          : unknownDistribution(
              "%",
              options.modelWindowTokens
                ? "no context ledger events"
                : "model window size not provided (--model-window-tokens) and ledger carries no window",
            ),
      compactionsPerSession: dist(stats.compactionsPerSession, "count", "session events: session.next.compaction.started per session"),
      costPerTask:
        allCostValues.length > 0
          ? dist(allCostValues, "USD", "run records/session linkage: reported cost per run")
          : unknownDistribution("USD", records.length === 0 ? noRunReason : "run records report no cost and carry no session_id cost evidence"),
      costPerVerifiedSolve:
        verifiedCostValues.length > 0
          ? dist(verifiedCostValues, "USD", "run records/session linkage: reported cost of verified runs")
          : unknownDistribution("USD", records.length === 0 ? noRunReason : "no cost evidence for verified runs"),
    },
    toolLoop: {
      toolCallSuccessRate: rate(stats.toolOk, stats.toolOk + stats.toolFail, "%", "session events: tool.success vs tool.failed"),
      invalidToolArgs: parsed ? measured(stats.invalidArgs, "count", "session events: tool.failed with invalid-argument message pattern", stats.toolOk + stats.toolFail) : unknownValue("count", noEventReason),
      commandExitCodes:
        stats.exitReported > 0
          ? {
              status: "measured",
              counts: stats.exitCounts,
              reported: stats.exitReported,
              shellCalls: stats.shellCalls,
              basis: `${stats.exitReported}/${stats.shellCalls} shell calls reported an exit code`,
            }
          : {
              status: "unknown",
              counts: {},
              reported: 0,
              shellCalls: stats.shellCalls,
              basis: stats.shellCalls > 0 ? "no shell call reported an exit code in structured output" : "no shell calls observed",
            },
      fileOpFailureRate: rate(stats.fileOpFail, stats.fileOps, "%", "session events: file-mutating tool failures"),
      patchApplyFailureRate: rate(stats.patchFail, stats.patchCalls, "%", "session events: patch/apply tool failures"),
      duplicateCalls: parsed ? measured(stats.duplicates, "count", "session events: identical (tool,input) repeats within a session", stats.sessions) : unknownValue("count", noEventReason),
      noProgressLoops: parsed ? measured(stats.noProgressLoops, "count", "session events: identical (tool,input) failing >=2 times in a session", stats.sessions) : unknownValue("count", noEventReason),
      recoveryAfterError: rate(stats.recoveredSessions, stats.sessionsWithFailures, "%", "session events: sessions with a tool success after a tool failure"),
      testsTriggeredPerTask: linkageAvailable
        ? dist(
            records.map((record) => testCandidates(linkable(record)!).length),
            "count",
            "session events linked by run.session_id: test-classified commands per task",
          )
        : unknownDistribution("count", "run records carry no session_id linkage to attribute test commands to tasks"),
      testsTriggeredPerSession: dist(testsPerSession, "count", "session events: test-classified commands per session"),
      turnsUntilFirstToolSuccess: dist(stats.turnsToFirstSuccess, "turns", "session events: model steps up to first tool.success"),
      turnsUntilVerifiedSuccess:
        turns.length > 0
          ? dist(turns, "turns", `run records: turns field (${coverage(turns, records.length)})`)
          : unknownDistribution("turns", records.length === 0 ? noRunReason : "run records expose no turns field"),
      cancellationResponsiveness: unknownValue("ms", "session event contract carries no cancellation-request/acknowledgement pair"),
    },
    reliability: {
      finishNormallyRate: rate(stats.normalFinishes, stats.finishes, "%", "session events: Step.Ended finish in {stop, tool-calls, end_turn}"),
      patchInspectableRate: unknownValue("%", "no patch-inspection evidence emitted in session events or run records"),
      verificationCompletesRate: unknownValue("%", "no verification-completion signal emitted in session events or run records"),
      resumeAfterInterruptRate: unknownValue("%", "no interrupt/resume signal emitted in session events or run records"),
      passAt1: dist(passRates, "%", "run records: per-task pass rate across repeated runs (>=2 runs)"),
      blockedUnauthorizedWrites:
        stats.blockedUnauthorizedWrites > 0
          ? estimated(stats.blockedUnauthorizedWrites, "count", "session events: failed file-mutating calls with denial-shaped errors (pattern match)", stats.sessions)
          : unknownValue("count", "no denial-shaped tool failure observed; Guard block telemetry not present in this stream"),
      blockedDestructiveCommands:
        stats.blockedDestructive > 0
          ? estimated(stats.blockedDestructive, "count", "session events: failed shell calls matching destructive patterns (pattern match)", stats.shellCalls)
          : unknownValue("count", "no failed destructive-pattern shell call observed; Guard block telemetry not present in this stream"),
      approvalBypassAttempts: unknownValue("count", "no approval-bypass telemetry emitted in the session event contract"),
      secretsInLogsDetected: unknownValue("count", "no secret-scan telemetry emitted in the session event contract"),
      blockedUnsafeAttempts:
        stats.blockedUnsafe > 0
          ? estimated(stats.blockedUnsafe, "count", "session events: tool failures with denial-shaped errors (pattern match)", stats.sessions)
          : unknownValue("count", "no denial-shaped tool failure observed"),
      modelIdentityViolations: guard
        ? guard.pinMissing
          ? unknownValue("count", "model guard: no pinned model configured — validity UNKNOWN")
          : measured(guardViolations, "count", "model guard: mismatches + model-switch events (safety/validity failure)", guard.checked)
        : unknownValue("count", "model guard not evaluated (no pin configured)"),
    },
    failures: {
      classifications,
      primaryCounts,
      contributingCounts,
      classified: classifications.length,
      unclassified: records.length - classifications.length,
    },
  }
}
