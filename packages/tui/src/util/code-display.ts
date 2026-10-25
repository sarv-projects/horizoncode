/**
 * §31.23 code display and syntax-highlight RAM policy.
 *
 * Presentation-only helpers: they never read canonical files, never authorize a
 * workspace mutation, and never retain a second unbounded copy of code text.
 * The renderer keeps canonical bytes in the Session part / SourceArtifact and
 * asks this module only which bounded display mode and viewport window to paint.
 */

export type CodeDisplayModeV1 = "plain" | "conceal" | "lazy_highlight" | "full_highlight"

export type CodeDisplayPolicyV1 = {
  readonly defaultMode: CodeDisplayModeV1
  readonly concealAfterLines: number
  readonly lazyHighlightMaxLines: number
  readonly lazyHighlightMaxBytes: number
  readonly viewportOverscanLines: number
  readonly maxConcurrentHighlightJobs: number
}

/** Initial safety defaults from §31.23.2; tuning candidates, not perf claims. */
export const DEFAULT_CODE_DISPLAY_POLICY: CodeDisplayPolicyV1 = Object.freeze({
  defaultMode: "conceal",
  concealAfterLines: 24,
  lazyHighlightMaxLines: 5_000,
  lazyHighlightMaxBytes: 262_144,
  viewportOverscanLines: 8,
  maxConcurrentHighlightJobs: 2,
})

export type CodeDisplaySelectionInputV1 = {
  readonly settled: boolean
  readonly languageKnown: boolean
  readonly lineCount: number
  readonly byteLength: number
  readonly expandedOrReview?: boolean
}

const utf8 = new TextEncoder()

export function codeTextBytes(text: string): number {
  return utf8.encode(text).byteLength
}

export type CodeDisplayBoundsV1 = {
  readonly exceedsLineLimit: boolean
  readonly exceedsByteLimit: boolean
  readonly scannedChars: number
}

/**
 * Inspect just enough source to decide whether a code surface must be
 * concealed. `scannedChars` is intentionally exposed for deterministic
 * bounded-work tests; it is not a latency or performance measurement.
 */
export function inspectCodeDisplayBounds(
  text: string,
  limits: { readonly maxLines: number; readonly maxBytes: number },
): CodeDisplayBoundsV1 {
  const maxLines = boundedCount(limits.maxLines)
  const maxBytes = boundedCount(limits.maxBytes)
  let lines = 1
  let bytes = 0
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index)
    let width: number
    if (code === 10) lines++
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4
        index += 2
      } else {
        width = 3
        index++
      }
    } else {
      width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
      index++
    }
    bytes += width
    if (lines > maxLines || bytes > maxBytes) {
      return { exceedsLineLimit: lines > maxLines, exceedsByteLimit: bytes > maxBytes, scannedChars: index }
    }
  }
  return { exceedsLineLimit: false, exceedsByteLimit: false, scannedChars: text.length }
}

/**
 * Select the bounded display mode for one code surface.
 *
 * Streaming text and unknown languages stay plain. Settled text above either
 * cap is concealed in the transcript; an expanded card/review overlay may use
 * lazy highlighting on the visible window only. Full highlighting is reserved
 * for a surface already under both caps.
 */
export function selectCodeDisplayMode(
  input: CodeDisplaySelectionInputV1,
  policy: CodeDisplayPolicyV1 = DEFAULT_CODE_DISPLAY_POLICY,
): CodeDisplayModeV1 {
  const lines = boundedCount(input.lineCount)
  const bytes = boundedCount(input.byteLength)
  if (!input.settled || !input.languageKnown) return "plain"
  if (lines <= policy.concealAfterLines && bytes <= policy.lazyHighlightMaxBytes) return "full_highlight"
  if (input.expandedOrReview) {
    return lines <= policy.lazyHighlightMaxLines && bytes <= policy.lazyHighlightMaxBytes
      ? "lazy_highlight"
      : "conceal"
  }
  return "conceal"
}

export type ConcealedCodeBlockV1 = {
  readonly head: readonly string[]
  readonly tail: readonly string[]
  readonly omittedLines: number
  readonly bytes: number
}

/**
 * Collapse a long settled code block to bounded head/tail lines. The full source
 * remains in the canonical part or artifact; this result is only a paint surface.
 */
