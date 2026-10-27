import type { SvgRasterObservationV1 } from "./artifact-render"
import { redactToolText } from "./collapse-tool-output"

export type TuiArtifactMetricV1 =
  | "ui.artifact.render_full"
  | "ui.artifact.render_sample"
  | "ui.artifact.render_failed"
  | "ui.artifact.raster_cache_entries"
  | "ui.artifact.raster_cache_bytes"
  | "ui.artifact.raster_requests"
  | "ui.artifact.raster_completed"
  | "ui.artifact.raster_failed"

export type TuiArtifactObservationV1 = {
  metric: TuiArtifactMetricV1
  value: number
  unit: "entries" | "bytes" | "events" | "renders"
  provenance: "measured" | "unknown"
  source: "svg-raster-port" | "tui-artifact-renderer"
  observedAtMs?: number
}

type TuiObservationV1 = {
  metric: string
  value: number
  unit: string
  provenance: "measured" | "estimated" | "unknown"
  source: string
  observedAtMs?: number
}

type UsageMetricV1 = { readonly status: "provider-reported" | "measured" | "estimated"; readonly value: number } | { readonly status: "unknown" }

const MAX_USAGE_MESSAGES = 256
const MAX_USAGE_PARTS = 8_192

function analyticsArray(value: unknown): { readonly isArray: boolean; readonly value?: unknown[] } | undefined {
  try {
    return Array.isArray(value) ? { isArray: true, value } : { isArray: false }
  } catch {
    return
  }
}

function analyticsRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return
  const array = analyticsArray(value)
  if (!array || array.isArray) return
  return value as Record<string, unknown>
}

function ownDataProperty(record: Readonly<Record<string, unknown>>, key: string) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function safeIdentity(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:/+=@~-]{1,128}$/.test(value)
    ? value
    : undefined
}

function usageMetric(value: unknown): UsageMetricV1 | undefined {
  const metric = analyticsRecord(value)
  if (!metric) return
  const status = ownDataProperty(metric, "status")
  if (status === "unknown") {
    if (ownDataProperty(metric, "value") !== undefined) return
    return { status: "unknown" }
  }
  const rawValue = ownDataProperty(metric, "value")
  if (
    (status !== "provider-reported" && status !== "measured" && status !== "estimated") ||
    !Number.isSafeInteger(rawValue) || (rawValue as number) < 0
  ) return
  return { status, value: rawValue as number }
}

function usageMetricText(value: unknown) {
  const metric = usageMetric(value)
  return metric?.status === "unknown" || !metric ? "unknown" : `${metric.status}:${metric.value}`
}

function usageCostText(value: unknown, hasRequestIdentity: boolean) {
  const cost = analyticsRecord(value)
  if (!cost) return "unknown"
  const status = ownDataProperty(cost, "status")
  const rawValue = ownDataProperty(cost, "value")
  if (status === "unknown") return "unknown"
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) return "unknown"
  if (status === "provider-reported") {
    return hasRequestIdentity ? `provider-reported:${rawValue} via provider response` : "unknown"
  }
  if (status === "measured") {
    const measurementSource = ownDataProperty(cost, "measurementSource")
    if (measurementSource !== "provider-billing-receipt-v1" || !safeIdentity(ownDataProperty(cost, "evidenceRef"))) return "unknown"
    return `measured:${rawValue} via ${measurementSource}`
  }
  if (status === "estimated") {
    const priceSource = ownDataProperty(cost, "priceSource")
    const pricingRevision = ownDataProperty(cost, "pricingRevision")
    const pricing = analyticsRecord(ownDataProperty(cost, "pricing"))
    const tokenInputs = analyticsRecord(ownDataProperty(cost, "tokenInputs"))
    const algorithm = ownDataProperty(cost, "algorithm")
    if (
      !safeIdentity(priceSource) ||
      typeof pricingRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(pricingRevision) ||
      algorithm !== "per-million-linear-v1" ||
      !pricing || !["input", "output", "cacheRead", "cacheWrite"].map((key) => ownDataProperty(pricing, key)).every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0) ||
      !tokenInputs || ["input", "output", "reasoning", "cacheRead", "cacheWrite"].map((key) => ownDataProperty(tokenInputs, key)).some((item) => !Number.isSafeInteger(item) || (item as number) < 0)
    ) return "unknown"
    return `estimated:${rawValue} via ${priceSource} (${pricingRevision.slice(0, 19)})`
  }
  return "unknown"
}

