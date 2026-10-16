/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { QuestionV2Request } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource } from "../fixture/tui-sdk"
import { QuestionPrompt } from "../../src/routes/session/question"
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
  while (true) {
    await app.renderOnce()
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(frame)) return frame
    if (Date.now() - start > timeout) throw new Error("timed out waiting for question prompt frame")
    await Bun.sleep(10)
  }
}

async function renderQuestion(request: QuestionV2Request) {
  const calls: Call[] = []
  const fallback = createFetch()
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.includes("/question/")) {
      calls.push({ method: request.method, pathname: url.pathname, body: await request.text() })
      return new Response(null, { status: 204 })
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
