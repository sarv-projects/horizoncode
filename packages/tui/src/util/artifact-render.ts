import { createHash } from "node:crypto"
import stripAnsi from "strip-ansi"
import { createSvgRasterService, type SvgRasterResultV1, type SvgRasterWorkerLikeV1 } from "../component/svg-raster"
import type { MetricProvenanceV1 } from "../context/ui-event-mux"
import { tuiAnalyticsProjection } from "./tui-analytics"

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_RENDERED_OUTPUT_BYTES = 512 * 1024
const MAX_RENDER_SOURCE_LINES = 16_384
const MAX_RENDERED_BLOCKS = 32
const MAX_FRAME_CACHE_ENTRIES = 32
const MAX_FRAME_CACHE_BYTES = 32 * 4_096
// Keep renders in flight bounded independently from the completed-frame cache.
// A transcript can expose many distinct artifact generations before workers
// finish; request tracking must not grow with that history.
const MAX_IN_FLIGHT_RENDER_REQUESTS = 8
const MAX_FRAME_BYTES = 4_096
const MAX_FRAME_CELLS = 1_800
const MAX_FRAME_ROWS = 30
const MAX_FRAME_COLUMNS = 60
const MAX_DIAGNOSTICS = 16
const MAX_MERMAID_EDGES = 128
const MAX_MERMAID_NODES = 64
const MAX_CHART_ROWS = 100
const MAX_BAR_WIDTH = 24

export type TuiArtifactFidelity = "FULL" | "SAMPLE" | "FAILED"

export type TuiArtifactRenderResult = {
  content: string
  diagnostics: string[]
  /**
   * Truthful render-boundary fidelity:
   * - `FULL`: the source is complete and every derived preview rendered.
   * - `SAMPLE`: the source itself is still streaming; no preview is attempted
   *   and nothing here claims a full render.
   * - `FAILED`: the source is complete but at least one derived preview was
   *   skipped, pending, or unavailable; the inert source remains the only
   *   rendered truth. A pending isolated-worker frame is `FAILED` for this
   *   render and becomes `FULL` only on a later render that adopts the frame.
   */
  fidelity: TuiArtifactFidelity
}

/** Deterministic identity and invalidation generation of one SVG source block. */
export type SvgRasterBlockV1 = {
  blockID: string
  generation: string
  source: string
}

export type SvgRasterPortFrameV1 =
  | { status: "pending"; generation: string }
  | { status: "ready"; generation: string; frame: string[]; shapeCount: number; cellCount: number }
  | { status: "failed"; generation: string; reason: string; message: string }

/**
 * Synchronous renderer-facing view over an isolated SVG raster worker. `frame`
 * only looks at the bounded in-memory cache and never parses SVG; `request`
 * schedules at most one isolated render per block generation.
 */
export type SvgRasterObservationV1 = {
  metric:
    | "ui.artifact.render_full"
    | "ui.artifact.render_sample"
    | "ui.artifact.render_failed"
    | "ui.artifact.raster_cache_entries"
    | "ui.artifact.raster_cache_bytes"
    | "ui.artifact.raster_requests"
    | "ui.artifact.raster_completed"
    | "ui.artifact.raster_failed"
  value: number
  unit: "entries" | "bytes" | "events" | "renders"
  provenance: MetricProvenanceV1
  source: "svg-raster-port" | "tui-artifact-renderer"
  observedAtMs: number
}

export type SvgRasterPortV1 = {
  frame(block: SvgRasterBlockV1): SvgRasterPortFrameV1
  request(block: SvgRasterBlockV1): void
  stats(): { cachedFrames: number; cachedFrameBytes: number; requests: number; completed: number; failed: number; disposed: boolean }
  observations(): SvgRasterObservationV1[]
  dispose(): void
}

export type SvgRasterServiceLikeV1 = {
  render(input: { source: string; generation: number; key?: string }): Promise<SvgRasterResultV1>
  dispose(): void
}

