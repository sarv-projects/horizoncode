/**
 * Bounded, isolated SVG raster worker for the TUI renderer (§31.6).
 *
 * The parser/rasterizer is a pure, deterministic function over a strict inert
 * subset of SVG: no script, no network, no filesystem, no external entity, no
 * style/transform/animation/image grammar. Anything outside the subset fails
 * closed so the caller can keep showing the original source text.
 *
 * `createSvgRasterService` owns the worker lifecycle: at most one isolated
 * worker, a declared byte/entry budget, a hard render deadline, a bounded spawn
 * count, and late-frame discard against the requested generation. Every claim
 * (bytes, entries, spawns, cells, frame bytes) is declared here rather than
 * inferred from terminal capabilities.
 */

export type SvgRasterBoundsV1 = {
  maxSourceBytes: number
  maxCells: number
  maxCols: number
  maxRows: number
  maxShapes: number
  maxPathCommands: number
  maxFrameBytes: number
}

export const SVG_RASTER_DEFAULT_BOUNDS: SvgRasterBoundsV1 = {
  maxSourceBytes: 64 * 1024,
  maxCells: 1_800,
  maxCols: 60,
  maxRows: 30,
  maxShapes: 64,
  maxPathCommands: 256,
  maxFrameBytes: 4_096,
}

export type SvgRasterFrameV1 = {
  /** Raster rows, top to bottom, each no longer than `maxCols`. */
  frame: string[]
  shapeCount: number
  cellCount: number
}

export type SvgRasterFailureV1 = {
  reason: "source_too_large" | "parse_failed" | "frame_too_large"
  message: string
}

const SHAPE_ELEMENTS = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"])
const FORBIDDEN_PATTERN =
  /<\s*\/?\s*(script|style|foreignObject|image|use|animate|animateTransform|set|iframe|object|embed|audio|video|canvas|link|meta|base|text|tspan)\b|<!|<\?|&#|on[a-z]+\s*=|href|xlink:|url\s*\(|data:|javascript:/i
const TAG_PATTERN = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g
const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g
const PATH_PATTERN = /([MmLlHhVvZz])|(-?(?:\d+\.?\d*|\.\d+))/g
const RASTER_FAILURE_REASONS = new Set<SvgRasterFailureV1["reason"]>([
  "source_too_large",
  "parse_failed",
  "frame_too_large",
])
const UNSAFE_DIAGNOSTIC_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/

function isRasterFailureReason(reason: unknown): reason is SvgRasterFailureV1["reason"] {
  return typeof reason === "string" && RASTER_FAILURE_REASONS.has(reason as SvgRasterFailureV1["reason"])
}

const COMMON_ATTRIBUTES = new Set(["fill", "stroke", "stroke-width", "fill-opacity", "opacity", "id", "class"])
const GEOMETRY_ATTRIBUTES: Record<string, Set<string>> = {
  rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
  circle: new Set(["cx", "cy", "r"]),
  ellipse: new Set(["cx", "cy", "rx", "ry"]),
  line: new Set(["x1", "y1", "x2", "y2"]),
  polyline: new Set(["points"]),
  polygon: new Set(["points"]),
  path: new Set(["d"]),
}

type Shape =
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "line"; points: Array<[number, number]>; closed: boolean }
  | { kind: "polygon"; points: Array<[number, number]>; closed: boolean }

type ViewBox = { minX: number; minY: number; width: number; height: number }

function utf8ByteLength(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
    if (bytes > 0x7fffffff) return bytes
  }
  return bytes
}

function parseNumber(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback
  if (value.length === 0 || value.length > 24) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1_000_000) return undefined
  return parsed
}

function parsePoints(value: string, limit: number): Array<[number, number]> | undefined {
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  if (tokens.length % 2 !== 0 || tokens.length / 2 > limit) return undefined
  const points: Array<[number, number]> = []
  for (let index = 0; index < tokens.length; index += 2) {
    const x = parseNumber(tokens[index])
    const y = parseNumber(tokens[index + 1])
    if (x === undefined || y === undefined) return undefined
    points.push([x, y])
  }
  return points.length >= 2 ? points : undefined
}

