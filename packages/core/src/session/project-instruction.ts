/**
 * §29.23 project instruction resolver.
 *
 * Pure, deterministic planning over already-discovered instruction files. It
 * performs no filesystem access, network fetch, workspace widening or approval.
 * The caller (Core ContextService / OpenCode Instruction service) supplies exact
 * file candidates with content digests read under the existing workspace read
 * policy. Ancestor files load at session start; subdirectory files load on demand
 * and enter only the next context compile. External imports require explicit
 * approval and are never partially loaded.
 */
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { ContextLedgerEntryV2 } from "@opencode-ai/schema/context-ledger-v2"
import { ContextSelectionSourceV1 as ContextSelectionSourceSchema } from "@opencode-ai/schema/context-selection-v1"
import { canonicalProviderInputJson } from "./context-selection"

type ContextSelectionSourceV1 = typeof ContextSelectionSourceSchema.Type

export type ProjectInstructionModeV1 = "prefer_agents_md" | "prefer_claude_md" | "merge_both" | "config_only"

export type ProjectInstructionResolverV1 = {
  readonly mode: ProjectInstructionModeV1
  readonly maxCompiledBytes: number
  readonly maxAncestorFiles: number
  readonly excludeGlobs: ReadonlyArray<string>
  readonly onDemandSubdir: boolean
}

export const DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1: ProjectInstructionResolverV1 = Object.freeze({
  mode: "prefer_agents_md",
  maxCompiledBytes: 131_072,
  maxAncestorFiles: 32,
  excludeGlobs: Object.freeze(["node_modules/", ".git/", "vendor/", "repo_take/", "dist/", "build/", "target/"]),
  onDemandSubdir: true,
})

const MAX_COMPILED_BYTES = 1_048_576
const MAX_FILES = 64
const MAX_EXCLUDE_GLOBS = 64
const MAX_EXCLUDE_BYTES = 512
const MAX_IMPORT_DEPTH = 8
const MAX_IMPORTED_FILES = 32
const MAX_IMPORTS_PER_FILE = 32
const MAX_PATH_BYTES = 4096
const DIGEST_PATTERN = /^blake3:[0-9a-f]{64}$/
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/

const contentDigest = (content: string): string =>
  `blake3:${bytesToHex(blake3(new TextEncoder().encode(content)))}`

const hasMatchingContentDigest = (file: ProjectInstructionFileV1): boolean =>
  DIGEST_PATTERN.test(file.digest) && file.digest === contentDigest(file.content)

const hasSafeDisplayPath = (file: ProjectInstructionFileV1): boolean =>
  file.displayPath === undefined ||
  (file.displayPath.length > 0 &&
    Buffer.byteLength(file.displayPath, "utf8") <= MAX_PATH_BYTES &&
    !CONTROL_OR_BIDI.test(file.displayPath))

export type InstructionFileKindV1 = "agents" | "claude" | "claude_local" | "config" | "import"
export type InstructionFileScopeV1 = "global" | "user" | "project" | "subdirectory"

export type ProjectInstructionFileV1 = {
  /** Absolute path used only for local identity; never rendered into the prompt. */
  readonly filepath: string
  /** Workspace-relative display/selection reference. */
  readonly relativePath: string
  /** Optional absolute display label for the prompt; defaults to relativePath. */
  readonly displayPath?: string
  readonly kind: InstructionFileKindV1
  readonly scope: InstructionFileScopeV1
  readonly digest: string
  readonly content: string
}

export type LoadedProjectInstructionRefV1 = {
  readonly relativePath: string
  readonly digest: string
}

export type ExcludedInstructionFileV1 = {
  readonly relativePath: string
  readonly reason: "exclude_glob" | "outside_workspace" | "invalid_path" | "digest_mismatch" | "ancestor_limit" | "config_only"
}

export type BlockedInstructionImportV1 = {
  readonly from: string
  readonly target: string
  readonly reason: "outside_workspace_requires_approval" | "missing" | "invalid" | "cycle" | "depth_limit" | "import_limit"
}

