/**
 * Reader for the REAL emitted session telemetry.
 *
 * Every event type and field handled here comes from the durable session event
 * contract in `packages/schema/src/session-event.ts` (decoded in tests with the
 * real Effect schemas), in its JSON wire encoding:
 *
 *   Base:   { timestamp: epochMillis, sessionID }
 *   step:   session.next.step.started | session.next.step.ended | session.next.step.failed
 *   text:   session.next.text.started | session.next.text.delta | session.next.text.ended
 *   tool:   session.next.tool.called | session.next.tool.success | session.next.tool.failed
 *   shell:  session.next.shell.started | session.next.shell.ended
 *   misc:   session.next.prompted | session.next.prompt.admitted
 *           session.next.retried | session.next.compaction.started
 *           session.next.model.switched | session.context_ledger
 *
 * This module only READS those events; it never changes how tools run.
 */

import type { SessionEvent } from "@horizoncode/schema/session-event"
import { classifyCommand, extractExitCode, isShellTool, isInvalidArgsMessage, isUnsafeDenialMessage, isDestructiveCommand, stableKey } from "./classify"

// Compile-time wiring: the wire interfaces below mirror the contract's JSON shape.
export type StepEndedWireType = SessionEvent.Step.Ended["type"]
export type ToolSuccessWireType = SessionEvent.Tool.Success["type"]
export type ContextLedgerWireType = SessionEvent.ContextLedger["type"]

export const KNOWN_EVENT_TYPES = [
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.tool.called",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.ended",
  "session.next.model.switched",
  "session.next.agent.switched",
  "session.context_ledger",
] as const

export interface WireEvent {
  readonly type: string
  readonly timestamp: number
  readonly sessionID?: string
  readonly [field: string]: unknown
}

export interface ParsedEvents {
  readonly events: WireEvent[]
  readonly lines: number
  readonly malformed: number
  readonly unknownTypes: number
  readonly withoutSession: number
  readonly reasons: string[]
}

export function parseEventsJsonl(text: string): ParsedEvents {
  const events: WireEvent[] = []
  const reasons: string[] = []
  let lines = 0
  let malformed = 0
  let unknownTypes = 0
  let withoutSession = 0
  const known = new Set<string>(KNOWN_EVENT_TYPES)
  const asObject = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    lines++
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      malformed++
      if (reasons.length < 5) reasons.push("line is not valid JSON")
      continue
    }
    const outer = asObject(parsed)
    if (!outer) {
      malformed++
      if (reasons.length < 5) reasons.push("line is not a JSON object")
      continue
    }
    // Canonical durable envelope: { id, type, data: { timestamp, sessionID, ... } }
    // (packages/schema/src/event.ts Event.define). Flat exports are tolerated too.
    const inner = asObject(outer.data)
    const type =
      typeof outer.type === "string" && outer.type.length > 0
        ? outer.type
        : inner && typeof inner.type === "string" && inner.type.length > 0
          ? inner.type
          : null
    if (type === null) {
      malformed++
      if (reasons.length < 5) reasons.push("missing event type")
      continue
    }
    const body: Record<string, unknown> = inner ? { ...inner, type } : { ...outer, type }
    if (typeof outer.id === "string" && outer.id.length > 0) body.envelopeID = outer.id

    let timestamp = body.timestamp
    if (typeof timestamp === "string") {
      const parsedMs = Date.parse(timestamp)
      if (Number.isFinite(parsedMs)) timestamp = parsedMs
    }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      malformed++
      if (reasons.length < 5) reasons.push(`event ${type} has no numeric timestamp`)
      continue
    }
    body.timestamp = timestamp
    if (!known.has(type)) unknownTypes++
    if (typeof body.sessionID !== "string" || body.sessionID.length === 0) withoutSession++
    events.push(body as WireEvent)
  }
  return { events, lines, malformed, unknownTypes, withoutSession, reasons }
}

export interface StepSpan {
  readonly assistantMessageID: string
  readonly start: number
  end: number | null
  failed: boolean
  model: string | null
  finish: string | null
  firstTextAt: number | null
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null
  cost: number | null
  costStatus: string | null
}

