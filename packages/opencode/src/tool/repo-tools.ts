import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location as LocationSchema } from "@opencode-ai/schema"
import * as RepoIntelligenceSchema from "@opencode-ai/schema/repo-intelligence-v1"
import { RepoIntel } from "./repo-intel"
import * as Tool from "./tool"

const REPO_SEARCH_OUTPUT_MAX_BYTES = 32 * 1024
const REPO_SEARCH_OUTPUT_TRUNCATION = "[output truncated at 32 KiB; narrow the query or continue with nextCursor]"
const RepoDiscoveryParameters = Schema.Struct({
  path: Schema.optional(RepoSearchPath).annotate({ description: "Subdirectory relative to the project root." }),
  depth: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))).annotate({
    description: "Maximum directory depth (1-16, default 8).",
  }),
  maxEntries: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 }))).annotate({
    description: "Maximum returned/visited entries (1-512, default 256).",
  }),
})

type DiscoveryInput = typeof RepoDiscoveryParameters.Type

const REPO_DISCOVERY_MAX_BYTES = 256 * 1024
const REPO_DISCOVERY_OUTPUT_MAX_BYTES = 32 * 1024
const REPO_DISCOVERY_DOCUMENT_MAX_BYTES = 64 * 1024
const REPO_DISCOVERY_OUTPUT_TRUNCATION = "[detection output truncated at 32 KiB; narrow the repository path]"

/** Repository names are source-controlled input and may contain terminal controls. Keep
 * canonical path refs untouched for HostKernel reads; transform only their display form. */
const safeDiscoveryLabel = (value: string, maxBytes = 512) => {
  const clean = value
    // Removing ESC makes any remaining printable fragments inert even when an
    // attacker supplies an incomplete CSI/OSC sequence.
    .replace(/\u001b/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|credential|cookie)\b\s*[:=]\s*)[^/]+/giu, "$1[REDACTED]")
  const encoder = new TextEncoder()
  if (encoder.encode(clean).byteLength <= maxBytes) return clean
  let result = ""
  for (const point of clean) {
    if (encoder.encode(result + point).byteLength > maxBytes - 3) break
    result += point
  }
  return `${result}…`
}

