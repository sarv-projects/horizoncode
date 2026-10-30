import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Database as SQLite } from "bun:sqlite"
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  linkSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import { EventV2 } from "@horizoncode/core/event"
import { configServiceMockDefaults } from "./lib/config"
import { Database } from "@horizoncode/core/database/database"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { Project } from "@horizoncode/core/project"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { SessionInput } from "@horizoncode/core/session/input"
import { SessionV2 } from "@horizoncode/core/session"
import { SessionExecution } from "@horizoncode/core/session/execution"
import { SessionStore } from "@horizoncode/core/session/store"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { SessionTable } from "@horizoncode/core/session/sql"
import { SessionEvent } from "@horizoncode/schema/session-event"
import { SessionID } from "@horizoncode/schema/session-id"
import { SessionMessage } from "@horizoncode/schema/session-message"
import { AbsolutePath } from "@horizoncode/core/schema"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { Prompt } from "@horizoncode/core/session/prompt"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  SessionSupervisorError,
  type GuardApprovalRequest,
} from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"

import { AgentV2 } from "@horizoncode/core/agent"
import { Config } from "@horizoncode/core/config"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { Location } from "@horizoncode/core/location"
import { ReferenceGuidance } from "@horizoncode/core/reference/guidance"
import { SessionRunner } from "@horizoncode/core/session/runner"
import * as SessionRunnerLLM from "@horizoncode/core/session/runner/llm"
import { SessionRunnerModel } from "@horizoncode/core/session/runner/model"
import { SkillGuidance } from "@horizoncode/core/skill/guidance"
import { Snapshot } from "@horizoncode/core/snapshot"
import { SystemContext } from "@horizoncode/core/system-context"
import { SystemContextRegistry } from "@horizoncode/core/system-context/registry"
import { ToolRegistry } from "@horizoncode/core/tool/registry"
import { ToolOutputStore } from "@horizoncode/core/tool-output-store"
import { WriteTool } from "@horizoncode/core/tool/write"
import { LLMClient, LLMEvent, Model, type LLMClientShape } from "@horizoncode/llm"
import * as OpenAIChat from "@horizoncode/llm/protocols/openai-chat"
const rust = resolve(import.meta.dir, "../../../kernel/target/debug/session_sync_probe")
const supervisorRust = resolve(import.meta.dir, "../../../kernel/target/debug/session_supervisor")
const hostKernelRust = resolve(import.meta.dir, "../../../kernel/target/debug/hz-kernel")
const sessionID = SessionID.make("ses_kernel_live_producer")
const messageID = SessionMessage.ID.make("msg_kernel_live_producer")

// The host-scoped kernel owns the durable owner epoch; Core refuses to start the
// projection-only Session supervisor without it, so every live interop case must
// package the real `hz-kernel` binary exactly like `packages/horizoncode/script/build.ts` does.
function hostKernelRuntime(stateDirectory: string) {
  expect(existsSync(hostKernelRust)).toBe(true)
  return {
    hostKernelAssetPath: hostKernelRust,
    hostKernelManifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "hz-kernel",
      target: `linux-${process.arch}-gnu`,
      sha256: createHash("sha256").update(readFileSync(hostKernelRust)).digest("hex"),
    }),
    hostKernelInstallRoot: join(stateDirectory, "host-kernel-install"),
    hostKernelStateRoot: join(stateDirectory, "host-kernel-state"),
  }
}

function observerRuntime(directory: string, stateRoot: string) {
  const sha256 = createHash("sha256").update(readFileSync(supervisorRust)).digest("hex")
  return SessionSupervisor.RuntimeConfig.of({
    assetPath: supervisorRust,
    manifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "session_supervisor",
      target: `linux-${process.arch}-gnu`,
      sha256,
    }),
    installRoot: join(directory, "install"),
    stateRoot,
    ...hostKernelRuntime(directory),
  })
}

function databaseNode(source: string) {
  return makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(source), deps: [] })
}

// hz-kernel owns effect state: one private directory per registered Location
// (`register_location` in kernel/src/host_kernel.rs), never the Session observer's
// `s-<hash>` state directory, which only holds projection metadata.
function hostEffectsDatabase(stateDirectory: string) {
  const locationsRoot = join(stateDirectory, "host-kernel-state", "effect-locations")
  const entries = readdirSync(locationsRoot)
  expect(entries.length).toBe(1)
  return join(locationsRoot, entries[0]!, "effects.sqlite")
}

async function publish(source: string, text: string) {
  const replacement = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(source),
    deps: [],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [[Database.node, replacement]])
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      return yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        text,
      })
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

