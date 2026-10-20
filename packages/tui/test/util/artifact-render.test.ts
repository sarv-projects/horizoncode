import { expect, test } from "bun:test"
import { createTuiArtifactRenderer, renderTuiArtifacts } from "../../src/util/artifact-render"
import { rasterizeSvgSubset, type SvgRasterWorkerLikeV1 } from "../../src/component/svg-raster"

const SAFE_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="80"/></svg>'
const SAFE_SVG_BLOCK = "```svg\n" + SAFE_SVG + "\n```"

function idleWorker(): SvgRasterWorkerLikeV1 {
  return { postMessage() {}, terminate() {}, onmessage: null, onerror: null }
}

function drivenWorker(handler: (request: { id: string; source: string }) => unknown): SvgRasterWorkerLikeV1 {
  const worker: SvgRasterWorkerLikeV1 = {
    postMessage(message: unknown) {
      const request = message as { id: string; source: string }
      const response = handler(request)
      queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, result: response } }))
    },
    terminate() {},
    onmessage: null,
    onerror: null,
  }
  return worker
}

async function waitFor(predicate: () => boolean, timeout = 2_000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for isolated raster frame")
    await Bun.sleep(10)
  }
}

test("removes terminal control sequences from untrusted markdown text", () => {
  const result = renderTuiArtifacts("safe\u001b[31mred\u001b[0m\u001b]8;;https://bad.invalid\u0007link", {
    complete: true,
  })
  expect(result.content).toBe("saferedlink")
})

test("removes non-ANSI terminal controls and expands tabs before markdown rendering", () => {
  const result = renderTuiArtifacts("left\tright\u0007\u0000\u0085done", { complete: false })
  expect(result.content).toBe("left  rightdone")
})

test("removes bidirectional formatting controls from terminal fallback text", () => {
  const result = renderTuiArtifacts("safe\u202Ehidden\u2066directional\u2069text", { complete: false })
  expect(result.content).toBe("safehiddendirectionaltext")
})

test("removes deprecated bidirectional formatting controls from terminal fallback text", () => {
  const result = renderTuiArtifacts("safe\u206Ahidden\u206Ftext", { complete: false })
  expect(result.content).toBe("safehiddentext")
})

test("renders only a closed, supported Mermaid flowchart and keeps the source", () => {
  const source = "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toContain(source)
  expect(rendered.content).toContain("Start (A) → Finish (B)")
  expect(rendered.diagnostics).toEqual([])

  const partial = renderTuiArtifacts("```mermaid\nflowchart LR\nA --> B", { complete: false })
  expect(partial.content).toBe("```mermaid\nflowchart LR\nA --> B")
})

test("keeps unsupported Mermaid and SVG as inert source with a diagnostic", () => {
  const mermaid = "```mermaid\nstateDiagram-v2\n[*] --> Ready\n```"
  const unsupported = renderTuiArtifacts(mermaid, { complete: true })
  expect(unsupported.content).toContain(mermaid)
  expect(unsupported.diagnostics).toHaveLength(1)

  const svg = '```svg\n<svg onload="run()"><script>run()</script></svg>\n```'
  const fallback = renderTuiArtifacts(svg, { complete: true })
  expect(fallback.content).toContain(svg)
  expect(fallback.diagnostics).toHaveLength(1)
  expect(fallback.content).toContain("SVG preview unavailable")
  expect(fallback.fidelity).toBe("FAILED")
})

test("does not render Mermaid directives or unsupported grammar", () => {
  const source = "```mermaid\n%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA[Start] --> B[Finish]\n```"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toContain(source)
  expect(rendered.content).not.toContain("Start (A) → Finish (B)")
  expect(rendered.diagnostics).toHaveLength(1)
})

test("charts only complete numeric tables and preserves original values and units", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 ms |"
  expect(renderTuiArtifacts(table, { complete: false }).content).toBe(table)
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toContain(table)
  expect(rendered.content).toContain("Fast")
  expect(rendered.content).toContain("12 ms")
  expect(rendered.content).toContain("18 ms")
  expect(rendered.content).toContain("█")
})

test("does not chart numeric tables with mixed units", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 s |"
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toBe(table)
  expect(rendered.diagnostics).toEqual([])
})

test("checks the render limit without allocating an encoded copy of the source", () => {
  const originalEncode = TextEncoder.prototype.encode
  TextEncoder.prototype.encode = () => {
    throw new Error("unexpected full-source UTF-8 encoding")
  }

  try {
    expect(renderTuiArtifacts("plain text", { complete: true }).content).toBe("plain text")
  } finally {
    TextEncoder.prototype.encode = originalEncode
  }
})