export type SvgRasterPortOptionsV1 = {
  /** Bounded frame cache entries; never unbounded across a long transcript. */
  maxEntries?: number
  /** Geometry/theme inputs bound into the block generation. */
  rasterWidth?: number
  rasterTheme?: string
  /** Called after a frame or failure lands so the caller can re-render. */
  onUpdate?: () => void
  service?: SvgRasterServiceLikeV1
  workerFactory?: () => SvgRasterWorkerLikeV1 | undefined
  timeoutMs?: number
}

export type TuiArtifactRenderOptionsV1 = {
  complete: boolean
  raster?: SvgRasterPortV1
  rasterWidth?: number
  rasterTheme?: string
}

function svgBlockID(source: string) {
  // Cache identity must not alias for adversarially chosen model output. This
  // digest is only a renderer key; it grants no artifact or workspace authority.
  return createHash("sha256").update(source, "utf8").digest("hex")
}

function svgBlock(source: string, options: TuiArtifactRenderOptionsV1): SvgRasterBlockV1 {
  const blockID = svgBlockID(source)
  return {
    blockID,
    generation: `${blockID}:${options.rasterWidth ?? 0}:${options.rasterTheme ?? ""}`,
    source,
  }
}

function svgPreview(
  source: string,
  options: TuiArtifactRenderOptionsV1,
): { rendered?: string; message: string; pending?: boolean } {
  const port = options.raster
  if (!port) return { message: "SVG preview unavailable; source is shown as inert text." }
  const block = svgBlock(source, options)
  const view = port.frame(block)
  if (view.status === "ready" && view.frame.length > 0) {
    return { rendered: fencedText(view.frame.join("\n")), message: "" }
  }
  if (view.status === "pending") {
    // Schedules at most one isolated render per block generation; the caller
    // re-renders when the port reports an update.
    port.request(block)
    return { message: "SVG preview pending in the isolated worker; source is shown as inert text.", pending: true }
  }
  if (view.status === "failed") {
    return { message: `SVG preview failed in the isolated worker (${view.reason}); source is shown as inert text.` }
  }
  return { message: "SVG preview unavailable; source is shown as inert text." }
}

