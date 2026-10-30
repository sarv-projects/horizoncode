/**
 * Dashboard renderer: markdown/ASCII output with median AND p95 for every
 * distribution, an explicit status (measured/estimated/UNKNOWN) per metric,
 * and a prominent model-identity guard banner.
 */

import type { AggregatedMetrics, ExitCodeDistribution } from "./aggregate"
import type { MetricDistribution, MetricStatus, MetricValue } from "./types"
import type { ModelGuardReport } from "./model-guard"

export interface RenderOptions {
  readonly guard?: ModelGuardReport | null
  /** Absolute or repo-relative path shown in the header for provenance. */
  readonly eventsSource?: string | null
  readonly runsSource?: string | null
  readonly generatedAt?: string
}

type Row = readonly [name: string, display: string, samples: string, status: MetricStatus, basis: string]

const UNKNOWN_TOKEN = "UNKNOWN"

function fmtNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString("en-US")
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function fmtUnit(value: number, unit: string): string {
  if (unit === "ms" && value >= 1000) return `${fmtNumber(value)} ms (${(value / 1000).toFixed(2)} s)`
  if (unit === "%") return `${fmtNumber(value)} %`
  if (unit === "USD") return `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
  return `${fmtNumber(value)} ${unit}`
}

function valueRow(name: string, metric: MetricValue): Row {
  if (metric.status === "unknown" || metric.value === null) return [name, UNKNOWN_TOKEN, "0", "unknown", metric.basis]
  return [name, fmtUnit(metric.value, metric.unit), String(metric.samples), metric.status, metric.basis]
}

function distRow(name: string, metric: MetricDistribution): Row {
  if (metric.status === "unknown" || metric.median === null || metric.p95 === null) {
    return [name, UNKNOWN_TOKEN, "0", "unknown", metric.basis]
  }
  return [
    name,
    `median ${fmtUnit(metric.median, metric.unit)} | p95 ${fmtUnit(metric.p95, metric.unit)}`,
    String(metric.count),
    metric.status,
    metric.basis,
  ]
}

function renderTable(title: string, rows: Row[]): string[] {
  const lines: string[] = ["", `### ${title}`, "", "| Metric | Value (median / p95) | n | Status | Basis |", "|---|---|---:|---|---|"]
  for (const [name, display, samples, status, basis] of rows) {
    const statusLabel = status === "unknown" ? "**UNKNOWN**" : status === "estimated" ? "estimated" : "measured"
    lines.push(`| ${name} | ${display} | ${samples} | ${statusLabel} | ${basis} |`)
  }
  return lines
}

function exitCodeRow(exit: ExitCodeDistribution): Row {
  if (exit.status === "unknown") return ["Command exit-code distribution", UNKNOWN_TOKEN, "0", "unknown", exit.basis]
  const parts = Object.keys(exit.counts)
    .sort()
    .map((code) => `exit ${code}: ${exit.counts[code]}`)
    .join(", ")
  return ["Command exit-code distribution", parts, String(exit.reported), "measured", exit.basis]
}