function parsePath(value: string, bounds: SvgRasterBoundsV1): Array<[number, number]> | undefined {
  if (value.length > 4_096) return undefined
  if (!/^[MmLlHhVvZz0-9\s,.\-]*$/.test(value)) return undefined
  const tokens: Array<{ command?: string; number?: number }> = []
  PATH_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_PATTERN.exec(value)) !== null) {
    tokens.push(match[1] ? { command: match[1] } : { number: Number(match[2]) })
    if (tokens.length > bounds.maxPathCommands * 3) return undefined
  }
  if (tokens.length === 0) return undefined

  const points: Array<[number, number]> = []
  let cursor: [number, number] = [0, 0]
  let start: [number, number] = [0, 0]
  let command = ""
  let index = 0
  const nextNumber = () => {
    const token = tokens[index]
    if (!token || token.number === undefined || !Number.isFinite(token.number)) return undefined
    index++
    return token.number
  }

  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.command !== undefined) {
      command = token.command
      index++
      if (command === "Z" || command === "z") {
        if (points.length > 0) points.push(start)
        cursor = start
      }
      continue
    }
    if (!command) return undefined
    const relative = command === command.toLowerCase()
    let x = cursor[0]
    let y = cursor[1]
    if (command === "H" || command === "h") {
      const value1 = nextNumber()
      if (value1 === undefined) return undefined
      x = relative ? cursor[0] + value1 : value1
    } else if (command === "V" || command === "v") {
      const value1 = nextNumber()
      if (value1 === undefined) return undefined
      y = relative ? cursor[1] + value1 : value1
    } else {
      const value1 = nextNumber()
      const value2 = nextNumber()
      if (value1 === undefined || value2 === undefined) return undefined
      x = relative ? cursor[0] + value1 : value1
      y = relative ? cursor[1] + value2 : value2
    }
    cursor = [x, y]
    if (command === "M") command = "L"
    else if (command === "m") command = "l"
    points.push(cursor)
    if (points.length > bounds.maxPathCommands) return undefined
  }

  if (points.length < 2) return undefined
  return points
}

function parseViewBox(value: string | undefined): ViewBox | undefined {
  if (value === undefined) return undefined
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  if (tokens.length !== 4) return undefined
  const [minX, minY, width, height] = tokens.map((token) => parseNumber(token))
  if (minX === undefined || minY === undefined || width === undefined || height === undefined) return undefined
  if (width <= 0 || height <= 0) return undefined
  return { minX, minY, width, height }
}