test("uses UTF-8 byte length at the exact render limit", () => {
  const maxBytes = 256 * 1024
  const exactLimit = `${"a".repeat(maxBytes - 2)}é`
  const overLimit = `${"a".repeat(maxBytes - 1)}é`

  expect(renderTuiArtifacts(exactLimit, { complete: true }).content).toBe(exactLimit)
  expect(renderTuiArtifacts(overLimit, { complete: true }).diagnostics).toHaveLength(1)
})

test("keeps an unclosed Mermaid fence as inert source with failed fidelity", () => {
  const source = "```mermaid\nflowchart LR\nA --> B"
  const rendered = renderTuiArtifacts(source, { complete: true })
  expect(rendered.content).toContain(source)
  expect(rendered.diagnostics).toHaveLength(1)
  expect(rendered.fidelity).toBe("FAILED")
})

test("does not render Mermaid graphs beyond the node or edge caps", () => {
  const nodeLines = Array.from({ length: 65 }, (_, index) => `N${index} --> N${index + 1}`).join("\n")
  const nodes = "```mermaid\nflowchart LR\n" + nodeLines + "\n```"
  const nodeResult = renderTuiArtifacts(nodes, { complete: true })
  expect(nodeResult.content).toContain(nodes)
  expect(nodeResult.diagnostics).toHaveLength(1)

  const edgeLines = Array.from({ length: 129 }, () => "A --> B").join("\n")
  const edges = "```mermaid\nflowchart LR\n" + edgeLines + "\n```"
  const edgeResult = renderTuiArtifacts(edges, { complete: true })
  expect(edgeResult.content).toContain(edges)
  expect(edgeResult.diagnostics).toHaveLength(1)
})

test("marks additional renderable blocks when the preview budget is exhausted", () => {
  const blocks = Array.from(
    { length: 33 },
    (_, index) => "```mermaid\nflowchart LR\nA" + index + " --> B" + index + "\n```",
  ).join("\n")
  const rendered = renderTuiArtifacts(blocks, { complete: true })
  expect(rendered.content).toContain("Preview limit reached; 1 additional block kept as source only.")
  expect(rendered.diagnostics).toHaveLength(1)
})

test("keeps chart previews inside their text fence when labels contain backticks", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| `a` | 12 ms |\n| ```b``` | 18 ms |"
  const rendered = renderTuiArtifacts(table, { complete: true })
  expect(rendered.content).toContain(table)
  expect(rendered.content).toContain("\n````text\n")
  expect(rendered.content).toContain("```b```")
  expect(rendered.content.endsWith("\n````")).toBe(true)
})

test("produces identical chart output for identical source", () => {
  const table = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |\n| Safe | 18 ms |"
  expect(renderTuiArtifacts(table, { complete: true }).content).toBe(
    renderTuiArtifacts(table, { complete: true }).content,
  )
})

test("does not chart numeric tables with fewer than two rows or a non-positive maximum", () => {
  const singleRow = "| Build | Duration |\n| --- | ---: |\n| Fast | 12 ms |"
  expect(renderTuiArtifacts(singleRow, { complete: true }).content).toBe(singleRow)

  const zero = "| Build | Duration |\n| --- | ---: |\n| Fast | 0 ms |\n| Safe | 0 ms |"
  expect(renderTuiArtifacts(zero, { complete: true }).content).toBe(zero)
})

test("reports FULL only for a complete source whose previews all rendered", () => {
  expect(renderTuiArtifacts("plain text", { complete: true }).fidelity).toBe("FULL")
  expect(renderTuiArtifacts("plain text", { complete: false }).fidelity).toBe("SAMPLE")

  const mermaid = "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```"
  expect(renderTuiArtifacts(mermaid, { complete: true }).fidelity).toBe("FULL")
  expect(renderTuiArtifacts("```mermaid\nstateDiagram-v2\n[*] --> Ready\n```", { complete: true }).fidelity).toBe(
    "FAILED",
  )
  expect(renderTuiArtifacts("a".repeat(256 * 1024 + 1), { complete: true }).fidelity).toBe("FAILED")
  expect(renderTuiArtifacts("| A | B |\n| --- | ---: |\n| x | 1 ms |\n| y | 2 ms |", { complete: true }).fidelity).toBe(
    "FULL",
  )
})

test("reports artifact render fidelity with measured analytics provenance", () => {
  const renderer = createTuiArtifactRenderer({ workerFactory: () => undefined })
  try {
    renderer.render("sample", false)
    renderer.render("complete", true)
    renderer.render("a".repeat(256 * 1024 + 1), true)
    const observations = renderer.observations()
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "ui.artifact.render_sample",
          value: 1,
          unit: "renders",
          provenance: "measured",
          source: "tui-artifact-renderer",
        }),
        expect.objectContaining({
          metric: "ui.artifact.render_full",
          value: 1,
          unit: "renders",
          provenance: "measured",
          source: "tui-artifact-renderer",
        }),
        expect.objectContaining({
          metric: "ui.artifact.render_failed",
          value: 1,
          unit: "renders",
          provenance: "measured",
          source: "tui-artifact-renderer",
        }),
      ]),
    )
    expect(observations.every((item) => item.observedAtMs > 0)).toBe(true)
  } finally {
    renderer.dispose()
  }
})

