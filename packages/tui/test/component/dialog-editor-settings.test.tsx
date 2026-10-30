/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { HorizonCodingProfile } from "@horizoncode/core/config/coding-profile"
import type { CapabilityTier } from "@horizoncode/core/config/coding-profile"
import * as ExternalEditorProfile from "../../../schema/src/external-editor-profile-v1"
import { DialogEditorSettings } from "../../src/component/dialog-editor-settings"
import { DialogSessionSettings, projectCapabilityChipsViewV1 } from "../../src/routes/session/dialog-settings"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { eventSource, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

function ensureToSorted() {
  const candidate = (Array.prototype as { toSorted?: unknown }).toSorted
  if (typeof candidate === "function") return
  Object.defineProperty(Array.prototype, "toSorted", {
    value<T>(this: T[], compare?: (left: T, right: T) => number) {
      return [...this].sort(compare)
    },
  })
}


async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
) {
  const start = Date.now()
  let last = ""
  while (true) {
    await app.renderOnce()
    last = app.captureCharFrame().replace(/\s+/g, " ")
    if (predicate(last)) return last
    if (Date.now() > start + 2000) throw new Error(`timed out waiting for editor settings: ${last}`)
    await Bun.sleep(10)
  }
}

test("renders saved editor profiles and selection, and saves only an explicit user choice", async () => {
  ensureToSorted()
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const definition = {
    schemaVersion: 1 as const,
    profileId: "nvim",
    revision: "1",
    executableSelector: "horizoncode:editor:nvim",
    argv: [],
    targetArgIndex: 0,
    launchMode: "foreground_tty" as const,
    targetKinds: ["prompt_scratch", "workspace_file"] as const,
    environmentPolicy: "sanitized_host" as const,
  }
  const profileRef = ExternalEditorProfile.externalEditorProfileRefV1(definition)
  let projection: { schemaVersion: 1; revision: string; selected: unknown; profiles: unknown[] } = { schemaVersion: 1, revision: "1", selected: null, profiles: [{ definition, profileRef }] }
  const writes: unknown[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "GET") return json(projection)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "PATCH") {
      const body = await request.clone().json()
      writes.push(body)
      projection = { ...projection, revision: "2", selected: profileRef }
      return json(projection)
    }
    return json({})
  }
  let dialog: { stack: unknown[] } | undefined

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof fetch}>
          <TuiConfigProvider config={config}>
            <ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
              <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider>
                <DialogProvider><Probe /></DialogProvider><Toast />
              </ToastProvider></ThemeProvider></ExitProvider>
            </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() => current.replace(() => <DialogEditorSettings sessionID="session_test" />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>,
    { kittyKeyboard: true, width: 120, height: 40 },
  )
  try {
    const frame = await waitForFrame(app, (value) => value.includes("nvim · revision 1"))
    expect(frame).toContain("Selected: none")
    expect(frame).toContain("Saved immutable profiles")
    expect(frame).toContain("horizoncode:editor:nvim")
    expect(frame).toContain("does not launch or authorize a process")
    expect(writes).toEqual([])

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await waitForFrame(app, (value) => value.includes("Selected: nvim"))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      expectedSelection: null,
      select: profileRef,
    })
    expect(dialog?.stack.length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("Escape cancels editor settings without writing a profile selection", async () => {
  ensureToSorted()
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  let writes = 0
  const profile = {
    schemaVersion: 1 as const,
    profileId: "nvim",
    revision: "1",
    executableSelector: "horizoncode:editor:nvim",
    argv: [],
    targetArgIndex: 0,
    launchMode: "foreground_tty" as const,
    targetKinds: ["prompt_scratch", "workspace_file"] as const,
    environmentPolicy: "sanitized_host" as const,
  }
  const profileRef = ExternalEditorProfile.externalEditorProfileRefV1(profile)
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "PATCH") writes++
    if (url.pathname === "/config/external-editor-profiles")
      return json({ schemaVersion: 1, revision: "1", selected: null, profiles: [{ definition: profile, profileRef }] })
    return json({})
  }
  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return <OpencodeKeymapProvider keymap={keymap}><SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof fetch}>
      <TuiConfigProvider config={config}><ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
        <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider><DialogProvider><Probe /></DialogProvider><Toast /></ToastProvider></ThemeProvider></ExitProvider>
      </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider></TuiConfigProvider>
    </SDKProvider></OpencodeKeymapProvider>
  }
  function Probe() {
    const current = useDialog()
    onMount(() => current.replace(() => <DialogEditorSettings sessionID="session_test" />))
    return null
  }
  const app = await testRender(() => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>, { kittyKeyboard: true, width: 120, height: 40 })
  try {
    await waitForFrame(app, (value) => value.includes("nvim · revision 1"))
    app.mockInput.pressKey("ESC")
    await Bun.sleep(40)
    expect(writes).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("adds the next immutable built-in editor revision with the current selection CAS", async () => {
  ensureToSorted()
  const root = path.resolve(import.meta.dir, `../../../horizoncode/.agent-tmp/p4-editor-settings-add-${randomUUID()}`)
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const definition = (revision: string) => ({
    schemaVersion: 1 as const,
    profileId: "nvim",
    revision,
    executableSelector: "horizoncode:editor:nvim",
    argv: [],
    targetArgIndex: 0,
    launchMode: "foreground_tty" as const,
    targetKinds: ["prompt_scratch", "workspace_file"] as const,
    environmentPolicy: "sanitized_host" as const,
  })
  const history = ["2", "8"].map((revision) => {
    const value = definition(revision)
    return { definition: value, profileRef: ExternalEditorProfile.externalEditorProfileRefV1(value) }
  })
  let projection: { schemaVersion: 1; revision: string; selected: unknown; profiles: unknown[] } = { schemaVersion: 1, revision: "4", selected: null, profiles: history }
  const writes: unknown[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "GET") return json(projection)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "PATCH") {
      const body = await request.clone().json() as Record<string, unknown>
      writes.push(body)
      const added = body.addProfile as ReturnType<typeof definition>
      const profileRef = ExternalEditorProfile.externalEditorProfileRefV1(added)
      projection = {
        schemaVersion: 1,
        revision: "5",
        selected: profileRef,
        profiles: [...history, { definition: added, profileRef }],
      }
      return json(projection)
    }
    return json({})
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return <OpencodeKeymapProvider keymap={keymap}><SDKProvider url="http://test" directory={root} events={eventSource()} fetch={fetchImpl as typeof fetch}>
      <TuiConfigProvider config={config}><ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
        <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider><DialogProvider><Probe /></DialogProvider><Toast /></ToastProvider></ThemeProvider></ExitProvider>
      </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider></TuiConfigProvider>
    </SDKProvider></OpencodeKeymapProvider>
  }
  function Probe() {
    const current = useDialog()
    onMount(() => current.replace(() => <DialogEditorSettings sessionID="session_test" />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: root, state, worktree: root }}><Harness /></TestTuiContexts>,
    { kittyKeyboard: true, width: 120, height: 40 },
  )
  try {
    await waitForFrame(app, (frame) => frame.includes("Add nvim revision 9"))
    // The flattened options are No external editor, the two saved revisions,
    // then nano/vi/vim/nvim. Move from the initial selection to Add nvim.
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    const deadline = Date.now() + 2_000
    while (writes.length === 0 && Date.now() < deadline) {
      await app.renderOnce()
      await Bun.sleep(10)
    }

    expect(writes).toHaveLength(1)
    const body = writes[0] as { expectedSelection: unknown; addProfile: ReturnType<typeof definition>; select: unknown }
    expect(body.expectedSelection).toBeNull()
    expect(body.addProfile).toMatchObject({
      profileId: "nvim",
      revision: "9",
      executableSelector: "horizoncode:editor:nvim",
      argv: [],
      targetArgIndex: 0,
      launchMode: "foreground_tty",
    })
    expect(body.select).toEqual(ExternalEditorProfile.externalEditorProfileRefV1(body.addProfile))
    await waitForFrame(app, (frame) => frame.includes("Selected: nvim"))
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("does not launch or authorize a process")
  } finally {
    app.renderer.destroy()
  }
})

