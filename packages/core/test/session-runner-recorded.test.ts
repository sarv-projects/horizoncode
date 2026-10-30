import { HttpRecorder } from "@horizoncode/http-recorder"
import { HttpRecorderInternal } from "@horizoncode/http-recorder/internal"
import * as OpenAIChat from "@horizoncode/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@horizoncode/llm/route"
import { createHash } from "node:crypto"
import { Database } from "@horizoncode/core/database/database"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@horizoncode/core/effect/app-node-platform"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { EventV2 } from "@horizoncode/core/event"
import { EventTable } from "@horizoncode/core/event/sql"
import { PermissionV2 } from "@horizoncode/core/permission"
import { AgentV2 } from "@horizoncode/core/agent"
import { Config } from "@horizoncode/core/config"
import { Project } from "@horizoncode/core/project"
import { ProjectTable } from "@horizoncode/core/project/sql"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionV2 } from "@horizoncode/core/session"
import { Snapshot } from "@horizoncode/core/snapshot"
import { Prompt } from "@horizoncode/core/session/prompt"
import { SessionProjector } from "@horizoncode/core/session/projector"
import { SessionExecution } from "@horizoncode/core/session/execution"
import * as SessionExecutionLocal from "@horizoncode/core/session/execution/local"
import * as SessionRunnerLLM from "@horizoncode/core/session/runner/llm"
import { SessionRunnerModel } from "@horizoncode/core/session/runner/model"
import { ToolRegistry } from "@horizoncode/core/tool/registry"
import { ToolOutputStore } from "@horizoncode/core/tool-output-store"
import { SessionInput } from "@horizoncode/core/session/input"
import { SessionTable } from "@horizoncode/core/session/sql"
import { SessionStore } from "@horizoncode/core/session/store"
import { buildLocationServiceMap, LocationServiceMap } from "@horizoncode/core/location-services"
import { SessionSupervisor, SessionSupervisorError } from "@horizoncode/core/session/supervisor"
import { Location } from "@horizoncode/core/location"
import { InstanceRef } from "../../horizoncode/src/effect/instance-ref"
import { BackgroundJob } from "../../horizoncode/src/background/job"
import { SessionRunState } from "../../horizoncode/src/session/run-state"
import { SessionStatus } from "../../horizoncode/src/session/status"
import { SystemContextBuiltIns } from "@horizoncode/core/system-context/builtins"
import { SystemContextRegistry } from "@horizoncode/core/system-context/registry"
import { SystemContext } from "@horizoncode/core/system-context"
import { SkillGuidance } from "@horizoncode/core/skill/guidance"
import { ReferenceGuidance } from "@horizoncode/core/reference/guidance"
import { afterAll, describe as bunDescribe, expect } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { testEffect } from "./lib/effect"
import { configServiceMockDefaults } from "./lib/config"
const describe = process.platform === "linux" ? bunDescribe : bunDescribe.skip

const observerTestRoot = mkdtempSync(path.join(tmpdir(), "hc-recorded-session-observer-"))
const recordedWorktree = path.join(observerTestRoot, "worktree")
mkdirSync(recordedWorktree)
const recordedDatabasePath = path.join(observerTestRoot, "opencode.db")
const recordedDatabaseNode = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(recordedDatabasePath),
  deps: [],
})
const cassette =
  process.env.RECORD === "true"
    ? HttpRecorderInternal.cassetteLayer("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
        mode: "record",
      })
    : HttpRecorder.http("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
      })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
  }),
)
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
let modelResolveHook: Effect.Effect<void> = Effect.void
const models = SessionRunnerModel.layerWith(() => modelResolveHook.pipe(Effect.as(model)))
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ ...configServiceMockDefaults, entries: () => Effect.succeed([]) }))
const emptyToolRegistry = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({
    register: () => Effect.void,
    materialize: () =>
      Effect.succeed({
        definitions: [],
        validate: () => Effect.succeed(undefined),
        classify: (call) => ({ id: call.name, effectClass: "unknown" as const }),
        settle: () => Effect.succeed({ result: { type: "error" as const, value: "tool execution disabled in cassette" } }),
      }),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Database.node, recordedDatabaseNode],
  [ToolRegistry.node, emptyToolRegistry],
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make(recordedWorktree) })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const locationServices = buildLocationServiceMap([
  [SessionRunnerLLM.node, runnerLayer],
  [ToolRegistry.node, emptyToolRegistry],
  [SystemContextBuiltIns.node, Layer.empty],
])
afterAll(() => rmSync(observerTestRoot, { recursive: true, force: true }))
const observerBinary = path.resolve(import.meta.dir, "../../../kernel/target/debug/session_supervisor")
const hostKernelBinary = path.resolve(import.meta.dir, "../../../kernel/target/debug/hz-kernel")
const observerRuntime = Layer.succeed(
  SessionSupervisor.RuntimeConfig,
  SessionSupervisor.RuntimeConfig.of({
    assetPath: observerBinary,
    manifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "session_supervisor",
      target: `linux-${process.arch}-gnu`,
      sha256: createHash("sha256").update(readFileSync(observerBinary)).digest("hex"),
    }),
    installRoot: path.join(observerTestRoot, "install"),
    stateRoot: path.join(observerTestRoot, "state"),
    hostKernelAssetPath: hostKernelBinary,
    hostKernelManifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "hz-kernel",
      target: `linux-${process.arch}-gnu`,
      sha256: createHash("sha256").update(readFileSync(hostKernelBinary)).digest("hex"),
    }),
    hostKernelInstallRoot: path.join(observerTestRoot, "host-kernel-install"),
    hostKernelStateRoot: path.join(observerTestRoot, "host-kernel-state"),
  }),
)