const boundDiscoveryOutput = (lines: ReadonlyArray<string>) => {
  const encoder = new TextEncoder()
  const output = lines.join("\n")
  if (encoder.encode(output).byteLength <= REPO_DISCOVERY_OUTPUT_MAX_BYTES) return output
  const kept: string[] = []
  let bytes = 0
  const markerBytes = encoder.encode(`\n${REPO_DISCOVERY_OUTPUT_TRUNCATION}`).byteLength
  for (const line of lines) {
    const lineBytes = encoder.encode(`${kept.length === 0 ? "" : "\n"}${line}`).byteLength
    if (bytes + lineBytes + markerBytes > REPO_DISCOVERY_OUTPUT_MAX_BYTES) break
    kept.push(line)
    bytes += lineBytes
  }
  kept.push(REPO_DISCOVERY_OUTPUT_TRUNCATION)
  return kept.join("\n")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const knownManifestForPath = (path: string): string | undefined => {
  const name = path.split("/").at(-1)?.toLowerCase()
  if (!name) return undefined
  if (name === "package.json") return "package_json"
  if (name === "tsconfig.json") return "tsconfig_json"
  if (name === "cargo.toml") return "cargo_toml"
  if (name === "pyproject.toml") return "pyproject_toml"
  if (name === "requirements.txt") return "requirements_txt"
  if (name === "go.mod") return "go_mod"
  if (name === "pom.xml") return "pom_xml"
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle"
  if (name === "composer.json") return "composer_json"
  if (name === "gemfile") return "gemfile"
  if (name === "package.swift") return "package_swift"
  if (name === "makefile" || name === "gnumakefile") return "makefile"
  if (name === "dockerfile") return "dockerfile"
  if (name.endsWith(".csproj")) return "csproj"
  if (name.endsWith(".sln")) return "sln"
  return undefined
}

const detectManifestFacts = (kind: string, text: string) => {
  const facts = new Set<string>()
  let parseFailed = false
  const mention = (fact: string) => facts.add(fact)
  switch (kind) {
    case "package_json": {
      let manifest: Record<string, unknown> | undefined
      try {
        const value: unknown = JSON.parse(text)
        if (isRecord(value)) manifest = value
        else parseFailed = true
      } catch {
        parseFailed = true
      }
      if (!manifest) break
      mention("package system: npm-compatible (package.json)")
      if (typeof manifest.packageManager === "string") {
        const manager = /^(npm|pnpm|yarn|bun)@/u.exec(manifest.packageManager)?.[1]
        if (manager) mention(`package manager: ${manager}`)
      }
      const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
        .filter(isRecord)
        .flatMap((group) => Object.keys(group))
      const dependencySet = new Set(dependencies)
      mention(dependencySet.has("typescript") ? "language: typescript" : "language: javascript")
      const frameworks = [
        ["react", "react"],
        ["next", "next.js"],
        ["vue", "vue"],
        ["svelte", "svelte"],
        ["@angular/core", "angular"],
      ] as const
      for (const [dependency, framework] of frameworks) {
        if (dependencySet.has(dependency)) mention(`framework: ${framework}`)
      }
      if (isRecord(manifest.scripts)) {
        if (typeof manifest.scripts.test === "string") mention("test script: declared")
        if (typeof manifest.scripts.build === "string") mention("build script: declared")
      }
      break
    }
    case "tsconfig_json":
      mention("language: typescript")
      break
    case "cargo_toml":
      mention("language: rust")
      mention("package system: Cargo")
      if (/^\s*\[\[?test\]\]?\s*$/mu.test(text)) mention("test target: declared")
      break
    case "pyproject_toml":
      mention("language: python")
      mention("package system: pyproject.toml")
      if (/\[tool\.(?:pytest|tox|nox)|\[tool\.poetry\.scripts\]/u.test(text)) mention("test configuration: declared")
      if (/\[tool\.(?:poetry|uv|hatch|setuptools)\]/u.test(text)) mention("build/package configuration: declared")
      break
    case "requirements_txt":
      mention("language: python")
      mention("package system: pip requirements")
      break
    case "go_mod":
      mention("language: go")
      mention("package system: Go modules")
      break
    case "pom_xml":
      mention("language: java")
      mention("build system: Maven")
      if (/<artifactId>[^<]*junit[^<]*<\/artifactId>/iu.test(text)) mention("test framework: JUnit declared")
      break
    case "gradle":
      mention("build system: Gradle")
      if (/org\.junit|useJUnitPlatform/u.test(text)) mention("test framework: JUnit declared")
      break
    case "csproj":
    case "sln":
      mention("language: csharp")
      mention("build system: .NET")
      if (/Microsoft\.NET\.Test\.Sdk|\bIsTestProject\b/iu.test(text)) mention("test project: declared")
      break
    case "composer_json":
      try {
        const manifest: unknown = JSON.parse(text)
        if (isRecord(manifest)) {
          mention("language: php")
          mention("package system: Composer")
        } else {
          parseFailed = true
        }
      } catch {
        parseFailed = true
      }
      break
    case "gemfile":
      mention("language: ruby")
      mention("package system: Bundler")
      if (/\brspec\b|\bminitest\b/iu.test(text)) mention("test framework: declared")
      break
    case "package_swift":
      mention("language: swift")
      mention("package system: SwiftPM")
      if (/\.testTarget\s*\(/u.test(text)) mention("test target: declared")
      break
    case "makefile":
      mention("build system: Make")
      if (/^\s*(?:test|check)\s*:/mu.test(text)) mention("test target: declared")
      break
    case "dockerfile":
      mention("build system: Docker")
      break
  }
  return { facts: [...facts], parseFailed }
}

const renderDiscoveryPage = (page: RepoIntelligenceSchema.RepoDiscoveryPageV1) => {
  const lines = [
    `status: ${page.status}`,
    `freshness: ${page.freshness}`,
    `completeness: ${page.completeness}`,
    `workspace: ${page.authority.workspaceBinding}`,
    `sourceRevision: ${page.authority.sourceRevision}`,
    `coverage: ${page.coverage.entries} entries, ${page.coverage.bytes} bytes, depth ${page.coverage.depth}`,
    `authority: authenticated read-only inventory; symlinks are listed and never followed`,
  ]
  if (page.partialReason) lines.push(`partialReason: ${page.partialReason}`)
  for (const entry of page.entries) {
    lines.push(`${"  ".repeat(Math.min(entry.depth, 16))}${safeDiscoveryLabel(entry.pathRef)}${entry.kind === "directory" ? "/" : entry.kind === "symlink" ? " [symlink]" : ""}`)
  }
  let output = lines.join("\n")
  if (Buffer.byteLength(output, "utf8") <= REPO_DISCOVERY_OUTPUT_MAX_BYTES) return output
  const marker = "[display truncated at 32 KiB; HostKernel coverage remains authoritative]"
  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line, marker].join("\n")
    if (Buffer.byteLength(candidate, "utf8") > REPO_DISCOVERY_OUTPUT_MAX_BYTES) break
    kept.push(line)
  }
  kept.push(marker)
  output = kept.join("\n")
  return output
}

const runRepoDiscovery = (
  supervisor: SessionSupervisor.Interface,
  input: DiscoveryInput,
  ctx: Tool.Context,
  mode: "tree" | "manifests",
) => Effect.gen(function* () {
  const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
  if (Option.isNone(principal) || !supervisor.discoverRepo) {
    return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: authenticated HostKernel repository discovery is unavailable", count: 0 }
  }
  const instance = yield* InstanceState.context
  const locationRef = LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) })
  const path = input.path ?? "."
  yield* ctx.ask({ permission: "glob", patterns: [path], always: ["*"], metadata: { path, operation: mode } })
  const page = yield* supervisor.discoverRepo({
    sessionID: ctx.sessionID,
    locationRef,
    request: {
      schemaVersion: 1,
      messageType: "discover",
      requestId: `repo-${randomUUID()}`,
      rootRef: path,
      mode,
      maxEntries: input.maxEntries ?? 256,
      maxBytes: REPO_DISCOVERY_MAX_BYTES,
      maxDepth: input.depth ?? 8,
      deadline: new Date(Date.now() + 30_000).toISOString(),
    },
  }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value))

  if (mode === "tree" || page.status === "UNAVAILABLE") {
    return { status: page.status, output: renderDiscoveryPage(page), count: page.coverage.entries }
  }
  // A bounded partial manifest inventory still contains authenticated current
  // candidates. Read those exact candidates at the same revision and preserve
  // the partial-coverage status; never turn a truncated scan into a complete
  // project-detection claim.
  if (page.freshness !== "current") {
    return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: manifest discovery has no current source revision", count: 0 }
  }
  if (!supervisor.readRepoDocument) {
    return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: authenticated manifest reads are unavailable", count: 0 }
  }
  const manifests = page.entries.filter((entry) => entry.kind === "file" && entry.manifestKind)
  const detected: string[] = []
  let parseFailed = false
  let readBytes = 0
  for (const entry of manifests) {
    if (entry.kind !== "file" || !entry.manifestKind || knownManifestForPath(entry.pathRef) !== entry.manifestKind) {
      return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: discovery returned an invalid manifest candidate", count: 0 }
    }
    if (entry.sizeBytes.length > 20) return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: manifest size is invalid", count: 0 }
    const size = Number(entry.sizeBytes)
    if (!Number.isSafeInteger(size) || size < 0 || size > REPO_DISCOVERY_DOCUMENT_MAX_BYTES || readBytes + size > REPO_DISCOVERY_MAX_BYTES) {
      return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: manifest read budget exceeded", count: 0 }
    }
    const document = yield* supervisor.readRepoDocument({
      sessionID: ctx.sessionID,
      locationRef,
      request: {
        schemaVersion: 1,
        pathRef: entry.pathRef,
        revisionKind: "discovery_observation",
        expectedWorkspaceRevision: page.authority.sourceRevision,
        maxBytes: REPO_DISCOVERY_DOCUMENT_MAX_BYTES,
      },
    }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value), Effect.catch(() => Effect.succeed(undefined)))
    if (document === undefined || document.revisionKind !== "discovery_observation" ||
      document.observedWorkspaceRevision !== page.authority.sourceRevision) {
      return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: manifest could not be read at the discovery revision", count: 0 }
    }
    const documentBytes = Buffer.byteLength(document.text, "utf8")
    if (documentBytes > size || readBytes + documentBytes > REPO_DISCOVERY_MAX_BYTES) {
      return { status: "UNAVAILABLE", output: "status: UNAVAILABLE\nreason: manifest read bytes exceeded the authenticated discovery budget", count: 0 }
    }
    readBytes += documentBytes
    const kind = entry.manifestKind!
    const displayPath = safeDiscoveryLabel(entry.pathRef)
    detected.push(`${kind}: ${displayPath}`)
    const facts = detectManifestFacts(kind, document.text)
    detected.push(...facts.facts.map((fact) => `${fact} (from ${displayPath})`))
    if (entry.languageHint) detected.push(`language hint: ${entry.languageHint} (${displayPath})`)
    if (facts.parseFailed) {
      parseFailed = true
      detected.push(`parse: failed (${displayPath})`)
    }
  }
  const uniqueDetected = [...new Set(detected)]
  const partial = page.status === "PARTIAL" || parseFailed
  return {
    status: partial ? "PARTIAL" : "CURRENT",
    output: boundDiscoveryOutput([
      `status: ${partial ? "PARTIAL" : "CURRENT"}`,
      `sourceRevision: ${page.authority.sourceRevision}`,
      `coverage: ${page.coverage.entries} manifest candidates, ${page.coverage.bytes} discovery bytes`,
      ...(page.partialReason ? [`coveragePartialReason: ${page.partialReason}`] : []),
      ...(uniqueDetected.length ? uniqueDetected.map((fact) => `detected: ${fact}`) : ["detected: no recognized manifests in the bounded scan"]),
      "authority: content read through HostKernel at the exact discovery revision",
    ]),
    count: uniqueDetected.length,
  }
})

