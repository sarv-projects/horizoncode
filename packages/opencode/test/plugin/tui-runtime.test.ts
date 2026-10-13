import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { dispose, init, list } from "@/plugin/tui/runtime"

const dirs: string[] = []

afterEach(async () => {
  await dispose()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("configured external TUI plugin modules remain unavailable without import side effects", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-tui-plugin-"))
  dirs.push(dir)
  const marker = path.join(dir, "executed")
  const plugin = path.join(dir, "plugin.mjs")
  await writeFile(
    plugin,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default { tui() { writeFileSync(${JSON.stringify(marker)}, "initialized") } }`,
  )

  let state: Record<string, unknown> = {}
  const runtime = {
    setupSlots: () => ({ register() {}, dispose() {} }),
    update: (next: Record<string, unknown>) => {
      state = { ...state, ...next }
    },
    clear() {
      state = {}
    },
  }
  const api = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "kv") return { get: () => ({}), set() {} }
        if (key === "state") return { path: { directory: dir, config: dir, worktree: dir } }
        if (key === "tuiConfig") return { keybinds: { gather: () => [] } }
        return new Proxy(() => undefined, { get: () => () => undefined })
      },
    },
  )

  await init({
    api: api as never,
    runtime: runtime as never,
    config: {
      plugin_origins: [{ spec: pathToFileURL(plugin).href, source: path.join(dir, "tui.json"), scope: "local" }],
    } as never,
  })

  expect(await readFile(marker).catch(() => undefined)).toBeUndefined()
  expect(list().find((item) => item.spec === pathToFileURL(plugin).href)).toEqual({
    id: pathToFileURL(plugin).href,
    source: "file",
    spec: pathToFileURL(plugin).href,
    target: pathToFileURL(plugin).href,
    enabled: false,
    active: false,
  })

  const commands = state.commands as {
    activate: (id: string) => Promise<boolean>
    add: (spec: string) => Promise<boolean>
    install: (spec: string) => Promise<{ ok: boolean; message?: string }>
  }
  expect(await commands.activate(pathToFileURL(plugin).href)).toBe(false)
  expect(await commands.add(pathToFileURL(plugin).href)).toBe(false)
  expect(await commands.install(pathToFileURL(plugin).href)).toEqual({
    ok: false,
    message: "External TUI plugins are unavailable.",
  })
  expect(list().find((item) => item.spec === pathToFileURL(plugin).href)).toMatchObject({
    enabled: false,
    active: false,
  })
})
