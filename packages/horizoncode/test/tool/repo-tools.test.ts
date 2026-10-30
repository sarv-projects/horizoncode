import { describe, expect, it } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { FSUtil } from "@horizoncode/core/fs-util"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { Location as LocationSchema } from "@horizoncode/schema"
import * as RepoIntelligenceSchema from "@horizoncode/schema/repo-intelligence-v1"
import { Digest } from "@horizoncode/schema/composition-v1"
import { AbsolutePath } from "@horizoncode/core/schema"
import {
  REPO_DISCOVERY_TOOL_ACCEPTANCE_READY,
  REPO_INTEL_TOOL_ACCEPTANCE_READY,
  ToolRegistry,
} from "@/tool/registry"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectV2 } from "@horizoncode/core/project"
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

const unavailableSupervisorMock = Layer.mock(SessionSupervisor.Service, {
  hostFeatureEnabled: () => Effect.succeed(false),
  queryRepoStructure: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  discoverRepo: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  readRepoDocument: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
})
const unavailableSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: unavailableSupervisorMock,
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
    // ToolRegistry declares SessionSupervisor.node as a dependency, so the mock
    // must replace that node rather than sit beside it in the group.
    [SessionSupervisor.node, unavailableSupervisorMock],
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

// A host that negotiated `repo-intel.read-context-v1`. The operations still fail
// closed, so these tests observe registry visibility only, never a real read.
const hostReadySupervisorMock = Layer.mock(SessionSupervisor.Service, {
  hostFeatureEnabled: () => Effect.succeed(true),
  queryRepoStructure: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  discoverRepo: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
  readRepoDocument: () => Effect.fail({ _tag: "SessionSupervisorError", code: "host-kernel-feature" } as never),
})
const hostReadyRegistryLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(registryRoot, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    [SessionSupervisor.node, hostReadySupervisorMock],
  ]).pipe(Layer.provide(fixtureInstanceRef))