/** Bounded renderer-facing port over the isolated SVG raster worker. */
export function createSvgRasterPort(options: SvgRasterPortOptionsV1 = {}): SvgRasterPortV1 {
  const requestedEntries = options.maxEntries ?? MAX_FRAME_CACHE_ENTRIES
  const maxEntries = Number.isFinite(requestedEntries)
    ? Math.max(1, Math.min(MAX_FRAME_CACHE_ENTRIES, Math.floor(requestedEntries)))
    : MAX_FRAME_CACHE_ENTRIES
  const service =
    options.service ??
    createSvgRasterService({
      workerFactory: options.workerFactory,
      timeoutMs: options.timeoutMs,
    })
  const cache = new Map<string, SvgRasterPortFrameV1>()
  let cacheBytes = 0
  const requested = new Set<string>()
  // At most one current request generation per bounded in-flight key. An older
  // geometry/theme render may settle after a newer one and must not replace it.
  const currentRequestGeneration = new Map<string, string>()
  let requests = 0
  let completed = 0
  let failed = 0
  let nextGeneration = 0
  let inFlight = 0
  let disposed = false

  function cachedBytes(view: SvgRasterPortFrameV1 | undefined) {
    if (view?.status !== "ready") return 0
    return view.frame.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0)
  }

  function validFrame(result: Extract<SvgRasterResultV1, { status: "ok" }>) {
    const sourceFrame = result.frame
    if (!Array.isArray(sourceFrame) || sourceFrame.length === 0 || sourceFrame.length > MAX_FRAME_ROWS) return undefined
    const frame: string[] = []
    for (let index = 0; index < sourceFrame.length; index++) {
      const line = sourceFrame[index]
      // Array#every skips sparse slots, which would let an incomplete worker
      // frame appear ready and silently render as empty rows via join().
      if (typeof line !== "string" || line.length > MAX_FRAME_COLUMNS || !/^[ #.]*$/.test(line)) return undefined
      frame.push(line)
    }
    const shapeCount = result.shapeCount
    const cellCount = result.cellCount
    if (
      cachedBytes({ status: "ready", generation: "", frame, shapeCount, cellCount }) > MAX_FRAME_BYTES ||
      !Number.isSafeInteger(shapeCount) || shapeCount <= 0 || shapeCount > 64 ||
      !Number.isSafeInteger(cellCount) || cellCount <= 0 || cellCount > MAX_FRAME_CELLS
    ) return undefined
    return { frame, shapeCount, cellCount }
  }

  function touch(blockID: string, view: SvgRasterPortFrameV1) {
    const previous = cache.get(blockID)
    if (previous) cacheBytes -= cachedBytes(previous)
    cache.delete(blockID)
    cache.set(blockID, view)
    cacheBytes += cachedBytes(view)
    while (cache.size > maxEntries || cacheBytes > MAX_FRAME_CACHE_BYTES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cacheBytes -= cachedBytes(cache.get(oldest))
      cache.delete(oldest)
    }
  }

  return {
    frame(block) {
      const cached = cache.get(block.blockID)
      if (!cached || cached.generation !== block.generation) {
        return { status: "pending", generation: block.generation }
      }
      return cached
    },
    request(block) {
      if (disposed) return
      const cached = cache.get(block.blockID)
      if (cached?.generation === block.generation) return
      const requestKey = `${block.blockID}@${block.generation}`
      if (requested.has(requestKey)) return
      // A newer geometry/theme generation may start while an older one is still
      // settling. Completion is fenced by the current generation below, and the
      // global in-flight cap still bounds total worker work.
      if (inFlight >= MAX_IN_FLIGHT_RENDER_REQUESTS) {
        // Leave this generation pending. A completion from one of the bounded
        // workers triggers the next render pass, which can then admit it.
        return
      }
      requested.add(requestKey)
      currentRequestGeneration.set(block.blockID, block.generation)
      inFlight++
      requests++
      nextGeneration++
      const generation = nextGeneration
      const release = () => {
        if (!requested.delete(requestKey)) return false
        inFlight--
        return true
      }
      const fail = () => {
        release()
        if (disposed || currentRequestGeneration.get(block.blockID) !== block.generation) return
        currentRequestGeneration.delete(block.blockID)
        failed++
        touch(block.blockID, {
          status: "failed",
          generation: block.generation,
          reason: "worker_unavailable",
          message: "SVG raster service failed.",
        })
        options.onUpdate?.()
      }
      try {
        void service.render({ source: block.source, generation, key: block.blockID }).then((result) => {
          release()
          if (disposed || currentRequestGeneration.get(block.blockID) !== block.generation) return
          let resultStatus: SvgRasterResultV1["status"]
          let resultGeneration: number
          try {
            resultStatus = result.status
            resultGeneration = result.generation
          } catch {
            fail()
            return
          }
          if (resultGeneration !== generation) {
            fail()
            return
          }
          let rejectionReason: string | undefined
          let rejectionMessage: string | undefined
          if (result.status === "rejected") {
            try {
              rejectionReason = result.reason
              rejectionMessage = result.message
            } catch {
              fail()
              return
            }
          }
          currentRequestGeneration.delete(block.blockID)
          if (resultStatus === "rejected" && rejectionReason === "stale") {
            // The source generation changed while the worker was rendering.
            // Re-render the caller so it can submit the current generation.
            options.onUpdate?.()
            return
          }
          if (result.status === "ok") {
            let snapshot: ReturnType<typeof validFrame>
            try {
              snapshot = validFrame(result)
            } catch {
              // Treat malformed worker payloads like any other invalid frame;
              // a hostile accessor must not escape the async completion path.
            }
            if (!snapshot) {
              failed++
              touch(block.blockID, {
                status: "failed",
                generation: block.generation,
                reason: "worker_unavailable",
                message: "SVG raster frame exceeded the renderer cache bounds.",
              })
              options.onUpdate?.()
              return
            }
            completed++
            touch(block.blockID, {
              status: "ready",
              generation: block.generation,
              frame: snapshot.frame,
              shapeCount: snapshot.shapeCount,
              cellCount: snapshot.cellCount,
            })
          } else {
            failed++
            // A failed generation is remembered instead of re-requested, so a
            // deterministic rejection cannot spin the bounded worker.
            touch(block.blockID, {
              status: "failed",
              generation: block.generation,
              reason: rejectionReason ?? "worker_unavailable",
              message: rejectionMessage ?? "SVG raster service failed.",
            })
          }
          options.onUpdate?.()
        }, fail)
      } catch {
        fail()
      }
    },
    stats() {
      return { cachedFrames: cache.size, cachedFrameBytes: cacheBytes, requests, completed, failed, disposed }
    },
    /** Analytics observations; every value is a measured bounded counter. */
    observations(): SvgRasterObservationV1[] {
      const observedAtMs = Date.now()
      const measured = (
        metric: SvgRasterObservationV1["metric"],
        value: number,
        unit: SvgRasterObservationV1["unit"],
      ): SvgRasterObservationV1 => ({
        metric,
        value,
        unit,
        provenance: "measured",
        source: "svg-raster-port",
        observedAtMs,
      })
      return [
        measured("ui.artifact.raster_cache_entries", cache.size, "entries"),
        measured("ui.artifact.raster_cache_bytes", cacheBytes, "bytes"),
        measured("ui.artifact.raster_requests", requests, "events"),
        measured("ui.artifact.raster_completed", completed, "events"),
        measured("ui.artifact.raster_failed", failed, "events"),
      ]
    },
    dispose() {
      disposed = true
      cache.clear()
      cacheBytes = 0
      requested.clear()
      currentRequestGeneration.clear()
      service.dispose()
    },
  }
}

export type TuiArtifactRendererV1 = {
  render(source: string, complete: boolean): TuiArtifactRenderResult
  subscribe(listener: () => void): () => void
  stats(): {
    cachedFrames: number
    cachedFrameBytes: number
    requests: number
    completed: number
    failed: number
    disposed: boolean
    listeners: number
  }
  observations(): SvgRasterObservationV1[]
  dispose(): void
}

/**
 * Renderer controller for TUI callers: synchronous render results plus a
 * subscription that fires when an isolated frame lands, so the caller can
 * re-render. Worker absence or failure never falls back to main-thread SVG
 * parsing; the inert source stays authoritative.
 */
export function createTuiArtifactRenderer(options: SvgRasterPortOptionsV1 = {}): TuiArtifactRendererV1 {
  const listeners = new Set<() => void>()
  const renderCounts = { FULL: 0, SAMPLE: 0, FAILED: 0 }
  const reporter = tuiAnalyticsProjection.attachArtifactRenderer()
  const port = createSvgRasterPort({
    ...options,
    onUpdate: () => {
      for (const listener of listeners) listener()
    },
  })
  const observedAt = (metric: SvgRasterObservationV1["metric"], value: number): SvgRasterObservationV1 => ({
    metric,
    value,
    unit: "renders",
    provenance: "measured",
    source: "tui-artifact-renderer",
    observedAtMs: Date.now(),
  })
  return {
    render(source, complete) {
      const result = renderTuiArtifacts(source, {
        complete,
        raster: port,
        rasterWidth: options.rasterWidth,
        rasterTheme: options.rasterTheme,
      })
      renderCounts[result.fidelity]++
      reporter.observe([
        ...port.observations(),
        observedAt("ui.artifact.render_full", renderCounts.FULL),
        observedAt("ui.artifact.render_sample", renderCounts.SAMPLE),
        observedAt("ui.artifact.render_failed", renderCounts.FAILED),
      ])
      return result
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stats() {
      return { ...port.stats(), listeners: listeners.size }
    },
    observations() {
      return [
        ...port.observations(),
        observedAt("ui.artifact.render_full", renderCounts.FULL),
        observedAt("ui.artifact.render_sample", renderCounts.SAMPLE),
        observedAt("ui.artifact.render_failed", renderCounts.FAILED),
      ]
    },
    dispose() {
      listeners.clear()
      reporter.dispose()
      port.dispose()
    },
  }
}

type Fence = {
  character: "`" | "~"
  length: number
  language: string
}

type NumericCell = {
  value: number
  unit: string
  source: string
}

function sanitizeTerminalText(source: string) {
  return stripAnsi(source)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g, "")
}

function exceedsUtf8Limit(value: string, limit: number) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) bytes += 1
    else if (codeUnit <= 0x7ff) bytes += 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3

    if (bytes > limit) return true
  }
  return false
}

