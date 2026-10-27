import type { GlobalEvent, SessionMessage } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, onMount } from "solid-js"
import { DataProvider, useData } from "../../src/context/data"
import { SDKProvider } from "../../src/context/sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, eventSource, json } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_stream_mux"
const assistantMessageID = "msg_stream_mux"
const textID = "part_stream_mux"
let eventCounter = 0
const streamCursor = new Map<string, { generation: string; sequence: number; offset: number }>()

function streamPart(properties: Record<string, unknown>) {
  const partID = properties.textID ?? properties.reasoningID ?? properties.callID
  return `${String(properties.sessionID)}:${String(properties.assistantMessageID)}:${String(partID)}`
}

function event(
  type: string,
  properties: Record<string, unknown>,
  durable?: { aggregateID: string; seq: number; version: number },
) {
  eventCounter++
  const key = streamPart(properties)
  const streamType = type.match(/^session\.next\.(text|reasoning|tool\.input)\.(started|delta|ended)$/)
  if (streamType) {
    const current = streamCursor.get(key)
    if (streamType[2] === "started") {
      streamCursor.set(key, { generation: `test-stream-${eventCounter}`, sequence: 0, offset: 0 })
      properties.sourceGeneration = streamCursor.get(key)!.generation
    } else if (current) {
      properties.sourceGeneration = current.generation
      if (streamType[2] === "delta") {
        const sequence = typeof properties.sequence === "number" ? properties.sequence : current.sequence
        properties.sequence = sequence
        properties.offset = typeof properties.offset === "number" ? properties.offset : current.offset
        streamCursor.set(key, {
          ...current,
          sequence: Math.max(current.sequence, sequence + 1),
          offset: Math.max(current.offset, Number(properties.offset) + String(properties.delta ?? "").length),
        })
      } else {
        properties.sequence = typeof properties.sequence === "number" ? properties.sequence : current.sequence
      }
    }
  }
  return {
    directory: "/tmp/stream-mux",
    payload: {
      id: durable ? `evt_${type}_${durable.seq}` : `evt_${type}_${eventCounter}`,
      type,
      properties,
      ...(durable ? { durable } : {}),
    },
  } as GlobalEvent
}

async function waitForState(predicate: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for streamed text")
    await Bun.sleep(10)
  }
}

