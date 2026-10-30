import { EOL } from "node:os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { collectAnalytics, discoverDefaultTelemetry } from "@/analytics/collect"
import type { CollectSources } from "@/analytics/collect"
import { renderDashboard } from "@/analytics/render"

function describeSource(count: number, paths: readonly string[], placeholder: string): string | null {
  if (count === 0) return null
  const shown = paths.slice(0, 2).join(", ")
  return paths.length > 2 ? `${shown} (+${paths.length - 2} more)` : shown || placeholder
}

function noTelemetryReport(searched: readonly string[], sources: CollectSources): string {
  const lines = [
    "HorizonCode analytics — no telemetry found",
    "",
    `Event files read: ${sources.eventFiles}`,
    `Run-record directories read: ${sources.runDirs}`,
  ]
  if (searched.length > 0) {
    lines.push("", "Searched:")
    for (const location of searched) lines.push(`  - ${location}`)
  }
  if (sources.missing.length > 0) {
    lines.push("", "Unresolved inputs:")
    for (const entry of sources.missing) lines.push(`  - ${entry}`)
  }
  lines.push("", "Status: UNKNOWN — no recorded telemetry, so no metric is measured.")
  lines.push("Nothing is estimated or fabricated: every metric below is UNKNOWN with its reason.")
  lines.push("Record a run (events.jsonl / run records) or pass --events / --runs.")
  return lines.join(EOL)
}

export const AnalyticsCommand = effectCmd({
  command: "analytics",
  describe: "render harness performance metrics from recorded telemetry (events.jsonl and run records)",
  // Reads recorded telemetry from disk only: no project state, no instance bootstrap.
  instance: false,
  builder: (yargs) =>
    yargs
      .option("events", {
        describe: "jsonl event file, or a directory containing events.jsonl (repeatable)",
        type: "string",
        array: true,
      })
      .option("runs", {
        describe: "directory of per-task run-record json files (repeatable)",
        type: "string",
        array: true,
      })
      .option("model-window", {
        describe: "model context window in tokens (enables context utilization)",
        type: "number",
      })
      .option("timeout-ms", {
        describe: "task wall-time ceiling in milliseconds (used by the derived failure classifier)",
        type: "number",
      })
      .option("json", {
        describe: "print the full AggregatedMetrics JSON instead of the dashboard",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.analytics")(function* (args) {
    const flags = args as unknown as {
      events?: string[]
      runs?: string[]
      "model-window"?: number
      "timeout-ms"?: number
      json?: boolean
    }
    const events = flags.events ?? []
    const runs = flags.runs ?? []
    const useDefaults = events.length === 0 && runs.length === 0
    const discovered = useDefaults ? discoverDefaultTelemetry() : null

    const { metrics, sources } = yield* Effect.promise(() =>
      collectAnalytics({
        eventFiles: discovered ? discovered.eventFiles : events,
        runDirs: discovered ? discovered.runDirs : runs,
        modelWindowTokens: flags["model-window"] ?? null,
        timeoutMs: flags["timeout-ms"] ?? null,
      }),
    )

    const empty = metrics.sources.events === 0 && metrics.sources.runRecords === 0
    const report = empty ? noTelemetryReport(discovered?.searched ?? [], sources) : null

    if (flags.json) {
      // Keep stdout machine-readable; the UNKNOWN explanation goes to stderr.
      if (report) process.stderr.write(report + EOL + EOL)
      process.stdout.write(JSON.stringify(metrics, null, 2) + EOL)
      return
    }

    if (report) process.stdout.write(report + EOL + EOL)
    process.stdout.write(
      renderDashboard(metrics, {
        eventsSource: describeSource(sources.eventFiles, sources.eventPaths, "none"),
        runsSource: describeSource(sources.runDirs, sources.runPaths, "none"),
        generatedAt: metrics.generatedAt,
      }) + EOL,
    )
  }),
})
