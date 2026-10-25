import { describe, expect, it } from "bun:test"
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
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { DefinitionsFindTool, ReferencesFindTool, RepoDetectTool, RepoSearchParameters, RepoTreeTool, SymbolsSearchTool } from "../../src/tool/repo-tools"
import { RepoIntel } from "../../src/tool/repo-intel"
import { Git } from "@/git"
import { TestInstance } from "../fixture/fixture"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import type { Context as ToolContext } from "../../src/tool/tool"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
  getRepoIntelProfile: () => Effect.succeed({
    requested: "lightweight",
    requestedValue: null,
    effective: "lightweight",
    configurationSource: "default",
    effectiveSource: "default",
    policyLock: "unlocked",
  }),
})

const unavailableSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
    discoverRepo: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
    readRepoDocument: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  }),
  deps: [],
})

// TaskTool.init requires SessionStatus.Service and WebSearchTool.init reads the
// instance context at layer-build time; in the full app graph both arrive from
// the root-group ordering/bootstrap scope, so this minimal test graph supplies
// them explicitly (SessionStatus before ToolRegistry; a build-scope InstanceRef).
// The build-scope context is captured by tool init effects but never used for
// filesystem access by these gate tests; keep the path repo-contained anyway.
const fixtureInstanceRef = Layer.succeed(InstanceRef, {
  directory: "/home/sarvesh/business_Dev/agentx/.p3-fixture",
  worktree: "/home/sarvesh/business_Dev/agentx/.p3-fixture",
  project: {
    id: ProjectV2.ID.make("proj_repo-tools-fixture"),
    worktree: "/home/sarvesh/business_Dev/agentx/.p3-fixture",
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})
const registryRoot = LayerNode.group([SessionStatus.node, Agent.node, ToolRegistry.node])
const registryLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(registryRoot, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ]).pipe(Layer.provide(fixtureInstanceRef))

const toolLayer = LayerNode.compile(
  LayerNode.group([
    Config.node,
    FSUtil.node,
    RepoIntel.node,
    CrossSpawnSpawner.node,
    Truncate.node,
    Agent.node,
    Git.node,
    unavailableSupervisorNode,
  ]),
  [[Config.node, configLayer]],
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
  coverage: { files: "2", nodes: "2", bytes: "256" },
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
    {
      workspaceBinding: "workspace-test",
      sourceGeneration: structureGeneration,
      sourceRevision: structureRevision,
      pathRef: "src/b.ts",
      fileDigest: Schema.decodeUnknownSync(Digest)(structureDocumentDigest),
      nodeId: "node-b",
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
      contentDigest: Schema.decodeUnknownSync(Digest)(RepoIntelligenceSchema.repoDocumentContentDigest(structureDocumentText)),
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
        coverage: { files: "40", nodes: "100", bytes: "40000" },
        nodes: Array.from({ length: 100 }, (_, index) => ({
          ...structurePage.nodes[0]!,
          nodeId: `node-${index}`,
          pathRef: `src/${index}.ts`,
          symbol: "x".repeat(900),
        })),
        fallback: { reason: "parse_partial", sourceKind: "parser" },
        nextCursor: Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructureCursorLeaseRefV1)("repo_cur_0123456789abcdef"),
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
      Config.node,
      FSUtil.node,
      RepoIntel.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Git.node,
      repoStructureSupervisorNode,
      trustedPrincipalNode,
    ]),
    [[Config.node, configLayer]],
  ),
)
const itLargeStructure = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      FSUtil.node,
      RepoIntel.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Git.node,
      largeStructureSupervisorNode,
      trustedPrincipalNode,
    ]),
    [[Config.node, configLayer]],
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
const discoveryRevisionDrift = Schema.decodeUnknownSync(Digest)(`blake3:${"8".repeat(64)}`)
const defaultManifestText =
  '{"packageManager":"bun@1.3.14","dependencies":{"react":"^19"},"scripts":{"test":"bun test","build":"bun run build"}}'
/** ~64 KiB of manifest bytes, inside the per-document bound but enough to exhaust
 * the aggregate discovery read budget after four exact-revision reads. */
