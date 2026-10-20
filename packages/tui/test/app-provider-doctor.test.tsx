import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("provider.doctor.offline is discoverable as a system settings command", async () => {
  const setup = await createTestRenderer({ width: 100, height: 32, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls: string[] = []
  const fallback = createFetch()
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/provider/doctor/offline") return json({
      schemaVersion: 1,
      doctorRunId: "doctor_offline_test",
      tier: "offline",
      selection: { providerRef: "provider:unselected", configurationStatus: "UNKNOWN" },
      localReadiness: "UNKNOWN",
      remoteChecks: { entitlement: "UNCHECKED", quota: "UNCHECKED", service: "UNCHECKED" },
      credentialAccess: "NOT_READ",
      networkRequestCount: 0,
      costStatus: "NOT_APPLICABLE",
      probes: [{ phase: "config", outcome: "UNKNOWN", code: "local_config_status_unknown" }],
    })
    return fallback.fetch(request)
  }) as typeof globalThis.fetch

  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch,
      events: events.source,
      args: {},
      pluginHost: {
        async start(input) { api = input.api; started() },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))))
    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("provider.doctor.offline").ok).toBe(true)
    const deadline = Date.now() + 2_000
    while (!calls.includes("POST /provider/doctor/offline") && Date.now() < deadline) await Bun.sleep(10)
    expect(calls).toContain("POST /provider/doctor/offline")
    expect(calls.some((call) => call.includes("/auth/") || call.includes("/oauth/") || call.includes("/provider/chat"))).toBe(false)
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 15_000 })
