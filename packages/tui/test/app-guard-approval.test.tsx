import { expect, mock, test } from "bun:test"
import type { GlobalEvent } from "@horizoncode/sdk/v2"
import type { TuiPluginApi } from "@horizoncode/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Global } from "@horizoncode/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"

test("a pending Guard approval event becomes a visible fail-closed TUI decision", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  const events = createEventSource()
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: createFetch((url) => {
          if (url.pathname === "/provider")
            return new Response(
              JSON.stringify({
                all: [{ id: "test", name: "Test Provider", source: "custom", env: [], options: {}, models: {} }],
                default: {},
                connected: ["test"],
              }),
              { headers: { "content-type": "application/json" } },
            )
          if (url.pathname === "/config/providers")
            return new Response(
              JSON.stringify({
                providers: [
                  {
                    id: "test",
                    name: "Test Provider",
                    models: {
                      model: {
                        id: "model",
                        name: "Test Model",
                        providerID: "test",
                        status: "active",
                        cost: { input: 0, output: 0 },
                      },
                    },
                  },
                ],
                default: {},
              }),
              { headers: { "content-type": "application/json" } },
            )
          return undefined
        }, events).fetch,
        events: events.source,
        args: { model: "test/model" },
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
    await Bun.sleep(50)
    events.emit({
      directory,
      workspace: "workspace-main",
      payload: {
        id: "event-approval-1",
        type: "guard.approval.requested",
        properties: {
          approvalID: "approval-1",
          challengeID: "challenge-1",
          effectID: "effect-1",
          capabilityID: "builtin.verifier",
          locationID: "loc_0123456789abcdef",
          inputDigest: `blake3:${"a".repeat(64)}`,
          normalizedTargets: [{ criterionID: "tests-pass", resource: "kernel/tests/**" }],
          expiresAtUnixMs: Date.now() + 60_000,
          policySummary: "Run one host-registered verifier criterion in this workspace.",
          origin: "managed_run",
          runID: "run-1",
          source: "managed verifier profile",
          policyID: "broker-process.local.v1",
          policyDigest: `blake3:${"b".repeat(64)}`,
          normalizedAction: "builtin.verifier",
          argumentSummary: { status: "unavailable", reason: "not included in this event" },
          requestedGuarantees: ["process.confined", "workspace.read_only"],
          guaranteeAssessment: { status: "not_assessed", residual: null },
          allowEnabled: false,
          noResponse: "deny_and_expire",
        },
      },
    } as unknown as GlobalEvent)

    const deadline = Date.now() + 3000
    let frame = ""
    while (!frame.includes("Guard approval") && Date.now() < deadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      await Bun.sleep(10)
    }
    expect(frame).toContain("Guard approval")
    expect(frame).toContain("builtin.verifier")
    expect(frame).toContain("Deny (default)")
    expect(frame.replace(/\s+/g, "")).toContain("Allow:unavailable")
    expect(frame).toContain("incomplete")

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })
