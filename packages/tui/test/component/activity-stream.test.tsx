/** @jsxImportSource @opentui/solid */
import type { Part } from "@opencode-ai/sdk/v2"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ActivityStream } from "../../src/component/activity-stream"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, eventSource } from "../fixture/tui-sdk"
import { SDKProvider } from "../../src/context/sdk"

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  timeout = 2_000,
) {
  const start = Date.now()
  let last = ""
  while (true) {
    await app.renderOnce()
    last = app.captureCharFrame()
    if (predicate(last)) return last
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for activity frame: ${last}`)
    await Bun.sleep(10)
  }
}

test("renders canonical progress, tool states, and answer in part order without raw reasoning", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const parts = [
    { type: "reasoning", id: "reason-1", text: "private chain of thought", time: { start: 1_000, end: 2_200 } },
    {
      type: "tool",
      id: "call-1",
      callID: "call-1",
      name: "read",
      tool: "read",
      state: { status: "running", input: { filePath: "src/main.ts" }, content: [] },
    },
    {
      type: "tool",
      id: "call-2",
      callID: "call-2",
      name: "bash",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "curl -H 'Authorization: Bearer bearer-secret-value'", apiKey: "sk-live-secret-value" },
        output: "first output\nsecond output\nthird output\nfourth output",
        metadata: { truncated: true },
        content: [],
      },
    },
    {
      type: "tool",
      id: "call-3",
      callID: "call-3",
      name: "grep",
      tool: "grep",
      state: {
        status: "error",
        input: { pattern: "TODO" },
        error: `token=secret-error-value\n${"x".repeat(100_000)}`,
        content: [],
      },
    },
    { type: "text", id: "text-1", text: "final answer" },
  ] as unknown as Part[]

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={createFetch().fetch}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box flexDirection="column">
                  <text>activity-render-sentinel</text>
                  <ActivityStream
                    parts={parts}
                    complete={true}
                    width={100}
                    renderText={(part) => <text>{part.text}</text>}
                    renderToolDetails={(part) => <text>{JSON.stringify(part.state.input)}</text>}
                  />
                </box>
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
    { width: 100, height: 30, kittyKeyboard: true, useMouse: true },
  )

  try {
    const collapsed = await waitForFrame(app, (frame) => frame.includes("activity-render-sentinel"))
    expect(collapsed).toContain("activity-render-sentinel")
    expect(collapsed).not.toContain("private chain of thought")
    expect(collapsed).not.toContain("bearer-secret-value")
    expect(collapsed).not.toContain("sk-live-secret-value")
    expect(collapsed).not.toContain("secret-error-value")
    expect(collapsed).toContain("Reasoning · 1.2s")
    expect(collapsed).toContain("Read")
    expect(collapsed).toContain("Read src/main.ts")
    expect(collapsed).toContain("command=")
    expect(collapsed).toContain("curl")
    expect(collapsed).toContain("Running")
    expect(collapsed).toContain("Succeeded")
    expect(collapsed).toContain("Output artifact: UNKNOWN")
    expect(collapsed).toContain("Failed")
    expect(collapsed).not.toContain("first output")
    expect(collapsed).not.toContain("fourth output")
    expect(collapsed).toContain("Expand output")
    expect(collapsed).toContain("final answer")
    expect(collapsed.indexOf("Reasoning · 1.2s")).toBeLessThan(collapsed.indexOf("Read"))
    expect(collapsed.indexOf("Read")).toBeLessThan(collapsed.indexOf("Succeeded shell"))
    expect(collapsed.indexOf("Succeeded")).toBeLessThan(collapsed.indexOf("Failed"))
    expect(collapsed.indexOf("Failed")).toBeLessThan(collapsed.indexOf("final answer"))

    const toggle = app.renderer.root.findDescendantById("activity-output-toggle-call-2") as
      | import("@opentui/core").Renderable
      | undefined
    expect(toggle).toBeDefined()
    expect(toggle?.focusable).toBe(true)
    toggle!.focus()
    app.mockInput.pressEnter()
    await app.renderOnce()
    const keyboardExpanded = app.captureCharFrame()
    expect(keyboardExpanded).toContain("fourth output")
    expect(keyboardExpanded.indexOf("Succeeded bash")).toBeLessThan(keyboardExpanded.indexOf("fourth output"))
    toggle!.focus()
    app.mockInput.pressKey(" ")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("fourth output")

    const rows = collapsed.split("\n")
    const bashRow = rows.findIndex((line) => line.includes("Succeeded shell"))
    const toggleLine = rows.findIndex((line, index) => index > bashRow && line.includes("Expand output"))
    const toggleColumn = collapsed.split("\n")[toggleLine].indexOf("Expand output")
    await app.mockMouse.click(toggleColumn, toggleLine)
    await app.renderOnce()
    const expanded = app.captureCharFrame()
    expect(expanded).toContain("fourth output")
    expect(expanded).not.toContain("bearer-secret-value")
    expect(expanded).not.toContain("sk-live-secret-value")

    const expandedRows = expanded.split("\n")
    const expandedToggleLine = expandedRows.findIndex(
      (line, index) => index > bashRow && line.includes("Collapse output"),
    )
    const expandedToggleColumn = expandedRows[expandedToggleLine]?.indexOf("Collapse output") ?? -1
    await app.mockMouse.click(expandedToggleColumn, expandedToggleLine)
    await app.renderOnce()
    const collapsedAgain = app.captureCharFrame()
    expect(collapsedAgain).not.toContain("fourth output")
    expect(collapsedAgain).toContain("Expand output")
  } finally {
    app.renderer.destroy()
  }
}, 90_000)

test("keeps only one tool details panel expanded at a time", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const parts = ["one", "two", "three"].map((id) => ({
    type: "tool",
    id: `detail-${id}`,
    callID: `detail-${id}`,
    name: "read",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: `DETAIL_${id.toUpperCase()}_START${"x".repeat(1024)}_END_${id.toUpperCase()}` },
      output: `OUTPUT_${id.toUpperCase()}_MARKER${"y".repeat(1024)}`,
      content: [],
    },
  })) as unknown as Part[]

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={createFetch().fetch}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ActivityStream
                  parts={parts}
                  complete={true}
                  renderText={(part) => <text>{part.text}</text>}
                  renderToolDetails={(part) => <text>{JSON.stringify(part.state.input)}</text>}
                />
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
    { width: 120, height: 500, kittyKeyboard: true },
  )

  try {
    await waitForFrame(app, (frame) => frame.includes("Expand output"))
    for (const id of ["one", "two"]) {
      const toggle = app.renderer.root.findDescendantById(`activity-output-toggle-detail-${id}`)
      expect(toggle).toBeDefined()
      toggle!.focus()
      app.mockInput.pressEnter()
      await app.renderOnce()
    }

    const frame = app.captureCharFrame()
    expect(frame).toContain("_END_TWO")
    expect(frame).not.toContain("_END_ONE")
    expect(frame).not.toContain("_END_THREE")
  } finally {
    app.renderer.destroy()
  }
})

test("bounds aggregate activity nodes and bytes while retaining final text", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const parts = [
    ...Array.from({ length: 40 }, (_, index) => ({
      type: "tool",
      id: `tool-${index}`,
      callID: `tool-${index}`,
      name: `tool-${index}`,
      tool: `tool-${index}`,
      state: {
        status: "completed",
        input: { command: `tool-${index} --safe` },
        output: "x".repeat(8 * 1024),
        content: [],
      },
    })),
    { type: "text", id: "final-text", text: "FINAL ANSWER RETAINED" },
  ] as unknown as Part[]

  function Harness() {
    return (
      <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={createFetch().fetch}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box flexDirection="column">
                <ActivityStream
                  parts={parts}
                  complete={true}
                  width={100}
                  renderText={(part) => <text>{part.text}</text>}
                />
              </box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { width: 100, height: 500, kittyKeyboard: true },
  )

  try {
    const frame = await waitForFrame(app, (value) => value.includes("FINAL ANSWER RETAINED"), 5_000)
    const renderedTools = frame.match(/succeeded tool-/g) ?? []
    expect(renderedTools.length).toBeLessThanOrEqual(64)
    expect(frame).toContain("Activity limited: remaining parts omitted")
    expect(frame).toContain("FINAL ANSWER RETAINED")
  } finally {
    app.renderer.destroy()
  }
}, 90_000)

test("bounds projection work to the live tail of very large part histories", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const parts = [
    { type: "text", id: "old-text", text: "OLD HISTORY SHOULD BE OMITTED" },
    ...Array.from({ length: 10_000 }, (_, index) => ({
      type: "tool",
      id: `large-tool-${index}`,
      callID: `large-tool-${index}`,
      name: "read",
      tool: "read",
      state: { status: "completed", input: { filePath: `src/${index}.ts` }, output: "ok", content: [] },
    })),
    { type: "text", id: "latest-text", text: "LATEST ANSWER RETAINED" },
  ] as unknown as Part[]

  function Harness() {
    return (
      <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={createFetch().fetch}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ActivityStream parts={parts} complete={true} renderText={(part) => <text>{part.text}</text>} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { width: 100, height: 500, kittyKeyboard: true },
  )

  try {
    const frame = await waitForFrame(app, (value) => value.includes("LATEST ANSWER RETAINED"), 5_000)
    expect(frame).toContain("Activity limited: remaining parts omitted")
    expect(frame).not.toContain("OLD HISTORY SHOULD BE OMITTED")
    expect(frame).toContain("LATEST ANSWER RETAINED")
    expect(frame.match(/Read filePath=/g)?.length ?? 0).toBeLessThanOrEqual(64)
  } finally {
    app.renderer.destroy()
  }
}, 90_000)
