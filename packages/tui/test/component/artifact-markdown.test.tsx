/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { ArtifactMarkdown } from "../../src/component/artifact-markdown"
import { createTuiArtifactRenderer } from "../../src/util/artifact-render"
import { rasterizeSvgSubset, type SvgRasterWorkerLikeV1 } from "../../src/component/svg-raster"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource } from "../fixture/tui-sdk"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { tmpdir } from "../fixture/fixture"

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
    if (Date.now() - start > timeout) throw new Error("timed out waiting for artifact state")
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  timeout = 2_000,
) {
  const start = Date.now()
  let lastFrame = ""
  while (true) {
    await app.renderOnce()
    lastFrame = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(lastFrame)) return lastFrame
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for artifact frame; last frame: ${lastFrame}`)
    }
    await Bun.sleep(10)
  }
}

async function mount(source: string, complete: boolean, renderer: ReturnType<typeof createTuiArtifactRenderer>) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Harness() {
    const rendererInstance = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(rendererInstance)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, rendererInstance, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={createFetch().fetch}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ArtifactMarkdown source={source} complete={complete} renderer={renderer} />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )
  return { app, tmp }
}

test("renders the bounded isolated frame while keeping the inert original source", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  const { app } = await mount(SAFE_SVG_BLOCK, true, renderer)
  try {
    await waitFor(() => renderer.stats().completed === 1)
    const ready = await waitForFrame(
      app,
      (frame) => frame.includes("####") && !frame.includes("isolated worker; "),
    )
    expect(ready).toContain("svg")
    expect(ready).toContain("rect")
    expect(ready).toContain("Derived artifact preview: FULL")
    expect(renderer.stats()).toMatchObject({ requests: 1, completed: 1, failed: 0 })
  } finally {
    app.renderer.destroy()
    renderer.dispose()
  }
})

test("shows the inert source and a pending marker while the isolated worker is busy", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => idleWorker(),
    timeoutMs: 10_000,
  })
  const { app } = await mount(SAFE_SVG_BLOCK, true, renderer)
  try {
    const frame = await waitForFrame(app, (value) => value.includes("pending in the isolated worker"))
    expect(frame).toContain("svg")
    expect(frame).toContain("rect")
    expect(frame).toContain("Derived artifact preview: SAMPLE")
    expect(renderer.stats()).toMatchObject({ requests: 1, completed: 0, failed: 0 })
  } finally {
    app.renderer.destroy()
    renderer.dispose()
  }
})

test("fails closed and truthfully when no isolated worker is available", async () => {
  const renderer = createTuiArtifactRenderer({ workerFactory: () => undefined })
  const { app } = await mount(SAFE_SVG_BLOCK, true, renderer)
  try {
    await waitFor(() => renderer.stats().failed === 1)
    const failed = await waitForFrame(app, (frame) => frame.includes("worker_unavailable"))
    expect(failed).toContain("svg")
    expect(failed).not.toContain("####")
    expect(failed).toContain("Derived artifact preview: FAILED")
    // The remembered failure is not re-requested on later renders.
    expect(renderer.stats()).toMatchObject({ requests: 1, failed: 1 })
  } finally {
    app.renderer.destroy()
    renderer.dispose()
  }
})

test("never requests an isolated raster for a streaming sample source", async () => {
  const renderer = createTuiArtifactRenderer({
    workerFactory: () => drivenWorker((request) => rasterizeSvgSubset(request.source)),
  })
  const { app } = await mount(SAFE_SVG_BLOCK, false, renderer)
  try {
    const frame = await waitForFrame(app, (value) => value.includes("svg"))
    expect(frame).not.toContain("pending in the isolated worker")
    expect(frame).not.toContain("worker_unavailable")
    expect(renderer.stats()).toMatchObject({ requests: 0, completed: 0, failed: 0 })
  } finally {
    app.renderer.destroy()
    renderer.dispose()
  }
})

test("unsubscribes on unmount and disposes the renderer without late-frame crashes", async () => {
  let resolveWorker: ((value: unknown) => void) | undefined
  const worker: SvgRasterWorkerLikeV1 = {
    postMessage(message: unknown) {
      const request = message as { id: string }
      resolveWorker = (value: unknown) => worker.onmessage?.({ data: { id: request.id, result: value } })
    },
    terminate() {},
    onmessage: null,
    onerror: null,
  }
  const renderer = createTuiArtifactRenderer({ workerFactory: () => worker, timeoutMs: 10_000 })
  const { app } = await mount(SAFE_SVG_BLOCK, true, renderer)
  await waitForFrame(app, (frame) => frame.includes("pending in the isolated worker"))
  expect(renderer.stats()).toMatchObject({ listeners: 1, requests: 1 })

  app.renderer.destroy()
  expect(renderer.stats().listeners).toBe(0)

  // A late completion after unmount must not throw or render.
  resolveWorker?.(rasterizeSvgSubset(SAFE_SVG))
  await Bun.sleep(20)
  renderer.dispose()
  expect(renderer.stats()).toMatchObject({ listeners: 0, cachedFrames: 0 })
})