const discoveryTool = (name: string, capabilityID: "repo.tree" | "repo.detect", mode: "tree" | "manifests") => Tool.define(
  name,
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    return {
      description: mode === "tree"
        ? "List a bounded repository tree using authenticated HostKernel discovery. Symlinks are shown but never followed."
        : "Detect bounded manifest candidates and common JavaScript frameworks using revision-pinned HostKernel reads.",
      parameters: RepoDiscoveryParameters,
      capability: { id: capabilityID, effectClass: "read_only" },
      execute: (params: DiscoveryInput, ctx: Tool.Context) => runRepoDiscovery(supervisor, params, ctx, mode).pipe(
        Effect.map((result) => ({ title: `${name} ${result.status.toLowerCase()}`, metadata: { status: result.status, count: result.count }, output: result.output })),
        Effect.catch((error) => Effect.succeed({
          title: `${name} unavailable`,
          metadata: { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "hostkernel_discovery_failed" },
          output: "status: UNAVAILABLE\nreason: authenticated HostKernel discovery failed",
        })),
        Effect.orDie,
      ),
    }
  }),
)

/** Core-backed adapters are implemented but remain absent from ToolRegistry until acceptance. */
export const RepoTreeTool = discoveryTool("repo_tree", "repo.tree", "tree")
export const RepoDetectTool = discoveryTool("repo_detect", "repo.detect", "manifests")

