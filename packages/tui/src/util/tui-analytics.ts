import type { SvgRasterObservationV1 } from "./artifact-render"

export type TuiArtifactMetricV1 =
  | "ui.artifact.render_full"
  | "ui.artifact.render_sample"
  | "ui.artifact.render_failed"
  | "ui.artifact.raster_cache_bytes"
  | "ui.artifact.raster_requests"
  | "ui.artifact.raster_completed"
  | "ui.artifact.raster_failed"

export type TuiArtifactObservationV1 = {
  metric: TuiArtifactMetricV1
  value: number
  unit: "bytes" | "events" | "renders"
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

/** Formats only typed metric fields; arbitrary observation payloads are never copied. */
export function formatTuiObservation(observation: TuiObservationV1, nowMs = Date.now()) {
  const words = observation.metric.replace(/^ui\./, "").replaceAll(".", " ").replaceAll("_", " ")
  const label = words.length ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Metric"
  const fresh =
    Number.isSafeInteger(observation.observedAtMs) &&
    observation.observedAtMs! >= 0 &&
    observation.observedAtMs! <= nowMs
      ? `${Math.floor(Math.max(0, nowMs - observation.observedAtMs!) / 1000)}s old`
      : "unknown freshness"
  return {
    label,
    value: `${observation.value} ${observation.unit}, ${observation.provenance} via ${observation.source}, ${fresh}`,
  }
}

const METRICS = [
  "ui.artifact.render_full",
  "ui.artifact.render_sample",
  "ui.artifact.render_failed",
  "ui.artifact.raster_cache_bytes",
  "ui.artifact.raster_requests",
  "ui.artifact.raster_completed",
  "ui.artifact.raster_failed",
] as const satisfies readonly TuiArtifactMetricV1[]

const SOURCES: Record<TuiArtifactMetricV1, TuiArtifactObservationV1["source"]> = {
  "ui.artifact.render_full": "tui-artifact-renderer",
  "ui.artifact.render_sample": "tui-artifact-renderer",
  "ui.artifact.render_failed": "tui-artifact-renderer",
  "ui.artifact.raster_cache_bytes": "svg-raster-port",
  "ui.artifact.raster_requests": "svg-raster-port",
  "ui.artifact.raster_completed": "svg-raster-port",
  "ui.artifact.raster_failed": "svg-raster-port",
}

const UNITS: Record<TuiArtifactMetricV1, TuiArtifactObservationV1["unit"]> = {
  "ui.artifact.render_full": "renders",
  "ui.artifact.render_sample": "renders",
  "ui.artifact.render_failed": "renders",
  "ui.artifact.raster_cache_bytes": "bytes",
  "ui.artifact.raster_requests": "events",
  "ui.artifact.raster_completed": "events",
  "ui.artifact.raster_failed": "events",
}

const MAX_TOTAL = Number.MAX_SAFE_INTEGER
const MAX_RENDERERS = 16
const MAX_OBSERVATIONS_PER_REPORT = 8

/** Fixed-cardinality, content-free process-local projection for the TUI debug panel. */
export function createTuiAnalyticsProjection(now: () => number = Date.now) {
  const totals = new Map<TuiArtifactMetricV1, number>(METRICS.map((metric) => [metric, 0]))
  const freshness = new Map<TuiArtifactMetricV1, number>()
  let activeReporters = 0

  return {
    attachArtifactRenderer() {
      if (activeReporters >= MAX_RENDERERS) {
        return { observe(_observations: readonly SvgRasterObservationV1[]) {}, dispose() {} }
      }
      activeReporters++
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
          previous.clear()
        },
      }
    },
    snapshot(): readonly TuiArtifactObservationV1[] {
      return METRICS.map((metric) => ({
        metric,
        value: totals.get(metric) ?? 0,
        unit: UNITS[metric],
        provenance: freshness.has(metric) ? "measured" : "unknown",
        source: SOURCES[metric],
        observedAtMs: freshness.get(metric),
      }))
    },
  }
}

/** Singleton projection used by all mounted session routes and the Debug panel. */
export const tuiAnalyticsProjection = createTuiAnalyticsProjection()
