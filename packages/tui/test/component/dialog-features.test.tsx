/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onCleanup, onMount } from "solid-js"
import { FeatureExposure } from "@horizoncode/core/v1/config/feature-exposure"
import { DialogFeatures, featureSettingIsMutable } from "../../src/component/dialog-features"
import { DialogProvider as DialogProviderList } from "../../src/component/dialog-provider"
import { DialogModel } from "../../src/component/dialog-model"
import { useLocal } from "../../src/context/local"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { LocalProvider } from "../../src/context/local"
import { RouteProvider } from "../../src/context/route"
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

test("feature settings are mutable only when the authoritative policy state is unlocked", () => {
  const [feature] = FeatureExposure.list({})
  expect(feature).toBeDefined()
  expect(feature && featureSettingIsMutable(feature)).toBe(true)
  expect(feature && featureSettingIsMutable({
    ...feature,
    state: { ...feature.state, policyLock: "unknown" },
  })).toBe(false)
  expect(feature && featureSettingIsMutable({
    ...feature,
    state: { ...feature.state, policyLock: "locked", blockedReason: "Managed by policy" },
  })).toBe(false)
})

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
  let last = ""
  while (true) {
    await app.renderOnce()
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    last = frame
    if (predicate(frame)) return frame
    if (Date.now() > start + timeout) throw new Error(`timed out waiting for feature settings frame: ${last}`)
    await Bun.sleep(10)
  }
}

/**
 * Box borders can split a rendered phrase across lines, and waitForFrame has
 * already collapsed whitespace. Strip vertical borders and collapse again
 * before matching multi-word phrases.
 */
function containsPhrase(frame: string, phrase: string) {
  return frame.replaceAll("┃", "").replace(/\s+/g, " ").includes(phrase)
}

