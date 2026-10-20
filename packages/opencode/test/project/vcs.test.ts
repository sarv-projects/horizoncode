import { afterAll, afterEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { GuardApprovalRequested, type GuardApprovalRequest } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { parsePatch } from "diff"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue } from "effect"
import fs from "fs/promises"
import path from "path"
import {
  provideInstance,
  requireInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const rustTestRoot = mkdtempSync(path.join(tmpdir(), "hc-vcs-guard-"))
const testDatabasePath = path.join(rustTestRoot, "opencode.db")
const testDatabaseNode = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(testDatabasePath),
  deps: [],
})
const supervisorBinary = path.resolve(import.meta.dir, "../../../../kernel/target/debug/session_supervisor")
const supervisorAvailable = process.platform === "linux" && existsSync(supervisorBinary)
const supervisorDigest = supervisorAvailable
  ? createHash("sha256").update(readFileSync(supervisorBinary)).digest("hex")
  : undefined
const hostKernelBinary = path.resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel")
const hostKernelAvailable = process.platform === "linux" && existsSync(hostKernelBinary)
const hostKernelDigest = hostKernelAvailable
  ? createHash("sha256").update(readFileSync(hostKernelBinary)).digest("hex")
  : undefined
const supervisorRuntime = Layer.succeed(
  SessionSupervisor.RuntimeConfig,
  SessionSupervisor.RuntimeConfig.of({
    assetPath: supervisorAvailable ? supervisorBinary : undefined,
    manifestJSON: supervisorDigest
      ? JSON.stringify({
          schemaVersion: 1,
          status: "available",
          binaryName: "session_supervisor",
          target: `linux-${process.arch}-gnu`,
          sha256: supervisorDigest,
        })
      : undefined,
    installRoot: path.join(rustTestRoot, "install"),
    stateRoot: path.join(rustTestRoot, "state"),
    hostKernelAssetPath: hostKernelAvailable ? hostKernelBinary : undefined,
    hostKernelManifestJSON: hostKernelDigest
      ? JSON.stringify({
          schemaVersion: 1,
          status: "available",
          binaryName: "hz-kernel",
          target: `linux-${process.arch}-gnu`,
          sha256: hostKernelDigest,
        })
      : undefined,
    hostKernelInstallRoot: path.join(rustTestRoot, "install-hz-kernel"),
    hostKernelStateRoot: path.join(rustTestRoot, "state-hz-kernel"),
  }),
)
const localOnlyRuntime = Layer.succeed(
  SessionSupervisor.RuntimeConfig,
  SessionSupervisor.RuntimeConfig.of({
    installRoot: path.join(rustTestRoot, "install"),
    stateRoot: path.join(rustTestRoot, "state"),
    hostKernelInstallRoot: path.join(rustTestRoot, "install-hz-kernel"),
    hostKernelStateRoot: path.join(rustTestRoot, "state-hz-kernel"),
  }),
)
const makeLayer = (runtime: typeof supervisorRuntime) =>
  AppNodeBuilder.build(
  LayerNode.group([
    Vcs.node,
    Git.node,
    EventV2Bridge.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Database.node,
    AppProcess.node,
    SessionSupervisor.node,
    SessionSupervisor.runtimeConfigNode,
    Session.node,
    SessionRunState.node,
    SessionProjector.node,
    SessionStatus.node,
    BackgroundJob.node,
    RuntimeFlags.node,
  ]),
  [
    [Database.node, testDatabaseNode],
    [SessionSupervisor.runtimeConfigNode, runtime],
  ],
)
const layer = makeLayer(localOnlyRuntime)
const hostKernelLayer = makeLayer(supervisorRuntime)
const it = testEffect(layer)
const hostKernelIt = testEffect(hostKernelLayer)
const withRustSupervisor = supervisorAvailable && hostKernelAvailable ? hostKernelIt.instance : hostKernelIt.instance.skip
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))
afterEach(async () => {
  await resetDatabase(testDatabasePath)
})

afterAll(async () => {
  await fs.rm(rustTestRoot, { recursive: true, force: true })
})

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        execFile(
          "git",
          ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", ...args],
          { cwd },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(`git ${args.join(" ")} failed: ${stderr}`))
            else resolve()
          },
        )
      }),
  )
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  it.instance("does not expose arbitrary Git subprocess execution", () =>
    Effect.gen(function* () {
      const service = yield* Git.Service
      expect("run" in service).toBe(false)
    }),
  )

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
})

describe("Vcs apply", () => {
  withRustSupervisor(
    "applies an exact patch through Rust Guard and rejects stale preimages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "apply.txt")
        yield* write(file, "before\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "apply fixture"])
        const instance = yield* requireInstance
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({
            id: instance.project.id,
            worktree: AbsolutePath.make(test.directory),
            vcs: "git",
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "guarded VCS apply" })
        const supervisor = yield* SessionSupervisor.Service
        const events = yield* EventV2Bridge.Service
        const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
        const projectionError = yield* Deferred.make<string | undefined>()
        const off = yield* events.listen((event) => {
          if (event.type === GuardApprovalRequested.type) {
            Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        const approval = yield* Effect.forkChild(
          Effect.gen(function* () {
            const request = yield* Queue.take(approvals)
            const missing: string[] = []
            if (request.capabilityID !== "files.patch") missing.push("capabilityID")
            if (request.sessionID !== session.id) missing.push("sessionID")
            if (request.origin !== "session_batch") missing.push("origin")
            if (request.source !== "core.tool_batch") missing.push("source")
            if (request.policyID !== "workspace-write.local.v1") missing.push("policyID")
            if (request.normalizedAction !== "files.patch") missing.push("normalizedAction")
            if (request.argumentSummary?.status !== "available") missing.push("argumentSummary")
            if (request.guaranteeAssessment?.status !== "assessed") missing.push("guaranteeAssessment")
            if (request.allowEnabled !== true) missing.push("allowEnabled")
            yield* Deferred.succeed(projectionError, missing.length ? `Guard projection missing: ${missing.join(", ")}` : undefined)
            if (missing.length) {
              yield* supervisor
                .replyGuardApproval({ approvalID: request.approvalID, decision: "deny" })
                .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "host_os" } }))
              return
            }
            yield* supervisor
              .replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
              .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "host_os" } }))
          }),
        )
        const vcs = yield* init()
        const patch = [
          "diff --git a/apply.txt b/apply.txt",
          "index 0000000..0000000 100644",
          "--- a/apply.txt",
          "+++ b/apply.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n")
        const appliedExit = yield* Effect.exit(vcs.apply({ sessionID: session.id, patch }))
        const projectionIssue = yield* Deferred.await(projectionError)
        expect(projectionIssue).toBeUndefined()
        if (Exit.isFailure(appliedExit)) return yield* Effect.fail(Cause.squash(appliedExit.cause))
        const applied = appliedExit.value
        yield* Fiber.join(approval)
        expect(applied.applied).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("after\n")

        yield* write(file, "external\n")
        const stale = yield* Effect.flip(vcs.apply({ sessionID: session.id, patch }))
        expect(stale.reason).toBe("stale")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("external\n")
      }),
    { git: true },
    20_000,
  )
})