export function renderDashboard(metrics: AggregatedMetrics, options: RenderOptions = {}): string {
  const lines: string[] = []
  const guard = options.guard ?? null
  const generatedAt = options.generatedAt ?? metrics.generatedAt

  lines.push("# HorizonCode Harness Performance Dashboard")
  lines.push("")
  lines.push(`Generated: ${generatedAt}`)
  lines.push(
    ...[
      "",
      "## Sources",
      "",
      `- Session events: ${metrics.sources.events} events / ${metrics.sources.sessions} sessions` +
        (options.eventsSource ? ` (from \`${options.eventsSource}\`)` : ""),
      `- Run records: ${metrics.sources.runRecords} records from ${metrics.sources.runFiles} files` +
        (options.runsSource ? ` (\`${options.runsSource}\`)` : ""),
      `- Pinned model: ${guard?.pinned ? `\`${guard.pinned}\`` : "NOT CONFIGURED"}`,
      ...metrics.sources.notes.map((note) => `- Note: ${note}`),
    ],
  )

  // ---- model guard banner -------------------------------------------------
  lines.push("")
  if (!guard) {
    lines.push("## MODEL IDENTITY GUARD: **NOT EVALUATED**")
    lines.push("")
    lines.push("No pin configured; model validity is UNKNOWN.")
  } else if (guard.pinMissing) {
    lines.push("## [MODEL GUARD WARNING] MODEL IDENTITY GUARD: **NO PIN CONFIGURED**")
    lines.push("")
    lines.push("Model validity cannot be asserted: pass `--pinned-model <ref>`.")
  } else if (!guard.ok) {
    lines.push(`## [MODEL GUARD WARNING] MODEL IDENTITY GUARD: **FAILED (${guard.mismatches.length} mismatch(es), ${guard.switches} switch(es))**`)
    lines.push("")
    lines.push(`Every request must use the pinned model \`${guard.pinned}\`.`)
    if (guard.switches > 0) {
      lines.push("")
      lines.push(`**${guard.switches} model switch event(s) observed — validity failure counted in safety metrics.**`)
    }
    if (guard.mismatches.length > 0) {
      lines.push("")
      lines.push("| Source | Observed model | Session / task |")
      lines.push("|---|---|---|")
      for (const mismatch of guard.mismatches.slice(0, 20)) {
        lines.push(`| ${mismatch.source} | \`${mismatch.observed}\` | ${mismatch.sessionID ?? mismatch.task_id ?? "-"} |`)
      }
      if (guard.mismatches.length > 20) lines.push(`| ... | ${guard.mismatches.length - 20} more | - |`)
    }
  } else if (guard.checked === 0) {
    lines.push("## [MODEL GUARD WARNING] MODEL IDENTITY GUARD: **NO OBSERVATIONS — validity UNKNOWN**")
    lines.push("")
    lines.push(`Pin \`${guard.pinned}\` configured, but the inputs contain no model-identity observations to check.`)
  } else {
    lines.push(`## MODEL IDENTITY GUARD: OK (${guard.checked} model observation(s) match \`${guard.pinned}\`)`)
  }

  // ---- metric families ----------------------------------------------------
  const harness = metrics.harness
  lines.push(
    ...renderTable("Harness & System Performance", [
      valueRow("Verified task success", harness.verifiedTaskSuccessRate),
      valueRow("Regression-free success", harness.regressionFreeSuccessRate),
      distRow("Task completion time", harness.taskCompletionTime),
      distRow("Time-to-first-action", harness.timeToFirstAction),
      distRow("Model latency (per step)", harness.modelLatency),
      distRow("Tokens per task", harness.tokensPerTask),
      distRow("Cost per successful task", harness.costPerSuccessfulTask),
      valueRow("Tool-call success rate", harness.toolCallSuccessRate),
      valueRow("Recovery rate", harness.recoveryRate),
      valueRow("Crash / timeout rate", harness.crashTimeoutRate),
      valueRow("Reproducibility (identical repeats)", harness.reproducibility),
      valueRow("Safety violations blocked", harness.safetyViolationsBlocked),
    ]),
  )

  const speed = metrics.speed
  lines.push(
    ...renderTable("Speed Timeline", [
      distRow("TTFT (first token)", speed.ttft),
      distRow("Time-to-first-useful-action", speed.timeToFirstUsefulAction),
      valueRow("Model time (total)", speed.modelTimeMs),
      valueRow("Tool time (total)", speed.toolTimeMs),
      distRow("Time-to-first-patch", speed.timeToFirstPatch),
      distRow("Time-to-first-passing-test", speed.timeToFirstPassingTest),
      distRow("Total-to-verified-success", speed.totalToVerifiedSuccess),
      distRow("Idle time", speed.idleTimeMs),
      distRow("Step latency", speed.stepLatency),
    ]),
  )

  const tokens = metrics.tokensCost
  lines.push(
    ...renderTable("Tokens & Cost", [
      valueRow("Input tokens (total)", tokens.inputTokens),
      valueRow("Output tokens (total)", tokens.outputTokens),
      valueRow("Reasoning tokens (total)", tokens.reasoningTokens),
      valueRow("Cache-read tokens (total)", tokens.cacheReadTokens),
      valueRow("Cache-write tokens (total)", tokens.cacheWriteTokens),
      distRow("Tokens per successful task", tokens.tokensPerSuccessfulTask),
      valueRow("Retry count", tokens.retryCount),
      valueRow("Retry token overhead", tokens.retryTokenOverhead),
      distRow("Context tokens included (per request)", tokens.contextIncludedTokens),
      distRow("Request payload bytes", tokens.requestBytes),
      distRow("Context utilization vs window", tokens.contextUtilization),
      distRow("Compactions per session", tokens.compactionsPerSession),
      distRow("Cost per task", tokens.costPerTask),
      distRow("Cost per verified solve", tokens.costPerVerifiedSolve),
    ]),
  )

  const toolLoop = metrics.toolLoop
  lines.push(
    ...renderTable("Tool Loop", [
      valueRow("Tool-call success rate", toolLoop.toolCallSuccessRate),
      valueRow("Invalid tool args", toolLoop.invalidToolArgs),
      exitCodeRow(toolLoop.commandExitCodes),
      valueRow("File-op failure rate", toolLoop.fileOpFailureRate),
      valueRow("Patch-apply failure rate", toolLoop.patchApplyFailureRate),
      valueRow("Duplicate calls", toolLoop.duplicateCalls),
      valueRow("No-progress loops", toolLoop.noProgressLoops),
      valueRow("Recovery after error", toolLoop.recoveryAfterError),
      distRow("Tests triggered per task", toolLoop.testsTriggeredPerTask),
      distRow("Tests triggered per session", toolLoop.testsTriggeredPerSession),
      distRow("Turns until first tool success", toolLoop.turnsUntilFirstToolSuccess),
      distRow("Turns until verified success", toolLoop.turnsUntilVerifiedSuccess),
      valueRow("Cancellation responsiveness", toolLoop.cancellationResponsiveness),
    ]),
  )

  const reliability = metrics.reliability
  lines.push(
    ...renderTable("Reliability & Safety", [
      valueRow("Finish normally", reliability.finishNormallyRate),
      valueRow("Patch inspectable", reliability.patchInspectableRate),
      valueRow("Verification completes", reliability.verificationCompletesRate),
      valueRow("Resume after interrupt", reliability.resumeAfterInterruptRate),
      distRow("pass@1 across repeats", reliability.passAt1),
      valueRow("Blocked unauthorized writes", reliability.blockedUnauthorizedWrites),
      valueRow("Blocked destructive commands", reliability.blockedDestructiveCommands),
      valueRow("Approval-bypass attempts", reliability.approvalBypassAttempts),
      valueRow("Secrets in logs detected", reliability.secretsInLogsDetected),
      valueRow("Blocked unsafe attempts (pattern)", reliability.blockedUnsafeAttempts),
      valueRow("Model identity violations (safety/validity)", reliability.modelIdentityViolations),
    ]),
  )

  // ---- failure classification --------------------------------------------
  const failures = metrics.failures
  lines.push("", "### Failure Classification", "")
  if (failures.classifications.length === 0) {
    lines.push(`No failed runs to classify (${failures.unclassified} records without a failure).`)
  } else {
    lines.push("| Primary category | Count |")
    lines.push("|---|---:|")
    for (const category of ["model", "harness", "environment", "verification", "infrastructure", "budget", "unknown"] as const) {
      lines.push(`| ${category} | ${failures.primaryCounts[category]} |`)
    }
    const causes = Object.keys(failures.contributingCounts).sort()
    if (causes.length > 0) {
      lines.push("")
      lines.push("| Contributing cause | Count |")
      lines.push("|---|---:|")
      for (const cause of causes) lines.push(`| ${cause} | ${failures.contributingCounts[cause]} |`)
    }
    lines.push("")
    lines.push(`Classified failures: ${failures.classified} / ${failures.classified + failures.unclassified} records.`)
  }

  // ---- unknown roll-up ----------------------------------------------------
  const unknownRows: string[] = []
  const collect = (family: Record<string, unknown>) => {
    for (const [name, metric] of Object.entries(family)) {
      const candidate = metric as MetricValue | MetricDistribution
      if (candidate && candidate.status === "unknown") unknownRows.push(`- \`${name}\` — ${candidate.basis}`)
    }
  }
  collect(metrics.harness as unknown as Record<string, unknown>)
  collect(metrics.speed as unknown as Record<string, unknown>)
  collect(metrics.tokensCost as unknown as Record<string, unknown>)
  collect(metrics.toolLoop as unknown as Record<string, unknown>)
  collect(metrics.reliability as unknown as Record<string, unknown>)
  lines.push("", `## UNKNOWN metrics (${unknownRows.length})`, "", ...unknownRows)

  lines.push("")
  lines.push("---")
  lines.push("Statuses: measured = observed in emitted telemetry; estimated = pattern/provenance-derived; **UNKNOWN** = not derivable from current sources (never fabricated).")
  lines.push("")
  return lines.join("\n")
}