const budgetManifestText = `{"dependencies":{"pad":"${"a".repeat(64_000)}"}}`
const commentedGradleManifestText = `// testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")\n/* useJUnitPlatform() */\nplugins { id("java") }\n`
const commentedMavenManifestText = `<!-- <dependency><artifactId>junit-jupiter</artifactId></dependency> -->\n<project><artifactId>sample</artifactId></project>\n`
const mavenArtifactNamesWithoutJUnitDependencyText = `<project><parent><groupId>org.example</groupId><artifactId>junit-parent</artifactId></parent><artifactId>junit-helper</artifactId><dependencies><dependency><groupId>org.example</groupId><artifactId>spring-core</artifactId></dependency></dependencies></project>\n`
const activeMavenManifestText = `<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>\n`
const activeGradleManifestText = `dependencies { testImplementation("org.junit.jupiter:junit-jupiter:5.10.0") }\n`
const commentedGemfileManifestText = `# gem "rspec", "~> 3.13"\nsource "https://rubygems.org"\n`
const activeGemfileManifestText = `source "https://rubygems.org"\ngem "rspec", "~> 3.13"\n`
const commentedPyprojectTestManifestText = `# [tool.pytest.ini_options]\n[project]\nname = "sample"\n`
const activePyprojectTestManifestText = `[project]\nname = "sample"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`
const commentedCsprojTestManifestText = `<Project><!-- <IsTestProject>true</IsTestProject> --><!-- <PackageReference Include="Microsoft.NET.Test.Sdk" /> --></Project>\n`
const activeCsprojTestManifestText = `<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n`
const commentedSwiftTestManifestText = `// .testTarget(name: "ExampleTests", dependencies: ["Example"])\n/* .testTarget(name: "ExampleBlockTests", dependencies: ["Example"]) */\nlet package = Package(name: "Example", targets: [])\n`
const activeSwiftTestManifestText = `let package = Package(name: "Example", targets: [.testTarget(name: "ExampleTests", dependencies: ["Example"])])\n`
/** >32 KiB of rendered tree lines, used to prove the `repo_tree` display cap. */
const largeTreeEntries = Array.from({ length: 512 }, (_, index) => ({
  pathRef:
    index === 0
      ? "src/generated/evil\u001b]0;pwned\u0007_\u202egnp.ts"
      : `src/generated/module_${String(index).padStart(4, "0")}_padding_padding_padding_padding_padding_padding.ts`,
  kind: "file" as const,
  depth: 2,
  sizeBytes: "128",
}))
const treeEntriesFor = (rootRef: string) => (rootRef === "large" ? largeTreeEntries : discoveryPage.entries)
const manifestEntry = (pathRef: string, sizeBytes: string, extra: Partial<{ manifestKind: string; languageHint: string }> = {}) => ({
  pathRef,
  kind: "file" as const,
  depth: 1,
  sizeBytes,
  manifestKind: (extra.manifestKind ?? "package_json") as "package_json",
  ...(extra.languageHint ? { languageHint: extra.languageHint as "javascript" } : {}),
})
/** Root-keyed manifest fixtures for the rejection negatives; each scenario names a
 * different malformed/oversized/revision-drifted discovery result. */
