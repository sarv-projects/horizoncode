import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, onMount } from "solid-js"
import { DataProvider, useData } from "../../src/context/data"
import { SDKProvider } from "../../src/context/sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_stream_mux"
const assistantMessageID = "msg_stream_mux"
const textID = "part_stream_mux"

function event(type: string, properties: Record<string, unknown>, durable?: { aggregateID: string; seq: number; version: number }) {
  return {
    directory: "/tmp/stream-mux",
    payload: {
      id: `evt_${type}_${durable?.seq ?? "paint"}`,
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

    updates = 0
    for (let index = 0; index < 1000; index++) {
      events.emit(
        event("session.next.text.delta", {
          timestamp: index + 3,
          sessionID,
          assistantMessageID,
          textID,
          delta: "x",
        }),
      )
    }
    await waitForState(() => {
      const assistant = data!.session.message.list(sessionID)?.find((item) => item.type === "assistant")
      return assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text.length === 1000
    })
    const coalesced = data!.stream.stats().coalesced
    expect(coalesced).toBeGreaterThan(0)
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
      return assistant?.type === "assistant" && assistant.content.find((part) => part.type === "text")?.text.length === 1002
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
