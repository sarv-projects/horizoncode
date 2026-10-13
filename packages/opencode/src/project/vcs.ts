import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Scope } from "effect"
import { applyPatch, formatPatch, parsePatch, structuredPatch } from "diff"
import { open, lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { Stats } from "node:fs"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "@/git"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { VcsEvent } from "@opencode-ai/schema/vcs-event"
import { Database } from "@opencode-ai/core/database/database"
import {
  Service as SessionSupervisorService,
  node as sessionSupervisorNode,
  type PatchOperation,
} from "@opencode-ai/core/session/supervisor"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
const MAX_PATCH_OPERATIONS = 64
const MAX_PATCH_OPERATION_BYTES = 2 * 1024 * 1024
const MAX_PATCH_TOTAL_OPERATION_BYTES = 4 * 1024 * 1024
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const patchError = (message: string, reason: PatchApplyError["reason"]) => new PatchApplyError({ message, reason })
function sameFile(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  )
}

async function readPatchPreimage(root: string, target: string): Promise<Buffer | null> {
  const relative = path.relative(root, target)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw patchError("Patch target is outside the workspace", "invalid-patch")
  }
  let parent = root
  const components = relative.split(path.sep)
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component)
    const info = await lstat(parent)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw patchError("Patch parent is not a safe directory", "invalid-patch")
    }
  }
  let expected: Stats
  try {
    expected = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (expected.isSymbolicLink() || !expected.isFile() || expected.nlink !== 1) {
    throw patchError("Patch target is not a regular single-link file", "invalid-patch")
  }
  if (expected.size > MAX_PATCH_OPERATION_BYTES) {
    throw patchError("Patch preimage exceeds the file limit", "invalid-patch")
  }
  const canonical = await realpath(target)
  const canonicalRelative = path.relative(root, canonical)
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw patchError("Patch target resolves outside the workspace", "invalid-patch")
  }
  const handle = await open(canonical, "r")
  try {
    const opened = await handle.stat()
    const current = await lstat(target)
    if (!sameFile(opened, expected) || !sameFile(current, expected) || !opened.isFile() || opened.nlink !== 1) {
      throw patchError("Patch target changed while reading its preimage", "stale")
    }
    const content = await handle.readFile()
    if (content.byteLength !== opened.size || content.byteLength > MAX_PATCH_OPERATION_BYTES) {
      throw patchError("Patch target changed while reading its preimage", "stale")
    }
    if (!sameFile(await handle.stat(), opened)) {
      throw patchError("Patch target changed while reading its preimage", "stale")
    }
    return content
  } finally {
    await handle.close()
  }
}

function patchFilePath(value: string | undefined) {
  if (!value || value === "/dev/null") return
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1)
    if (end < 0 || /\\(?![tnr"\\])/.test(value.slice(1, end))) {
      throw patchError("Quoted patch paths use unsupported escapes", "unsupported-patch")
    }
  }
  const file = parsePathToken(value)
  return file.startsWith("a/") || file.startsWith("b/") ? file.slice(2) : file
}

