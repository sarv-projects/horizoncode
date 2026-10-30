/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { Global } from "@horizoncode/core/global"
import type { TuiPluginApi } from "@horizoncode/plugin/tui"
import type { GlobalEvent } from "@horizoncode/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createEventSource, createFetch, directory, json } from "../../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"

/**
 * UI-001 / UI-002 rendered transcript behaviour, mounted through the real app.
 *
 * The session route only mounts its `<scrollbox>` when the session exists in the
 * sync store, and `UserMessage` renders exclusively from message *parts* — so the
 * fixture below serves `/session`, `/session/:id` and `/session/:id/message`
 * (with parts) and appends live rows through `message.updated` +
 * `message.part.updated`. No provider turn is involved: the backend is a fixture.
 *
 * `args.continue` is what feeds `RouteProvider` its `{type:"session"}` initial
 * route, and that route hard-codes the id `dummy`.
 */
const sessionID = "dummy"
const COUNT = 40

const session = {
  id: sessionID,
  title: "scroll probe",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: `${directory}/packages/tui`,
}

function userMessage(index: number) {
  return {
    id: `msg_${index}`,
    sessionID,
    role: "user" as const,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    path: { cwd: session.directory, root: session.directory },
    time: { created: index },
    text: `ANCHOR-${index}`,
  }
}

function textPart(index: number) {
  return {
    id: `prt_${index}`,
    sessionID,
    messageID: `msg_${index}`,
    type: "text" as const,
    text: `ANCHOR-${index}`,
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function readFrame(app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string }) {
  return app.captureCharFrame().replace(/\s+/g, " ")
}

async function render(app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string }) {
  await app.renderOnce()
  await Bun.sleep(30)
  await app.renderOnce()
  return readFrame(app)
}

async function waitFor(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  label: string,
  timeout = 6000,
) {
  const start = Date.now()
  let last = ""
  while (Date.now() - start <= timeout) {
    await app.renderOnce()
    last = readFrame(app)
    if (predicate(last)) return last
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}; last frame: ${last.slice(0, 600)}`)
}

test(
  "transcript follows only at the bottom and stays anchored near the tail (UI-001/UI-002)",
  async () => {
    await using tmp = await tmpdir()
    const setup = await createTestRenderer({ width: 110, height: 44, useThread: false })
    const core = await import("@opentui/core")
    await mock.module("@opentui/core", () => ({
      ...core,
      createCliRenderer: async () => setup.renderer,
    }))

    const events = createEventSource()
    const calls = createFetch((url) => {
      // The SDK reaches these under both /session and /api/session prefixes.
      const path = url.pathname.replace(/^\/api/, "")
      if (path === "/session") return json([session])
      if (path === `/session/${sessionID}`) return json(session)
      if (path === `/session/${sessionID}/message`) {
        return json(
          Array.from({ length: COUNT }, (_, index) => ({
            info: userMessage(index + 1),
            parts: [textPart(index + 1)],
          })),
        )
      }
      if (path.startsWith(`/session/${sessionID}/`)) return json([])
      return undefined
    })

    let api: TuiPluginApi | undefined
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })

    try {
      const { run } = await import("../../../../src/app")
      const task = Effect.runPromise(
        run({
          url: "http://test",
          directory,
          config: createTuiResolvedConfig({ plugin_enabled: {} }),
          fetch: calls.fetch,
          events: events.source,
          args: { continue: true },
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

      // --- UI-001: streaming/loaded tail is what the reader sees at the bottom
      const tail = await waitFor(
        setup,
        (frame) => frame.includes(`ANCHOR-${COUNT}`),
        "the newest message at the bottom of the transcript",
      )
      expect(tail).toContain(`ANCHOR-${COUNT}`)

      // One half-page command is a quarter-viewport scroll. The renderer must
      // preserve this near-tail position when the next message arrives.
      // The route finishes its first sync with a deferred toBottom(); let that
      // land before scrolling so this test does not race the initial position.
      await Bun.sleep(600)
      await waitFor(setup, (frame) => frame.includes(`ANCHOR-${COUNT}`), "the settled tail")

      const up = api?.keymap.dispatchCommand("session.half.page.up")
      expect(up?.ok).toBe(true)
      // Wait until the newest message is genuinely off-screen: this proves the
      // reader detached instead of racing the route's asynchronous first sync.
      const scrolled = await waitFor(
        setup,
        (frame) => !frame.includes(`ANCHOR-${COUNT}`) && /ANCHOR-\d+/.test(frame),
        "the reader to detach while older messages stay mounted",
      )
      const anchorBefore = scrolled.match(/ANCHOR-\d+/)?.[0]
      expect(anchorBefore).toBeDefined()
      // Sticky-bottom must not silently re-engage after the scroll settles.
      await Bun.sleep(120)
      const settled = await render(setup)
      expect(settled).not.toContain(`ANCHOR-${COUNT}`)
      expect(settled).toContain(anchorBefore!)

      // --- UI-002: a new tail message must not drag a scrolled-up reader down
      events.emit(
        global({
          id: "evt_new_1",
          type: "message.updated",
          properties: { sessionID, info: userMessage(41) },
        }),
      )
      events.emit(
        global({
          id: "evt_new_part_1",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 2,
            part: { ...textPart(41), text: "NEWTAIL-41" },
          },
        }),
      )

      // Give the message store and the deferred boundary check time to run.
      await Bun.sleep(80)
      const afterAppend = await render(setup)
      expect(afterAppend).not.toContain("NEWTAIL-41")
      // Still the same reader position: no jump.
      expect(afterAppend).toContain(anchorBefore!)

      // --- UI-002: a reader farther up the transcript also stays anchored
      for (let index = 0; index < 3; index++) {
        api?.keymap.dispatchCommand("session.half.page.up")
        await Bun.sleep(50)
      }
      const farScrolled = await render(setup)
      const farAnchorBefore = farScrolled.match(/ANCHOR-\d+/)?.[0]
      expect(farAnchorBefore).toBeDefined()
      events.emit(
        global({
          id: "evt_new_2",
          type: "message.updated",
          properties: { sessionID, info: userMessage(42) },
        }),
      )
      events.emit(
        global({
          id: "evt_new_part_2",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 3,
            part: { ...textPart(42), text: "NEWTAIL-42" },
          },
        }),
      )
      await Bun.sleep(80)
      const afterFarAppend = await render(setup)
      expect(afterFarAppend).not.toContain("NEWTAIL-42")
      expect(afterFarAppend).toContain(farAnchorBefore!)

      // --- scroll back to the bottom; following must resume
      for (let index = 0; index < 12; index++) {
        api?.keymap.dispatchCommand("session.half.page.down")
        await Bun.sleep(25)
      }
      await waitFor(
        setup,
        (frame) => frame.includes("NEWTAIL-42"),
        "the viewport to return to the tail after scrolling back down",
      )

      // --- UI-001 again: a tail append is now followed
      events.emit(
        global({
          id: "evt_new_3",
          type: "message.updated",
          properties: { sessionID, info: userMessage(43) },
        }),
      )
      events.emit(
        global({
          id: "evt_new_part_3",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 4,
            part: { ...textPart(43), text: "NEWTAIL-43" },
          },
        }),
      )
      const followed = await waitFor(
        setup,
        (frame) => frame.includes("NEWTAIL-43"),
        "the newest message to be followed while the reader is at the bottom",
      )
      expect(followed).toContain("NEWTAIL-43")

      api?.keymap.dispatchCommand("app.exit")
      await task
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    }
  },
  { timeout: 180_000 },
)