const legacyRunStateLayer = LayerNode.compile(SessionRunState.node, [
  [
    BackgroundJob.node,
    Layer.mock(BackgroundJob.Service, {
      list: () => Effect.succeed([]),
      cancel: () => Effect.succeed(undefined),
    }),
  ],
  [SessionStatus.node, Layer.mock(SessionStatus.Service, { set: () => Effect.void })],
])

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        SessionProjector.node,
        SessionStore.node,
        AgentV2.node,
        ToolRegistry.node,
        SessionRunnerModel.node,
        SystemContextRegistry.node,
        SkillGuidance.node,
        ReferenceGuidance.node,
        Config.node,
        Snapshot.node,
        SessionExecution.node,
        SessionSupervisor.node,
        SessionV2.node,
      ]),
      [
        [Database.node, recordedDatabaseNode],
        [LayerNodePlatform.llmClient, client],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        [SessionRunnerModel.node, models],
        [SystemContextRegistry.node, systemContext],
        [Location.node, Location.boundNode({ directory: AbsolutePath.make(recordedWorktree) })],
        [SkillGuidance.node, skillGuidance],
        [ReferenceGuidance.node, referenceGuidance],
        [Config.node, config],
        [Snapshot.node, Snapshot.noopLayer],
        [SessionExecution.node, SessionExecutionLocal.node],
        [LocationServiceMap.node, locationServices],
        [SessionSupervisor.runtimeConfigNode, observerRuntime],
      ],
    ),
    legacyRunStateLayer,
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_recorded")
const rustProbe = path.resolve(import.meta.dir, "../../../kernel/target/debug/session_sync_probe")