export function parseSvgSubset(source: string, boundsInput: Partial<SvgRasterBoundsV1> = {}): Shape[] | undefined {
  const bounds: SvgRasterBoundsV1 = { ...SVG_RASTER_DEFAULT_BOUNDS, ...boundsInput }
  if (utf8ByteLength(source) > bounds.maxSourceBytes) return undefined
  if (FORBIDDEN_PATTERN.test(source) || !/<\/svg\s*>\s*$/i.test(source)) return undefined

  const shapes: Shape[] = []
  let viewBox: ViewBox | undefined
  let roots = 0
  let matched = false
  TAG_PATTERN.lastIndex = 0

  for (const match of source.matchAll(TAG_PATTERN)) {
    matched = true
    const closing = match[1] === "/"
    const name = match[2] ?? ""
    const rawAttributes = match[3] ?? ""
    if (name.toLowerCase() === "svg") {
      if (closing) continue
      roots++
      if (roots > 1) return undefined
      const attributes = new Map<string, string>()
      for (const attribute of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
        const key = attribute[1] ?? ""
        if (key !== "viewBox" && key !== "xmlns" && key !== "width" && key !== "height") return undefined
        attributes.set(key, attribute[2] ?? "")
      }
      viewBox = parseViewBox(attributes.get("viewBox"))
      if (viewBox === undefined) {
        const width = parseNumber(attributes.get("width"))
        const height = parseNumber(attributes.get("height"))
        if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
        viewBox = { minX: 0, minY: 0, width, height }
      }
      continue
    }
    if (!SHAPE_ELEMENTS.has(name)) return undefined
    if (closing) return undefined
    const attributes = new Map<string, string>()
    for (const attribute of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
      const key = attribute[1] ?? ""
      if (!COMMON_ATTRIBUTES.has(key) && !GEOMETRY_ATTRIBUTES[name]?.has(key)) return undefined
      attributes.set(key, attribute[2] ?? "")
    }
    if (shapes.length >= bounds.maxShapes) return undefined

    switch (name) {
      case "rect": {
        const x = parseNumber(attributes.get("x"), 0)
        const y = parseNumber(attributes.get("y"), 0)
        const width = parseNumber(attributes.get("width"))
        const height = parseNumber(attributes.get("height"))
        if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
        if (width <= 0 || height <= 0) return undefined
        shapes.push({ kind: "rect", x, y, width, height })
        break
      }
      case "circle":
      case "ellipse": {
        const cx = parseNumber(attributes.get("cx"), 0)
        const cy = parseNumber(attributes.get("cy"), 0)
        if (cx === undefined || cy === undefined) return undefined
        if (name === "circle") {
          const r = parseNumber(attributes.get("r"))
          if (r === undefined || r <= 0) return undefined
          shapes.push({ kind: "circle", cx, cy, r })
        } else {
          const rx = parseNumber(attributes.get("rx"))
          const ry = parseNumber(attributes.get("ry"))
          if (rx === undefined || ry === undefined || rx <= 0 || ry <= 0) return undefined
          shapes.push({ kind: "ellipse", cx, cy, rx, ry })
        }
        break
      }
      case "line":
      case "polyline":
      case "polygon": {
        if (name === "line") {
          const x1 = parseNumber(attributes.get("x1"), 0)
          const y1 = parseNumber(attributes.get("y1"), 0)
          const x2 = parseNumber(attributes.get("x2"), 0)
          const y2 = parseNumber(attributes.get("y2"), 0)
          if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined
          shapes.push({ kind: "line", points: [[x1, y1], [x2, y2]], closed: false })
        } else {
          const points = parsePoints(attributes.get("points") ?? "", bounds.maxPathCommands)
          if (!points) return undefined
          shapes.push({ kind: "polygon", points, closed: name === "polygon" })
        }
        break
      }
      case "path": {
        const points = parsePath(attributes.get("d") ?? "", bounds)
        if (!points) return undefined
        shapes.push({ kind: "polygon", points, closed: false })
        break
      }
    }
  }

  if (!matched || roots !== 1 || viewBox === undefined || shapes.length === 0) return undefined
  return shapes
}

