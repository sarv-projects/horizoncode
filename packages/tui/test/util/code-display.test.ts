import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CODE_DISPLAY_POLICY,
  SyntaxSpanCacheV1,
  codeViewportWindow,
  concealCodeBlock,
  createHighlightScheduler,
  inspectCodeDisplayBounds,
  selectCodeDisplayMode,
  type HighlightJobV1,
} from "../../src/util/code-display"

describe("§31.23 code display policy", () => {
  test("streaming and unknown languages stay plain, small settled surfaces may fully highlight", () => {
    expect(selectCodeDisplayMode({ settled: false, languageKnown: true, lineCount: 3, byteLength: 40 })).toBe("plain")
    expect(selectCodeDisplayMode({ settled: true, languageKnown: false, lineCount: 3, byteLength: 40 })).toBe("plain")
    expect(selectCodeDisplayMode({ settled: true, languageKnown: true, lineCount: 24, byteLength: 1_024 })).toBe("full_highlight")
  })

  test("large settled blocks conceal in the transcript but lazy-highlight only an expanded/review window", () => {
    expect(selectCodeDisplayMode({ settled: true, languageKnown: true, lineCount: 5_001, byteLength: 2_048 })).toBe("conceal")
    expect(selectCodeDisplayMode({
      settled: true,
      languageKnown: true,
      lineCount: 5_000,
      byteLength: 262_144,
      expandedOrReview: true,
    })).toBe("lazy_highlight")
    expect(selectCodeDisplayMode({
      settled: true,
      languageKnown: true,
      lineCount: 5_001,
      byteLength: 262_145,
      expandedOrReview: true,
    })).toBe("conceal")
  })

  test("conceal keeps bounded head/tail lines and reports omitted lines", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n")
    const concealed = concealCodeBlock(text)
    expect(concealed.head).toHaveLength(12)
    expect(concealed.tail).toHaveLength(6)
    expect(concealed.omittedLines).toBe(82)
    expect(concealed.bytes).toBeLessThan(Buffer.byteLength(text, "utf8"))
    expect(concealed.head[0]).toBe("line-0")
    expect(concealed.tail.at(-1)).toBe("line-99")
  })

  test("conceal scans a large source while retaining only its bounded preview lines", () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join("\n")
    const concealed = concealCodeBlock(text)
    expect(concealed.head).toHaveLength(12)
    expect(concealed.tail).toHaveLength(6)
    expect(concealed.omittedLines).toBe(19_982)
    expect(concealed.head[0]).toBe("line-0")
    expect(concealed.tail.at(-1)).toBe("line-19999")
    expect(concealed.bytes).toBe(Buffer.byteLength([...concealed.head, ...concealed.tail].join("\n"), "utf8"))
  })

  test("code display bound inspection stops as soon as a conceal limit is crossed", () => {
    const text = "x\n".repeat(20_000)
    const bounds = inspectCodeDisplayBounds(text, { maxLines: 24, maxBytes: 262_144 })
    expect(bounds).toMatchObject({ exceedsLineLimit: true, exceedsByteLimit: false })
    expect(bounds.scannedChars).toBeLessThan(100)
    expect(bounds.scannedChars).toBeLessThan(text.length)
  })

  test("code display bound inspection counts UTF-8 and stops at the byte cap", () => {
    const text = `${"🙂".repeat(100_000)}\nsmall`
    const bounds = inspectCodeDisplayBounds(text, { maxLines: 24, maxBytes: 32 })
    expect(bounds).toMatchObject({ exceedsLineLimit: false, exceedsByteLimit: true })
    expect(bounds.scannedChars).toBe(18)
  })

  test("viewport windows carry fixed overscan and never slice outside the source", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index}`)
    const middle = codeViewportWindow(lines, { startLine: 50, viewportLines: 20 })
    expect(middle).toMatchObject({ startLine: 42, endLine: 78 })
    expect(middle.lines[0]).toBe("line-42")
    expect(middle.lines.length).toBe(36)
    expect(codeViewportWindow(lines, { startLine: -10, viewportLines: 5 })).toMatchObject({ startLine: 0, endLine: 13 })
    expect(codeViewportWindow(lines, { startLine: 199, viewportLines: 20 }).endLine).toBe(200)
  })

  test("syntax span cache enforces entry/byte caps and drops stale generations", () => {
    const cache = new SyntaxSpanCacheV1<string>({ maxEntries: 3, maxBytes: 10 })
    const generation = { sourceGeneration: "source-1", themeGeneration: "theme-1" }
    expect(cache.set("a", "aaaa", generation, 4)).toBe(true)
    expect(cache.set("b", "bbbb", generation, 4)).toBe(true)
    expect(cache.get("a", generation)).toBe("aaaa")
    expect(cache.set("c", "cccc", generation, 4)).toBe(true)
    expect(cache.set("d", "dddd", generation, 4)).toBe(true)
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 8 })
    expect(cache.get("a", { ...generation, themeGeneration: "theme-2" })).toBeUndefined()
    expect(cache.set("too-large", "x", generation, 11)).toBe(false)
  })

  test("highlight scheduler keeps a bounded latest-per-key queue and drops stale results", async () => {
    const resolved: Array<{ job: HighlightJobV1; value: string }> = []
    const pendingRuns: Array<() => void> = []
    const scheduler = createHighlightScheduler({
      policy: { ...DEFAULT_CODE_DISPLAY_POLICY, maxConcurrentHighlightJobs: 1 },
      run: (job) => new Promise<string>((resolve) => pendingRuns.push(() => resolve(`highlight:${job.text}`))),
      onResult: (job, result) => resolved.push({ job, value: String(result) }),
    })
    scheduler.generation("source-1", "theme-1")
    const base = { sourceGeneration: "source-1", themeGeneration: "theme-1", lineStart: 0, lineEnd: 10 }
    scheduler.schedule({ ...base, key: "block", text: "a" })
    scheduler.schedule({ ...base, key: "block", text: "ab" })
    scheduler.schedule({ ...base, key: "block", text: "abc" })
    expect(scheduler.stats()).toMatchObject({ running: 1, coalesced: 1 })
    pendingRuns.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved.at(-1)?.value).toBe("highlight:a")
    // The coalesced latest viewport for "block" paints next.
    expect(scheduler.stats()).toMatchObject({ running: 1, coalesced: 1, completed: 1 })

    scheduler.generation("source-2", "theme-1")
    pendingRuns.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toHaveLength(1)
    expect(scheduler.stats().dropped).toBeGreaterThan(0)
  })

  test("default policy matches the documented safety defaults", () => {
    expect(DEFAULT_CODE_DISPLAY_POLICY).toMatchObject({
      defaultMode: "conceal",
      concealAfterLines: 24,
      lazyHighlightMaxBytes: 262_144,
      viewportOverscanLines: 8,
      maxConcurrentHighlightJobs: 2,
    })
  })
})
