/** @jsxImportSource @opentui/solid */
import type { GlobalEvent, QuestionV2Request } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DataProvider, useData } from "../../src/context/data"
import { SDKProvider } from "../../src/context/sdk"
import { createTuiApiAdapters } from "../../src/plugin/adapters"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, json } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_question_adapter"

const hydrated: QuestionV2Request = {
  id: "que_adapter_hydrated",
  sessionID,
  questions: [
    {
      question: "Pick a deployment target",
      header: "Target",
      options: [{ label: "Local", description: "Run locally" }],
    },
  ],
}

async function waitForState(predicate: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for adapter question state")
    await Bun.sleep(10)
  }
}

function questionEvent(properties: Record<string, unknown>): GlobalEvent {
  return {
    directory: "/tmp/question-adapter",
    payload: { id: "evt_question.v2.asked", type: "question.v2.asked", properties },
  } as GlobalEvent
}

// only `state.session.question` is exercised here; unrelated capabilities are never touched by this test.
function createAdapterApi() {
  return createTuiApiAdapters({
    version: "test",
    tuiConfig: {},
    dialog: {},
    keymap: {},
    kv: {},
    route: {},
    routes: {},
    event: {},
    sdk: {},
    sync: {},
    theme: {},
    toast: {},
    renderer: {},
    attention: {},
    Slot: () => null,
  } as unknown as Parameters<typeof createTuiApiAdapters>[0])
}

test("plugin state question accessor reads the session question store", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const listPath = `/api/session/${sessionID}/question`
  const callsApi = createFetch((url) => {
    if (url.pathname !== listPath) return
    return json({ data: [hydrated] })
  }, events)

  let api: ReturnType<typeof createTuiApiAdapters> | undefined
  let hydratedOnce = false

  function Probe() {
    api = createAdapterApi()
    const data = useData()
    onMount(async () => {
      await data.session.question.refresh(sessionID)
      hydratedOnce = true
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <SDKProvider url="http://test" directory={tmp.path} events={events.source} fetch={callsApi.fetch}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </SDKProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )

  try {
    await app.waitFor(() => hydratedOnce)
    expect(api!.state.session.question(sessionID)).toEqual([hydrated])
    // a session that has never asked a question resolves to an empty list, not undefined
    expect(api!.state.session.question("ses_question_adapter_none")).toEqual([])

    const asked: QuestionV2Request = {
      id: "que_adapter_asked",
      sessionID,
      questions: [{ question: "Continue?", header: "Confirm", options: [] }],
    }
    events.emit(questionEvent(asked as unknown as Record<string, unknown>))
    await waitForState(() => api!.state.session.question(sessionID).some((request) => request.id === asked.id))
    expect(api!.state.session.question(sessionID)).toEqual([hydrated, asked])
  } finally {
    app.renderer.destroy()
  }
})