const itHostReady = testEffect(hostReadyRegistryLayer())
const itHostReadyExperimental = testEffect(hostReadyRegistryLayer({ experimentalRepoTools: true }))

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
const unknownFreshnessCurrentStructurePage = {
  ...structurePage,
  freshness: "unknown" as const,
}
const unknownFreshnessPartialStructurePage = {
  ...structurePage,
  status: "PARTIAL" as const,
  freshness: "unknown" as const,
  completeness: "partial" as const,
}
const bidiStructurePage = Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoStructurePageV1)({
  ...structurePage,
  nodes: structurePage.nodes.map((node, index) => index === 0
    ? { ...node, pathRef: "src/pay\u202Eload.ts" }
    : node),
})
const repoStructureSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: (input) =>
      Effect.sync(() => {
        observedStructureCalls.push(input)
        const page = input.query.rootRef === "unknown-current"
          ? unknownFreshnessCurrentStructurePage
          : input.query.rootRef === "unknown-partial"
            ? unknownFreshnessPartialStructurePage
            : structurePage
        return { ...page, queryId: input.query.queryId }
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
const bidiRepoStructureSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.mock(SessionSupervisor.Service, {
    queryRepoStructure: (input) => Effect.succeed({ ...bidiStructurePage, queryId: input.query.queryId }),
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
const itBidiRepoStructure = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      FSUtil.node,
      RepoIntel.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Git.node,
      bidiRepoStructureSupervisorNode,
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
const nestedCommentedGradleManifestText = `/* outer /* inner */ useJUnitPlatform() */\nplugins { id("java") }\n`
const unterminatedGradleManifestText = `/* unterminated\nplugins { id("java") }\nuseJUnitPlatform()\n`
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
const orderedCsprojTestManifestText = `<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n`
const commentedSwiftTestManifestText = `// .testTarget(name: "ExampleTests", dependencies: ["Example"])\n/* .testTarget(name: "ExampleBlockTests", dependencies: ["Example"]) */\nlet package = Package(name: "Example", targets: [])\n`
const nestedCommentedSwiftTestManifestText = `/* outer /* inner */ .testTarget(name: "NestedExampleTests", dependencies: ["Example"]) */\nlet package = Package(name: "Example", targets: [])\n`
const activeSwiftTestManifestText = `let package = Package(name: "Example", targets: [.testTarget(name: "ExampleTests", dependencies: ["Example"])])\n`
const mavenExclusionJunitManifestText = `<project><dependencies><dependency><groupId>com.example</groupId><artifactId>lib</artifactId><exclusions><exclusion><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></exclusion></exclusions></dependency></dependencies></project>\n`
const explicitNonTestCsprojManifestText = `<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>\n`
const commentedSlnManifestText = `# Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Test", "Test.csproj", "{...}"\n# Microsoft.NET.Test.Sdk\n`
const inlineCommentGemfileManifestText = `source "https://rubygems.org"\ngem "rake" # rspec is deprecated\n`
const inlineCommentPyprojectManifestText = `[project]\nname = "sample"\ndescription = "Works with [tool.pytest] plugins"\n# [tool.pytest.ini_options]\n`
const poetryScriptsPyprojectManifestText = `[tool.poetry.scripts]\nserve = "app:main"\n`
const stringCargoTestManifestText = `[package]\nname = "sample"\ndescription = """\n[[test]]\n"""\n`
const activeCargoTestManifestText = `[package]\nname = "sample"\n\n[[test]]\nname = "integration"\n`
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
    case "nested-commented-gradle":
    case "unterminated-gradle":
      return [manifestEntry(`${root}/build.gradle`, "512", { manifestKind: "gradle" })]
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
    case "ordered-csproj-test":
      return [manifestEntry(`${root}/sample.csproj`, "512", { manifestKind: "csproj" })]
    case "commented-swift-test":
    case "active-swift-test":
    case "nested-commented-swift-test":
      return [manifestEntry(`${root}/Package.swift`, "512", { manifestKind: "package_swift" })]
    case "maven-exclusion-junit":
      return [manifestEntry("maven-exclusion-junit/pom.xml", "512", { manifestKind: "pom_xml" })]
    case "explicit-non-test-csproj":
      return [manifestEntry("explicit-non-test-csproj/sample.csproj", "512", { manifestKind: "csproj" })]
    case "commented-sln":
      return [manifestEntry("commented-sln/sample.sln", "512", { manifestKind: "sln" })]
    case "inline-comment-gemfile":
      return [manifestEntry("inline-comment-gemfile/Gemfile", "512", { manifestKind: "gemfile" })]
    case "inline-comment-pyproject":
      return [manifestEntry("inline-comment-pyproject/pyproject.toml", "512", { manifestKind: "pyproject_toml" })]
    case "poetry-scripts-pyproject":
      return [manifestEntry("poetry-scripts-pyproject/pyproject.toml", "512", { manifestKind: "pyproject_toml" })]
    case "string-cargo-test":
    case "active-cargo-test":
      return [manifestEntry(`${root}/Cargo.toml`, "512", { manifestKind: "cargo_toml" })]
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
        : input.request.pathRef.startsWith("nested-commented-gradle/")
          ? nestedCommentedGradleManifestText
        : input.request.pathRef.startsWith("unterminated-gradle/")
          ? unterminatedGradleManifestText
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
        : input.request.pathRef.startsWith("ordered-csproj-test/")
          ? orderedCsprojTestManifestText
        : input.request.pathRef.startsWith("commented-swift-test/")
          ? commentedSwiftTestManifestText
        : input.request.pathRef.startsWith("nested-commented-swift-test/")
          ? nestedCommentedSwiftTestManifestText
        : input.request.pathRef.startsWith("active-swift-test/")
          ? activeSwiftTestManifestText
        : input.request.pathRef.startsWith("active-test-config/")
          ? input.request.pathRef.endsWith("pom.xml") ? activeMavenManifestText : activeGradleManifestText
        : input.request.pathRef.startsWith("maven-nondependency-junit/")
          ? mavenArtifactNamesWithoutJUnitDependencyText
        : input.request.pathRef.startsWith("maven-exclusion-junit/")
          ? mavenExclusionJunitManifestText
        : input.request.pathRef.startsWith("explicit-non-test-csproj/")
          ? explicitNonTestCsprojManifestText
        : input.request.pathRef.startsWith("commented-sln/")
          ? commentedSlnManifestText
        : input.request.pathRef.startsWith("inline-comment-gemfile/")
          ? inlineCommentGemfileManifestText
        : input.request.pathRef.startsWith("inline-comment-pyproject/")
          ? inlineCommentPyprojectManifestText
        : input.request.pathRef.startsWith("poetry-scripts-pyproject/")
          ? poetryScriptsPyprojectManifestText
        : input.request.pathRef.startsWith("string-cargo-test/")
          ? stringCargoTestManifestText
        : input.request.pathRef.startsWith("active-cargo-test/")
          ? activeCargoTestManifestText
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

  itRegistry.instance("keeps discovery-level repo tools hidden until the host negotiates the read context", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(REPO_DISCOVERY_TOOL_ACCEPTANCE_READY).toBe(true)
      expect(REPO_INTEL_TOOL_ACCEPTANCE_READY).toBe(false)
      expect(ids).not.toContain("repo_tree")
      expect(ids).not.toContain("repo_detect")
      expect(ids).not.toContain("symbols_search")
      expect(ids).not.toContain("references_find")
      expect(ids).not.toContain("definitions_find")
    }),
  )

  itRepoTools.instance("still requires the negotiated host feature after the experimental opt-in", () =>
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

  itHostReady.instance("offers repo_tree and repo_detect by default once the host feature is available", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      // Discovery needs no experimental opt-in: the negotiated host feature is
      // the only remaining gate.
      expect(ids).toContain("repo_tree")
      expect(ids).toContain("repo_detect")
      // Structural reads stay closed: indexd answers symbol/references/impact
      // with a typed unsupported result, so the acceptance flag remains false.
      expect(REPO_INTEL_TOOL_ACCEPTANCE_READY).toBe(false)
      expect(ids).not.toContain("symbols_search")
      expect(ids).not.toContain("references_find")
      expect(ids).not.toContain("definitions_find")
      // DAP stays closed and the LSP tool still needs the HostKernel routes.
      expect(ids).not.toContain("debug")
      expect(ids).not.toContain("lsp")
    }),
  )

  itHostReadyExperimental.instance("does not let the experimental opt-in release structural acceptance", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("repo_tree")
      expect(ids).toContain("repo_detect")
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

  itBidiRepoStructure.instance("removes bidi format controls from terminal-rendered RepoSearch nodes", () =>
    Effect.gen(function* () {
      const info = yield* DefinitionsFindTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ query: "entry" }, ctx)

      expect(result.output).not.toContain("\u202E")
      expect(result.output).toContain("src/payload.ts:1 function entry")
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

  itDiscovery.instance("does not expose repo_tree entries when discovery freshness is unknown", () =>
    Effect.gen(function* () {
      const treeInfo = yield* RepoTreeTool
      const tree = yield* treeInfo.init()
      const result = yield* tree.execute({ path: "noncurrent", depth: 8 }, ctx)

      expect(result.metadata.status).toBe("UNAVAILABLE")
      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("no current source revision")
      expect(result.output).not.toContain("src/link")
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

  itDiscovery.instance("reports an unterminated Gradle block comment as a parse failure", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "unterminated-gradle" }, ctx)
      expect(result.metadata.status).toBe("PARTIAL")
      expect(result.output).toContain("parse: failed (unterminated-gradle/build.gradle)")
      expect(result.output).not.toContain("test framework: JUnit declared")
      expect(observedManifestReads).toEqual(["unterminated-gradle/build.gradle"])
    }),
  )

  itDiscovery.instance("does not report Gradle test declarations hidden in nested block comments", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const nested = yield* detect.execute({ path: "nested-commented-gradle" }, ctx)
      expect(nested.metadata.status).toBe("CURRENT")
      expect(nested.output).not.toContain("test framework: JUnit declared")

      const active = yield* detect.execute({ path: "active-test-config" }, ctx)
      expect(active.output).toContain("test framework: JUnit declared (from active-test-config/build.gradle)")
      expect(observedManifestReads).toEqual([
        "nested-commented-gradle/build.gradle",
        "active-test-config/build.gradle",
        "active-test-config/pom.xml",
      ])
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

  itDiscovery.instance("uses the last .NET IsTestProject declaration when property groups override earlier values", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "ordered-csproj-test" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).toContain("test project: declared")
      expect(observedManifestReads).toEqual(["ordered-csproj-test/sample.csproj"])
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

  itDiscovery.instance("does not report a test target hidden in nested Swift block comments", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const nested = yield* detect.execute({ path: "nested-commented-swift-test" }, ctx)
      expect(nested.metadata.status).toBe("CURRENT")
      expect(nested.output).not.toContain("test target: declared")
      expect(observedManifestReads).toEqual(["nested-commented-swift-test/Package.swift"])
    }),
  )

  itDiscovery.instance("does not report JUnit when Maven dependency excludes JUnit", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "maven-exclusion-junit" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test framework: JUnit declared")
      expect(observedManifestReads).toEqual(["maven-exclusion-junit/pom.xml"])
    }),
  )

  itDiscovery.instance("does not report test project when .NET project explicitly declares IsTestProject false or in commented .sln", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const nonTest = yield* detect.execute({ path: "explicit-non-test-csproj" }, ctx)
      expect(nonTest.metadata.status).toBe("CURRENT")
      expect(nonTest.output).not.toContain("test project: declared")

      const commentedSln = yield* detect.execute({ path: "commented-sln" }, ctx)
      expect(commentedSln.metadata.status).toBe("CURRENT")
      expect(commentedSln.output).not.toContain("test project: declared")
      expect(observedManifestReads).toEqual([
        "explicit-non-test-csproj/sample.csproj",
        "commented-sln/sample.sln",
      ])
    }),
  )

  itDiscovery.instance("does not report test configuration for inline commented pyproject test tables or descriptions", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "inline-comment-pyproject" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test configuration: declared")
      expect(observedManifestReads).toEqual(["inline-comment-pyproject/pyproject.toml"])
    }),
  )

  itDiscovery.instance("does not mistake Poetry CLI scripts for test configuration", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "poetry-scripts-pyproject" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test configuration: declared")
      expect(observedManifestReads).toEqual(["poetry-scripts-pyproject/pyproject.toml"])
    }),
  )

  itDiscovery.instance("does not report a Cargo test target hidden inside a TOML string", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const hidden = yield* detect.execute({ path: "string-cargo-test" }, ctx)
      expect(hidden.metadata.status).toBe("CURRENT")
      expect(hidden.output).not.toContain("test target: declared")

      const active = yield* detect.execute({ path: "active-cargo-test" }, ctx)
      expect(active.output).toContain("test target: declared")
      expect(observedManifestReads).toEqual([
        "string-cargo-test/Cargo.toml",
        "active-cargo-test/Cargo.toml",
      ])
    }),
  )

  itDiscovery.instance("does not report test framework for inline commented Gemfile dependencies", () =>
    Effect.gen(function* () {
      observedManifestReads.length = 0
      const detectInfo = yield* RepoDetectTool
      const detect = yield* detectInfo.init()
      const result = yield* detect.execute({ path: "inline-comment-gemfile" }, ctx)
      expect(result.metadata.status).toBe("CURRENT")
      expect(result.output).not.toContain("test framework: declared")
      expect(observedManifestReads).toEqual(["inline-comment-gemfile/Gemfile"])
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

  itRepoStructure.instance("fails closed for unknown-freshness pages without a continuation cursor", () =>
    Effect.gen(function* () {
      const info = yield* SymbolsSearchTool
      const tool = yield* info.init()

      for (const path of ["unknown-current", "unknown-partial"]) {
        const result = yield* tool.execute({ query: "entry", path }, ctx)
        expect(result.metadata.status).toBe("UNAVAILABLE")
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("status: UNAVAILABLE")
        expect(result.output).not.toContain("src/a.ts")
      }
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
