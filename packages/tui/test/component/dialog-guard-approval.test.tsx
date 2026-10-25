/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { DialogGuardApproval, type GuardApprovalRequestView } from "../../src/component/dialog-guard-approval"
import type { GuardApprovalDecision } from "../../src/context/sync"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for Guard approval dialog")
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: { renderOnce: () => Promise<unknown>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
) {
  const start = Date.now()
  let last = ""
  while (true) {
    await app.renderOnce()
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    last = frame
    if (predicate(frame)) return frame
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for Guard approval frame: ${last}`)
    await Bun.sleep(10)
  }
}

const request: GuardApprovalRequestView = {
  approvalID: "approval-1",
  challengeID: "challenge-1",
  effectID: "effect-1",
  capabilityID: "builtin.verifier",
  locationID: "loc_0123456789abcdef",
  sessionID: "session-1",
  inputDigest: `blake3:${"a".repeat(64)}`,
  normalizedTargets: [{ criterionID: "tests-pass", resource: "kernel/tests/**" }],
  expiresAtUnixMs: 1_900_000_000_000,
  policySummary: "Run one host-registered verifier criterion in the current workspace.",
  origin: "managed_run",
  runID: "run-1",
  source: "host.managed_verifier",
  policyID: "broker-process.local.v1",
  policyDigest: `blake3:${"b".repeat(64)}`,
  normalizedAction: "builtin.verifier",
  argumentSummary: { status: "unavailable", reason: "not included in this Guard request" },
  requestedGuarantees: ["process.confined", "workspace.read_only"],
  guaranteeAssessment: { status: "not_assessed", residual: null },
  allowEnabled: false,
  noResponse: "deny_and_expire",
}

async function mountApproval(
  directory: string,
  state: string,
  onDecision: (decision: GuardApprovalDecision) => Promise<boolean>,
  approvalRequest: GuardApprovalRequestView = request,
) {
  let dialog: { stack: unknown[]; replace: (element: unknown, onClose?: () => void) => void } | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
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
      </OpencodeKeymapProvider>
    )
  }

  function Probe() {
    const current = useDialog()
    dialog = current
    onMount(() => {
      let replied = false
      const reply = async (decision: GuardApprovalDecision) => {
        replied = true
        await onDecision(decision)
      }
      current.replace(
        () => <DialogGuardApproval request={approvalRequest} onDecision={reply} />,
        () => {
          if (!replied) void reply("deny")
        },
      )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: directory, state, worktree: directory }}>
        <Harness />
      </TestTuiContexts>
    ),
    { kittyKeyboard: true, width: 120, height: 44 },
  )

  await waitFor(() => dialog?.stack.length === 1)
  return { app, dialog, dispose: () => app.renderer.destroy() }
}

test("Guard approval shows host-minted context and states expiry and missing context", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const decisions: string[] = []
  const { app, dialog, dispose } = await mountApproval(tmp.path, state, async (decision) => {
    decisions.push(decision)
    return true
  })
  try {
    const frame = await waitForFrame(app, (value) => value.includes("page 1 of"))
    expect(frame).toContain("builtin.verifier")
    expect(frame).toContain("effect-1")
    expect(frame).toContain("Location")
    expect(frame).toContain("session-1")
    expect(frame).toContain("run-1")
    expect(frame).toContain("Next details page")
    expect(frame).toContain("Deny (default)")
    expect(frame.replace(/\s+/g, "")).toContain("Allow:unavailable")

    // Allow is absent from DialogSelect's enabled option list. Home selects
    // the inert details row; End selects the only enabled decision, Deny.
    app.mockInput.pressKey("HOME")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    expect(decisions).toEqual([])
    expect(dialog?.stack).toHaveLength(1)

    app.mockInput.pressKey("END")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await waitFor(() => decisions.length === 1)
    await waitFor(() => dialog?.stack.length === 0)
    expect(decisions).toEqual(["deny"])
    app.mockInput.pressEnter()
    await waitFor(() => decisions.length === 1)
    await waitFor(() => dialog?.stack.length === 0)
    expect(decisions).toEqual(["deny"])
    expect(decisions).not.toContain("allow_once")
  } finally {
    dispose()
  }
})

test("Guard approval defaults to deny and sends only the decision", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const decisions: string[] = []
  const { app, dialog, dispose } = await mountApproval(tmp.path, state, async (decision) => {
    decisions.push(decision)
    return true
  })
  try {
    await waitForFrame(app, (value) => value.includes("Deny (default)"))
    app.mockInput.pressEnter()
    await waitFor(() => decisions.length === 1)
    await waitFor(() => dialog?.stack.length === 0)
    expect(decisions).toEqual(["deny"])
    expect(dialog?.stack).toHaveLength(0)
  } finally {
    dispose()
  }
})

test("Guard approval allow choice is explicitly one-use", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const decisions: string[] = []
  const allowedRequest: GuardApprovalRequestView = {
    ...request,
    argumentSummary: { status: "available", text: "Run the fixed repository test command." },
    guaranteeAssessment: { status: "assessed", residual: [] },
    allowEnabled: true,
  }
  const { app, dialog, dispose } = await mountApproval(tmp.path, state, async (decision) => {
    decisions.push(decision)
    return true
  }, allowedRequest)
  try {
    const allowFrame = await waitForFrame(app, (value) => value.includes("Allow this effect once"))
    expect(allowFrame).toContain("Allow: available once")
    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Allow this effect once"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[row].indexOf("Allow this effect once"), row)
    await waitFor(() => decisions.length === 1)
    await waitFor(() => dialog?.stack.length === 0)
    expect(decisions).toEqual(["allow_once"])
    expect(dialog?.stack).toHaveLength(0)
  } finally {
    dispose()
  }
})

test("managed provider inference allows only the exact host-issued consent policy", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const decisions: string[] = []
  const providerRequest: GuardApprovalRequestView = {
    ...request,
    capabilityID: "providers.infer",
    origin: "managed_run",
    source: "host.managed_provider",
    runID: "run-1",
    policyID: "provider-inference.managed.v1",
    normalizedAction: "providers.infer",
    argumentSummary: { status: "available", text: "Infer with the selected provider route and model; request details are hidden." },
    requestedGuarantees: ["live_managed_attempt", "selected_route_revision", "normalized_request_digest", "transport_request_digest", "secret_operation_digest", "explicit_route_consent", "budget_bound", "one_use", "no_fallback"],
    guaranteeAssessment: { status: "assessed", residual: [] },
    allowEnabled: true,
  }
  const { app, dispose } = await mountApproval(tmp.path, state, async (decision) => {
    decisions.push(decision)
    return true
  }, providerRequest)
  try {
    const firstPage = await waitForFrame(app, (value) => value.includes("Allow this effect once"))
    expect(firstPage).toContain("Review request details · page 1 of")
    expect(firstPage).not.toContain("provider-inference.managed.v1")

    // The policy detail follows the resource/consent summary on later pages.
    // Exercise the rendered pagination instead of assuming every detail fits
    // on page one; the approval option remains available throughout review.
    let frame = firstPage
    let reviewedDetails = firstPage.replace(/\s+/g, "")
    while (Number(frame.match(/page (\d+) of (\d+)/)?.[1] ?? 0) <
      Number(frame.match(/page (\d+) of (\d+)/)?.[2] ?? 0)) {
      const lines = app.captureCharFrame().split("\n")
      const nextRow = lines.findIndex((line) => line.includes("Next details page"))
      expect(nextRow).toBeGreaterThanOrEqual(0)
      const nextColumn = lines[nextRow].indexOf("Next details page")
      expect(nextColumn).toBeGreaterThanOrEqual(0)
      await app.mockMouse.click(nextColumn, nextRow)
      const currentPage = Number(frame.match(/page (\d+) of/)?.[1] ?? 0)
      frame = await waitForFrame(app, (value) => value.includes(`page ${currentPage + 1} of`))
      reviewedDetails += frame.replace(/\s+/g, "")
    }
    // Detail lines are fixed-width and pagination is line-based, so the
    // policy identifier's continuation may land on the following page.
    expect(reviewedDetails).toContain("Policy:provider-inferen")
    expect(reviewedDetails).toContain("ce.managed.v1")

    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Allow this effect once"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[row].indexOf("Allow this effect once"), row)
    await waitFor(() => decisions.length === 1)
    expect(decisions).toEqual(["allow_once"])
  } finally {
    dispose()
  }
})

test("managed provider inference denies incomplete consent guarantees", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const decisions: string[] = []
  const providerRequest: GuardApprovalRequestView = {
    ...request,
    capabilityID: "providers.infer",
    origin: "managed_run",
    source: "host.managed_provider",
    runID: "run-1",
    policyID: "provider-inference.managed.v1",
    normalizedAction: "providers.infer",
    argumentSummary: { status: "available", text: "Selected provider route." },
    requestedGuarantees: ["live_managed_attempt", "one_use"],
    guaranteeAssessment: { status: "assessed", residual: [] },
    allowEnabled: true,
  }
  const { app, dispose } = await mountApproval(tmp.path, state, async (decision) => {
    decisions.push(decision)
    return true
  }, providerRequest)
  try {
    const frame = await waitForFrame(app, (value) => value.includes("Deny (default)"))
    // The fixed-width details renderer can wrap a word across visual rows;
    // compare the logical label without whitespace introduced by the frame.
    expect(frame.replace(/\s+/g, "")).toContain("consentcontextincomplete")
    app.mockInput.pressEnter()
    await waitFor(() => decisions.length === 1)
    expect(decisions).toEqual(["deny"])
  } finally {
    dispose()
  }
})