function exceedsLineLimit(value: string, limit: number) {
  let lines = 1
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) !== 10) continue
    lines++
    if (lines > limit) return true
  }
  return false
}

/** Return a UTF-8 bounded prefix without allocating an encoded copy of input. */
function utf8Prefix(value: string, limit: number) {
  let bytes = 0
  let end = 0
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    let width = 0
    if (codeUnit <= 0x7f) width = 1
    else if (codeUnit <= 0x7ff) width = 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        width = 4
        index++
      } else width = 3
    } else width = 3

    if (bytes + width > limit) break
    bytes += width
    end = index + 1
  }
  return value.slice(0, end)
}

function openingFence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return
  const marker = match[2]
  if (!marker) return
  const info = match[3]?.trim() ?? ""
  const language = info.split(/\s+/, 1)[0]?.toLowerCase() ?? ""
  return {
    character: marker[0] as Fence["character"],
    length: marker.length,
    language,
  }
}

function closesFence(line: string, fence: Fence) {
  const match = /^ {0,3}(`+|~+)\s*$/.exec(line)
  return match?.[1]?.[0] === fence.character && (match[1]?.length ?? 0) >= fence.length
}

function longestBacktickRun(value: string) {
  let longest = 0
  let current = 0
  for (const character of value) {
    if (character === "`") {
      current++
      if (current > longest) longest = current
      continue
    }
    current = 0
  }
  return longest
}

