import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer, Queue, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import * as LegacySessionHandler from "../../src/server/routes/instance/httpapi/handlers/session"
import * as V2SessionHandler from "@opencode-ai/server/handlers/session"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Session } from "@/session/session"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  SessionSupervisorError,
  type GuardApprovalRequest,
} from "@opencode-ai/core/session/supervisor"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import {
  disposeAllInstances,
  provideInstanceEffect,
  requireInstance,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect, awaitWithTimeout } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const rustTestRoot = mkdtempSync(path.join(tmpdir(), "hc-httpapi-session-guard-"))
const supervisorBinary = path.resolve(import.meta.dir, "../../../../kernel/target/debug/session_supervisor")
const hostKernelBinary = path.resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel")
const hostKernelAvailable = process.platform === "linux" && existsSync(hostKernelBinary)
const supervisorAvailable = process.platform === "linux" && existsSync(supervisorBinary)
const supervisorDigest = supervisorAvailable
  ? createHash("sha256").update(readFileSync(supervisorBinary)).digest("hex")
  : undefined
const hostKernelDigest = hostKernelAvailable
  ? createHash("sha256").update(readFileSync(hostKernelBinary)).digest("hex")
  : undefined
// The default suite fixture deliberately leaves the host kernel unavailable: the
// shell/command 503 surface and the legacy-revert unavailability contract are
// defined for an unmediated Guard host. Tests that need the real Guard-mediated
// `files.patch` flow opt into `hostIt` below.
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
  }),
)
const testDatabasePath = path.join(rustTestRoot, "opencode.db")
const testDatabaseNode = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(testDatabasePath),
  deps: [],
})
const routeReplacements = [
  [Database.node, testDatabaseNode],
  [SessionSupervisor.runtimeConfigNode, supervisorRuntime],
] as const
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer], ...routeReplacements],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError | SessionSupervisorError, HttpServer.HttpServer> =
  HttpRouter.serve(
    HttpApiApp.createRoutes(undefined, routeReplacements),
    {
      disableListenLog: true,
      disableLogger: true,
    },
  )
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

// Real host-backed instance: mirrors the `hostKernelRuntime` wiring in
// test/session/prompt.test.ts (same fresh `hz-kernel`, sha256 manifest, and
// per-suite install/state roots). Used only by tests that exercise the real
// Guard-mediated files.patch flow.
const hostKernelRuntime = Layer.succeed(
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
    installRoot: path.join(rustTestRoot, "host-suite-install"),
    stateRoot: path.join(rustTestRoot, "host-suite-state"),
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
    hostKernelInstallRoot: path.join(rustTestRoot, "host-kernel-install"),
    hostKernelStateRoot: path.join(rustTestRoot, "host-kernel-state"),
  }),
)
const hostRouteReplacements = [
  [Database.node, testDatabaseNode],
  [SessionSupervisor.runtimeConfigNode, hostKernelRuntime],
] as const
const hostAppLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    EventV2Bridge.node,
    SessionSupervisor.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer], ...hostRouteReplacements],
)
const hostServedRoutes: Layer.Layer<never, Config.ConfigError | SessionSupervisorError, HttpServer.HttpServer> =
  HttpRouter.serve(
    HttpApiApp.createRoutes(undefined, hostRouteReplacements),
    {
      disableListenLog: true,
      disableLogger: true,
    },
  )
const hostHttpApiLayer = hostServedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
// Guard approval replies are explicit user actions and require a trusted
// principal, exactly as test/session/prompt.test.ts provides for its live tests.
const trustedPrincipalLayer = Layer.succeed(TrustedPrincipalContext, {
  principal: { kind: "host_os" as const },
})
const hostIt = testEffect(
  Layer.mergeAll(hostAppLayer, hostHttpApiLayer).pipe(Layer.provideMerge(trustedPrincipalLayer)),
)
const publicApiSpec = OpenApi.fromApi(PublicApi) as {
  paths: Record<string, Partial<Record<"post", { responses?: Record<string, unknown> }>>>
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertV2AssistantMessage = (
  sessionID: SessionIDType,
  seq: number,
  snapshot?: { readonly start: string; readonly files: readonly string[] },
) =>
  Effect.gen(function* () {
    const time = Date.now()
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
      snapshot: snapshot
        ? { start: snapshot.start, files: snapshot.files.map((file) => RelativePath.make(file)) }
        : undefined,
    })
    const { type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(message)
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([{ id: message.id, session_id: sessionID, type, seq, time_created: time, data }])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
  await rm(testDatabasePath, { force: true })
  await rm(`${testDatabasePath}-wal`, { force: true })
  await rm(`${testDatabasePath}-shm`, { force: true })
})
afterAll(async () => {
  await rm(rustTestRoot, { recursive: true, force: true })
})