async function admitAndPromote(source: string, directory = "/projection-test") {
  const replacement = makeGlobalNode({
    service: Database.Service,
    layer: Database.layerFromPath(source),
    deps: [],
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [Database.node, replacement],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "projection-test",
          directory,
          title: "projection test",
          version: "test",
          metadata: { horizonPrincipalOwner: { kind: "server_auth", subject: "projection-test" } },
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const admitted = yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "private prompt text must never replicate" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      return admitted
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

describe("OpenCode EventV2 -> Rust Session supervisor", () => {
  test("Core Effect supervisor authenticates, negotiates, receives and ACKs real OpenCode events", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "x"))
    const source = join(dir, "opencode.db")
    const state = dir
    try {
      const observerDirectory = join(state, `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`)
      const observerSocket = join(observerDirectory, `s-${"0".repeat(16)}.sock`)
      const hostSocket = join(dir, "host-kernel-state", `host-${"0".repeat(16)}.sock`)
      expect(Buffer.byteLength(observerSocket, "utf8")).toBeLessThan(108)
      expect(Buffer.byteLength(hostSocket, "utf8")).toBeLessThan(108)
      await admitAndPromote(source)
      console.log("observer-stage:layer-built")
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]), [
        [Database.node, databaseNode(source)],
        [SessionSupervisor.runtimeConfigNode, Layer.succeed(SessionSupervisor.RuntimeConfig, observerRuntime(dir, state))],
      ])
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            console.log("observer-stage:supervisor-acquired")
            const opened = yield* supervisor.openForSession(sessionID, source)
            console.log("observer-stage:open-complete")
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            const cursor = {
              ownerKind: "session",
              ownerId: sessionID,
              seq: "0",
              eventDigest: "blake3:" + "0".repeat(64),
            }
            yield* Effect.promise(() => client.subscribe(cursor))
            const first = yield* Effect.promise(() => client.receive())
            expect(first.kind).toBe("event")
            if (first.kind !== "event") return
            expect(first.eventType).toBe("session.next.prompt.admitted.1")
            expect(JSON.stringify(first.payload)).not.toContain("private prompt text")
            const rejectedOutOfOrderAck = yield* Effect.promise(() =>
              client
                .ack({
                  ...first,
                  cursor: { ...first.cursor, seq: "2" },
                })
                .then(
                  () => false,
                  (error: unknown) => error instanceof Error && error.message.includes("oldest delivered event"),
                ),
            )
            expect(rejectedOutOfOrderAck).toBe(true)
            yield* Effect.promise(() => client.ack(first))
            const second = yield* Effect.promise(() => client.receive())
            expect(second.kind).toBe("event")
            if (second.kind !== "event") return
            expect(second.eventType).toBe("session.next.prompted.1")
            yield* Effect.promise(() => client.ack(second))
            const pageEnd = yield* Effect.promise(() => client.receive())
            expect(pageEnd).toMatchObject({ kind: "page_end", through: second.cursor, hasMore: false })
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume).toEqual(second.cursor)
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume.seq).toBe("2")
            const rejectedCursorRollback = yield* Effect.promise(() =>
              client
                .subscribe({
                  ownerKind: "session",
                  ownerId: sessionID,
                  seq: "0",
                  eventDigest: "blake3:" + "0".repeat(64),
                })
                .then(
                  () => false,
                  (error: unknown) => error instanceof Error && error.message.includes("durable acknowledged cursor"),
                ),
            )
            expect(rejectedCursorRollback).toBe(true)
            yield* Effect.promise(() => client.subscribe())
            const pageEnd = yield* Effect.promise(() => client.receive())
            expect(pageEnd).toMatchObject({ kind: "page_end", through: resume, hasMore: false })
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      const sessionState = join(state, `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`)
      const checkpoint = join(sessionState, `session-${sessionID}.cursor`)
      unlinkSync(checkpoint)
      symlinkSync(source, checkpoint)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            const rejected = yield* Effect.promise(() =>
              client.resumeCursor().then(
                () => false,
                (error: unknown) => error instanceof Error && error.message.includes("cursor file is unsafe"),
              ),
            )
            expect(rejected).toBe(true)
            unlinkSync(checkpoint)
            writeFileSync(checkpoint, "{malformed", { mode: 0o600 })
            const rejectedMalformed = yield* Effect.promise(() =>
              client.resumeCursor().then(
                () => false,
                (error: unknown) => error instanceof Error && error.message.includes("cursor is malformed"),
              ),
            )
            expect(rejectedMalformed).toBe(true)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("Core Effect admits and settles a files.write through Rust Guard and ExecutionHost", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-session-effect-write-"))
    const source = join(dir, "opencode.db")
    const workspacePath = join(dir, "workspace")
    const installRoot = join(dir, "install")
    const stateRoot = join(dir, "state")
    try {
      mkdirSync(workspacePath)
      const workspace = realpathSync(workspacePath)
      await admitAndPromote(source, workspace)
      const sha256 = createHash("sha256").update(readFileSync(supervisorRust)).digest("hex")
      const runtime = Layer.succeed(
        SessionSupervisor.RuntimeConfig,
        SessionSupervisor.RuntimeConfig.of({
          assetPath: supervisorRust,
          manifestJSON: JSON.stringify({
            schemaVersion: 1,
            status: "available",
            binaryName: "session_supervisor",
            target: `linux-${process.arch}-gnu`,
            sha256,
          }),
          installRoot,
          stateRoot,
          ...hostKernelRuntime(dir),
        }),
      )
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node, EventV2.node]), [
        [Database.node, databaseNode(source)],
        [SessionSupervisor.runtimeConfigNode, runtime],
      ]).pipe(Layer.merge(Layer.succeed(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "projection-test" } })))
      const content = "TypeScript-to-Rust guarded workspace write"
      const target = join(workspace, "approved.txt")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const events = yield* EventV2.Service
            const turnComplete = yield* Ref.make(false)
            const ready = yield* Deferred.make<void, SessionSupervisorError>()
            const watcher = yield* Effect.forkScoped(
              supervisor.watchSession(sessionID, source, workspace, turnComplete, ready),
            )
            yield* Deferred.await(ready)
            // `prepareToolBatch` blocks on a `guard.approval.requested` decision that only a
            // concurrent approval surface can supply; the preparing fiber can never reply to
            // its own request (arch_V1/14-EFFECTS-EXECUTION-SECURITY.md).
            const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
            yield* events.listen((event) => {
              if (event.type === GuardApprovalRequested.type) {
                Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
              }
              return Effect.void
            })
            const responder = yield* Effect.forkScoped(
              Effect.gen(function* () {
                const request = yield* Queue.take(approvals)
                yield* supervisor.replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
              }),
            )
            const locationRef = {
              directory: AbsolutePath.make(workspace),
              workspaceID: WorkspaceV2.ID.make("wrk_projection_test"),
            }
            const admission = yield* supervisor.prepareToolBatch({
              sessionID,
              locationRef,
              batchID: "batch_typescript_interop",
              turnContextDigest: `sha256:${"c".repeat(64)}`,
              calls: [
                {
                  callID: "call_typescript_write",
                  capabilityID: "files.write",
                  arguments: { path: "approved.txt", content },
                },
              ],
            })
            expect(admission.status).toBe("prepared")
            if (admission.status !== "prepared") return
            const receipt = yield* supervisor.executeWrite({
              sessionID,
              locationRef,
              lease: admission.lease,
              content,
              trustedPrincipal: { kind: "server_auth", subject: "projection-test" },
            })
            expect(receipt.effectID).toBe(admission.lease.effectID)
            expect(receipt.target).toBe(target)
            expect(receipt.resource).toBe("approved.txt")
            expect(receipt.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
            // The one-use capability lease was consumed by the first execution, so the same
            // lease must never settle the effect a second time.
            const replay = yield* Effect.exit(
              supervisor.executeWrite({
                sessionID,
                locationRef,
                lease: admission.lease,
                content,
                trustedPrincipal: { kind: "server_auth", subject: "projection-test" },
              }),
            )
            expect(Exit.isFailure(replay)).toBe(true)
            yield* Ref.set(turnComplete, true)
            yield* Fiber.join(watcher)
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(readFileSync(target, "utf8")).toBe(content)
      expect(readFileSync(hostEffectsDatabase(dir)).includes(Buffer.from(content))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("SessionRunner binds its generated digest through Rust effects.v2 and denies multi-write batches", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-session-runner-effect-"))
    const source = join(dir, "opencode.db")
    const workspacePath = join(dir, "workspace")
    const installRoot = join(dir, "install")
    const stateRoot = join(dir, "state")
    const content = "PRIVATE_SESSION_RUNNER_EFFECT_CONTENT"
    const deniedBatch = [
      { id: "call_session_runner_batch_first", path: "batch-first.txt", content: "PRIVATE_BATCH_FIRST_CONTENT" },
      { id: "call_session_runner_batch_second", path: "batch-second.txt", content: "PRIVATE_BATCH_SECOND_CONTENT" },
    ] as const
    const target = join(workspacePath, "approved.txt")
    try {
      mkdirSync(workspacePath)
      const workspace = realpathSync(workspacePath)
      await admitAndPromote(source, workspace)
      const sha256 = createHash("sha256").update(readFileSync(supervisorRust)).digest("hex")
      const runtime = Layer.succeed(
        SessionSupervisor.RuntimeConfig,
        SessionSupervisor.RuntimeConfig.of({
          assetPath: supervisorRust,
          manifestJSON: JSON.stringify({
            schemaVersion: 1,
            status: "available",
            binaryName: "session_supervisor",
            target: `linux-${process.arch}-gnu`,
            sha256,
          }),
          installRoot,
          stateRoot,
          ...hostKernelRuntime(dir),
        }),
      )
      const databaseNode = makeGlobalNode({
        service: Database.Service,
        layer: Database.layerFromPath(source),
        deps: [],
      })
      const fakeModel = Model.make({ id: "guard-test-model", provider: "test", route: OpenAIChat.route })
      const model = Layer.succeed(
        SessionRunnerModel.Service,
        SessionRunnerModel.Service.of({
          resolve: () => Effect.succeed(fakeModel),
          resolveSelection: () =>
            Effect.succeed({
              model: fakeModel,
              directProviderRoute: {
                providerID: "test",
                modelID: "guard-test-model",
                routeID: "route-test",
                routeRevision: "1",
                endpointRevision: "1",
                endpointBase: "https://test.provider/v1",
              },
            }),
        }),
      )
      const responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call_session_runner_write",
            name: "write",
            input: { path: "approved.txt", content },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          ...deniedBatch.map((call) =>
            LLMEvent.toolCall({
              id: call.id,
              name: "write",
              input: { path: call.path, content: call.content },
            }),
          ),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "File written; unsupported batch denied." }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const client = Layer.succeed(
        LLMClient.Service,
        LLMClient.Service.of({
          prepare: () => Effect.die("unused"),
          stream: (() => Stream.fromIterable((responses.shift() ?? []) as never[])) as unknown as LLMClientShape["stream"],
          generate: () => Effect.die("unused"),
        }),
      )
      const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
      const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
      const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
        load: () => Effect.succeed(SystemContext.empty),
      })
      const config = Layer.succeed(Config.Service, Config.Service.of({ ...configServiceMockDefaults, entries: () => Effect.succeed([]) }))
      const layer = AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          SessionProjector.node,
          SessionStore.node,
          AgentV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          SessionRunnerModel.node,
          SystemContextRegistry.node,
          SkillGuidance.node,
          ReferenceGuidance.node,
          Config.node,
          Snapshot.node,
          SessionRunnerLLM.node,
          WriteTool.node,
          SessionSupervisor.node,
        ]),
        [
          [Database.node, databaseNode],
          [LayerNodePlatform.llmClient, client],
          [SessionRunnerModel.node, model],
          [SystemContextRegistry.node, systemContext],
          [Location.node, Location.boundNode({ directory: AbsolutePath.make(workspace) })],
          [SkillGuidance.node, skillGuidance],
          [ReferenceGuidance.node, referenceGuidance],
          [Config.node, config],
          [Snapshot.node, Snapshot.noopLayer],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [SessionSupervisor.runtimeConfigNode, runtime],
        ],
      ).pipe(Layer.merge(Layer.succeed(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "projection-test" } })))
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const agents = yield* AgentV2.Service
            yield* agents.transform((editor) =>
              editor.update(AgentV2.ID.make("build"), (agent) => {
                agent.permissions = [{ action: "edit", resource: "*", effect: "allow" }]
              }),
            )
            const supervisor = yield* SessionSupervisor.Service
            const database = yield* Database.Service
            const runner = yield* SessionRunner.Service
            const turnComplete = yield* Ref.make(false)
            const ready = yield* Deferred.make<void, SessionSupervisorError>()
            const watcher = yield* Effect.forkScoped(
              supervisor.watchSession(sessionID, database.path, workspace, turnComplete, ready),
            )
            yield* Deferred.await(ready)
            const duplicateReady = yield* Deferred.make<void, SessionSupervisorError>()
            const duplicate = yield* Effect.exit(
              supervisor.watchSession(sessionID, database.path, workspace, turnComplete, duplicateReady),
            ).pipe(Effect.timeoutOption("2 seconds"))
            expect(Option.isSome(duplicate)).toBe(true)
            if (Option.isNone(duplicate)) return yield* Effect.die("duplicate observer did not fail promptly")
            expect(Exit.isFailure(duplicate.value)).toBe(true)
            if (Exit.isFailure(duplicate.value)) {
              expect(Option.getOrUndefined(Cause.findErrorOption(duplicate.value.cause))).toMatchObject({
                stage: "ownership",
                reason: "another Rust observer already owns this Session",
              })
            }
            // The approval surface answers `guard.approval.requested` concurrently with the
            // preparing fiber; single-write batches are allowed, multi-write batches denied.
            const events = yield* EventV2.Service
            const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
            yield* events.listen((event) => {
              if (event.type === GuardApprovalRequested.type) {
                Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
              }
              return Effect.void
            })
            const responder = yield* Effect.forkScoped(
              Effect.gen(function* () {
                for (;;) {
                  const request = yield* Queue.take(approvals)
                  const decision = request.normalizedTargets.length > 1 ? ("deny" as const) : ("allow_once" as const)
                  yield* supervisor
                    .replyGuardApproval({ approvalID: request.approvalID, decision })
                    .pipe(Effect.catch(() => Effect.void))
                }
              }),
            )
            yield* runner.run({ sessionID, force: true })
            yield* Ref.set(turnComplete, true)
            yield* Fiber.join(watcher)

            const store = yield* SessionStore.Service
            const transcript = yield* store.context(sessionID)
            const writeCall = transcript
              .flatMap((message) => (message.type === "assistant" ? message.content : []))
              .find((part) => part.type === "tool" && part.id === "call_session_runner_write")
            expect(writeCall).toMatchObject({ type: "tool", state: { status: "completed" } })
            expect(readFileSync(target, "utf8")).toBe(content)
            const transcriptParts = transcript.flatMap((message) =>
              message.type === "assistant" ? message.content : [],
            )
            for (const call of deniedBatch) {
              expect(
                transcriptParts.find((part) => part.type === "tool" && part.id === call.id),
              ).toMatchObject({ type: "tool", id: call.id, state: { status: "error" } })
              expect(existsSync(join(workspace, call.path))).toBe(false)
            }

            const effectsDatabasePath = hostEffectsDatabase(dir)
            expect(readFileSync(effectsDatabasePath).includes(Buffer.from(content))).toBe(false)
            for (const call of deniedBatch) {
              expect(readFileSync(effectsDatabasePath).includes(Buffer.from(call.content))).toBe(false)
            }
            const effectsDatabase = new SQLite(effectsDatabasePath, { readonly: true, strict: true })
            let effectID: string
            try {
              const row = effectsDatabase
                .query("SELECT effect_id, turn_context_digest, status FROM effect_challenges WHERE status = 'SETTLED'")
                .get() as { effect_id: string; turn_context_digest: string; status: string } | null
              expect(row).toBeDefined()
              if (!row) return yield* Effect.die("Expected a settled Rust effect challenge")
              expect(row.status).toBe("SETTLED")
              expect(row.turn_context_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
              expect(row.turn_context_digest).not.toBe(`sha256:${"c".repeat(64)}`)
              effectID = row.effect_id
            } finally {
              effectsDatabase.close()
            }

            const replayTurnComplete = yield* Ref.make(false)
            const replayReady = yield* Deferred.make<void, SessionSupervisorError>()
            const replayWatcher = yield* Effect.forkScoped(
              supervisor.watchSession(sessionID, database.path, workspace, replayTurnComplete, replayReady),
            )
            yield* Deferred.await(replayReady)
            // The settled effect's capability lease was consumed on execution, so replaying
            // the same effect identity must never settle a second write.
            const replay = yield* Effect.exit(
              supervisor.executeWrite({
                sessionID,
                locationRef: { directory: AbsolutePath.make(workspace) },
                lease: { effectID, capabilityLeaseDigest: `blake3:${"0".repeat(64)}` },
                content,
                trustedPrincipal: { kind: "server_auth", subject: "projection-test" },
              }),
            )
            expect(Exit.isFailure(replay)).toBe(true)
            yield* Ref.set(replayTurnComplete, true)
            yield* Fiber.join(replayWatcher)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("Effect scope interruption releases the process lease and permits restart", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-session-supervisor-cancel-"))
    const source = join(dir, "opencode.db")
    const state = join(dir, "supervisor")
    try {
      await admitAndPromote(source)
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]), [
        [Database.node, databaseNode(source)],
        [SessionSupervisor.runtimeConfigNode, Layer.succeed(SessionSupervisor.RuntimeConfig, observerRuntime(dir, state))],
      ])
      const sessionState = join(state, `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`)
      const started = await Effect.runPromise(Deferred.make<void>())
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            yield* Effect.promise(() =>
              client.subscribe({
                ownerKind: "session",
                ownerId: sessionID,
                seq: "0",
                eventDigest: "blake3:" + "0".repeat(64),
              }),
            )
            const first = yield* Effect.promise(() => client.receive())
            expect(first.kind).toBe("event")
            if (first.kind !== "event") return
            yield* Effect.promise(() => client.ack(first))
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.provide(layer)),
        ),
      )
      await Effect.runPromise(Deferred.await(started))
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(readdirSync(sessionState).filter((name) => name.endsWith(".sock"))).toEqual([])
      expect(await Bun.file(join(sessionState, "supervisor.epoch")).text()).toBe("1")
      expect(existsSync(join(sessionState, `session-${sessionID}.cursor`))).toBe(false)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            const resume = yield* Effect.promise(() => client.resumeCursor())
            expect(resume).toEqual({
              ownerKind: "session",
              ownerId: sessionID,
              seq: "0",
              eventDigest: "blake3:" + "0".repeat(64),
            })
            yield* Effect.promise(() => client.subscribe())
            for (const expected of ["session.next.prompt.admitted.1", "session.next.prompted.1"]) {
              const event = yield* Effect.promise(() => client.receive())
              expect(event.kind).toBe("event")
              if (event.kind !== "event") return
              expect(event.eventType).toBe(expected)
              yield* Effect.promise(() => client.ack(event))
            }
            const end = yield* Effect.promise(() => client.receive())
            expect(end.kind).toBe("page_end")
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(await Bun.file(join(sessionState, "supervisor.epoch")).text()).toBe("2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("observer restart after an unacked mid-stream event replays exactly once", async () => {
    expect(existsSync(supervisorRust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "x"))
    const source = join(dir, "opencode.db")
    const state = join(dir, "supervisor")
    try {
      await admitAndPromote(source)
      const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]), [
        [Database.node, databaseNode(source)],
        [SessionSupervisor.runtimeConfigNode, Layer.succeed(SessionSupervisor.RuntimeConfig, observerRuntime(dir, state))],
      ])
      const sessionState = join(state, `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`)
      const started = await Effect.runPromise(Deferred.make<void>())
      const fiber = Effect.runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            yield* Effect.promise(() =>
              opened.client.subscribe({
                ownerKind: "session",
                ownerId: sessionID,
                seq: "0",
                eventDigest: "blake3:" + "0".repeat(64),
              }),
            )
            const first = yield* Effect.promise(() => opened.client.receive())
            expect(first.kind).toBe("event")
            if (first.kind !== "event") return
            expect(first.eventType).toBe("session.next.prompt.admitted.1")
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.provide(layer)),
        ),
      )
      await Effect.runPromise(Deferred.await(started))
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(readdirSync(sessionState).filter((name) => name.endsWith(".sock"))).toEqual([])
      expect(await Bun.file(join(sessionState, "supervisor.epoch")).text()).toBe("1")
      expect(existsSync(join(sessionState, `session-${sessionID}.cursor`))).toBe(false)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const client = opened.client
            expect(yield* Effect.promise(() => client.resumeCursor())).toEqual({
              ownerKind: "session",
              ownerId: sessionID,
              seq: "0",
              eventDigest: "blake3:" + "0".repeat(64),
            })
            yield* Effect.promise(() => client.subscribe())
            const expected = ["session.next.prompt.admitted.1", "session.next.prompted.1"]
            const cursors = []
            for (const eventType of expected) {
              const event = yield* Effect.promise(() => client.receive())
              expect(event.kind).toBe("event")
              if (event.kind !== "event") return
              expect(event.eventType).toBe(eventType)
              cursors.push(event.cursor)
              yield* Effect.promise(() => client.ack(event))
            }
            const end = yield* Effect.promise(() => client.receive())
            expect(end).toMatchObject({ kind: "page_end", through: cursors[1], hasMore: false })
            yield* Effect.promise(() => client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(await Bun.file(join(sessionState, `session-${sessionID}.cursor`)).text()).toContain('"seq":"2"')

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* SessionSupervisor.Service
            const opened = yield* supervisor.openForSession(sessionID, source)
            if (opened.status !== "available") return yield* Effect.fail(new Error(opened.reason))
            const resume = yield* Effect.promise(() => opened.client.resumeCursor())
            expect(resume.seq).toBe("2")
            yield* Effect.promise(() => opened.client.subscribe())
            const end = yield* Effect.promise(() => opened.client.receive())
            expect(end).toMatchObject({ kind: "page_end", through: resume, hasMore: false })
            yield* Effect.promise(() => opened.client.unsubscribe())
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(await Bun.file(join(sessionState, "supervisor.epoch")).text()).toBe("3")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("persists real prompt admission and promotion events with replay parity", async () => {
    expect(existsSync(rust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-prompt-live-"))
    const source = join(dir, "opencode.db")
    const target = join(dir, "projection.db")
    try {
      const admitted = await admitAndPromote(source)
      expect(admitted.admittedSeq).toBe(0)
      const child = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
      const projection = new SQLite(target, { readonly: true, strict: true })
      try {
        const events = projection
          .query("SELECT kind,message_id,seq FROM hc_session_receipts ORDER BY seq")
          .all() as Array<{ kind: string; message_id: string | null; seq: number }>
        expect(events).toEqual([
          { kind: "session.next.prompt.admitted.1", message_id: messageID, seq: 0 },
          { kind: "session.next.prompted.1", message_id: messageID, seq: 1 },
        ])
        expect(JSON.stringify(events)).not.toContain("private prompt text")
      } finally {
        projection.close()
      }
      const restart = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await restart.exited).toBe(0)
      expect(await new Response(restart.stdout).text()).toContain("imported=0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  test("streams committed OpenCode events in WAL mode, redacts content, and replays after restart", async () => {
    expect(existsSync(rust)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), "hc-opencode-live-"))
    const source = join(dir, "opencode.db")
    const target = join(dir, "projection.db")
    try {
      await publish(source, "private first message must not replicate")
      const child = Bun.spawn([rust, source, target, sessionID, "--follow", "--poll-ms=50", "--max-polls=35"], {
        stdout: "pipe", stderr: "pipe",
      })
      try {
        await Bun.sleep(180)
        await publish(source, "private second message must not replicate")
        await Bun.sleep(180)
        await publish(source, "private third message must not replicate")
        expect(await child.exited).toBe(0)
        await new Response(child.stdout).text()
        const errors = await new Response(child.stderr).text()
        expect(errors).toBe("")
        const db = new SQLite(target, { readonly: true, strict: true })
        try {
          const values = db.query("SELECT kind,message_id,tool_call_id,seq FROM hc_session_receipts ORDER BY seq").all() as Array<{
            kind:string; message_id:string | null; tool_call_id:string | null; seq:number
          }>
          expect(values.length).toBe(3)
          expect(values.map((v) => v.seq)).toEqual([0,1,2])
          expect(values.every((v) => v.message_id === messageID)).toBe(true)
          expect(values.every((v) => v.kind === "session.next.context.updated.1")).toBe(true)
          expect(JSON.stringify(values)).not.toContain("private")
        } finally { db.close() }
        const restart = Bun.spawn([rust,source,target,sessionID],{ stdout:"pipe", stderr:"pipe" })
        expect(await restart.exited).toBe(0)
        expect(await new Response(restart.stdout).text()).toContain("imported=0")
      } finally {
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    } finally {
      rmSync(dir,{recursive:true,force:true})
    }
  }, 20000)
})


test("refuses same file or hardlink for projection database", async () => {
  expect(existsSync(rust)).toBe(true)
  const directory = mkdtempSync(join(tmpdir(), "hc-projection-isolation-"))
  const source = join(directory, "opencode.db")
  try {
    await publish(source, "private source must be preserved")
    const alias = join(directory, "hardlink.db")
    linkSync(source, alias)
    for (const target of [source, alias]) {
      const child = Bun.spawn([rust, source, target, sessionID], { stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).not.toBe(0)
      const reason = await new Response(child.stderr).text()
      expect(reason).toContain("Source and destination")
    }
    const db = new SQLite(source, { readonly: true, strict: true })
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n).toBe(1)
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hc_session_receipts'").get()).toBeNull()
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)

test("bundled Session observer installs the pinned artifact and resumes its ACK cursor", async () => {
  expect(existsSync(supervisorRust)).toBe(true)
  const directory = mkdtempSync(join(tmpdir(), "hc-session-observer-install-"))
  const source = join(directory, "opencode.db")
  const sha256 = createHash("sha256").update(readFileSync(supervisorRust)).digest("hex")
  try {
    await admitAndPromote(source)
    const runtime = Layer.succeed(
      SessionSupervisor.RuntimeConfig,
      SessionSupervisor.RuntimeConfig.of({
        assetPath: supervisorRust,
        manifestJSON: JSON.stringify({
          schemaVersion: 1,
          status: "available",
          binaryName: "session_supervisor",
          target: `linux-${process.arch}-gnu`,
          sha256,
        }),
        installRoot: join(directory, "install"),
        stateRoot: join(directory, "state"),
        ...hostKernelRuntime(directory),
      }),
    )
    const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]), [
      [Database.node, databaseNode(source)],
      [SessionSupervisor.runtimeConfigNode, runtime],
    ])
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* SessionSupervisor.Service
          const opened = yield* supervisor.openForSession(sessionID, source)
          expect(opened.status).toBe("available")
          if (opened.status !== "available") return
          yield* Effect.tryPromise({ try: () => opened.client.subscribe(), catch: (error) => error as Error })
          let events = 0
          while (true) {
            const message = yield* Effect.tryPromise({
              try: () => opened.client.receive(),
              catch: (error) => error as Error,
            })
            if (message.kind === "event") {
              events++
              expect(JSON.stringify(message.payload)).not.toContain("private prompt text")
              yield* Effect.tryPromise({
                try: () => opened.client.ack(message),
                catch: (error) => error as Error,
              })
              continue
            }
            expect(message.kind).toBe("page_end")
            if (message.kind === "page_end") {
              expect(message.hasMore).toBe(false)
              expect(message.through.seq).toBe("2")
            }
            break
          }
          expect(events).toBe(2)
          expect((yield* Effect.tryPromise({
            try: () => opened.client.resumeCursor(),
            catch: (error) => error as Error,
          })).seq).toBe("2")
        }).pipe(Effect.provide(layer)),
      ),
    )
    const installed = join(directory, "install", `session_supervisor-${sha256}`)
    expect((lstatSync(installed).mode & 0o777).toString(8)).toBe("700")
    expect(createHash("sha256").update(readFileSync(installed)).digest("hex")).toBe(sha256)
    const sessionState = join(directory, "state", `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`)
    expect(readdirSync(sessionState).filter((name) => name.endsWith(".sock"))).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)