function insidePolygon(points: Array<[number, number]>, x: number, y: number) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!
    const [xj, yj] = points[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToSegment(points: Array<[number, number]>, closed: boolean, x: number, y: number) {
  let best = Number.POSITIVE_INFINITY
  const segments = closed ? points.length : points.length - 1
  for (let index = 0; index < segments; index++) {
    const [x1, y1] = points[index]!
    const [x2, y2] = points[(index + 1) % points.length]!
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
    const px = x1 + t * dx
    const py = y1 + t * dy
    best = Math.min(best, Math.hypot(x - px, y - py))
  }
  return best
}

function coverage(shape: Shape, x: number, y: number, strokeThreshold: number) {
  switch (shape.kind) {
    case "rect":
      return x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height
    case "circle":
      return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r
    case "ellipse": {
      const dx = (x - shape.cx) / shape.rx
      const dy = (y - shape.cy) / shape.ry
      return dx * dx + dy * dy <= 1
    }
    case "line":
      return distanceToSegment(shape.points, shape.closed, x, y) <= strokeThreshold
    case "polygon":
      return shape.closed
        ? insidePolygon(shape.points, x, y)
        : distanceToSegment(shape.points, false, x, y) <= strokeThreshold
  }
}

export function rasterizeSvgSubset(
  source: string,
  boundsInput: Partial<SvgRasterBoundsV1> = {},
): SvgRasterFrameV1 | SvgRasterFailureV1 {
  const bounds: SvgRasterBoundsV1 = { ...SVG_RASTER_DEFAULT_BOUNDS, ...boundsInput }
  if (utf8ByteLength(source) > bounds.maxSourceBytes) {
    return { reason: "source_too_large", message: `SVG source exceeds the ${bounds.maxSourceBytes}-byte raster budget.` }
  }
  const shapes = parseSvgSubset(source, bounds)
  if (!shapes) return { reason: "parse_failed", message: "SVG source is outside the inert raster subset." }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const shape of shapes) {
    const points: Array<[number, number]> =
      shape.kind === "rect"
        ? [
            [shape.x, shape.y],
            [shape.x + shape.width, shape.y + shape.height],
          ]
        : shape.kind === "circle"
          ? [
              [shape.cx - shape.r, shape.cy - shape.r],
              [shape.cx + shape.r, shape.cy + shape.r],
            ]
          : shape.kind === "ellipse"
            ? [
                [shape.cx - shape.rx, shape.cy - shape.ry],
                [shape.cx + shape.rx, shape.cy + shape.ry],
              ]
            : shape.points
    for (const [x, y] of points) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  const width = Math.max(maxX - minX, Number.EPSILON)
  const height = Math.max(maxY - minY, Number.EPSILON)
  let cols = Math.min(bounds.maxCols, Math.max(8, Math.round((bounds.maxCols * width) / Math.max(width, height))))
  let rows = Math.min(bounds.maxRows, Math.max(4, Math.round((bounds.maxRows * height) / Math.max(width, height))))
  while (cols * rows > bounds.maxCells) {
    if (cols >= rows) cols = Math.max(8, cols - 1)
    else rows = Math.max(4, rows - 1)
    if (cols === 8 && rows === 4) break
  }

  const cellWidth = width / cols
  const cellHeight = height / rows
  const strokeThreshold = Math.max(cellWidth, cellHeight) * 0.6
  const covered: boolean[][] = []
  for (let row = 0; row < rows; row++) {
    const line: boolean[] = []
    for (let col = 0; col < cols; col++) {
      const x = minX + ((col + 0.5) / cols) * width
      const y = minY + ((rows - row - 0.5) / rows) * height
      line.push(shapes.some((shape) => coverage(shape, x, y, strokeThreshold)))
    }
    covered.push(line)
  }

  const frame = covered.map((line, row) =>
    line
      .map((filled, col) => {
        if (filled) return "#"
        let neighbors = 0
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as Array<[number, number]>) {
          const r = row + dr
          const c = col + dc
          if (covered[r]?.[c]) neighbors++
        }
        return neighbors > 0 ? "." : " "
      })
      .join(""),
  )

  const frameBytes = frame.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0)
  if (frameBytes > bounds.maxFrameBytes) {
    return { reason: "frame_too_large", message: `Raster frame exceeds the ${bounds.maxFrameBytes}-byte budget.` }
  }
  return { frame, shapeCount: shapes.length, cellCount: cols * rows }
}

/**
 * Worker-side handler. Pure and synchronous so it can run inside the isolated
 * worker thread without touching host capabilities.
 */
export function handleSvgRasterRequest(request: {
  source: string
  bounds?: Partial<SvgRasterBoundsV1>
}): SvgRasterFrameV1 | SvgRasterFailureV1 {
  const bounds: SvgRasterBoundsV1 = { ...SVG_RASTER_DEFAULT_BOUNDS, ...request.bounds }
  return rasterizeSvgSubset(request.source, bounds)
}