const TOKEN_FIELDS = [
  ["input", "Input"],
  ["output", "Output"],
  ["reasoning", "Reasoning"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
] as const

type UsageQuality = "provider-reported" | "measured" | "estimated"

function tokenField(tokens: Record<string, unknown> | undefined, field: (typeof TOKEN_FIELDS)[number][0]) {
  if (!tokens) return undefined
  if (field === "cacheRead" || field === "cacheWrite") {
    const cache = analyticsRecord(ownDataProperty(tokens, "cache"))
    return cache && ownDataProperty(cache, field === "cacheRead" ? "read" : "write")
  }
  return ownDataProperty(tokens, field)
}

type UsageObservationV1 = {
  readonly provenance?: Record<string, unknown>
  readonly messageID: string
  readonly stepFinishIndex?: number
  readonly unknownReason?: string
}

function usageObservations(
  assistantMessages: readonly unknown[],
  partsByMessage: Readonly<Record<string, readonly unknown[]>> = {},
): UsageObservationV1[] {
  const observations: UsageObservationV1[] = []
  let scannedParts = 0
  for (const rawMessage of assistantMessages) {
    const message = analyticsRecord(rawMessage)
    const messageID = safeIdentity(message && ownDataProperty(message, "id")) ?? "unknown"
    const candidateParts = ownDataProperty(partsByMessage, messageID)
    const parts = analyticsArray(candidateParts)?.value ?? []
    const stepObservations: UsageObservationV1[] = []
    let truncated = false
    for (const rawPart of parts) {
      if (scannedParts >= MAX_USAGE_PARTS) {
        truncated = true
        break
      }
      scannedParts++
      const part = analyticsRecord(rawPart)
      if (!part || ownDataProperty(part, "type") !== "step-finish") continue
      const rawIndex = ownDataProperty(part, "stepFinishIndex")
      const stepFinishIndex = Number.isSafeInteger(rawIndex) && (rawIndex as number) >= 0
        ? rawIndex as number
        : undefined
      const provenance = analyticsRecord(ownDataProperty(part, "usageProvenance"))
      if (provenance) {
        stepObservations.push({ provenance, messageID, ...(stepFinishIndex === undefined ? {} : { stepFinishIndex }) })
      } else {
        stepObservations.push({ messageID, ...(stepFinishIndex === undefined ? {} : { stepFinishIndex }), unknownReason: "step usage provenance unavailable" })
      }
    }
    if (stepObservations.length > 0) {
        const assistantProvenance = analyticsRecord(message && ownDataProperty(message, "usageProvenance"))
      const lastStep = stepObservations.at(-1)
      if (assistantProvenance && lastStep && !lastStep.provenance) {
        // Older projections may lack the new per-step part field while still
        // carrying the last step's provenance on Assistant.info. Attribute it
        // only to that final missing step; earlier steps remain UNKNOWN.
        stepObservations[stepObservations.length - 1] = {
          provenance: assistantProvenance,
          messageID,
          ...(lastStep.stepFinishIndex === undefined ? {} : { stepFinishIndex: lastStep.stepFinishIndex }),
        }
      }
      observations.push(...stepObservations)
    } else {
      // Older projections may expose only the assistant-level record. Use it
      // only when no per-step receipts exist, avoiding a duplicate of the last
      // step that the assistant projection also carries.
      const provenance = analyticsRecord(message && ownDataProperty(message, "usageProvenance"))
      observations.push(provenance ? { provenance, messageID } : { messageID, unknownReason: "usage provenance unavailable" })
    }
    if (truncated) observations.push({ messageID, unknownReason: "usage history exceeded the bounded analytics scan" })
  }
  return observations
}

type TokenAggregateV1 = {
  /** Sum per quality. Kept separate from `counts` so a known zero stays known. */
  values: Record<UsageQuality, bigint>
  /** How many observations supplied a known metric of each quality. */
  counts: Record<UsageQuality, number>
  unknown: number
}

function tokenTotals(observations: readonly UsageObservationV1[]) {
  const totals = new Map<string, TokenAggregateV1>()
  for (const [field] of TOKEN_FIELDS) {
    totals.set(field, {
      values: { "provider-reported": 0n, measured: 0n, estimated: 0n },
      counts: { "provider-reported": 0, measured: 0, estimated: 0 },
      unknown: 0,
    })
  }
  const costs: Record<UsageQuality, number> = { "provider-reported": 0, measured: 0, estimated: 0 }
  let unknownCosts = 0

  for (const observation of observations) {
    const provenance = observation.provenance
    const tokens = analyticsRecord(provenance?.tokens)
    const cache = analyticsRecord(tokens?.cache)
    const identityValid = Boolean(
      safeIdentity(provenance?.providerID) &&
      safeIdentity(provenance?.modelID) &&
      tokens && cache,
    )

    for (const [field] of TOKEN_FIELDS) {
      const aggregate = totals.get(field)!
      const metric = identityValid ? usageMetric(tokenField(tokens, field)) : undefined
      if (!metric || metric.status === "unknown") {
        aggregate.unknown++
        continue
      }
      aggregate.values[metric.status] += BigInt(metric.value)
      aggregate.counts[metric.status]++
    }

    const costText = usageCostText(
      provenance?.cost,
      identityValid && analyticsCostHasRequestIdentity(safeIdentity(provenance?.requestID)),
    )
    const costStatus = costText === "unknown" ? undefined : costText.slice(0, costText.indexOf(":")) as UsageQuality
    if (costStatus && Object.hasOwn(costs, costStatus)) costs[costStatus]++
    else unknownCosts++
  }

  const renderMetric = (field: (typeof TOKEN_FIELDS)[number][0], label: string) => {
    const aggregate = totals.get(field)!
    // Report every quality that *supplied* a value, even when the sum is zero:
    // a provider-reported zero is known, and §31.19 forbids relabelling it as
    // unknown provenance. `counts` therefore gates the segment, not the sum.
    const parts = (Object.keys(aggregate.counts) as UsageQuality[])
      .filter((quality) => aggregate.counts[quality] > 0)
      .map((quality) => `${quality} ${aggregate.values[quality]}`)
    if (aggregate.unknown > 0) parts.push(`unknown ${aggregate.unknown}`)
    // No observation touched this bucket at all: there is no evidence.
    if (parts.length === 0) parts.push("unknown 0")
    return `${label}: ${parts.join(" + ")}`
  }

  const tokenSummary = `Token totals for recent provider steps: ${TOKEN_FIELDS.map(([field, label]) => renderMetric(field, label)).join(" · ")}`
  const costSummary = `Cost observations (no cross-route sum; V1 does not declare a currency): provider-reported ${costs["provider-reported"]} · estimated ${costs.estimated} · measured ${costs.measured} · unknown ${unknownCosts}`
  return [tokenSummary, costSummary]
}

/**
 * Read-only, bounded view of current canonical assistant-message usage.
 * Legacy scalar token/cost fields are intentionally ignored; absent or invalid
 * UsageProvenance remains unknown instead of becoming a fabricated zero.
 */
export function projectSessionUsage(
  messages: readonly unknown[],
  maxRows = 8,
  partsByMessage: Readonly<Record<string, readonly unknown[]>> = {},
): readonly string[] {
  const rowLimit = Number.isSafeInteger(maxRows) ? Math.min(16, Math.max(0, maxRows)) : 0
  // Do not scan or retain an unbounded transcript just to populate a debug
  // panel. Counts below describe this recent-message window, not the whole
  // Session history.
  const recentMessages = messages.slice(Math.max(0, messages.length - MAX_USAGE_MESSAGES))
  const assistantMessages = recentMessages.filter((message) => {
    const record = analyticsRecord(message)
    return record && ownDataProperty(record, "role") === "assistant"
  })
  const observations = usageObservations(assistantMessages, partsByMessage)
  const rows: string[] = []
  let attributed = 0
  let unknown = 0

  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index]!
    const provenance = observation.provenance
    if (!provenance) {
      unknown++
      if (rows.length < rowLimit) rows.push(`Usage unavailable · ${observation.unknownReason ?? "missing provenance"}`)
      continue
    }
    const providerID = safeIdentity(provenance.providerID)
    const modelID = safeIdentity(provenance.modelID)
    const operationID = safeIdentity(provenance.operationID)
    const requestID = safeIdentity(provenance.requestID)
    const tokens = analyticsRecord(provenance.tokens)
    const cache = analyticsRecord(tokens?.cache)
    if (!providerID || !modelID || !tokens || !cache) {
      unknown++
      if (rows.length < rowLimit) rows.push("Usage unavailable · identity or token provenance is malformed")
      continue
    }
    attributed++
    if (rows.length >= rowLimit) continue
    const cost = usageCostText(provenance.cost, analyticsCostHasRequestIdentity(requestID))
    const step = observation.stepFinishIndex === undefined ? "" : ` · step ${observation.stepFinishIndex}`
    const identity = `${providerID}/${modelID} · request ${requestID ?? "unknown"} · operation ${operationID ?? "unknown"}${step}`
    rows.push(
      `${identity} · in ${usageMetricText(tokenField(tokens, "input"))} · out ${usageMetricText(tokenField(tokens, "output"))} · reasoning ${usageMetricText(tokenField(tokens, "reasoning"))} · cache read ${usageMetricText(tokenField(tokens, "cacheRead"))} · cache write ${usageMetricText(tokenField(tokens, "cacheWrite"))} · cost ${cost}`,
    )
  }

  const total = observations.length
  return [
    `Recent usage (last ${recentMessages.length} Session messages): ${assistantMessages.length} assistant messages · ${total} provider steps/records · ${attributed} provenance ${attributed === 1 ? "record" : "records"} · ${unknown} unknown`,
    ...rows,
    ...tokenTotals(observations),
  ]
}

