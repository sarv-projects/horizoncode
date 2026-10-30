/**
 * Failure classification for per-task runs.
 *
 * Primary categories align with Lead 4's run-record schema exactly:
 *   model | harness | environment | verification | infrastructure | budget | unknown
 *
 * When a run record already carries a canonical `failure_category` that value
 * is consumed as the primary (source: "run-record"); contributing causes are
 * still derived from the run's trace. Otherwise the primary is derived from
 * trace signals with the ordered rules below. Nothing is guessed: absence of
 * signal yields "unknown".
 */

import type { RunRecord } from "./run-records"
import { KNOWN_FAILURE_CATEGORIES } from "./run-records"
import { isCrashTimeoutMessage, isInvalidArgsMessage } from "./classify"

export type FailureCategory = "model" | "harness" | "environment" | "verification" | "infrastructure" | "budget" | "unknown"

export const FAILURE_CATEGORIES: readonly FailureCategory[] = KNOWN_FAILURE_CATEGORIES

export interface FailureClassification {
  readonly task_id: string
  readonly model_id: string | null
  readonly verified_success: boolean | null
  readonly duration_ms: number | null
  readonly tool_errors: number | null
  readonly failure_category: FailureCategory
  readonly source: "run-record" | "derived" | "record-invalid"
  readonly contributing: string[]
}

export interface TraceHints {
  /** Error messages from step.failed / tool.failed events in the run's trace. */
  readonly errorMessages?: readonly string[]
  readonly retries?: number
  readonly modelSwitch?: boolean
  readonly timeoutMs?: number | null
}

const BUDGET_PATTERN = /\b(budget|token limit|context (length |window )?(overflow|exceeded)|max(imum)? (input |output )?tokens|too long|quota exceeded)\b/i
const ENVIRONMENT_PATTERN =
  /\b(command not found|no such file or directory|permission denied|eacces|enoent|not installed|missing dependency|exit code 127|cannot execute|read-?only file system)\b/i
const VERIFICATION_PATTERN = /\b(test(s)? failed|assertion( error)?|verification failed|check failed|failing test|non-zero exit|expected .+ to)\b/i
const MODEL_PATTERN = /\b(malformed|invalid (json|response)|provider error|rate limit|econnrefused|api error|http 5\d\d|status 5\d\d|refus(ed|al)|did not (call|emit)|tool call (parse|truncat))/i
const HARNESS_PATTERN = /\b(invalid (tool )?argument|unknown tool|internal error|unexpected (state|error)|failed to parse|serialization|registry)\b/i

function classifyFromMessages(messages: readonly string[]): FailureCategory | null {
  // Ordered: the most specific environmental/budget facts win over generic
  // provider noise; each message may only vote once, first match takes it.
  const votes: FailureCategory[] = []
  for (const message of messages) {
    if (!message) continue
    if (BUDGET_PATTERN.test(message)) votes.push("budget")
    else if (CRASH(message)) votes.push("infrastructure")
    else if (ENVIRONMENT_PATTERN.test(message)) votes.push("environment")
    else if (VERIFICATION_PATTERN.test(message)) votes.push("verification")
    else if (HARNESS_PATTERN.test(message) || isInvalidArgsMessage(message)) votes.push("harness")
    else if (MODEL_PATTERN.test(message)) votes.push("model")
  }
  if (votes.length === 0) return null
  const priority: FailureCategory[] = ["budget", "infrastructure", "environment", "verification", "harness", "model"]
  for (const category of priority) if (votes.includes(category)) return category
  return null
}

function CRASH(message: string): boolean {
  return isCrashTimeoutMessage(message)
}

/**
 * Classify a failed run. Returns null for verified successes (there is no
 * failure to classify). `verified_success === null` still classifies, with a
 * `success-unknown` contributing cause.
 */
export function classifyFailure(record: RunRecord, hints: TraceHints = {}): FailureClassification | null {
  if (record.verified_success === true) return null

  const contributing: string[] = []
  if (record.verified_success === null) contributing.push("success-unknown")
  if (record.tool_errors !== null && record.tool_errors > 0) contributing.push("tool_errors")
  if (hints.retries !== undefined && hints.retries > 0) contributing.push("provider_retries")
  if (hints.modelSwitch) contributing.push("model_switch")
  const messages = hints.errorMessages ?? []
  if (messages.some((m) => m && CRASH(m))) contributing.push("timeout_or_crash")
  if (messages.some((m) => m && isInvalidArgsMessage(m))) contributing.push("invalid_tool_args")
  if (messages.some((m) => m && VERIFICATION_PATTERN.test(m))) contributing.push("test_failure")
  if (messages.some((m) => m && BUDGET_PATTERN.test(m))) contributing.push("budget_exhausted")

  if (record.failure_category !== null) {
    return {
      task_id: record.task_id,
      model_id: record.model_id,
      verified_success: record.verified_success,
      duration_ms: record.duration_ms,
      tool_errors: record.tool_errors,
      failure_category: record.failure_category,
      source: record.failure_category_valid ? "run-record" : "record-invalid",
      contributing: dedupe(contributing),
    }
  }

  const fromMessages = classifyFromMessages(messages)
  if (fromMessages) {
    return finish(record, fromMessages, "derived", contributing)
  }

  if (
    hints.timeoutMs != null &&
    record.duration_ms != null &&
    hints.timeoutMs > 0 &&
    record.duration_ms >= hints.timeoutMs
  ) {
    contributing.push("budget_exhausted")
    return finish(record, "budget", "derived", contributing)
  }

  if (record.tool_errors !== null && record.tool_errors > 0) {
    // Tool-level failures with no specific signal are harness-side.
    return finish(record, "harness", "derived", contributing)
  }

  if (record.verified_success === false) {
    // Clean run (no tool errors, no error messages) that did not verify.
    contributing.push("no_tool_errors")
    return finish(record, "verification", "derived", contributing)
  }

  return finish(record, "unknown", "derived", contributing)
}

function finish(record: RunRecord, category: FailureCategory, source: FailureClassification["source"], contributing: string[]): FailureClassification {
  return {
    task_id: record.task_id,
    model_id: record.model_id,
    verified_success: record.verified_success,
    duration_ms: record.duration_ms,
    tool_errors: record.tool_errors,
    failure_category: category,
    source,
    contributing: dedupe(contributing),
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
