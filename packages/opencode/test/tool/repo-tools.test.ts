import { afterEach, describe, expect } from "bun:test"
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
import { DefinitionsFindTool, ReferencesFindTool, RepoDetectTool, RepoSearchParameters, RepoTreeTool, SymbolsSearchTool } from "../../src/tool/repo-tools"
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
const structureDocumentText = "export function entry(): void {}\n"
const structureDocumentDigest = RepoIntelligenceSchema.repoDocumentContentDigest(structureDocumentText)
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
      fileDigest: Schema.decodeUnknownSync(Digest)(structureDocumentDigest),
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
    readRepoDocument: (input) => Effect.succeed({
      schemaVersion: 1 as const,
      status: "OK" as const,
      pathRef: input.request.pathRef,
      revisionKind: input.request.revisionKind,
      text: structureDocumentText,
      contentDigest: RepoIntelligenceSchema.repoDocumentContentDigest(structureDocumentText),
      observedWorkspaceRevision: input.request.expectedWorkspaceRevision,
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
        coverage: { files: 40, nodes: 100, bytes: 40_000 },
        nodes: Array.from({ length: 100 }, (_, index) => ({
          ...structurePage.nodes[0]!,
          nodeId: `node-${index}`,
          pathRef: `src/${index}.ts`,
          symbol: "x".repeat(900),
        })),
        fallback: { reason: "parse_partial", sourceKind: "parser" },
        nextCursor: "repo_cur_0123456789abcdef",
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

const discoveryGeneration = Schema.decodeUnknownSync(Digest)(`blake3:${"6".repeat(64)}`)
const discoveryRevision = Schema.decodeUnknownSync(Digest)(`blake3:${"7".repeat(64)}`)
const discoveryPage = Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoDiscoveryPageV1)({
  schemaVersion: 1,
  messageType: "discovery",
  requestId: "repo-discovery-test",
  status: "CURRENT",
  freshness: "current",
  completeness: "complete",
  authority: {
    principalBinding: discoveryGeneration,
    sessionID: "ses_test",
    locationID: "loc_test",
    ownerEpoch: "3",
    workspaceBinding: discoveryGeneration,
    sourceRevision: discoveryRevision,
    readPolicyDigest: discoveryGeneration,
    rootRef: ".",
    mode: "tree",
    maxEntries: 256,
    maxBytes: 262144,
    maxDepth: 8,
  },
  coverage: { entries: 2, bytes: 128, depth: 1 },
  entries: [
    { pathRef: "src", kind: "directory", depth: 1, sizeBytes: "0" },
    { pathRef: "src/link", kind: "symlink", depth: 1, sizeBytes: "12" },
  ],
})
const observedDiscoveryCalls: Array<{ mode: string; request: typeof RepoIntelligenceSchema.RepoDiscoveryRequestV1.Type }> = []
const observedManifestReads: string[] = []
const observedManifestRevisionKinds: string[] = []
const discoverySupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    discoverRepo: (input) => Effect.sync(() => {
      observedDiscoveryCalls.push({ mode: input.request.mode, request: input.request })
      const partial = input.request.mode === "manifests" && input.request.rootRef === "partial"
      return Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoDiscoveryPageV1)({
        ...discoveryPage,
        requestId: input.request.requestId,
        status: partial ? "PARTIAL" : "CURRENT",
        completeness: partial ? "partial" : "complete",
        ...(partial ? { partialReason: "entry_limit" as const } : {}),
        authority: { ...discoveryPage.authority, rootRef: input.request.rootRef, mode: input.request.mode,
          maxEntries: input.request.maxEntries, maxBytes: input.request.maxBytes, maxDepth: input.request.maxDepth },
        entries: input.request.mode === "tree" ? discoveryPage.entries : [
          {
            pathRef: input.request.rootRef === "redact" ? "redact/api_key=fixture-secret/package.json" : "package.json",
            kind: "file",
            depth: input.request.rootRef === "redact" ? 2 : 1,
            sizeBytes: "512",
            manifestKind: "package_json",
            languageHint: "javascript",
          },
        ],
        coverage: {
          entries: input.request.mode === "tree" ? discoveryPage.entries.length : 1,
          bytes: 128,
          depth: input.request.rootRef === "redact" ? 2 : 1,
        },
      })
    }),
    readRepoDocument: (input) => Effect.sync(() => {
      observedManifestReads.push(input.request.pathRef)
      observedManifestRevisionKinds.push(input.request.revisionKind)
      return { schemaVersion: 1 as const, status: "OK" as const, pathRef: input.request.pathRef,
        revisionKind: input.request.revisionKind,
        text: '{"packageManager":"bun@1.3.14","dependencies":{"react":"^19"},"scripts":{"test":"bun test","build":"bun run build"}}', contentDigest: discoveryGeneration,
        observedWorkspaceRevision: input.request.expectedWorkspaceRevision }
    }),
  }),
  deps: [],
})
const itDiscovery = testEffect(LayerNode.compile(LayerNode.group([
  FSUtil.node, RepoIntel.node, CrossSpawnSpawner.node, Truncate.node, Agent.node, Git.node,
  discoverySupervisorNode, trustedPrincipalNode,
])))

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
  it("rejects over-limit or unsafe search inputs before any HostKernel dispatch", () => {
    const decode = Schema.decodeUnknownSync(RepoSearchParameters)
    expect(() => decode({ query: "é".repeat(513) })).toThrow()
    expect(() => decode({ query: "needle\nsecond-line" })).toThrow()
    expect(() => decode({ query: "needle", path: "../outside" })).toThrow()
    expect(() => decode({ query: "needle", path: "x".repeat(4_097) })).toThrow()
    expect(decode({ query: "needle", path: "src/nested" }).path).toBe("src/nested")
  })

  itRegistry.instance("keeps RepoIntel tools hidden without the experimental flag", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("repo_tree")
      expect(ids).not.toContain("repo_detect")
      expect(ids).not.toContain("symbols_search")
      expect(ids).not.toContain("references_find")
      expect(ids).not.toContain("definitions_find")
    }),
  )

  itRepoTools.instance("keeps RepoIntel tools hidden until integrated acceptance is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("repo_tree")
      expect(ids).not.toContain("repo_detect")
      expect(ids).not.toContain("symbols_search")
      expect(ids).not.toContain("references_find")
      expect(ids).not.toContain("definitions_find")
    }),
  )

  itRepoStructure.instance("returns source-pinned lexical declaration candidates without claiming parser certainty", () =>
    Effect.gen(function* () {
      const info = yield* DefinitionsFindTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "entry" }, ctx)
      expect(result.metadata.status).toBe("PARTIAL")
      expect(result.output).toContain("resultKind: lexical declaration candidates")
      expect(result.output).toContain("src/a.ts:1 function entry")
      expect(result.output).not.toContain("parser-confirmed")
    }),
  )

  itTool.instance("repo_tree and repo_detect fail closed when HostKernel discovery is unavailable", () =>
    Effect.gen(function* () {
      const treeInfo = yield* RepoTreeTool
      const tree = yield* treeInfo.init()
      const treeResult = yield* tree.execute({ path: "src", depth: 2 }, ctx)
      expect(treeResult.metadata.status).toBe("UNAVAILABLE")
      expect(treeResult.output).toContain("UNAVAILABLE")

      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const detectResult = yield* detect.execute({ path: "src" }, ctx)
      expect(detectResult.metadata.status).toBe("UNAVAILABLE")
      expect(detectResult.output).toContain("UNAVAILABLE")
    }),
  )

  itDiscovery.instance("uses bounded HostKernel discovery and exact-revision manifest reads", () =>
    Effect.gen(function* () {
      observedDiscoveryCalls.length = 0
      observedManifestReads.length = 0
      observedManifestRevisionKinds.length = 0
      const treeInfo = yield* RepoTreeTool
      const tree = yield* treeInfo.init()
      const treeResult = yield* tree.execute({ path: ".", depth: 8, maxEntries: 256 }, ctx)
      expect(treeResult.metadata.status).toBe("CURRENT")
      expect(treeResult.output).toContain("src/link [symlink]")
      expect(observedDiscoveryCalls[0]?.mode).toBe("tree")

      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const detectResult = yield* detect.execute({ path: "." }, ctx)
      expect(detectResult.metadata.status).toBe("CURRENT")
      expect(detectResult.output).toContain("framework: react")
      expect(detectResult.output).toContain("package manager: bun")
      expect(detectResult.output).toContain("test script: declared")
      expect(detectResult.output).toContain("build script: declared")
      expect(observedManifestReads).toEqual(["package.json"])
      expect(observedManifestRevisionKinds).toEqual(["discovery_observation"])
      expect(observedDiscoveryCalls[1]?.mode).toBe("manifests")
    }),
  )

  itDiscovery.instance("redacts credential-shaped path labels in manifest detection output", () =>
    Effect.gen(function* () {
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "redact" }, ctx)
      expect(result.output).toContain("[REDACTED]/package.json")
      expect(result.output).not.toContain("fixture-secret")
      expect(observedManifestReads.at(-1)).toBe("redact/api_key=fixture-secret/package.json")
    }),
  )

  itDiscovery.instance("uses current candidates from a partial manifest page without claiming complete detection", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      observedManifestRevisionKinds.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "partial" }, ctx)
      expect(result.metadata.status).toBe("PARTIAL")
      expect(result.output).toContain("coveragePartialReason: entry_limit")
      expect(result.output).toContain("framework: react")
      expect(observedManifestRevisionKinds).toEqual(["discovery_observation"])
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
      expect(result.output).toContain("source: parser; coverage: 40 files, 100 nodes, 40000 bytes")
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
