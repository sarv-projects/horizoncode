import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect } from "effect"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { ManagedAttemptScopeV1 } from "@/session/managed-control"

const it = testEffect(LayerNode.compile(LSP.node))
const digest = (digit: string) => `blake3:${digit.repeat(64)}`

function managedScope(): ManagedAttemptScopeV1 {
  return {
    goalID: "goal_1",
    runID: "run_1",
    taskID: "task_1",
    attemptID: "attempt_1",
    ownerEpoch: "7",
    expectedManagedRevision: "1",
    requestSequence: "1",
    requestID: "request_1",
    contextSelectionDigest: digest("9"),
    locationID: "location-1",
    sessionID: "session-managed",
    workspaceRevision: digest("1"),
    effectiveMaxTokens: "100000",
    remainingTokens: "100000",
    delegationBindingDigest: digest("c"),
    permissionScopeDigest: digest("a"),
    worktreeTarget: {
      worktreeID: "worktree_1",
      worktreeBaseRevision: digest("5"),
      worktreePoolRevision: "3",
      locationID: "location-1",
      workspaceID: "wrk_managed",
      workspaceRef: "worktree_1",
      canonicalRoot: "/workspace/managed",
      workspaceRevision: digest("1"),
    },
  }
}

describe("LSP service lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
  })

  afterEach(() => {
    spawnSpy.mockRestore()
  })

  it.instance("snapshots nested managed worktree authority before running the prompt", () =>
    Effect.gen(function* () {
      const lsp = yield* LSP.Service
      const attempt = managedScope()
      const locationRef = {
        directory: "/workspace/managed",
        workspaceID: "wrk_managed" as never,
      } as never
      const inspect = Effect.gen(function* () {
        const scope = yield* LSP.ExecutionScope
        ;(attempt.worktreeTarget as { canonicalRoot: string }).canonicalRoot = "/attacker/changed"
        expect(scope.managedAttempt?.worktreeTarget.canonicalRoot).toBe("/workspace/managed")
        expect(Object.isFrozen(scope.managedAttempt?.worktreeTarget)).toBe(true)
      })
      yield* lsp.withExecutionScope(
        {
          sessionID: "session-managed",
          locationID: "location-1",
          locationRef,
          workspaceRevision: digest("1"),
          workspaceID: "wrk_managed",
          managedAttempt: attempt,
          getClients: async () => [],
          getExistingClients: async () => [],
          dispose: async () => {},
        },
        inspect,
      )
    }),
  )

  it.instance("init() completes without error", () => LSP.Service.use((lsp) => lsp.init()))

  it.instance("status() returns empty array initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.status()
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(0)
      }),
    ),
  )

  it.instance("diagnostics() returns empty object initially", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.diagnostics()
        expect(typeof result).toBe("object")
        expect(Object.keys(result).length).toBe(0)
      }),
    ),
  )

  it.instance("hasClients() returns false for .ts files in instance when LSP is unset", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
        expect(result).toBe(false)
      }),
    ),
  )

  it.instance(
    "hasClients() returns false for .ts files when LSP is configured but unsupervised",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          expect(result).toBe(false)
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "hasClients() returns false for configured LSPs until they are supervised",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "test.ts"))
          expect(result).toBe(false)
        }),
      ),
    { config: { lsp: { eslint: { disabled: true } } } },
  )

  it.instance("hasClients() returns false for files outside instance", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.hasClients(path.join((yield* TestInstance).directory, "..", "outside.ts"))
        expect(typeof result).toBe("boolean")
      }),
    ),
  )

  it.instance("workspaceSymbol() returns empty array with no clients", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.workspaceSymbol("test")
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(0)
      }),
    ),
  )

  it.instance("definition() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.definition({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("references() returns empty array for unknown file", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const result = yield* lsp.references({
          file: path.join((yield* TestInstance).directory, "nonexistent.ts"),
          line: 0,
          character: 0,
        })
        expect(Array.isArray(result)).toBe(true)
      }),
    ),
  )

  it.instance("multiple init() calls are idempotent", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        yield* lsp.init()
        yield* lsp.init()
        yield* lsp.init()
      }),
    ),
  )
})

describe("LSP.Diagnostic", () => {
  test("pretty() formats error diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
      message: "Type 'string' is not assignable to type 'number'",
      severity: 1,
    } as any)
    expect(result).toBe("ERROR [10:5] Type 'string' is not assignable to type 'number'")
  })

  test("pretty() formats warning diagnostic", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "Unused variable",
      severity: 2,
    } as any)
    expect(result).toBe("WARN [1:1] Unused variable")
  })

  test("pretty() defaults to ERROR when no severity", () => {
    const result = LSP.Diagnostic.pretty({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Something wrong",
    } as any)
    expect(result).toBe("ERROR [1:1] Something wrong")
  })
})
