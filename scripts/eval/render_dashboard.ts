#!/usr/bin/env bun
/**
 * HorizonCode metrics dashboard renderer (Lead 5 — Analytics & Metrics).
 *
 * Reads REAL emitted session telemetry (JSONL of `session.next.*` events from
 * packages/schema/src/session-event.ts) and Lead 4's per-task run records
 * (`.tmp/nemotron-bench/runs/*.json`, consumed read-only), runs the analytics
 * aggregator, applies the model-identity guard, and prints a markdown/ASCII
 * dashboard where every distribution shows median AND p95 and anything not
 * derivable prints as UNKNOWN.
 *
 * Usage:
 *   bun run scripts/eval/render_dashboard.ts [options]
 *
 * Options:
 *   --events <file.jsonl>      session-event JSONL (repeatable)
 *   --runs <dir>               run-records directory (default: .tmp/nemotron-bench/runs)
 *   --pinned-model <ref>       pinned model; enables the model-identity guard
 *   --model-window-tokens <n>  model context window for utilization %
 *   --timeout-ms <n>           task wall-time ceiling for budget classification
 *   --json                     emit the aggregated metrics JSON instead of markdown
 *   --strict-guard             exit 2 when the model guard fails
 *   --help
 *
 * Exit codes: 0 rendered; 1 bad invocation/read failure; 2 guard failed
 * (only with --strict-guard).
 */

import { aggregate } from "../../packages/horizoncode/src/analytics/aggregate"
import { checkModelIdentity } from "../../packages/horizoncode/src/analytics/model-guard"
import { parseEventsJsonl } from "../../packages/horizoncode/src/analytics/events"
import { loadRunRecordsDir } from "../../packages/horizoncode/src/analytics/run-records"
import { renderDashboard } from "../../packages/horizoncode/src/analytics/render"

interface CliArgs {
  events: string[]
  runs: string
  pinnedModel: string | null
  modelWindowTokens: number | null
  timeoutMs: number | null
  json: boolean
  strictGuard: boolean
  help: boolean
  error: string | null
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    events: [],
    runs: ".tmp/nemotron-bench/runs",
    pinnedModel: null,
    modelWindowTokens: null,
    timeoutMs: null,
    json: false,
    strictGuard: false,
    help: false,
    error: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string | null => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) return null
      i++
      return value
    }
    switch (arg) {
      case "--events": {
        const value = next()
        if (!value) args.error = "--events requires a file path"
        else args.events.push(value)
        break
      }
      case "--runs": {
        const value = next()
        if (!value) args.error = "--runs requires a directory path"
        else args.runs = value
        break
      }
      case "--pinned-model": {
        const value = next()
        if (!value) args.error = "--pinned-model requires a model reference"
        else args.pinnedModel = value
        break
      }
      case "--model-window-tokens": {
        const value = next()
        const parsed = value !== null ? Number(value) : NaN
        if (!Number.isFinite(parsed) || parsed <= 0) args.error = "--model-window-tokens requires a positive number"
        else args.modelWindowTokens = parsed
        break
      }
      case "--timeout-ms": {
        const value = next()
        const parsed = value !== null ? Number(value) : NaN
        if (!Number.isFinite(parsed) || parsed <= 0) args.error = "--timeout-ms requires a positive number"
        else args.timeoutMs = parsed
        break
      }
      case "--json":
        args.json = true
        break
      case "--strict-guard":
        args.strictGuard = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        args.error = `unknown argument: ${arg}`
        break
    }
  }
  return args
}

const HELP = `bun run scripts/eval/render_dashboard.ts [--events file.jsonl] [--runs dir] [--pinned-model ref]
       [--model-window-tokens n] [--timeout-ms n] [--json] [--strict-guard]`

async function readEvents(paths: readonly string[]): Promise<{ text: string; source: string } | { error: string }> {
  const chunks: string[] = []
  const labels: string[] = []
  for (const path of paths) {
    const file = Bun.file(path)
    if (!(await file.exists())) return { error: `events file not found: ${path}` }
    chunks.push(await file.text())
    labels.push(path)
  }
  return { text: chunks.join("\n"), source: labels.join(", ") }
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.error) {
    console.error(`error: ${args.error}\nusage: ${HELP}`)
    return 1
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }

  let parsed = null as ReturnType<typeof parseEventsJsonl> | null
  let eventsSource: string | null = null
  if (args.events.length > 0) {
    const loaded = await readEvents(args.events)
    if ("error" in loaded) {
      console.error(`error: ${loaded.error}`)
      return 1
    }
    parsed = parseEventsJsonl(loaded.text)
    eventsSource = loaded.source
  }

  const runs = loadRunRecordsDir(args.runs)

  const pin = args.pinnedModel ?? process.env.HZ_PINNED_MODEL ?? null
  const guard = checkModelIdentity({ pinned: pin, events: parsed?.events ?? [], runRecords: runs.records })
  const metrics = aggregate({
    parsed,
    runs,
    options: { modelWindowTokens: args.modelWindowTokens, timeoutMs: args.timeoutMs, guard },
  })

  if (args.json) {
    console.log(JSON.stringify({ metrics, guard }, null, 2))
  } else {
    console.log(
      renderDashboard(metrics, {
        guard,
        eventsSource,
        runsSource: args.runs,
      }),
    )
  }

  if (args.strictGuard && !guard.ok) {
    console.error(`model guard FAILED: pinned=${guard.pinned ?? "none"} mismatches=${guard.mismatches.length} switches=${guard.switches}`)
    return 2
  }
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
