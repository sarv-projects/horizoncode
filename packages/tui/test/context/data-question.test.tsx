import type { GlobalEvent, QuestionRequest, QuestionV2Request } from "@horizoncode/sdk/v2"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DataProvider, useData } from "../../src/context/data"
import { SDKProvider } from "../../src/context/sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, json } from "../fixture/tui-sdk"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_question_flow"

const hydrated: QuestionV2Request = {
  id: "que_hydrated",
  sessionID,
  questions: [
    {
      question: "Choose a build mode",
      header: "Build",
      options: [{ label: "Fast", description: "Use the fast build" }],
    },
  ],
}

async function waitForState(predicate: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for question state")
    await Bun.sleep(10)
  }
}

function questionEvent(
  type:
    | "question.v2.asked"
    | "question.v2.replied"
    | "question.v2.rejected"
    | "question.asked"
    | "question.replied"
    | "question.rejected",
  properties: Record<string, unknown>,
): GlobalEvent {
  return {
    directory: "/tmp/question-flow",
    payload: { id: `evt_${type}`, type, properties },
  } as GlobalEvent
}

test("legacy questions hydrate and project callbacks through their separate lane", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const legacy: QuestionRequest = {
    id: "que_legacy_hydrated",
    sessionID,
    questions: [{ question: "Choose a route", header: "Route", options: [{ label: "Local", description: "" }] }],
  }
  const callsApi = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/question`) return json({ data: [] })
    if (url.pathname === "/question") return json([legacy])
  }, events)

  let data: ReturnType<typeof useData> | undefined
  let hydratedOnce = false
  function Probe() {
    data = useData()
    onMount(async () => {
      await data!.session.question.refresh(sessionID)
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
    expect(data!.session.question.list(sessionID)).toEqual([legacy])
    expect(data!.session.question.prompts(sessionID)).toEqual([{ lane: "legacy", request: legacy }])

    const asked: QuestionRequest = {
      ...legacy,
      id: "que_legacy_event",
      questions: [{ question: "Continue?", header: "Continue", options: [] }],
    }
    events.emit(questionEvent("question.asked", asked as unknown as Record<string, unknown>))
    await waitForState(() => data!.session.question.prompts(sessionID).some((item) => item.request.id === asked.id))
    events.emit(questionEvent("question.replied", { sessionID, requestID: asked.id, answers: [[]] }))
    await waitForState(() => !data!.session.question.prompts(sessionID).some((item) => item.request.id === asked.id))
    expect(data!.session.question.list(sessionID)).toEqual([legacy])
  } finally {
    app.renderer.destroy()
  }
})

test("V2 session question hydration and asked/replied/rejected events update the session list", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const listPath = `/api/session/${sessionID}/question`
  const calls: string[] = []
  const callsApi = createFetch((url) => {
    if (url.pathname !== listPath) return
    calls.push(url.pathname)
    return json({ data: [hydrated] })
  }, events)

  let data: ReturnType<typeof useData> | undefined
  let hydratedOnce = false

  function Probe() {
    data = useData()
    onMount(async () => {
      await data!.session.question.refresh(sessionID)
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
    expect(calls).toEqual([listPath])
    expect(data!.session.question.list(sessionID)).toEqual([hydrated])

    const asked: QuestionV2Request = {
      id: "que_asked",
      sessionID,
      questions: [{ question: "Pick a test", header: "Test", options: [] }],
    }
    events.emit(questionEvent("question.v2.asked", asked as unknown as Record<string, unknown>))
    await waitForState(() => data!.session.question.list(sessionID)?.some((request) => request.id === asked.id) === true)
    expect(data!.session.question.list(sessionID)).toEqual([hydrated, asked])

    events.emit(
      questionEvent("question.v2.replied", {
        sessionID,
        requestID: hydrated.id,
        answers: [["Fast"]],
      }),
    )
    await waitForState(() => {
      const requests = data!.session.question.list(sessionID)
      return requests?.length === 1 && requests[0]?.id === asked.id
    })
    expect(data!.session.question.list(sessionID)).toEqual([asked])

    events.emit(
      questionEvent("question.v2.rejected", {
        sessionID,
        requestID: asked.id,
      }),
    )
    await waitForState(() => data!.session.question.list(sessionID)?.length === 0)
    expect(data!.session.question.list(sessionID)).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("a V2 asked event initializes the session question list before hydration", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const askedSessionID = "ses_question_before_hydration"
  const listPath = `/api/session/${askedSessionID}/question`
  let listRequested = false
  let resolveList!: (response: Response) => void
  let refresh: Promise<void> | undefined
  const callsApi = createFetch((url) => {
    if (url.pathname !== listPath) return
    listRequested = true
    return new Promise<Response>((resolve) => {
      resolveList = resolve
    })
  }, events)

  let data: ReturnType<typeof useData> | undefined

  function Probe() {
    data = useData()
    onMount(() => {
      refresh = data!.session.question.refresh(askedSessionID)
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
    await app.waitFor(() => listRequested)
    const asked: QuestionV2Request = {
      id: "que_before_hydration",
      sessionID: askedSessionID,
      questions: [{ question: "Choose a runner", header: "Runner", options: [] }],
    }

    events.emit(questionEvent("question.v2.asked", asked as unknown as Record<string, unknown>))
    await waitForState(() => data!.session.question.list(askedSessionID)?.some((request) => request.id === asked.id) === true)
    expect(data!.session.question.list(askedSessionID)).toEqual([asked])

    resolveList(json({ data: [] }))
    await refresh
    expect(data!.session.question.list(askedSessionID)).toEqual([asked])
  } finally {
    if (resolveList) resolveList(json({ data: [] }))
    await refresh?.catch(() => {})
    app.renderer.destroy()
  }
})