const manifestEntriesFor = (root: string): ReadonlyArray<Record<string, unknown>> => {
  switch (root) {
    case "oversized":
      return [manifestEntry("package.json", "70000")]
    case "mismatch":
      return [manifestEntry("package.json", "512", { manifestKind: "cargo_toml" })]
    case "overlong":
      return [manifestEntry("package.json", "4")]
    case "drift":
      return [manifestEntry("drift/package.json", "512")]
    case "budget":
      return Array.from({ length: 5 }, (_, index) => manifestEntry(`budget/pkg-${index}/package.json`, "65536"))
    case "redact":
      return [manifestEntry("redact/api_key=fixture-secret/package.json", "512", { languageHint: "javascript" })]
    case "commented-test-config":
      return [
        manifestEntry("build.gradle", "512", { manifestKind: "gradle" }),
        manifestEntry("pom.xml", "512", { manifestKind: "pom_xml" }),
      ]
    case "active-test-config":
      return [
        manifestEntry("active-test-config/build.gradle", "512", { manifestKind: "gradle" }),
        manifestEntry("active-test-config/pom.xml", "512", { manifestKind: "pom_xml" }),
      ]
    case "maven-nondependency-junit":
      return [manifestEntry("maven-nondependency-junit/pom.xml", "512", { manifestKind: "pom_xml" })]
    case "commented-gemfile":
    case "active-gemfile":
      return [manifestEntry(`${root}/Gemfile`, "512", { manifestKind: "gemfile" })]
    case "commented-pyproject-test":
    case "active-pyproject-test":
      return [manifestEntry(`${root}/pyproject.toml`, "512", { manifestKind: "pyproject_toml" })]
    case "commented-csproj-test":
    case "active-csproj-test":
      return [manifestEntry(`${root}/sample.csproj`, "512", { manifestKind: "csproj" })]
    case "commented-swift-test":
    case "active-swift-test":
      return [manifestEntry(`${root}/Package.swift`, "512", { manifestKind: "package_swift" })]
    case "partial":
      return [manifestEntry("package.json", "512", { languageHint: "javascript" })]
    default:
      return [manifestEntry("package.json", "512", { languageHint: "javascript" })]
  }
}
const discoverySupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    discoverRepo: (input) => Effect.sync(() => {
      observedDiscoveryCalls.push({ mode: input.request.mode, request: input.request })
      const root = input.request.rootRef
      const envelope = {
        schemaVersion: 1 as const,
        messageType: "discovery" as const,
        requestId: input.request.requestId,
        authority: {
          ...discoveryPage.authority,
          rootRef: root,
          mode: input.request.mode,
          maxEntries: input.request.maxEntries,
          maxBytes: input.request.maxBytes,
          maxDepth: input.request.maxDepth,
        },
      }
      // A typed HostKernel unavailability is a real discovery result the tool must
      // relay verbatim, including its reason.
      if (root === "unavailable") {
        return Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoDiscoveryPageV1)({
          ...envelope,
          status: "UNAVAILABLE",
          freshness: "unknown",
          completeness: "unavailable",
          unavailableReason: "read_unavailable",
          coverage: { entries: 0, bytes: 0, depth: 0 },
          entries: [],
        })
      }
      const noncurrent = root === "noncurrent"
      const partial = input.request.mode === "manifests" && root === "partial"
      const entries = input.request.mode === "tree"
        ? treeEntriesFor(root)
        : manifestEntriesFor(root)
      return Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoDiscoveryPageV1)({
        ...envelope,
        status: partial ? "PARTIAL" : "CURRENT",
        freshness: noncurrent ? "unknown" : "current",
        completeness: partial ? "partial" : "complete",
        ...(partial ? { partialReason: "entry_limit" as const } : {}),
        entries,
        coverage: {
          entries: entries.length,
          bytes: 128,
          depth: root === "redact" ? 2 : 1,
        },
      })
    }),
    readRepoDocument: (input) => Effect.sync(() => {
      observedManifestReads.push(input.request.pathRef)
      observedManifestRevisionKinds.push(input.request.revisionKind)
      const text = input.request.pathRef.startsWith("budget/")
        ? budgetManifestText
        : input.request.pathRef.startsWith("commented-gemfile/")
          ? commentedGemfileManifestText
        : input.request.pathRef.startsWith("active-gemfile/")
          ? activeGemfileManifestText
        : input.request.pathRef.startsWith("commented-pyproject-test/")
          ? commentedPyprojectTestManifestText
        : input.request.pathRef.startsWith("active-pyproject-test/")
          ? activePyprojectTestManifestText
        : input.request.pathRef.startsWith("commented-csproj-test/")
          ? commentedCsprojTestManifestText
        : input.request.pathRef.startsWith("active-csproj-test/")
          ? activeCsprojTestManifestText
        : input.request.pathRef.startsWith("commented-swift-test/")
          ? commentedSwiftTestManifestText
        : input.request.pathRef.startsWith("active-swift-test/")
          ? activeSwiftTestManifestText
        : input.request.pathRef.startsWith("active-test-config/")
          ? input.request.pathRef.endsWith("pom.xml") ? activeMavenManifestText : activeGradleManifestText
        : input.request.pathRef.startsWith("maven-nondependency-junit/")
          ? mavenArtifactNamesWithoutJUnitDependencyText
        : input.request.pathRef.endsWith("build.gradle")
          ? commentedGradleManifestText
          : input.request.pathRef.endsWith("pom.xml")
            ? commentedMavenManifestText
            : defaultManifestText
      const observedWorkspaceRevision = input.request.pathRef.startsWith("drift/")
        ? discoveryRevisionDrift
        : input.request.expectedWorkspaceRevision
      return { schemaVersion: 1 as const, status: "OK" as const, pathRef: input.request.pathRef,
        revisionKind: input.request.revisionKind,
        text,
        contentDigest: Schema.decodeUnknownSync(Digest)(RepoIntelligenceSchema.repoDocumentContentDigest(text)),
        observedWorkspaceRevision }
    }),
  }),
  deps: [],
})
const itDiscovery = testEffect(LayerNode.compile(LayerNode.group([
  Config.node, FSUtil.node, RepoIntel.node, CrossSpawnSpawner.node, Truncate.node, Agent.node, Git.node,
  discoverySupervisorNode, trustedPrincipalNode,
]), [[Config.node, configLayer]]))
const itUnavailableSupervisor = testEffect(
  LayerNode.compile(LayerNode.group([
    Config.node, FSUtil.node, RepoIntel.node, CrossSpawnSpawner.node, Truncate.node, Agent.node, Git.node,
    unavailableSupervisorNode, trustedPrincipalNode,
  ]), [[Config.node, configLayer]]),
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

  itRepoStructure.instance("lists every bounded same-name candidate without selecting a write target", () =>
    Effect.gen(function* () {
      const info = yield* DefinitionsFindTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "entry" }, ctx)
      expect(result.metadata.status).toBe("PARTIAL")
      expect(result.output).toContain("src/a.ts:1 function entry")
      expect(result.output).toContain("src/b.ts:1 function entry")
      expect(result.output).toContain("candidates do not authorize edits")
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

  itDiscovery.instance("caps repo_tree rendering at 32 KiB while keeping authority provenance", () =>
    Effect.gen(function* () {
      const treeInfo = yield* RepoTreeTool
      const tree = yield* treeInfo.init()
      const result = yield* tree.execute({ path: "large", depth: 8, maxEntries: 512 }, ctx)
      const bytes = new TextEncoder().encode(result.output).byteLength
      expect(bytes).toBeLessThanOrEqual(32 * 1024)
      expect(result.output).toContain("[display truncated at 32 KiB")
      // The header that carries the provenance survives the truncation.
      expect(result.output).toContain("authority: authenticated read-only inventory")
      expect(result.output).toContain("coverage: 512 entries")
      expect(result.output).toContain("sourceRevision:")
      // RD-020: terminal controls, OSC payloads and bidi overrides never reach
      // the discovery output; the stripped label is what the tool printed.
      expect(result.output).not.toContain("\u001b")
      expect(result.output).not.toContain("\u0007")
      expect(result.output).not.toContain("\u202e")
      expect(result.output).toContain("evil]0;pwned")
      expect(result.metadata.status).toBe("CURRENT")
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

  itDiscovery.instance("does not report commented-out Maven or Gradle test declarations", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "commented-test-config" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test framework: JUnit declared")
      const active = yield* detect.execute({ path: "active-test-config" }, ctx)
      expect(active.output).toContain("test framework: JUnit declared")
      expect(active.output).toContain("test framework: JUnit declared (from active-test-config/pom.xml)")
      expect(observedManifestReads).toEqual([
        "build.gradle",
        "pom.xml",
        "active-test-config/build.gradle",
        "active-test-config/pom.xml",
      ])
    }),
  )

  itDiscovery.instance("does not infer JUnit from Maven project or parent artifact names", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "maven-nondependency-junit" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test framework: JUnit declared")
      expect(observedManifestReads).toEqual(["maven-nondependency-junit/pom.xml"])
    }),
  )

  itDiscovery.instance("does not report a commented-out Gemfile test dependency", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const commented = yield* detect.execute({ path: "commented-gemfile" }, ctx)
      expect(commented.metadata.status).toBe("CURRENT")
      expect(commented.output).not.toContain("test framework: declared")

      const active = yield* detect.execute({ path: "active-gemfile" }, ctx)
      expect(active.output).toContain("test framework: declared")
      expect(observedManifestReads).toEqual(["commented-gemfile/Gemfile", "active-gemfile/Gemfile"])
    }),
  )

  itDiscovery.instance("does not report a commented-out pyproject test table", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const commented = yield* detect.execute({ path: "commented-pyproject-test" }, ctx)
      expect(commented.metadata.status).toBe("CURRENT")
      expect(commented.output).not.toContain("test configuration: declared")

      const active = yield* detect.execute({ path: "active-pyproject-test" }, ctx)
      expect(active.output).toContain("test configuration: declared")
      expect(observedManifestReads).toEqual([
        "commented-pyproject-test/pyproject.toml",
        "active-pyproject-test/pyproject.toml",
      ])
    }),
  )

  itDiscovery.instance("does not report commented-out .NET test project declarations", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const commented = yield* detect.execute({ path: "commented-csproj-test" }, ctx)
      expect(commented.metadata.status).toBe("CURRENT")
      expect(commented.output).not.toContain("test project: declared")

      const active = yield* detect.execute({ path: "active-csproj-test" }, ctx)
      expect(active.output).toContain("test project: declared")
      expect(observedManifestReads).toEqual([
        "commented-csproj-test/sample.csproj",
        "active-csproj-test/sample.csproj",
      ])
    }),
  )

  itDiscovery.instance("does not report a commented-out SwiftPM test target", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const commented = yield* detect.execute({ path: "commented-swift-test" }, ctx)
      expect(commented.metadata.status).toBe("CURRENT")
      expect(commented.output).not.toContain("test target: declared")

      const active = yield* detect.execute({ path: "active-swift-test" }, ctx)
      expect(active.output).toContain("test target: declared")
      expect(observedManifestReads).toEqual([
        "commented-swift-test/Package.swift",
        "active-swift-test/Package.swift",
      ])
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

  itDiscovery.instance("surfaces the typed unavailable reason of an authenticated discovery page", () =>
    Effect.gen(function* () {
      // HostKernel reports exactly why discovery failed (read_unavailable /
      // deadline_exceeded / workspace_changed). Dropping the typed reason would
      // leave the model unable to distinguish a permission problem from a deadline.
      observedManifestReads.length = 0
      const treeInfo = yield* RepoTreeTool
      const tree = yield* treeInfo.init()
      const treeResult = yield* tree.execute({ path: "unavailable", depth: 8 }, ctx)
      expect(treeResult.metadata.status).toBe("UNAVAILABLE")
      expect(treeResult.output).toContain("status: UNAVAILABLE")
      expect(treeResult.output).toContain("unavailableReason: read_unavailable")
      // An empty refusal must not claim an inventory that was never returned.
      expect(treeResult.output).toContain("no inventory was returned")
      expect(treeResult.output).not.toContain("authenticated read-only inventory")

      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const detectResult = yield* detect.execute({ path: "unavailable" }, ctx)
      expect(detectResult.metadata.status).toBe("UNAVAILABLE")
      expect(detectResult.output).toContain("unavailableReason: read_unavailable")
      expect(observedManifestReads).toHaveLength(0)
    }),
  )

  itDiscovery.instance("rejects oversized or mislabelled manifest candidates before any document read", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      observedManifestRevisionKinds.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()

      const oversized = yield* detect.execute({ path: "oversized" }, ctx)
      expect(oversized.metadata.status).toBe("UNAVAILABLE")
      expect(oversized.output).toContain("reason: manifest read budget exceeded")

      const mislabelled = yield* detect.execute({ path: "mismatch" }, ctx)
      expect(mislabelled.metadata.status).toBe("UNAVAILABLE")
      expect(mislabelled.output).toContain("reason: discovery returned an invalid manifest candidate")

      // Neither candidate may reach the authenticated document-read path.
      expect(observedManifestReads).toHaveLength(0)
      expect(observedManifestRevisionKinds).toHaveLength(0)
    }),
  )

  itDiscovery.instance("rejects a manifest read that drifted from the discovery revision or its declared size", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()

      const drift = yield* detect.execute({ path: "drift" }, ctx)
      expect(drift.metadata.status).toBe("UNAVAILABLE")
      expect(drift.output).toContain("reason: manifest could not be read at the discovery revision")

      const overlong = yield* detect.execute({ path: "overlong" }, ctx)
      expect(overlong.metadata.status).toBe("UNAVAILABLE")
      expect(overlong.output).toContain("reason: manifest read bytes exceeded the authenticated discovery budget")

      // Both rejections are reported after at most one read and never as detection.
      expect(observedManifestReads).toHaveLength(2)
      expect(drift.output).not.toContain("detected: package system")
    }),
  )

  itDiscovery.instance("stops at the bounded manifest read budget without reading the remaining candidates", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "budget" }, ctx)
      expect(result.metadata.status).toBe("UNAVAILABLE")
      expect(result.output).toContain("reason: manifest read budget exceeded")
      // 5 candidates × 65536 declared bytes exceed the 256 KiB read budget after
      // four exact-revision reads; the fifth candidate must never be read.
      expect(observedManifestReads).toHaveLength(4)
      expect(result.output).not.toContain("detected: package system")
    }),
  )

  itDiscovery.instance("refuses manifest detection when the discovery page has no current source revision", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "noncurrent" }, ctx)
      expect(result.metadata.status).toBe("UNAVAILABLE")
      expect(result.output).toContain("reason: manifest discovery has no current source revision")
      expect(observedManifestReads).toHaveLength(0)
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
      expect(result.output).toContain("function entry")
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
