/**
 * Disk loader for the analytics library.
 *
 * `events.ts` / `run-records.ts` / `aggregate.ts` / `render.ts` describe how to
 * measure real telemetry, but nothing fed them real files. This module is that
 * feed: it reads recorded telemetry from disk, normalizes the wire encodings
 * that actually exist in this repo, and hands the result to `aggregate()`.
 * No network, no database, no writes.
 *
 * TWO REAL ON-DISK EVENT ENCODINGS ARE SUPPORTED
 *
 *  1. Durable session-event contract JSONL: one
 *     `{ id, type, data: { timestamp, sessionID, ... } }` envelope (or a flat
 *     `{ type, timestamp, sessionID, ... }`) per line. Handed to
 *     `parseEventsJsonl` untouched.
 *
 *  2. The V1 SSE capture written by the e2e collector
 *     (`.tmp/e2e/logs/<run>/events.jsonl`): one
 *     `{ t, raw: "<json {id,type,properties}>", type, sessionID }` envelope per
 *     line, where `raw` is the SSE payload as delivered and `t` is the
 *     collector's local receive clock in epoch SECONDS. That stream carries the
 *     `message.*` projections, not `session.next.*` events, so it is normalized
 *     into the contract shape first. See `normalizeSseFrames` for the exact
 *     wire fields each emitted event is derived from.
 *
 * HONESTY: nothing here invents a timestamp. A value that has no real field
 * behind it is dropped, and `aggregate()` then reports that metric as UNKNOWN.
 */

import fs from "node:fs"
import path from "node:path"
import { aggregate } from "./aggregate"
import type { AggregatedMetrics } from "./aggregate"
import { parseEventsJsonl } from "./events"
import type { ParsedEvents, WireEvent } from "./events"
import { loadRunRecordsDir } from "./run-records"
import type { LoadedRuns, RunRecord } from "./run-records"

export interface CollectInput {
  /** Event files to read. A directory expands to its `events.jsonl` (one level deep). */
  readonly eventFiles?: readonly string[]
  /** Extra event directories, expanded the same way as `eventFiles`. */
  readonly eventDirs?: readonly string[]
  /** Directories of per-task run-record `*.json` files. */
  readonly runDirs?: readonly string[]
  /** Model context window in tokens; context utilization stays UNKNOWN without it. */
  readonly modelWindowTokens?: number | null
  /** Task wall-time ceiling, used by the derived failure classifier. */
  readonly timeoutMs?: number | null
}

export type EventWireFormat = "session-event-jsonl" | "sse-envelope-jsonl"

export interface CollectSources {
  /** Event files actually read (0 when nothing resolved). */
  readonly eventFiles: number
  /** Run-record directories actually read (0 when nothing resolved). */
  readonly runDirs: number
  /** Absolute paths behind `eventFiles`, for provenance in the dashboard header. */
  readonly eventPaths: readonly string[]
  /** Absolute paths behind `runDirs`. */
  readonly runPaths: readonly string[]
  /** Wire encoding detected per event file, in read order. */
  readonly formats: readonly EventWireFormat[]
  /** Inputs that did not resolve on disk. Reported, never guessed around. */
  readonly missing: readonly string[]
}

