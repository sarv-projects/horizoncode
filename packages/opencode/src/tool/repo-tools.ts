import path from "path"
import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location as LocationSchema } from "@opencode-ai/schema"
import * as RepoIntelligenceSchema from "@opencode-ai/schema/repo-intelligence-v1"
import { assertExternalDirectoryEffect } from "./external-directory"
import { RepoIntel } from "./repo-intel"
import * as Tool from "./tool"

const REPO_TREE_ENTRY_LIMIT = 500
const REPO_SEARCH_OUTPUT_MAX_BYTES = 32 * 1024
const REPO_SEARCH_OUTPUT_TRUNCATION = "[output truncated at 32 KiB; narrow the query or continue with nextCursor]"

const RepoTreeParameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to inspect, relative to the project root. Omit to inspect the project root.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Maximum directory depth to list (1-4, default 2).",
  }),
})

export const RepoTreeTool = Tool.define(
  "repo_tree",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description:
        "Bounded repository structure overview: lists directories and files under a path up to a small depth. Read-only; `.git` and `node_modules` are skipped and symlinks are not followed.",
      parameters: RepoTreeParameters,
      capability: { id: "repo.tree", effectClass: "read_only" },
      execute: (params: { path?: string; depth?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.path ?? "*"],
            always: ["*"],
            metadata: { path: params.path, depth: params.depth },
          })

          const requested = params.path ?? ins.directory
          const root = path.isAbsolute(requested) ? requested : path.resolve(ins.directory, requested)
          yield* assertExternalDirectoryEffect(ctx, root, { bypass: false, kind: "directory" })

          const depth = Math.min(Math.max(Math.trunc(params.depth ?? 2) || 2, 1), 4)
          const ignored = new Set([".git", "node_modules"])
          const lines: string[] = []
          let truncated = false

          const walk = (dir: string, level: number): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (level > depth || truncated) return
              const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
              for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
                if (truncated || ignored.has(entry.name)) continue
                if (entry.type === "symlink" || entry.type === "other") continue
                if (lines.length >= REPO_TREE_ENTRY_LIMIT) {
                  truncated = true
                  return
                }
                lines.push(`${"  ".repeat(level - 1)}${entry.name}${entry.type === "directory" ? "/" : ""}`)
                if (entry.type === "directory") yield* walk(path.join(dir, entry.name), level + 1)
              }
            })

          yield* walk(root, 1)

          const output: string[] = []
          if (lines.length === 0) output.push("No entries found")
          if (lines.length > 0) output.push(...lines)
          if (truncated) {
            output.push("")
            output.push(
              `(Results are truncated: showing first ${REPO_TREE_ENTRY_LIMIT} entries. Narrow the path or lower depth.)`,
            )
          }

          return {
            title: path.relative(ins.worktree, root) || ".",
            metadata: { count: lines.length, truncated, depth },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const RepoSearchParameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Single-line symbol name or prefix to look for." }),
  path: Schema.optional(Schema.String).annotate({
    description: "Subdirectory relative to the project root. Omit to search the whole project.",
  }),
  maxResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
    description: "Maximum results (1-100, default 50).",
  }),
  cursor: Schema.optional(Schema.String).annotate({ description: "Opaque cursor returned by a previous reply." }),
})

type RepoSearchInput = { query: string; path?: string; maxResults?: number; cursor?: string }

const REPO_STRUCTURE_QUERY_MAX_BYTES = 262_144

const renderStructurePage = (page: RepoIntelligenceSchema.RepoStructurePageV1) => {
  const header = [
    `status: ${page.status}`,
    `freshness: ${page.freshness}`,
    `source: ${page.sourceKind}; coverage: ${page.coverage.files} files, ${page.coverage.nodes} nodes, ${page.coverage.bytes} bytes`,
  ]
  if (page.fallback) header.push(`fallback: ${page.fallback.reason}`)
  const nodes = page.nodes.map(
    (node) => `${node.pathRef}:${node.byteRange.start}-${node.byteRange.end} symbol: ${node.symbol} (${node.nodeKind})`,
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

const runRepoStructureSearch = (
  client: ReturnType<typeof RepoIntel.repoStructureClientFromSupervisor>,
  params: RepoSearchInput,
  ctx: Tool.Context,
): Effect.Effect<{ output: string; count: number; status: string }> =>
  Effect.gen(function* () {
    const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
    if (Option.isNone(principal)) {
      return {
        output: "status: UNAVAILABLE\nreason: authenticated RepoIntel reads are unavailable in this context",
        count: 0,
        status: "UNAVAILABLE",
      }
    }
    const instance = yield* InstanceState.context
    const page = yield* client.query({
      sessionID: ctx.sessionID,
      locationRef: LocationSchema.Ref.make({ directory: AbsolutePath.make(instance.directory) }),
      query: {
        schemaVersion: 1,
        messageType: "query",
        queryId: `repo-${randomUUID()}`,
        rootRef: params.path ?? ".",
        selector: { symbols: [params.query] },
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        maxNodes: params.maxResults ?? 50,
        maxBytes: REPO_STRUCTURE_QUERY_MAX_BYTES,
        maxDepth: 16,
        deadline: new Date(Date.now() + 30_000).toISOString(),
      },
    }).pipe(Effect.provideService(TrustedPrincipalContext, principal.value))

    return { output: renderStructurePage(page), count: page.coverage.nodes, status: page.status }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        output: `status: UNAVAILABLE\nreason: authenticated RepoIntel query failed (${error.code})`,
        count: 0,
        status: "UNAVAILABLE",
      }),
    ),
  )

export const SymbolsSearchTool = Tool.define(
  "symbols_search",
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const structure = RepoIntel.repoStructureClientFromSupervisor(supervisor)

    return {
      description:
        "Search declared symbols by exact name or prefix. Read-only advisory: on backends without symbol support the result is an explicit UNAVAILABLE status — nothing is guessed.",
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
          const result = yield* runRepoStructureSearch(structure, params, ctx)
          return {
            title: `symbols: ${params.query}`,
            metadata: { count: result.count, status: result.status },
            output: result.output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ReferencesFindTool = Tool.define(
  "references_find",
  Effect.succeed({
      description:
        "Find references to a symbol by exact name or prefix. This read-only route stays unavailable until an authenticated HostKernel reference query is supported.",
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
          return {
            title: `references: ${params.query}`,
            metadata: { count: 0, status: "UNAVAILABLE" },
            output: "status: UNAVAILABLE\nreason: authenticated HostKernel reference queries are not supported",
          }
        }).pipe(Effect.orDie),
  }),
)