function analyticsCostHasRequestIdentity(requestID: string | undefined) {
  return Boolean(requestID)
}

const OBSERVATION_FORMATS: Record<string, { label: string; unit: string; source: string }> = {
  "ui.artifact.render_full": { label: "Artifact render full", unit: "renders", source: "tui-artifact-renderer" },
  "ui.artifact.render_sample": { label: "Artifact render sample", unit: "renders", source: "tui-artifact-renderer" },
  "ui.artifact.render_failed": { label: "Artifact render failed", unit: "renders", source: "tui-artifact-renderer" },
  "ui.artifact.raster_cache_entries": { label: "Artifact raster cache entries", unit: "entries", source: "svg-raster-port" },
  "ui.artifact.raster_cache_bytes": { label: "Artifact raster cache bytes", unit: "bytes", source: "svg-raster-port" },
  "ui.artifact.raster_requests": { label: "Artifact raster requests", unit: "events", source: "svg-raster-port" },
  "ui.artifact.raster_completed": { label: "Artifact raster completed", unit: "events", source: "svg-raster-port" },
  "ui.artifact.raster_failed": { label: "Artifact raster failed", unit: "events", source: "svg-raster-port" },
  "ui.queue.pending_events": { label: "Queue pending events", unit: "events", source: "ui-event-mux" },
  "ui.queue.pending_bytes": { label: "Queue pending bytes", unit: "bytes", source: "ui-event-mux" },
  "ui.queue.coalesced_events": { label: "Queue coalesced events", unit: "events", source: "ui-event-mux" },
  "ui.queue.dropped_events": { label: "Queue dropped events", unit: "events", source: "ui-event-mux" },
  "ui.queue.direct_deliveries": { label: "Queue direct deliveries", unit: "events", source: "ui-event-mux" },
  "ui.stream.duplicates_suppressed": { label: "Stream duplicates suppressed", unit: "events", source: "ui-event-mux" },
  "ui.stream.resnapshots_required": { label: "Stream resnapshots required", unit: "events", source: "ui-event-mux" },
}