export type ResolveProjectInstructionFilesInputV1 = {
  readonly workspaceRoot: string
  readonly cwd: string
  readonly resolver?: Partial<ProjectInstructionResolverV1>
  readonly configGlobs?: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<ProjectInstructionFileV1>
  /** First on-demand workspace path touched by a Guarded operation in this turn. */
  readonly targetPath?: string
  /** Exact path+digest identities already loaded by an earlier compile. */
  readonly alreadyLoaded?: ReadonlyArray<LoadedProjectInstructionRefV1>
  /** Exact normalized absolute paths the user approved for external imports. */
  readonly approvedExternalImports?: ReadonlyArray<string>
  /** Candidates available for `@import` resolution (same read authority). */
  readonly importCandidates?: ReadonlyArray<ProjectInstructionFileV1>
}

export type ResolvedProjectInstructionSliceV1 = {
  readonly file: ProjectInstructionFileV1
  /** True when the slice enters at the next compile rather than this turn's ancestor set. */
  readonly onDemand: boolean
}

export type ResolveProjectInstructionFilesResultV1 = {
  readonly resolver: ProjectInstructionResolverV1
  readonly ancestor: ReadonlyArray<ResolvedProjectInstructionSliceV1>
  readonly onDemand: ReadonlyArray<ResolvedProjectInstructionSliceV1>
  readonly excluded: ReadonlyArray<ExcludedInstructionFileV1>
  readonly blockedImports: ReadonlyArray<BlockedInstructionImportV1>
}

const normalizeAbsolute = (value: string): string | undefined => {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return undefined
  if (CONTROL_OR_BIDI.test(value)) return undefined
  const slashed = value.replace(/\\/gu, "/")
  const absolute = slashed.startsWith("/") ? slashed : `/${slashed}`
  const parts: string[] = []
  for (const part of absolute.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") return undefined
    parts.push(part)
  }
  return `/${parts.join("/")}`
}