test("TUI reports policy locks and unavailable experiments without sending config updates", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let configRequests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/config/features") return undefined
    configRequests++
    const features = FeatureExposure.list({})
    features[0]!.state.policyLock = "locked"
    features[0]!.state.blockedReason = "Managed by test policy"
    return json(features)
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
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness fetch={calls.fetch} />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 64, height: 20 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitFor(() => configStatus === "complete")
    await waitFor(() => configRequests === 1)
    const frame = await waitForFrame(app, (frame) => frame.includes("source default"))
    expect(frame).toContain("default ON")
    expect(frame).toContain("effective ON")
    expect(frame).toContain("source default")
    expect(frame).toContain("policy lock locked")
    expect(frame).toContain("Scope project")
    expect(frame).toContain("next turn")
    const beforeSelection = configRequests

    // A managed lock is authoritative even while the current effective value
    // is ON. Selecting it must not issue a PATCH.
    expect(frame).toContain("Locked: Managed by test policy")
    app.mockInput.pressEnter()
    await Bun.sleep(25)
    expect(configRequests).toBe(beforeSelection)

    // The list order starts with the two wired stable options, then the
    // unimplemented experimental options. Select an unavailable option.
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    const unavailableFrame = app.captureCharFrame().replace(/\s+/g, " ")
    expect(unavailableFrame).toContain("Experimental")
    expect(unavailableFrame).toContain("Unavailable")
    expect(unavailableFrame).toContain("Not implemented or release-verified")
    expect(unavailableFrame).toContain("default OFF")
    expect(unavailableFrame).toContain("effective OFF")
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
  let nextList = FeatureExposure.list(
    {
      compaction: { auto: false },
      origins: { auto: { valueSource: "project", policyLock: "unlocked", pendingApplyAt: "next_turn" } },
    },
    { compaction: { auto: true } },
  )
  const calls = createFetch((url) => {
    if (url.pathname !== "/config/features") return undefined
    listRequests++
    return json(current)
  })
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (new URL(request.url).pathname === "/config/features" && request.method === "PATCH") {
      updateRequests++
      updateBody = await request
        .clone()
        .json()
        .catch(() => undefined)
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
        <SDKProvider
          url="http://test"
          directory={tmp.path}
          events={eventSource()}
          fetch={fetchImpl as typeof globalThis.fetch}
        >
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
    await waitForFrame(
      app,
      (frame) => frame.includes("requested OFF") && frame.includes("effective ON") && frame.includes("pending_apply"),
    )
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Pending next turn")

    // A stale/concurrent write is surfaced as a typed conflict and the shown
    // effective state must not change.
    conflict = true
    app.mockInput.pressEnter()
    await waitFor(() => updateRequests === 2)
    expect(updateBody).toEqual({ featureId: "compaction.auto", expectedEnabled: false, enabled: true })
    await waitForFrame(app, (frame) => frame.includes("was not saved"))
    await waitForFrame(app, (frame) => frame.includes("effective ON") && frame.includes("pending_apply"))

    // The dialog stays usable; retrying after the conflict succeeds.
    conflict = false
    nextList = FeatureExposure.list(
      {
        compaction: { auto: true },
        origins: { auto: { valueSource: "project", policyLock: "unlocked" } },
      },
      { compaction: { auto: true } },
    )
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

test("an unconnected provider does not prompt for or submit credentials", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let providerLists = 0
  let authWrites = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") {
      return json({
        providers: [
          {
            id: "test-provider",
            name: "Test Provider",
            models: {
              "test-model": {
                id: "test-model",
                name: "Test Model",
                providerID: "test-provider",
                status: "active",
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              },
            },
          },
        ],
        default: {},
      })
    }
    if (url.pathname === "/provider") {
      providerLists++
      return json({
        all: [{ id: "test-provider", name: "Test Provider", source: "api", env: [], options: {}, models: {} }],
        default: {},
        connected: [],
      })
    }
    if (url.pathname === "/auth/test-provider") {
      authWrites++
      return json({}, { status: 503 })
    }
    if (url.pathname === "/instance/dispose") return json({})
    return undefined
  })
  let syncStatus: string | undefined
  let dialog: { stack: unknown[] } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={calls.fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <RouteProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <LocalProvider>
                                <DialogProvider>
                                  <Probe />
                                </DialogProvider>
                                <Toast />
                              </LocalProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </RouteProvider>
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
    createEffect(() => (syncStatus = sync.status))
    dialog = current
    onMount(() => current.replace(() => <DialogProviderList />))
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
    await waitFor(() => syncStatus === "complete")
    expect(providerLists).toBe(1)
    await waitForFrame(app, (frame) => frame.includes("Test Provider"))

    app.mockInput.pressEnter()
    const frame = await waitForFrame(app, (value) =>
      containsPhrase(value, "has no usable credential reference"),
    )
    expect(containsPhrase(frame, "Guarded SecretBroker credential entry and OAuth transport are unavailable")).toBe(true)
    expect(frame).not.toContain("API key")
    expect(frame).not.toContain("Authorization code")
    expect(providerLists).toBe(1)
    expect(authWrites).toBe(0)

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    const customFrame = await waitForFrame(app, (value) =>
      value.includes("Custom provider credentials are unavailable"),
    )
    expect(customFrame).not.toContain("Provider id")
    expect(customFrame).not.toContain("API key")
    expect(authWrites).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("an environment-disabled feature is reported as blocked and performs no config update", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  // Requested on by config but forced off by the runtime env flag: the value in
  // effect is not the user's to toggle from this dialog.
  const features = FeatureExposure.list({ compaction: { auto: true } }, { compaction: { auto: false } })
  expect(features[0]?.state.effectiveState).toBe("blocked")
  const patches: string[] = []
  const calls = createFetch()
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(String(input), init)
    if (new URL(request.url).pathname === "/config/features") {
      if (request.method === "PATCH") patches.push(await request.text())
      return json(features)
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
        <SDKProvider
          url="http://test"
          directory={tmp.path}
          events={eventSource()}
          fetch={fetchImpl as typeof globalThis.fetch}
        >
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
    // P6's unknown-lock correction: when the winning source is unknown the
    // reason is the policy-status one — Core pins it in
    // packages/core/test/config/feature-exposure.test.ts.
    const frame = await waitForFrame(app, (value) =>
      value.includes("Effective state differs from the request; policy status is unknown"),
    )
    expect(frame).toContain("Blocked")
    expect(frame).toContain("requested ON")
    expect(frame).toContain("effective OFF")
    expect(frame).toContain("source unknown")
    expect(frame).toContain("policy lock unknown")

    app.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(patches).toEqual([])
    const after = await waitForFrame(app, (value) =>
      value.includes("Effective state differs from the request; policy status is unknown"),
    )
    expect(after).toContain("requested ON")
    expect(after).toContain("effective OFF")
    expect(after).toContain("policy lock unknown")
  } finally {
    app.renderer.destroy()
  }
})