describe("session HttpApi", () => {
  it.effect("maps legacy prompt failures to explicit client, conflict, denial, and host errors", () =>
    Effect.sync(() => {
      const mapper = (HttpSessionError as typeof HttpSessionError & {
        mapLegacyPromptError?: (error: unknown, sessionID: SessionIDType) => unknown
      }).mapLegacyPromptError
      expect(mapper).toBeTypeOf("function")
      if (!mapper) return

      const sessionID = SessionID.descending()
      expect(mapper(new Error("invalid prompt input"), sessionID)).toMatchObject({ _tag: "BadRequest" })
      expect(mapper(new Session.BusyError({ sessionID }), sessionID)).toMatchObject({
        _tag: "SessionBusyError",
        sessionID,
      })
      expect(
        mapper(new SessionSupervisorError({ stage: "authorization", reason: "Guard denied" }), sessionID),
      ).toMatchObject({ _tag: "ForbiddenError", message: "Session supervisor authorization failed: Guard denied" })
      expect(mapper(new SessionSupervisorError({ stage: "ownership", reason: "another owner" }), sessionID)).toMatchObject({
        _tag: "SessionBusyError",
        sessionID,
      })
      expect(mapper(new SessionSupervisorError({ stage: "transport", reason: "channel closed" }), sessionID)).toMatchObject({
        _tag: "ServiceUnavailableError",
        service: "host-kernel",
      })
    }),
  )

  it.effect("maps v2 revert Guard denial and owner conflict separately from host unavailability", () =>
    Effect.sync(() => {
      const mapper = (V2SessionHandler as typeof V2SessionHandler & {
        mapSupervisorError?: (error: SessionSupervisorError, sessionID: string) => unknown
      }).mapSupervisorError
      expect(mapper).toBeTypeOf("function")
      if (!mapper) return

      const sessionID = SessionID.descending()
      expect(mapper(new SessionSupervisorError({ stage: "authorization", reason: "Guard denied" }), sessionID)).toMatchObject({
        _tag: "ForbiddenError",
        message: "Session supervisor authorization failed: Guard denied",
      })
      expect(mapper(new SessionSupervisorError({ stage: "ownership", reason: "another owner" }), sessionID)).toMatchObject({
        _tag: "ConflictError",
        resource: sessionID,
      })
      expect(mapper(new SessionSupervisorError({ stage: "transport", reason: "channel closed" }), sessionID)).toMatchObject({
        _tag: "ServiceUnavailableError",
        service: "files.patch",
      })
    }),
  )

  it.effect("maps legacy command and revert Guard denials to Forbidden", () =>
    Effect.sync(() => {
      const sessionID = SessionID.descending()
      const commandMapper = (LegacySessionHandler as typeof LegacySessionHandler & {
        mapLegacySupervisorError?: (error: SessionSupervisorError, sessionID: string, service?: string) => unknown
      }).mapLegacySupervisorError
      const revertMapper = (LegacySessionHandler as typeof LegacySessionHandler & {
        mapLegacyRevertError?: (error: SessionSupervisorError, sessionID: string) => unknown
      }).mapLegacyRevertError

      expect(commandMapper).toBeTypeOf("function")
      expect(revertMapper).toBeTypeOf("function")
      if (!commandMapper || !revertMapper) return

      const denied = new SessionSupervisorError({ stage: "authorization", reason: "Guard denied" })
      const expected = {
        _tag: "ForbiddenError",
        message: "Session supervisor authorization failed: Guard denied",
      }
      expect(commandMapper(denied, sessionID)).toMatchObject(expected)
      expect(revertMapper(denied, sessionID)).toMatchObject(expected)
      const ownership = new SessionSupervisorError({ stage: "ownership", reason: "another owner" })
      expect(commandMapper(ownership, sessionID)).toMatchObject({ _tag: "SessionBusyError", sessionID })
      expect(revertMapper(ownership, sessionID)).toMatchObject({ _tag: "SessionBusyError", sessionID })
      const unavailable = new SessionSupervisorError({ stage: "transport", reason: "channel closed" })
      expect(commandMapper(unavailable, sessionID)).toMatchObject({
        _tag: "ServiceUnavailableError",
        service: "host-kernel",
      })
      expect(revertMapper(unavailable, sessionID)).toMatchObject({
        _tag: "ServiceUnavailableError",
        service: "files.patch",
      })
    }),
  )

  it.effect("declares the legacy and v2 session failure mappings in OpenAPI", () =>
    Effect.sync(() => {
      const responses = (path: string) => publicApiSpec.paths[path]?.post?.responses ?? {}
      const encodedResponse = (path: string, status: string) => JSON.stringify(responses(path)[status] ?? {})

      for (const path of ["/session/{sessionID}/init", "/session/{sessionID}/message"]) {
        expect(responses(path), `${path} 400 client error`).toHaveProperty("400")
        expect(responses(path), `${path} 409 busy conflict`).toHaveProperty("409")
        expect(encodedResponse(path, "403"), `${path} Guard denial`).toContain("ForbiddenError")
        expect(encodedResponse(path, "503"), `${path} host failure`).toContain("ServiceUnavailableError")
      }

      for (const path of ["/session/{sessionID}/command", "/session/{sessionID}/shell"]) {
        expect(responses(path), `${path} Guard denial`).toHaveProperty("403")
        expect(responses(path), `${path} owner conflict`).toHaveProperty("409")
        expect(responses(path), `${path} host failure`).toHaveProperty("503")
        expect(encodedResponse(path, "403")).toContain("ForbiddenError")
        expect(encodedResponse(path, "409")).toContain("SessionBusyError")
        expect(encodedResponse(path, "503")).toContain("ServiceUnavailableError")
      }

      for (const path of ["/session/{sessionID}/revert", "/session/{sessionID}/unrevert"]) {
        expect(responses(path), `${path} Guard denial`).toHaveProperty("403")
        expect(responses(path), `${path} owner conflict`).toHaveProperty("409")
        expect(responses(path), `${path} host failure`).toHaveProperty("503")
        expect(encodedResponse(path, "403")).toContain("ForbiddenError")
        expect(encodedResponse(path, "409")).toContain("SessionBusyError")
        expect(encodedResponse(path, "503")).toContain("ServiceUnavailableError")
      }

      for (const path of ["/api/session/{sessionID}/revert/stage", "/api/session/{sessionID}/revert/clear"]) {
        expect(responses(path), `${path} owner conflict`).toHaveProperty("409")
        expect(responses(path), `${path} Guard denial`).toHaveProperty("403")
        expect(responses(path), `${path} host failure`).toHaveProperty("503")
        expect(encodedResponse(path, "409")).toContain("ConflictError")
        expect(encodedResponse(path, "403")).toContain("ForbiddenError")
        expect(encodedResponse(path, "503")).toContain("ServiceUnavailableError")
      }
    }),
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns HTTP 503 and starts no process for shell when the host kernel is unavailable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "terminal unavailable" })
        const response = yield* request(pathFor(SessionPaths.shell, { sessionID: session.id }), {
          method: "POST",
          headers: {
            "x-opencode-directory": test.directory,
            "content-type": "application/json",
          },
          body: JSON.stringify({ agent: "build", command: "touch shell-must-not-run" }),
        })

        expect(response.status).toBe(503)
        expect(yield* responseJson(response)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Shell execution is unavailable until terminal.run is mediated by Rust Guard and ExecutionHost.",
          service: "terminal.run",
        })
        expect(existsSync(path.join(test.directory, "shell-must-not-run"))).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15000 },
  )

  it.instance(
    "returns HTTP 503 and starts no process for slash-command interpolation without the host kernel",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "shell-must-not-run")
        yield* Effect.promise(() =>
          writeFile(
            path.join(test.directory, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              command: { probe: { template: `Probe !\`touch ${marker}\`` } },
            }),
          ),
        )
        const session = yield* createSession({ title: "command shell unavailable" })
        const response = yield* request(pathFor(SessionPaths.command, { sessionID: session.id }), {
          method: "POST",
          headers: {
            "x-opencode-directory": test.directory,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: "probe", arguments: "" }),
        })

        expect(response.status).toBe(503)
        expect(yield* responseJson(response)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Shell execution is unavailable until terminal.run is mediated by Rust Guard and ExecutionHost.",
          service: "terminal.run",
        })
        expect(existsSync(marker)).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15000 },
  )

  it.instance(
    "keeps legacy revert unavailable without starting a snapshot process or changing files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
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

        const tracked = path.join(test.directory, "legacy-revert.txt")
        yield* Effect.promise(() => writeFile(tracked, "before\n"))
        const session = yield* createSession({ title: "legacy revert unavailable" })
        const user = yield* createTextMessage(session.id, "revert target")

        const response = yield* request(pathFor(SessionPaths.revert, { sessionID: session.id }), {
          method: "POST",
          headers: {
            "x-opencode-directory": test.directory,
            "content-type": "application/json",
          },
          body: JSON.stringify({ messageID: user.info.id }),
        })

        expect(response.status).toBe(503)
        expect(yield* responseJson(response)).toMatchObject({
          _tag: "ServiceUnavailableError",
          service: "files.patch",
        })
        expect(yield* Effect.promise(() => readFile(tracked, "utf8"))).toBe("before\n")
        expect((yield* Session.use.get(session.id)).revert).toBeUndefined()
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "returns HTTP 503 for MCP effects until Rust broker mediation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const marker = path.join(test.directory, "mcp-command-started")
        const command = [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
        ]
        let remoteRequests = 0
        const remote = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: () => {
                remoteRequests++
                return new Response("unexpected MCP request")
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const configFile = path.join(test.directory, "opencode.json")
        const config = {
          mcp: {
            marker: { type: "local", command },
            remote: { type: "remote", url: remote.url.href, enabled: true, oauth: {} },
          },
        }
        yield* Effect.promise(() => writeFile(configFile, JSON.stringify(config)))
        const headers = {
          "x-opencode-directory": test.directory,
          "content-type": "application/json",
        }
        const unavailable = {
          _tag: "ServiceUnavailableError",
          message:
            "MCP connections are unavailable until the canonical Rust execution broker supports MCP process and network effects.",
          service: "mcp",
        }

        const connect = yield* request(pathFor(McpPaths.connect, { name: "marker" }), {
          method: "POST",
          headers,
        })
        expect({ status: connect.status, body: yield* responseJson(connect) }).toEqual({
          status: 503,
          body: unavailable,
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)

        const add = yield* request(McpPaths.status, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "added",
            config: { type: "local", command },
          }),
        })
        expect(add.status).toBe(503)
        expect(yield* responseJson(add)).toEqual(unavailable)
        expect(JSON.parse(yield* Effect.promise(() => Bun.file(configFile).text())).mcp).toEqual(config.mcp)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)

        const authStart = yield* request(pathFor(McpPaths.auth, { name: "remote" }), {
          method: "POST",
          headers,
        })
        expect(authStart.status).toBe(503)
        expect(yield* responseJson(authStart)).toEqual(unavailable)

        const authAuthenticate = yield* request(pathFor(McpPaths.authAuthenticate, { name: "remote" }), {
          method: "POST",
          headers,
        })
        expect(authAuthenticate.status).toBe(503)
        expect(yield* responseJson(authAuthenticate)).toEqual(unavailable)

        const authCallback = yield* request(pathFor(McpPaths.authCallback, { name: "remote" }), {
          method: "POST",
          headers,
          body: JSON.stringify({ code: "untrusted-authorization-code" }),
        })
        expect(authCallback.status).toBe(503)
        expect(yield* responseJson(authCallback)).toEqual(unavailable)
        expect(remoteRequests).toBe(0)

        const removeAuth = yield* request(pathFor(McpPaths.auth, { name: "marker" }), {
          method: "DELETE",
          headers,
        })
        expect(removeAuth.status).toBe(503)
        expect(yield* responseJson(removeAuth)).toEqual(unavailable)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns HTTP 409 before summarize work when another backend owns the Session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "owned elsewhere" })
        const sessions = yield* Session.Service
        const before = yield* sessions.messages({ sessionID: session.id })
        const response = yield* Effect.scoped(
          SessionSupervisor.acquireExecutionOwner(session.id, "core-v2").pipe(
            Effect.andThen(
              request(pathFor(SessionPaths.summarize, { sessionID: session.id }), {
                method: "POST",
                headers: {
                  "x-opencode-directory": test.directory,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  providerID: "test",
                  modelID: "test-model",
                }),
              }),
            ),
          ),
        )

        expect(response.status).toBe(409)
        expect(yield* responseJson(response)).toEqual({
          _tag: "SessionBusyError",
          sessionID: session.id,
          message: `Session is busy: ${session.id}`,
        })
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns HTTP 409 before init and async prompt dispatch when another backend owns the Session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "owned elsewhere" })
        const sessions = yield* Session.Service
        const before = yield* sessions.messages({ sessionID: session.id })
        const responses = yield* Effect.scoped(
          SessionSupervisor.acquireExecutionOwner(session.id, "core-v2").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const headers = {
                  "x-opencode-directory": test.directory,
                  "content-type": "application/json",
                }
                const init = yield* request(pathFor(SessionPaths.init, { sessionID: session.id }), {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    providerID: "test",
                    modelID: "test-model",
                    messageID: MessageID.ascending(),
                  }),
                })
                const promptAsync = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    agent: "build",
                    noReply: true,
                    parts: [{ type: "text", text: "must not be stored" }],
                  }),
                })
                return [init, promptAsync]
              }),
            ),
          ),
        )

        for (const response of responses) {
          expect(response.status).toBe(409)
          expect(yield* responseJson(response)).toEqual({
            _tag: "SessionBusyError",
            sessionID: session.id,
            message: `Session is busy: ${session.id}`,
          })
        }
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("uses the persisted session directory for prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const messages = yield* Session.use
        .messages({ sessionID: session.id })
        .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: sessionDirectory,
        root: sessionDirectory,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.instance(
    "returns a conflict before V2 revert stage when another backend owns the Session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
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

        const tracked = path.join(test.directory, "tracked.txt")
        yield* Effect.promise(() => writeFile(tracked, "before\n"))
        const session = yield* createSession({ title: "V2 revert owner conflict" })
        const snapshotLayer = AppNodeBuilder.build(Snapshot.node, [
          [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(test.directory) }))],
        ])
        const baseline = yield* Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          return yield* snapshot.capture()
        }).pipe(Effect.provide(snapshotLayer))
        if (!baseline) throw new Error("Snapshot capture was unavailable for the V2 revert fixture")

        yield* Effect.promise(() => writeFile(tracked, "after\n"))
        const boundary = yield* insertV2AssistantMessage(session.id, 1)
        yield* insertV2AssistantMessage(session.id, 2, { start: baseline, files: ["tracked.txt"] })
        const response = yield* Effect.scoped(
          SessionSupervisor.acquireExecutionOwner(session.id, "opencode-v1").pipe(
            Effect.andThen(
              request(`/api/session/${session.id}/revert/stage`, {
                method: "POST",
                headers: {
                  "x-opencode-directory": test.directory,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ messageID: boundary.id }),
              }),
            ),
          ),
        )

        expect(response.status).toBe(409)
        expect(yield* responseJson(response)).toMatchObject({
          _tag: "ConflictError",
          resource: session.id,
        })
        expect(yield* Effect.promise(() => readFile(tracked, "utf8"))).toBe("after\n")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  if (supervisorAvailable && hostKernelAvailable) {
    hostIt.instance(
      "stages and clears V2 revert file changes through Guarded files.patch",
      () =>
        Effect.gen(function* () {
          // Stage and clear each prepare one `files.patch` ToolBatch, which blocks
          // until a concurrent surface answers `guard.approval.requested`; a fiber
          // that prepares the batch can never reply to itself.
          const events = yield* EventV2Bridge.Service
          const supervisor = yield* SessionSupervisor.Service
          const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
          const off = yield* events.listen((event) => {
            if (event.type === GuardApprovalRequested.type) {
              Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
            }
            return Effect.void
          })
          const approve = Effect.gen(function* () {
            for (let index = 0; index < 2; index++) {
              const request = yield* awaitWithTimeout(
                Queue.take(approvals),
                "timed out waiting for the Guard files.patch approval",
                "15 seconds",
              )
              expect(request.capabilityID).toBe("files.patch")
              yield* supervisor.replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
            }
          })
          const body = Effect.gen(function* () {
            const test = yield* TestInstance
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
            const tracked = path.join(test.directory, "tracked.txt")
            yield* Effect.promise(() => writeFile(tracked, "before\n"))

            const session = yield* createSession({ title: "guarded V2 revert" })

            const snapshotLayer = AppNodeBuilder.build(Snapshot.node, [
              [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(test.directory) }))],
            ])
            const baseline = yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer))
            if (!baseline) throw new Error("Snapshot capture was unavailable for the V2 revert fixture")

            yield* Effect.promise(() => writeFile(tracked, "after\n"))
            const boundary = yield* insertV2AssistantMessage(session.id, 1)
            yield* insertV2AssistantMessage(session.id, 2, { start: baseline, files: ["tracked.txt"] })
            const headers = {
              "x-opencode-directory": test.directory,
              "content-type": "application/json",
            }

            const stage = yield* request(`/api/session/${session.id}/revert/stage`, {
              method: "POST",
              headers,
              body: JSON.stringify({ messageID: boundary.id }),
            })
            if (stage.status !== 200) {
              const body = yield* responseJson(stage)
              throw new Error(`V2 revert stage returned ${stage.status}: ${JSON.stringify(body)}`)
            }
            const staged = yield* json<{ data: { messageID: string; restoreFiles?: readonly string[] } }>(stage)
            expect(staged.data.messageID).toBe(boundary.id)
            expect(staged.data.restoreFiles).toEqual(["tracked.txt"])
            expect(yield* Effect.promise(() => readFile(tracked, "utf8"))).toBe("before\n")

            const clear = yield* request(`/api/session/${session.id}/revert/clear`, {
              method: "POST",
              headers: { "x-opencode-directory": test.directory },
            })
            expect(clear.status).toBe(204)
            expect(yield* Effect.promise(() => readFile(tracked, "utf8"))).toBe("after\n")
          })
          return yield* Effect.all([body, approve] as const, { concurrency: "unbounded" }).pipe(
            Effect.ensuring(off),
          )
        }),
      { git: true, config: { formatter: false, lsp: false } },
    )
  } else {
    hostIt.instance.skip("stages and clears V2 revert file changes through Guarded files.patch", () => Effect.void, {
      git: true,
    })
  }
  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })

        const wakeID = SessionMessage.ID.make("msg_http_wake")
        const wake = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: wakeID, prompt: { text: "hello again" } }),
        })
        expect(wake.status).toBe(200)
        const message = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, { headers }).pipe(
            Effect.map(({ data }) => data.find((message) => message.id === wakeID)),
          ),
          "V2 prompt was not promoted after wake",
          "10 seconds",
        )
        expect(message).toMatchObject({ id: wakeID, type: "user" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public unavailable errors for unfinished session mutations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session compact is not available yet",
          service: "session.compact",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session wait is not available yet",
          service: "session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir })),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists sessions created through an equivalent directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hint = test.directory + path.sep
        const headers = { "x-opencode-directory": hint, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "hinted" }),
        })

        const query = new URLSearchParams({ directory: hint, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(created.id)

        const globalQuery = new URLSearchParams({ directory: hint })
        const global = yield* requestJson<Session.Info[]>(`${ExperimentalPaths.session}?${globalQuery}`, { headers })
        expect(global.map((item) => item.id)).toContain(created.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "lists Windows sessions for equivalent directory spellings",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "windows spelling" }),
        })

        const forwardSlashes = test.directory.replaceAll("\\", "/")
        const lowercaseDrive = test.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const trailingSeparator = `${test.directory}\\`
        for (const spelling of [forwardSlashes, lowercaseDrive, trailingSeparator]) {
          const query = new URLSearchParams({ directory: spelling, roots: "true" })
          const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
          expect({ spelling, ids: listed.map((item) => item.id) }).toEqual({ spelling, ids: [created.id] })
        }
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "lists Windows sessions created through the global worktree sentinel",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const globalWorktreeSentinel = "/"
        const headers = { "x-opencode-directory": globalWorktreeSentinel, "content-type": "application/json" }
        const driveRootSession = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created at drive root" }),
        })
        expect(driveRootSession.directory).toMatch(/^[A-Za-z]:\\$/)

        const query = new URLSearchParams({ directory: globalWorktreeSentinel, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(driveRootSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "no-ops when a requested revert message or revert state is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "revert missing state" })

        const revert = yield* request(pathFor(SessionPaths.revert, { sessionID: session.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ messageID: MessageID.ascending() }),
        })
        expect(revert.status).toBe(200)
        expect((yield* json<{ id: string }>(revert)).id).toBe(session.id)

        const unrevert = yield* request(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
          method: "POST",
          headers,
        })
        expect(unrevert.status).toBe(200)
        expect((yield* json<{ id: string }>(unrevert)).id).toBe(session.id)
        expect((yield* Session.use.get(session.id)).revert).toBeUndefined()

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