function fencedText(value: string) {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1))
  return `${fence}text\n${value}\n${fence}`
}

function safeMermaidLabel(value: string | undefined, id: string) {
  if (value === undefined) return id
  const label = value.trim()
  if (!label || label.length > 80 || !/^[\p{L}\p{N} .,_()+/#-]+$/u.test(label)) return
  return label
}

function renderSimpleMermaid(source: string) {
  const [header, ...body] = source.split("\n")
  if (!/^(?:flowchart|graph)\s+(?:LR|RL|TB|TD|BT)$/i.test(header?.trim() ?? "")) return

  const nodes = new Set<string>()
  const edges: string[] = []
  const edgePattern =
    /^\s*([A-Za-z][A-Za-z0-9_]{0,31})(?:\[([^\]\r\n]{1,80})\])?\s*-->\s*([A-Za-z][A-Za-z0-9_]{0,31})(?:\[([^\]\r\n]{1,80})\])?\s*$/

  for (const line of body) {
    if (!line.trim()) continue
    const match = edgePattern.exec(line)
    if (!match) return
    const fromID = match[1]
    const toID = match[3]
    if (!fromID || !toID) return
    const from = safeMermaidLabel(match[2], fromID)
    const to = safeMermaidLabel(match[4], toID)
    if (!from || !to) return
    nodes.add(fromID)
    nodes.add(toID)
    if (nodes.size > MAX_MERMAID_NODES || edges.length >= MAX_MERMAID_EDGES) return
    edges.push(`${from} (${fromID}) → ${to} (${toID})`)
  }

  if (edges.length === 0) return
  return fencedText(edges.join("\n"))
}

