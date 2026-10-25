import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Config as CoreConfig } from "@opencode-ai/core/config"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { SessionV2 } from "@opencode-ai/core/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Project } from "../../src/project/project"
import { ServerAuth } from "../../src/server/auth"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { WebSearchRuntime } from "../../src/tool/websearch-runtime"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceHttpApi, RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { goalReviewHandlers } from "../../src/server/routes/instance/httpapi/handlers/goal-review"
import {
  GoalReviewApi,
  GoalProposalDraftV1,
  GoalRunControlInputV1,
  GoalRunPlanInputV1,
  GoalRunStartInputV1,
  GoalVerificationInputV1,
  GoalVerificationPayloadV1,
} from "../../src/server/routes/instance/httpapi/groups/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { withFixedWorkspaceID } from "../fixture/flag"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const input = MoveSession.Input.make({
  sessionID: SessionV2.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: false,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)
const authenticatedSubject = Ref.makeUnsafe<string | undefined>(undefined)

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) =>
        Effect.gen(function* () {
          const context = yield* Effect.serviceOption(TrustedPrincipalContext)
          yield* Ref.set(
            authenticatedSubject,
            Option.isSome(context) && context.value.principal.kind === "server_auth"
              ? context.value.principal.subject
              : undefined,
          )
          if (value.moveChanges) {
            return yield* Effect.fail(
              new MoveSession.MoveChangesUnavailableError({
                message: "Moving changes is unavailable until files.patch is mediated by Rust Guard and ExecutionHost.",
              }),
            )
          }
          yield* Ref.set(called, value)
        }),
    }),
  ),
  Layer.provide(
    ServerAuth.Config.configLayer({
      password: Option.some("executor-secret"),
      username: "executor",
      reviewerPassword: Option.some("reviewer-secret"),
      reviewerUsername: Option.some("reviewer"),
    }),
  ),
)
const it = testEffect(apiLayer)

const goalReviewTestStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

type GoalReviewHostCall = { readonly serviceID: string; readonly operation: string }
const goalReviewHostResponse = Ref.makeUnsafe<Readonly<Record<string, unknown>>>({ goals: [] })
const goalReviewHostCalls = Ref.makeUnsafe<ReadonlyArray<GoalReviewHostCall>>([])

const goalReviewSupervisorLayer = Layer.mock(SessionSupervisor.Service)({
  requestHostKernel: (serviceID, operation) =>
    Effect.gen(function* () {
      yield* Ref.update(goalReviewHostCalls, (calls) => [...calls, { serviceID, operation }])
      if (operation === "pause_run" || operation === "resume_run" || operation === "cancel") {
        return {
          goalID: "goal-control",
          runID: "run-control",
          status: operation === "pause_run" ? "PAUSED" : operation === "resume_run" ? "RUNNING" : "CANCELLING",
          runPhase: operation === "pause_run" ? "PAUSED" : operation === "resume_run" ? "RUNNING" : "CANCELLING",
          // HostKernel emits `revision` as a JSON unsigned integer
          // (`Value::Unsigned(snapshot.revision)`); a decimal string here is a
          // protocol mismatch, not a wire value — the route answers DecimalU64.
          revision: 5,
        }
      }
      return yield* Ref.get(goalReviewHostResponse)
    }),
})

const goalReviewWorkspaceMiddleware = Layer.mergeAll(
  instanceContextLayer,
  workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
)

// Production wires `goalReviewHandlers` (built on `InstanceHttpApi`) into the
// instance route tree and supplies `schemaErrorLayer` alongside the auth and
// workspace/instance middleware (`server.ts` `instanceRoutes`). The test keeps
// the focused route surface required by `test/AGENTS.md`, but it must serve the
// *same* API identity as the handler group: `HttpApiBuilder.layer` requires
// `ApiGroup<ApiId, Name>` for its groups while `HttpApiBuilder.group` provides
// `ApiGroup<ApiId, Name>` for the API it was built against. `GoalReviewApi` is a
// standalone `HttpApi.make("goalReview")` value, so pairing it with the
// production handlers leaves `ApiGroup<"goalReview", "goalReview">` unsatisfied.
// Group services are keyed by group identifier at runtime
// (`effect/httpapi/HttpApiGroup/<identifier>`), so restricting the group set to
// the one under test only narrows which routes are registered; it changes no
// handler, middleware or endpoint contract.
const goalReviewRoutesApi = HttpApi.make(InstanceHttpApi.identifier).addHttpApi(GoalReviewApi)
const goalReviewRoutes = HttpApiBuilder.layer(goalReviewRoutesApi).pipe(
  Layer.provide(goalReviewHandlers),
  Layer.provide([
    authorizationLayer,
    goalReviewWorkspaceMiddleware,
    schemaErrorLayer,
  ]),
)