const RepoSearchQuery = Schema.String.check(Schema.makeFilter((value) => {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes === 0 || bytes > 1_024) return "query must contain 1-1024 UTF-8 bytes"
  if (/[\r\n\u0000-\u001f\u007f]/u.test(value)) return "query must be a single line without control characters"
  return undefined
}))

const RepoSearchPath = Schema.String.check(Schema.makeFilter((value) => {
  if (Buffer.byteLength(value, "utf8") > 4_096) return "path exceeds 4096 UTF-8 bytes"
  if (value === ".") return undefined
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
    return "path must be a normalized relative path"
  }
  if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "path must not contain empty, dot, or parent segments"
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return "path must not contain control characters"
  return undefined
}))

export const RepoSearchParameters = Schema.Struct({
  query: RepoSearchQuery.annotate({ description: "Single-line symbol name or prefix (1-1024 UTF-8 bytes)." }),
  path: Schema.optional(RepoSearchPath).annotate({
    description: "Subdirectory relative to the project root. Omit to search the whole project.",
  }),
  maxResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
    description: "Maximum results (1-100, default 50).",
  }),
  cursor: Schema.optional(
    Schema.String.check(Schema.isNonEmpty()).check(
      Schema.isMaxLength(RepoIntelligenceSchema.MAX_STRUCTURE_CURSOR_BYTES),
    ),
  ).annotate({ description: "Opaque cursor returned by a previous reply." }),
})

