/**
 * Model-identity guard.
 *
 * Every request in a benchmark run must use the pinned model. This check
 * consumes the real telemetry observations of model identity:
 *   - `session.next.step.started.model` (which model each step requested)
 *   - `session.next.model.switched` (an explicit mid-run switch)
 *   - Lead 4 run records' `model_id`
 * and reports every mismatch. A mismatch or a switch is a counted safety /
 * validity failure surfaced as a prominent dashboard warning — the guard never
 * silently normalizes a different model into the pinned one.
 */

import type { WireEvent } from "./events"
import { resolveModelRef } from "./events"
import type { RunRecord } from "./run-records"

export interface ModelMismatch {
  readonly source: "session.next.step.started" | "session.next.model.switched" | "run-record"
  readonly observed: string
  readonly sessionID?: string
  readonly task_id?: string
  readonly at?: number
}

export interface ModelGuardReport {
  readonly pinned: string | null
  /** Number of model-identity observations checked (steps + run records). */
  readonly checked: number
  /** `session.next.model.switched` events observed (any switch is a validity failure). */
  readonly switches: number
  readonly mismatches: ModelMismatch[]
  readonly ok: boolean
  /** true when no pin was configured, so validity cannot be asserted at all. */
  readonly pinMissing: boolean
}

/**
 * Normalize a model reference for comparison: compare the final `/`-separated
 * segment, case-insensitively, so `openrouter/nvidia/<id>` matches a pinned
 * `nvidia/<id>` or a bare `<id>` — while `nemotron-3-super` still differs from
 * `nemotron-3-super-120b-a12b`. Variant tags (`:free`) are kept: they identify
 * a distinct serving variant.
 */
export function normalizeModelRef(ref: string): string {
  const trimmed = ref.trim()
  const withoutScheme = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed
  return withoutScheme.toLowerCase()
}

export function modelsMatch(a: string, b: string): boolean {
  const left = normalizeModelRef(a)
  const right = normalizeModelRef(b)
  return left.length > 0 && left === right
}

export function checkModelIdentity(options: {
  pinned: string | null
  events?: readonly WireEvent[]
  runRecords?: readonly RunRecord[]
}): ModelGuardReport {
  const { pinned, events = [], runRecords = [] } = options
  const pinMissing = pinned === null || pinned.trim().length === 0
  const mismatches: ModelMismatch[] = []
  let checked = 0
  let switches = 0

  if (!pinMissing) {
    const pin = pinned!
    for (const event of events) {
      if (event.type === "session.next.step.started") {
        const model = resolveModelRef(event.model)
        if (!model) continue
        checked++
        if (!modelsMatch(model, pin)) {
          mismatches.push({
            source: "session.next.step.started",
            observed: model,
            sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
            at: typeof event.timestamp === "number" ? event.timestamp : undefined,
          })
        }
      } else if (event.type === "session.next.model.switched") {
        switches++
        const model = resolveModelRef(event.model)
        if (model && !modelsMatch(model, pin)) {
          mismatches.push({
            source: "session.next.model.switched",
            observed: model,
            sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
            at: typeof event.timestamp === "number" ? event.timestamp : undefined,
          })
        }
      }
    }
    for (const record of runRecords) {
      if (!record.model_id) continue
      checked++
      if (!modelsMatch(record.model_id, pin)) {
        mismatches.push({ source: "run-record", observed: record.model_id, task_id: record.task_id })
      }
    }
  } else {
    // Without a pin, still surface switches for visibility, but validity is UNKNOWN.
    switches = events.filter((event) => event.type === "session.next.model.switched").length
  }

  return {
    pinned: pinMissing ? null : pinned,
    checked,
    switches,
    mismatches,
    ok: !pinMissing && mismatches.length === 0 && switches === 0,
    pinMissing,
  }
}
