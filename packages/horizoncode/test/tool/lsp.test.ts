import { PermissionV1 } from "@horizoncode/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { FSUtil } from "@horizoncode/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const workspaceSymbolQueries: string[] = []
let hasClientsCalls = 0

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    withExecutionScope: (scope, effect) =>
      Effect.provideService(effect, LSP.ExecutionScope, scope).pipe(
        Effect.ensuring(Effect.promise(() => scope.dispose())),
      ),
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.sync(() => {
      hasClientsCalls++
      return true
    }),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    postPatchDiagnostics: () => Effect.succeed({ files: [], omittedFiles: 0, omittedErrors: 0 }),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return []
      }),
    codeAction: () => Effect.succeed([]),
    rename: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const lspRoot = LayerNode.group([
  Agent.node,
  FSUtil.node,
  CrossSpawnSpawner.node,
  Truncate.node,
  LSP.node,
  RuntimeFlags.node,
])
const lspLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(lspRoot, [
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

// Default surface: read-only navigation only.
const it = testEffect(lspLayer())
// Same tool with the existing edit-proposal gate enabled.
const itWithEditProposals = testEffect(lspLayer({ experimentalLspTool: true }))

const init = Effect.fn("LspToolTest.init")(function* () {
  const info = yield* LspTool
  return yield* info.init()
})

const run = Effect.fn("LspToolTest.run")(function* (
  args: Tool.InferParameters<typeof LspTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const put = Effect.fn("LspToolTest.put")(function* (file: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, "export const x = 1\n")
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.lsp", () => {
  it.instance("hides edit-proposal operations from the default surface before any LSP call", () =>
    Effect.gen(function* () {
      hasClientsCalls = 0
      const dir = (yield* TestInstance).directory
      const file = path.join(dir, "test.ts")

      const rename = yield* Effect.exit(
        run({ operation: "rename", filePath: file, line: 1, character: 1, newName: "next" }),
      )
      const codeAction = yield* Effect.exit(run({ operation: "codeAction", filePath: file, line: 1, character: 1 }))

      // The default parameter schema does not admit either operation, so the
      // LSP service is never consulted: rename/codeAction stay behind
      // OPENCODE_EXPERIMENTAL_LSP_TOOL.
      expect(rename._tag).toBe("Failure")
      expect(codeAction._tag).toBe("Failure")
      expect(hasClientsCalls).toBe(0)
    }),
  )

  it.instance(
    "keeps read-only navigation available without the experimental gate",
    () =>
      Effect.gen(function* () {
        hasClientsCalls = 0
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* put(file)

        const result = yield* run({ operation: "hover", filePath: file, line: 3, character: 7 })
        expect(result.title).toEndWith("test.ts:3:7")
        expect(hasClientsCalls).toBe(1)
      }),
    { git: true },
  )

  itWithEditProposals.instance("rejects a rename without a name before consulting LSP", () =>
    Effect.gen(function* () {
      hasClientsCalls = 0
      const dir = (yield* TestInstance).directory
      const exit = yield* Effect.exit(run({ operation: "rename", filePath: path.join(dir, "test.ts"), line: 1, character: 1 }))

      expect(exit._tag).toBe("Failure")
      expect(hasClientsCalls).toBe(0)
    }),
  )

  itWithEditProposals.instance(
    "dispatches rename only when the edit-proposal gate is enabled",
    () =>
      Effect.gen(function* () {
        hasClientsCalls = 0
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* put(file)

        const result = yield* run({ operation: "rename", filePath: file, line: 3, character: 7, newName: "renamed" })
        // The result stays an untrusted proposal; the tool never applies it.
        expect(result.metadata.proposalOnly).toBe(true)
        expect(hasClientsCalls).toBe(1)
      }),
    { git: true },
  )

  describe("HostKernel protocol authorization", () => {
    it.instance(
      "keeps cursor details for position-based operations",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 }, next)
          expect(items).toEqual([])
          expect(result.title).toEndWith("test.ts:3:7")
        }),
      { git: true },
    )

    it.instance(
      "omits cursor details for documentSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "documentSymbol", filePath: file, line: 3, character: 7 }, next)
          expect(items).toEqual([])
          expect(result.title).toEndWith("test.ts")
        }),
      { git: true },
    )

    it.instance(
      "omits file and cursor details for workspaceSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)
          expect(items).toEqual([])
          expect(result.title).toBe("workspaceSymbol")
        }),
      { git: true },
    )

    it.instance(
      "passes workspaceSymbol query to LSP",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7, query: "TestSymbol" }, next)
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)

          // Legacy PermissionV1 prompts are not an authorization source for
          // LSP; protocol dispatch is admitted by the active SessionSupervisor.
          expect(items).toEqual([])
          expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
        }),
      { git: true },
    )
  })
})
