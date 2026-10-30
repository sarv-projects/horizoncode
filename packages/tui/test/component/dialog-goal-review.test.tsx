/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Global } from "@horizoncode/core/global"
import type { TuiPluginApi } from "@horizoncode/plugin/tui"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import {
  DialogGoalReview,
  type GoalReviewProjection,
} from "../../src/component/dialog-goal-review"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for Goal review dialog")
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
) {
  const start = Date.now()
  while (true) {
    await app.renderOnce()
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(frame)) return frame
    if (Date.now() - start > 2000) throw new Error("timed out waiting for Goal review frame")
    await Bun.sleep(10)
  }
}

function proposal(
  reviewAvailability: GoalReviewProjection["reviewAvailability"] = {
    available: false,
    reason: "No authenticated reviewer is available.",
  },
): GoalReviewProjection {
  return {
    goalId: "goal-managed",
    goalRevision: "9007199254740993",
    specVersionId: "spec-v2",
    parentVersionId: "spec-v1",
    proposedBy: "server_auth.author",
    reviewAvailability,
    specDigest: `blake3:${"a".repeat(64)}`,
    objective: "Finish the managed task without changing unrelated files",
    projectRef: "project-main",
    workspaceRef: "workspace-main",
    capabilityScope: ["files.read"],
    scope: ["kernel/src/**"],
    constraints: ["Preserve user-owned changes"],
    criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
    budget: {
      maxTasks: 4,
      maxAttemptsPerTask: 2,
      maxRunDurationMs: 60_000,
      maxWorkers: 1,
      maxMemoryBytes: "18446744073709551615",
      maxDiskBytes: null,
      maxTokens: "4096",
      maxCostMicros: "0",
    },
    sourceDigests: [`sha256:${"b".repeat(64)}`],
  }
}

test("Goal review shows the immutable proposal but refuses decisions without an authenticated reviewer", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let accepted = false
  let rejected = false
  let dialog: { stack: unknown[]; replace: (element: unknown) => void } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() =>
      current.replace(() => (
        <DialogGoalReview
          proposal={proposal()}
          onAccept={() => {
            accepted = true
          }}
          onReject={() => {
            rejected = true
          }}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 60 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    // The ordered detail pages are deterministic: 23 rows at width 120 truncate
    // to three 8-row pages, so each assertion below names the exact page it
    // requires instead of relying on incidental content.
    const frame = await waitForFrame(app, (value) => value.includes("page 1 of 3"))
    expect(frame).toContain("Parent SpecVersion: spec-v1")
    expect(frame).toContain("Proposed by: server_auth.author")
    expect(frame).toContain("Goal revision: 9007199254740993")
    expect(frame).toContain("Review proposal details · page 1 of 3")
    expect(frame).toContain("Next details page")

    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(accepted).toBe(false)
    expect(rejected).toBe(false)

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    const middlePage = await waitForFrame(app, (value) => value.includes("page 2 of 3"))
    expect(middlePage).toContain("Focused tests pass")
    expect(middlePage).toContain("Capability: files.read")
    expect(middlePage).not.toContain("Budget max workers: 1")
    app.mockInput.pressEnter()
    const finalPage = await waitForFrame(app, (value) => value.includes("page 3 of 3"))
    expect(finalPage).toContain("18446744073709551615")
    expect(finalPage).toContain("Budget max duration ms: 60000")
    expect(finalPage).toContain("Budget max workers: 1")
    expect(finalPage).toContain("Budget max disk bytes: not specified")
    expect(finalPage).toContain("Budget max tokens: 4096")
    expect(finalPage).toContain("Budget max cost micros: 0")
    expect(finalPage).toContain("bbbbbbbbbbbbbbbb")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(accepted).toBe(false)
    expect(rejected).toBe(false)
    expect(dialog?.stack).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
test("Goal review keeps the reject action disabled when the server projection denies review", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let rejected = false
  let dialog: { stack: unknown[]; replace: (element: unknown) => void } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() =>
      current.replace(() => (
        <DialogGoalReview
          proposal={proposal()}
          onAccept={() => {}}
          onReject={() => {
            rejected = true
          }}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 60 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitForFrame(app, (value) => value.includes("spec-v2"))
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(rejected).toBe(false)
    expect(dialog?.stack).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("Goal review exposes the unavailable-service reason and never emits a decision", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let accepted = false
  let rejected = false
  let dialog: { stack: unknown[]; replace: (element: unknown) => void } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() =>
      current.replace(() => (
        <DialogGoalReview
          proposal={proposal()}
          onAccept={() => {
            accepted = true
          }}
          onReject={() => {
            rejected = true
          }}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 60 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    const frame = await waitForFrame(app, (value) => value.includes("spec-v2"))
    expect(frame).toContain("Decision unavailable: No authenticated reviewer is available.")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(accepted).toBe(false)
    expect(rejected).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

// Boots the whole TUI app against a mocked renderer, so the budget covers module
// load plus real app composition; measured at ~12s on Linux/Bun 1.4.2.
test("the app goal.review command reports honestly when no SpecVersion awaits review", async () => {
  const setup = await createTestRenderer({ width: 100, height: 40, useThread: false })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const reviewRequests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname !== "/experimental/control-plane/goal-reviews") return
    reviewRequests.push(url)
    return new Response(JSON.stringify({ goals: [], nextAfterGoalID: null }), {
      headers: { "content-type": "application/json" },
    })
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.review").ok).toBe(true)
    const deadline = Date.now() + 2000
    while (reviewRequests.length === 0 && Date.now() < deadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(reviewRequests).toHaveLength(1)
    expect(reviewRequests[0].searchParams.get("limit")).toBe("64")
    // An empty authenticated inbox is reported through the app alert; no
    // revision-bound decision request is possible without a proposal.
    expect(reviewRequests.some((url) => url.pathname.endsWith("/goal-review/decision"))).toBe(false)
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 60_000 })

test("Goal review sends only the exact proposal identity to its authenticated decision callback", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let dialog: { stack: unknown[]; replace: (element: unknown) => void } | undefined
  let callbackCalled = false
  let submitted: unknown

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() =>
      current.replace(() => (
        <DialogGoalReview
          proposal={proposal({ available: true })}
          onAccept={async (decision) => {
            callbackCalled = true
            submitted = decision
            throw new Error("stale revision")
          }}
          onReject={() => {}}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 60 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitForFrame(app, (frame) => frame.includes("spec-v2"))
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    const frame = await waitForFrame(app, (value) => value.includes("Decision was not saved"))
    expect(frame).toContain("Refresh the Goal")
    expect(callbackCalled).toBe(true)
    expect(submitted).toEqual({
      goalId: "goal-managed",
      specVersionId: "spec-v2",
      specDigest: `blake3:${"a".repeat(64)}`,
      expectedRevision: "9007199254740993",
    })
    expect(submitted).not.toHaveProperty("principal")
    expect(dialog?.stack).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