export interface CollectedAnalytics {
  readonly metrics: AggregatedMetrics
  readonly sources: CollectSources
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const MAX_ANCESTORS = 6

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function statSafe(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * `from` first, then each ancestor. The repo root is often several levels above
 * the directory the CLI was started from (`packages/horizoncode`), while recorded
 * telemetry lives in `<repo>/.tmp`, so resolving only against `process.cwd()`
 * would silently miss real logs and report "no telemetry".
 */
function ancestorRoots(from: string): string[] {
  const roots: string[] = []
  let current = path.resolve(from)
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    roots.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

function resolveExisting(input: string, roots: readonly string[] = ancestorRoots(process.cwd())): string | null {
  if (path.isAbsolute(input)) return fs.existsSync(input) ? input : null
  for (const root of roots) {
    const candidate = path.resolve(root, input)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// V1 SSE capture normalization
// ---------------------------------------------------------------------------

interface SseFrame {
  /** Collector receive clock, epoch SECONDS (envelope field `t`). */
  readonly receivedSeconds: number
  /** Decoded `raw` payload: `{ id, type, properties }`. */
  readonly body: Record<string, unknown>
}

function isSseEnvelope(value: unknown): boolean {
  const record = asObject(value)
  if (!record) return false
  if (asNumber(record.t) === null) return false
  const raw = record.raw
  return typeof raw === "string" || asObject(raw) !== null
}

function readSseFrames(text: string): { frames: SseFrame[]; skipped: number } {
  const frames: SseFrame[] = []
  let skipped = 0
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    const record = asObject(parsed)
    const receivedSeconds = record ? asNumber(record.t) : null
    if (!record || receivedSeconds === null) {
      skipped++
      continue
    }
    const raw = record.raw
    if (typeof raw === "string") {
      try {
        const body = asObject(JSON.parse(raw))
        if (body) frames.push({ receivedSeconds, body })
        else skipped++
      } catch {
        skipped++
      }
      continue
    }
    const body = asObject(raw)
    if (body) frames.push({ receivedSeconds, body })
    else skipped++
  }
  return { frames, skipped }
}

interface ToolCallState {
  readonly sessionID: string
  readonly tool: string
  /**
   * Earliest part update (`properties.time`) for this call. This is when the
   * MODEL announced the call while streaming its arguments, which can precede
   * real execution by minutes on a tool-calling batch — so it is only a
   * fallback, never the execution start.
   */
  firstSeenAt: number
  /** Real execution start (`state.time.start`), null until a running/terminal part supplies it. */
  start: number | null
  input: Record<string, unknown> | null
  end: number | null
  ok: boolean | null
  error: string | null
  structured: Record<string, unknown> | null
}

/**
 * Normalize one `message.part.updated` tool part into `calls`, keyed by
 * `part.callID` so the `pending` / `running` / terminal updates of one call
 * collapse into a single call span instead of fake duplicates.
 */
function recordToolPart(input: {
  calls: Map<string, ToolCallState>
  part: Record<string, unknown>
  properties: Record<string, unknown>
  frame: SseFrame
  sessionID: string
}): void {
  const { calls, part, properties, frame, sessionID } = input
  const callID = asText(part.callID) ?? asText(part.id)
  const state = asObject(part.state)
  if (!callID || !state) return

  const stateTime = asObject(state.time)
  const at =
    (stateTime ? asNumber(stateTime.start) : null) ??
    asNumber(properties.time) ??
    Math.round(frame.receivedSeconds * 1000)
  const rawInput = asObject(state.input)
  const usableInput = rawInput && Object.keys(rawInput).length > 0 ? rawInput : null

  const existing = calls.get(callID)
  const call: ToolCallState = existing ?? {
    sessionID,
    tool: asText(part.tool) ?? "unknown",
    firstSeenAt: at,
    start: null,
    input: null,
    end: null,
    ok: null,
    error: null,
    structured: null,
  }
  if (!existing) calls.set(callID, call)
  if (at < call.firstSeenAt) call.firstSeenAt = at
  // Only `state.time.start` is a real execution start; a `pending` part has no
  // `state.time` at all, so its `properties.time` must not become the start.
  const executionStart = stateTime ? asNumber(stateTime.start) : null
  if (executionStart !== null && (call.start === null || executionStart < call.start)) call.start = executionStart
  if (call.input === null && usableInput) call.input = usableInput

  const status = asText(state.status)
  if (status === "completed") {
    call.ok = true
    call.end = (stateTime ? asNumber(stateTime.end) : null) ?? at
    // The shell tool publishes `{ output, status, exit }` through ctx.metadata
    // (see src/tool/shell.ts), which lands on `state.metadata`; extractExitCode
    // reads the `exit` key from here.
    call.structured = asObject(state.metadata)
  } else if (status === "error") {
    call.ok = false
    call.end = (stateTime ? asNumber(stateTime.end) : null) ?? at
    call.error = asText(state.error) ?? asText(asObject(state.error)?.message) ?? null
  }
}

/**
 * Map the V1 SSE capture onto the durable `session.next.*` contract so the
 * aggregate layer can measure it. Every emitted event below is derived from a
 * real field; nothing is interpolated. Exact wire fields used:
 *
 *   message.updated            properties.info.role==="user"
 *     -> session.next.prompted   timestamp = properties.info.time.created (epoch ms)
 *                                sessionID = properties.sessionID, message = properties.info.id
 *     (the same user message is re-published several times; deduped by
 *      `sessionID:info.id` so one prompt stays one prompt)
 *
 *   message.part.updated       part.type==="step-start"
 *     -> session.next.step.started   timestamp = properties.info.time.created of the
 *                                    `message.updated` for the SAME part.messageID
 *                                    (the step's request dispatch, epoch ms)
 *                                    assistantMessageID = part.messageID
 *     (the V1 `step-start` part only appears once the provider's response stream
 *      opens — in the captured live run that was 41s after dispatch, which would
 *      make TTFT measure stream-open -> first token instead of request -> first
 *      token. The assistant message is created when the step's request is
 *      dispatched, so that is the step start; `properties.time` is used only as
 *      a fallback when no assistant `message.updated` was captured.)
 *
 *   message.part.updated       part.type==="step-finish"
 *     -> session.next.step.ended     timestamp = properties.time (epoch ms)
 *                                    finish = part.reason
 *                                    tokens = part.tokens ({input,output,reasoning,cache.read,cache.write})
 *                                    cost = part.cost, usageProvenance = part.usageProvenance
 *
 *   message.part.delta         properties.field==="text"
 *     -> session.next.text.delta     timestamp = round(envelope.t * 1000)
 *     (a delta carries NO timestamp of its own; the envelope `t` receive clock
 *      is the only real time on it. This is what makes TTFT measurable from a
 *      real `.tmp/e2e/logs/<run>/events.jsonl` — the library's TTFT is
 *      step.started -> first text delta.)
 *
 *   message.part.updated       part.type==="tool"
 *     -> session.next.tool.called / tool.success / tool.failed
 *        callID = part.callID, tool = part.tool, input = state.input,
 *        start = state.time.start (a `pending` part has no state.time, so it is
 *        only a fallback for calls that never reached `running`),
 *        end = state.time.end,
 *        structured = state.metadata (shell exit code lives here),
 *        error = state.error
 *
 * Anything outside this table is counted as `ignored`, never reinterpreted.
 */
function normalizeSseFrames(frames: readonly SseFrame[]): { lines: string[]; ignored: number } {
  const lines: string[] = []
  const promptedMessages = new Set<string>()
  const calls = new Map<string, ToolCallState>()
  const emit = (event: Record<string, unknown>) => {
    for (const key of Object.keys(event)) if (event[key] === undefined) delete event[key]
    lines.push(JSON.stringify(event))
  }
  let ignored = 0

  // V1 publishes the assistant message when the step's request is dispatched,
  // and the `step-start` part only when the response stream opens. Build the
  // messageID -> dispatch-time lookup up front so steps are anchored honestly.
  const dispatchedAt = new Map<string, number>()
  for (const frame of frames) {
    if (asText(frame.body.type) !== "message.updated") continue
    const properties = asObject(frame.body.properties)
    const info = properties ? asObject(properties.info) : null
    if (!info || info.role !== "assistant") continue
    const id = asText(info.id)
    const created = asNumber(asObject(info.time)?.created)
    if (id && created !== null && !dispatchedAt.has(id)) dispatchedAt.set(id, created)
  }

  for (const frame of frames) {
    const type = asText(frame.body.type)
    const properties = asObject(frame.body.properties)
    if (!type || !properties) {
      ignored++
      continue
    }
    const envelopeSessionID = asText(properties.sessionID) ?? asText(frame.body.sessionID)

    if (type === "message.updated") {
      const info = asObject(properties.info)
      if (!info || info.role !== "user") {
        ignored++
        continue
      }
      const sessionID = envelopeSessionID ?? asText(info.sessionID)
      const createdAt = asNumber(asObject(info.time)?.created)
      if (!sessionID || createdAt === null) {
        ignored++
        continue
      }
      const messageID = asText(info.id)
      if (messageID) {
        const key = `${sessionID}:${messageID}`
        if (promptedMessages.has(key)) {
          ignored++
          continue
        }
        promptedMessages.add(key)
      }
      emit({ type: "session.next.prompted", timestamp: createdAt, sessionID, messageID })
      continue
    }

    if (type === "message.part.delta") {
      if (asText(properties.field) !== "text") {
        ignored++
        continue
      }
      if (!envelopeSessionID) {
        ignored++
        continue
      }
      emit({
        type: "session.next.text.delta",
        timestamp: Math.round(frame.receivedSeconds * 1000),
        sessionID: envelopeSessionID,
        messageID: asText(properties.messageID),
      })
      continue
    }

    if (type === "message.part.updated") {
      const part = asObject(properties.part)
      const partType = part ? asText(part.type) : null
      const sessionID = envelopeSessionID ?? (part ? asText(part.sessionID) : null)
      if (!part || !partType || !sessionID) {
        ignored++
        continue
      }
      const messageID = asText(part.messageID)
      const partAt = asNumber(properties.time) ?? Math.round(frame.receivedSeconds * 1000)

      if (partType === "step-start") {
        if (!messageID) {
          ignored++
          continue
        }
        const stepStart = dispatchedAt.get(messageID) ?? partAt
        emit({ type: "session.next.step.started", timestamp: stepStart, sessionID, assistantMessageID: messageID })
        continue
      }

      if (partType === "step-finish") {
        if (!messageID) {
          ignored++
          continue
        }
        emit({
          type: "session.next.step.ended",
          timestamp: partAt,
          sessionID,
          assistantMessageID: messageID,
          finish: asText(part.reason),
          tokens: asObject(part.tokens),
          cost: asNumber(part.cost),
          usageProvenance: asObject(part.usageProvenance),
        })
        continue
      }

      if (partType === "tool") {
        recordToolPart({ calls, part, properties, frame, sessionID })
        continue
      }

      ignored++
      continue
    }

    ignored++
  }

  for (const [callID, call] of calls) {
    emit({
      type: "session.next.tool.called",
      timestamp: call.start ?? call.firstSeenAt,
      sessionID: call.sessionID,
      callID,
      tool: call.tool,
      input: call.input ?? {},
    })
    if (call.ok === null || call.end === null) continue
    if (call.ok) {
      emit({
        type: "session.next.tool.success",
        timestamp: call.end,
        sessionID: call.sessionID,
        callID,
        structured: call.structured,
      })
    } else {
      emit({
        type: "session.next.tool.failed",
        timestamp: call.end,
        sessionID: call.sessionID,
        callID,
        error: call.error,
      })
    }
  }

  return { lines, ignored }
}

function detectFormat(text: string): EventWireFormat {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      return isSseEnvelope(JSON.parse(line)) ? "sse-envelope-jsonl" : "session-event-jsonl"
    } catch {
      return "session-event-jsonl"
    }
  }
  return "session-event-jsonl"
}

/** Detect the wire encoding of one event file and parse it into contract events. */
export function parseEventText(text: string): { parsed: ParsedEvents; format: EventWireFormat } {
  const format = detectFormat(text)
  if (format === "session-event-jsonl") return { parsed: parseEventsJsonl(text), format }
  const { frames, skipped } = readSseFrames(text)
  const { lines } = normalizeSseFrames(frames)
  const parsed = parseEventsJsonl(lines.join("\n"))
  return {
    format,
    parsed: {
      ...parsed,
      lines: parsed.lines + skipped,
      malformed: parsed.malformed + skipped,
      reasons:
        skipped > 0 && !parsed.reasons.some((reason) => reason.includes("SSE"))
          ? [...parsed.reasons, `${skipped} SSE envelope line(s) were not decodable`].slice(0, 5)
          : parsed.reasons,
    },
  }
}

// ---------------------------------------------------------------------------
// path expansion
// ---------------------------------------------------------------------------

/** A directory entry expands to its own `events.jsonl`, else one level deep. */
function expandEventEntry(entry: string, roots: readonly string[]): { files: string[]; missing: string[] } {
  const resolved = resolveExisting(entry, roots)
  if (!resolved) return { files: [], missing: [entry] }
  const stat = statSafe(resolved)
  if (!stat) return { files: [], missing: [entry] }
  if (stat.isFile()) return { files: [resolved], missing: [] }
  if (!stat.isDirectory()) return { files: [], missing: [entry] }

  const direct = path.join(resolved, "events.jsonl")
  if (fs.existsSync(direct)) return { files: [direct], missing: [] }

  const files: string[] = []
  for (const child of readdirSafe(resolved).sort()) {
    const nested = path.join(resolved, child, "events.jsonl")
    if (fs.existsSync(nested)) files.push(nested)
  }
  return files.length > 0 ? { files, missing: [] } : { files: [], missing: [entry] }
}

function mergeParsed(parts: readonly ParsedEvents[]): ParsedEvents {
  const events: WireEvent[] = []
  const reasons: string[] = []
  let lines = 0
  let malformed = 0
  let unknownTypes = 0
  let withoutSession = 0
  for (const part of parts) {
    events.push(...part.events)
    lines += part.lines
    malformed += part.malformed
    unknownTypes += part.unknownTypes
    withoutSession += part.withoutSession
    for (const reason of part.reasons) {
      if (reasons.length < 5 && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  return { events, lines, malformed, unknownTypes, withoutSession, reasons }
}

function mergeRuns(loaded: readonly LoadedRuns[]): LoadedRuns {
  const records: RunRecord[] = []
  const reasons: string[] = []
  let files = 0
  let malformed = 0
  let anyDirMissing = false
  for (const part of loaded) {
    records.push(...part.records)
    files += part.files
    malformed += part.malformed
    if (part.missingDir) anyDirMissing = true
    for (const reason of part.reasons) {
      if (reasons.length < 5 && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  records.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.file.localeCompare(b.file))
  return { records, files, malformed, missingDir: anyDirMissing && records.length === 0, reasons }
}

// ---------------------------------------------------------------------------
// default telemetry discovery
// ---------------------------------------------------------------------------

export interface DiscoveredTelemetry {
  readonly roots: readonly string[]
  readonly eventFiles: readonly string[]
  readonly runDirs: readonly string[]
  /** Human-readable locations the scan looked at, for the "no telemetry" message. */
  readonly searched: readonly string[]
}

/**
 * Bounded, symlink-free search for `run-records` directories. Uses dirent types
 * (no per-entry `stat`) because `.tmp` holds tens of thousands of files.
 */
function findRunRecordDirs(root: string, maxDepth = 4, maxVisited = 2000): string[] {
  const found: string[] = []
  let visited = 0
  let frontier: string[] = [root]
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const dir of frontier) {
      if (visited++ > maxVisited) return found
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === "node_modules" || entry.name === ".git") continue
        const full = path.join(dir, entry.name)
        if (entry.name === "run-records") found.push(full)
        else next.push(full)
      }
    }
    frontier = next
  }
  return found
}

/**
 * The repo's own recorded telemetry: `.tmp/e2e/logs/<run>/events.jsonl` plus any
 * `.tmp/**\/run-records` directory. Scanned from the cwd and its ancestors so it
 * also works when invoked from `packages/horizoncode`.
 */
export function discoverDefaultTelemetry(cwd: string = process.cwd()): DiscoveredTelemetry {
  const roots = ancestorRoots(cwd).filter((root) => fs.existsSync(path.join(root, ".tmp")))
  const eventFiles: string[] = []
  const runDirs: string[] = []
  const searched: string[] = []

  // Even with zero `.tmp` roots, report the patterns that were looked for.
  for (const root of roots.length > 0 ? roots : [path.resolve(cwd)]) {
    const tmp = path.join(root, ".tmp")
    const logs = path.join(tmp, "e2e", "logs")
    searched.push(path.join(logs, "*", "events.jsonl"))
    for (const entry of readdirSafe(logs).sort()) {
      const file = path.join(logs, entry, "events.jsonl")
      if (fs.existsSync(file)) eventFiles.push(file)
    }
    searched.push(path.join(tmp, "**", "run-records"))
    runDirs.push(...findRunRecordDirs(tmp))
  }

  return { roots, eventFiles: dedupe(eventFiles), runDirs: dedupe(runDirs), searched: dedupe(searched) }
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

export async function collectAnalytics(input: CollectInput): Promise<CollectedAnalytics> {
  const roots = ancestorRoots(process.cwd())
  const missing: string[] = []
  const eventPaths: string[] = []
  const formats: EventWireFormat[] = []

  for (const entry of [...(input.eventFiles ?? []), ...(input.eventDirs ?? [])]) {
    const expanded = expandEventEntry(entry, roots)
    eventPaths.push(...expanded.files)
    missing.push(...expanded.missing)
  }

  const uniqueEventPaths = dedupe(eventPaths)
  const parsedParts: ParsedEvents[] = []
  const readEventPaths: string[] = []
  for (const file of uniqueEventPaths) {
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      missing.push(`${file}: unreadable`)
      continue
    }
    const { parsed, format } = parseEventText(text)
    parsedParts.push(parsed)
    formats.push(format)
    readEventPaths.push(file)
  }

  const requestedRunDirs = input.runDirs ?? []
  const runPaths = dedupe(requestedRunDirs.map((entry) => resolveExisting(entry, roots) ?? path.resolve(entry)))
  for (const entry of requestedRunDirs) {
    if (!resolveExisting(entry, roots)) missing.push(`${entry}: directory not found`)
  }
  const loadedRuns = runPaths.map((dir) => loadRunRecordsDir(dir))

  const parsed = parsedParts.length > 0 ? mergeParsed(parsedParts) : null
  const runs = loadedRuns.length > 0 ? mergeRuns(loadedRuns) : null

  const metrics = aggregate({
    parsed,
    runs,
    options: {
      modelWindowTokens: input.modelWindowTokens ?? null,
      timeoutMs: input.timeoutMs ?? null,
    },
  })

  return {
    metrics,
    sources: {
      eventFiles: readEventPaths.length,
      runDirs: runPaths.length,
      eventPaths: readEventPaths,
      runPaths,
      formats,
      missing,
    },
  }
}
