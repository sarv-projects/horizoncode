import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("goal.review fetches a pending proposal and posts only its revision-bound decision", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: unknown }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-reviews") {
      requests.push({ url: url.toString() })
      return json({
        goals: [
          {
            goalID: "goal-managed",
            goalRevision: "9007199254740993",
            projectRef: "proj_test",
            workspaceRef: "workspace-main",
            proposals: [
              {
                goalId: "goal-managed",
                goalRevision: "9007199254740993",
                specVersionId: "spec-v2",
                parentVersionId: "spec-v1",
                proposedBy: "server_auth.author",
                reviewAvailability: { available: true },
                specDigest: `blake3:${"a".repeat(64)}`,
                objective: "Finish the managed task",
                projectRef: "proj_test",
                workspaceRef: "workspace-main",
                capabilityScope: ["files.read"],
                scope: ["kernel/src/**"],
                constraints: ["Preserve user-owned changes"],
                criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
                budget: {
                  maxTasks: 4,
                  maxAttemptsPerTask: 2,
                  maxRunDurationMs: 60_000,
                  maxWorkers: 1,
                  maxMemoryBytes: "4096",
                  maxDiskBytes: "8192",
                  maxTokens: "4096",
                  maxCostMicros: "0",
                },
                sourceDigests: [`sha256:${"b".repeat(64)}`],
              },
            ],
          },
        ],
        nextAfterGoalID: null,
      })
    }
    if (url.pathname === "/experimental/control-plane/goal-review/decision") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({
        goalID: "goal-managed",
        specID: "spec-v2",
        specDigest: `blake3:${"a".repeat(64)}`,
        decision: "ACCEPTED",
        decidedBy: "server_auth.reviewer",
        decidedAtMs: 1,
        reviewedRevision: "9007199254740993",
        revision: "9007199254740994",
      })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch

  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.review").ok).toBe(true)
    await Bun.sleep(100)
    expect(requests.some((item) => new URL(item.url).pathname.endsWith("/goal-reviews"))).toBe(true)
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    await setup.renderOnce()
    setup.mockInput.pressKey("ARROW_DOWN")
    setup.mockInput.pressKey("ARROW_DOWN")
    setup.mockInput.pressKey("ARROW_DOWN")
    setup.mockInput.pressEnter()
    const decisionDeadline = Date.now() + 3000
    while (!requests.some((item) => item.url.endsWith("/goal-review/decision")) && Date.now() < decisionDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }

    expect(requests).toHaveLength(2)
    expect(new URL(requests[0].url).searchParams.get("limit")).toBe("64")
    expect(requests[1].body).toEqual({
      decision: "accept",
      goalID: "goal-managed",
      specID: "spec-v2",
      specDigest: `blake3:${"a".repeat(64)}`,
      expectedRevision: "9007199254740993",
    })
    expect(requests[1].body).not.toHaveProperty("principal")
    // A successful decision closes the review dialog, and the app command
    // catalog must stay intact afterwards (no crash/error-boundary swap).
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Review proposed SpecVersion")
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("goal.propose submits a bounded versioned draft in the current workspace", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: unknown }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-proposals") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({ goalID: "goal-new", specID: "spec-new", specDigest: `blake3:${"a".repeat(64)}`, accepted: false })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch

  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) { api = input.api; started() },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.propose").ok).toBe(true)
    await setup.renderOnce()
    await setup.mockInput.typeText(JSON.stringify({
      schemaVersion: 1,
      objective: "Finish a managed task",
      capabilityScope: ["files.patch", "files.read"],
      scope: ["kernel/src/**"],
      constraints: ["Preserve user work"],
      criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
      budget: {
        maxTasks: 2,
        maxAttemptsPerTask: 1,
        maxRunDurationMs: 30_000,
        maxWorkers: 1,
        maxTokens: 1000,
        maxCostMicros: 0,
      },
      sourceDigests: [],
    }))
    setup.mockInput.pressEnter()
    const deadline = Date.now() + 3000
    while (requests.length === 0 && Date.now() < deadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/experimental/control-plane/goal-proposals")
    expect(requests[0].body).toEqual({
      schemaVersion: 1,
      objective: "Finish a managed task",
      capabilityScope: ["files.patch", "files.read"],
      scope: ["kernel/src/**"],
      constraints: ["Preserve user work"],
      criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
      budget: {
        maxTasks: 2,
        maxAttemptsPerTask: 1,
        maxRunDurationMs: 30_000,
        maxWorkers: 1,
        maxTokens: 1000,
        maxCostMicros: 0,
      },
      sourceDigests: [],
    })
    expect(requests[0].body).not.toHaveProperty("projectRef")
    expect(requests[0].body).not.toHaveProperty("principal")
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("goal.verify requests verification through authenticated API without caller identity or evidence", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-verification") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({
        schemaVersion: 1,
        status: "UNKNOWN",
        goalID: "goal-managed",
        runID: "run-current",
        verificationRunID: "verify-1",
        revision: "workspace-revision-17",
      })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) { api = input.api; started() },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.verify").ok).toBe(true)
    await setup.renderOnce()
    await setup.mockInput.typeText("goal-managed run-current")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    const deadline = Date.now() + 3000
    while (requests.length === 0 && Date.now() < deadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/experimental/control-plane/goal-verification")
    expect(requests[0].body).toEqual({ schemaVersion: 1, goalID: "goal-managed", runID: "run-current" })
    for (const forbidden of ["principal", "reviewer", "verdict", "evidence", "artifact", "credential"]) {
      expect(requests[0].body).not.toHaveProperty(forbidden)
    }
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("goal.plan preserves decimal revisions and reports that the plan has no execution authority", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-run-plan") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({
        schemaVersion: 1,
        status: "PLAN_ONLY",
        executionAvailable: false,
        goalID: "goal-managed",
        runID: "run-plan",
        specID: "spec-accepted",
        revision: "9007199254740994",
        runPhase: "PLAN_ONLY",
        taskIDs: ["task-one"],
        tasksReady: false,
        reason: "Guarded admission is unavailable",
      })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: { async start(input) { api = input.api; started() }, async dispose() {} },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.plan").ok).toBe(true)
    await setup.renderOnce()
    await setup.mockInput.typeText(JSON.stringify({
      schemaVersion: 1,
      goalID: "goal-managed",
      specID: "spec-accepted",
      specDigest: `blake3:${"a".repeat(64)}`,
      expectedGoalRevision: "9007199254740993",
      runID: "run-plan",
      tasks: [{
        taskID: "task-one",
        dependencies: [],
        criterionIDs: ["tests-pass"],
        requiredCapabilities: ["files.read"],
        profileSelection: { profileId: "default", revision: "9007199254740993" },
      }],
    }))
    setup.mockInput.pressEnter()
    const deadline = Date.now() + 3000
    while (requests.length === 0 && Date.now() < deadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body?.expectedGoalRevision).toBe("9007199254740993")
    expect((requests[0]?.body?.tasks as Array<{ profileSelection: { revision: string } }>)[0]?.profileSelection.revision).toBe("9007199254740993")
    expect(requests[0]?.body).not.toHaveProperty("principal")
    expect(requests[0]?.body).not.toHaveProperty("attemptID")
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("goal.control confirms against the observed Goal revision and submits a fenced action", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-review") {
      requests.push({ url: url.toString() })
      return json({
        goalID: "goal-managed",
        goalRevision: "9007199254740993",
        projectRef: "proj_test",
        workspaceRef: "workspace-main",
        proposals: [],
        acceptedSpecs: [],
        runs: [{ runID: "run-current", specID: "spec-current", runPhase: "PAUSED" }],
      })
    }
    if (url.pathname === "/experimental/control-plane/goal-run-control") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({
        schemaVersion: 1,
        goalID: "goal-managed",
        runID: "run-current",
        status: "RUNNING",
        runPhase: "RUNNING",
        revision: "9007199254740994",
      })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) { api = input.api; started() },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.control").ok).toBe(true)
    await setup.renderOnce()
    await setup.mockInput.typeText("goal-managed run-current pause")
    setup.mockInput.pressEnter()
    const readDeadline = Date.now() + 3000
    while (requests.length === 0 && Date.now() < readDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests).toHaveLength(1)
    expect(setup.captureCharFrame()).toContain("Goal revision 9007199254740993")
    setup.mockInput.pressEnter()
    const writeDeadline = Date.now() + 3000
    while (requests.length < 2 && Date.now() < writeDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests[1].body).toEqual({
      schemaVersion: 1,
      action: "pause",
      goalID: "goal-managed",
      runID: "run-current",
      expectedRevision: "9007199254740993",
    })
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })

test("goal.start derives accepted SpecVersion and revision from the trusted Goal snapshot", async () => {
  const setup = await createTestRenderer({ width: 120, height: 60, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const fallback = createFetch()
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/experimental/control-plane/goal-review") {
      requests.push({ url: url.toString() })
      return json({
        goalID: "goal-managed",
        goalRevision: "9007199254740993",
        projectRef: "proj_test",
        workspaceRef: "workspace-main",
        proposals: [],
        acceptedSpecs: [{ specID: "spec-accepted", specDigest: `blake3:${"a".repeat(64)}` }],
        runs: [{ runID: "run-planned", specID: "spec-accepted", runPhase: "PLAN_ONLY" }],
      })
    }
    if (url.pathname === "/experimental/control-plane/goal-run-start") {
      requests.push({ url: url.toString(), body: await request.clone().json() })
      return json({
        schemaVersion: 1,
        goalID: "goal-managed",
        runID: "run-planned",
        specID: "spec-accepted",
        runPhase: "RUNNING",
        revision: "9007199254740994",
      })
    }
    return fallback.fetch(request)
  }) as typeof globalThis.fetch
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch,
        events: events.source,
        args: {},
        pluginHost: { async start(input) { api = input.api; started() }, async dispose() {} },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    expect(api?.keymap.dispatchCommand("goal.start").ok).toBe(true)
    await setup.renderOnce()
    await setup.mockInput.typeText(JSON.stringify({
      schemaVersion: 1,
      goalID: "goal-managed",
      runID: "run-planned",
      idempotencyKey: "start-run-1",
    }))
    setup.mockInput.pressEnter()
    const readDeadline = Date.now() + 3000
    while (requests.length === 0 && Date.now() < readDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests).toHaveLength(1)
    expect(setup.captureCharFrame()).toContain("spec-accepted")
    expect(setup.captureCharFrame()).toContain("9007199254740993")
    setup.mockInput.pressEnter()
    const writeDeadline = Date.now() + 3000
    while (requests.length < 2 && Date.now() < writeDeadline) {
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    expect(requests[1]?.body).toEqual({
      schemaVersion: 1,
      goalID: "goal-managed",
      runID: "run-planned",
      expectedGoalRevision: "9007199254740993",
      specID: "spec-accepted",
      specDigest: `blake3:${"a".repeat(64)}`,
      idempotencyKey: "start-run-1",
    })
    const exit = api?.keymap.dispatchCommand("app.exit")
    expect(exit?.ok).toBe(true)
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, { timeout: 30_000 })