type RepoSearchInput = { query: string; path?: string; maxResults?: number; cursor?: string }

const REPO_STRUCTURE_QUERY_MAX_BYTES = 262_144

const renderStructurePage = (page: RepoIntelligenceSchema.RepoStructurePageV1) => {
  const header = [
    `status: ${page.status}`,
    `freshness: ${page.freshness}`,
    `completeness: ${page.completeness}`,
    `workspace: ${page.workspaceBinding}`,
    `sourceGeneration: ${page.sourceGeneration}`,
    `sourceRevision: ${page.sourceRevision}`,
    `queryID: ${page.queryId}`,
    "authority: read-only evidence; edits require a fresh canonical files.patch/Guard check",
    `source: ${page.sourceKind}; coverage: ${page.coverage.files} files, ${page.coverage.nodes} nodes, ${page.coverage.bytes} bytes`,
  ]
  if (page.parserId !== undefined) header.push(`parser: ${page.parserId}@${page.parserVersion ?? "unknown"}`)
  if (page.overlayDigest !== undefined) header.push(`overlayDigest: ${page.overlayDigest}`)
  if (page.fallback) header.push(`fallback: ${page.fallback.reason}`)
  const nodes = page.nodes.map(
    (node) =>
      `${node.pathRef}:${node.byteRange.start}-${node.byteRange.end} ${node.nodeKind} ${node.symbol} ` +
      `[node=${node.nodeId} file=${node.fileDigest} parser=${node.parserId}@${node.parserVersion}` +
      `${node.overlayDigest ? ` overlay=${node.overlayDigest}` : ""}]`,
  )
  const cursor = page.nextCursor ? `nextCursor: ${page.nextCursor}` : undefined

  const encoder = new TextEncoder()
  const all = [...header, ...nodes, ...(cursor ? [cursor] : [])]
  const output = all.join("\n")
  if (encoder.encode(output).byteLength <= REPO_SEARCH_OUTPUT_MAX_BYTES) return output

  const suffixLines = [REPO_SEARCH_OUTPUT_TRUNCATION, ...(cursor ? [cursor] : [])]
  const suffixBytes = encoder.encode(`\n${suffixLines.join("\n")}`).byteLength
  const lines = [...header]
  let bytes = encoder.encode(lines.join("\n")).byteLength
  for (const line of nodes) {
    const lineBytes = encoder.encode(line).byteLength + 1
    if (bytes + lineBytes + suffixBytes > REPO_SEARCH_OUTPUT_MAX_BYTES) break
    lines.push(line)
    bytes += lineBytes
  }
  return `${lines.join("\n")}\n${suffixLines.join("\n")}`
}

const renderAnalysisProfile = (profile: RepoIntel.RepoIntelAnalysisProfileState) =>
  `analysisProfile: requested=${profile.requested}; effective=${profile.effective}; ` +
  `configurationSource=${profile.configurationSource}; source=${profile.effectiveSource}; ` +
  `policyLock=${profile.policyLock}; reason=${profile.reason ?? "none"}`

type DeclarationCandidateKind = "function" | "type" | "value"

/**
 * Deliberately narrow lexical declaration candidates for common source forms.
 * These are navigation hints only: comments/macros/generated syntax can still
 * fool a line recognizer, so the caller must preserve PARTIAL/lexical provenance
 * and must never treat these as parser-confirmed symbols or patch authority.
 */