function parseApplyPatch(text: string): ParsedPatchFile[] {
  if (!text || Buffer.byteLength(text) > MAX_PATCH_BYTES) {
    throw patchError("Patch is empty or exceeds the maximum size", "invalid-patch")
  }
  const starts = [...text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index! + 1 : match.index!,
  )
  if (starts.length === 0 || text.slice(0, starts[0]).trim()) {
    throw patchError("Patch must contain only git unified-diff files", "invalid-patch")
  }
  const chunks = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
  if (chunks.length > MAX_PATCH_OPERATIONS) {
    throw patchError("Patch exceeds the maximum number of files", "invalid-patch")
  }
  return chunks.map((chunk) => {
    if (/^(?:rename from|rename to|copy from|copy to|GIT binary patch|Binary files )/m.test(chunk)) {
      throw patchError("Binary, rename, and copy patches are not supported", "unsupported-patch")
    }
    const lines = chunk.split("\n")
    const oldHeader = lines.find((line) => line.startsWith("--- "))
    const newHeader = lines.find((line) => line.startsWith("+++ "))
    if (!oldHeader || !newHeader) throw patchError("Malformed unified-diff file headers", "invalid-patch")
    const oldPath = patchFilePath(oldHeader.slice(4))
    const newPath = patchFilePath(newHeader.slice(4))
    if (!oldPath && !newPath) throw patchError("Patch file path is missing", "invalid-patch")
    if (oldPath && newPath && oldPath !== newPath) {
      throw patchError("File renames are not supported", "unsupported-patch")
    }
    const file = oldPath ?? newPath!
    const gitHeader = /^diff --git (.+)$/m.exec(chunk)?.[1]
    if (!gitHeader || fileFromGitHeader(gitHeader) !== file) {
      throw patchError("Git and unified-diff paths do not match", "invalid-patch")
    }
    if (
      file.includes("\0") ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      file.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw patchError(`Patch path is not a safe relative path: ${file}`, "invalid-patch")
    }

    const modeHeaders = [...chunk.matchAll(/^(new file mode|deleted file mode|old mode|new mode) (\S+)$/gm)]
    if (modeHeaders.some((match) => match[2] !== "100644" && match[2] !== "100755")) {
      throw patchError("Only regular 100644 and 100755 file modes are supported", "unsupported-patch")
    }
    const modeValues = new Map(modeHeaders.map((match) => [match[1]!, match[2]!]))
    if (
      (modeValues.has("new file mode") && (oldPath || !newPath || modeHeaders.length !== 1)) ||
      (modeValues.has("deleted file mode") && (!oldPath || newPath || modeHeaders.length !== 1)) ||
      modeValues.has("old mode") !== modeValues.has("new mode") ||
      (modeValues.has("old mode") && (!oldPath || !newPath || modeHeaders.length !== 2))
    ) {
      throw patchError("Malformed file mode metadata", "invalid-patch")
    }
    const executableMode = modeValues.get("new file mode") ?? modeValues.get("new mode")
    const metadata = lines.slice(1, lines.indexOf(oldHeader)).filter(Boolean)
    if (
      metadata.some(
        (line) =>
          !line.startsWith("index ") &&
          !/^(?:new file mode|deleted file mode|old mode|new mode) (?:100644|100755)$/.test(line),
      )
    ) {
      throw patchError("Patch contains unsupported git metadata", "unsupported-patch")
    }

    const parsed = parsePatch(chunk)
    if (parsed.length !== 1) throw patchError("Malformed unified diff", "invalid-patch")
    if (parsed[0]!.hunks.length === 0) {
      throw patchError(
        modeHeaders.length > 0 ? "Mode-only patches are not supported" : "Malformed or empty unified diff",
        modeHeaders.length > 0 ? "unsupported-patch" : "invalid-patch",
      )
    }
    return {
      file,
      operation: newPath ? "write" : "delete",
      patch: chunk,
      executable: newPath && executableMode ? executableMode === "100755" : undefined,
    }
  })
}

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = VcsEvent

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>
export const ApplyInput = Schema.Struct({
  sessionID: SessionID,
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["invalid-patch", "unsupported-patch", "stale", "denied", "session"]),
}) {}

