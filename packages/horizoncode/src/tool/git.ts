/**
 * Read-only git inspection tools (`git.status`, `git.diff`, `git.log`,
 * `git.show`, `git.branch.list` from arch_V1 §33).
 *
 * Every tool runs one fixed argv through `Process.run` (argv array, never a
 * shell string) with the child cwd pinned to the Session workspace. Caller
 * values that reach argv are rejected when they are flag-like (a leading `-`,
 * the flag-injection guard the reference MCP git server applies) or outside a
 * minimal ref grammar, and caller paths are confined to the workspace. No
 * mutating or network-capable subcommand is reachable from this module.
 */
import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@horizoncode/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import * as Tool from "./tool"
import * as Truncate from "./truncate"

/** Hard read deadline; arch_V1 read tools stay at or below 15s. */
const GIT_TIMEOUT_MS = 10_000
/** SIGKILL grace after the abort signal reaches the child. */
const GIT_KILL_GRACE_MS = 2_000
/** Raw stdout bound before the truncation helper runs. */
const MAX_STDOUT_BYTES = 64 * 1024
const MAX_ARG_BYTES = 256
const OUTPUT_MAX_LINES = 1_500
const OUTPUT_MAX_BYTES = 48 * 1024

/** Git never prompts; the tools cannot reach the network or hold repo locks. */
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
}

/** Conservative revision grammar: no whitespace, no leading `-`, no glob. */
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^:+-]*$/

/**
 * `--upload-pack=…`, `--output=/etc/…`, `-c core.pager=…` and friends are all
 * caught by the leading-dash rule before the value can become an argv flag.
 */
const flagGuard = (value: string, label: string): string | undefined => {
  if (value.length === 0) return `${label} must not be empty`
  if (Buffer.byteLength(value, "utf8") > MAX_ARG_BYTES) return `${label} must be at most ${MAX_ARG_BYTES} UTF-8 bytes`
  if (value.startsWith("-")) return `${label} must not start with '-' (flag-injection guard)`
  return undefined
}

const Revision = Schema.String.check(
  Schema.makeFilter((value) => {
    const flag = flagGuard(value, "revision")
    if (flag) return flag
    if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return "revision must not contain whitespace or control characters"
    if (!REF_PATTERN.test(value)) return "revision contains characters outside the git ref grammar"
    return undefined
  }),
)

/** Workspace-relative path. Absolute paths, drive letters and `..` segments are refused. */
const WorkspacePath = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value === ".") return undefined
    const flag = flagGuard(value, "path")
    if (flag) return flag
    if (/[\u0000-\u001f\u007f]/u.test(value)) return "path must not contain control characters"
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) return "path must be relative to the session workspace"
    if (value.includes("\\")) return "path must use '/' separators"
    const segments = value.split("/")
    if (segments.includes("..")) return "path must not contain parent ('..') segments"
    if (segments.some((segment) => segment.length === 0 || segment === ".")) return "path must be a normalized relative path"
    return undefined
  }),
)

const ContextLines = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))
const MaxCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
const BranchScope = Schema.Literals(["local", "remote", "all"])