export type SvgRasterRejectionReasonV1 =
  | SvgRasterFailureV1["reason"]
  | "entry_limit"
  | "timeout"
  | "stale"
  | "worker_unavailable"
  | "spawn_limit"
  | "disposed"
  | "invalid_response"

export type SvgRasterResultV1 =
  | { status: "ok"; generation: number; frame: string[]; shapeCount: number; cellCount: number }
  | { status: "rejected"; generation: number; reason: SvgRasterRejectionReasonV1; message: string }

/** Minimal worker surface; matches the `Worker` API used under Bun. */
export type SvgRasterWorkerLikeV1 = {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SvgRasterServiceOptionsV1 = {
  bounds?: Partial<SvgRasterBoundsV1>
  /** Outstanding requests (in flight plus queued); the newest supersedes a queued older one. */
  maxEntries?: number
  /** Hard per-render deadline; the worker is terminated when it elapses. */
  timeoutMs?: number
  /** Total bounded worker spawns for the lifetime of this service. */
  maxSpawns?: number
  /** Minimum delay between worker dispatches (throttles intermediate renders). */
  minIntervalMs?: number
  workerFactory?: () => SvgRasterWorkerLikeV1 | undefined
}

type SvgRasterRequestV1 = { id: string; source: string; generation: number; key: string }

type Pending = {
  request: SvgRasterRequestV1
  resolve: (result: SvgRasterResultV1) => void
}

/// Bounded independent render lanes; a keyed request is only superseded by a
/// newer generation of the same key, so document blocks rasterize independently.
const MAX_TRACKED_KEYS = 64

function defaultSvgRasterWorkerFactory(): SvgRasterWorkerLikeV1 | undefined {
  try {
    const WorkerCtor = (globalThis as { Worker?: new (url: URL | string) => unknown }).Worker
    if (!WorkerCtor) return undefined
    const entry = new URL("./svg-raster.worker-entry.ts", import.meta.url)
    return new WorkerCtor(entry) as SvgRasterWorkerLikeV1
  } catch {
    return undefined
  }
}

function rejection(generation: number, reason: SvgRasterRejectionReasonV1, message: string): SvgRasterResultV1 {
  return { status: "rejected", generation, reason, message }
}

/**
 * Bounded SVG raster service. A declared entry budget (never more than
 * `maxEntries` outstanding renders), one live isolated worker, a hard deadline
 * per render, a bounded spawn count, throttled dispatches, and late-frame
 * discard when the requested generation was superseded. When no isolated worker
 * is available every render fails closed and the caller keeps the source text.
 */
export function createSvgRasterService(options: SvgRasterServiceOptionsV1 = {}) {
  const bounds: SvgRasterBoundsV1 = { ...SVG_RASTER_DEFAULT_BOUNDS, ...options.bounds }
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 2))
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 500))
  const maxSpawns = Math.max(0, Math.floor(options.maxSpawns ?? 8))
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? 50))
  const workerFactory = options.workerFactory ?? defaultSvgRasterWorkerFactory

  let worker: SvgRasterWorkerLikeV1 | undefined
  let queued: Pending | undefined
  let inFlight: (Pending & { timer?: ReturnType<typeof setTimeout> }) | undefined
  const latestByKey = new Map<string, number>()
  let spawns = 0
  let completed = 0
  let rejected = 0
  let droppedLate = 0
  let lastFrame: string[] | undefined
  let lastDispatchAt = Number.NEGATIVE_INFINITY
  let throttleTimer: ReturnType<typeof setTimeout> | undefined
  let nextRequestID = 0
  let disposed = false

  function noteGeneration(key: string, generation: number) {
    latestByKey.delete(key)
    latestByKey.set(key, generation)
    while (latestByKey.size > MAX_TRACKED_KEYS) {
      const oldest = latestByKey.keys().next().value
      if (oldest === undefined) break
      latestByKey.delete(oldest)
    }
  }

  function superseded(request: SvgRasterRequestV1) {
    const latest = latestByKey.get(request.key)
    return latest !== undefined && request.generation < latest
  }

  function settle(pending: Pending, result: SvgRasterResultV1) {
    if (result.status === "ok") {
      completed++
      lastFrame = result.frame
    } else rejected++
    pending.resolve(result)
  }

  function release(request: SvgRasterRequestV1, reason: SvgRasterRejectionReasonV1, message: string) {
    if (inFlight?.request.id === request.id) {
      if (inFlight.timer) clearTimeout(inFlight.timer)
      const pending = inFlight
      inFlight = undefined
      settle(pending, rejection(request.generation, reason, message))
      return true
    }
    if (queued?.request.id === request.id) {
      const pending = queued
      queued = undefined
      settle(pending, rejection(request.generation, reason, message))
      return true
    }
    return false
  }

  function abandonWorker() {
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      worker = undefined
    }
  }

  function ensureWorker(): SvgRasterWorkerLikeV1 | undefined {
    if (worker) return worker
    if (spawns >= maxSpawns) return undefined
    const created = workerFactory()
    if (!created) return undefined
    spawns++
    created.onmessage = (event) => {
      const response = event?.data as { id?: unknown; result?: unknown } | undefined
      const result = response?.result
      if (!inFlight || response?.id !== inFlight.request.id || !result || typeof result !== "object") return
      const pending = inFlight
      if (pending.timer) clearTimeout(pending.timer)
      inFlight = undefined
      const frame = result as SvgRasterFrameV1 | SvgRasterFailureV1
      if ("frame" in frame && Array.isArray(frame.frame)) {
        const valid =
          frame.frame.length <= bounds.maxRows &&
          frame.frame.length > 0 &&
          frame.frame.every((line) => typeof line === "string" && line.length <= bounds.maxCols && /^[ #.]*$/.test(line)) &&
          frame.frame.reduce((total, line) => total + line.length + 1, 0) <= bounds.maxFrameBytes &&
          Number.isSafeInteger(frame.shapeCount) &&
          frame.shapeCount > 0 &&
          frame.shapeCount <= bounds.maxShapes &&
          Number.isSafeInteger(frame.cellCount) &&
          frame.cellCount > 0 &&
          frame.cellCount <= bounds.maxCells
        if (!valid) {
          settle(pending, rejection(pending.request.generation, "invalid_response", "Worker frame exceeded declared bounds."))
        } else if (superseded(pending.request)) {
          droppedLate++
          settle(pending, rejection(pending.request.generation, "stale", "Superseded render generation."))
        } else {
          settle(pending, {
            status: "ok",
            generation: pending.request.generation,
            frame: frame.frame,
            shapeCount: frame.shapeCount ?? 0,
            cellCount: frame.cellCount ?? 0,
          })
        }
      } else {
        const failure = frame as Partial<SvgRasterFailureV1>
        if (
          !isRasterFailureReason(failure.reason) ||
          typeof failure.message !== "string" ||
          failure.message.length > 512 ||
          UNSAFE_DIAGNOSTIC_PATTERN.test(failure.message)
        ) {
          settle(pending, rejection(pending.request.generation, "invalid_response", "Worker returned an invalid failure response."))
          pump()
          return
        }
        settle(
          pending,
          rejection(pending.request.generation, failure.reason, failure.message),
        )
      }
      pump()
    }
    created.onerror = () => {
      abandonWorker()
      if (inFlight) {
        const pending = inFlight
        if (pending.timer) clearTimeout(pending.timer)
        inFlight = undefined
        settle(pending, rejection(pending.request.generation, "worker_unavailable", "SVG raster worker failed."))
      }
      pump()
    }
    worker = created
    return worker
  }

  function pump() {
    if (disposed || inFlight || !queued) return
    const now = Date.now()
    const wait = lastDispatchAt + minIntervalMs - now
    if (wait > 0) {
      if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = undefined
          pump()
        }, wait)
      }
      return
    }
    const pending = queued
    queued = undefined
    let active: SvgRasterWorkerLikeV1 | undefined
    try {
      active = ensureWorker()
    } catch {
      settle(pending, rejection(pending.request.generation, "worker_unavailable", "SVG raster worker could not be created."))
      pump()
      return
    }
    if (!active) {
      settle(
        pending,
        rejection(
          pending.request.generation,
          spawns >= maxSpawns ? "spawn_limit" : "worker_unavailable",
          spawns >= maxSpawns
            ? `SVG raster worker spawn budget (${maxSpawns}) exhausted.`
            : "No isolated SVG raster worker is available.",
        ),
      )
      return
    }
    lastDispatchAt = Date.now()
    inFlight = pending
    inFlight.timer = setTimeout(() => {
      if (!inFlight || inFlight.request.id !== pending.request.id) return
      abandonWorker()
      const timedOut = inFlight
      inFlight = undefined
      settle(timedOut, rejection(timedOut.request.generation, "timeout", `SVG raster exceeded ${timeoutMs} ms.`))
      pump()
    }, timeoutMs)
    try {
      active.postMessage({ id: pending.request.id, source: pending.request.source, bounds })
    } catch {
      if (inFlight?.request.id !== pending.request.id) return
      if (inFlight.timer) clearTimeout(inFlight.timer)
      const failed = inFlight
      inFlight = undefined
      abandonWorker()
      settle(failed, rejection(failed.request.generation, "worker_unavailable", "SVG raster worker rejected the request."))
      pump()
    }
  }

  return {
    render(input: { source: string; generation: number; key?: string }): Promise<SvgRasterResultV1> {
      if (disposed) return Promise.resolve(rejection(input.generation, "disposed", "SVG raster service is disposed."))
      const key = input.key ?? ""
      noteGeneration(key, input.generation)
      if (utf8ByteLength(input.source) > bounds.maxSourceBytes) {
        rejected++
        return Promise.resolve(
          rejection(input.generation, "source_too_large", `SVG source exceeds the ${bounds.maxSourceBytes}-byte budget.`),
        )
      }
      if (queued && queued.request.key === key && input.generation > queued.request.generation) {
        const supersededRequest = queued
        queued = undefined
        droppedLate++
        settle(supersededRequest, rejection(supersededRequest.request.generation, "stale", "Superseded queued render generation."))
      }
      const outstanding = (inFlight ? 1 : 0) + (queued ? 1 : 0)
      if (outstanding >= maxEntries) {
        rejected++
        return Promise.resolve(
          rejection(input.generation, "entry_limit", `SVG raster entry budget (${maxEntries}) is full.`),
        )
      }
      return new Promise<SvgRasterResultV1>((resolve) => {
        nextRequestID++
        queued = {
          request: { id: `svg-raster-${nextRequestID}`, source: input.source, generation: input.generation, key },
          resolve,
        }
        pump()
      })
    },
    /** Keep the last successful frame only; a newer generation must be requested explicitly. */
    lastFrame() {
      return lastFrame
    },
    stats() {
      return {
        workerSpawns: spawns,
        completed,
        rejected,
        droppedLate,
        inFlight: inFlight !== undefined,
        queued: queued !== undefined,
        hasFrame: lastFrame !== undefined,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (throttleTimer) clearTimeout(throttleTimer)
      abandonWorker()
      const outstanding = [inFlight, queued].filter((pending): pending is Pending => pending !== undefined)
      inFlight = undefined
      queued = undefined
      for (const pending of outstanding) settle(pending, rejection(pending.request.generation, "disposed", "SVG raster service is disposed."))
    },
  }
}
