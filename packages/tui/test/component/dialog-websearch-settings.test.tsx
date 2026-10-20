/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { DialogWebSearchSettings } from "../../src/component/dialog-websearch-settings"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() > start + timeout) throw new Error("timed out waiting for web-search settings")
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
    last = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(last)) return last
    if (Date.now() > start + timeout) throw new Error(`timed out waiting for web-search dialog frame: ${last}`)
    await Bun.sleep(10)
  }
}

test("web-search settings record route consent and ordering without invoking an unavailable provider", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let config: Record<string, unknown> = {
    model: "keep-this-setting",
    websearch: { enabled: ["exa_keyless", "youcom_free", "firecrawl_keyless"], order: ["exa_keyless", "youcom_free", "firecrawl_keyless"] },
  }
  const configWrites: Record<string, unknown>[] = []
  const authWrites: { providerID: string; body: unknown }[] = []
  const searchRequests: string[] = []
  const fallback = createFetch()
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/config" && request.method === "GET") return json(config)
    if (url.pathname === "/config" && request.method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>
      configWrites.push(body)
      config = body
      return json(config)
    }
    if (url.pathname === "/auth/horizoncode-search-brave" && request.method === "PUT") {
      authWrites.push({ providerID: "horizoncode-search-brave", body: await request.json() })
      return json({ type: "api" })
    }
    if (/search|brave|exa/i.test(url.pathname + url.search)) searchRequests.push(`${request.method} ${url.pathname}`)
    return fallback.fetch(request)
  }
  let dialog: { stack: unknown[] } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolved = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, resolved)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof globalThis.fetch}>
          <TuiConfigProvider config={resolved}>
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
    const current = useDialog()
    dialog = current
    onMount(() => current.replace(() => <DialogWebSearchSettings />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>,
    { kittyKeyboard: true, width: 120, height: 40 },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    const initial = await waitForFrame(app, (frame) => frame.includes("Brave Search"))
    expect(initial).toContain("Built-in default")
    expect(initial).toContain("BYO routes remain unavailable")
    expect(initial).toContain("Disabled")

    // Selecting Brave records explicit consent in route settings. No generic
    // auth credential is created and the absent SecretBroker/Guard transport
    // keeps the provider from receiving a request.
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await waitFor(() => configWrites.length === 1)
    await waitForFrame(app, (frame) => frame.includes("Enabled · route 2 · unconfigured"))
    expect(authWrites).toEqual([])
    expect(configWrites[0]?.websearch).toEqual({
      enabled: ["exa_keyless", "youcom_free", "firecrawl_keyless", "brave"],
      order: ["exa_keyless", "youcom_free", "firecrawl_keyless", "brave"],
    })
    expect(searchRequests).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