/** Formats only allowlisted metric/source/unit tuples; arbitrary observation data is never copied. */
export function formatTuiObservation(observation: TuiObservationV1, nowMs = Date.now()) {
  const format = typeof observation.metric === "string" && Object.hasOwn(OBSERVATION_FORMATS, observation.metric)
    ? OBSERVATION_FORMATS[observation.metric]
    : undefined
  const validProvenance = observation.provenance === "measured" || observation.provenance === "estimated" || observation.provenance === "unknown"
  const validValue = Number.isSafeInteger(observation.value) && observation.value >= 0
  const validTuple = format && observation.unit === format.unit && observation.source === format.source && validProvenance && validValue
  const label = format?.label ?? "Metric unavailable"
  const provenance = validTuple ? observation.provenance : "unknown"
  // An unknown observation may carry a numeric placeholder for schema/transport
  // compatibility. Do not render that placeholder as a measured zero (or any
  // other value); provenance is part of the value's truth contract.
  const value = validTuple && format && observation.provenance !== "unknown"
    ? `${observation.value} ${format.unit}`
    : "unknown"
  const fresh =
    validTuple &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    Number.isSafeInteger(observation.observedAtMs) &&
    observation.observedAtMs! >= 0 &&
    observation.observedAtMs! <= nowMs
      ? `${Math.floor(Math.max(0, nowMs - observation.observedAtMs!) / 1000)}s old`
      : "unknown freshness"
  return {
    label,
    value: `${value}, ${provenance}${validTuple && format ? ` via ${format.source}` : ""}, ${fresh}`,
  }
}

