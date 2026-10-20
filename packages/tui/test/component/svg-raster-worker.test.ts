import { expect, test } from "bun:test"
import {
  SVG_RASTER_DEFAULT_BOUNDS,
  createSvgRasterService,
  parseSvgSubset,
  rasterizeSvgSubset,
  type SvgRasterWorkerLikeV1,
} from "../../src/component/svg-raster"

const SQUARE = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="80"/></svg>'

/** Fake worker that never answers, so the service deadline must terminate it. */
function silentWorker(): SvgRasterWorkerLikeV1 {
  return {
    postMessage() {},
    terminate() {},
    onmessage: null,
    onerror: null,
  }
}

/** Fake worker driven by a test-supplied handler, without spawning a thread. */
function drivenWorker(handler: (request: { id: string; source: string }) => unknown) {
  const terminated: number[] = []
  let terminateCount = 0
  const worker: SvgRasterWorkerLikeV1 = {
    postMessage(message: unknown) {
      const request = message as { id: string; source: string }
      const response = handler(request)
      queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, result: response } }))
    },
    terminate() {
      terminateCount++
      terminated.push(terminateCount)
      worker.onmessage = null
    },
    onmessage: null,
    onerror: null,
  }
  return { worker, terminated: () => terminateCount }
}

test("parses only the inert SVG subset and rejects active or unknown grammar", () => {
  expect(parseSvgSubset(SQUARE)).toHaveLength(1)

  const rejected = [
    '<svg viewBox="0 0 10 10"><script>run()</script></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><rect width="10" height="10" transform="scale(2)"/></svg>',
    '<svg viewBox="0 0 10 10"><rect width="10" height="10" onclick="run()"/></svg>',
    '<svg viewBox="0 0 10 10"><image href="file:///etc/passwd"/></svg>',
    '<svg viewBox="0 0 10 10"><use href="#x"/></svg>',
    "<!DOCTYPE svg><svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>",
    '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg><svg viewBox="0 0 1 1"/>',
    '<svg viewBox="0 0 10 10"><path d="M0 0 C10 10 20 20 30 30"/></svg>',
    '<svg viewBox="0 0 10 10"><rect width="10" height="10"',
  ]
  for (const source of rejected) expect(parseSvgSubset(source)).toBeUndefined()
})

test("rasterizes a bounded deterministic frame without inventing active content", () => {
  const first = rasterizeSvgSubset(SQUARE)
  const second = rasterizeSvgSubset(SQUARE)
  if ("reason" in first || "reason" in second) throw new Error("expected a raster frame")

  expect(first).toEqual(second)
  expect(first.frame.length).toBeLessThanOrEqual(SVG_RASTER_DEFAULT_BOUNDS.maxRows)
  expect(first.frame.every((line) => line.length <= SVG_RASTER_DEFAULT_BOUNDS.maxCols)).toBe(true)
  expect(first.frame.join("\n")).toContain("#")
  expect(first.shapeCount).toBe(1)
  expect(first.cellCount).toBeLessThanOrEqual(SVG_RASTER_DEFAULT_BOUNDS.maxCells)
})

test("enforces declared source, shape, path and frame byte bounds", () => {
  const oversized = `<svg viewBox="0 0 10 10"><rect width="10" height="10"/><!--${"x".repeat(200)}--></svg>`
  expect(rasterizeSvgSubset(oversized, { maxSourceBytes: 64 })).toMatchObject({ reason: "source_too_large" })

  const manyShapes = `<svg viewBox="0 0 10 10">${'<rect x="0" y="0" width="1" height="1"/>'.repeat(8)}</svg>`
  expect(rasterizeSvgSubset(manyShapes, { maxShapes: 4 })).toMatchObject({ reason: "parse_failed" })

  const longPath = `<svg viewBox="0 0 10 10"><path d="${"L1 1 ".repeat(64)}"/></svg>`
  expect(rasterizeSvgSubset(longPath, { maxPathCommands: 8 })).toMatchObject({ reason: "parse_failed" })

  expect(rasterizeSvgSubset(SQUARE, { maxFrameBytes: 8 })).toMatchObject({ reason: "frame_too_large" })
})