// The Goal review group's managed-control handlers declare a build-time
// requirement on the Core AgentProfile service, and `ManagedControl.goalReviewSnapshot`
// (used by verification, Run control and decision routes) resolves the profile
// catalog at request time for the eligibility projection. These tests assert
// revision/CAS and inbox behavior, never profile content, so the fixture supplies
// an explicitly empty catalog — truthfully "no profile configured here" — and
// every other method still fails loudly if a path outside that contract runs.
const agentProfilesStub = Layer.succeed(
  CoreConfig.AgentProfileService,
  CoreConfig.AgentProfileService.of({
    agentProfiles: () => Effect.succeed([]),
    agentProfileSelectors: () => Effect.die("not exercised by the Goal review route tests"),
    agentProfile: () => Effect.die("not exercised by the Goal review route tests"),
    agentProfileSelector: () => Effect.die("not exercised by the Goal review route tests"),
    primaryAgentProfile: () => Effect.die("not exercised by the Goal review route tests"),
  }),
)

const itGoalReviewLayer = Layer.mergeAll(
  goalReviewTestStateLayer,
  NodeHttpServer.layerTest,
  NodeServices.layer,
  workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
  // These are app-level dependencies of the production handler graph, not
  // inputs to the route tests below. Keep them in the test runtime because
  // `serveGoalReview` builds the route layer inside each test effect; strict
  // partial layers make any accidental provider/search use fail loudly.
  Layer.mock(Provider.Service)({}),
  Layer.mock(Agent.Service)({}),
  Layer.mock(WebSearchRuntime.Service)({}),
  // `goalReviewHandlers` yields `RuntimeFlags.Service` inside its handler
  // context, so `HttpApiBuilder.group` puts it in the route layer's raw
  // `RIn`. `workspaceLayerWithRuntimeFlags` builds exactly this override as a
  // *dependency* of `Workspace.node`, and `LayerNode.compile` feeds
  // dependencies through `Layer.provide`, which by contract exposes only the
  // consuming layer's own services — the fixture's group therefore cannot
  // discharge the routes' requirement. Production lists `RuntimeFlags.node`
  // directly in `server.ts`'s `app` group for the same reason; supply the
  // identically-overridden service here so the requirement is met by a real
  // layer rather than asserted away.
  RuntimeFlags.layer({ experimentalWorkspaces: true }),
  goalReviewSupervisorLayer,
  agentProfilesStub,
  ServerAuth.Config.configLayer({
    password: Option.some("executor-secret"),
    username: "executor",
    reviewerPassword: Option.some("reviewer-secret"),
    reviewerUsername: Option.some("reviewer"),
  }),
)

const itGoalReview = testEffect(itGoalReviewLayer)

const serveGoalReview = () =>
  HttpRouter.serve(goalReviewRoutes, { disableListenLog: true, disableLogger: true }).pipe(Layer.build)

function pendingGoal(input: { readonly goalID: string; readonly projectRef: string; readonly workspaceRef: string }) {
  return {
    goalID: input.goalID,
    revision: 4n,
    goal: { projectRef: input.projectRef, workspaceRef: input.workspaceRef },
    specs: [
      {
        specID: `spec-${input.goalID}`,
        accepted: false,
        acceptedBy: null,
        acceptedAtMs: null,
        rejectedBy: null,
        rejectedAtMs: null,
        proposedBy: "server_auth:author",
        specDigest: `blake3:${"a".repeat(64)}`,
        parentVersionID: null,
        objective: "Complete the reviewed task",
        projectRef: input.projectRef,
        workspaceRef: input.workspaceRef,
        capabilityScope: ["files.read"],
        scope: ["kernel/src/**"],
        constraints: ["Preserve user changes"],
        criteria: [{ id: "checks-pass", description: "Focused checks pass" }],
        budget: {
          maxTasks: 1,
          maxAttemptsPerTask: 1,
          maxRunDurationMs: 30_000,
          maxWorkers: 1,
          maxMemoryBytes: null,
          maxDiskBytes: null,
          maxTokens: null,
          maxCostMicros: null,
        },
        sourceDigests: [],
      },
    ],
    runs: [],
    acceptedSpecs: [],
  }
}