const lexicalDeclarationKind = (line: string, query: string): DeclarationCandidateKind | undefined => {
  const name = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const identifierEnd = `(?![A-Za-z0-9_$])`
  const patterns: readonly [DeclarationCandidateKind, RegExp][] = [
    ["function", new RegExp(`^\\s*(?:(?:export|default|declare|abstract|async|pub|unsafe|extern)\\s+)*(?:function\\*?\\s+${name}${identifierEnd}|fn\\s+${name}${identifierEnd}|(?:async\\s+)?def\\s+${name}${identifierEnd}|func\\s+${name}${identifierEnd})`)],
    ["type", new RegExp(`^\\s*(?:(?:export|default|declare|abstract|pub)\\s+)*(?:class|interface|enum|trait|struct|namespace|type|record)\\s+${name}${identifierEnd}`)],
    ["value", new RegExp(`^\\s*(?:(?:export|declare|pub)\\s+)*(?:const|let|var|static)\\s+${name}${identifierEnd}(?:\\s*[:=;,]|\\s*$)`)],
  ]
  return patterns.find(([, pattern]) => pattern.test(line))?.[0]
}

const boundRepoSearchLines = (lines: ReadonlyArray<string>) => {
  const output = lines.join("\n")
  if (Buffer.byteLength(output, "utf8") <= REPO_SEARCH_OUTPUT_MAX_BYTES) return output
  const marker = "[output truncated at 32 KiB; narrow the query]"
  const kept: string[] = []
  for (const line of lines) {
    if (Buffer.byteLength([...kept, line, marker].join("\n"), "utf8") > REPO_SEARCH_OUTPUT_MAX_BYTES) break
    kept.push(line)
  }
  kept.push(marker)
  return kept.join("\n")
}

const runRepoStructureSearch = (
  client: ReturnType<typeof RepoIntel.repoStructureClientFromSupervisor>,
  params: RepoSearchInput,
  ctx: Tool.Context,
  selector: RepoIntelligenceSchema.RepoStructureQueryV1["selector"] = { symbols: [params.query] },
  profileResolution?: RepoIntel.RepoIntelProfileResolution,
): Effect.Effect<{
  output: string
  count: number
  status: string
  analysisProfile: RepoIntel.RepoIntelAnalysisProfileState
}> =>
  Effect.gen(function* () {
    const analysisProfile = RepoIntel.resolveAnalysisProfile(profileResolution)
    if (
      params.cursor !== undefined &&
      Buffer.byteLength(params.cursor, "utf8") > RepoIntelligenceSchema.MAX_STRUCTURE_CURSOR_BYTES
    ) {
      return {
        output: `${renderAnalysisProfile(analysisProfile)}\nstatus: UNAVAILABLE\nreason: RepoIntel continuation cursor exceeds the byte limit`,
        count: 0,
        status: "UNAVAILABLE",
        analysisProfile,
      }
    }
    const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
    if (Option.isNone(principal)) {
      return {
        output: `${renderAnalysisProfile(analysisProfile)}\nstatus: UNAVAILABLE\nreason: authenticated RepoIntel reads are unavailable in this context`,
        count: 0,
        status: "UNAVAILABLE",
        analysisProfile,
      }
    }
    const instance = yield* InstanceState.context
    const page = yield* client.query({
      sessionID: ctx.sessionID,
      locationRef: LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) }),
      // P6/Core supplies the eventual effective settings projection here. The
      // request seam defaults to the policy-mandated lightweight profile and
      // never exposes a model-controlled profile selector.
      analysisProfile,
      query: {
        schemaVersion: 1,
        messageType: "query",
        queryId: `repo-${randomUUID()}`,
        rootRef: params.path ?? ".",
        selector,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        maxNodes: params.maxResults ?? 50,
        maxBytes: REPO_STRUCTURE_QUERY_MAX_BYTES,
        maxDepth: 16,
        deadline: new Date(Date.now() + 30_000).toISOString(),
      },
    }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value))

    return {
      output: `${renderAnalysisProfile(analysisProfile)}\n${renderStructurePage(page)}`,
      count: page.coverage.nodes,
      status: page.status,
      analysisProfile,
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        output: `${renderAnalysisProfile(RepoIntel.resolveAnalysisProfile(profileResolution))}\nstatus: UNAVAILABLE\nreason: authenticated RepoIntel query failed (${error.code})`,
        count: 0,
        status: "UNAVAILABLE",
        analysisProfile: RepoIntel.resolveAnalysisProfile(profileResolution),
      }),
    ),
  )

