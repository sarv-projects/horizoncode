import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { confirmWorkspaceFileChanges } from "../../src/component/dialog-workspace-create"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { DialogProvider, useDialog, type DialogContext } from "../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createFetch, eventSource, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for workspace file-change dialog")
    await Bun.sleep(10)
  }
}

test("confirmed workspace file changes opt into the Guarded copy path", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const calls = createFetch((url) => {
    if (url.pathname !== "/vcs/status") return
    return json([{ file: "tracked.txt", status: "modified", additions: 1, deletions: 0 }])
  })
  let result: boolean | undefined
  let dialog: DialogContext | undefined

  function Probe() {
    const currentDialog = useDialog()
    dialog = currentDialog
    const sdk = useSDK()
    onMount(() => {
      void confirmWorkspaceFileChanges({
        dialog: currentDialog,
        sdk,
        sourceWorkspaceID: "source-workspace",
      }).then((value) => (result = value))
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={calls.fetch}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Probe />
                  </DialogProvider>
                </ToastProvider>
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
    { kittyKeyboard: true },
  )

  try {
    await waitFor(() => dialog?.stack.length === 1)
    app.mockInput.pressEnter()
    await waitFor(() => result !== undefined)
    expect(result).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
