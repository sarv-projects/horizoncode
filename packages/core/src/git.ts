export * as Git from "./git"

import path from "path"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AbsolutePath, RelativePath } from "./schema"
import { FSUtil } from "./fs-util"
import { AppProcess } from "./process"
import { makeGlobalNode } from "./effect/app-node"
import { File } from "./file"
import { KeyedMutex } from "./effect/keyed-mutex"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

export const ChangeSet = Schema.String.pipe(Schema.brand("Git.ChangeSet"))
export type ChangeSet = typeof ChangeSet.Type

export const TreeID = Schema.String.pipe(Schema.brand("Git.TreeID"))
const MAX_TREE_FILE_BYTES = 2 * 1024 * 1024
const GIT_READ_ONLY_ARGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
] as const
const GIT_PROCESS_UNAVAILABLE = "Git process operations are unavailable until routed through Guard and ExecutionHost"
export type TreeID = typeof TreeID.Type

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("Git.OperationError", {
  operation: Schema.Literals([
    "clone",
    "fetch",
    "checkout",
    "reset",
    "create",
    "refresh",
    "write_tree",
    "list_files",
    "read_file",
    "diff",
    "restore",
  ]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literals(["main", "linked"]),
}) {}

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()("Git.WorktreeError", {
  operation: Schema.Literals(["create", "remove", "list"]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  forceRequired: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class PatchError extends Schema.TaggedErrorClass<PatchError>()("Git.PatchError", {
  operation: Schema.Literals(["capture", "apply", "reset"]),
  directory: AbsolutePath,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly repo: {
    readonly discover: (input: AbsolutePath) => Effect.Effect<Repository | undefined>
    readonly clone: (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) => Effect.Effect<Repository, OperationError>
    readonly create: (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) => Effect.Effect<Repository, OperationError>
  }
  readonly remote: {
    readonly get: (repository: Repository, name?: string) => Effect.Effect<string | undefined>
  }
  readonly history: {
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    readonly defaultRemoteBranch: (repository: Repository, remote?: string) => Effect.Effect<string | undefined>
    readonly rootCommits: (repository: Repository) => Effect.Effect<readonly string[]>
  }
  readonly sync: {
    readonly fetchRemotes: (repository: Repository, input?: { prune?: boolean }) => Effect.Effect<void, OperationError>
    readonly fetchBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly resetHard: (repository: Repository, revision: string) => Effect.Effect<void, OperationError>
  }
  readonly change: {
    readonly capture: (input: { repository: Repository; path: AbsolutePath }) => Effect.Effect<ChangeSet, PatchError>
    readonly apply: (input: {
      repository: Repository
      path: AbsolutePath
      changes: ChangeSet
    }) => Effect.Effect<void, PatchError>
    readonly discard: (input: {
      repository: Repository
      path: AbsolutePath
      index: "preserve" | "reset"
      untracked: "preserve" | "remove"
    }) => Effect.Effect<void, PatchError>
  }
  readonly worktree: {
    readonly create: (input: {
      repository: Repository
      directory: AbsolutePath
    }) => Effect.Effect<Repository, WorktreeError>
    readonly remove: (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) => Effect.Effect<void, WorktreeError>
    readonly list: (repository: Repository) => Effect.Effect<readonly Worktree[], WorktreeError>
  }
  readonly index: {
    /** Refresh only the requested project-relative scope, preserving all other entries. */
    readonly refresh: (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<{ readonly skipped: readonly RelativePath[] }, OperationError>
    readonly ignored: (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) => Effect.Effect<ReadonlySet<RelativePath>, OperationError>
  }
  readonly tree: {
    readonly capture: (input: {
      repository: Repository
      scopes: readonly RelativePath[]
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<TreeID, OperationError>
    readonly write: (repository: Repository) => Effect.Effect<TreeID, OperationError>
    readonly files: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) => Effect.Effect<readonly RelativePath[], OperationError>
    readonly readFile: (input: {
      repository: Repository
      tree: TreeID
      path: RelativePath
    }) => Effect.Effect<{ readonly content: Uint8Array; readonly executable: boolean } | undefined, OperationError>
    readonly diff: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) => Effect.Effect<readonly File.Diff[], OperationError>
    readonly preview: (input: {
      repository: Repository
      current: TreeID
      files: ReadonlyMap<RelativePath, TreeID>
      context?: number
    }) => Effect.Effect<readonly File.Diff[], OperationError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const process = yield* AppProcess.Service
    // The legacy Git service uses child processes even for read-only inspection.
    // Until those invocations have a Guard/ExecutionHost route, give every helper
    // the same fail-closed process port so no Git path can accidentally spawn.
    const proc: AppProcess.Interface = {
      ...process,
      run(command) {
        const name = command._tag === "StandardCommand" ? command.command : "git"
        return Effect.fail(
          new AppProcess.AppProcessError({
            command: name,
            cause: new Error(GIT_PROCESS_UNAVAILABLE),
          }),
        )
      },
    }
    const locks = KeyedMutex.makeUnsafe<string>()
    const locked = <A, E, R>(repository: Repository, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(repository.gitDirectory)(effect)

    const discover = Effect.fn("Git.repo.discover")(function* (input: AbsolutePath) {
      const dotgit = yield* fs.up({ targets: [".git"], start: input }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!dotgit) return undefined

      const cwd = path.dirname(dotgit)
      const git = run(cwd, proc)
      const topLevel = yield* git(["rev-parse", "--show-toplevel"])
      const gitDir = yield* git(["rev-parse", "--git-dir"])
      const commonDir = yield* git(["rev-parse", "--git-common-dir"])
      if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return undefined

      return new Repository({
        worktree: AbsolutePath.make(topLevel.exitCode === 0 ? resolvePath(cwd, topLevel.text) : cwd),
        gitDirectory: AbsolutePath.make(resolvePath(cwd, gitDir.text)),
        commonDirectory: AbsolutePath.make(resolvePath(cwd, commonDir.text)),
      })
    })

    const remote = Effect.fn("Git.remote.get")(function* (repository: Repository, name = "origin") {
      const result = yield* run(repository.worktree, proc)(["remote", "get-url", name])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const roots = Effect.fn("Git.history.rootCommits")(function* (repository: Repository) {
      // Enumerate every root reachable from refs: the storage migration uses the
      // oldest project root, including independent histories on retained branches.
      const result = yield* run(repository.worktree, proc)(["rev-list", "--max-parents=0", "--all"])
      if (result.exitCode !== 0) return []
      return result.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()
    })

    const head = Effect.fn("Git.history.head")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc)(["rev-parse", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const branch = Effect.fn("Git.history.branch")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc)(["symbolic-ref", "--quiet", "--short", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const remoteHead = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Repository,
      remoteName = "origin",
    ) {
      const result = yield* run(repository.worktree, proc)(["symbolic-ref", `refs/remotes/${remoteName}/HEAD`])
      if (result.exitCode !== 0) return undefined
      return result.text.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "") || undefined
    })

    const clone = Effect.fn("Git.repo.clone")(function* (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) {
      return yield* new OperationError({
        operation: "clone",
        directory: AbsolutePath.make(path.dirname(input.directory)),
        message: "Direct Git clone is unavailable until routed through Guard and ExecutionHost",
      })
    })

    const fetch = Effect.fn("Git.sync.fetchRemotes")(function* (
      repository: Repository,
      input: { prune?: boolean } = {},
    ) {
      void input
      return yield* new OperationError({
        operation: "fetch",
        directory: repository.worktree,
        message: "Direct Git fetch is unavailable until routed through Guard and ExecutionHost",
      })
    })

    const fetchBranch = Effect.fn("Git.sync.fetchBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) {
      void input
      return yield* new OperationError({
        operation: "fetch",
        directory: repository.worktree,
        message: "Direct Git fetch is unavailable until routed through Guard and ExecutionHost",
      })
    })

    const checkout = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) {
      void input
      return yield* new OperationError({
        operation: "checkout",
        directory: repository.worktree,
        message: "Direct Git checkout is unavailable until routed through Guard and ExecutionHost",
      })
    })

    const reset = Effect.fn("Git.sync.resetHard")(function* (repository: Repository, revision: string) {
      void revision
      return yield* new OperationError({
        operation: "reset",
        directory: repository.worktree,
        message: "Direct Git reset is unavailable until routed through Guard and ExecutionHost",
      })
    })

    const repositoryArgs = (repository: Repository, args: string[]) => [
      ...GIT_READ_ONLY_ARGS,
      "--git-dir",
      repository.gitDirectory,
      "--work-tree",
      repository.worktree,
      ...args,
    ]

    const repositoryOperation = Effect.fnUntraced(function* (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: { stdin?: string; env?: Record<string, string> },
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make("git", repositoryArgs(repository, args), {
            cwd: repository.worktree,
            env: options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: operationName,
                directory: repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      const text = result.stdout.toString("utf8")
      if (result.exitCode === 0) return { text, stderr: result.stderr.toString("utf8") }
      return yield* new OperationError({
        operation: operationName,
        directory: repository.worktree,
        message: result.stderr.toString("utf8").trim() || text.trim() || `Git ${operationName} failed`,
      })
    })

    const create = Effect.fn("Git.repo.create")(function* (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) {
      return yield* new OperationError({
        operation: "create",
        directory: input.gitDirectory,
        message: "Direct Git repository initialization is unavailable until Guard admission exists",
      })
    })

    const refresh = Effect.fn("Git.index.refresh")(function* (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) {
      return yield* new OperationError({
        operation: "refresh",
        directory: input.repository.worktree,
        message: "Direct Git index refresh is unavailable until Guard admission exists",
      })
    })

    const ignored = Effect.fn("Git.index.ignored")(function* (input: {
      repository: Repository
      paths: readonly RelativePath[]
    }) {
      if (!input.paths.length) return new Set<RelativePath>()
      const result = yield* proc
        .run(
          ChildProcess.make("git", repositoryArgs(input.repository, ["check-ignore", "--no-index", "--stdin", "-z"]), {
            cwd: input.repository.worktree,
            extendEnv: true,
          }),
          { stdin: input.paths.join("\0") + "\0" },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "list_files",
                directory: input.repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* new OperationError({
          operation: "list_files",
          directory: input.repository.worktree,
          message: result.stderr.toString("utf8").trim() || "Failed to check ignored paths",
        })
      return new Set(
        result.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((file) => RelativePath.make(file)),
      )
    })

    const writeTree = Effect.fn("Git.tree.write")(function* (repository: Repository) {
      return yield* new OperationError({
        operation: "write_tree",
        directory: repository.worktree,
        message: "Direct Git tree writes are unavailable until Guard admission exists",
      })
    })

    const captureTree = Effect.fn("Git.tree.capture")(
      (input: {
        repository: Repository
        scopes: readonly RelativePath[]
        ignores?: Repository
        maximumUntrackedFileBytes?: number
      }) =>
        locked(
          input.repository,
          new OperationError({
            operation: "write_tree",
            directory: input.repository.worktree,
            message: "Direct Git tree capture is unavailable until Guard admission exists",
          }),
        ),
    )

    const treeFiles = Effect.fn("Git.tree.files")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) {
      return (yield* repositoryOperation("list_files", input.repository, [
        "diff",
        "--name-only",
        "-z",
        input.from,
        input.to,
      ])).text
        .split("\0")
        .filter(Boolean)
        .map((file) => RelativePath.make(file))
    })

    const treeDiff = Effect.fn("Git.tree.diff")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) {
      const paths = input.paths ?? (yield* treeFiles(input))
      return yield* Effect.forEach(paths, (file) =>
        Effect.gen(function* () {
          const statusText = (yield* repositoryOperation("diff", input.repository, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "--no-renames",
            input.from,
            input.to,
            "--",
            file,
          ])).text.trim()
          const status = statusText.startsWith("A") ? "added" : statusText.startsWith("D") ? "deleted" : "modified"
          const stats = (yield* repositoryOperation("diff", input.repository, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "--no-renames",
            input.from,
            input.to,
            "--",
            file,
          ])).text.split("\t")
          const binary = stats[0] === "-" || stats[1] === "-"
          const patch = binary
            ? ""
            : (yield* repositoryOperation("diff", input.repository, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                `--unified=${input.context ?? 3}`,
                "--no-renames",
                input.from,
                input.to,
                "--",
                file,
              ])).text
          return {
            path: file,
            status,
            additions: binary ? 0 : Number(stats[0] ?? 0),
            deletions: binary ? 0 : Number(stats[1] ?? 0),
            patch,
          } satisfies File.Diff
        }),
      )
    })

    const entry = Effect.fnUntraced(function* (repository: Repository, tree: TreeID, file: RelativePath) {
      const normalized = file.replaceAll("\\", "/")
      if (
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) ||
        file.includes("\0") ||
        path.isAbsolute(file) ||
        normalized.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid snapshot tree path: ${file}`,
        })
      }
      const text = (yield* repositoryOperation("restore", repository, [
        "ls-tree",
        "-z",
        "--end-of-options",
        tree,
        "--",
        `:(top,literal)${file}`,
      ])).text.replace(/\0$/, "")
      if (!text) return
      const match = text.match(/^(\d{6})\s+(\w+)\s+([0-9a-f]{40}|[0-9a-f]{64})\t/)
      if (!match)
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid tree entry for ${file}`,
        })
      return { mode: match[1]!, type: match[2]!, object: match[3]! }
    })

    const readTreeFile = Effect.fn("Git.tree.readFile")(function* (input: {
      repository: Repository
      tree: TreeID
      path: RelativePath
    }) {
      const source = yield* entry(input.repository, input.tree, input.path)
      if (!source) return
      if (source.type !== "blob" || !["100644", "100755"].includes(source.mode)) {
        return yield* new OperationError({
          operation: "read_file",
          directory: input.repository.worktree,
          message: `Snapshot path is not a regular file: ${input.path}`,
        })
      }
      const sizeText = (yield* repositoryOperation("read_file", input.repository, ["cat-file", "-s", source.object])).text.trim()
      const size = Number(sizeText)
      if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || size > MAX_TREE_FILE_BYTES) {
        return yield* new OperationError({
          operation: "read_file",
          directory: input.repository.worktree,
          message: `Snapshot file exceeds the supported size: ${input.path}`,
        })
      }
      const result = yield* proc
        .run(
          ChildProcess.make(
            "git",
            repositoryArgs(input.repository, ["cat-file", "blob", source.object]),
            {
              cwd: input.repository.worktree,
              extendEnv: true,
              stdin: "ignore",
            },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "read_file",
                directory: input.repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      if (result.exitCode !== 0) {
        return yield* new OperationError({
          operation: "read_file",
          directory: input.repository.worktree,
          message: result.stderr.toString("utf8").trim() || `Failed to read snapshot path: ${input.path}`,
        })
      }
      if (result.stdout.byteLength !== size) {
        return yield* new OperationError({
          operation: "read_file",
          directory: input.repository.worktree,
          message: `Snapshot file size changed while reading: ${input.path}`,
        })
      }
      return { content: result.stdout, executable: source.mode === "100755" }
    })

    const preview = Effect.fn("Git.tree.preview")(function* (input: {
      repository: Repository
      current: TreeID
      files: ReadonlyMap<RelativePath, TreeID>
      context?: number
    }) {
      return yield* new OperationError({
        operation: "diff",
        directory: input.repository.worktree,
        message: "Git tree preview is unavailable because it writes temporary Git index/object state",
      })
    })

    const capture = Effect.fn("Git.change.capture")(function* (input: { repository: Repository; path: AbsolutePath }) {
      const scope = path.relative(input.repository.worktree, input.path).replaceAll("\\", "/") || "."
      const tracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (tracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message: tracked.stderr.trim() || tracked.text.trim() || "Failed to capture tracked changes",
        })
      }

      const untracked = yield* execute(
        input.repository.worktree,
        proc,
      )(["ls-files", "--others", "--exclude-standard", "-z", "--", scope]).pipe(
        Effect.mapError(
          (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
        ),
      )
      if (untracked.exitCode !== 0) {
        return yield* new PatchError({
          operation: "capture",
          directory: input.path,
          message: untracked.stderr.trim() || untracked.text.trim() || "Failed to list untracked changes",
        })
      }

      const created = yield* Effect.forEach(untracked.text.split("\0").filter(Boolean), (file) =>
        execute(
          input.repository.worktree,
          proc,
        )(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", file]).pipe(
          Effect.mapError(
            (cause) => new PatchError({ operation: "capture", directory: input.path, message: cause.message, cause }),
          ),
          Effect.flatMap((result) =>
            // git diff --no-index returns 1 when differences were found.
            result.exitCode === 0 || result.exitCode === 1
              ? Effect.succeed(result.text)
              : Effect.fail(
                  new PatchError({
                    operation: "capture",
                    directory: input.path,
                    message:
                      result.stderr.trim() || result.text.trim() || `Failed to capture untracked change: ${file}`,
                  }),
                ),
          ),
        ),
      )
      return ChangeSet.make([tracked.text, ...created].filter(Boolean).join("\n"))
    })

    const apply = Effect.fn("Git.change.apply")(function* (input: {
      repository: Repository
      path: AbsolutePath
      changes: ChangeSet
    }) {
      return yield* new PatchError({
        operation: "apply",
        directory: input.path,
        message: "Direct Git patch application is unavailable; use the Guarded workspace patch route",
      })
    })

    const discard = Effect.fn("Git.change.discard")(function* (input: {
      repository: Repository
      path: AbsolutePath
      index: "preserve" | "reset"
      untracked: "preserve" | "remove"
    }) {
      return yield* new PatchError({
        operation: "reset",
        directory: input.path,
        message: "Direct Git discard is unavailable; use the Guarded workspace mutation route",
      })
    })

    const worktreeRun = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repository: Repository,
      args: string[],
      worktreeDirectory?: AbsolutePath,
      cwd = repository.worktree,
    ) {
      const result = yield* proc
        .run(ChildProcess.make("git", [...GIT_READ_ONLY_ARGS, ...args], { cwd, extendEnv: true, stdin: "ignore" }))
        .pipe(
          Effect.mapError(
            (cause) => new WorktreeError({ operation, directory: worktreeDirectory, message: cause.message, cause }),
          ),
        )
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Git failed"
      return yield* new WorktreeError({
        operation,
        directory: worktreeDirectory,
        message,
        forceRequired: operation === "remove" && /contains modified or untracked files|is dirty/i.test(message),
      })
    })

    const worktreeCreate = Effect.fn("Git.worktree.create")(function* (input: {
      repository: Repository
      directory: AbsolutePath
    }) {
      return yield* new WorktreeError({
        operation: "create",
        directory: input.directory,
        message: "Direct Git worktree creation is unavailable until Guard admission exists",
      })
    })

    const worktreeRemove = Effect.fn("Git.worktree.remove")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) {
      return yield* new WorktreeError({
        operation: "remove",
        directory: input.directory,
        message: "Direct Git worktree removal is unavailable until Guard admission exists",
      })
    })

    const worktreeList = Effect.fn("Git.worktree.list")(function* (repository: Repository) {
      return (yield* worktreeRun("list", repository, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Worktree({
              directory: AbsolutePath.make(resolvePath(repository.worktree, line.slice("worktree ".length).trim())),
              kind: index === 0 ? "main" : "linked",
            }),
        )
    })

    return Service.of({
      repo: { discover, clone, create },
      remote: { get: remote },
      history: { head, branch, defaultRemoteBranch: remoteHead, rootCommits: roots },
      sync: { fetchRemotes: fetch, fetchBranch, checkoutRemoteBranch: checkout, resetHard: reset },
      change: { capture, apply, discard },
      worktree: { create: worktreeCreate, remove: worktreeRemove, list: worktreeList },
      index: { refresh, ignored },
      tree: {
        capture: captureTree,
        write: writeTree,
        files: treeFiles,
        diff: treeDiff,
        preview,
        readFile: readTreeFile,
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, AppProcess.node] })

interface Result {
  readonly exitCode: number
  readonly text: string
  readonly stderr: string
}

function run(cwd: string, proc: AppProcess.Interface) {
  return (args: string[]) =>
    execute(cwd, proc)(args).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, text: "", stderr: "" })))
}

function execute(cwd: string, proc: AppProcess.Interface) {
  return (args: string[]) =>
    proc
      .run(
        ChildProcess.make("git", [...GIT_READ_ONLY_ARGS, ...args], {
          cwd,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.map(
          (result) =>
            ({
              exitCode: result.exitCode,
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            }) satisfies Result,
        ),
      )
}

function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "")
  if (!trimmed) return cwd
  const normalized = FSUtil.windowsPath(trimmed)
  if (path.isAbsolute(normalized)) return path.normalize(normalized)
  return path.resolve(cwd, normalized)
}