const runRepoDefinitionCandidates = (
  supervisor: SessionSupervisor.Interface,
  client: ReturnType<typeof RepoIntel.repoStructureClientFromSupervisor>,
  params: RepoSearchInput,
  ctx: Tool.Context,
  profileResolution?: RepoIntel.RepoIntelProfileResolution,
) => Effect.gen(function* () {
  const profile = RepoIntel.resolveAnalysisProfile(profileResolution)
  const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
  if (Option.isNone(principal) || !supervisor.readRepoDocument) {
    return { output: renderAnalysisProfile(profile) + "\nstatus: UNAVAILABLE\nreason: authenticated source reads are unavailable", count: 0, status: "UNAVAILABLE", analysisProfile: profile }
  }
  const instance = yield* InstanceState.context
  const locationRef = LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) })
  const page = yield* client.query({
    sessionID: ctx.sessionID,
    locationRef,
    analysisProfile: profile,
    query: {
      schemaVersion: 1,
      messageType: "query",
      queryId: `repo-${randomUUID()}`,
      rootRef: params.path ?? ".",
      selector: { symbols: [params.query] },
      maxNodes: 100,
      maxBytes: REPO_STRUCTURE_QUERY_MAX_BYTES,
      maxDepth: 16,
      deadline: new Date(Date.now() + 30_000).toISOString(),
    },
  }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value))

  const header = [
    renderAnalysisProfile(profile),
    `status: ${page.status === "UNAVAILABLE" || page.freshness !== "current" ? "UNAVAILABLE" : "PARTIAL"}`,
    `source: ${page.sourceKind}; freshness: ${page.freshness}; completeness: ${page.completeness}`,
    `sourceGeneration: ${page.sourceGeneration}; sourceRevision: ${page.sourceRevision}`,
    `coverage: ${page.coverage.files} files, ${page.coverage.nodes} lexical hits, ${page.coverage.bytes} bytes`,
    "resultKind: lexical declaration candidates; inspect source before relying on a result",
    "authority: exact-revision HostKernel reads; candidates do not authorize edits",
  ]
  if (page.fallback) header.push(`fallback: ${page.fallback.reason}`)
  if (page.status === "UNAVAILABLE" || page.freshness !== "current" || page.sourceKind === "none") {
    return { output: boundRepoSearchLines(header), count: 0, status: "UNAVAILABLE", analysisProfile: profile }
  }

  const files = new Map<string, RepoIntelligenceSchema.RepoNodeRefV1[]>()
  for (const node of page.nodes) {
    if (node.symbol === params.query) files.set(node.pathRef, [...(files.get(node.pathRef) ?? []), node])
  }
  const selected = [...files.entries()].slice(0, 8)
  let partial = page.status === "PARTIAL" || page.nextCursor !== undefined || files.size > selected.length
  let bytesRead = 0
  const candidates = new Set<string>()
  for (const [pathRef, nodes] of selected) {
    const read = yield* Effect.either(supervisor.readRepoDocument({
      sessionID: ctx.sessionID,
      locationRef,
      request: {
        schemaVersion: 1,
        pathRef,
        revisionKind: "workspace",
        expectedWorkspaceRevision: page.sourceRevision,
        maxBytes: 131_072,
      },
    }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value)))
    if (read._tag === "Left") {
      return { output: boundRepoSearchLines([...header, "status: STALE", "reason: exact-revision source read was rejected"]), count: 0, status: "STALE", analysisProfile: profile }
    }
    const document = read.right
    if (document.revisionKind !== "workspace" || document.observedWorkspaceRevision !== page.sourceRevision ||
      document.contentDigest !== nodes[0]?.fileDigest) {
      return { output: boundRepoSearchLines([...header, "status: STALE", "reason: source digest or revision changed"]), count: 0, status: "STALE", analysisProfile: profile }
    }
    bytesRead += Buffer.byteLength(document.text, "utf8")
    if (bytesRead > 512 * 1024) {
      return { output: boundRepoSearchLines([...header, "status: UNAVAILABLE", "reason: bounded source-read budget exceeded"]), count: 0, status: "UNAVAILABLE", analysisProfile: profile }
    }
    const lines = document.text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const declaration = lexicalDeclarationKind(lines[index]!, params.query)
      if (declaration) candidates.add(`${pathRef}:${index + 1} ${declaration} ${params.query} [file=${document.contentDigest}]`)
    }
  }
  const outputRows = [...candidates].slice(0, params.maxResults ?? 50)
  if (candidates.size > outputRows.length) partial = true
  return {
    output: boundRepoSearchLines([
      ...header,
      `sourceFilesRead: ${selected.length}; sourceBytes: ${bytesRead}`,
      ...(partial ? ["coverageNote: bounded lexical sample; narrow the path or continue the source search"] : []),
      ...(outputRows.length ? outputRows : ["candidates: none found in the bounded authenticated source sample"]),
      ...(page.nextCursor ? [`nextCursor: ${page.nextCursor}`] : []),
    ]),
    count: outputRows.length,
    // This helper intentionally uses a line recognizer rather than a complete
    // language parser, so its coverage is always partial even when every
    // selected file was read successfully.
    status: "PARTIAL",
    analysisProfile: profile,
  }
}).pipe(Effect.catch((error) => Effect.succeed({
  output: renderAnalysisProfile(RepoIntel.resolveAnalysisProfile(profileResolution)) + `\nstatus: UNAVAILABLE\nreason: authenticated RepoIntel candidate lookup failed (${error instanceof Error ? error.message : "unknown"})`,
  count: 0,
  status: "UNAVAILABLE",
  analysisProfile: RepoIntel.resolveAnalysisProfile(profileResolution),
})))