type ParsedPatchFile = {
  readonly file: string
  readonly operation: "write" | "delete"
  readonly patch: string
  readonly executable?: boolean
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

const layer: Layer.Layer<
  Service,
  never,
  | Git.Service
  | EventV2Bridge.Service
  | Database.Service
  | Session.Service
  | SessionRunState.Service
  | SessionSupervisorService
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const { path: databasePath } = yield* Database.Service
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const supervisor = yield* SessionSupervisorService
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??"),
          (item) => git.patchUntracked(ctx.directory, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* patchError("VCS patch application requires a git workspace", "session")
        }
        const session = yield* sessions
          .get(input.sessionID)
          .pipe(Effect.mapError(() => patchError("The requested session does not exist", "session")))
        const locations = yield* Effect.tryPromise({
          try: async () => ({
            root: await realpath(path.resolve(ctx.worktree)),
            directory: await realpath(path.resolve(ctx.directory)),
            sessionDirectory: await realpath(path.resolve(session.directory)),
          }),
          catch: () => patchError("The requested session or VCS workspace is unavailable", "session"),
        })
        const { root, directory, sessionDirectory } = locations
        const relativeWorktree = path.relative(sessionDirectory, root)
        if (
          relativeWorktree === ".." ||
          relativeWorktree.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeWorktree)
        ) {
          return yield* patchError("The requested session does not contain this VCS worktree", "session")
        }
        const relativeDirectory = path.relative(root, directory)
        if (
          relativeDirectory === ".." ||
          relativeDirectory.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeDirectory)
        ) {
          return yield* patchError("The VCS directory is outside its worktree", "session")
        }
        yield* runState
          .assertNotBusy(session.id)
          .pipe(Effect.mapError(() => patchError("Cannot apply a VCS patch while the Session is active", "session")))

        return yield* runState
          .withExecutionOwner(
            session.id,
            Effect.gen(function* () {
              const files = yield* Effect.try({
                try: () => parseApplyPatch(input.patch),
                catch: (error) =>
                  error instanceof PatchApplyError ? error : patchError("Patch is malformed", "invalid-patch"),
              })
              const operations: PatchOperation[] = []
              const operationPaths = new Set<string>()
              let totalBytes = 0
              for (const file of files) {
                const absolute = path.resolve(directory, file.file)
                const relative = path.relative(directory, absolute)
                if (
                  relative === ".." ||
                  relative.startsWith(`..${path.sep}`) ||
                  path.isAbsolute(relative) ||
                  operationPaths.has(absolute)
                ) {
                  return yield* patchError(
                    `Patch path is outside the workspace or duplicated: ${file.file}`,
                    "invalid-patch",
                  )
                }
                operationPaths.add(absolute)
                const before = yield* Effect.tryPromise({
                  try: () => readPatchPreimage(directory, absolute),
                  catch: (error) =>
                    error instanceof PatchApplyError
                      ? error
                      : patchError(`Unable to read patch preimage: ${file.file}`, "stale"),
                })
                let beforeText: string
                try {
                  beforeText = before === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(before)
                } catch {
                  return yield* patchError(`Patch target is not valid UTF-8: ${file.file}`, "unsupported-patch")
                }
                const afterText = applyPatch(beforeText, file.patch)
                if (afterText === false) {
                  return yield* patchError(`Patch preimage is stale or does not match: ${file.file}`, "stale")
                }
                const after = Buffer.from(afterText, "utf8")
                if (file.operation === "delete" && after.length !== 0) {
                  return yield* patchError(
                    `Delete patch does not remove the entire file: ${file.file}`,
                    "invalid-patch",
                  )
                }
                if (file.operation === "write" && before?.equals(after) && file.executable === undefined) continue
                if (
                  (before?.byteLength ?? 0) > MAX_PATCH_OPERATION_BYTES ||
                  after.byteLength > MAX_PATCH_OPERATION_BYTES ||
                  totalBytes + (before?.byteLength ?? 0) + after.byteLength > MAX_PATCH_TOTAL_OPERATION_BYTES
                ) {
                  return yield* patchError("Patch exceeds the decoded byte limits", "invalid-patch")
                }
                totalBytes += (before?.byteLength ?? 0) + after.byteLength
                if (file.operation === "delete") {
                  if (!before) return yield* patchError(`Delete patch target is missing: ${file.file}`, "stale")
                  operations.push({
                    operation: "delete",
                    path: absolute,
                    expectedBeforeBase64: before.toString("base64"),
                  })
                } else {
                  operations.push({
                    operation: "write",
                    path: absolute,
                    expectedBeforeBase64: before?.toString("base64") ?? null,
                    contentBase64: after.toString("base64"),
                    ...(file.executable === undefined ? {} : { executable: file.executable }),
                  })
                }
              }
              if (operations.length === 0)
                return yield* patchError("Patch contains no file operations", "invalid-patch")
              const turnContextDigest = `sha256:${createHash("sha256")
                .update(JSON.stringify({ sessionID: session.id, workspaceRoot: root, operations }))
                .digest("hex")}`
              yield* supervisor
                .runPatch({
                  sessionID: session.id,
                  source: databasePath,
                  workspaceRoot: root,
                  turnContextDigest,
                  operations,
                  authorize: async () => undefined,
                })
                .pipe(
                  Effect.mapError((error) =>
                    patchError(
                      error.message,
                      error.stage === "authorization" || error.stage === "ownership"
                        ? "denied"
                        : error.stage === "effect" || error.stage === "protocol"
                          ? "invalid-patch"
                          : "stale",
                    ),
                  ),
                )
              return { applied: true }
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof Session.BusyError
                ? patchError("Cannot apply a VCS patch while the Session is active", "session")
                : error,
            ),
          )
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, EventV2Bridge.node, Database.node, Session.node, SessionRunState.node, sessionSupervisorNode],
})

export * as Vcs from "./vcs"
