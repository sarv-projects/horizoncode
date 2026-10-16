/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onCleanup, onMount } from "solid-js"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { DialogFeatures } from "../../src/component/dialog-features"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ExitProvider } from "../../src/context/exit"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() > start + timeout) throw new Error("timed out waiting for feature settings")
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  timeout = 2000,
) {
  const start = Date.now()
  while (true) {
    await app.renderOnce()
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(frame)) return frame
    if (Date.now() > start + timeout) throw new Error("timed out waiting for feature settings frame")
    await Bun.sleep(10)
  }
}

test("TUI projects feature state and unavailable experiment selection performs no config update", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let configRequests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/config/features") return undefined
    configRequests++
    return json(FeatureExposure.list({}))
  })
  let configStatus: string | undefined
  let dialog: { stack: unknown[] } | undefined

  function Harness(props: { fetch: typeof globalThis.fetch }) {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={props.fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <ExitProvider exit={() => {}}>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <ToastProvider>
                            <DialogProvider>
                              <Probe />
                            </DialogProvider>
                            <Toast />
                          </ToastProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ExitProvider>
                  </ProjectProvider>
                </PermissionProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const sync = useSync()
    const current = useDialog()
    createEffect(() => (configStatus = sync.status))
    dialog = current
    // app.tsx mounts this dialog with dialog.replace; the harness must do the same.
    onMount(() => current.replace(() => <DialogFeatures />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness fetch={calls.fetch} /></TestTuiContexts>,
    { kittyKeyboard: true, width: 120, height: 40 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitFor(() => configStatus === "complete")
    await waitFor(() => configRequests === 1)
    const frame = await waitForFrame(app, (frame) => frame.includes("source default"))
    expect(frame).toContain("default ON")
    expect(frame).toContain("effective ON")
    expect(frame).toContain("source default")
    expect(frame).toContain("policy lock unknown")
    expect(frame).toContain("Scope project")
    expect(frame).toContain("next turn")
    const beforeSelection = configRequests

    // The list order starts with the two wired stable options, then the
    // unimplemented experimental options. Select an unavailable option.
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    const unavailableFrame = app.captureCharFrame().replace(/\s+/g, " ")
    expect(unavailableFrame).toContain("Unavailable")
    expect(unavailableFrame).toContain("Not implemented or release-verified")
    expect(unavailableFrame).toContain("default OFF")
    expect(unavailableFrame).toContain("effective OFF")
    expect(unavailableFrame).toContain("source default")
    app.mockInput.pressEnter()
    await Bun.sleep(25)
    expect(configRequests).toBe(beforeSelection)
  } finally {
    app.renderer.destroy()
  }
})

test("TUI sends a conditional feature update, refreshes, and survives a stale-write conflict", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let listRequests = 0
  let updateRequests = 0
  let updateBody: unknown
  let conflict = false
  let current = FeatureExposure.list({})
  let nextList = FeatureExposure.list({ compaction: { auto: false } })
  const calls = createFetch((url) => {
    if (url.pathname !== "/config/features") return undefined
    listRequests++
    return json(current)
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (new URL(request.url).pathname === "/config/features" && request.method === "PATCH") {
      updateRequests++
      updateBody = await request.clone().json().catch(() => undefined)
      if (conflict) {
        return new Response(
          JSON.stringify({ _tag: "ConflictError", message: "stale write", resource: "compaction.auto" }),
          { status: 409, headers: { "content-type": "application/json" } },
        )
      }
      current = nextList
      return json(current)
    }
    return calls.fetch(request)
  }
  let configStatus: string | undefined
  let dialog: { stack: unknown[] } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <ExitProvider exit={() => {}}>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <ToastProvider>
                            <DialogProvider>
                              <Probe />
                            </DialogProvider>
                            <Toast />
                          </ToastProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ExitProvider>
                  </ProjectProvider>
                </PermissionProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const sync = useSync()
    const current = useDialog()
    createEffect(() => (configStatus = sync.status))
    dialog = current
    onMount(() => current.replace(() => <DialogFeatures />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 40 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitFor(() => configStatus === "complete")
    await waitFor(() => listRequests === 1)
    await waitForFrame(app, (frame) => frame.includes("source default"))

    // First conditional update: turn the default-on stable option off. The
    // optimistic-concurrency token is the previously requested value (null).
    app.mockInput.pressEnter()
    await waitFor(() => updateRequests === 1)
    expect(updateBody).toEqual({ featureId: "compaction.auto", expectedEnabled: null, enabled: false })
    await waitForFrame(app, (frame) => frame.includes("requested OFF") && frame.includes("effective OFF"))

    // A stale/concurrent write is surfaced as a typed conflict and the shown
    // effective state must not change.
    conflict = true
    app.mockInput.pressEnter()
    await waitFor(() => updateRequests === 2)
    expect(updateBody).toEqual({ featureId: "compaction.auto", expectedEnabled: false, enabled: true })
    await waitForFrame(app, (frame) => frame.includes("was not saved"))
    await waitForFrame(app, (frame) => frame.includes("effective OFF"))

    // The dialog stays usable; retrying after the conflict succeeds.
    conflict = false
    nextList = FeatureExposure.list({ compaction: { auto: true } })
    const target = updateRequests + 1
    for (let attempt = 0; attempt < 50 && updateRequests < target; attempt++) {
      app.mockInput.pressEnter()
      await app.renderOnce()
      await Bun.sleep(5)
    }
    expect(updateRequests).toBe(target)
    await waitForFrame(app, (frame) => frame.includes("requested ON") && frame.includes("effective ON"))
  } finally {
    app.renderer.destroy()
  }
})
