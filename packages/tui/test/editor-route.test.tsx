import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@horizoncode/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Global } from "@horizoncode/core/global"
import * as ExternalEditorProfile from "../../schema/src/external-editor-profile-v1"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

// The mounted app bootstrap (Effect run + plugin host + sync fetches) takes
// 16–90+ s while other owners' typecheck/build jobs hold the host (observed
// load 8–35), so the original 30 s budget timed out before any assertion
// failed. Assertions, the 5 s per-frame deadlines, and coverage are unchanged;
// only the wall-clock budget reflects observed host contention.
test("workspace editor overlay and side pane are opt-in and close back to the single-pane session", async () => {
  const setup = await createTestRenderer({ width: 100, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const sessionID = "editor_route"
  const session = {
    id: sessionID,
    title: "Editor route test",
    slug: sessionID,
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  }
  const message = {
    info: {
      id: "editor-message",
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "editor-user",
      modelID: "model",
      providerID: "test",
      mode: "build",
      agent: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "editor-text", sessionID, messageID: "editor-message", type: "text", text: "Single-pane session" }],
  }
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/global/event")) return events.response()
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/question`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [{
      id: "editor-message",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      content: [{ type: "text", id: "editor-text", text: "Single-pane session" }],
      time: { created: 1, completed: 2 },
    }], cursor: {} })
    if (url.pathname === `/session/${sessionID}/message`) return json([message])
    return undefined
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { sessionID },
        pluginHost: {
          async start(input) { api = input.api; started() },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    const frame = async (predicate: (frame: string) => boolean) => {
      const deadline = Date.now() + 5_000
      let value = ""
      while (Date.now() < deadline) {
        await setup.renderOnce()
        value = setup.captureCharFrame().replace(/\s+/g, " ")
        if (predicate(value)) return value
        await Bun.sleep(10)
      }
      return value
    }

    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")
    expect(setup.captureCharFrame()).not.toContain("Workspace Explorer")

    api?.keymap.dispatchCommand("session.editor.open")
    expect(await frame((value) => value.includes("Workspace Explorer"))).toContain("Workspace Explorer")
    setup.mockInput.pressKey("ESC")
    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")

    api?.keymap.dispatchCommand("session.editor.open.side")
    expect(await frame((value) => value.includes("Workspace Explorer"))).toContain("Workspace Explorer")
    api?.keymap.dispatchCommand("session.editor.close")
    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 180_000 })

// EDITOR-013: `/settings` → Editors changes the user-owned profile selection
// with one CAS write, returns to the single-pane session, and the Explorer
// still mounts only by explicit command afterwards. The capability chips in the
// Settings header are a read-only projection; nothing in this journey starts a
// process, and the host launch route stays closed.
test("settings editor selection then opt-in Explorer stays a read-only journey (EDITOR-013)", async () => {
  const setup = await createTestRenderer({ width: 100, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const sessionID = "editor_route_settings"
  const session = {
    id: sessionID,
    title: "Editor settings journey",
    slug: sessionID,
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  }
  const message = {
    info: {
      id: "editor-settings-message",
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "editor-settings-user",
      modelID: "model",
      providerID: "test",
      mode: "build",
      agent: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "editor-settings-text", sessionID, messageID: "editor-settings-message", type: "text", text: "Single-pane session" }],
  }
  const events = createEventSource()

  const definition = {
    schemaVersion: 1 as const,
    profileId: "nvim",
    revision: "1",
    executableSelector: "horizoncode:editor:nvim",
    argv: [] as string[],
    targetArgIndex: 0,
    launchMode: "foreground_tty" as const,
    targetKinds: ["prompt_scratch", "workspace_file"] as const,
    environmentPolicy: "sanitized_host" as const,
  }
  const profileRef = ExternalEditorProfile.externalEditorProfileRefV1(definition)
  const projection = { schemaVersion: 1 as const, revision: "1", selected: null, profiles: [{ definition, profileRef }] }
  const patches: unknown[] = []

  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/global/event")) return events.response()
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/question`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [
          {
            id: "editor-settings-message",
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", id: "editor-settings-text", text: "Single-pane session" }],
            time: { created: 1, completed: 2 },
          },
        ],
        cursor: {},
      })
    if (url.pathname === `/session/${sessionID}/message`) return json([message])
    return undefined
  })

  // Test-local wrapper: the Settings-owned paths are served here (GET/PATCH
  // distinguished by the Request) so the shared fetch fixture stays untouched.
  const fetchWithSettings = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/skill") return json([])
    if (url.pathname === "/config/external-editor-profiles") {
      if (request.method === "PATCH") {
        const body = (await request.clone().json()) as { expectedSelection: unknown; select: unknown }
        patches.push(body)
        return json({ ...projection, revision: "2", selected: body.select })
      }
      return json(projection)
    }
    return calls.fetch(request, init)
  }) as typeof fetch

  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: fetchWithSettings,
        events: events.source,
        args: { sessionID },
        pluginHost: {
          async start(input) { api = input.api; started() },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    const frame = async (predicate: (frame: string) => boolean) => {
      const deadline = Date.now() + 5_000
      let value = ""
      while (Date.now() < deadline) {
        await setup.renderOnce()
        value = setup.captureCharFrame().replace(/\s+/g, " ")
        if (predicate(value)) return value
        await Bun.sleep(10)
      }
      return value
    }

    // EDITOR-010: the session starts single-pane with no Explorer mounted.
    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")

    // `/settings` renders the read-only Horizon Coding Profile capability chips.
    api?.keymap.dispatchCommand("session.settings")
    expect(await frame((value) => value.includes("Capability exposure") && value.includes("Editors"))).toContain("Precedence: Coding profile default")

    // Enter Editors and pick the saved immutable profile.
    setup.mockInput.pressKey("ARROW_DOWN")
    setup.mockInput.pressKey("ARROW_UP")
    setup.mockInput.pressEnter()
    expect(await frame((value) => value.includes("Saved immutable profiles"))).toContain("horizoncode:editor:nvim")
    setup.mockInput.pressKey("ARROW_DOWN")
    setup.mockInput.pressEnter()
    expect(await frame((value) => value.includes("Selected: nvim"))).toContain("does not launch or authorize a process")
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ expectedSelection: null, select: profileRef })

    // Escape returns to the single-pane session without any further write.
    setup.mockInput.pressKey("ESC")
    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")

    // The Explorer still mounts only by explicit command after the settings change.
    api?.keymap.dispatchCommand("session.editor.open")
    expect(await frame((value) => value.includes("Workspace Explorer"))).toContain("Workspace Explorer")
    api?.keymap.dispatchCommand("session.editor.close")
    expect(await frame((value) => value.includes("Single-pane session") && !value.includes("Workspace Explorer"))).toContain("Single-pane session")

    // The whole journey produced exactly one settings PATCH and no launch.
    expect(patches).toHaveLength(1)

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 180_000 })
