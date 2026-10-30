/** Nearest-rank percentiles over numeric samples. No averaging shortcuts. */

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  if (p <= 0) return sortedAsc[0] ?? null
  if (p >= 100) return sortedAsc[sortedAsc.length - 1] ?? null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))
  return sortedAsc[idx] ?? null
}

export interface Summary {
  readonly count: number
  readonly median: number | null
  readonly p95: number | null
  readonly min: number | null
  readonly max: number | null
}

export function sortNumbers(values: readonly number[]): number[] {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b)
}

/** Ascending summary of finite values; null when there is no sample at all. */
export function summarize(values: readonly number[]): Summary | null {
  const sorted = sortNumbers(values)
  if (sorted.length === 0) return null
  return {
    count: sorted.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  }
}

export function median(values: readonly number[]): number | null {
  const sorted = sortNumbers(values)
  if (sorted.length === 0) return null
  return percentile(sorted, 50)
}
