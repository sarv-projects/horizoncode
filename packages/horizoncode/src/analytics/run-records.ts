/**
 * Reader for Lead 4's per-task run records
 * (`.tmp/nemotron-bench/runs/*.json`).
 *
 * CONSUME ONLY: this module never writes or edits Lead 4's files. Known fields
 * (task_id / model_id / verified_success / duration_ms / tool_errors /
 * failure_category) are parsed strictly-or-null; additional optional fields are
 * used opportunistically and always reported with their basis. Anything absent
 * stays null and renders as UNKNOWN — never a guessed number.
 */

import type { FailureCategory } from "./failure-category"
import fs from "node:fs"
import path from "node:path"

export const KNOWN_FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "model",
  "harness",
  "environment",
  "verification",
  "infrastructure",
  "budget",
  "unknown",
]

export interface RunRecord {
  readonly file: string
  readonly task_id: string
  readonly model_id: string | null
  readonly verified_success: boolean | null
  readonly duration_ms: number | null
  readonly tool_errors: number | null
  readonly failure_category: FailureCategory | null
  /** true only when the raw category was one of the seven canonical values. */
  readonly failure_category_valid: boolean
  readonly session_id: string | null
  readonly turns: number | null
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly cached_tokens: number | null
  readonly cost_usd: number | null
  readonly regression_free: boolean | null
  readonly raw: Record<string, unknown>
}

export interface LoadedRuns {
  readonly records: RunRecord[]
  readonly files: number
  readonly malformed: number
  readonly missingDir: boolean
  readonly reasons: string[]
}

function str(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function num(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function bool(record: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "boolean") return value
  }
  return null
}

export function parseRunRecord(fileName: string, json: unknown): { record: RunRecord | null; reason: string | null } {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { record: null, reason: `${fileName}: not a JSON object` }
  }
  const raw = json as Record<string, unknown>
  const taskID = str(raw, ["task_id", "taskId", "task"])
  if (!taskID) return { record: null, reason: `${fileName}: missing task_id` }

  const rawCategory = str(raw, ["failure_category", "failureCategory"])
  const failureCategoryValid = rawCategory !== null && (KNOWN_FAILURE_CATEGORIES as readonly string[]).includes(rawCategory)
  const failureCategory = failureCategoryValid ? (rawCategory as FailureCategory) : rawCategory !== null ? "unknown" : null

  const tokens = raw.tokens !== null && typeof raw.tokens === "object" && !Array.isArray(raw.tokens) ? (raw.tokens as Record<string, unknown>) : null

  const record: RunRecord = {
    file: fileName,
    task_id: taskID,
    model_id: str(raw, ["model_id", "modelId", "model"]),
    verified_success: bool(raw, ["verified_success", "verifiedSuccess", "verified"]),
    duration_ms: num(raw, ["duration_ms", "durationMs", "duration", "elapsed_ms"]),
    tool_errors: num(raw, ["tool_errors", "toolErrors", "tool_error_count"]),
    failure_category: failureCategory,
    failure_category_valid: failureCategoryValid,
    session_id: str(raw, ["session_id", "sessionId"]),
    turns: num(raw, ["turns", "turn_count", "turns_until_success"]),
    input_tokens: num(raw, ["input_tokens", "inputTokens"]) ?? (tokens ? num(tokens, ["input", "inputTokens"]) : null),
    output_tokens: num(raw, ["output_tokens", "outputTokens"]) ?? (tokens ? num(tokens, ["output", "outputTokens"]) : null),
    cached_tokens:
      num(raw, ["cached_tokens", "cachedTokens", "cache_read_tokens"]) ??
      (tokens ? (num(tokens, ["cache_read", "cached", "cacheRead"]) ?? num(tokens.cache !== undefined ? (tokens.cache as Record<string, unknown>) : {}, ["read"])) : null),
    cost_usd: num(raw, ["cost_usd", "costUsd", "cost", "cost_dollars"]),
    regression_free: bool(raw, ["regression_free", "regressionFree", "no_regressions"]),
    raw,
  }
  return { record, reason: null }
}

/** Pure loader over in-memory `{file, text}` pairs (fixtures + tests). */
export function loadRunRecordsFromTexts(items: readonly { file: string; text: string }[]): LoadedRuns {
  const records: RunRecord[] = []
  const reasons: string[] = []
  let malformed = 0
  for (const item of items) {
    let parsed: unknown
    try {
      parsed = JSON.parse(item.text)
    } catch {
      malformed++
      if (reasons.length < 5) reasons.push(`${item.file}: invalid JSON`)
      continue
    }
    const { record, reason } = parseRunRecord(item.file, parsed)
    if (record) records.push(record)
    else {
      malformed++
      if (reason && reasons.length < 5) reasons.push(reason)
    }
  }
  records.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.file.localeCompare(b.file))
  return { records, files: items.length, malformed, missingDir: false, reasons }
}

export function loadRunRecordsDir(dir: string): LoadedRuns {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { records: [], files: 0, malformed: 0, missingDir: true, reasons: [`run records directory not found: ${dir}`] }
  }
  const items: { file: string; text: string }[] = []
  const reasons: string[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue
    const full = path.join(dir, entry)
    try {
      items.push({ file: full, text: fs.readFileSync(full, "utf8") })
    } catch {
      if (reasons.length < 5) reasons.push(`${full}: unreadable`)
    }
  }
  const loaded = loadRunRecordsFromTexts(items)
  return { ...loaded, reasons: [...loaded.reasons, ...reasons] }
}