test("bundled Session observer refuses a sidecar that differs from its manifest", async () => {
  expect(existsSync(supervisorRust)).toBe(true)
  const directory = mkdtempSync(join(tmpdir(), "hc-session-observer-pin-"))
  const source = join(directory, "opencode.db")
  try {
    await admitAndPromote(source)
    const runtime = Layer.succeed(
      SessionSupervisor.RuntimeConfig,
      SessionSupervisor.RuntimeConfig.of({
        assetPath: supervisorRust,
        manifestJSON: JSON.stringify({
          schemaVersion: 1,
          status: "available",
          binaryName: "session_supervisor",
          target: `linux-${process.arch}-gnu`,
          sha256: "0".repeat(64),
        }),
        installRoot: join(directory, "install"),
        stateRoot: join(directory, "state"),
        ...hostKernelRuntime(directory),
      }),
    )
    const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node]), [
      [Database.node, databaseNode(source)],
      [SessionSupervisor.runtimeConfigNode, runtime],
    ])
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* SessionSupervisor.Service
          return yield* Effect.exit(supervisor.openForSession(sessionID, source))
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(existsSync(join(directory, "install"))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)

test("a Session has one process-wide execution owner class with scope-based recovery", async () => {
  const ownerID = SessionID.make("ses_process_execution_owner")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* SessionSupervisor.acquireExecutionOwner(ownerID, "core-v2")
        const nested = yield* Effect.scoped(
          SessionSupervisor.acquireExecutionOwner(ownerID, "core-v2"),
        ).pipe(Effect.exit)
        expect(Exit.isSuccess(nested)).toBe(true)
        const conflict = yield* Effect.scoped(
          SessionSupervisor.acquireExecutionOwner(ownerID, "opencode-v1"),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(conflict)).toBe(true)
        if (Exit.isFailure(conflict)) {
          const error = Cause.findErrorOption(conflict.cause)
          expect(Option.getOrUndefined(error)).toMatchObject({
            stage: "ownership",
            reason: "another execution already owns this Session",
          })
        }
      }),
    ),
  )
  await Effect.runPromise(Effect.scoped(SessionSupervisor.acquireExecutionOwner(ownerID, "opencode-v1")))

  const interruptedID = SessionID.make("ses_process_execution_owner_cancel")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const holder = yield* Effect.gen(function* () {
          yield* SessionSupervisor.acquireExecutionOwner(interruptedID, "core-v2")
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }).pipe(Effect.scoped, Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(holder)
        yield* Effect.scoped(SessionSupervisor.acquireExecutionOwner(interruptedID, "opencode-v1"))
      }),
    ),
  )
})
