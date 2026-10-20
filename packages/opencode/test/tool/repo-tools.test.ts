import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Location as LocationSchema } from "@opencode-ai/schema"
import * as RepoIntelligenceSchema from "@opencode-ai/schema/repo-intelligence-v1"
import { Digest } from "@opencode-ai/schema/composition-v1"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { ReferencesFindTool, RepoTreeTool, SymbolsSearchTool } from "../../src/tool/repo-tools"
import { RepoIntel } from "../../src/tool/repo-intel"
import { Git } from "@/git"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import type { Context as ToolContext } from "../../src/tool/tool"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

const registryRoot = LayerNode.group([ToolRegistry.node, Agent.node])
const registryLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(registryRoot, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const toolLayer = LayerNode.compile(
  LayerNode.group([FSUtil.node, RepoIntel.node, CrossSpawnSpawner.node, Truncate.node, Agent.node, Git.node]),
)

const itRegistry = testEffect(registryLayer())
const itRepoTools = testEffect(registryLayer({ experimentalRepoTools: true }))
const itTool = testEffect(toolLayer)

const observedStructureCalls: Array<{
  sessionID: string
  locationRef: typeof LocationSchema.Ref.Type
  query: Omit<typeof RepoIntelligenceSchema.RepoStructureQueryV1.Type, "sourceGeneration">
}> = []
const structureGeneration = Schema.decodeUnknownSync(Digest)(`blake3:${"3".repeat(64)}`)
const structureRevision = Schema.decodeUnknownSync(Digest)(`blake3:${"4".repeat(64)}`)
const structurePage = Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructurePageV1)({
  schemaVersion: 1,
  messageType: "page",
  queryId: "placeholder",
  workspaceBinding: "workspace-test",
  sourceGeneration: structureGeneration,
  sourceRevision: structureRevision,
  sourceKind: "parser",
  status: "CURRENT",
  freshness: "current",
  completeness: "complete",
  coverage: { files: 1, nodes: 1, bytes: 128 },
  nodes: [
    {
      workspaceBinding: "workspace-test",
      sourceGeneration: structureGeneration,
      sourceRevision: structureRevision,
      pathRef: "src/a.ts",
      fileDigest: Schema.decodeUnknownSync(Digest)(`blake3:${"5".repeat(64)}`),
      nodeId: "node-a",
      nodeKind: "function",
      symbol: "entry",
      byteRange: { start: 0, end: 18 },
      parserId: "typescript",
      parserVersion: "5.9.0",
    },
  ],
})
const repoStructureSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: (input) =>
      Effect.sync(() => {
        observedStructureCalls.push(input)
        return { ...structurePage, queryId: input.query.queryId }
      }),
  }),
  deps: [],
})
const largeStructureSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: (input) =>
      Effect.succeed({
        ...structurePage,
        queryId: input.query.queryId,
        status: "PARTIAL",
        freshness: "current",
        completeness: "partial",
        coverage: { files: 40, nodes: 40, bytes: 40_000 },
        nodes: Array.from({ length: 40 }, (_, index) => ({
          ...structurePage.nodes[0]!,
          nodeId: `node-${index}`,
          pathRef: `src/${index}.ts`,
          symbol: "x".repeat(900),
        })),
        fallback: { reason: "parse_partial", sourceKind: "parser" },
        nextCursor: "c".repeat(2_400),
      }),
  }),
  deps: [],
})
const trustedPrincipalNode = LayerNode.make({
  service: TrustedPrincipalContext,
  layer: Layer.succeed(
    TrustedPrincipalContext,
    TrustedPrincipalContext.of({ principal: { kind: "server_auth", subject: "test-user" } }),
  ),
  deps: [],
})
const itRepoStructure = testEffect(
  LayerNode.compile(
    LayerNode.group([
      FSUtil.node,
      RepoIntel.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Git.node,
      repoStructureSupervisorNode,
      trustedPrincipalNode,
    ]),
  ),
)
const itLargeStructure = testEffect(
  LayerNode.compile(
    LayerNode.group([
      FSUtil.node,
      RepoIntel.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Git.node,
      largeStructureSupervisorNode,
      trustedPrincipalNode,
    ]),
  ),
)

const unavailableSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  }),
  deps: [],
})
const itUnavailableSupervisor = testEffect(
  LayerNode.compile(LayerNode.group([FSUtil.node, RepoIntel.node, CrossSpawnSpawner.node, Truncate.node, Agent.node, Git.node, unavailableSupervisorNode, trustedPrincipalNode])),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies ToolContext

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.repo-tools", () => {
  itRegistry.instance("keeps RepoIntel tools hidden without the experimental flag", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("repo_tree")
      expect(ids).not.toContain("symbols_search")
      expect(ids).not.toContain("references_find")
    }),
  )

  itRepoTools.instance("exposes RepoIntel tools behind the experimental flag", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("repo_tree")
      expect(ids).toContain("symbols_search")
      expect(ids).toContain("references_find")
    }),
  )

  itTool.instance("repo_tree lists a bounded structure and skips ignored directories", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "src/index.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, ".git/config"), "[core]\n"))
      const info = yield* RepoTreeTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ path: test.directory, depth: 2 }, ctx)
      expect(result.output).toContain("src/")
      expect(result.output).toContain("index.ts")
      expect(result.output).not.toContain(".git")
    }),
  )

  itTool.instance("repo_tree skips symlink entries instead of traversing outside the selected root", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-outside`)
      yield* Effect.promise(async () => {
        await fs.mkdir(outside, { recursive: true })
        await fs.writeFile(path.join(outside, "secret.txt"), "outside")
        await fs.symlink(outside, path.join(test.directory, "escape"), "dir")
      })
      const info = yield* RepoTreeTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ path: test.directory, depth: 4 }, ctx)
      expect(result.output).not.toContain("escape")
      expect(result.output).not.toContain("secret.txt")
      yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
    }),
  )

  itTool.instance("repo_tree stops before reading an external directory when approval is denied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-outside`)
      yield* Effect.promise(async () => {
        await fs.mkdir(outside, { recursive: true })
        await fs.writeFile(path.join(outside, "secret.txt"), "outside")
      })
      const permissions: string[] = []
      let reads = 0
      const fsutil = yield* FSUtil.Service
      const info = yield* RepoTreeTool
      const tool = yield* info.init()
      const deniedContext: ToolContext = {
        ...ctx,
        ask: (input) => {
          permissions.push(input.permission)
          return input.permission === "external_directory"
            ? Effect.fail(new Error("denied")).pipe(Effect.orDie)
            : Effect.void
        },
      }
      const result = yield* Effect.exit(
        tool.execute({ path: outside, depth: 2 }, deniedContext).pipe(
          Effect.provideService(
            FSUtil.Service,
            FSUtil.Service.of({
              ...fsutil,
              readDirectoryEntries: (directory) => {
                reads++
                return fsutil.readDirectoryEntries(directory)
              },
            }),
          ),
        ),
      )
      expect(permissions).toEqual(["glob", "external_directory"])
      expect(reads).toBe(0)
      expect(result._tag).toBe("Failure")
      yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
    }),
  )

  itUnavailableSupervisor.instance("symbols_search fails closed when HostKernel RepoIntel is not negotiated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      const info = yield* SymbolsSearchTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "a" }, ctx)
      expect(result.output.toLowerCase()).toContain("unavailable")
    }),
  )

  itRepoStructure.instance("routes symbol search through the same-session authenticated Core RepoIntel API", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      observedStructureCalls.length = 0
      const info = yield* SymbolsSearchTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "entry", path: "src", maxResults: 8 }, ctx)

      expect(observedStructureCalls).toHaveLength(1)
      expect(observedStructureCalls[0]?.sessionID).toBe(ctx.sessionID)
      expect(String(observedStructureCalls[0]?.locationRef.directory)).toBe(test.directory)
      expect(observedStructureCalls[0]?.query.rootRef).toBe("src")
      expect(observedStructureCalls[0]?.query.selector.symbols).toEqual(["entry"])
      expect(observedStructureCalls[0]?.query).not.toHaveProperty("sourceGeneration")
      expect(result.output).toContain("src/a.ts")
      expect(result.output).toContain("symbol: entry")
    }),
  )

  itLargeStructure.instance("bounds aggregate structural rendering while preserving page provenance and continuation", () =>
    Effect.gen(function* () {
      const info = yield* SymbolsSearchTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "entry", maxResults: 100 }, ctx)
      expect(new TextEncoder().encode(result.output).byteLength).toBeLessThanOrEqual(32 * 1024)
      expect(result.output).toContain("source: parser; coverage: 40 files, 40 nodes, 40000 bytes")
      expect(result.output).toContain("nextCursor:")
      expect(result.output).toContain("[output truncated at 32 KiB")
    }),
  )

  itTool.instance("references_find fails closed without a RepoIntel backend", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      const info = yield* ReferencesFindTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "a" }, ctx)
      expect(result.output.toLowerCase()).toContain("unavailable")
    }),
  )

  itTool.instance("references_find remains unavailable until authenticated structural references are implemented", () =>
    Effect.gen(function* () {
      const info = yield* ReferencesFindTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "needle" }, ctx)
      expect(result.output).toContain("UNAVAILABLE")
    }),
  )
})