test("V2 stream deltas are coalesced without changing text and durable deltas stay immediate", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const api = createFetch(undefined, events)
  let data: ReturnType<typeof useData> | undefined
  let ready = false
  let updates = 0

  function Probe() {
    data = useData()
    createEffect(() => {
      const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
      if (assistant?.type === "assistant") {
        assistant.content.find((part) => part.type === "text")?.type
        assistant.content.find((part) => part.type === "text")?.text
      }
      updates++
    })
    onMount(() => {
      ready = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={api.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await Bun.sleep(20)
    events.emit(
      event("session.next.step.started", {
        timestamp: 1,
        sessionID,
        assistantMessageID,
        agent: {},
        model: {},
      }),
    )
    events.emit(
      event("session.next.text.started", {
        timestamp: 2,
        sessionID,
        assistantMessageID,
        textID,
      }),
    )
    await waitForState(() => {
      const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
      return assistant?.type === "assistant" && assistant.content.some((part) => part.type === "text")
    })

    const observations = data!.stream
      .observations()
      .map(({ observedAtMs: _observedAtMs, ...observation }) => observation)
    expect(observations).toEqual([
      {
        metric: "ui.queue.pending_events",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.queue.pending_bytes",
        value: 0,
        unit: "bytes",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.queue.coalesced_events",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.queue.dropped_events",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.queue.direct_deliveries",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.stream.duplicates_suppressed",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
      {
        metric: "ui.stream.resnapshots_required",
        value: 0,
        unit: "events",
        provenance: "measured",
        source: "ui-event-mux",
      },
    ])

    updates = 0
    for (let index = 0; index < 1000; index++) {
      events.emit(
        event("session.next.text.delta", {
          timestamp: index + 3,
          sessionID,
          assistantMessageID,
          textID,
          delta: "x",
          sequence: index,
          sourceGeneration: `${assistantMessageID}:${textID}`,
        }),
      )
    }
    await waitForState(() => {
      const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
      return (
        assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text.length === 1000
      )
    })
    const coalesced = data!.stream.stats().coalesced
    expect(coalesced).toBeGreaterThan(0)
    expect(
      Object.fromEntries(
        data!.stream.observations().map(({ metric, value, provenance }) => [metric, { value, provenance }]),
      ),
    ).toEqual({
      "ui.queue.pending_events": { value: 0, provenance: "measured" },
      "ui.queue.pending_bytes": { value: 0, provenance: "measured" },
      "ui.queue.coalesced_events": { value: coalesced, provenance: "measured" },
      "ui.queue.dropped_events": { value: 0, provenance: "measured" },
      "ui.queue.direct_deliveries": { value: 0, provenance: "measured" },
      "ui.stream.duplicates_suppressed": { value: 0, provenance: "measured" },
      "ui.stream.resnapshots_required": { value: 0, provenance: "measured" },
    })
    expect(updates).toBeLessThan(1000)

    events.emit(
      event(
        "session.next.text.delta",
        { timestamp: 1003, sessionID, assistantMessageID, textID, delta: "a" },
        { aggregateID: sessionID, seq: 1, version: 1 },
      ),
    )
    events.emit(
      event(
        "session.next.text.delta",
        { timestamp: 1004, sessionID, assistantMessageID, textID, delta: "b" },
        { aggregateID: sessionID, seq: 2, version: 1 },
      ),
    )
    await waitForState(() => {
      const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
      return (
        assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text.length === 1002
      )
    })
    expect(data!.stream.stats().coalesced).toBe(coalesced)
    const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
    expect(assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text).toBe(
      `${"x".repeat(1000)}ab`,
    )
  } finally {
    app.renderer.destroy()
  }
})

test("flushes queued paint deltas before a terminal failure event is applied", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const api = createFetch(undefined, events)
  const terminalSessionID = "ses_stream_terminal"
  const terminalMessageID = "msg_stream_terminal"
  const terminalTextID = "part_stream_terminal"
  let data: ReturnType<typeof useData> | undefined
  let ready = false
  let textLengthAtFailure: number | undefined

  function Probe() {
    data = useData()
    createEffect(() => {
      const assistant = data!.session.message.list(terminalSessionID)?.find((item) => item.type === "assistant")
      if (assistant?.type !== "assistant" || !assistant.error || textLengthAtFailure !== undefined) return
      textLengthAtFailure = assistant.content.find((part) => part.type === "text")?.text.length ?? 0
    })
    onMount(() => {
      ready = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={api.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await Bun.sleep(20)
    events.emit(
      event("session.next.step.started", {
        timestamp: 1,
        sessionID: terminalSessionID,
        assistantMessageID: terminalMessageID,
        agent: {},
        model: {},
      }),
    )
    events.emit(
      event("session.next.text.started", {
        timestamp: 2,
        sessionID: terminalSessionID,
        assistantMessageID: terminalMessageID,
        textID: terminalTextID,
      }),
    )
    await waitForState(() => {
      const assistant = data!.session.message.list(terminalSessionID)?.find((item) => item.type === "assistant")
      return assistant?.type === "assistant" && assistant.content.some((part) => part.type === "text")
    })

    for (let index = 0; index < 200; index++) {
      events.emit(
        event("session.next.text.delta", {
          timestamp: index + 3,
          sessionID: terminalSessionID,
          assistantMessageID: terminalMessageID,
          textID: terminalTextID,
          delta: "y",
          sequence: index,
          sourceGeneration: `${terminalMessageID}:${terminalTextID}`,
        }),
      )
    }
    events.emit(
      event("session.next.step.failed", {
        timestamp: 500,
        sessionID: terminalSessionID,
        assistantMessageID: terminalMessageID,
        error: { name: "UnknownError", message: "stream aborted" },
      }),
    )

    await waitForState(() => {
      const assistant = data!.session.message.list(terminalSessionID)?.find((item) => item.type === "assistant")
      return assistant?.type === "assistant" && assistant.error !== undefined
    })
    expect(textLengthAtFailure).toBe(200)
  } finally {
    app.renderer.destroy()
  }
})

test("durable text end replaces the streamed prefix exactly once (AC-012)", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const api = createFetch(undefined, events)
  const endedSessionID = "ses_stream_ended"
  const endedMessageID = "msg_stream_ended"
  const endedTextID = "part_stream_ended"
  let data: ReturnType<typeof useData> | undefined
  let ready = false

  function Probe() {
    data = useData()
    onMount(() => {
      ready = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={api.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await Bun.sleep(20)
    events.emit(
      event("session.next.step.started", {
        timestamp: 1,
        sessionID: endedSessionID,
        assistantMessageID: endedMessageID,
        agent: {},
        model: {},
      }),
    )
    events.emit(
      event("session.next.text.started", {
        timestamp: 2,
        sessionID: endedSessionID,
        assistantMessageID: endedMessageID,
        textID: endedTextID,
      }),
    )
    for (let index = 0; index < 200; index++) {
      events.emit(
        event("session.next.text.delta", {
          timestamp: index + 3,
          sessionID: endedSessionID,
          assistantMessageID: endedMessageID,
          textID: endedTextID,
          delta: "z",
          sequence: index,
          sourceGeneration: `${endedMessageID}:${endedTextID}`,
        }),
      )
    }
    events.emit(
      event("session.next.text.ended", {
        timestamp: 500,
        sessionID: endedSessionID,
        assistantMessageID: endedMessageID,
        textID: endedTextID,
        text: "final canonical text",
      }),
    )
    await waitForState(() => {
      const assistant = data!.session.message.list(endedSessionID)?.find((item) => item.type === "assistant")
      return (
        assistant?.type === "assistant" &&
        assistant.content.find((part) => part.type === "text")?.text === "final canonical text"
      )
    })
    const assistant = data!.session.message.list(endedSessionID)?.find((item) => item.type === "assistant")
    expect(assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text).toBe(
      "final canonical text",
    )

    // A late duplicate of an already-ended delta cannot re-append text.
    events.emit(
      event("session.next.text.delta", {
        timestamp: 501,
        sessionID: endedSessionID,
        assistantMessageID: endedMessageID,
        textID: endedTextID,
        delta: "z",
        sequence: 199,
        sourceGeneration: `${endedMessageID}:${endedTextID}`,
      }),
    )
    await Bun.sleep(40)
    const after = data!.session.message.list(endedSessionID)?.find((item) => item.type === "assistant")
    expect(after?.type === "assistant" && after.content.find((part) => part.type === "text")?.text).toBe(
      "final canonical text",
    )
  } finally {
    app.renderer.destroy()
  }
})

test("rejects duplicate and missing source sequences, retries a failed resnapshot, then restores canonical text", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const gapSessionID = "ses_stream_gap"
  const gapMessageID = "msg_stream_gap"
  const gapTextID = "part_stream_gap"
  let refreshCount = 0
  let data: ReturnType<typeof useData> | undefined
  let ready = false
  const canonical: SessionMessage = {
    id: gapMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: gapTextID, text: "canonical after gap" }],
    time: { created: 1, completed: 2 },
  }
  const api = createFetch((url) => {
    if (url.pathname !== `/api/session/${gapSessionID}/message`) return
    refreshCount++
    if (refreshCount === 1) return json({ error: "temporary snapshot failure" }, { status: 503 })
    return json({ data: [canonical], cursor: {} })
  }, events)

  function Probe() {
    data = useData()
    onMount(() => {
      ready = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={api.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await Bun.sleep(20)
    const sourceGeneration = `${gapMessageID}:${gapTextID}`
    events.emit(
      event("session.next.step.started", {
        timestamp: 1,
        sessionID: gapSessionID,
        assistantMessageID: gapMessageID,
        agent: {},
        model: {},
      }),
    )
    events.emit(
      event("session.next.text.started", {
        timestamp: 2,
        sessionID: gapSessionID,
        assistantMessageID: gapMessageID,
        textID: gapTextID,
      }),
    )
    events.emit(
      event("session.next.text.delta", {
        timestamp: 3,
        sessionID: gapSessionID,
        assistantMessageID: gapMessageID,
        textID: gapTextID,
        delta: "a",
        sequence: 0,
        sourceGeneration,
      }),
    )
    events.emit(
      event("session.next.text.delta", {
        timestamp: 4,
        sessionID: gapSessionID,
        assistantMessageID: gapMessageID,
        textID: gapTextID,
        delta: "a",
        sequence: 0,
        sourceGeneration,
      }),
    )
    events.emit(
      event("session.next.text.delta", {
        timestamp: 5,
        sessionID: gapSessionID,
        assistantMessageID: gapMessageID,
        textID: gapTextID,
        delta: "c",
        sequence: 2,
        sourceGeneration,
      }),
    )

    await waitForState(() => {
      const assistant = data!.session.message.list(gapSessionID)?.find((item) => item.type === "assistant")
      return (
        refreshCount === 2 &&
        assistant?.type === "assistant" &&
        assistant.content.find((part) => part.type === "text")?.text === "canonical after gap"
      )
    }, 5_000)
    expect(data!.stream.streamStats().duplicatesSuppressed).toBe(1)
    expect(data!.stream.streamStats().resnapshotsRequired).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("reloads canonical messages when the SDK event stream reconnects", async () => {
  await using tmp = await tmpdir()
  const initialMessage: SessionMessage = {
    id: assistantMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: textID, text: "before reconnect" }],
    time: { created: 1 },
  }
  const refreshedMessage: SessionMessage = {
    id: assistantMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: textID, text: "canonical after reconnect" }],
    time: { created: 1, completed: 2 },
  }
  let canonicalMessages: SessionMessage[] = [initialMessage]
  let refreshCount = 0
  let eventConnections = 0
  const originalFetch = globalThis.fetch
  const eventResponse = (url: URL) => {
    if (!url.pathname.endsWith("/global/event")) return
    eventConnections++
    const body =
      eventConnections === 1
        ? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    directory: tmp.path,
                    payload: {
                      id: "evt_reconnect",
                      type: "session.next.compaction.started",
                      properties: {
                        timestamp: 3,
                        sessionID,
                        messageID: "msg_reconnect",
                        reason: "auto",
                      },
                    },
                  })}\n\n`,
                ),
              )
            },
            cancel() {},
          })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const api = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) {
      refreshCount++
      return json({ data: canonicalMessages, cursor: {} })
    }
    return eventResponse(url)
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return eventResponse(url) ?? originalFetch(input, init)
  }) as typeof fetch
  let data: ReturnType<typeof useData> | undefined
  let ready = false

  function Probe() {
    data = useData()
    onMount(() => {
      ready = true
    })
    return null
  }

  let destroy: (() => void) | undefined
  try {
    const app = await testRender(
      () => (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <SDKProvider url="http://test" directory={tmp.path} fetch={api.fetch}>
            <DataProvider>
              <Probe />
            </DataProvider>
          </SDKProvider>
        </TestTuiContexts>
      ),
      { kittyKeyboard: true },
    )
    destroy = () => app.renderer.destroy()
    await waitForState(() => ready)
    await data!.session.message.refresh(sessionID)
    expect(data!.session.message.list(sessionID)?.[0]).toEqual(initialMessage)
    expect(refreshCount).toBe(1)
    canonicalMessages = [refreshedMessage]
    await Bun.sleep(1200)
    expect(eventConnections).toBeGreaterThanOrEqual(2)
    await waitForState(
      () => {
        const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
        const text = assistant?.type === "assistant" ? assistant.content.find((part) => part.type === "text") : undefined
        return refreshCount === 2 && text?.text === "canonical after reconnect"
      },
      4000,
    )
    expect(refreshCount).toBe(2)
    expect(eventConnections).toBeGreaterThanOrEqual(2)
    const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
    expect(assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text).toBe(
      "canonical after reconnect",
    )
  } finally {
    destroy?.()
    globalThis.fetch = originalFetch
  }
})

test("resnapshots bounded canonical history through older V2 cursor pages in chronological order", async () => {
  await using tmp = await tmpdir()
  const canonical = Array.from({ length: 250 }, (_, index): SessionMessage => ({
    id: `history-${String(index + 1).padStart(3, "0")}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: `text-${index + 1}`, text: `message ${index + 1}` }],
    time: { created: index + 1, completed: index + 2 },
  }))
  const requests: URL[] = []
  const api = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    requests.push(url)
    const limit = Number(url.searchParams.get("limit") ?? 100)
    const cursor = url.searchParams.get("cursor")
    const pageIndex = cursor ? Number(cursor.replace("older-", "")) : 0
    const end = canonical.length - pageIndex * 100
    const start = Math.max(0, end - limit)
    const data = canonical.slice(start, end).toReversed()
    const more = start > 0
    return json({
      data,
      cursor: {
        ...(more ? { previous: `older-${pageIndex + 1}` } : {}),
      },
    })
  })
  let data: ReturnType<typeof useData> | undefined
  let ready = false

  function Probe() {
    data = useData()
    onMount(() => {
      ready = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={api.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await data!.session.message.refresh(sessionID)

    const loaded = data!.session.message.list(sessionID) ?? []
    expect(loaded).toHaveLength(250)
    expect(loaded[0]?.id).toBe("history-001")
    expect(loaded.at(-1)?.id).toBe("history-250")
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.searchParams.get("cursor"))).toEqual([null, "older-1", "older-2"])
    expect(requests.every((request) => request.searchParams.get("limit") === "100")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("holds the first reconnected event until canonical message refresh succeeds", async () => {
  await using tmp = await tmpdir()
  const initialMessage: SessionMessage = {
    id: assistantMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: textID, text: "before reconnect" }],
    time: { created: 1 },
  }
  const refreshedMessage: SessionMessage = {
    id: assistantMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: textID, text: "canonical after recovery" }],
    time: { created: 1, completed: 2 },
  }
  let canonicalMessages: SessionMessage[] = [initialMessage]
  let refreshCount = 0
  let eventConnections = 0
  const refreshSnapshots: string[][] = []
  let releaseRecovery = () => {}
  let recoveryStarted = () => {}
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve
  })
  const recoveryStartedPromise = new Promise<void>((resolve) => {
    recoveryStarted = resolve
  })
  const originalFetch = globalThis.fetch
  const reconnectEvent = {
    directory: tmp.path,
    payload: {
      id: "evt_reconnect_compaction",
      type: "session.next.compaction.ended",
      properties: {
        timestamp: 3,
        sessionID,
        messageID: "msg_reconnect_compaction",
        reason: "auto",
        text: "reconnected compaction",
        recent: [],
      },
    },
  }
  const eventResponse = (url: URL) => {
    if (!url.pathname.endsWith("/global/event")) return
    eventConnections++
    const body =
      eventConnections === 1
        ? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(reconnectEvent)}\n\n`))
            },
            cancel() {},
          })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const api = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) {
      refreshSnapshots.push(data?.session.message.list(sessionID)?.map((message) => message.id) ?? [])
      refreshCount++
      if (refreshCount === 2) return json({ error: "temporary refresh failure" }, { status: 503 })
      if (refreshCount === 3) {
        recoveryStarted()
        return recoveryGate.then(() => json({ data: canonicalMessages, cursor: {} }))
      }
      return json({ data: canonicalMessages, cursor: {} })
    }
    return eventResponse(url)
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return eventResponse(url) ?? originalFetch(input, init)
  }) as typeof fetch
  let data: ReturnType<typeof useData> | undefined
  let ready = false

  function Probe() {
    data = useData()
    onMount(() => {
      ready = true
    })
    return null
  }

  let destroy: (() => void) | undefined
  try {
    const app = await testRender(
      () => (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
          <SDKProvider url="http://test" directory={tmp.path} fetch={api.fetch}>
            <DataProvider>
              <Probe />
            </DataProvider>
          </SDKProvider>
        </TestTuiContexts>
      ),
      { kittyKeyboard: true },
    )
    destroy = () => app.renderer.destroy()
    await waitForState(() => ready)
    await data!.session.message.refresh(sessionID)
    expect(data!.session.message.list(sessionID)?.[0]).toEqual(initialMessage)
    expect(refreshCount).toBe(1)

    canonicalMessages = [refreshedMessage]
    await waitForState(() => refreshCount === 2 && eventConnections >= 2, 5000)
    await Bun.sleep(50)
    expect(data!.session.message.list(sessionID)?.some((message) => message.id === "msg_reconnect_compaction")).toBe(
      false,
    )

    await waitForState(() => refreshCount === 3, 5000)
    await recoveryStartedPromise
    expect(data!.session.message.list(sessionID)?.some((message) => message.id === "msg_reconnect_compaction")).toBe(
      false,
    )
    releaseRecovery()
    await waitForState(
      () => data!.session.message.list(sessionID)?.some((message) => message.id === "msg_reconnect_compaction") === true,
    )

    expect(refreshSnapshots).toEqual([[], [assistantMessageID], [assistantMessageID]])
    const messages = data!.session.message.list(sessionID) ?? []
    expect(messages.filter((message) => message.id === "msg_reconnect_compaction")).toHaveLength(1)
    expect(messages.find((message) => message.id === assistantMessageID)).toEqual(refreshedMessage)
  } finally {
    releaseRecovery()
    destroy?.()
    globalThis.fetch = originalFetch
  }
})

test("retries a canonical refresh when live deltas arrive during pagination", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const raceSessionID = "ses_stream_snapshot_race"
  const raceMessageID = "msg_stream_snapshot_race"
  const raceTextID = "part_stream_snapshot_race"
  let data: ReturnType<typeof useData> | undefined
  let ready = false
  let releaseFirstSnapshot = () => {}
  let firstSnapshotStarted = () => {}
  const firstSnapshotGate = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve })
  const firstSnapshotStartedPromise = new Promise<void>((resolve) => { firstSnapshotStarted = resolve })
  let snapshotCount = 0
  const canonical: SessionMessage = {
    id: raceMessageID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content: [{ type: "text", id: raceTextID, text: "live text included in canonical snapshot" }],
    time: { created: 1 },
  }
  const api = createFetch(async (url) => {
    if (url.pathname !== `/api/session/${raceSessionID}/message`) return
    snapshotCount++
    if (snapshotCount === 1) {
      firstSnapshotStarted()
      await firstSnapshotGate
      return json({ data: [], cursor: {} })
    }
    return json({ data: [canonical], cursor: {} })
  }, events)

  function Probe() {
    data = useData()
    onMount(() => { ready = true })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={api.fetch}>
          <DataProvider><Probe /></DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await waitForState(() => ready)
    await Bun.sleep(20)
    events.emit(event("session.next.step.started", {
      timestamp: 1, sessionID: raceSessionID, assistantMessageID: raceMessageID, agent: {}, model: {},
    }))
    events.emit(event("session.next.text.started", {
      timestamp: 2, sessionID: raceSessionID, assistantMessageID: raceMessageID, textID: raceTextID,
    }))
    await waitForState(() => {
      const assistant = data!.session.message.list(raceSessionID)?.find((item) => item.type === "assistant")
      return assistant?.type === "assistant" && assistant.content.some((part) => part.type === "text")
    })

    const refresh = data!.session.message.refresh(raceSessionID)
    await firstSnapshotStartedPromise
    events.emit(event("session.next.text.delta", {
      timestamp: 3,
      sessionID: raceSessionID,
      assistantMessageID: raceMessageID,
      textID: raceTextID,
      delta: "live text included in canonical snapshot",
      sequence: 0,
      sourceGeneration: "race-generation",
    }))
    await waitForState(() => data!.stream.stats().pendingEvents > 0)
    releaseFirstSnapshot()
    await refresh

    expect(snapshotCount).toBe(2)
    const assistant = data!.session.message.list(raceSessionID)?.find((item) => item.type === "assistant")
    expect(assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text)
      .toBe("live text included in canonical snapshot")
  } finally {
    releaseFirstSnapshot()
    app.renderer.destroy()
  }
})