const METRICS = [
  "ui.artifact.render_full",
  "ui.artifact.render_sample",
  "ui.artifact.render_failed",
  "ui.artifact.raster_cache_entries",
  "ui.artifact.raster_cache_bytes",
  "ui.artifact.raster_requests",
  "ui.artifact.raster_completed",
  "ui.artifact.raster_failed",
] as const satisfies readonly TuiArtifactMetricV1[]

const SOURCES: Record<TuiArtifactMetricV1, TuiArtifactObservationV1["source"]> = {
  "ui.artifact.render_full": "tui-artifact-renderer",
  "ui.artifact.render_sample": "tui-artifact-renderer",
  "ui.artifact.render_failed": "tui-artifact-renderer",
  "ui.artifact.raster_cache_entries": "svg-raster-port",
  "ui.artifact.raster_cache_bytes": "svg-raster-port",
  "ui.artifact.raster_requests": "svg-raster-port",
  "ui.artifact.raster_completed": "svg-raster-port",
  "ui.artifact.raster_failed": "svg-raster-port",
}

const UNITS: Record<TuiArtifactMetricV1, TuiArtifactObservationV1["unit"]> = {
  "ui.artifact.render_full": "renders",
  "ui.artifact.render_sample": "renders",
  "ui.artifact.render_failed": "renders",
  "ui.artifact.raster_cache_entries": "entries",
  "ui.artifact.raster_cache_bytes": "bytes",
  "ui.artifact.raster_requests": "events",
  "ui.artifact.raster_completed": "events",
  "ui.artifact.raster_failed": "events",
}

const MAX_TOTAL = Number.MAX_SAFE_INTEGER
const MAX_RENDERERS = 16
const MAX_OBSERVATIONS_PER_REPORT = 8

export type DiagnosticExportEntryV1 = { readonly label?: unknown; readonly value?: unknown }

/**
 * §31.16: diagnostic export is local and redacted unless explicitly approved.
 * AN-007 additionally requires that no secret or raw content reaches an export
 * unless it was explicitly selected, so every row passes through the shared
 * recursive redaction path and the assembled payload carries an explicit byte
 * bound with a truncation marker rather than growing with the session.
 */
export const DIAGNOSTIC_EXPORT_MAX_BYTES = 64 * 1024
const DIAGNOSTIC_ROW_MAX_BYTES = 4 * 1024
const DIAGNOSTIC_LABEL_MAX_BYTES = 128
const DIAGNOSTIC_TRUNCATION_MARKER = "[diagnostic export truncated]"
const EXPORT_ENCODER = new TextEncoder()

function utf8Prefix(value: string, maxBytes: number) {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
    const paired = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    const size = paired ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (bytes + size > maxBytes) break
    bytes += size
    index += paired ? 2 : 1
  }
  return value.slice(0, index)
}

function diagnosticRow(entry: unknown): { line: string; clipped: boolean } | undefined {
  // Shape validation happens before anything is copied: a derived or
  // malformed row can never contribute a partially-typed fragment.
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
  const record = entry as Record<string, unknown>
  if (typeof record.label !== "string" || typeof record.value !== "string") return
  const label = redactToolText(record.label)
  const redacted = redactToolText(record.value)
  const clipped = EXPORT_ENCODER.encode(redacted).length > DIAGNOSTIC_ROW_MAX_BYTES
  const value = utf8Prefix(redacted, DIAGNOSTIC_ROW_MAX_BYTES)
  return { line: `${utf8Prefix(label, DIAGNOSTIC_LABEL_MAX_BYTES)}: ${value}`, clipped }
}

/** Assembles a bounded, redacted, shape-validated local diagnostic export. */
export function buildDiagnosticExport(entries: readonly unknown[]): string {
  const markerBytes = EXPORT_ENCODER.encode(`\n${DIAGNOSTIC_TRUNCATION_MARKER}`).length
  const budget = Math.max(0, DIAGNOSTIC_EXPORT_MAX_BYTES - markerBytes)
  const lines: string[] = []
  let bytes = 0
  let truncated = false

  for (const entry of entries) {
    const row = diagnosticRow(entry)
    if (!row) continue
    if (row.clipped) truncated = true
    const separator = lines.length > 0 ? 1 : 0
    const size = EXPORT_ENCODER.encode(row.line).length + separator
    if (bytes + size > budget) {
      truncated = true
      break
    }
    lines.push(row.line)
    bytes += size
  }

  return truncated ? `${lines.join("\n")}\n${DIAGNOSTIC_TRUNCATION_MARKER}` : lines.join("\n")
}