/** Second, runtime half of the flag guard: schema decoding is not the only caller. */
const safeArg = (value: string, label: string) => {
  const flag = flagGuard(value, label)
  if (flag) throw new Error(flag)
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must not contain whitespace or control characters`)
  if (!REF_PATTERN.test(value)) throw new Error(`${label} contains characters outside the git ref grammar`)
  return value
}

/** Second, runtime half of the workspace bound: resolve, then prove containment. */
const boundedPath = (relative: string, instance: InstanceContext) => {
  const resolved = relative === "." ? instance.directory : path.resolve(instance.directory, relative)
  if (!FSUtil.contains(instance.directory, resolved)) {
    throw new Error(`path escapes the session workspace: ${relative}`)
  }
  return path.relative(instance.directory, resolved) || "."
}

type GitOutcome = { readonly stdout: string }

const executeGit = (input: {
  readonly cwd: string
  readonly args: readonly string[]
  readonly abort: AbortSignal
}): Effect.Effect<GitOutcome, Error> =>
  Effect.gen(function* () {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    input.abort.addEventListener("abort", onAbort, { once: true })
    if (input.abort.aborted) controller.abort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, GIT_TIMEOUT_MS)
    const outcome = yield* Effect.tryPromise({
      try: () =>
        Process.run(["git", "--no-pager", "--no-optional-locks", ...input.args], {
          cwd: input.cwd,
          env: GIT_ENV,
          abort: controller.signal,
          timeout: GIT_KILL_GRACE_MS,
          nothrow: true,
        }),
      catch: (cause) => new Error(`git ${input.args[0] ?? "command"} could not start: ${errorMessage(cause)}`),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          clearTimeout(timer)
          input.abort.removeEventListener("abort", onAbort)
        }),
      ),
    )

    const command = input.args[0] ?? "command"
    if (timedOut) return yield* Effect.fail(new Error(`git ${command} exceeded the ${GIT_TIMEOUT_MS}ms read timeout`))
    if (input.abort.aborted) return yield* Effect.fail(new Error(`git ${command} was cancelled`))
    if (outcome.code !== 0) {
      const detail = outcome.stderr.toString("utf8").trim().slice(0, 2_000)
      return yield* Effect.fail(
        new Error(detail ? `git ${command} failed: ${detail}` : `git ${command} exited with code ${outcome.code}`),
      )
    }
    if (outcome.stdout.byteLength <= MAX_STDOUT_BYTES) return { stdout: outcome.stdout.toString("utf8") }
    const head = outcome.stdout.subarray(0, MAX_STDOUT_BYTES).toString("utf8")
    return { stdout: `${head}\n[stdout bounded at ${MAX_STDOUT_BYTES} bytes]` }
  })

/** Bound the rendered output through the shared truncation helper. */
const finish = (truncate: Truncate.Interface, title: string, output: string) =>
  Effect.gen(function* () {
    const limited = yield* truncate.output(output, { maxLines: OUTPUT_MAX_LINES, maxBytes: OUTPUT_MAX_BYTES })
    return {
      title,
      metadata: {
        truncated: limited.truncated,
        ...(limited.truncated ? { outputPath: limited.outputPath } : {}),
      },
      output: limited.content,
    }
  })

/** Drop trailing newlines so "no changes" detection stays simple. */
const compact = (text: string) => text.replace(/\s+$/u, "")

const orEmpty = (text: string, fallback: string) => (compact(text).length === 0 ? fallback : compact(text))

export const StatusParameters = Schema.Struct({})

export const DiffParameters = Schema.Struct({
  staged: Schema.optional(Schema.Boolean).annotate({
    description: "Compare the index against HEAD (staged changes) instead of the working tree.",
  }),
  target: Schema.optional(Revision).annotate({
    description: "Revision to diff against, for example `HEAD~1`. Flag-like values are rejected.",
  }),
  path: Schema.optional(WorkspacePath).annotate({
    description: "Workspace-relative path filter. Omit to diff the whole workspace.",
  }),
  contextLines: Schema.optional(ContextLines).annotate({
    description: "Unified diff context lines (0-10, default 3).",
  }),
})

export const LogParameters = Schema.Struct({
  maxCount: Schema.optional(MaxCount).annotate({ description: "Maximum commits to return (1-50, default 10)." }),
  path: Schema.optional(WorkspacePath).annotate({
    description: "Workspace-relative path filter. Omit to log the whole workspace.",
  }),
})

export const ShowParameters = Schema.Struct({
  revision: Schema.optional(Revision).annotate({
    description: "Revision to show, either a commit (`HEAD`, `HEAD~1`) or a blob (`HEAD:path/to/file`). Defaults to HEAD.",
  }),
})

export const BranchParameters = Schema.Struct({
  scope: Schema.optional(BranchScope).annotate({
    description: "Which branches to list: local (default), remote, or all.",
  }),
})

export const GitStatusTool = Tool.define(
  "git_status",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description:
        "Report the working-tree status (porcelain v1, branch header included) of the session workspace. Read-only: never stages, commits or writes.",
      parameters: StatusParameters,
      capability: { id: "git.status", effectClass: "read_only" as const },
      execute: (_params: typeof StatusParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const { stdout } = yield* executeGit({
            cwd: instance.directory,
            args: ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
            abort: ctx.abort,
          })
          return yield* finish(truncate, "git status", orEmpty(stdout, "Working tree clean"))
        }).pipe(Effect.orDie),
    }
  }),
)

export const GitDiffTool = Tool.define(
  "git_diff",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description:
        "Show a unified diff of the session workspace: unstaged by default, staged with `staged`, optionally against a revision and limited to one path. Read-only.",
      parameters: DiffParameters,
      capability: { id: "git.diff", effectClass: "read_only" as const },
      execute: (params: typeof DiffParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const target = params.target === undefined ? undefined : safeArg(params.target, "target")
          const filter = params.path === undefined ? undefined : boundedPath(params.path, instance)
          const context = params.contextLines ?? 3
          const args = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            `--unified=${context}`,
            ...(params.staged ? ["--cached"] : []),
            ...(target === undefined ? [] : [target]),
            "--",
            ...(filter === undefined ? [] : [filter]),
          ]
          const { stdout } = yield* executeGit({ cwd: instance.directory, args, abort: ctx.abort })
          const title = `git diff${params.staged ? " --cached" : ""}${target === undefined ? "" : ` ${target}`}`
          return yield* finish(truncate, title, orEmpty(stdout, "No changes."))
        }).pipe(Effect.orDie),
    }
  }),
)

export const GitLogTool = Tool.define(
  "git_log",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description:
        "List recent commits (`hash subject (author, relative date)`) in the session workspace, optionally limited to one path. Read-only.",
      parameters: LogParameters,
      capability: { id: "git.log", effectClass: "read_only" as const },
      execute: (params: typeof LogParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filter = params.path === undefined ? undefined : boundedPath(params.path, instance)
          const maxCount = params.maxCount ?? 10
          const { stdout } = yield* executeGit({
            cwd: instance.directory,
            args: [
              "log",
              "--no-color",
              "--no-decorate",
              "--format=%h %s (%an, %ar)",
              "-n",
              String(maxCount),
              ...(filter === undefined ? [] : ["--", filter]),
            ],
            abort: ctx.abort,
          })
          return yield* finish(truncate, `git log -n ${maxCount}`, orEmpty(stdout, "No commits."))
        }).pipe(Effect.orDie),
    }
  }),
)

export const GitShowTool = Tool.define(
  "git_show",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description:
        "Show one revision: a commit (`HEAD`, `HEAD~1`) or a file blob (`HEAD:path/to/file`) in the session workspace. Read-only.",
      parameters: ShowParameters,
      capability: { id: "git.show", effectClass: "read_only" as const },
      execute: (params: typeof ShowParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const revision = safeArg(params.revision ?? "HEAD", "revision")
          const blob = revision.includes(":")
          const { stdout } = yield* executeGit({
            cwd: instance.directory,
            args: ["show", "--no-color", ...(blob ? [] : ["--no-ext-diff", "--no-textconv"]), revision],
            abort: ctx.abort,
          })
          return yield* finish(truncate, `git show ${revision}`, orEmpty(stdout, "(empty revision)"))
        }).pipe(Effect.orDie),
    }
  }),
)

export const GitBranchesTool = Tool.define(
  "git_branches",
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    return {
      description:
        "List branches in the session workspace (`*` marks the current branch) for local, remote or all refs. Read-only.",
      parameters: BranchParameters,
      capability: { id: "git.branch.list", effectClass: "read_only" as const },
      execute: (params: typeof BranchParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const scope = params.scope ?? "local"
          const scopeFlag = scope === "all" ? "--all" : scope === "remote" ? "--remotes" : "--list"
          const { stdout } = yield* executeGit({
            cwd: instance.directory,
            args: ["branch", "--no-color", "--format=%(HEAD) %(refname:short)", scopeFlag],
            abort: ctx.abort,
          })
          return yield* finish(truncate, `git branch (${scope})`, orEmpty(stdout, "No branches."))
        }).pipe(Effect.orDie),
    }
  }),
)

/** Provider-safe ids; the canonical dotted capability IDs stay on `capability`. */
export const gitToolIDs = ["git_status", "git_diff", "git_log", "git_show", "git_branches"] as const