test("rejects worker frames that violate the inert terminal-output contract", async () => {
  const worker: SvgRasterWorkerLikeV1 = {
    postMessage(message: unknown) {
      const request = message as { id: string }
      queueMicrotask(() =>
        worker.onmessage?.({
          data: {
            id: request.id,
            result: { frame: ["\u001b[31mPWN\u001b[0m"], shapeCount: 1, cellCount: 1 },
          },
        }),
      )
    },
    terminate() {},
    onmessage: null,
    onerror: null,
  }
  const service = createSvgRasterService({ workerFactory: () => worker })

  const result = await service.render({ source: SQUARE, generation: 1 })

  expect(result).toMatchObject({ status: "rejected", reason: "invalid_response" })
  expect(service.stats()).toMatchObject({ inFlight: false, queued: false, completed: 0, rejected: 1 })
  service.dispose()
})

test("turns a synchronous worker dispatch failure into a settled rejection", async () => {
  const worker: SvgRasterWorkerLikeV1 = {
    postMessage() {
      throw new Error("worker closed before dispatch")
    },
    terminate() {},
    onmessage: null,
    onerror: null,
  }
  const service = createSvgRasterService({ workerFactory: () => worker })

  const result = await service.render({ source: SQUARE, generation: 1 }).catch((error) => ({
    status: "thrown",
    reason: error instanceof Error ? error.message : String(error),
  }))

  expect(result).toMatchObject({ status: "rejected", reason: "worker_unavailable" })
  expect(service.stats()).toMatchObject({ inFlight: false, queued: false, rejected: 1 })
  service.dispose()
})

test("turns a worker factory exception into a settled rejection", async () => {
  const service = createSvgRasterService({
    workerFactory() {
      throw new Error("worker runtime unavailable")
    },
  })

  const result = await service.render({ source: SQUARE, generation: 1 }).catch((error) => ({
    status: "thrown",
    reason: error instanceof Error ? error.message : String(error),
  }))

  expect(result).toMatchObject({ status: "rejected", reason: "worker_unavailable" })
  expect(service.stats()).toMatchObject({ inFlight: false, queued: false, rejected: 1 })
  service.dispose()
})

test("bounds a 64 KiB source rejection before any worker dispatch", async () => {
  let dispatches = 0
  const service = createSvgRasterService({
    workerFactory: () => {
      dispatches++
      return silentWorker()
    },
  })
  const result = await service.render({ source: "x".repeat(SVG_RASTER_DEFAULT_BOUNDS.maxSourceBytes + 1), generation: 1 })
  expect(result).toMatchObject({ status: "rejected", reason: "source_too_large" })
  expect(dispatches).toBe(0)
  expect(service.stats()).toMatchObject({ workerSpawns: 0, rejected: 1 })
  service.dispose()
})

test("keeps one isolated worker, throttles dispatches and discards a superseded generation", async () => {
  let spawned = 0
  const service = createSvgRasterService({
    minIntervalMs: 5,
    workerFactory: () => {
      spawned++
      return drivenWorker((request) => rasterizeSvgSubset(request.source)).worker
    },
  })
  const first = service.render({ source: SQUARE, generation: 1 })
  const second = service.render({ source: SQUARE, generation: 2 })
  const third = service.render({ source: SQUARE, generation: 3 })

  const results = await Promise.all([first, second, third])
  expect(results[2]).toMatchObject({ status: "ok", generation: 3 })
  expect(results[0]).toMatchObject({ status: "rejected", reason: "stale" })
  expect(results[1]).toMatchObject({ status: "rejected", reason: "stale" })
  expect(spawned).toBe(1)
  expect(service.stats()).toMatchObject({ workerSpawns: 1, completed: 1, droppedLate: 2, hasFrame: true })
  expect(service.lastFrame()?.length).toBeGreaterThan(0)
  service.dispose()
})

test("enforces the entry budget and never spawns unbounded workers", async () => {
  const service = createSvgRasterService({
    maxEntries: 1,
    workerFactory: () => drivenWorker(() => new Promise(() => {})).worker,
  })
  const first = service.render({ source: SQUARE, generation: 1 })
  const overflow = await service.render({ source: SQUARE, generation: 2 })
  expect(overflow).toMatchObject({ status: "rejected", reason: "entry_limit" })
  expect(service.stats()).toMatchObject({ workerSpawns: 1 })

  const bounded = createSvgRasterService({ maxSpawns: 0, workerFactory: () => silentWorker() })
  const noWorker = await bounded.render({ source: SQUARE, generation: 1 })
  expect(noWorker).toMatchObject({ status: "rejected", reason: "spawn_limit" })
  expect(bounded.stats().workerSpawns).toBe(0)

  service.dispose()
  bounded.dispose()
  void first
})