export function concealCodeBlock(
  text: string,
  policy: CodeDisplayPolicyV1 = DEFAULT_CODE_DISPLAY_POLICY,
  headLines = 12,
  tailLines = 6,
): ConcealedCodeBlockV1 {
  // Do not split/join the canonical source: that temporarily retains an array
  // of every line and a second full-size string just to paint a small preview.
  // Count line boundaries in place and retain only the bounded head + tail.
  const lineBudget = Math.max(0, Math.min(policy.lazyHighlightMaxLines, Number.MAX_SAFE_INTEGER))
  const headLimit = Math.max(0, Math.min(Math.floor(headLines), Math.floor(lineBudget / 2)))
  const tailLimit = Math.max(0, Math.min(Math.floor(tailLines), lineBudget - headLimit))
  const head: string[] = []
  const tail: string[] = []
  let lineCount = 0
  let lineStart = 0
  let tailCursor = 0
  for (let index = 0; index <= text.length; index++) {
    if (index !== text.length && text.charCodeAt(index) !== 10) continue
    const line = text.slice(lineStart, index)
    lineCount++
    if (lineCount <= Math.floor(lineBudget / 2) && head.length < headLimit) head.push(line)
    else if (tailLimit > 0) {
      if (tail.length < tailLimit) tail.push(line)
      else {
        tail[tailCursor] = line
        tailCursor = (tailCursor + 1) % tailLimit
      }
    }
    lineStart = index + 1
  }
  const budget = Math.min(lineBudget, lineCount)
  const headCount = Math.max(0, Math.min(headLines, Math.floor(budget / 2)))
  const tailCount = Math.max(0, Math.min(tailLines, budget - headCount))
  if (lineCount <= headCount + tailCount) {
    return { head: [...head, ...tail].slice(0, lineCount), tail: [], omittedLines: 0, bytes: codeTextBytes([...head, ...tail].slice(0, lineCount).join("\n")) }
  }
  const selectedHead = head.slice(0, headCount)
  const orderedTail = tailCursor === 0 ? tail : [...tail.slice(tailCursor), ...tail.slice(0, tailCursor)]
  const selectedTail = tailCount === 0 ? [] : orderedTail.slice(-tailCount)
  const omittedLines = lineCount - selectedHead.length - selectedTail.length
  return {
    head: selectedHead,
    tail: selectedTail,
    omittedLines,
    bytes: codeTextBytes([...selectedHead, ...selectedTail].join("\n")),
  }
}

export type CodeViewportWindowV1 = {
  readonly startLine: number
  readonly endLine: number
  readonly lines: readonly string[]
  readonly bytes: number
}

/**
 * Return the visible window plus fixed overscan. The line index is computed from
 * offsets, so callers never need a second full copy of the code string.
 */