function tableCells(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes("|") || /\\\|/.test(trimmed)) return
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").map((cell) => cell.trim())
}

function parseNumericCell(source: string): NumericCell | undefined {
  const match = /^((?:\d+(?:\.\d*)?|\.\d+))(?:\s+([A-Za-z%][A-Za-z0-9%/_-]{0,15}))?$/.exec(source.trim())
  if (!match) return
  const value = Number(match[1])
  if (!Number.isFinite(value)) return
  return { value, unit: match[2] ?? "", source: source.trim() }
}

function renderNumericTable(lines: string[]) {
  if (lines.length < 4 || lines.length > MAX_CHART_ROWS + 2) return
  const header = tableCells(lines[0] ?? "")
  const divider = tableCells(lines[1] ?? "")
  if (header?.length !== 2 || divider?.length !== header.length) return
  if (!header[0] || !header[1] || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) return

  const rows: Array<{ label: string; metric: NumericCell }> = []
  for (const line of lines.slice(2)) {
    const cells = tableCells(line)
    if (cells?.length !== 2 || !cells[0] || cells[0].length > 40) return
    const metric = parseNumericCell(cells[1] ?? "")
    if (!metric) return
    rows.push({ label: cells[0], metric })
  }
  if (rows.length < 2) return

  const unit = rows[0]?.metric.unit
  if (rows.some((row) => row.metric.unit !== unit)) return
  const maximum = Math.max(...rows.map((row) => row.metric.value))
  if (maximum <= 0) return

  const title = unit ? `${header[1]} (${unit})` : header[1]
  const chart = [
    title,
    ...rows.map((row) => {
      const width = Math.max(1, Math.round((row.metric.value / maximum) * MAX_BAR_WIDTH))
      const bar = "█".repeat(width)
      return `${row.label}  ${bar}  ${row.metric.source}`
    }),
  ]
  return fencedText(chart.join("\n"))
}

function addDiagnostic(diagnostics: string[], message: string) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message)
}