test("never requests an isolated raster for a streaming sample source", () => {
  let webWorkers = 0
  const result = renderTuiArtifacts("```svg\n" + SAFE_SVG, { complete: false })
  expect(result.content).toBe("```svg\n" + SAFE_SVG)
  expect(result.fidelity).toBe("SAMPLE")
  expect(result.diagnostics).toEqual([])
  expect(webWorkers).toBe(0)
})

test("renders an isolated worker frame on a later pass and never parses SVG on the caller thread", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  try {
    const pending = renderer.render(SAFE_SVG_BLOCK, true)
    expect(pending.fidelity).toBe("FAILED")
    expect(pending.content).toContain(SAFE_SVG_BLOCK)
    expect(pending.content).toContain("pending in the isolated worker")
    expect(pending.content).not.toContain("###")
    expect(renderer.stats().requests).toBe(1)

    let updates = 0
    renderer.subscribe(() => updates++)
    await waitFor(() => renderer.stats().completed === 1)
    expect(updates).toBe(1)

    const rendered = renderer.render(SAFE_SVG_BLOCK, true)
    expect(rendered.fidelity).toBe("FULL")
    expect(rendered.diagnostics).toEqual([])
    expect(rendered.content).toContain(SAFE_SVG_BLOCK)
    expect(rendered.content).toContain("#")
    expect(renderer.stats()).toMatchObject({ requests: 1, completed: 1, failed: 0 })
  } finally {
    renderer.dispose()
  }
})

test("fails closed and truthfully when no isolated raster worker is available", async () => {
  const port = createTuiArtifactRenderer({ workerFactory: () => undefined })
  try {
    const first = port.render(SAFE_SVG_BLOCK, true)
    expect(first.fidelity).toBe("FAILED")
    expect(first.content).toContain(SAFE_SVG_BLOCK)
    expect(first.content).toContain("pending in the isolated worker")
    expect(first.content).not.toContain("#")

    await waitFor(() => port.stats().failed === 1)
    const second = port.render(SAFE_SVG_BLOCK, true)
    expect(second.fidelity).toBe("FAILED")
    expect(second.content).toContain("SVG preview failed in the isolated worker (worker_unavailable)")
    expect(second.content).toContain(SAFE_SVG_BLOCK)
    expect(second.content).not.toContain("#")

    // A remembered failure does not spin the bounded worker on later renders.
    const third = port.render(SAFE_SVG_BLOCK, true)
    expect(third.fidelity).toBe("FAILED")
    expect(port.stats()).toMatchObject({ requests: 1, failed: 1 })
  } finally {
    port.dispose()
  }
})

test("bounds the raster frame cache across many blocks", async () => {
  const renderer = createTuiArtifactRenderer({
    maxEntries: 1,
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  try {
    const second = SAFE_SVG_BLOCK.replace('width="80" height="80"', 'width="40" height="70"')
    renderer.render(SAFE_SVG_BLOCK, true)
    renderer.render(second, true)
    await waitFor(() => renderer.stats().completed === 2)
    expect(renderer.stats().cachedFrames).toBe(1)
    expect(renderer.stats().cachedFrameBytes).toBeLessThanOrEqual(4_096)
    expect(renderer.render(second, true).fidelity).toBe("FULL")
    expect(renderer.render(SAFE_SVG_BLOCK, true).fidelity).toBe("FAILED")
  } finally {
    renderer.dispose()
  }
})

test("rejects an injected raster frame that exceeds renderer cache bounds", async () => {
  const renderer = createTuiArtifactRenderer({
    service: {
      async render() {
        return {
          status: "ok",
          generation: 1,
          frame: ["#".repeat(4_097)],
          shapeCount: 1,
          cellCount: 1,
        }
      },
      dispose() {},
    },
  })
  try {
    const pending = renderer.render(SAFE_SVG_BLOCK, true)
    expect(pending.fidelity).toBe("FAILED")
    await waitFor(() => renderer.stats().failed === 1)
    expect(renderer.stats().cachedFrameBytes).toBe(0)
    expect(renderer.render(SAFE_SVG_BLOCK, true).fidelity).toBe("FAILED")
  } finally {
    renderer.dispose()
  }
})

test("rejects unrasterizable SVG through the isolated worker without a main-thread fallback", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  try {
    const hostile = '```svg\n<svg viewBox="0 0 10 10"><script>run()</script></svg>\n```'
    const pending = renderer.render(hostile, true)
    expect(pending.fidelity).toBe("FAILED")
    expect(pending.content).toContain(hostile)
    await waitFor(() => renderer.stats().failed === 1)

    const failed = renderer.render(hostile, true)
    expect(failed.fidelity).toBe("FAILED")
    expect(failed.content).toContain(hostile)
    expect(failed.content).toContain("SVG preview failed in the isolated worker (parse_failed)")
    expect(failed.content).not.toContain("#")
    expect(renderer.stats()).toMatchObject({ requests: 1, completed: 0, failed: 1 })
  } finally {
    renderer.dispose()
  }
})

test("rejects an oversized SVG block at the renderer boundary without main-thread parsing", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  try {
    const oversized = "```svg\n" + SAFE_SVG.replace("</svg>", " ".repeat(70 * 1024) + "</svg>") + "\n```"
    const pending = renderer.render(oversized, true)
    expect(pending.fidelity).toBe("FAILED")
    expect(pending.content).toContain("pending in the isolated worker")
    await waitFor(() => renderer.stats().failed === 1)

    const failed = renderer.render(oversized, true)
    expect(failed.fidelity).toBe("FAILED")
    expect(failed.content).toContain("(source_too_large)")
    expect(failed.content).toContain("```svg")
    expect(failed.content).not.toContain("#")
  } finally {
    renderer.dispose()
  }
})

