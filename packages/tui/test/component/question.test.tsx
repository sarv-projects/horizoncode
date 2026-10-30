/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { QuestionV2Request } from "@horizoncode/sdk/v2"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource } from "../fixture/tui-sdk"
import { QuestionPrompt } from "../../src/routes/session/question"
import type { SessionQuestionRequest } from "../../src/context/data"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_question_prompt"

type Call = { method: string; pathname: string; body: string }

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for question request")
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  timeout = 2000,
) {
  const start = Date.now()
  let lastFrame = ""
  while (true) {
    await app.renderOnce()
    lastFrame = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(lastFrame)) return lastFrame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for question prompt frame; last frame: ${lastFrame}`)
    await Bun.sleep(10)
  }
}

async function renderQuestion(request: QuestionV2Request | SessionQuestionRequest, respond?: (call: Call) => Response) {
  const calls: Call[] = []
  const fallback = createFetch()
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.includes("/question/")) {
      const call = { method: request.method, pathname: url.pathname, body: await request.text() }
      calls.push(call)
      return respond?.(call) ?? new Response(null, { status: 204 })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch

  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetch}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <QuestionPrompt request={request} />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 100, height: 35 },
  )
  return {
    app,
    calls,
    dispose: async () => {
      await Bun.sleep(25)
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("legacy question callbacks use the legacy reply and reject routes", async () => {
  const reply = await renderQuestion({
    lane: "legacy",
    request: {
      id: "que_legacy_reply",
      sessionID,
      questions: [{ question: "Which route?", header: "Route", options: [{ label: "Local", description: "Local" }] }],
    },
  })
  try {
    await waitForFrame(reply.app, (frame) => frame.includes("Local"))
    reply.app.mockInput.pressEnter()
    await waitFor(() => reply.calls.length === 1)
    expect(reply.calls).toEqual([{
      method: "POST",
      pathname: "/question/que_legacy_reply/reply",
      body: JSON.stringify({ answers: [["Local"]] }),
    }])
  } finally {
    reply.app.renderer.destroy()
    await reply.dispose()
  }

  const reject = await renderQuestion({
    lane: "legacy",
    request: {
      id: "que_legacy_reject",
      sessionID,
      questions: [{ question: "Continue?", header: "Continue", options: [] }],
    },
  })
  try {
    await waitForFrame(reject.app, (frame) => frame.includes("Continue?"))
    reject.app.mockInput.pressEscape()
    await waitFor(() => reject.calls.length === 1)
    expect(reject.calls).toEqual([{
      method: "POST",
      pathname: "/question/que_legacy_reject/reject",
      body: "",
    }])
  } finally {
    reject.app.renderer.destroy()
    await reject.dispose()
  }
})

test("single choice replies to the V2 session/request route with one answer", async () => {
  const { app, calls, dispose } = await renderQuestion({
    id: "que_single_choice",
    sessionID,
    questions: [
      {
        question: "Which build?",
        header: "Build",
        options: [{ label: "Fast", description: "Fast build" }],
      },
    ],
  })

  try {
    await waitForFrame(app, (frame) => frame.includes("Fast"))
    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: `/api/session/${sessionID}/question/que_single_choice/reply`,
        body: JSON.stringify({ answers: [["Fast"]] }),
      },
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("multiple choices and custom text are submitted together over V2", async () => {
  const { app, calls, dispose } = await renderQuestion({
    id: "que_multiple_custom",
    sessionID,
    questions: [
      {
        question: "Which checks?",
        header: "Checks",
        multiple: true,
        options: [
          { label: "Unit", description: "Unit tests" },
          { label: "Lint", description: "Lint checks" },
        ],
      },
    ],
  })

  try {
    await waitForFrame(app, (frame) => frame.includes("Unit"))
    app.mockInput.pressEnter()
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await Bun.sleep(20)
    await app.mockInput.typeText("Typecheck")
    await waitForFrame(app, (frame) => frame.includes("Typecheck"))
    app.mockInput.pressEnter()
    app.mockInput.pressTab()
    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: `/api/session/${sessionID}/question/que_multiple_custom/reply`,
        body: JSON.stringify({ answers: [["Unit", "Lint", "Typecheck"]] }),
      },
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("two questions answer sequentially, review on the confirm tab, and submit exact answers", async () => {
  const { app, calls, dispose } = await renderQuestion({
    id: "que_multi_flow",
    sessionID,
    questions: [
      {
        question: "Which OS?",
        header: "OS",
        options: [
          { label: "Linux", description: "Linux runner" },
          { label: "macOS", description: "macOS runner" },
        ],
      },
      {
        question: "Which checks?",
        header: "Checks",
        multiple: true,
        options: [
          { label: "Unit", description: "Unit tests" },
          { label: "Lint", description: "Lint checks" },
        ],
      },
    ],
  })

  try {
    await waitForFrame(app, (frame) => frame.includes("Which OS?"))
    app.mockInput.pressEnter() // Linux → advance to the checks tab
    const secondFrame = await waitForFrame(app, (frame) => frame.includes("Which checks?"))
    expect(secondFrame).toContain("select all that apply")

    app.mockInput.pressEnter() // toggle Unit
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter() // toggle Lint
    app.mockInput.pressTab() // → confirm tab

    const reviewFrame = await waitForFrame(app, (frame) => frame.includes("Review"))
    expect(reviewFrame).toContain("OS: Linux")
    expect(reviewFrame).toContain("Checks: Unit, Lint")

    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: `/api/session/${sessionID}/question/que_multi_flow/reply`,
        body: JSON.stringify({ answers: [["Linux"], ["Unit", "Lint"]] }),
      },
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("a multi-question flow marks unanswered questions on review and dismisses from the confirm tab", async () => {
  const { app, calls, dispose } = await renderQuestion({
    id: "que_multi_dismiss",
    sessionID,
    questions: [
      {
        question: "Which OS?",
        header: "OS",
        options: [{ label: "Linux", description: "Linux runner" }],
      },
      {
        question: "Which checks?",
        header: "Checks",
        multiple: true,
        options: [{ label: "Unit", description: "Unit tests" }],
      },
    ],
  })

  try {
    await waitForFrame(app, (frame) => frame.includes("Which OS?"))
    app.mockInput.pressEnter() // answer only the first question
    await waitForFrame(app, (frame) => frame.includes("Which checks?"))
    app.mockInput.pressTab() // → confirm tab

    const reviewFrame = await waitForFrame(app, (frame) => frame.includes("(not answered)"))
    expect(reviewFrame).toContain("OS: Linux")
    expect(reviewFrame).toContain("Checks: (not answered)")

    app.mockInput.pressEscape()
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: `/api/session/${sessionID}/question/que_multi_dismiss/reject`,
        body: "",
      },
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("escape dismisses a question through its V2 session/request route", async () => {
  const { app, calls, dispose } = await renderQuestion({
    id: "que_dismiss",
    sessionID,
    questions: [{ question: "Continue?", header: "Continue", options: [] }],
  })

  try {
    await waitForFrame(app, (frame) => frame.includes("Continue?"))
    app.mockInput.pressEscape()
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: `/api/session/${sessionID}/question/que_dismiss/reject`,
        body: "",
      },
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("a failed answer stays retryable and does not expose the server error body", async () => {
  let responseCount = 0
  const { app, calls, dispose } = await renderQuestion(
    {
      id: "que_retry_answer",
      sessionID,
      questions: [
        {
          question: "Which build?",
          header: "Build",
          options: [{ label: "Fast", description: "Fast build" }],
        },
      ],
    },
    () =>
      ++responseCount === 1
        ? new Response(JSON.stringify({ message: "private server detail" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 204 }),
  )

  try {
    await waitForFrame(app, (frame) => frame.includes("Fast"))
    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 1)
    const failedFrame = await waitForFrame(app, (frame) => frame.includes("Could not confirm answer"))
    expect(failedFrame).not.toContain("private server detail")
    expect(failedFrame).toContain("Which build?")

    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 2)
    const retriedFrame = await waitForFrame(app, (frame) => frame.includes("Fast"))
    expect(retriedFrame).not.toContain("Could not confirm answer")
    expect(calls.map((call) => call.pathname)).toEqual([
      `/api/session/${sessionID}/question/que_retry_answer/reply`,
      `/api/session/${sessionID}/question/que_retry_answer/reply`,
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("a failed dismiss stays retryable without hiding the pending question", async () => {
  let responseCount = 0
  const { app, calls, dispose } = await renderQuestion(
    {
      id: "que_retry_dismiss",
      sessionID,
      questions: [{ question: "Continue?", header: "Continue", options: [] }],
    },
    () =>
      ++responseCount === 1
        ? new Response(JSON.stringify({ message: "private server detail" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 204 }),
  )

  try {
    await waitForFrame(app, (frame) => frame.includes("Continue?"))
    app.mockInput.pressEscape()
    await waitFor(() => calls.length === 1)
    const failedFrame = await waitForFrame(app, (frame) => frame.includes("Could not confirm dismiss"))
    expect(failedFrame).not.toContain("private server detail")
    expect(failedFrame).toContain("Continue?")

    app.mockInput.pressEscape()
    await waitFor(() => calls.length === 2)
    expect(calls.map((call) => call.pathname)).toEqual([
      `/api/session/${sessionID}/question/que_retry_dismiss/reject`,
      `/api/session/${sessionID}/question/que_retry_dismiss/reject`,
    ])
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})

test("a transport failure does not claim the answer was rejected or expose transport details", async () => {
  let responseCount = 0
  const { app, calls, dispose } = await renderQuestion(
    {
      id: "que_unknown_answer",
      sessionID,
      questions: [
        {
          question: "Which build?",
          header: "Build",
          options: [{ label: "Fast", description: "Fast build" }],
        },
      ],
    },
    () => {
      if (responseCount++ === 0) throw new Error("private transport detail")
      return new Response(null, { status: 204 })
    },
  )

  try {
    await waitForFrame(app, (frame) => frame.includes("Fast"))
    app.mockInput.pressEnter()
    await waitFor(() => calls.length === 1)
    const failedFrame = await waitForFrame(app, (frame) => frame.includes("Could not confirm answer"))
    expect(failedFrame).toContain("Which build?")
    expect(failedFrame).not.toContain("private transport detail")
  } finally {
    app.renderer.destroy()
    await dispose()
  }
})