export const SymbolsSearchTool = Tool.define(
  "symbols_search",
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const config = yield* Config.Service
    const structure = RepoIntel.repoStructureClientFromSupervisor(supervisor)

    return {
      description:
        "Search immutable RepoIntel source snapshots for exact textual occurrences. Results are lexical candidates only, not parser-confirmed declarations.",
      parameters: RepoSearchParameters,
      capability: { id: "symbols.search", effectClass: "read_only" },
      execute: (params: RepoSearchInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query, path: params.path },
          })
          const profile = yield* config.getRepoIntelProfile()
          const result = yield* runRepoStructureSearch(structure, params, ctx, undefined, profile)
          return {
            title: `symbols: ${params.query}`,
            metadata: { count: result.count, status: result.status, analysisProfile: result.analysisProfile },
            output: result.output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ReferencesFindTool = Tool.define(
  "references_find",
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const config = yield* Config.Service
    const structure = RepoIntel.repoStructureClientFromSupervisor(supervisor)
    return {
      description:
        "Find exact textual occurrences through authenticated RepoIntel. Results are lexical candidates, not resolved reference edges.",
      parameters: RepoSearchParameters,
      capability: { id: "references.find", effectClass: "read_only" },
      execute: (params: RepoSearchInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query, path: params.path },
          })
          const profile = yield* config.getRepoIntelProfile()
          const result = yield* runRepoStructureSearch(structure, params, ctx, {
            symbols: [params.query],
            includeCallers: true,
          }, profile)
          return {
            title: `references: ${params.query}`,
            metadata: { count: result.count, status: result.status, analysisProfile: result.analysisProfile },
            output: result.output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const DefinitionsFindTool = Tool.define(
  "definitions_find",
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const config = yield* Config.Service
    const structure = RepoIntel.repoStructureClientFromSupervisor(supervisor)
    return {
      description:
        "Find bounded lexical declaration candidates for common source forms. Candidates are not parser-confirmed definitions; inspect the source before relying on them.",
      parameters: RepoSearchParameters,
      capability: { id: "definitions.find", effectClass: "read_only" },
      execute: (params: RepoSearchInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query, path: params.path, operation: "definitions.find" },
          })
          const profile = yield* config.getRepoIntelProfile()
          const result = yield* runRepoDefinitionCandidates(supervisor, structure, params, ctx, profile)
          return {
            title: `definitions: ${params.query}`,
            metadata: { count: result.count, status: result.status, analysisProfile: result.analysisProfile },
            output: result.output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