export interface ToolSpan {
  readonly callID: string
  readonly tool: string
  start: number
  end: number | null
  ok: boolean | null
  input: Record<string, unknown> | null
  structured: Record<string, unknown> | null
  error: string | null
}

export interface ShellSpan {
  readonly callID: string
  command: string
  start: number
  end: number | null
}

export interface LedgerSample {
  readonly at: number
  readonly requestBytes: number | null
  /** Included context entries with token evidence; exact=false means estimated. */
  readonly includedTokens: { value: number; exact: boolean }[]
}

export interface SessionTrace {
  readonly sessionID: string
  readonly promptTimes: number[]
  readonly steps: StepSpan[]
  readonly tools: ToolSpan[]
  readonly shells: ShellSpan[]
  retries: number
  compactions: number
  readonly modelSwitches: { at: number; model: string }[]
  readonly ledgers: LedgerSample[]
  readonly stepFailures: string[]
  firstEventAt: number
  lastEventAt: number
  blockedUnsafeAttempts: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Resolve a model identity from any real emission shape:
 * - Model.Ref struct { id, providerID, variant? } (session.next.step.started)
 * - V1-style { providerID, modelID } (message/session projections)
 * - plain model ID or provider/model string (usage provenance, run records)
 */
export function resolveModelRef(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value
  const record = asRecord(value)
  if (record) {
    const provider = typeof record.providerID === "string" ? record.providerID : null
    const model = typeof record.modelID === "string" ? record.modelID : typeof record.id === "string" ? record.id : null
    if (model) return provider ? `${provider}/${model}` : model
  }
  return null
}

function errorMessage(value: unknown): string {
  const record = asRecord(value)
  if (!record) return typeof value === "string" ? value : ""
  return typeof record.message === "string" ? record.message : ""
}

/** Group events per session, ordered by timestamp, and reconstruct spans. */
export function buildTraces(events: readonly WireEvent[]): { traces: SessionTrace[]; skippedNoSession: number } {
  const bySession = new Map<string, WireEvent[]>()
  let skippedNoSession = 0
  for (const event of events) {
    const sessionID = typeof event.sessionID === "string" && event.sessionID.length > 0 ? event.sessionID : null
    if (!sessionID) {
      skippedNoSession++
      continue
    }
    const bucket = bySession.get(sessionID)
    if (bucket) bucket.push(event)
    else bySession.set(sessionID, [event])
  }

  const traces: SessionTrace[] = []
  for (const [sessionID, sessionEvents] of bySession) {
    const ordered = sessionEvents
      .map((event, index) => ({ event, index }))
      .sort((a, b) => a.event.timestamp - b.event.timestamp || a.index - b.index)
      .map((entry) => entry.event)

    const trace: SessionTrace = {
      sessionID,
      promptTimes: [],
      steps: [],
      tools: [],
      shells: [],
      retries: 0,
      compactions: 0,
      modelSwitches: [],
      ledgers: [],
      stepFailures: [],
      firstEventAt: ordered[0]?.timestamp ?? 0,
      lastEventAt: ordered[ordered.length - 1]?.timestamp ?? 0,
      blockedUnsafeAttempts: 0,
    }

    const openSteps = new Map<string, StepSpan>()
    const openTools = new Map<string, ToolSpan>()
    const openShells = new Map<string, ShellSpan>()

    for (const event of ordered) {
      const t = event.timestamp
      switch (event.type) {
        case "session.next.prompted":
        case "session.next.prompt.admitted": {
          trace.promptTimes.push(t)
          break
        }
        case "session.next.step.started": {
          const messageID = typeof event.assistantMessageID === "string" ? event.assistantMessageID : `anon-${t}`
          const step: StepSpan = {
            assistantMessageID: messageID,
            start: t,
            end: null,
            failed: false,
            model: resolveModelRef(event.model),
            finish: null,
            firstTextAt: null,
            tokens: null,
            cost: null,
            costStatus: null,
          }
          trace.steps.push(step)
          openSteps.set(messageID, step)
          break
        }
        case "session.next.text.started":
        case "session.next.text.delta": {
          for (const step of openSteps.values()) {
            if (step.firstTextAt === null && t >= step.start) step.firstTextAt = t
          }
          break
        }
        case "session.next.step.ended": {
          const messageID = typeof event.assistantMessageID === "string" ? event.assistantMessageID : null
          const step = messageID ? openSteps.get(messageID) : undefined
          if (!step) break
          step.end = t
          openSteps.delete(messageID!)
          step.finish = typeof event.finish === "string" ? event.finish : null
          const tokens = asRecord(event.tokens)
          if (tokens) {
            const cache = asRecord(tokens.cache)
            step.tokens = {
              input: typeof tokens.input === "number" ? tokens.input : 0,
              output: typeof tokens.output === "number" ? tokens.output : 0,
              reasoning: typeof tokens.reasoning === "number" ? tokens.reasoning : 0,
              cacheRead: typeof cache?.read === "number" ? cache.read : 0,
              cacheWrite: typeof cache?.write === "number" ? cache.write : 0,
            }
          }
          if (typeof event.cost === "number" && Number.isFinite(event.cost)) {
            step.cost = event.cost
            step.costStatus = "reported"
          }
          const provenance = asRecord(event.usageProvenance)
          if (provenance) {
            const provModel = resolveModelRef(provenance.modelID) ?? resolveModelRef(provenance)
            if (provModel && !step.model) step.model = provModel
            const cost = asRecord(provenance.cost)
            if (cost && typeof cost.value === "number" && Number.isFinite(cost.value)) {
              step.cost = cost.value
              step.costStatus = typeof cost.status === "string" ? cost.status : "reported"
            }
            const provTokens = asRecord(provenance.tokens)
            if (provTokens) step.tokens = readUsageMetrics(provTokens) ?? step.tokens
          }
          break
        }
        case "session.next.step.failed": {
          const messageID = typeof event.assistantMessageID === "string" ? event.assistantMessageID : null
          const step = messageID ? openSteps.get(messageID) : undefined
          if (step) {
            step.end = t
            step.failed = true
            if (messageID) openSteps.delete(messageID)
          }
          trace.stepFailures.push(errorMessage(event.error))
          break
        }
        case "session.next.tool.called": {
          const callID = typeof event.callID === "string" ? event.callID : `anon-call-${t}`
          const span: ToolSpan = {
            callID,
            tool: typeof event.tool === "string" ? event.tool : "unknown",
            start: t,
            end: null,
            ok: null,
            input: asRecord(event.input),
            structured: null,
            error: null,
          }
          trace.tools.push(span)
          openTools.set(callID, span)
          break
        }
        case "session.next.tool.success": {
          const callID = typeof event.callID === "string" ? event.callID : null
          if (!callID) break
          let span = openTools.get(callID)
          if (!span) {
            span = { callID, tool: "unknown", start: t, end: null, ok: null, input: null, structured: null, error: null }
            trace.tools.push(span)
            openTools.set(callID, span)
          }
          span.end = t
          span.ok = true
          span.structured = asRecord(event.structured)
          openTools.delete(callID)
          break
        }
        case "session.next.tool.failed": {
          const callID = typeof event.callID === "string" ? event.callID : null
          if (!callID) break
          let span = openTools.get(callID)
          if (!span) {
            span = { callID, tool: "unknown", start: t, end: null, ok: null, input: null, structured: null, error: null }
            trace.tools.push(span)
            openTools.set(callID, span)
          }
          span.end = t
          span.ok = false
          span.error = errorMessage(event.error)
          span.structured = asRecord(event.structured)
          openTools.delete(callID)
          if (span.error && isUnsafeDenialMessage(span.error)) trace.blockedUnsafeAttempts++
          break
        }
        case "session.next.shell.started": {
          const callID = typeof event.callID === "string" ? event.callID : `anon-shell-${t}`
          trace.shells.push({ callID, command: typeof event.command === "string" ? event.command : "", start: t, end: null })
          openShells.set(callID, trace.shells[trace.shells.length - 1]!)
          break
        }
        case "session.next.shell.ended": {
          const callID = typeof event.callID === "string" ? event.callID : null
          const shell = callID ? openShells.get(callID) : undefined
          if (shell) {
            shell.end = t
            if (callID) openShells.delete(callID)
          }
          break
        }
        case "session.next.retried": {
          trace.retries++
          break
        }
        case "session.next.compaction.started": {
          trace.compactions++
          break
        }
        case "session.next.model.switched": {
          const model = resolveModelRef(event.model)
          trace.modelSwitches.push({ at: t, model: model ?? "unknown" })
          break
        }
        case "session.context_ledger": {
          const ledger = asRecord(event.ledger)
          if (!ledger) break
          const includedTokens: { value: number; exact: boolean }[] = []
          const entries = Array.isArray(ledger.entries) ? ledger.entries : []
          for (const rawEntry of entries) {
            const entry = asRecord(rawEntry)
            if (!entry || entry.included !== true) continue
            const tokens = asRecord(entry.tokens)
            if (!tokens || typeof tokens.value !== "number") continue
            includedTokens.push({ value: tokens.value, exact: tokens.kind === "exact" })
          }
          trace.ledgers.push({
            at: t,
            requestBytes: typeof ledger.requestBytes === "number" ? ledger.requestBytes : null,
            includedTokens,
          })
          break
        }
        default:
          break
      }
    }
    traces.push(trace)
  }
  traces.sort((a, b) => (a.firstEventAt < b.firstEventAt ? -1 : a.firstEventAt > b.firstEventAt ? 1 : a.sessionID.localeCompare(b.sessionID)))
  return { traces, skippedNoSession }
}

function readUsageMetrics(tokens: Record<string, unknown>): StepSpan["tokens"] {
  const read = (metric: unknown): number | null => {
    const record = asRecord(metric)
    if (!record) return null
    if (typeof record.value === "number" && record.status !== "unknown") return record.value
    return null
  }
  const cache = asRecord(tokens.cache)
  const values = {
    input: read(tokens.input),
    output: read(tokens.output),
    reasoning: read(tokens.reasoning),
    cacheRead: cache ? read(cache.read) : null,
    cacheWrite: cache ? read(cache.write) : null,
  }
  if (values.input === null || values.output === null || values.reasoning === null || values.cacheRead === null || values.cacheWrite === null) {
    // Partial provenance is not a total: never silently zero the missing part.
    return null
  }
  return { input: values.input, output: values.output, reasoning: values.reasoning, cacheRead: values.cacheRead, cacheWrite: values.cacheWrite }
}

export interface TestCandidate {
  readonly at: number
  readonly command: string
  readonly passing: boolean
}

/** Test-classified shell commands in time order, with their observed outcome. */
export function testCandidates(trace: SessionTrace): TestCandidate[] {
  const commandByCall = new Map<string, string>()
  for (const shell of trace.shells) commandByCall.set(shell.callID, shell.command)
  const candidates: TestCandidate[] = []
  const seenCallIDs = new Set<string>()
  for (const tool of trace.tools) {
    if (!isShellTool(tool.tool)) continue
    const fromInput = tool.input && typeof tool.input.command === "string" ? tool.input.command : null
    const command = fromInput ?? commandByCall.get(tool.callID) ?? ""
    if (!command || classifyCommand(command) !== "test") continue
    const exit = extractExitCode(tool.structured)
    const passing = exit !== null ? exit === 0 : tool.ok === true
    candidates.push({ at: tool.start, command, passing })
    seenCallIDs.add(tool.callID)
  }
  // Shell events without a paired tool span still count as triggered tests,
  // but their outcome is unknown, so they never count as passing.
  for (const shell of trace.shells) {
    if (seenCallIDs.has(shell.callID)) continue
    if (classifyCommand(shell.command) !== "test") continue
    candidates.push({ at: shell.start, command: shell.command, passing: false })
  }
  return candidates.sort((a, b) => a.at - b.at)
}