test("reports raster analytics with measured provenance and freshness", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  try {
    renderer.render(SAFE_SVG_BLOCK, true)
    await waitFor(() => renderer.stats().completed === 1)

    const observations = renderer.observations()
    expect(observations.map(({ observedAtMs: _time, ...observation }) => observation)).toEqual([
      {
        metric: "ui.artifact.raster_cache_entries",
        value: 1,
        unit: "entries",
        provenance: "measured",
        source: "svg-raster-port",
      },
      { metric: "ui.artifact.raster_requests", value: 1, unit: "events", provenance: "measured", source: "svg-raster-port" },
      { metric: "ui.artifact.raster_completed", value: 1, unit: "events", provenance: "measured", source: "svg-raster-port" },
      { metric: "ui.artifact.raster_failed", value: 0, unit: "events", provenance: "measured", source: "svg-raster-port" },
      { metric: "ui.artifact.render_full", value: 0, unit: "renders", provenance: "measured", source: "tui-artifact-renderer" },
      { metric: "ui.artifact.render_sample", value: 0, unit: "renders", provenance: "measured", source: "tui-artifact-renderer" },
      { metric: "ui.artifact.render_failed", value: 1, unit: "renders", provenance: "measured", source: "tui-artifact-renderer" },
    ])
    expect(observations.every((observation) => Number.isSafeInteger(observation.observedAtMs))).toBe(true)
  } finally {
    renderer.dispose()
  }
})

test("aborts an isolated raster that exceeds its deadline and keeps the source fallback", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => idleWorker(),
    timeoutMs: 10,
  })
  try {
    const pending = renderer.render(SAFE_SVG_BLOCK, true)
    expect(pending.fidelity).toBe("FAILED")
    expect(pending.content).toContain("pending in the isolated worker")
    await waitFor(() => renderer.stats().failed === 1)

    const timedOut = renderer.render(SAFE_SVG_BLOCK, true)
    expect(timedOut.fidelity).toBe("FAILED")
    expect(timedOut.content).toContain("SVG preview failed in the isolated worker (timeout)")
    expect(timedOut.content).toContain(SAFE_SVG_BLOCK)
    expect(timedOut.content).not.toContain("#")
  } finally {
    renderer.dispose()
  }
})

test("settles a rejected raster service as a cached source fallback", async () => {
  let requests = 0
  let updates = 0
  const renderer = createTuiArtifactRenderer({
    service: {
      render() {
        requests++
        return Promise.reject(new Error("worker transport failed"))
      },
      dispose() {},
    },
  })
  renderer.subscribe(() => updates++)

  try {
    const pending = renderer.render(SAFE_SVG_BLOCK, true)
    expect(pending.fidelity).toBe("FAILED")
    expect(pending.content).toContain(SAFE_SVG_BLOCK)
    await waitFor(() => renderer.stats().failed === 1)

    const failed = renderer.render(SAFE_SVG_BLOCK, true)
    expect(failed.fidelity).toBe("FAILED")
    expect(failed.content).toContain("SVG preview failed in the isolated worker (worker_unavailable)")
    expect(failed.content).toContain(SAFE_SVG_BLOCK)
    expect(renderer.stats()).toMatchObject({ requests: 1, completed: 0, failed: 1 })
    expect(requests).toBe(1)
    expect(updates).toBe(1)
  } finally {
    renderer.dispose()
  }
})