test("terminates a worker that exceeds the render deadline and fails closed without one", async () => {
  let terminates = 0
  const service = createSvgRasterService({
    timeoutMs: 20,
    maxSpawns: 1,
    workerFactory: () => {
      const silent = silentWorker()
      return {
        ...silent,
        terminate() {
          terminates++
        },
      }
    },
  })
  const timedOut = await service.render({ source: SQUARE, generation: 1 })
  expect(timedOut).toMatchObject({ status: "rejected", reason: "timeout" })
  expect(terminates).toBe(1)
  expect(service.stats()).toMatchObject({ workerSpawns: 1, rejected: 1 })

  const exhausted = await service.render({ source: SQUARE, generation: 2 })
  expect(exhausted).toMatchObject({ status: "rejected", reason: "spawn_limit" })
  expect(service.stats().workerSpawns).toBe(1)
  service.dispose()
})

test("fails closed when no isolated worker is available and resolves outstanding renders on dispose", async () => {
  const unavailable = createSvgRasterService({ workerFactory: () => undefined })
  expect(await unavailable.render({ source: SQUARE, generation: 1 })).toMatchObject({
    status: "rejected",
    reason: "worker_unavailable",
  })
  unavailable.dispose()

  const service = createSvgRasterService({ workerFactory: () => silentWorker(), timeoutMs: 10_000 })
  const pending = service.render({ source: SQUARE, generation: 1 })
  service.dispose()
  expect(await pending).toMatchObject({ status: "rejected", reason: "disposed" })
  expect(service.stats()).toMatchObject({ inFlight: false, queued: false })
})

test("rasterizes in a real isolated worker thread when the runtime provides one", async () => {
  const service = createSvgRasterService({ timeoutMs: 5_000 })
  const result = await service.render({ source: SQUARE, generation: 1 })
  if (result.status === "rejected" && result.reason === "worker_unavailable") {
    throw new Error(`isolated SVG raster worker unavailable: ${result.message}`)
  }
  expect(result).toMatchObject({ status: "ok", generation: 1, shapeCount: 1 })
  if (result.status === "ok") expect(result.frame.join("\n")).toContain("#")
  expect(service.stats().workerSpawns).toBe(1)
  service.dispose()
})

test("keeps keyed raster lanes independent and only supersedes the same key", async () => {
  const service = createSvgRasterService({
    minIntervalMs: 0,
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)).worker,
  })
  try {
    const first = service.render({ source: SQUARE, generation: 1, key: "block-a" })
    const second = service.render({ source: SQUARE, generation: 1, key: "block-b" })
    const results = await Promise.all([first, second])
    expect(results[0]).toMatchObject({ status: "ok", generation: 1 })
    expect(results[1]).toMatchObject({ status: "ok", generation: 1 })

    const older = service.render({ source: SQUARE, generation: 1, key: "block-c" })
    const newer = service.render({ source: SQUARE, generation: 2, key: "block-c" })
    const keyed = await Promise.all([older, newer])
    expect(keyed[0]).toMatchObject({ status: "rejected", reason: "stale" })
    expect(keyed[1]).toMatchObject({ status: "ok", generation: 2 })
  } finally {
    service.dispose()
  }
})

test("aborts a render that exceeds its deadline without leaving a worker behind", async () => {
  let terminations = 0
  const service = createSvgRasterService({
    timeoutMs: 10,
    workerFactory: () => {
      const worker = silentWorker()
      return {
        ...worker,
        terminate() {
          terminations++
        },
      }
    },
  })
  try {
    expect(await service.render({ source: SQUARE, generation: 1, key: "deadline" })).toMatchObject({
      status: "rejected",
      reason: "timeout",
    })
    expect(terminations).toBe(1)
    expect(service.stats()).toMatchObject({ inFlight: false, queued: false })
  } finally {
    service.dispose()
  }
})