test("reloads global selection after an editor-profile CAS conflict without retrying the write", async () => {
  ensureToSorted()
  const root = path.resolve(import.meta.dir, `../../../horizoncode/.agent-tmp/p4-editor-settings-conflict-${randomUUID()}`)
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const definition = (revision: string) => ({
    schemaVersion: 1 as const,
    profileId: "nvim",
    revision,
    executableSelector: "horizoncode:editor:nvim",
    argv: [],
    targetArgIndex: 0,
    launchMode: "foreground_tty" as const,
    targetKinds: ["prompt_scratch", "workspace_file"] as const,
    environmentPolicy: "sanitized_host" as const,
  })
  const history = ["2", "8"].map((revision) => {
    const value = definition(revision)
    return { definition: value, profileRef: ExternalEditorProfile.externalEditorProfileRefV1(value) }
  })
  const concurrentSelection = history[0]!.profileRef
  let projection: { schemaVersion: 1; revision: string; selected: unknown; profiles: unknown[] } = { schemaVersion: 1, revision: "4", selected: null, profiles: history }
  let reads = 0
  const writes: unknown[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/config/external-editor-profiles" && request.method === "GET") {
      reads++
      return json(projection)
    }
    if (url.pathname === "/config/external-editor-profiles" && request.method === "PATCH") {
      writes.push(await request.clone().json())
      projection = { ...projection, revision: "5", selected: concurrentSelection }
      return json({ error: "selection changed" }, { status: 409 })
    }
    return json({})
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return <OpencodeKeymapProvider keymap={keymap}><SDKProvider url="http://test" directory={root} events={eventSource()} fetch={fetchImpl as typeof fetch}>
      <TuiConfigProvider config={config}><ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
        <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider><DialogProvider><Probe /></DialogProvider><Toast /></ToastProvider></ThemeProvider></ExitProvider>
      </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider></TuiConfigProvider>
    </SDKProvider></OpencodeKeymapProvider>
  }
  function Probe() {
    const current = useDialog()
    onMount(() => current.replace(() => <DialogEditorSettings sessionID="session_test" />))
    return null
  }

  const app = await testRender(
    () => <TestTuiContexts paths={{ home: root, state, worktree: root }}><Harness /></TestTuiContexts>,
    { kittyKeyboard: true, width: 120, height: 40 },
  )
  try {
    await waitForFrame(app, (frame) => frame.includes("Add nvim revision 9"))
    for (let index = 0; index < 6; index++) app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await waitForFrame(app, (frame) => frame.includes("revision 2") && frame.includes("changed elsewhere"))

    expect(reads).toBe(2)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      expectedSelection: null,
      addProfile: { profileId: "nvim", revision: "9" },
    })
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Selected: nvim")
  } finally {
    app.renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Settings → capability chips (Horizon Coding Profile exposure projection).
// Pure-projection coverage plus rendered `/settings` read-only behavior.
// ---------------------------------------------------------------------------

const CHIP_DESCRIPTORS: readonly {
  readonly id: string
  readonly implementationStatus: "designed" | "code_present" | "wired" | "tested" | "verified" | "released"
  readonly disabledReason?: string
}[] = [
  { id: "files.read", implementationStatus: "wired" },
  { id: "symbols.search", implementationStatus: "wired" },
  { id: "history.read_range", implementationStatus: "code_present" },
  { id: "repo.tree", implementationStatus: "designed" },
  { id: "codemode.execute", implementationStatus: "designed" },
  { id: "browser.navigate", implementationStatus: "wired" },
  { id: "debug.start", implementationStatus: "wired", disabledReason: "dap_route_unavailable" },
  { id: "mystery.tool", implementationStatus: "wired" },
]

function chipView(
  overrides: Partial<Parameters<typeof projectCapabilityChipsViewV1>[0]> = {},
): ReturnType<typeof projectCapabilityChipsViewV1> {
  return projectCapabilityChipsViewV1({
    source: "default",
    policyLock: "unlocked",
    precedence: "Coding profile default (no user/project tier setting)",
    ...overrides,
  })
}

test("capability chips view projects every stability class with lock/precedence and truthful availability", () => {
  const view = chipView({
    requestedTiers: ["core", "extended"],
    available: CHIP_DESCRIPTORS,
    skillCatalogSize: 7,
    source: "user",
    policyLock: "locked",
    precedence: "project policy overrides the Coding profile default",
  })

  // (b) release class is displayed per tier: stable / beta / experimental.
  expect(view.tiers.map((row) => ({ id: row.id, stability: row.stability }))).toEqual([
    { id: "tier.core", stability: "stable" },
    { id: "tier.extended", stability: "beta" },
    { id: "tier.experimental", stability: "experimental" },
  ])

  // experimental renders OFF unless explicitly opted in.
  const experimental = view.tiers[2]!
  expect(experimental.requested).toBe("off")
  expect(experimental.effective).toBe("off")
  expect(experimental.availability).toBe("unavailable")
  expect(experimental.reason).toContain("no experimental opt-in")

  // requested / effective / source / lock / precedence are all displayed.
  expect(view.headerLines.join("\n")).toContain("Requested: core, extended · Effective: core, extended")
  expect(view.headerLines.join("\n")).toContain("Source: user · Policy lock: locked")
  expect(view.headerLines.join("\n")).toContain("Precedence: project policy overrides the Coding profile default")

  // design-only / code-present / tier-off / disabled / unclassified rows are
  // visibly unavailable and never suggest they can be enabled from Settings.
  const unavailable = new Map(view.unavailableCapabilities.map((row) => [row.id, row]))
  expect(unavailable.get("capability.repo.tree")?.availability).toBe("unavailable")
  expect(unavailable.get("capability.repo.tree")?.reason).toContain("design-only")
  expect(unavailable.get("capability.history.read_range")?.availability).toBe("unavailable")
  expect(unavailable.get("capability.history.read_range")?.reason).toContain("cannot be enabled")
  expect(unavailable.get("capability.browser.navigate")?.availability).toBe("unavailable")
  expect(unavailable.get("capability.browser.navigate")?.reason).toContain("experimental opt-in")
  expect(unavailable.get("capability.debug.start")?.availability).toBe("unavailable")
  expect(unavailable.get("capability.debug.start")?.reason).toBe("dap_route_unavailable")
  expect(unavailable.get("capability.mystery.tool")?.reason).toContain("unclassified")
  for (const row of view.unavailableCapabilities) expect(row.availability).toBe("unavailable")

  // Aggregate counts come from projectCapabilityChips and exclude unwired work.
  expect(view.tools.availability).toBe("available")
  expect(view.tools.detail).toBe("effective 2 / catalog 8")
  expect(view.tools.reason).toBe("experimental_tier_off")
  expect(view.skills.detail).toBe("listed 7")
  expect(view.lines.join("\n")).toContain("Read-only projection")
  expect(view.lines.join("\n")).toContain("Tier core [stable] · requested ON · effective ON · available")
})

test("a code_present or design-only capability is never projected as working", () => {
  const view = chipView({
    available: [
      { id: "files.read", implementationStatus: "wired" },
      { id: "files.write", implementationStatus: "code_present" },
      { id: "files.patch", implementationStatus: "designed" },
    ],
    skillCatalogSize: 0,
  })
  expect(view.tools.detail).toBe("effective 1 / catalog 3")
  expect(view.unavailableCapabilities.map((row) => row.id)).toEqual([
    "capability.files.write",
    "capability.files.patch",
  ])
  for (const row of view.unavailableCapabilities) {
    expect(row.availability).toBe("unavailable")
    expect(row.reason).toContain("cannot be enabled")
  }
  // an explicitly opted-in experimental tier still cannot surface design-only work
  const optedIn = chipView({
    requestedTiers: ["core", "extended", "experimental"],
    available: [
      { id: "browser.navigate", implementationStatus: "designed" },
      { id: "files.read", implementationStatus: "wired" },
    ],
    skillCatalogSize: 1,
  })
  expect(optedIn.tiers[2]).toMatchObject({ requested: "on", effective: "on" })
  expect(optedIn.unavailableCapabilities.map((row) => row.id)).toEqual(["capability.browser.navigate"])
  expect(optedIn.unavailableCapabilities[0]?.availability).toBe("unavailable")
})

test("an absent capability or skill source renders unknown, never a fabricated zero", () => {
  const view = chipView()
  expect(view.descriptorSourcePresent).toBe(false)
  expect(view.skillCatalogPresent).toBe(false)
  expect(view.tools.availability).toBe("unknown")
  expect(view.skills.availability).toBe("unknown")
  const text = view.lines.join("\n")
  expect(text).toContain("effective unknown / catalog unknown")
  expect(text).toContain("listed unknown")
  expect(text).not.toContain("catalog 0")
  expect(text).not.toContain("listed 0")
  expect(view.tiers.map((row) => row.availability)).toEqual(["available", "available", "unavailable"])
  expect(view.unavailableCapabilities).toEqual([])
})

test("view tier and count projection stays identical to projectCapabilityChips", () => {
  const cases = [
    [],
    ["core"],
    ["core", "extended"],
    ["core", "extended", "experimental"],
  ] as readonly (readonly CapabilityTier[])[]
  for (const requestedTiers of cases) {
    const view = chipView({ requestedTiers, available: CHIP_DESCRIPTORS, skillCatalogSize: 3 })
    const chips = HorizonCodingProfile.projectCapabilityChips({
      requestedTiers,
      available: CHIP_DESCRIPTORS,
      skillCatalogSize: 3,
    })
    expect(view.chips).toEqual(chips)
    expect(view.effective).toEqual(chips.tiers)
    expect(view.tools.detail).toBe(`effective ${chips.tools.effective} / catalog ${chips.tools.catalog}`)
    expect(view.skills.detail).toBe(`listed ${chips.skills.listed}`)
  }
})

test("the chip view is a pure presentation projection with no mutation or authority surface", () => {
  const requestedTiers: readonly CapabilityTier[] = Object.freeze(["core", "extended"])
  const available = Object.freeze([Object.freeze({ id: "files.read", implementationStatus: "wired" as const })])
  const input = Object.freeze({
    requestedTiers,
    available,
    skillCatalogSize: 1,
    source: "default" as const,
    policyLock: "unlocked" as const,
    precedence: "Coding profile default (no user/project tier setting)",
  })
  const before = JSON.stringify(input)
  const view = projectCapabilityChipsViewV1(input)
  expect(JSON.stringify(input)).toBe(before)
  expect(Object.isFrozen(input)).toBe(true)
  expect(Object.isFrozen(input.available)).toBe(true)
  expect(Object.isFrozen(input.requestedTiers)).toBe(true)

  // No callable escape hatch: the view carries data only, so it cannot mutate
  // config, Guard state, provider/model selection or capability authority.
  const walk = (value: unknown, at: string) => {
    if (typeof value === "function") throw new Error(`capability chip view carries a callable at ${at}`)
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${at}.${key}`)
    }
  }
  walk(view, "view")
  expect(Object.keys(view).some((key) => /^(update|write|enable|grant|permission|authority|config)/i.test(key))).toBe(false)
  expect(typeof (view as { update?: unknown }).update).toBe("undefined")
})

test("Settings renders the capability chips read-only and interaction issues no write", async () => {
  ensureToSorted()
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const requests: { method: string; path: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    requests.push({ method: request.method, path: url.pathname })
    if (url.pathname === "/skill") return json([{ name: "fixture-skill", description: "fixture" }])
    if (url.pathname === "/config/external-editor-profiles")
      return json({ schemaVersion: 1, revision: "1", selected: null, profiles: [] })
    return json({})
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return <OpencodeKeymapProvider keymap={keymap}><SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof fetch}>
      <TuiConfigProvider config={config}><ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
        <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider><DialogProvider><Probe /></DialogProvider><Toast /></ToastProvider></ThemeProvider></ExitProvider>
      </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider></TuiConfigProvider>
    </SDKProvider></OpencodeKeymapProvider>
  }
  function Probe() {
    const current = useDialog()
    onMount(() => current.replace(() => <DialogSessionSettings sessionID="session_test" />))
    return null
  }

  const app = await testRender(() => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>, { kittyKeyboard: true, width: 120, height: 50 })
  try {
    const frame = await waitForFrame(app, (value) => value.includes("listed 1"))
    expect(frame).toContain("Capability exposure")
    expect(frame).toContain("Requested: core, extended · Effective: core, extended")
    expect(frame).toContain("Source: default · Policy lock: unlocked")
    expect(frame).toContain("Precedence: Coding profile default")
    expect(frame).toContain("Tier core [stable] · requested ON · effective ON · available")
    expect(frame).toContain("Tier extended [beta]")
    expect(frame).toContain("Tier experimental [experimental] · requested OFF · effective OFF")
    expect(frame).toContain("no experimental opt-in")
    expect(frame).toContain("effective unknown / catalog unknown")
    expect(frame).toContain("Skills · listed 1 · available")
    expect(frame).toContain("Read-only projection")

    // Moving focus and activating the dialog options must never write config
    // or capability state: the chips are not selectable entries at all.
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_UP")
    await Bun.sleep(20)
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([])

    app.mockInput.pressEnter()
    const editors = await waitForFrame(app, (value) => value.includes("Add profile") && value.includes("Selected: none"))
    expect(editors).toContain("Add nano revision 1")
    app.mockInput.pressKey("ESC")
    await Bun.sleep(40)
    expect(requests.filter((entry) => entry.method !== "GET")).toEqual([])

    // Chips are re-projected from frozen inputs; the hub only re-reads them.
    expect(requests.some((entry) => entry.method === "GET" && entry.path === "/skill")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed skill catalog load renders skills as unknown, never zero", async () => {
  ensureToSorted()
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname === "/skill") return json({ error: "unavailable" }, { status: 500 })
    return json({})
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return <OpencodeKeymapProvider keymap={keymap}><SDKProvider url="http://test" directory={tmp.path} events={eventSource()} fetch={fetchImpl as typeof fetch}>
      <TuiConfigProvider config={config}><ArgsProvider><KVProvider><PermissionProvider><ProjectProvider><RouteProvider>
        <ExitProvider exit={() => {}}><ThemeProvider mode="dark"><ToastProvider><DialogProvider><Probe /></DialogProvider><Toast /></ToastProvider></ThemeProvider></ExitProvider>
      </RouteProvider></ProjectProvider></PermissionProvider></KVProvider></ArgsProvider></TuiConfigProvider>
    </SDKProvider></OpencodeKeymapProvider>
  }
  function Probe() {
    const current = useDialog()
    onMount(() => current.replace(() => <DialogSessionSettings sessionID="session_test" />))
    return null
  }

  const app = await testRender(() => <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}><Harness /></TestTuiContexts>, { kittyKeyboard: true, width: 120, height: 50 })
  try {
    const frame = await waitForFrame(app, (value) => value.includes("Source: default · Policy lock: unlocked"))
    expect(frame).toContain("listed unknown")
    await Bun.sleep(300)
    const settled = app.captureCharFrame().replace(/\s+/g, " ")
    expect(settled).toContain("listed unknown")
    expect(settled).not.toContain("listed 0")
  } finally {
    app.renderer.destroy()
  }
})
