import { describe, expect, test } from "bun:test"
import { median, percentile, sortNumbers, summarize } from "../src/analytics/percentile"

describe("percentile (nearest-rank)", () => {
  test("empty sample yields null, never a fabricated number", () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([], 95)).toBeNull()
    expect(summarize([])).toBeNull()
    expect(median([])).toBeNull()
  })

  test("p50 and p95 use nearest rank", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
    expect(percentile([1, 2, 3, 4], 95)).toBe(4)
    expect(percentile([42, 58, 64, 71, 91, 128, 300], 50)).toBe(71)
    expect(percentile([42, 58, 64, 71, 91, 128, 300], 95)).toBe(300)
    expect(percentile([10], 50)).toBe(10)
    expect(percentile([10], 95)).toBe(10)
    expect(percentile([0, 1], 50)).toBe(0)
    expect(percentile([0, 1], 95)).toBe(1)
  })

  test("p0 and p100 clamp to ends", () => {
    expect(percentile([5, 9], 0)).toBe(5)
    expect(percentile([5, 9], 100)).toBe(9)
  })

  test("summarize sorts, filters non-finite values and reports min/max", () => {
    const summary = summarize([300, Number.NaN, 400, 100])
    expect(summary).toEqual({ count: 3, median: 300, p95: 400, min: 100, max: 400 })
  })

  test("sortNumbers returns ascending finite values", () => {
    expect(sortNumbers([3, 1, Number.POSITIVE_INFINITY, 2])).toEqual([1, 2, 3])
  })
})