export function renderTuiArtifacts(source: string, options: TuiArtifactRenderOptionsV1): TuiArtifactRenderResult {
  const diagnostics: string[] = []
  const sourceTooLarge = exceedsUtf8Limit(source, MAX_SOURCE_BYTES)
  // Bound raw input before stripAnsi/regex work. Sanitization may expand tabs,
  // so enforce the same cap again before returning or parsing the result.
  const boundedSource = sourceTooLarge ? utf8Prefix(source, MAX_SOURCE_BYTES) : source
  const sanitized = sanitizeTerminalText(boundedSource)
  const contentTooLarge = exceedsUtf8Limit(sanitized, MAX_SOURCE_BYTES)
  const content = contentTooLarge ? utf8Prefix(sanitized, MAX_SOURCE_BYTES) : sanitized
  if (sourceTooLarge || contentTooLarge) {
    const message = `Artifact preview skipped: source exceeds the ${MAX_SOURCE_BYTES / 1024} KiB render limit.`
    diagnostics.push(message)
    const annotation = `\n\n[${message}]`
    const sourceLimit = Math.max(0, MAX_RENDERED_OUTPUT_BYTES - Buffer.byteLength(annotation, "utf8"))
    return {
      content: `${utf8Prefix(content, sourceLimit)}${annotation}`,
      diagnostics,
      fidelity: options.complete ? "FAILED" : "SAMPLE",
    }
  }
  if (!options.complete) return { content, diagnostics, fidelity: "SAMPLE" }
  if (exceedsLineLimit(content, MAX_RENDER_SOURCE_LINES)) {
    const message = `Artifact preview skipped: source exceeds the ${MAX_RENDER_SOURCE_LINES.toLocaleString()} line render limit.`
    addDiagnostic(diagnostics, message)
    return {
      content: `${content}\n\n[${message}]`,
      diagnostics,
      fidelity: "FAILED",
    }
  }

  const lines = content.split("\n")
  const output: string[] = []
  let renderedBlocks = 0
  let skippedBlocks = 0
  let previewFailed = false
  let previewPending = false

  for (let index = 0; index < lines.length; ) {
    const fence = openingFence(lines[index] ?? "")
    if (fence) {
      let end = index + 1
      while (end < lines.length && !closesFence(lines[end] ?? "", fence)) end++
      if (end === lines.length) {
        output.push(...lines.slice(index))
        if (fence.language === "svg" || fence.language === "mermaid") {
          const message = `${fence.language === "svg" ? "SVG" : "Mermaid"} preview requires a complete fenced block; source is shown as text.`
          addDiagnostic(diagnostics, message)
          output.push(`[${message}]`)
          previewFailed = true
        }
        break
      }

      const block = lines.slice(index, end + 1).join("\n")
      const sourceBlock = lines.slice(index + 1, end).join("\n")
      output.push(block)
      if (fence.language === "svg") {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          const preview = svgPreview(sourceBlock, options)
          if (preview.rendered !== undefined) {
            output.push(preview.rendered)
          } else {
            addDiagnostic(diagnostics, preview.message)
            output.push(`[${preview.message}]`)
            if (preview.pending) previewPending = true
            else previewFailed = true
          }
        } else {
          skippedBlocks++
          previewFailed = true
        }
        renderedBlocks++
      } else if (fence.language === "mermaid") {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          const preview = renderSimpleMermaid(sourceBlock)
          if (preview) output.push(preview)
          else {
            const message = "Mermaid preview unavailable for this grammar; source is shown as text."
            addDiagnostic(diagnostics, message)
            output.push(`[${message}]`)
            previewFailed = true
          }
        } else {
          skippedBlocks++
          previewFailed = true
        }
        renderedBlocks++
      }
      index = end + 1
      continue
    }

    const next = lines[index + 1]
    const header = tableCells(lines[index] ?? "")
    const divider = tableCells(next ?? "")
    if (header?.length === 2 && divider?.length === 2 && divider.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      let end = index + 2
      while (end < lines.length && tableCells(lines[end] ?? "")) end++
      const table = lines.slice(index, end)
      const preview = renderNumericTable(table)
      output.push(...table)
      if (preview) {
        if (renderedBlocks < MAX_RENDERED_BLOCKS) {
          output.push(preview)
          renderedBlocks++
        } else skippedBlocks++
      }
      index = end
      continue
    }

    output.push(lines[index] ?? "")
    index++
  }

  if (skippedBlocks > 0) {
    const message = `Preview limit reached; ${skippedBlocks} additional block${skippedBlocks === 1 ? "" : "s"} kept as source only.`
    addDiagnostic(diagnostics, message)
    output.push(`[${message}]`)
    previewFailed = true
  }

  const renderedContent = output.join("\n")
  if (exceedsUtf8Limit(renderedContent, MAX_RENDERED_OUTPUT_BYTES)) {
    const message = `Artifact preview skipped: aggregate render exceeds the ${MAX_RENDERED_OUTPUT_BYTES / 1024} KiB output limit; source is shown without previews.`
    addDiagnostic(diagnostics, message)
    return {
      content: `${content}\n\n[${message}]`,
      diagnostics,
      fidelity: "FAILED",
    }
  }
  return {
    content: renderedContent,
    diagnostics,
    // `SAMPLE` describes an incomplete source. Once the source is complete,
    // a derived preview that is still pending is unavailable for this render
    // and must remain `FAILED` until a later render adopts the finished frame.
    fidelity: previewFailed || previewPending ? "FAILED" : "FULL",
  }
}