const relativeTo = (root: string, target: string): string | undefined => {
  if (target === root) return ""
  const prefix = root.endsWith("/") ? root : `${root}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : undefined
}

const parentDirectory = (value: string): string => {
  const index = value.lastIndexOf("/")
  return index <= 0 ? "/" : value.slice(0, index)
}

/** Lexically resolve `target` against an absolute base for @import; rejects root escape. */
const resolveImportPath = (base: string, target: string): string | undefined => {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(target)) return normalizeAbsolute(target)
  const parts: string[] = []
  for (const part of `${base}/${target.replace(/\\/gu, "/")}`.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** Glob -> anchored regex. Supports `*`, `**`, `?`, and directory-suffix patterns. */
const globToRegExp = (glob: string): RegExp | undefined => {
  if (glob.length === 0 || Buffer.byteLength(glob, "utf8") > MAX_EXCLUDE_BYTES) return undefined
  if (CONTROL_OR_BIDI.test(glob)) return undefined
  const normalized = glob.replace(/\\/gu, "/").replace(/^\.\//u, "")
  const directoryOnly = normalized.endsWith("/")
  const body = directoryOnly ? normalized.slice(0, -1) : normalized
  if (body.length === 0) return undefined
  let pattern = ""
  for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!
      if (char === "*") {
        if (body[index + 1] === "*") {
          if (body[index + 2] === "/") {
            // A globstar directory prefix also matches zero directories:
            // `**/AGENTS.md` covers both `AGENTS.md` and nested copies.
            pattern += "(?:.*/)?"
            index += 2
          } else {
            pattern += ".*"
            index += 1
          }
        } else {
          pattern += "[^/]*"
        }
    } else if (char === "?") {
      pattern += "[^/]"
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    }
  }
  // A bare directory name matches that segment anywhere; a path pattern is relative to the root.
  if (!body.includes("/")) return new RegExp(`(?:^|/)${pattern}(?:/|$)`, "u")
  return new RegExp(`^${pattern}${directoryOnly ? "(?:/|$)" : "$"}`, "u")
}

/** Public helper for adapters that already discovered a candidate path. */
export function isExcludedProjectInstructionPathV1(
  relativePath: string,
  excludeGlobs: ReadonlyArray<string> = DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.excludeGlobs,
): boolean {
  const patterns = excludeGlobs.map(globToRegExp)
  if (patterns.some((pattern) => pattern === undefined)) {
    throw new TypeError("excludeGlobs contains an invalid pattern")
  }
  if (relativePath.length === 0 || relativePath.startsWith("/") || CONTROL_OR_BIDI.test(relativePath)) return true
  if (relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return true
  return patterns.some((pattern) => pattern!.test(relativePath.replace(/\\/gu, "/")))
}

const mergeResolver = (resolver?: Partial<ProjectInstructionResolverV1>): ProjectInstructionResolverV1 => {
  const merged: ProjectInstructionResolverV1 = {
    mode: resolver?.mode ?? DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.mode,
    maxCompiledBytes: resolver?.maxCompiledBytes ?? DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.maxCompiledBytes,
    maxAncestorFiles: resolver?.maxAncestorFiles ?? DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.maxAncestorFiles,
    excludeGlobs: resolver?.excludeGlobs ?? DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.excludeGlobs,
    onDemandSubdir: resolver?.onDemandSubdir ?? DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.onDemandSubdir,
  }
  if (merged.mode !== "prefer_agents_md" && merged.mode !== "prefer_claude_md" && merged.mode !== "merge_both" && merged.mode !== "config_only") {
    throw new TypeError("project instruction mode is invalid")
  }
  if (!Number.isSafeInteger(merged.maxCompiledBytes) || merged.maxCompiledBytes < 1 || merged.maxCompiledBytes > MAX_COMPILED_BYTES) {
    throw new RangeError("maxCompiledBytes is outside its bound")
  }
  if (!Number.isSafeInteger(merged.maxAncestorFiles) || merged.maxAncestorFiles < 0 || merged.maxAncestorFiles > MAX_FILES) {
    throw new RangeError("maxAncestorFiles is outside its bound")
  }
  if (merged.excludeGlobs.length > MAX_EXCLUDE_GLOBS) throw new RangeError("excludeGlobs exceeds its bound")
  if (merged.excludeGlobs.some((glob) => globToRegExp(glob) === undefined)) {
    throw new TypeError("excludeGlobs contains an invalid pattern")
  }
  return merged
}

const kindOrder = (kind: InstructionFileKindV1): number =>
  kind === "agents" ? 0 : kind === "claude" ? 1 : kind === "claude_local" ? 2 : kind === "config" ? 3 : 4

const loadedInstructionKey = (relativePath: string, digest: string): string =>
  JSON.stringify([relativePath.replace(/\\/gu, "/").replace(/^\.\//u, ""), digest])

const selectKind = (
  mode: ProjectInstructionModeV1,
  files: ReadonlyArray<ProjectInstructionFileV1>,
): ReadonlyArray<ProjectInstructionFileV1> => {
  if (mode === "config_only") return []
  const agents = files.filter((file) => file.kind === "agents")
  const claude = files.filter((file) => file.kind === "claude" || file.kind === "claude_local").sort((left, right) => kindOrder(left.kind) - kindOrder(right.kind))
  if (mode === "prefer_agents_md") return agents.length > 0 ? agents : claude
  if (mode === "prefer_claude_md") return claude.length > 0 ? claude : agents
  return [...agents, ...claude]
}

const parseImports = (content: string): ReadonlyArray<string> => {
  const targets: string[] = []
  for (const line of content.split(/\r?\n/gu)) {
    const match = /^\s*@([^\s]+)\s*$/u.exec(line)
    if (match?.[1]) targets.push(match[1])
  }
  // Keep one overflow target so the caller can report that the bounded scan
  // omitted imports instead of making the compiled provenance look complete.
  return targets.slice(0, MAX_IMPORTS_PER_FILE + 1)
}

/**
 * Resolve the exact ancestor and on-demand instruction set. Session start loads
 * only root→cwd ancestors (CX-022); a Guarded operation under a deeper directory
 * loads at most one file per newly touched ancestor directory (CX-023).
 */
export function resolveProjectInstructionFilesV1(
  input: ResolveProjectInstructionFilesInputV1,
): ResolveProjectInstructionFilesResultV1 {
  const resolver = mergeResolver(input.resolver)
  const root = normalizeAbsolute(input.workspaceRoot)
  const cwd = normalizeAbsolute(input.cwd)
  if (root === undefined) throw new TypeError("workspaceRoot is not a normalized absolute path")
  if (cwd === undefined) throw new TypeError("cwd is not a normalized absolute path")
  const cwdRelative = relativeTo(root, cwd)
  if (cwdRelative === undefined) throw new TypeError("cwd is outside the workspace root")
  if (input.candidates.length > MAX_FILES * 4) throw new RangeError("instruction candidates exceed their bound")
  if ((input.importCandidates?.length ?? 0) > MAX_FILES * 4) {
    throw new RangeError("instruction import candidates exceed their bound")
  }
  if ((input.approvedExternalImports?.length ?? 0) > MAX_FILES * 4) {
    throw new RangeError("approved external imports exceed their bound")
  }
  if ((input.alreadyLoaded?.length ?? 0) > MAX_FILES * 4) {
    throw new RangeError("already-loaded instruction identities exceed their bound")
  }
  if ((input.configGlobs?.length ?? 0) > MAX_EXCLUDE_GLOBS) {
    throw new RangeError("configGlobs exceeds its bound")
  }
  const configPatterns = (input.configGlobs ?? []).map(globToRegExp)
  if (configPatterns.some((pattern) => pattern === undefined)) {
    throw new TypeError("configGlobs contains an invalid pattern")
  }

  const exclude = resolver.excludeGlobs.flatMap((glob) => {
    const pattern = globToRegExp(glob)
    return pattern ? [pattern] : []
  })
  const excluded: ExcludedInstructionFileV1[] = []
  const already = new Set((input.alreadyLoaded ?? []).map((item) => loadedInstructionKey(item.relativePath, item.digest)))
  const accepted: ProjectInstructionFileV1[] = []
  for (const candidate of input.candidates) {
    if (already.has(loadedInstructionKey(candidate.relativePath, candidate.digest))) continue
    const absolute = normalizeAbsolute(candidate.filepath)
    if (absolute === undefined) {
      excluded.push({ relativePath: candidate.relativePath, reason: "invalid_path" })
      continue
    }
    const personal = candidate.scope === "global" || candidate.scope === "user"
    if (!personal) {
      const workspaceRelativePath = relativeTo(root, absolute)
      if (workspaceRelativePath === undefined) {
        excluded.push({ relativePath: candidate.relativePath, reason: "outside_workspace" })
        continue
      }
      if (workspaceRelativePath !== candidate.relativePath) {
        excluded.push({ relativePath: candidate.relativePath, reason: "invalid_path" })
        continue
      }
    }
    if (
      candidate.relativePath.length === 0 ||
      candidate.relativePath.startsWith("/") ||
      candidate.relativePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
      CONTROL_OR_BIDI.test(candidate.relativePath) ||
      Buffer.byteLength(candidate.relativePath, "utf8") > MAX_PATH_BYTES
    ) {
      excluded.push({ relativePath: candidate.relativePath, reason: "invalid_path" })
      continue
    }
    if (!hasSafeDisplayPath(candidate)) {
      excluded.push({ relativePath: candidate.relativePath, reason: "invalid_path" })
      continue
    }
    if (!DIGEST_PATTERN.test(candidate.digest)) {
      excluded.push({ relativePath: candidate.relativePath, reason: "invalid_path" })
      continue
    }
    if (!hasMatchingContentDigest(candidate)) {
      excluded.push({ relativePath: candidate.relativePath, reason: "digest_mismatch" })
      continue
    }
    if (exclude.some((pattern) => pattern.test(candidate.relativePath))) {
      excluded.push({ relativePath: candidate.relativePath, reason: "exclude_glob" })
      continue
    }
    accepted.push(candidate)
  }
  const acceptedPaths = new Set<string>()
  for (const candidate of accepted) {
    if (acceptedPaths.has(candidate.relativePath)) {
      throw new TypeError("instruction candidate relative paths must be unique")
    }
    acceptedPaths.add(candidate.relativePath)
  }

  // Global/user scopes load first, then root→cwd project ancestors. `config_only`
  // intentionally ignores both and keeps only explicit config globs (INST-005).
  const ancestor: ResolvedProjectInstructionSliceV1[] = []
  const ancestorSet = new Set<string>()
  const ancestorLimitExcluded = new Map<string, string>()
  const addAncestor = (file: ProjectInstructionFileV1) => {
    if (ancestorSet.has(file.filepath)) return
    if (ancestor.length >= resolver.maxAncestorFiles) {
      ancestorLimitExcluded.set(file.filepath, file.relativePath)
      return
    }
    ancestorSet.add(file.filepath)
    ancestor.push({ file, onDemand: false })
  }
  if (resolver.mode !== "config_only") {
    for (const scope of ["global", "user"] as const) {
      for (const file of accepted.filter((item) => item.scope === scope).sort((left, right) => kindOrder(left.kind) - kindOrder(right.kind))) {
        addAncestor(file)
      }
    }
  }
  // Ancestor chain of cwd, root first. Never include sibling packages.
  const ancestorDirectories: string[] = []
  {
    const parts = cwdRelative === "" ? [] : cwdRelative.split("/")
    ancestorDirectories.push("")
    for (let index = 0; index < parts.length; index += 1) ancestorDirectories.push(parts.slice(0, index + 1).join("/"))
  }
  for (const directory of ancestorDirectories) {
    const inDirectory = accepted.filter((file) => {
      const relativeDirectory = file.relativePath.includes("/") ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/")) : ""
      return relativeDirectory === directory && (file.kind === "agents" || file.kind === "claude" || file.kind === "claude_local")
    })
    for (const file of selectKind(resolver.mode, inDirectory)) addAncestor(file)
  }
  // Explicit `instructions[]` config globs are always included after project
  // slices in every mode except config_only, where they are the only source.
  for (const file of accepted) {
    if (file.kind === "config" && configPatterns.some((pattern) => pattern!.test(file.relativePath))) {
      addAncestor(file)
    }
  }
  for (const relativePath of ancestorLimitExcluded.values()) {
    excluded.push({ relativePath, reason: "ancestor_limit" })
  }

  const onDemand: ResolvedProjectInstructionSliceV1[] = []
  const blockedImports: BlockedInstructionImportV1[] = []
  if (resolver.onDemandSubdir && input.targetPath !== undefined) {
    const target = normalizeAbsolute(input.targetPath)
    const targetRelative = target === undefined ? undefined : relativeTo(root, target)
    if (target === undefined || targetRelative === undefined) {
      excluded.push({ relativePath: input.targetPath, reason: "outside_workspace" })
    } else {
      const targetDirectory = targetRelative.includes("/") ? targetRelative.slice(0, targetRelative.lastIndexOf("/")) : ""
      if (targetDirectory !== "") {
        const parts = targetDirectory.split("/")
        let current = ""
        const ancestorSetPaths = new Set(ancestor.map((slice) => slice.file.relativePath))
        for (const part of parts) {
          current = current === "" ? part : `${current}/${part}`
          const inDirectory = accepted.filter((file) => {
            const relativeDirectory = file.relativePath.includes("/") ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/")) : ""
            return relativeDirectory === current && (file.kind === "agents" || file.kind === "claude" || file.kind === "claude_local")
          })
          for (const file of selectKind(resolver.mode, inDirectory)) {
            if (ancestorSetPaths.has(file.relativePath)) continue
            if (onDemand.some((slice) => slice.file.relativePath === file.relativePath)) continue
            onDemand.push({ file, onDemand: true })
            break
          }
        }
      }
    }
  }

  // Explicit imports: inside-workspace files load through the same read authority;
  // outside/absolute imports require a recorded user approval and are otherwise blocked.
  const importsByPath = new Map<string, ProjectInstructionFileV1>()
  for (const candidate of input.importCandidates ?? []) importsByPath.set(candidate.relativePath, candidate)
  const expanded: ResolvedProjectInstructionSliceV1[] = []
  const visitedImports = new Set<string>()
  const loadedPaths = new Set(
    [...ancestor, ...onDemand]
      .map((slice) => normalizeAbsolute(slice.file.filepath))
      .filter((item): item is string => item !== undefined),
  )
  const approved = new Set(
    (input.approvedExternalImports ?? [])
      .filter((item) => item.startsWith("/"))
      .map((item) => normalizeAbsolute(item))
      .filter((item): item is string => item !== undefined),
  )
  const expand = (slice: ResolvedProjectInstructionSliceV1, depth: number, stack: ReadonlySet<string>) => {
    expanded.push(slice)
    if (depth >= MAX_IMPORT_DEPTH) {
      for (const target of parseImports(slice.file.content)) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "depth_limit" })
      }
      return
    }
    for (const [index, target] of parseImports(slice.file.content).entries()) {
      if (index >= MAX_IMPORTS_PER_FILE) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "import_limit" })
        continue
      }
      if (expanded.length >= MAX_FILES * 2) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "import_limit" })
        continue
      }
      const absolute = target.startsWith("/")
        ? normalizeAbsolute(target)
        : resolveImportPath(parentDirectory(normalizeAbsolute(slice.file.filepath) ?? "/"), target)
      if (absolute === undefined) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "invalid" })
        continue
      }
      const relative = relativeTo(root, absolute)
      if (relative === undefined) {
        if (!approved.has(absolute)) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "outside_workspace_requires_approval" })
          continue
        }
        const external = importsByPath.get(target) ?? importsByPath.get(absolute)
        if (!external) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "missing" })
          continue
        }
        if (normalizeAbsolute(external.filepath) !== absolute) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "invalid" })
          continue
        }
        if (!hasSafeDisplayPath(external) || !hasMatchingContentDigest(external)) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "invalid" })
          continue
        }
        if (stack.has(absolute)) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "cycle" })
          continue
        }
        if (loadedPaths.has(absolute)) continue
        if (visitedImports.has(absolute)) continue
        if (visitedImports.size >= MAX_IMPORTED_FILES) {
          blockedImports.push({ from: slice.file.relativePath, target, reason: "import_limit" })
          continue
        }
        visitedImports.add(absolute)
        expand({ file: { ...external, kind: "import", scope: "project" }, onDemand: slice.onDemand }, depth + 1, new Set([...stack, absolute]))
        continue
      }
      const imported = importsByPath.get(relative)
      if (!imported) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "missing" })
        continue
      }
      if (normalizeAbsolute(imported.filepath) !== absolute) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "invalid" })
        continue
      }
      if (!hasSafeDisplayPath(imported) || !hasMatchingContentDigest(imported)) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "invalid" })
        continue
      }
      if (stack.has(absolute)) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "cycle" })
        continue
      }
      if (loadedPaths.has(absolute)) continue
      if (visitedImports.has(absolute)) continue
      if (visitedImports.size >= MAX_IMPORTED_FILES) {
        blockedImports.push({ from: slice.file.relativePath, target, reason: "import_limit" })
        continue
      }
      visitedImports.add(absolute)
      expand({ file: { ...imported, kind: "import", scope: "project" }, onDemand: slice.onDemand }, depth + 1, new Set([...stack, absolute]))
    }
  }
  for (const slice of [...ancestor, ...onDemand]) expand(slice, 0, new Set([normalizeAbsolute(slice.file.filepath) ?? ""]))

  return {
    resolver,
    ancestor: expanded.filter((slice) => !slice.onDemand),
    onDemand: expanded.filter((slice) => slice.onDemand),
    excluded,
    blockedImports,
  }
}

export type CompiledProjectInstructionsV1 = {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
  /** Explicit ledger marker; always present when truncated. */
  readonly marker?: string
  readonly digest: string
  readonly included: ReadonlyArray<{
    readonly relativePath: string
    readonly digest: string
    readonly bytes: number
    readonly truncated: boolean
    readonly onDemand: boolean
  }>
}

/**
 * Compile a bounded prompt slice. Over-budget output keeps a head and a tail and
 * records an explicit marker; it never silently truncates (INST-003).
 */
export function compileProjectInstructionsV1(input: {
  readonly blueprint: ResolveProjectInstructionFilesResultV1
  readonly maxCompiledBytes?: number
}): CompiledProjectInstructionsV1 {
  const maxBytes = input.maxCompiledBytes ?? input.blueprint.resolver.maxCompiledBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_COMPILED_BYTES) {
    throw new RangeError("compiled instruction budget is outside its bound")
  }
  const slices = [...input.blueprint.ancestor, ...input.blueprint.onDemand]
  const encoder = new TextEncoder()
  const header = (path: string) => `Instructions from: ${path}\n`
  const label = (file: ProjectInstructionFileV1) => file.displayPath ?? file.relativePath
  const rendered = slices.map((slice) => ({
    slice,
    header: header(label(slice.file)),
    body: slice.file.content,
    bytes: encoder.encode(`${header(label(slice.file))}${slice.file.content}`).byteLength,
  }))

  const markerFor = (omitted: number, files: number) =>
    `[project instructions truncated: ${omitted} bytes across ${files} file(s) omitted; re-read specific files on demand]`

  const exactText = rendered.map((item) => `${item.header}${item.body}`).join("\n\n")
  const exactBytes = encoder.encode(exactText).byteLength
  if (exactBytes <= maxBytes) {
    return {
      text: exactText,
      bytes: exactBytes,
      truncated: false,
      digest: instructionCompilationDigestV1(input.blueprint, false, exactText),
      included: rendered.map((item) => ({
        relativePath: item.slice.file.relativePath,
        digest: item.slice.file.digest,
        bytes: item.bytes,
        truncated: false,
        onDemand: item.slice.onDemand,
      })),
    }
  }
  const total = exactBytes

  // Reserve the largest plausible marker. Sample the head until half the budget,
  // then the tail until the remainder; the middle is explicitly omitted.
  const marker = markerFor(total, rendered.length)
  // Very small caller budgets cannot fit the full diagnostic marker. Since its
  // vocabulary is ASCII, a character prefix is also an exact UTF-8 byte prefix.
  const markerPrefix = marker.slice(0, maxBytes)
  const markerBytes = encoder.encode(`${markerPrefix}\n\n`).byteLength
  const budget = Math.max(0, maxBytes - markerBytes)
  const headBudget = Math.floor(budget / 2)
  const head: typeof rendered = []
  let headBytes = 0
  for (const item of rendered) {
    const nextBytes = headBytes + item.bytes + (head.length > 0 ? 2 : 0)
    if (nextBytes > headBudget) break
    head.push(item)
    headBytes = nextBytes
  }
  const tail: typeof rendered = []
  let tailBytes = 0
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index]!
    if (head.some((entry) => entry.slice.file.filepath === item.slice.file.filepath)) break
    const nextBytes = tailBytes + item.bytes + (tail.length > 0 ? 2 : 0)
    if (nextBytes > budget - headBytes) break
    tail.unshift(item)
    tailBytes = nextBytes
  }
  const omittedBytes = total - headBytes - tailBytes
  const omittedFiles = rendered.length - head.length - tail.length
  const finalMarker = markerFor(Math.max(0, omittedBytes), Math.max(0, omittedFiles)).slice(0, maxBytes)
  const text = [
    ...head.map((item) => `${item.header}${item.body}`),
    finalMarker,
    ...tail.map((item) => `${item.header}${item.body}`),
  ].join("\n\n")
  const encoded = encoder.encode(text)
  const included = [...head, ...tail].map((item) => ({
    relativePath: item.slice.file.relativePath,
    digest: item.slice.file.digest,
    bytes: item.bytes,
    // Whole files enter the sample; the omission marker is the truncation evidence.
    truncated: false,
    onDemand: item.slice.onDemand,
  }))
  return {
    text,
    bytes: encoded.byteLength,
    truncated: true,
    marker: finalMarker,
    digest: instructionCompilationDigestV1(input.blueprint, true, text),
    included,
  }
}

function instructionCompilationDigestV1(
  blueprint: ResolveProjectInstructionFilesResultV1,
  truncated: boolean,
  text: string,
): string {
  const canonical = canonicalProviderInputJson({
    mode: blueprint.resolver.mode,
    files: [...blueprint.ancestor, ...blueprint.onDemand].map((slice) => ({
      path: slice.file.relativePath,
      digest: slice.file.digest,
      onDemand: slice.onDemand,
    })),
    blockedImports: blueprint.blockedImports,
    truncated,
    text,
  })
  return `blake3:${bytesToHex(blake3(new TextEncoder().encode(`horizon.project-instruction.v1\0${canonical}`)))}`
}

/** Stable source identity for one instruction file (wire IDs cannot contain `/`). */
export function projectInstructionSourceIDV1(relativePath: string): string {
  return `ins_${bytesToHex(blake3(new TextEncoder().encode(relativePath))).slice(0, 32)}`
}

/** Exact ContextSelection sources for the compiled instruction set. */
export function projectInstructionSelectionSourcesV1(
  blueprint: ResolveProjectInstructionFilesResultV1,
): ReadonlyArray<ContextSelectionSourceV1> {
  const seen = new Set<string>()
  const sources: ContextSelectionSourceV1[] = []
  for (const slice of [...blueprint.ancestor, ...blueprint.onDemand]) {
    const sourceID = projectInstructionSourceIDV1(slice.file.relativePath)
    if (seen.has(sourceID)) continue
    seen.add(sourceID)
    if (!SOURCE_ID.test(sourceID) || !DIGEST_PATTERN.test(slice.file.digest)) {
      throw new TypeError("project instruction source identity is invalid")
    }
    sources.push({
      kind: "instruction",
      sourceID,
      sourceRevision: slice.file.digest,
      contentDigest: slice.file.digest,
      sourceAuthority: "instruction-resolver",
      trust: slice.file.scope === "global" || slice.file.scope === "user" ? "user" : "workspace",
      included: true,
      inclusionReason: "instruction",
    })
  }
  return sources
}

/** Ledger entries carrying `project_instruction` provenance and exact bytes. */
export function projectInstructionLedgerEntriesV1(input: {
  readonly blueprint: ResolveProjectInstructionFilesResultV1
  readonly compiled: CompiledProjectInstructionsV1
}): ReadonlyArray<ContextLedgerEntryV2> {
  const sources = projectInstructionSelectionSourcesV1(input.blueprint)
  const byPath = new Map<string, (typeof sources)[number]>()
  const slices = [...input.blueprint.ancestor, ...input.blueprint.onDemand]
  for (const slice of slices) {
    const source = sources.find((item) => item.sourceID === projectInstructionSourceIDV1(slice.file.relativePath))
    if (source) byPath.set(slice.file.relativePath, source)
  }
  return input.compiled.included.flatMap((included) => {
    const slice = slices.find((item) => item.file.relativePath === included.relativePath)
    const source = byPath.get(included.relativePath)
    if (!slice || !source) return []
    return [{
      entryID: `project-instruction:${source.sourceID}`,
      kind: "system" as const,
      sourceRef: `instruction:${source.sourceID}`,
      sourceRevision: slice.file.digest,
      trust: source.trust,
      bytes: Buffer.byteLength(slice.file.content, "utf8"),
      bytesKind: "exact" as const,
      tokens: { kind: "unknown" as const },
      included: true,
      inclusionReason: "project_instruction",
      protected: false,
      cacheClass: "static" as const,
      freshness: included.truncated ? "sampled" : "current",
      digest: slice.file.digest,
    }]
  })
}
