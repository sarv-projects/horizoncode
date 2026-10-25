/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { DialogProviderDoctor } from "../../src/component/dialog-provider-doctor"
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
import { createFetch, eventSource } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() > start + timeout) throw new Error("timed out waiting for Provider Doctor")
    await Bun.sleep(10)
  }
}

async function waitForFrame(app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string }) {
  const start = Date.now()
  let frame = ""
  while (!frame.includes("Full tier")) {
    await app.renderOnce()
    frame = app.captureCharFrame().replace(/\s+/g, " ")
    if (Date.now() > start + 2000) throw new Error(`timed out waiting for complete Provider Doctor frame: ${frame}`)
    await Bun.sleep(10)
  }
  return frame
}

test("offline Doctor TUI entry makes no provider or credential request", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const requests: string[] = []
  const fallback = createFetch()
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(String(input), init)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/provider/doctor/offline") {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          doctorRunId: "doctor_offline_test",
          tier: "offline",
          selection: { providerRef: "provider:unselected", configurationStatus: "UNKNOWN" },
          localReadiness: "UNKNOWN",
          catalogFreshness: "UNKNOWN",
          remoteChecks: { entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" },
          credentialAccess: "NOT_READ",
          networkRequestCount: 0,
          costStatus: "NOT_APPLICABLE",
          probes: [{ phase: "config", outcome: "UNKNOWN", code: "local_config_status_unknown" }],
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    return fallback.fetch(request)
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof globalThis.fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
              <ExitProvider exit={() => {}}><SyncProvider><ThemeProvider mode="dark"><ToastProvider>
                <LocalProvider><DialogProvider><Probe /></DialogProvider><Toast /></LocalProvider>
              </ToastProvider></ThemeProvider></SyncProvider></ExitProvider>
            </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  let dialog: { stack: unknown[] } | undefined
  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() => current.replace(() => <DialogProviderDoctor />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>,
    { kittyKeyboard: true, width: 100, height: 30 },
  )
  try {
    await waitFor(() => dialog?.stack.length === 1)
    const frame = await waitForFrame(app)
    expect(frame).toContain("Provider Doctor")
    expect(frame).toContain("Offline")
    expect(frame).toContain("Configuration: UNKNOWN")
    expect(frame).toContain("Local catalog snapshot: UNKNOWN · Credentials: NOT_READ")
    expect(frame).toContain("Remote: UNCHECKED · Requests: 0 · Cost: NOT_APPLICABLE")
    expect(frame).toContain("Offline tier: available · 0 requests · no credentials · no charge; diagnostics never contact a provider.")
    expect(frame).toContain("Catalog tier: unavailable · Guarded network access is required. No requests are sent.")
    expect(frame).toContain("Full tier: unavailable · may incur cost; requires separate network grant and explicit spend consent.")
    expect(frame).toContain("Guarded dispatch only. No provider fallback. Consent alone cannot enable a probe.")
    expect(requests.filter((request) => request.endsWith("/provider/doctor/offline")).length).toBe(1)
    expect(requests.some((request) => request.includes("/auth/") || request.includes("/oauth/"))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