describe("Goal proposal v1 draft schema", () => {
  const draft = {
    schemaVersion: 1 as const,
    objective: "Finish a managed task",
    capabilityScope: ["files.patch", "files.read"],
    scope: ["kernel/src/**"],
    constraints: ["Preserve user work"],
    criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
    budget: {
      maxTasks: 2,
      maxAttemptsPerTask: 1,
      maxRunDurationMs: 30_000,
      maxWorkers: 1,
      maxTokens: 1000,
      maxCostMicros: 0,
    },
    sourceDigests: [],
  }

  test("accepts the exact v1 shape and rejects unsupported versions and forged authority fields", () => {
    expect(Schema.decodeUnknownSync(GoalProposalDraftV1)(draft, { onExcessProperty: "error" })).toEqual(draft)
    expect(() => Schema.decodeUnknownSync(GoalProposalDraftV1)({ ...draft, schemaVersion: 2 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(GoalProposalDraftV1)({ ...draft, principal: { kind: "server_auth", subject: "forged" } }, {
        onExcessProperty: "error",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(GoalProposalDraftV1)({ ...draft, budget: { ...draft.budget, maxWorkers: 17 } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(GoalProposalDraftV1)({ ...draft, capabilityScope: Array(65).fill("files.read") })).toThrow()
  })
})

describe("Goal verification v1 route contract", () => {
  const request = { schemaVersion: 1 as const, goalID: "goal-1", runID: "run-1" }

  test("accepts only the Goal and Run identifiers from the caller", () => {
    expect(Schema.decodeUnknownSync(GoalVerificationInputV1)(request, { onExcessProperty: "error" })).toEqual(request)
    expect(() =>
      Schema.decodeUnknownSync(GoalVerificationInputV1)({ ...request, schemaVersion: 2 }, { onExcessProperty: "error" }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(GoalVerificationInputV1)({ ...request, runID: "bad/run" })).toThrow()
    expect(() => Schema.decodeUnknownSync(GoalVerificationInputV1)({ ...request, goalID: "g".repeat(257) })).toThrow()
    for (const authority of [
      { principal: { kind: "server_auth", subject: "reviewer" } },
      { workspaceRevision: "blake3:forged" },
      { verifierProfileID: "caller-selected" },
      { capabilityLeaseDigest: "sha256:forged" },
      { artifactRefs: [] },
      { verdict: "PASS" },
    ]) {
      expect(() => Schema.decodeUnknownSync(GoalVerificationInputV1)({ ...request, ...authority }, { onExcessProperty: "error" })).toThrow()
    }
  })

  test("projects only safe verification and cancellation statuses and an optional abort reason", () => {
    const result = {
      schemaVersion: 1,
      status: "ABORTED",
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      finalRevision: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      setIdentityDigest: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      challengeSetDigest: "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      verificationRunID: "verification-1",
      reason: "transport_lost",
      revision: "12",
    } as const
    expect(Schema.decodeUnknownSync(GoalVerificationPayloadV1)(result, { onExcessProperty: "error" })).toEqual(result)
    for (const status of ["FAILED", "CANCELLING", "CANCELLED"] as const) {
      expect(
        Schema.decodeUnknownSync(GoalVerificationPayloadV1)({
          ...result,
          status,
          reason: undefined,
        }, { onExcessProperty: "error" }).status,
      ).toBe(status)
    }
    expect(() => Schema.decodeUnknownSync(GoalVerificationPayloadV1)({ ...result, leases: [] }, { onExcessProperty: "error" })).toThrow()
  })
})

describe("Goal Run control v1 route contract", () => {
  test("accepts only a Goal, Run, and bounded control action", () => {
    const input = {
      schemaVersion: 1 as const,
      action: "pause" as const,
      goalID: "goal-1",
      runID: "run-1",
      expectedRevision: "4",
    }
    expect(Schema.decodeUnknownSync(GoalRunControlInputV1)(input, { onExcessProperty: "error" })).toEqual(input)
    expect(() => Schema.decodeUnknownSync(GoalRunControlInputV1)({ ...input, action: "restart" })).toThrow()
    expect(() => Schema.decodeUnknownSync(GoalRunControlInputV1)({ ...input, expectedRevision: "18446744073709551616" }, { onExcessProperty: "error" })).toThrow()
  })
})

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setHeader("authorization", basic("executor", "executor-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )
  it.live("derives the delegated reviewer only from the credential that authenticated", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setHeader("authorization", basic("reviewer", "reviewer-secret")),
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            ...input,
            principal: { kind: "server_auth", subject: "forged" },
          }),
        ),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(authenticatedSubject)).toBe("reviewer")
    }),
  )
  it.live("rejects an invalid reviewer secret before the route runs", () =>
    Effect.gen(function* () {
      yield* Ref.set(called, undefined)
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setHeader("authorization", basic("reviewer", "wrong-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(401)
      expect(yield* Ref.get(called)).toBeUndefined()
    }),
  )
  it.live("returns unavailable when moving changes is requested", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setHeader("authorization", basic("executor", "executor-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ ...input, moveChanges: true })),
        HttpClient.execute,
      )

      expect(response.status).toBe(503)
    }),
  )
})

describe("Goal review inbox HttpApi", () => {
  itGoalReview.live("keeps independent verification unavailable before snapshot or verifier dispatch", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(directory)
      const workspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(workspaceID)
      yield* Ref.set(goalReviewHostResponse, pendingGoal({
        goalID: "goal-verify-disabled",
        projectRef: project.project.id,
        workspaceRef: String(workspaceID),
      }))
      yield* Ref.set(goalReviewHostCalls, [])
      yield* serveGoalReview()

      const response = yield* HttpClientRequest.post(
        `/experimental/control-plane/goal-verification?directory=${encodeURIComponent(directory)}` +
          `&workspace=${encodeURIComponent(String(workspaceID))}`,
      ).pipe(
        HttpClientRequest.setHeader("authorization", basic("reviewer", "reviewer-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ schemaVersion: 1, goalID: "goal-verify-disabled", runID: "run-1" })),
        HttpClient.execute,
      )

      expect(response.status).toBe(503)
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([])
    }),
  )

  itGoalReview.live("derives the Run control CAS revision from the current scoped OwnerLog snapshot", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(directory)
      const workspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(workspaceID)
      const projectRef = project.project.id
      const workspaceRef = String(workspaceID)
      yield* Ref.set(goalReviewHostResponse, pendingGoal({ goalID: "goal-control", projectRef, workspaceRef }))
      yield* Ref.set(goalReviewHostCalls, [])
      yield* serveGoalReview()
      const response = yield* HttpClientRequest.post(
        `/experimental/control-plane/goal-run-control?directory=${encodeURIComponent(directory)}` +
          `&workspace=${encodeURIComponent(workspaceRef)}`,
      ).pipe(
        HttpClientRequest.setHeader("authorization", basic("executor", "executor-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({
          schemaVersion: 1,
          action: "pause",
          goalID: "goal-control",
          runID: "run-control",
          expectedRevision: "4",
        })),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        schemaVersion: 1,
        goalID: "goal-control",
        runID: "run-control",
        status: "PAUSED",
        revision: "5",
      })
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([
        { serviceID: "managed.v1", operation: "snapshot" },
        { serviceID: "managed.v1", operation: "pause_run" },
      ])
      yield* Ref.set(goalReviewHostCalls, [])
      const stale = yield* HttpClientRequest.post(
        `/experimental/control-plane/goal-run-control?directory=${encodeURIComponent(directory)}` +
          `&workspace=${encodeURIComponent(workspaceRef)}`,
      ).pipe(
        HttpClientRequest.setHeader("authorization", basic("executor", "executor-secret")),
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({
          schemaVersion: 1,
          action: "resume",
          goalID: "goal-control",
          runID: "run-control",
          expectedRevision: "3",
        })),
        HttpClient.execute,
      )
      expect(stale.status).toBe(409)
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([{ serviceID: "managed.v1", operation: "snapshot" }])
    }),
  )

  itGoalReview.live("keeps plan revisions as DecimalU64 strings and requires authenticated planning", () =>
    Effect.gen(function* () {
      const revision = "18446744073709551615"
      const payload = {
        schemaVersion: 1,
        goalID: "goal-plan",
        specID: "spec-plan",
        specDigest: `blake3:${"a".repeat(64)}`,
        expectedGoalRevision: revision,
        runID: "run-plan",
        tasks: [{
          taskID: "task-plan",
          title: "Plan the reviewed task",
          purpose: "Exercise the plan wire contract",
          dependencies: [],
          criterionIDs: ["criterion-plan"],
          requiredCapabilities: [],
          profileSelection: { profileId: "default", revision },
        }],
      } as const
      expect(Schema.decodeUnknownSync(GoalRunPlanInputV1)(payload, { onExcessProperty: "error" }))
        .toMatchObject({ expectedGoalRevision: revision, tasks: [{ profileSelection: { revision } }] })
      yield* Ref.set(goalReviewHostCalls, [])
      yield* serveGoalReview()
      const response = yield* HttpClientRequest.post("/experimental/control-plane/goal-run-plan").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
        HttpClient.execute,
      )
      expect(response.status).toBe(401)
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([])
    }),
  )

  itGoalReview.live("requires authenticated explicit start and excludes actor identity from the request", () =>
    Effect.gen(function* () {
      const payload = {
        schemaVersion: 1,
        goalID: "goal-start",
        runID: "run-start",
        expectedGoalRevision: "18446744073709551615",
        specID: "spec-start",
        specDigest: `blake3:${"a".repeat(64)}`,
        // Core-verified active top-level Session selector: the caller supplies it
        // and Rust pins it atomically; identity fields are never derived here.
        sessionID: SessionV2.ID.make("ses_start"),
        idempotencyKey: "start-delivery-1",
      } as const
      expect(Schema.decodeUnknownSync(GoalRunStartInputV1)(payload, { onExcessProperty: "error" }))
        .toMatchObject({ expectedGoalRevision: "18446744073709551615", idempotencyKey: "start-delivery-1" })
      yield* Ref.set(goalReviewHostCalls, [])
      yield* serveGoalReview()
      const response = yield* HttpClientRequest.post("/experimental/control-plane/goal-run-start").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
        HttpClient.execute,
      )
      expect(response.status).toBe(401)
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([])
      expect(payload).not.toHaveProperty("startedBy")
      expect(payload).not.toHaveProperty("tasks")
      expect(payload).not.toHaveProperty("profileDefinition")
    }),
  )

  itGoalReview.live("authenticates the inbox read and scopes its paginated results to the current workspace", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(directory)
      const workspaceID = WorkspaceV2.ID.ascending()
      yield* withFixedWorkspaceID(workspaceID)

      const projectRef = project.project.id
      const workspaceRef = String(workspaceID)
      yield* Ref.set(goalReviewHostResponse, {
        goals: [
          pendingGoal({ goalID: "goal-z", projectRef, workspaceRef }),
          pendingGoal({ goalID: "goal-outside-workspace", projectRef, workspaceRef: `${workspaceRef}-other` }),
          pendingGoal({ goalID: "goal-b", projectRef, workspaceRef }),
          pendingGoal({ goalID: "goal-a", projectRef, workspaceRef }),
          pendingGoal({ goalID: "goal-outside-project", projectRef: `${projectRef}-other`, workspaceRef }),
        ],
      })
      yield* Ref.set(goalReviewHostCalls, [])
      yield* serveGoalReview()

      const path =
        `/experimental/control-plane/goal-reviews?directory=${encodeURIComponent(directory)}` +
        `&workspace=${encodeURIComponent(workspaceRef)}&afterGoalID=goal-a&limit=1`

      const unauthorized = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
      expect(unauthorized.status).toBe(401)
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([])

      const response = yield* HttpClientRequest.get(path).pipe(
        HttpClientRequest.setHeader("authorization", basic("reviewer", "reviewer-secret")),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        goals: [
          {
            goalID: "goal-b",
            proposals: [{ reviewAvailability: { available: true } }],
          },
        ],
        nextAfterGoalID: "goal-b",
      })
      expect(yield* Ref.get(goalReviewHostCalls)).toEqual([
        { serviceID: "managed.v1", operation: "list_pending_reviews" },
      ])
    }),
  )
})