export function codeViewportWindow(
  lines: readonly string[],
  input: { readonly startLine: number; readonly viewportLines: number },
  policy: CodeDisplayPolicyV1 = DEFAULT_CODE_DISPLAY_POLICY,
): CodeViewportWindowV1 {
  const total = lines.length
  const start = Math.max(0, Math.min(total, boundedCount(input.startLine)))
  const viewport = Math.max(0, boundedCount(input.viewportLines))
  const from = Math.max(0, start - policy.viewportOverscanLines)
  const to = Math.min(total, start + viewport + policy.viewportOverscanLines)
  const window = lines.slice(from, to)
  return {
    startLine: from,
    endLine: to,
    lines: window,
    bytes: codeTextBytes(window.join("\n")),
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
}

/** §31.23.5 syntax-span cache bounds: 512 entries / 8 MiB, generation-fenced. */
export type SyntaxCacheStatsV1 = {
  readonly entries: number
  readonly bytes: number
  readonly maxEntries: number
  readonly maxBytes: number
}

type SyntaxCacheEntry<T> = {
  readonly value: T
  readonly bytes: number
  readonly sourceGeneration: string
  readonly themeGeneration: string
}

export class SyntaxSpanCacheV1<T = string> {
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #entries = new Map<string, SyntaxCacheEntry<T>>()

  constructor(limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {}) {
    this.#maxEntries = Math.max(0, boundedCount(limits.maxEntries ?? 512))
    this.#maxBytes = Math.max(0, boundedCount(limits.maxBytes ?? 8 * 1024 * 1024))
  }

  get(
    key: string,
    generation: { readonly sourceGeneration: string; readonly themeGeneration: string },
  ): T | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.sourceGeneration !== generation.sourceGeneration || entry.themeGeneration !== generation.themeGeneration) {
      this.#entries.delete(key)
      return undefined
    }
    // LRU: a cache read refreshes recency.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(
    key: string,
    value: T,
    generation: { readonly sourceGeneration: string; readonly themeGeneration: string },
    bytes: number,
  ): boolean {
    const size = boundedCount(bytes)
    if (this.#maxEntries === 0 || this.#maxBytes === 0 || size > this.#maxBytes) return false
    this.#entries.delete(key)
    this.#entries.set(key, { value, bytes: size, ...generation })
    this.#evict()
    return this.#entries.has(key)
  }

  /** Drop all entries for a superseded source/theme generation. */
  invalidate(generation?: { readonly sourceGeneration?: string; readonly themeGeneration?: string }): void {
    if (!generation) {
      this.#entries.clear()
      return
    }
    for (const [key, entry] of this.#entries) {
      if (
        (generation.sourceGeneration !== undefined && entry.sourceGeneration !== generation.sourceGeneration) ||
        (generation.themeGeneration !== undefined && entry.themeGeneration !== generation.themeGeneration)
      ) {
        this.#entries.delete(key)
      }
    }
  }

  stats(): SyntaxCacheStatsV1 {
    let bytes = 0
    for (const entry of this.#entries.values()) bytes += entry.bytes
    return { entries: this.#entries.size, bytes, maxEntries: this.#maxEntries, maxBytes: this.#maxBytes }
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries || this.stats().bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }
}

export type HighlightJobV1 = {
  readonly key: string
  readonly sourceGeneration: string
  readonly themeGeneration: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
}

export type HighlightSchedulerStatsV1 = {
  readonly running: number
  readonly coalesced: number
  readonly dropped: number
  readonly completed: number
}

/**
 * Bounded viewport-highlight scheduler: at most `maxConcurrentHighlightJobs`
 * jobs run per foreground tab, a newer viewport for the same key coalesces the
 * pending request, and a result whose generation no longer matches is dropped.
 */
export function createHighlightScheduler(input: {
  readonly policy?: CodeDisplayPolicyV1
  readonly run: (job: HighlightJobV1) => Promise<unknown>
  readonly onResult: (job: HighlightJobV1, result: unknown) => void
  readonly onError?: (job: HighlightJobV1, error: unknown) => void
}) {
  const policy = input.policy ?? DEFAULT_CODE_DISPLAY_POLICY
  const maxConcurrent = Math.max(0, boundedCount(policy.maxConcurrentHighlightJobs))
  const pending = new Map<string, HighlightJobV1>()
  let running = 0
  let coalesced = 0
  let dropped = 0
  let completed = 0
  let currentSource = ""
  let currentTheme = ""

  function generationValid(job: HighlightJobV1) {
    return job.sourceGeneration === currentSource && job.themeGeneration === currentTheme
  }

  function pump() {
    while (running < maxConcurrent && pending.size > 0) {
      const [key, job] = pending.entries().next().value as [string, HighlightJobV1]
      pending.delete(key)
      if (!generationValid(job)) {
        dropped++
        continue
      }
      running++
      void input
        .run(job)
        .then((result) => {
          if (!generationValid(job)) {
            dropped++
            return
          }
          completed++
          input.onResult(job, result)
        })
        .catch((error) => input.onError?.(job, error))
        .finally(() => {
          running--
          pump()
        })
    }
  }

  return {
    /** Bind the currently displayed source/theme; any older result is discarded. */
    generation(sourceGeneration: string, themeGeneration: string) {
      currentSource = sourceGeneration
      currentTheme = themeGeneration
      for (const [key, job] of pending) {
        if (!generationValid(job)) {
          pending.delete(key)
          dropped++
        }
      }
    },
    schedule(job: HighlightJobV1) {
      if (running >= maxConcurrent && !pending.has(job.key)) {
        // Bounded queue: keep one latest request per key, never unbounded work.
        if (pending.size >= Math.max(1, maxConcurrent * 4)) {
          dropped++
          return
        }
      }
      if (pending.has(job.key)) coalesced++
      pending.set(job.key, job)
      pump()
    },
    stats(): HighlightSchedulerStatsV1 {
      return { running, coalesced, dropped, completed }
    },
  }
}
