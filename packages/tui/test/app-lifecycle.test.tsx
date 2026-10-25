import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/dummy/question") return json({ data: [] })
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
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
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("the live session route renders redacted activity and applies canonical text deltas", async () => {
  const setup = await createTestRenderer({ width: 100, height: 50, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const sessionID = "route_stream"
  const deltaEvent = {
    directory,
    payload: {
      id: "route-live-delta-event",
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID: "msg-10050",
        partID: "route-c-live-text",
        field: "text",
        delta: " with live route update",
      },
    },
  }
  const deltaWhileReading = {
    ...deltaEvent,
    payload: {
      ...deltaEvent.payload,
      id: "route-live-delta-while-reading",
      properties: { ...deltaEvent.payload.properties, delta: " during history scroll" },
    },
  }
  let eventConnections = 0
  let firstEventStream: ReadableStreamDefaultController<Uint8Array> | undefined
  const eventStreams: ReadableStreamDefaultController<Uint8Array>[] = []
  let canonicalText = "route canonical base"
  const messageCount = 10_050
  const session = {
    id: sessionID,
    title: "Route stream acceptance",
    slug: sessionID,
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: messageCount },
  }
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const id = `msg-${String(index + 1).padStart(3, "0")}`
    const assistant = index === messageCount - 1
    return {
      info: {
        id,
        sessionID,
        role: assistant ? "assistant" : "user",
        time: { created: index + 1, ...(assistant ? { completed: index + 2 } : {}) },
        ...(assistant
          ? {
              parentID: `msg-${String(index).padStart(3, "0")}`,
              modelID: "model",
              providerID: "test",
              mode: "build",
              agent: "build",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            }
          : {}),
      },
      parts: assistant
        ? [
            {
              id: "route-a-private-reasoning",
              sessionID,
              messageID: id,
              type: "reasoning",
              text: "private route reasoning marker",
              time: { start: 1, end: 2 },
            },
            {
              id: "route-b-tool-call",
              sessionID,
              messageID: id,
              type: "tool",
              callID: "route-b-tool-call",
              tool: "bash",
              state: {
                status: "completed",
                input: {
                  command: "curl -H 'Authorization: Bearer route-bearer-secret-value'",
                  apiKey: "route-api-secret-value",
                },
                output: "route tool first line\nroute tool second line\nroute tool third line\nroute tool expanded marker",
                title: "Ran a command",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
            {
              id: "route-c-live-text",
              sessionID,
              messageID: id,
              type: "text",
              text: "route canonical base",
            },
          ]
        : index === 0
          ? [
              {
                id: "route-oldest-text",
                sessionID,
                messageID: id,
                type: "text",
                text: "earliest history marker",
              },
            ]
          : [],
    }
  })
  const messageRequests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/global/event")) {
      eventConnections++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            eventStreams.push(controller)
            if (eventConnections === 1) {
              firstEventStream = controller
              return
            }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(deltaEvent)}\n\n`))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === `/api/session/${sessionID}/message`) {
      const info = messages.at(-1)!.info
      return json({
        data: [
          {
            id: info.id,
            type: "assistant",
            agent: "build",
            model: { providerID: "test", id: "model" },
            content: [{ type: "text", id: "route-live-text", text: canonicalText }],
            time: { created: 1, completed: 2 },
          },
        ],
        cursor: {},
      })
    }
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/todo`) return json([])
    if (url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/question`) return json({ data: [] })
    if (url.pathname === `/session/${sessionID}/message`) {
      messageRequests.push(url)
      const limit = Number(url.searchParams.get("limit") ?? 100)
      const cursor = url.searchParams.get("before")
      const before = cursor ? Number(cursor) : messages.length
      const start = Math.max(0, before - limit)
      return json(messages.slice(start, before), {
        headers: start > 0 ? { "X-Next-Cursor": String(start) } : {},
      })
    }
    return undefined
  })
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
        fetch: calls.fetch,
        args: { sessionID },
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
    const deadline = Date.now() + 5_000
    let frame = ""
    while (Date.now() < deadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (messageRequests.length === 100 && frame.includes("route canonical base")) break
      await Bun.sleep(10)
    }
    expect(messageRequests).toHaveLength(100)
    expect(messageRequests[0]?.searchParams.get("before")).toBe(null)
    expect(messageRequests[1]?.searchParams.get("before")).toBe("9950")
    expect(messageRequests.at(-1)?.searchParams.get("before")).toBe("150")
    expect(frame).toContain("route canonical base")
    expect(frame).toContain("Reasoning ·")
    expect(frame).toContain("Succeeded shell")
    expect(frame).not.toContain("route tool first line")
    expect(frame).not.toContain("route tool expanded marker")
    expect(frame).not.toContain("private route reasoning marker")
    expect(frame).not.toContain("route-bearer-secret-value")
    expect(frame).not.toContain("route-api-secret-value")
    expect(frame).toContain("Showing the latest 10,000 messages")

    const toggle = setup.renderer.root.findDescendantById("activity-output-toggle-route-b-tool-call") as
      | { focusable: boolean; focus: () => void }
      | undefined
    expect(toggle).toBeDefined()
    expect(toggle?.focusable).toBe(true)
    toggle!.focus()
    expect(setup.captureCharFrame()).toContain("Expand output")

    firstEventStream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(deltaEvent)}\n\n`))
    const liveDeadline = Date.now() + 2_000
    while (Date.now() < liveDeadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (frame.includes("live route update")) break
      await Bun.sleep(10)
    }
    expect(frame).toContain("live route update")
    const liveText = messages.at(-1)!.parts.find((part) => part.id === "route-c-live-text") as
      | { id: string; text: string }
      | undefined
    expect(liveText).toBeDefined()
    liveText!.text = "route canonical base with live route update"
    canonicalText = liveText!.text
    firstEventStream?.close()
    const reconnectDeadline = Date.now() + 5_000
    while (Date.now() < reconnectDeadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (eventConnections >= 2 && frame.includes("live route update")) {
        await Bun.sleep(50)
        frame = setup.captureCharFrame().replace(/\s+/g, " ")
        break
      }
      await Bun.sleep(10)
    }
    expect(eventConnections).toBeGreaterThanOrEqual(2)
    const resnapshotDeadline = Date.now() + 5_000
    while (Date.now() < resnapshotDeadline && messageRequests.length < 300) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(messageRequests).toHaveLength(300)
    await setup.renderOnce()
    frame = setup.captureCharFrame().replace(/\s+/g, " ")
    expect(frame.match(/with live route update/g)).toHaveLength(1)
    api?.keymap.dispatchCommand("session.first")
    const oldestDeadline = Date.now() + 2_000
    while (Date.now() < oldestDeadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (messageRequests.length > 300 && frame.includes("earliest history marker")) break
      await Bun.sleep(10)
    }
    expect(messageRequests).toHaveLength(301)
    expect(messageRequests.at(-1)?.searchParams.get("before")).toBe("50")
    expect(frame).toContain("earliest history marker")
    eventStreams.at(-1)?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(deltaWhileReading)}\n\n`))
    const scrolledDeltaDeadline = Date.now() + 2_000
    while (Date.now() < scrolledDeltaDeadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (messageRequests.length > 300 && frame.includes("earliest history marker")) break
      await Bun.sleep(10)
    }
    expect(frame).toContain("earliest history marker")
    api?.keymap.dispatchCommand("session.last")
    const newestDeadline = Date.now() + 2_000
    while (Date.now() < newestDeadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame().replace(/\s+/g, " ")
      if (frame.includes("during history scroll")) break
      await Bun.sleep(10)
    }
    expect(frame).toContain("during history scroll")
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("fatal startup errors set a nonzero exit after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config")
      return json(
        {
          name: "ConfigRemoteAuthError",
          data: {
            url: "https://example.com",
            remote: "https://config.example.com/opencode.json",
          },
        },
        { status: 400 },
      )
    return undefined
  })
  let disposes = 0
  const originalWrite = process.stderr.write.bind(process.stderr)
  const originalExitCode = process.exitCode ?? 0
  let stderr = ""

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {},
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await task
    expect(stderr).toContain("Run `opencode auth login https://example.com` to re-authenticate.")
    expect(stderr).not.toContain("Unexpected server error")
    expect(process.exitCode).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(disposes).toBe(1)
  } finally {
    process.stderr.write = originalWrite
    process.exitCode = originalExitCode
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
