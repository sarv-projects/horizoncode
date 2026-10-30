import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Git } from "@horizoncode/core/git"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { AppProcess } from "@horizoncode/core/process"
import { Global } from "@horizoncode/core/global"
import { AbsolutePath, RelativePath } from "@horizoncode/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

testEffect(Layer.empty).live("refuses the legacy direct git apply process before dispatch", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        let processCalls = 0
        const appProcess = Layer.succeed(
          AppProcess.Service,
          AppProcess.Service.of({
            run: () =>
              Effect.sync(() => {
                processCalls++
                return {
                  command: "git apply -",
                  exitCode: 0,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.alloc(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              }),
            runStream: () => {
              processCalls++
              throw new Error("unexpected process stream")
            },
          } as unknown as AppProcess.Interface),
        )
        const layer = AppNodeBuilder.build(Git.node, [
          [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
          [AppProcess.node, appProcess],
        ])
        const git = yield* Git.Service.pipe(Effect.provide(layer))
        const directory = AbsolutePath.make(tmp.path)
        const repository = new Git.Repository({
          worktree: directory,
          gitDirectory: directory,
          commonDirectory: directory,
        })
        const result = yield* Effect.exit(
          git.change.apply({
            repository,
            path: directory,
            changes: Git.ChangeSet.make("diff --git a/file.txt b/file.txt\n"),
          }),
        )
        expect(result._tag).toBe("Failure")
        const discarded = yield* Effect.exit(
          git.change.discard({ repository, path: directory, index: "reset", untracked: "remove" }),
        )
        expect(discarded._tag).toBe("Failure")
        expect(processCalls).toBe(0)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

testEffect(Layer.empty).live("refuses unguarded Git mutation and network origins before dispatch", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        let processCalls = 0
        const appProcess = Layer.succeed(
          AppProcess.Service,
          AppProcess.Service.of({
            run: () =>
              Effect.sync(() => {
                processCalls++
                return {
                  command: "git mutation",
                  exitCode: 0,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.alloc(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              }),
            runStream: () => {
              processCalls++
              throw new Error("unexpected process stream")
            },
          } as unknown as AppProcess.Interface),
        )
        const layer = AppNodeBuilder.build(Git.node, [
          [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
          [AppProcess.node, appProcess],
        ])
        const git = yield* Git.Service.pipe(Effect.provide(layer))
        const root = AbsolutePath.make(tmp.path)
        const repository = new Git.Repository({
          worktree: root,
          gitDirectory: root,
          commonDirectory: root,
        })
        const absentGitDirectory = AbsolutePath.make(path.join(tmp.path, "new-git-directory"))
        const attempts: Array<Effect.Effect<unknown, unknown>> = [
          git.repo.clone({
            remote: "https://example.invalid/repo.git",
            directory: AbsolutePath.make(path.join(tmp.path, "clone")),
          }),
          git.repo.create({ worktree: root, gitDirectory: absentGitDirectory }),
          git.sync.fetchRemotes(repository),
          git.sync.fetchBranch(repository, { branch: "main" }),
          git.sync.checkoutRemoteBranch(repository, { branch: "main" }),
          git.sync.resetHard(repository, "HEAD"),
          git.change.apply({
            repository,
            path: root,
            changes: Git.ChangeSet.make("diff --git a/a b/a\n"),
          }),
          git.change.discard({ repository, path: root, index: "reset", untracked: "remove" }),
          git.worktree.create({ repository, directory: AbsolutePath.make(path.join(tmp.path, "linked")) }),
          git.worktree.remove({ repository, directory: root, force: true }),
          git.index.refresh({ repository, scope: RelativePath.make(".") }),
          git.tree.capture({ repository, scopes: [RelativePath.make(".")] }),
          git.tree.write(repository),
          git.tree.preview({
            repository,
            current: Git.TreeID.make("deadbeef"),
            files: new Map(),
          }),
        ]
        const results = yield* Effect.forEach(attempts, (attempt) => Effect.exit(attempt), {
          concurrency: 1,
        })

        expect(results.every((result) => result._tag === "Failure")).toBe(true)
        expect(processCalls).toBe(0)
        const createdPaths = yield* Effect.forEach(
          ["new-git-directory", "clone", "linked"],
          (name) =>
            Effect.promise(async () => {
              try {
                await fs.stat(path.join(tmp.path, name))
                return true
              } catch {
                return false
              }
            }),
          { concurrency: 1 },
        )
        expect(createdPaths).toEqual([false, false, false])
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("fails closed for Git inspection subprocesses before dispatch", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        let processCalls = 0
        const appProcess = Layer.succeed(
          AppProcess.Service,
          AppProcess.Service.of({
            run: () =>
              Effect.sync(() => {
                processCalls++
                return {
                  command: "git",
                  exitCode: 0,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.alloc(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              }),
            runStream: () => {
              processCalls++
              throw new Error("unexpected Git process stream")
            },
          } as unknown as AppProcess.Interface),
        )
        const layer = AppNodeBuilder.build(Git.node, [
          [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
          [AppProcess.node, appProcess],
        ])
        const git = yield* Git.Service.pipe(Effect.provide(layer))
        const directory = AbsolutePath.make(tmp.path)
        const repository = new Git.Repository({
          worktree: directory,
          gitDirectory: directory,
          commonDirectory: directory,
        })
        const inspections: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
          git.remote.get(repository),
          git.history.head(repository),
          git.history.branch(repository),
          git.history.defaultRemoteBranch(repository),
          git.history.rootCommits(repository),
          git.index.ignored({ repository, paths: [RelativePath.make("file.txt")] }),
          git.tree.files({ repository, from: Git.TreeID.make("a".repeat(40)), to: Git.TreeID.make("b".repeat(40)) }),
          git.tree.diff({ repository, from: Git.TreeID.make("a".repeat(40)), to: Git.TreeID.make("b".repeat(40)) }),
          git.tree.readFile({ repository, tree: Git.TreeID.make("a".repeat(40)), path: RelativePath.make("file.txt") }),
          git.worktree.list(repository),
          git.change.capture({ repository, path: directory }),
        ]
        const results = yield* Effect.forEach(inspections, (inspection) => Effect.exit(inspection), {
          concurrency: 1,
        })

        expect(results.some((result) => result._tag === "Failure")).toBe(true)
        expect(processCalls).toBe(0)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