/** Fixed-cardinality, content-free process-local projection for the TUI debug panel. */
export function createTuiAnalyticsProjection(now: () => number = Date.now) {
  const totals = new Map<TuiArtifactMetricV1, number>(METRICS.map((metric) => [metric, 0]))
  const freshness = new Map<TuiArtifactMetricV1, number>()
  const cacheBytesByReporter = new Map<number, { value: number; observedAtMs: number }>()
  const cacheEntriesByReporter = new Map<number, { value: number; observedAtMs: number }>()
  let activeReporters = 0
  let nextReporterID = 0

  return {
    attachArtifactRenderer() {
      if (activeReporters >= MAX_RENDERERS) {
        return { observe(_observations: readonly SvgRasterObservationV1[]) {}, dispose() {} }
      }
      activeReporters++
      const reporterID = ++nextReporterID
      const previous = new Map<TuiArtifactMetricV1, number>()
      let disposed = false
      return {
        observe(observations: readonly SvgRasterObservationV1[]) {
          if (disposed) return
          for (let index = 0; index < observations.length && index < MAX_OBSERVATIONS_PER_REPORT; index++) {
            const observation = observations[index]
            if (!observation) continue
            if (!METRICS.includes(observation.metric as TuiArtifactMetricV1)) continue
            const metric = observation.metric as TuiArtifactMetricV1
            if (
              observation.source !== SOURCES[metric] ||
              observation.provenance !== "measured" ||
              observation.unit !== UNITS[metric] ||
              !Number.isSafeInteger(observation.value) ||
              observation.value < 0 ||
              !Number.isSafeInteger(observation.observedAtMs) ||
              observation.observedAtMs < 0 ||
              observation.observedAtMs > now()
            )
              continue

            if (metric === "ui.artifact.raster_cache_bytes" || metric === "ui.artifact.raster_cache_entries") {
              // Cache size is a live gauge, not a lifetime counter. Keep one
              // value per renderer, replace it when eviction changes the
              // cache, and sum only currently attached renderers in snapshot().
              const gauges = metric === "ui.artifact.raster_cache_bytes" ? cacheBytesByReporter : cacheEntriesByReporter
              const previousGauge = gauges.get(reporterID)
              if (previousGauge && observation.observedAtMs < previousGauge.observedAtMs) continue
              gauges.set(reporterID, {
                value: observation.value,
                observedAtMs: observation.observedAtMs,
              })
              continue
            }

            const last = previous.get(metric) ?? 0
            if (observation.value < last) continue
            const delta = observation.value - last
            previous.set(metric, observation.value)
            totals.set(metric, Math.min(MAX_TOTAL, (totals.get(metric) ?? 0) + delta))
            freshness.set(metric, Math.max(freshness.get(metric) ?? 0, observation.observedAtMs))
          }
        },
        dispose() {
          if (disposed) return
          disposed = true
          activeReporters--
          cacheBytesByReporter.delete(reporterID)
          cacheEntriesByReporter.delete(reporterID)
          previous.clear()
        },
      }
    },
    snapshot(): readonly TuiArtifactObservationV1[] {
      return METRICS.map<TuiArtifactObservationV1>((metric) => {
        if (metric === "ui.artifact.raster_cache_bytes" || metric === "ui.artifact.raster_cache_entries") {
          const gauges = metric === "ui.artifact.raster_cache_bytes" ? cacheBytesByReporter : cacheEntriesByReporter
          const current = [...gauges.values()]
          return {
            metric,
            value: current.reduce((sum, item) => Math.min(MAX_TOTAL, sum + item.value), 0),
            unit: UNITS[metric],
            provenance: current.length > 0 ? "measured" : "unknown",
            source: SOURCES[metric],
            observedAtMs: current.reduce<number | undefined>(
              (latest, item) => Math.max(latest ?? 0, item.observedAtMs),
              undefined,
            ),
          }
        }
        return {
          metric,
          value: totals.get(metric) ?? 0,
          unit: UNITS[metric],
          provenance: freshness.has(metric) ? "measured" : "unknown",
          source: SOURCES[metric],
          observedAtMs: freshness.get(metric),
        }
      })
    },
  }
}

/** Singleton projection used by all mounted session routes and the Debug panel. */
export const tuiAnalyticsProjection = createTuiAnalyticsProjection()
