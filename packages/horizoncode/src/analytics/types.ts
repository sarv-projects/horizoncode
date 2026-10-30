/**
 * Analytics metric value model.
 *
 * Mirrors arch_V1/31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md §31.11: every
 * numeric metric is measured, estimated or unknown, and carries the basis it
 * was derived from. An unknown metric NEVER carries a fabricated number.
 */

export type MetricStatus = "measured" | "estimated" | "unknown"

export interface MetricValue {
  readonly status: MetricStatus
  /** null whenever status === "unknown". */
  readonly value: number | null
  readonly unit: string
  /** Human-readable derivation / source note (also holds UNKNOWN reasons). */
  readonly basis: string
  /** Number of observations behind the value; 0 when unknown. */
  readonly samples: number
}

export interface MetricDistribution {
  readonly status: MetricStatus
  readonly unit: string
  readonly basis: string
  readonly count: number
  readonly median: number | null
  readonly p95: number | null
  readonly min: number | null
  readonly max: number | null
}

export function measured(value: number, unit: string, basis: string, samples: number): MetricValue {
  return { status: "measured", value, unit, basis, samples }
}

export function estimated(value: number, unit: string, basis: string, samples: number): MetricValue {
  return { status: "estimated", value, unit, basis, samples }
}

export function unknownValue(unit: string, reason: string): MetricValue {
  return { status: "unknown", value: null, unit, basis: reason, samples: 0 }
}

export function unknownDistribution(unit: string, reason: string): MetricDistribution {
  return { status: "unknown", unit, basis: reason, count: 0, median: null, p95: null, min: null, max: null }
}

export function measuredDistribution(
  summary: { count: number; median: number | null; p95: number | null; min: number | null; max: number | null },
  unit: string,
  basis: string,
): MetricDistribution {
  return { status: "measured", unit, basis, count: summary.count, median: summary.median, p95: summary.p95, min: summary.min, max: summary.max }
}
