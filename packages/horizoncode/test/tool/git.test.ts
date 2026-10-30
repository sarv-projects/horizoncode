import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { FSUtil } from "@horizoncode/core/fs-util"
import { classifyCapability } from "@horizoncode/core/config/coding-profile"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { GitBranchesTool, GitDiffTool, GitLogTool, GitShowTool, GitStatusTool } from "../../src/tool/git"
import type * as Tool from "../../src/tool/tool"

// The git tools spawn `git` directly (no service indirection) and only take
// Truncate.Service at init plus Agent.Service in Tool.define's wrapper.
const toolLayer = () => LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node]))

const it = testEffect(toolLayer())

const ctx = {
  sessionID: SessionID.make("ses_git"),
  messageID: MessageID.make("msg_git"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} satisfies Tool.Context

const git = (cwd: string, args: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`)
    return stdout
  })

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))

/** Commit `a.txt`, then leave it modified and add an untracked `b.txt`. */
const prepareWorktree = (directory: string) =>
  Effect.gen(function* () {
    yield* write(path.join(directory, "a.txt"), "one\n")
    yield* git(directory, ["add", "a.txt"])
    yield* git(directory, ["commit", "-m", "add a"])
    yield* write(path.join(directory, "a.txt"), "two\n")
    yield* write(path.join(directory, "b.txt"), "untracked\n")
  })

const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return ""
  const cause = Cause.squash(exit.cause)
  return cause instanceof Error ? cause.message : String(cause)
}

describe("tool.git", () => {
  it.effect("uses provider-safe ids and canonical Core read-only capabilities", () =>
    Effect.sync(() => {
      expect([
        [GitStatusTool.id, "git.status"],
        [GitDiffTool.id, "git.diff"],
        [GitLogTool.id, "git.log"],
        [GitShowTool.id, "git.show"],
        [GitBranchesTool.id, "git.branch.list"],
      ]).toEqual([
        ["git_status", "git.status"],
        ["git_diff", "git.diff"],
        ["git_log", "git.log"],
        ["git_show", "git.show"],
        ["git_branches", "git.branch.list"],
      ])
      for (const id of ["git_status", "git_diff", "git_log", "git_show", "git_branches"]) {
        expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      }
      for (const capability of ["git.status", "git.diff", "git.log", "git.show", "git.branch.list"]) {
        expect(classifyCapability(capability)).toBe("core")
      }
    }),
  )

  it.instance(
    "reports a modified file and an untracked file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const info = yield* GitStatusTool
        const tool = yield* info.init()
        const result = yield* tool.execute({}, ctx)

        expect(tool.capability).toEqual({ id: "git.status", effectClass: "read_only" })
        expect(result.output).toContain(" M a.txt")
        expect(result.output).toContain("?? b.txt")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "shows the unstaged hunk and the staged diff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const info = yield* GitDiffTool
        const tool = yield* info.init()

        const unstaged = yield* tool.execute({}, ctx)
        expect(tool.capability).toEqual({ id: "git.diff", effectClass: "read_only" })
        expect(unstaged.output).toContain("@@")
        expect(unstaged.output).toContain("-one")
        expect(unstaged.output).toContain("+two")

        const scoped = yield* tool.execute({ path: "a.txt", contextLines: 5 }, ctx)
        expect(scoped.output).toContain("a.txt")
        expect(scoped.output).not.toContain("b.txt")

        yield* git(test.directory, ["add", "a.txt"])
        const staged = yield* tool.execute({ staged: true }, ctx)
        expect(staged.output).toContain("+two")
        expect(staged.output).toContain("index")
        expect((yield* tool.execute({}, ctx)).output).toBe("No changes.")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "returns the commit log bounded by maxCount",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const info = yield* GitLogTool
        const tool = yield* info.init()

        const result = yield* tool.execute({ maxCount: 1 }, ctx)
        expect(tool.capability).toEqual({ id: "git.log", effectClass: "read_only" })
        expect(result.output).toContain("add a")
        expect(result.output).not.toContain("root commit")
        expect(result.output).not.toContain("\n")

        const full = yield* tool.execute({}, ctx)
        expect(full.output).toContain("root commit")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "shows a file blob and a commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const info = yield* GitShowTool
        const tool = yield* info.init()

        const blob = yield* tool.execute({ revision: "HEAD:a.txt" }, ctx)
        expect(tool.capability).toEqual({ id: "git.show", effectClass: "read_only" })
        expect(blob.output.trim()).toBe("one")

        const commit = yield* tool.execute({}, ctx)
        expect(commit.output).toContain("add a")
        expect(commit.output).toContain("a.txt")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "lists the current local branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const current = (yield* git(test.directory, ["branch", "--show-current"])).trim()
        expect(current.length).toBeGreaterThan(0)

        const info = yield* GitBranchesTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ scope: "local" }, ctx)

        expect(tool.capability).toEqual({ id: "git.branch.list", effectClass: "read_only" })
        expect(result.output).toContain(`* ${current}`)
      }),
    { git: true },
    30000,
  )

  it.instance(
    "rejects flag-injection values before they reach argv",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const showInfo = yield* GitShowTool
        const show = yield* showInfo.init()
        const diffInfo = yield* GitDiffTool
        const diff = yield* diffInfo.init()

        const revision = yield* show.execute({ revision: "--upload-pack=touch /tmp/git-pwned" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(revision)).toBe(true)
        expect(failureMessage(revision)).toContain("flag-injection guard")

        const target = yield* diff.execute({ target: "--no-index=/etc/passwd" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(target)).toBe(true)
        expect(failureMessage(target)).toContain("flag-injection guard")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "rejects paths outside the session workspace",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* prepareWorktree(test.directory)
        const info = yield* GitDiffTool
        const tool = yield* info.init()

        for (const value of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
          const exit = yield* tool.execute({ path: value }, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(failureMessage(exit)).toMatch(/session workspace|parent \('\.\.'\)/)
        }
      }),
    { git: true },
    30000,
  )
})