test("console-managed providers are locked and environment credentials do not enable dispatch", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let oauthCalls = 0
  let authWrites = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", hidden: false }])
    if (url.pathname === "/provider") {
      return json({
        all: [
          { id: "managed-provider", name: "Managed Provider", source: "config", env: [], options: {}, models: {} },
          {
            id: "env-provider",
            name: "Env Provider",
            source: "env",
            env: ["ENV_PROVIDER_KEY"],
            options: {},
            models: {},
          },
        ],
        default: {},
        connected: ["env-provider"],
      })
    }
    if (url.pathname === "/config/providers") {
      return json({
        providers: [
          {
            id: "env-provider",
            name: "Env Provider",
            models: {
              "env-model": {
                id: "env-model",
                name: "Environment Model",
                providerID: "env-provider",
                status: "active",
                cost: { input: 0, output: 0 },
              },
            },
          },
        ],
        default: {},
      })
    }
    if (url.pathname === "/experimental/console")
      return json({ consoleManagedProviders: ["managed-provider"], activeOrgName: "Acme Org", switchableOrgCount: 1 })
    if (url.pathname.startsWith("/provider/oauth/")) {
      oauthCalls++
      return json({})
    }
    if (url.pathname.startsWith("/auth/")) {
      authWrites++
      return json({})
    }
    return undefined
  })
  let syncStatus: string | undefined
  let dialog: { stack: unknown[] } | undefined
  let selectedModel: { providerID: string; modelID: string } | undefined
  let recentModels: { providerID: string; modelID: string }[] = []

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={calls.fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <RouteProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <LocalProvider>
                                <DialogProvider>
                                  <Probe />
                                </DialogProvider>
                                <Toast />
                              </LocalProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </RouteProvider>
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
    const local = useLocal()
    const current = useDialog()
    createEffect(() => (syncStatus = sync.status))
    createEffect(() => (selectedModel = local.model.current()))
    createEffect(() => (recentModels = local.model.recent()))
    dialog = current
    onMount(() => current.replace(() => <DialogProviderList />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    // The dialog box is a fixed 60 columns (ui/dialog.tsx `medium`), so a row
    // clips at the box edge and the terminal width cannot reveal more of the
    // sentence; the complete contract string is pinned by `providerProvenance`
    // in dialog-model.test.ts.
    { kittyKeyboard: true, width: 120, height: 40 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    await waitFor(() => syncStatus === "complete")
    const frame = await waitForFrame(app, (value) => value.includes("Env Provider"))
    // Current provenance format: the variable list is announced as
    // "provider-declared variables: …". The superseded parenthesized wording
    // must never come back.
    expect(containsPhrase(frame, "Legacy environment source detected · ")).toBe(true)
    expect(frame).not.toContain("(ENV_PROVIDER_KEY)")
    expect(frame).toContain("Managed Provider")
    expect(frame).toContain("Acme Org")

    // The console-managed provider is locked: selecting it explains who manages
    // it and starts no auth flow.
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    const lockedFrame = await waitForFrame(app, (value) =>
      containsPhrase(value, "managed by your OpenCode Console organization"),
    )
    expect(lockedFrame).toContain("Acme Org")
    expect(oauthCalls).toBe(0)
    expect(authWrites).toBe(0)
    expect(dialog?.stack.length).toBe(1)

    // The legacy environment source is visible as provenance, but it cannot
    // enable HorizonCode dispatch or create auth state.
    app.mockInput.pressKey("ARROW_UP")
    app.mockInput.pressEnter()
    const modelFrame = await waitForFrame(app, (value) => value.includes("Environment Model"))
    expect(modelFrame).toContain("Environment Model")
    expect(modelFrame).toContain("Dispatch unavailable in HorizonCode V1")
    // `local.model.current()` always falls back to the first valid model, so a
    // refused choice is observed as "unchanged and never recorded as recent"
    // rather than as an undefined selection: a successful set() would add the
    // recent entry that `recentModels` pins to its pre-choice value.
    const beforeModel = selectedModel
    const beforeRecent = recentModels
    app.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(selectedModel).toEqual(beforeModel)
    expect(recentModels).toEqual(beforeRecent)
    expect(oauthCalls).toBe(0)
    expect(authWrites).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("the model hub shows known input/output prices and marks incomplete pricing unknown", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let authWrites = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", hidden: false }])
    if (url.pathname === "/config/providers") {
      const model = (id: string, name: string, cost: unknown) => ({
        id,
        name,
        providerID: "opencode",
        status: "active",
        release_date: "2026-01-01",
        cost,
      })
      return json({
        providers: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            source: "custom",
            env: [],
            options: {},
            models: {
              "zen-free": model("zen-free", "Zen Free Model", { input: 0, output: 0, cache: { read: 0, write: 0 } }),
              "zen-unknown": model("zen-unknown", "Zen Unknown Price", { input: 0, output: 0 }),
              "zen-paid": model("zen-paid", "Zen Paid Model", {
                input: 5,
                output: 15,
                cache: { read: 1, write: 2 },
              }),
              "zen-nano": model("zen-nano", "Zen Nano", { input: 0, output: 0, cache: { read: 0, write: 0 } }),
            },
          },
          {
            id: "alternate",
            name: "Alternate Provider",
            source: "env",
            env: ["ALTERNATE_API_KEY"],
            options: {},
            models: {
              "alternate-model": {
                id: "alternate-model",
                name: "Alternate Model",
                providerID: "alternate",
                status: "active",
                release_date: "2026-02-01",
                cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
              },
            },
          },
        ],
        default: { opencode: "zen-free" },
      })
    }
    if (url.pathname === "/provider")
      return json({
        all: [
          { id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {}, models: {} },
          {
            id: "alternate",
            name: "Alternate Provider",
            source: "env",
            env: ["ALTERNATE_API_KEY"],
            options: {},
            models: {},
          },
        ],
        default: {},
        // Static catalog presence is not an access source. Keep the explicit
        // zero-priced anonymous OpenCode offer selectable; the credentialed
        // alternate remains visible but unavailable.
        connected: ["alternate"],
        anonymousFreeProviders: ["opencode"],
        anonymousFreeModels: ["opencode/zen-free"],
      })
    if (url.pathname === "/auth/alternate") {
      authWrites++
      return json({}, { status: 503 })
    }
    return undefined
  })
  let syncStatus: string | undefined
  let dialog: { stack: unknown[] } | undefined
  let selectedModel: { providerID: string; modelID: string } | undefined
  let recentModels: { providerID: string; modelID: string }[] = []

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={calls.fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <RouteProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <LocalProvider>
                                <DialogProvider>
                                  <Probe />
                                </DialogProvider>
                                <Toast />
                              </LocalProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </RouteProvider>
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
    const local = useLocal()
    createEffect(() => (syncStatus = sync.status))
    createEffect(() => (selectedModel = local.model.current()))
    createEffect(() => (recentModels = local.model.recent()))
    dialog = current
    onMount(() => current.replace(() => <DialogModel />))
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
    await waitFor(() => syncStatus === "complete")
    const frame = await waitForFrame(app, (value) => value.includes("Zen Free Model"))
    expect(frame).toContain("OpenCode Zen")
    expect(frame).toContain("Zen Unknown Price")
    expect(frame).toContain("Zen Paid Model")
    expect(frame).toContain("$5 in / $15 out per 1M")
    expect(frame).toContain("Price unknown")
    expect(frame).toContain("Listed $0")
    // Exactly one model declares a complete zero price; incomplete pricing
    // must not claim that label, and unavailable entries stay hidden.
    expect(frame.split("Listed $0").length - 1).toBe(1)
    expect(frame).not.toContain("Zen Nano")

    // A credentialed alternative is visible with provenance but remains
    // unavailable until its SecretBroker transport is Guarded.
    const alternateFrame = await waitForFrame(app, (value) => value.includes("Alternate Model"))
    expect(alternateFrame).toContain("Alternate Provider")
    const rendered = app.captureCharFrame()
    const rows = rendered.split("\n")
    const row = rows.findIndex((line) => line.includes("Alternate Model"))
    const beforeModel = selectedModel
    const beforeRecent = recentModels
    await app.mockMouse.click(rows[row]!.indexOf("Alternate Model"), row)
    await app.renderOnce()
    await Bun.sleep(100)
    // Choosing the visible-but-unavailable row must not replace the selected
    // model and must not record it as recent (arch_V1/16 provider/model hub).
    expect(selectedModel).toEqual(beforeModel)
    expect(recentModels).toEqual(beforeRecent)
    expect(authWrites).toBe(0)

    // The explicitly zero-priced anonymous OpenCode offer can be selected.
    const freeRows = app.captureCharFrame().split("\n")
    const freeRow = freeRows.findIndex((line) => line.includes("Zen Free Model"))
    await app.mockMouse.click(freeRows[freeRow]!.indexOf("Zen Free Model"), freeRow)
    await app.renderOnce()
    await Bun.sleep(50)
    expect(selectedModel).toEqual({ providerID: "opencode", modelID: "zen-free" })
    // The offered model really is selectable: set() ran with recent tracking.
    expect(recentModels).toEqual([{ providerID: "opencode", modelID: "zen-free" }])
    expect(authWrites).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