describe("SessionRunnerLLM recorded", () => {
  it.live("recovers the pinned observer during an active recorded provider turn", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { db } = database
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(recordedWorktree), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: recordedWorktree,
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const prompt = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Say hello in one short sentence." }),
        resume: false,
      })
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const store = yield* SessionStore.Service
      const projectionDeadline = Date.now() + 5_000
      let projected = yield* store.context(sessionID)
      while (!projected.some((message) => message.type === "user") && Date.now() < projectionDeadline) {
        yield* Effect.sleep("10 millis")
        projected = yield* store.context(sessionID)
      }
      expect(projected[0]).toMatchObject({ type: "user", text: "Say hello in one short sentence." })

      const observer = yield* SessionSupervisor.Service
      const observerSessionState = path.join(
        observerTestRoot,
        "state",
        `s-${createHash("sha256").update(sessionID).digest("hex").slice(0, 20)}`,
      )
      const epochPath = path.join(observerSessionState, "supervisor.epoch")
      const observerExecutable = path.join(
        observerTestRoot,
        "install",
        `session_supervisor-${createHash("sha256").update(readFileSync(observerBinary)).digest("hex")}`,
      )
      const modelGate = yield* Deferred.make<void>()
      const modelResolving = yield* Deferred.make<void>()
      modelResolveHook = Deferred.succeed(modelResolving, undefined).pipe(Effect.andThen(Deferred.await(modelGate)))
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      let runJoined = false
      try {
        yield* Deferred.await(modelResolving)
        const legacyRunState = yield* SessionRunState.Service
        const legacyAttempt = yield* legacyRunState
          .ensureRunning(
            sessionID,
            Effect.die("V1 interrupt hook must not run while V2 owns the Session"),
            Effect.die("V1 work ran while V2 owns the Session"),
          )
          .pipe(
            Effect.provideService(InstanceRef, {
              directory: recordedWorktree,
              worktree: recordedWorktree,
              project: {
                id: Project.ID.global,
                worktree: recordedWorktree,
                time: { created: 0, updated: 0 },
                sandboxes: [],
              },
            }),
            Effect.exit,
          )
        expect(Exit.isFailure(legacyAttempt)).toBe(true)
        if (Exit.isFailure(legacyAttempt)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(legacyAttempt.cause))).toMatchObject({
            _tag: "SessionBusyError",
            sessionID,
          })
        }
        const duplicateOwner = yield* SessionSupervisor.acquireExecutionOwner(sessionID, "opencode-v1").pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(duplicateOwner)).toBe(true)
        if (Exit.isFailure(duplicateOwner)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(duplicateOwner.cause))).toMatchObject({
            stage: "ownership",
            reason: "another execution already owns this Session",
          })
        }
        const startupDeadline = Date.now() + 15_000
        while (!existsSync(epochPath) && Date.now() < startupDeadline) yield* Effect.sleep("10 millis")
        expect(existsSync(epochPath)).toBeTrue()
        let observerPID: number | undefined
        const processDeadline = Date.now() + 15_000
        while (observerPID === undefined && Date.now() < processDeadline) {
          for (const entry of readdirSync("/proc")) {
            if (!/^[0-9]+$/.test(entry)) continue
            try {
              if (readlinkSync(path.join("/proc", entry, "exe")) === observerExecutable) {
                observerPID = Number(entry)
                break
              }
            } catch {}
          }
          if (observerPID === undefined) yield* Effect.sleep("10 millis")
        }
        expect(observerPID).toBeDefined()
        if (observerPID === undefined) throw new Error("running pinned Session observer process was not found")
        process.kill(observerPID, "SIGKILL")
        const recoveryDeadline = Date.now() + 15_000
        while (Date.now() < recoveryDeadline) {
          try {
            if (readFileSync(epochPath, "utf8") === "2") break
          } catch {}
          yield* Effect.sleep("10 millis")
        }
        expect(readFileSync(epochPath, "utf8")).toBe("2")
        modelResolveHook = Effect.void
        yield* Deferred.succeed(modelGate, undefined)
        yield* Fiber.join(run)
        runJoined = true
      } finally {
        if (!runJoined) yield* Fiber.interrupt(run)
        modelResolveHook = Effect.void
        yield* Deferred.succeed(modelGate, undefined)
      }
      const acknowledged = JSON.parse(
        readFileSync(path.join(observerSessionState, `session-${sessionID}.cursor`), "utf8"),
      ) as { readonly seq: string }
      expect(acknowledged.seq).toBe("6")

      const observerEpochBeforeResnapshot = Number(readFileSync(epochPath, "utf8"))
      const observerProjectionPath = path.join(observerSessionState, "session-projection.sqlite")
      const projectionDB = new SQLite(observerProjectionPath, { strict: true })
      let staleCursor: {
        readonly ownerKind: string
        readonly ownerId: string
        readonly seq: string
        readonly eventDigest: string
      }
      try {
        const receipt = projectionDB
          .query("SELECT event_hash FROM hc_session_receipts WHERE session_id = ? AND seq = ?")
          .get(sessionID, 4) as { readonly event_hash: string } | null
        expect(receipt?.event_hash).toBeDefined()
        if (!receipt) throw new Error("observer projection receipt was not found")
        staleCursor = {
          ownerKind: "session",
          ownerId: sessionID,
          seq: "5",
          eventDigest: `blake3:${receipt.event_hash}`,
        }
        const removed = projectionDB
          .query("DELETE FROM hc_session_receipts WHERE session_id = ? AND seq = ?")
          .run(sessionID, 4)
        expect(removed.changes).toBe(1)
      } finally {
        projectionDB.close()
      }
      writeFileSync(
        path.join(observerSessionState, `session-${sessionID}.cursor`),
        JSON.stringify(staleCursor),
        { mode: 0o600 },
      )
      const resnapshotRequired = yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* observer.openForSession(sessionID, database.path, recordedWorktree)
          expect(started.status).toBe("available")
          if (started.status !== "available") return undefined
          yield* Effect.tryPromise({ try: () => started.client.subscribe(), catch: (error) => error as Error })
          return yield* Effect.tryPromise({
            try: () => started.client.receive(),
            catch: (error) => error as Error,
          })
        }),
      )
      expect(resnapshotRequired).toMatchObject({ kind: "resnapshot_required" })
      const observerEpochAfterProbe = Number(readFileSync(epochPath, "utf8"))
      expect(observerEpochAfterProbe).toBe(observerEpochBeforeResnapshot + 1)
      const turnComplete = yield* Ref.make(false)
      const supervisorReady = yield* Deferred.make<void, SessionSupervisorError>()
      // Readiness only confirms process startup. Keep the watcher alive until its durable
      // acknowledged cursor proves the resnapshot replayed the complete source.
      const replayWatcher = yield* Effect.forkScoped(
        observer.watchSession(sessionID, database.path, recordedWorktree, turnComplete, supervisorReady),
      )
      yield* Deferred.await(supervisorReady)
      const cursorPath = path.join(observerSessionState, `session-${sessionID}.cursor`)
      let replayedSeq = ""
      const replayDeadline = Date.now() + 15_000
      while (replayedSeq !== "6" && Date.now() < replayDeadline) {
        try {
          replayedSeq = (JSON.parse(readFileSync(cursorPath, "utf8")) as { readonly seq: string }).seq
        } catch {}
        if (replayedSeq !== "6") yield* Effect.sleep("10 millis")
      }
      expect(replayedSeq).toBe("6")
      yield* Ref.set(turnComplete, true)
      yield* Fiber.join(replayWatcher)
      const rebuiltCursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { readonly seq: string }
      expect(rebuiltCursor.seq).toBe("6")
      expect(readFileSync(epochPath, "utf8")).toBe(String(observerEpochAfterProbe + 2))

      yield* Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* observer.openForSession(sessionID, database.path)
          expect(restarted.status).toBe("available")
          if (restarted.status !== "available") return
          yield* Effect.tryPromise({ try: () => restarted.client.subscribe(), catch: (error) => error as Error })
          const page = yield* Effect.tryPromise({
            try: () => restarted.client.receive(),
            catch: (error) => error as Error,
          })
          expect(page).toMatchObject({ kind: "page_end", through: { seq: "6" }, hasMore: false })
        }),
      )
      expect(readFileSync(path.join(observerSessionState, "supervisor.epoch"), "utf8")).toBe(
        String(observerEpochAfterProbe + 3),
      )

      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.next.prompt.admitted.1",
        "session.next.prompted.1",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])
      const sourceEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(EventTable.seq)
        .all()
      const answerEvent = sourceEvents.find((event) => event.type === "session.next.text.ended.1")
      expect(JSON.stringify(answerEvent?.data)).toContain("Hello!")

      const projectionDirectory = mkdtempSync(path.join(tmpdir(), "hc-recorded-turn-projection-"))
      const sourcePath = path.join(projectionDirectory, "opencode-events.db")
      const projectionPath = path.join(projectionDirectory, "session-projection.db")
      try {
        const source = new SQLite(sourcePath)
        try {
          source.exec(
            "CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(aggregate_id, seq))",
          )
          const insert = source.prepare("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?,?,?,?,?)")
          for (const event of sourceEvents) {
            insert.run(event.id, event.aggregate_id, event.seq, event.type, JSON.stringify(event.data))
          }
        } finally {
          source.close()
        }
        const child = Bun.spawn([rustProbe, sourcePath, projectionPath, sessionID], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const exitCode = yield* Effect.promise(() => child.exited)
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        const replay = Bun.spawn([rustProbe, sourcePath, projectionPath, sessionID], {
          stdout: "ignore",
          stderr: "pipe",
        })
        const replayExit = yield* Effect.promise(() => replay.exited)
        const replayStderr = yield* Effect.promise(() => new Response(replay.stderr).text())
        expect(replayExit).toBe(0)
        expect(replayStderr).toBe("")
        const projection = new SQLite(projectionPath, { readonly: true, strict: true })
        try {
          const projected = projection
            .query("SELECT kind,message_id,seq FROM hc_session_receipts ORDER BY seq")
            .all() as Array<{ kind: string; message_id: string | null; seq: number }>
          expect(projected.map((event) => event.kind)).toEqual([
            "session.next.prompt.admitted.1",
            "session.next.prompted.1",
            "session.next.step.started.1",
            "session.next.text.started.1",
            "session.next.text.ended.1",
            "session.next.step.ended.2",
          ])
          expect(projected.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
          expect(projected[0]?.message_id).toBe(prompt.id)
          expect(projected.every((event) => event.message_id !== null)).toBe(true)
          expect(JSON.stringify(projected)).not.toContain("Say hello in one short sentence.")
          expect(JSON.stringify(projected)).not.toContain("Hello!")
        } finally {
          projection.close()
        }
      } finally {
        rmSync(projectionDirectory, { recursive: true, force: true })
      }
    }),
    60_000,
  )
})
