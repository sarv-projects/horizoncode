import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Database } from "@horizoncode/core/database/database"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { SessionProjector } from "@horizoncode/core/session/projector"
import {
  SessionSupervisor,
  SessionSupervisorError,
  type Interface as SessionSupervisorInterface,
} from "@horizoncode/core/session/supervisor"
import { Cause, Effect, Exit, Layer, LayerMap, Stream } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { AgentProfileService } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { LocationServiceMap } from "@horizoncode/core/location-service-map"
import {
  locationServiceMapNode,
  type LocationError,
  type LocationServices,
} from "@horizoncode/core/location-services"
import type * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { CrossSpawnSpawner } from "@horizoncode/core/cross-spawn-spawner"
import { Ripgrep } from "@horizoncode/core/ripgrep"
import { Session } from "@/session/session"
import { ManagedControl } from "@/session/managed-control"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { managedTaskSelectionPinsMatch, managedTaskTokenBudget, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { Global } from "@horizoncode/core/global"
import fs from "node:fs/promises"
import path from "node:path"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}
const model = { id: ref.modelID, providerID: ref.providerID } as Provider.Model

const UNAVAILABLE = [
  "Task/subagent execution is unavailable: an authenticated Rust direct Attempt",
  "could not be admitted, so no child session was created or prompted.",
].join(" ")
const RECEIPT = `blake3:${"a".repeat(64)}`
const PROFILE_CONFIG_DIR = path.join(Global.Path.tmp, `task-profile-test-${process.pid}`)

describe("managed Task token authority", () => {
  test("accepts Rust remainder only under the pinned AgentProfileV2 ceiling", () => {
    expect(managedTaskTokenBudget({ effectiveMaxTokens: "1000", remainingTokens: "400", profileTokenBudget: "1200" }))
      .toEqual({ effectiveMaxTokens: "1000", remainingTokens: "400" })
    expect(managedTaskTokenBudget({ effectiveMaxTokens: "1000", remainingTokens: "400" }))
      .toEqual({ effectiveMaxTokens: "1000", remainingTokens: "400" })
  })

  test("rejects exhaustion, forged increase, stale profile ceiling, and noncanonical values", () => {
    expect(() => managedTaskTokenBudget({ effectiveMaxTokens: "1000", remainingTokens: "0" })).toThrow()
    expect(() => managedTaskTokenBudget({ effectiveMaxTokens: "1000", remainingTokens: "1001" })).toThrow()
    expect(() => managedTaskTokenBudget({ effectiveMaxTokens: "1000", remainingTokens: "500", profileTokenBudget: "999" })).toThrow()
    expect(managedTaskTokenBudget({ effectiveMaxTokens: "9007199254740993", remainingTokens: "9007199254740993", profileTokenBudget: "18446744073709551615" })).toMatchObject({ effectiveMaxTokens: "9007199254740993" })
    expect(() => managedTaskTokenBudget({ effectiveMaxTokens: "01", remainingTokens: "1" })).toThrow()
  })

  test("rejects recovery when the accepted Spec or immutable AgentProfileV2 pin changed", () => {
    const task = { taskID: "task-a", profile: { profileID: "agent-a", revision: "3", definitionDigest: RECEIPT, ownerBindingDigest: RECEIPT } }
    const profileDefinition = { profileId: "agent-a", revision: "3" } as AgentProfileV2.AgentProfileDefinitionV2
    const handoff = { goalID: "goal-a", runID: "run-a", taskID: "task-a", acceptedSpecDigest: RECEIPT,
      profileID: "agent-a", profileRevision: "3", profileDigest: RECEIPT, profileDefinition }
    const input = { selection: { goalID: "goal-a", runID: "run-a", specDigest: RECEIPT }, task, handoff }
    expect(managedTaskSelectionPinsMatch(input as Parameters<typeof managedTaskSelectionPinsMatch>[0])).toBe(true)
    expect(managedTaskSelectionPinsMatch({ ...input, selection: { ...input.selection, specDigest: `blake3:${"b".repeat(64)}` } } as Parameters<typeof managedTaskSelectionPinsMatch>[0])).toBe(false)
    expect(managedTaskSelectionPinsMatch({ ...input, task: { ...task, profile: { ...task.profile, revision: "4" } } } as Parameters<typeof managedTaskSelectionPinsMatch>[0])).toBe(false)
  })
})

const profile = {
  schemaVersion: 2,
  profileId: "user.general",
  revision: 1,
  name: "general",
  description: "General purpose child",
  source: "user",
  roles: ["subagent"],
  purpose: "Complete a bounded subtask",
  whenToUse: "When independent work is needed",
  whenNotToUse: "When work is not delegated",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "test", modelId: "test-model" },
  harness: "native-rich",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: 4096 },
  tools: [{ effect: "allow", toolPattern: "files.read" }],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [],
  context: { isolation: "fresh", allowImages: true, allowDocuments: true, allowArtifacts: true },
  inputMode: "default",
  memoryPolicy: "none",
  isolation: "workspace",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 4, maxActiveChildren: 4, maxTotalChildren: 8, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 4,
  enabled: true,
} as const
await fs.mkdir(PROFILE_CONFIG_DIR, { recursive: true })
await Bun.write(path.join(PROFILE_CONFIG_DIR, "opencode.json"), JSON.stringify({
  agent_profiles: [profile],
  agent_profile_selectors: [{ selector: "general", profileId: "user.general", revision: 1 }],
}))
afterAll(() => fs.rm(PROFILE_CONFIG_DIR, { recursive: true, force: true }))

type ManagedCall = {
  readonly serviceID: string
  readonly operation: string
  readonly body: Record<string, unknown>
  readonly deliveryID?: string
}

type FakeAttempt = {
  readonly intent: Record<string, unknown>
  phase: "EXECUTING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED"
  receiptDigest: string | null
  resultDigest: string | null
  failureCode: string | null
  retryable: boolean | null
  revision: number
}

/**
 * Canonical `expectedRevision` parsing at the scripted kernel boundary. The
 * decoded domain form is a canonical decimal string, the private wire form is a
 * MessagePack uint64 (`bigint` in Core's `DirectAttemptScopeWireV1`), and
 * callers may legitimately hold a safe number — one value, three JS spellings.
 * Non-canonical spellings (`01`, `-1`, `1.0`, foreign objects) never coerce.
 */
function parseCanonicalRevision(value: unknown): bigint | null {
  const text =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value.toString()
        : typeof value === "string"
          ? value
          : undefined
  return text !== undefined && /^(0|[1-9][0-9]*)$/.test(text) ? BigInt(text) : null
}

/** Exact canonical equivalence with the durable numeric Attempt revision. */
function canonicalRevisionMatches(value: unknown, revision: number): boolean {
  const parsed = parseCanonicalRevision(value)
  return parsed !== null && parsed === BigInt(revision)
}

/**
 * Scripted stand-in for the authenticated `managed.v1` kernel boundary. It keeps the
 * one-use delivery-key discipline and returns the exact response shapes the real
 * kernel projects, so the Task tool's protocol usage and settlement bookkeeping are
 * exercised deterministically. The real kernel behavior over the real socket is
 * covered by `kernel/tests/{direct_attempt_rpc,hz_kernel_process}.rs`.
 */
class FakeManagedKernel {
  readonly calls: ManagedCall[] = []
  readonly boundEffectIDs: string[][] = []
  readonly attempts = new Map<string, FakeAttempt>()
  readonly deliveries = new Map<string, string>()
  hosted = true
  refuseAdmission: string | null = null
  failSettlement: string | null = null
  /** Typed refusal code returned when `failSettlement` is set. */
  failSettlementCode = "managed_conflict"

  #error(operation: string, code: string, reason: string) {
    return new SessionSupervisorError({ stage: "effect", reason: `${operation}: ${reason}`, hostCode: code })
  }

  handle(
    serviceID: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options?: { readonly deliveryID?: string },
  ): Effect.Effect<Record<string, unknown>, SessionSupervisorError> {
    const self = this
    return Effect.gen(function* () {
      if (serviceID !== "managed.v1") {
        return yield* Effect.fail(self.#error(operation, "capability_unavailable", "service is unavailable"))
      }
      const call: ManagedCall = {
        serviceID,
        operation,
        body: { ...body },
        ...(options?.deliveryID === undefined ? {} : { deliveryID: options.deliveryID }),
      }
      self.calls.push(call)
      const delivery = options?.deliveryID
      if (operation !== "direct_attempt_snapshot" && delivery === undefined) {
        return yield* Effect.fail(self.#error(operation, "invalid_effect_request", "delivery id is required"))
      }
      const response = (attemptID: string, status: string) => {
        const attempt = self.attempts.get(attemptID)!
        // The 15-field live scope both admit and snapshot project; the real
        // kernel stamps `expectedRevision` with the current Attempt revision.
        const directAttempt = {
          attemptID,
          parentSessionID: attempt.intent.parentSessionID,
          childSessionID: attempt.intent.childSessionID,
          profileID: String(attempt.intent.profileID),
          profileRevision: String(attempt.intent.profileRevision),
          profileDigest: String(attempt.intent.profileDigest),
          ownerEpoch: 1,
          expectedRevision: attempt.revision,
          locationID: attempt.intent.locationID,
          workspaceID: attempt.intent.workspaceID,
          workspaceRevision: `blake3:${"b".repeat(64)}`,
          capabilityDigest: attempt.intent.capabilityDigest,
          permissionsDigest: attempt.intent.permissionsDigest,
          budgetDigest: attempt.intent.budgetDigest,
          scopeDigest: attempt.intent.scopeDigest,
        }
        return {
          status,
          attemptID,
          attemptPhase: attempt.phase,
          ...attempt.intent,
          receiptDigest: attempt.receiptDigest,
          resultDigest: attempt.resultDigest,
          failureCode: attempt.failureCode,
          retryable: attempt.retryable,
          revision: attempt.revision,
          ...(status === "ADMITTED"
            ? {
                ownerEpoch: 1,
                locationID: attempt.intent.locationID,
                workspaceID: attempt.intent.workspaceID,
                directAttempt,
              }
            : status === "SNAPSHOT"
              ? { directAttempt }
              : {}),
        }
      }
      const claimDelivery = (key: string, logical: string) => {
        const previous = self.deliveries.get(key)
        if (previous !== undefined && previous !== logical) {
          return false
        }
        self.deliveries.set(key, logical)
        return true
      }

      if (operation === "admit_direct_attempt") {
        if (self.refuseAdmission) {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", self.refuseAdmission))
        }
        const attemptID = String(body.attemptID)
        const existing = self.attempts.get(attemptID)
        const logical = `admit:${String(body.childSessionID)}:${String(body.agent)}:${String(body.scopeDigest)}`
        if (existing) {
          if (!claimDelivery(delivery!, logical)) {
            return yield* Effect.fail(self.#error(operation, "managed_conflict", "direct Attempt ID already used"))
          }
          return response(attemptID, "ADMITTED")
        }
        self.attempts.set(attemptID, {
          intent: {
            parentSessionID: String(body.parentSessionID),
            childSessionID: String(body.childSessionID),
            profileID: String((body.profileSelection as Record<string, unknown>).profileId),
            profileRevision: String((body.profileSelection as Record<string, unknown>).revision),
            profileDigest: `blake3:${"d".repeat(64)}`,
            agent: String(body.agent),
            scopeDigest: String(body.scopeDigest),
            locationID: String(body.locationID),
            workspaceID: String(body.workspaceID),
            capabilityDigest: String(body.capabilityDigest),
            permissionsDigest: String(body.permissionsDigest),
            budgetDigest: String(body.budgetDigest),
          },
          phase: "EXECUTING",
          receiptDigest: null,
          resultDigest: null,
          failureCode: null,
          retryable: null,
          revision: 1,
        })
        claimDelivery(delivery!, logical)
        return response(attemptID, "ADMITTED")
      }

      const attemptID = String(body.attemptID)
      const attempt = self.attempts.get(attemptID)
      if (!attempt) {
        return yield* Effect.fail(self.#error(operation, "managed_not_found", "direct Attempt is unknown"))
      }

      if (operation === "settle_direct_attempt") {
        if (self.failSettlement) {
          return yield* Effect.fail(self.#error(operation, self.failSettlementCode, self.failSettlement))
        }
        const outcome = String(body.outcome)
        const logical = `settle:${outcome}:${String(body.resultDigest ?? "")}`
        if (!claimDelivery(`${delivery!}.settle`, logical)) {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", "idempotency key reused"))
        }
        if (attempt.phase !== "EXECUTING") {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", "direct Attempt is not executing"))
        }
        const expectedRevision = parseCanonicalRevision(body.expectedRevision)
        if (expectedRevision === null) {
          return yield* Effect.fail(self.#error(operation, "invalid_effect_request", "expectedRevision is not a canonical decimal revision"))
        }
        if (expectedRevision !== BigInt(attempt.revision)) {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", "stale direct Attempt revision"))
        }
        attempt.phase = outcome === "succeeded" ? "SUCCEEDED" : outcome === "failed" ? "FAILED" : "UNKNOWN"
        attempt.revision += 1
        if (outcome !== "unknown") {
          attempt.resultDigest = String(body.resultDigest)
          attempt.receiptDigest = RECEIPT
          attempt.failureCode = typeof body.failureCode === "string" ? body.failureCode : null
          attempt.retryable = typeof body.retryable === "boolean" ? body.retryable : null
        }
        const settled = response(attemptID, "SETTLED")
        return { ...settled, outcome: String(body.outcome).toUpperCase() }
      }

      if (operation === "bind_direct_attempt_effects") {
        const scope = body.directAttempt
        const effectIDs = body.effectIDs
        if (
          attempt.phase !== "EXECUTING" ||
          typeof scope !== "object" || scope === null ||
          !Array.isArray(effectIDs) || effectIDs.length === 0 ||
          effectIDs.some((effectID) => typeof effectID !== "string") ||
          !canonicalRevisionMatches((scope as Record<string, unknown>).expectedRevision, attempt.revision)
        ) {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", "invalid or stale direct effect binding"))
        }
        const boundIDs = effectIDs as string[]
        self.boundEffectIDs.push(boundIDs)
        attempt.revision += 1
        const refreshedScope = {
          ...(scope as Record<string, unknown>),
          expectedRevision: BigInt(attempt.revision),
        }
        return {
          status: "BOUND",
          attemptID,
          locationID: attempt.intent.locationID,
          effectIDs: boundIDs,
          revision: BigInt(attempt.revision),
          directAttempt: refreshedScope,
        }
      }

      if (operation === "cancel_direct_attempt") {
        const logical = "cancel"
        if (!claimDelivery(`${delivery!}.cancel`, logical)) {
          return yield* Effect.fail(self.#error(operation, "managed_conflict", "idempotency key reused"))
        }
        if (attempt.phase !== "CANCELLED") {
          if (attempt.phase !== "EXECUTING") {
            return yield* Effect.fail(self.#error(operation, "managed_conflict", "direct Attempt is not executing"))
          }
          const expectedRevision = parseCanonicalRevision(body.expectedRevision)
          if (expectedRevision === null) {
            return yield* Effect.fail(self.#error(operation, "invalid_effect_request", "expectedRevision is not a canonical decimal revision"))
          }
          if (expectedRevision !== BigInt(attempt.revision)) {
            return yield* Effect.fail(self.#error(operation, "managed_conflict", "stale direct Attempt revision"))
          }
          attempt.phase = "CANCELLED"
          attempt.revision += 1
        }
        return response(attemptID, "CANCELLED")
      }

      if (operation === "direct_attempt_snapshot") {
        return response(attemptID, "SNAPSHOT")
      }

      return yield* Effect.fail(self.#error(operation, "capability_unavailable", "operation is unavailable"))
    })
  }
}

/**
 * The active scripted kernel for the current test. The module-level supervisor layer
 * reads it lazily, so each test gets a fresh kernel without rebuilding the layer.
 */
let activeKernel = new FakeManagedKernel()

function freshKernel() {
  activeKernel = new FakeManagedKernel()
  return activeKernel
}

const testSupervisorLayer = Layer.succeed(
  SessionSupervisor.Service,
  SessionSupervisor.Service.of({
    open: () => Effect.die("unexpected direct supervisor open"),
    openForSession: () => Effect.die("unexpected direct supervisor open"),
    registerHostLocation: () => Effect.succeed(`loc_${"c".repeat(64)}`),
    prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
    replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
    awaitManagedVerifierApprovals: () => Effect.die("unexpected managed verifier approval"),
    prepareToolBatch: () => Effect.die("unexpected effect preparation"),
    executeWrite: () => Effect.die("unexpected effect execution"),
    executePatch: () => Effect.die("unexpected patch execution"),
    runPatch: () => Effect.die("unexpected patch execution"),
    requestHostKernel: (
      serviceID: string,
      operation: string,
      body: Readonly<Record<string, unknown>>,
      options?: { readonly deliveryID?: string },
    ) => activeKernel.handle(serviceID, operation, body, options),
    hostOwnerEpoch: () =>
      activeKernel.hosted
        ? Effect.succeed(1)
        : Effect.fail(new SessionSupervisorError({ stage: "host-kernel", reason: "host kernel is unavailable" })),
    subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
    watchSession: () => Effect.die("unexpected session watch"),
  } as unknown as SessionSupervisorInterface),
)

const testSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: testSupervisorLayer,
  deps: [],
  tag: SessionSupervisor.node.tag,
})

const testAgentProfiles = Layer.succeed(
  AgentProfileService,
  AgentProfileService.of({
    agentProfiles: () =>
      Effect.succeed([profile as unknown as AgentProfileV2.AgentProfileDefinitionV2]),
    agentProfileSelectors: () =>
      Effect.succeed([
        {
          selector: "general",
          profile: profile as unknown as AgentProfileV2.AgentProfileDefinitionV2,
        },
      ]),
    agentProfile: () => Effect.succeed(profile as unknown as AgentProfileV2.AgentProfileDefinitionV2),
    agentProfileSelector: () => Effect.succeed(profile as unknown as AgentProfileV2.AgentProfileDefinitionV2),
    primaryAgentProfile: () => Effect.succeed(profile as unknown as AgentProfileV2.AgentProfileDefinitionV2),
  }),
)

const testLocationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: Layer.succeed(
    LocationServiceMap.Service,
    {
      get: () => testAgentProfiles,
    } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
  ),
  deps: [],
})

const failedBackgroundNode = (failure: "extend" | "start") => {
  const error = new Error(`injected background ${failure} failure`)
  return LayerNode.make({
    service: BackgroundJob.Service,
    layer: Layer.succeed(
      BackgroundJob.Service,
      BackgroundJob.Service.of({
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(undefined),
        start: () => Effect.die(error),
        extend: () => (failure === "extend" ? Effect.die(error) : Effect.succeed(false)),
        wait: () => Effect.succeed({ timedOut: false }),
        waitForPromotion: () => Effect.never,
        promote: () => Effect.succeed(undefined),
        cancel: () => Effect.succeed(undefined),
      }),
    ),
    deps: [],
    tag: BackgroundJob.node.tag,
  })
}

const promotionBackgroundNode = () => {
  const state = { cancelCalls: 0 }
  const layer = LayerNode.make({
    service: BackgroundJob.Service,
    layer: Layer.succeed(
      BackgroundJob.Service,
      BackgroundJob.Service.of({
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(undefined),
        start: (input) =>
          (input.onPromote ?? Effect.void).pipe(
            Effect.as({
              id: input.id ?? "task-promotion-test",
              type: input.type,
              title: input.title,
              status: "running" as const,
              started_at: Date.now(),
            }),
          ),
        extend: () => Effect.succeed(false),
        wait: () => Effect.succeed({ timedOut: false }),
        waitForPromotion: () => Effect.never,
        promote: () => Effect.succeed(undefined),
        cancel: () => Effect.sync(() => void state.cancelCalls++),
      }),
    ),
    deps: [],
    tag: BackgroundJob.node.tag,
  })
  return { layer, state }
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}, background?: LayerNode.Node<BackgroundJob.Service>) =>
  (() => {
    const root = LayerNode.group([
      Agent.node,
      background ?? BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      Provider.node,
      locationServiceMapNode,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      testSupervisorNode,
    ])
    const replacements = [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      [SessionSupervisor.node, testSupervisorNode],
      [Global.node, Global.layerWith({ config: PROFILE_CONFIG_DIR })],
      [locationServiceMapNode, testLocationServiceMapNode],
      [
        Provider.node,
        Layer.mock(Provider.Service, {
          getModel: () => Effect.succeed(model),
        }),
      ],
    ] as const
    if (!background) return LayerNode.compile(root, replacements)
    return LayerNode.compile(root, [...replacements, [BackgroundJob.node, background] as const])
  })()

const it = testEffect(layer())
const backgroundFailureTest = (failure: "extend" | "start") => testEffect(layer({}, failedBackgroundNode(failure)))
const backgroundPromotion = promotionBackgroundNode()
const backgroundPromotionTest = testEffect(
  layer({ experimentalBackgroundSubagents: true }, backgroundPromotion.layer),
)

const seed = Effect.fn("TaskToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Parent", workspaceID: WorkspaceV2.ID.make("wrk_task_test") })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function outputText(input: { info: SessionV1.Assistant; text: string }): SessionV1.WithParts {
  return {
    info: input.info,
    parts: [{ type: "text", id: "prt_task_result", sessionID: input.info.sessionID, messageID: input.info.id, text: input.text }],
  } as unknown as SessionV1.WithParts
}

function promptOps(input: Partial<TaskPromptOps> = {}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.die("unexpected subagent prompt"),
    ...input,
  }
}

function expectFailure(exit: Exit.Exit<unknown, unknown>): Error {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected Task/subagent dispatch to fail")
  console.error(Cause.pretty(exit.cause))
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("expected an Error")
  return error
}

const baseContext = (chat: { id: SessionID }, assistant: { id: MessageID }, abort: AbortSignal) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort,
  trustedPrincipal: { kind: "server_auth" as const, subject: "task-test" },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("direct Attempt expectedRevision canonical forms", () => {
  const admitBody = (attemptID: string): Record<string, unknown> => ({
    attemptID,
    parentSessionID: "ses_parent000000000000",
    childSessionID: `ses_${attemptID}`,
    agent: "general",
    profileSelection: { profileId: "user.general", revision: 1 },
    scopeDigest: `sha256:${"a".repeat(64)}`,
    locationID: `loc_${"c".repeat(64)}`,
    workspaceID: "workspace-1",
    capabilityDigest: `sha256:${"b".repeat(64)}`,
    permissionsDigest: `sha256:${"d".repeat(64)}`,
    budgetDigest: `sha256:${"e".repeat(64)}`,
  })

  it.instance(
    "cancel and settle accept string, number and bigint revisions and still fence stale or non-canonical values",
    () => {
      const kernel = freshKernel()
      return Effect.gen(function* () {
        const admit = (attemptID: string) =>
          Effect.exit(
            kernel.handle("managed.v1", "admit_direct_attempt", admitBody(attemptID), {
              deliveryID: `admit-${attemptID}`,
            }),
          )
        const cancelBody = (attemptID: string, expectedRevision: unknown) =>
          Effect.exit(
            kernel.handle(
              "managed.v1",
              "cancel_direct_attempt",
              { attemptID, expectedRevision },
              { deliveryID: `cancel-${attemptID}` },
            ),
          )
        const settleBody = (attemptID: string, expectedRevision: unknown) =>
          Effect.exit(
            kernel.handle(
              "managed.v1",
              "settle_direct_attempt",
              {
                attemptID,
                outcome: "succeeded",
                expectedRevision,
                resultDigest: `sha256:${"f".repeat(64)}`,
              },
              { deliveryID: `settle-${attemptID}` },
            ),
          )

        // Consumer seam: raw kernel bodies in each canonical JS spelling.
        for (const [attemptID, revision] of [
          ["att_consumerstring01", "1"],
          ["att_consumernumber01", 1],
          ["att_consumerbigint01", 1n],
        ] as const) {
          expect(Exit.isSuccess(yield* admit(attemptID))).toBe(true)
          expect(Exit.isSuccess(yield* cancelBody(attemptID, revision))).toBe(true)
          expect(kernel.attempts.get(attemptID)!.phase).toBe("CANCELLED")
        }
        for (const [attemptID, revision] of [
          ["att_settlestring0001", "1"],
          ["att_settlenumber0001", 1],
          ["att_settlebigint0001", 1n],
        ] as const) {
          expect(Exit.isSuccess(yield* admit(attemptID))).toBe(true)
          expect(Exit.isSuccess(yield* settleBody(attemptID, revision))).toBe(true)
          expect(kernel.attempts.get(attemptID)!.phase).toBe("SUCCEEDED")
        }

        // Producer seam: managed-control accepts every documented input form
        // and always serializes the uint64 wire form (bigint) in the body.
        for (const [attemptID, input] of [
          ["att_producerstring001", "1"],
          ["att_producernumber001", 1],
          ["att_producerbigint001", 1n],
        ] as const) {
          expect(Exit.isSuccess(yield* admit(attemptID))).toBe(true)
          const cancel = yield* Effect.exit(
            ManagedControl.cancelDirectAttempt({ attemptID, expectedRevision: input }),
          )
          expect(Exit.isSuccess(cancel)).toBe(true)
          expect(kernel.attempts.get(attemptID)!.phase).toBe("CANCELLED")
          const recorded = [...kernel.calls].reverse().find((call) => call.operation === "cancel_direct_attempt")!
          expect(typeof recorded.body.expectedRevision).toBe("bigint")
        }
        const settleAttemptID = "att_producersettle001"
        expect(Exit.isSuccess(yield* admit(settleAttemptID))).toBe(true)
        const settle = yield* Effect.exit(
          ManagedControl.settleDirectAttempt({
            attemptID: settleAttemptID,
            outcome: "succeeded",
            expectedRevision: "1",
            resultDigest: `sha256:${"f".repeat(64)}`,
          }),
        )
        expect(Exit.isSuccess(settle)).toBe(true)
        expect(kernel.attempts.get(settleAttemptID)!.phase).toBe("SUCCEEDED")
        const recordedSettle = [...kernel.calls].reverse().find((call) => call.operation === "settle_direct_attempt")!
        expect(typeof recordedSettle.body.expectedRevision).toBe("bigint")

        // A stale value is still a typed conflict — never retried blindly.
        const staleID = "att_stalerevision0001"
        expect(Exit.isSuccess(yield* admit(staleID))).toBe(true)
        const stale = yield* cancelBody(staleID, 2)
        expect(expectFailure(stale).message).toContain("stale direct Attempt revision")

        // A non-canonical spelling is rejected as invalid, never coerced.
        const invalidID = "att_noncanonical00001"
        expect(Exit.isSuccess(yield* admit(invalidID))).toBe(true)
        const invalid = yield* cancelBody(invalidID, "01")
        expect(expectFailure(invalid).message).toContain("expectedRevision is not a canonical decimal revision")
      })
    },
  )
})

describe("tool.task authenticated dispatch", () => {
  it.instance("an unavailable host kernel refuses dispatch with zero child effect", () => {
    const kernel = freshKernel()
    kernel.hosted = false
    return Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      let metadataUpdates = 0
      let permissionAsks = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            agent: "plan",
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () =>
                  Effect.sync(() => {
                    prompts += 1
                    throw new Error("subagent prompt must not run while the host kernel is unavailable")
                  }),
              }),
            },
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.sync(() => permissionAsks++),
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain(UNAVAILABLE)
      expect(kernel.calls).toHaveLength(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(yield* jobs.list()).toHaveLength(0)
      expect(prompts).toBe(0)
      expect(metadataUpdates).toBe(0)
      expect(permissionAsks).toBe(0)
    })
  })

  it.instance("an admission refusal keeps the child uncreated and unprompted", () => {
    const kernel = freshKernel()
    kernel.refuseAdmission = "admission refused by the kernel"
    return Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      let metadataUpdates = 0
      let permissionAsks = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              promptOps: promptOps({
                prompt: () =>
                  Effect.sync(() => {
                    prompts += 1
                    throw new Error("subagent prompt must not run while admission is refused")
                  }),
              }),
            },
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.sync(() => permissionAsks++),
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("managed_conflict")
      // The permission prompt precedes admission, and the refused admission still
      // produces zero child effect: no child session, no prompt, no metadata.
      expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt"])
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(permissionAsks).toBe(1)
      expect(prompts).toBe(0)
      expect(metadataUpdates).toBe(0)
    })
  })

  it.instance("a metadata failure after direct Attempt admission cancels before prompting", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "inspect", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({ prompt: () => Effect.sync(() => (prompts++, outputText({ info: assistant, text: "" }))) }),
            },
            metadata: () => Effect.die(new Error("metadata projection failed")),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(expectFailure(exit).message).toContain("metadata projection failed")
      expect(prompts).toBe(0)
      expect([...kernel.attempts.values()].map((attempt) => attempt.phase)).toEqual(["CANCELLED"])
      expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt", "cancel_direct_attempt"])
    })
  })

  it.instance("missing prompt operations after admission cancel the Attempt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let metadataUpdates = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "inspect", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: { bypassAgentCheck: true },
            metadata: () => Effect.sync(() => metadataUpdates++),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(expectFailure(exit).message).toContain("TaskTool requires promptOps")
      expect(metadataUpdates).toBe(1)
      expect([...kernel.attempts.values()].map((attempt) => attempt.phase)).toEqual(["CANCELLED"])
      expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt", "cancel_direct_attempt"])
    })
  })

  backgroundFailureTest("extend").instance("background extension failure cancels the admitted Attempt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "inspect", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({ prompt: () => Effect.sync(() => (prompts++, outputText({ info: assistant, text: "" }))) }),
            },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(expectFailure(exit).message).toContain("injected background extend failure")
      expect(prompts).toBe(0)
      expect([...kernel.attempts.values()].map((attempt) => attempt.phase)).toEqual(["CANCELLED"])
      expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt", "cancel_direct_attempt"])
    })
  })

  backgroundFailureTest("start").instance("background start failure cancels the admitted Attempt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "inspect", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.sync(() => (prompts++, outputText({ info: assistant, text: "" }))),
              }),
            },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(expectFailure(exit).message).toContain("injected background start failure")
      expect(prompts).toBe(0)
      expect([...kernel.attempts.values()].map((attempt) => attempt.phase)).toEqual(["CANCELLED"])
      expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt", "cancel_direct_attempt"])
    })
  })

  backgroundPromotionTest.instance(
    "onPromote metadata failure cancels the running child and admitted Attempt",
    () => {
      const kernel = freshKernel()
      return Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let metadataUpdates = 0

        const exit = yield* def
          .execute(
            { description: "inspect bug", prompt: "inspect", subagent_type: "general", background: true },
            {
              ...baseContext(chat, assistant, new AbortController().signal),
              extra: {
                bypassAgentCheck: true,
                promptOps: promptOps(),
              },
              metadata: () =>
                Effect.suspend(() =>
                ++metadataUpdates === 1 ? Effect.void : Effect.die(new Error("promotion metadata failed")),
                ),
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(expectFailure(exit).message).toContain("promotion metadata failed")
        expect(metadataUpdates).toBe(2)
        expect(backgroundPromotion.state.cancelCalls).toBe(1)
        expect([...kernel.attempts.values()].map((attempt) => attempt.phase)).toEqual(["CANCELLED"])
        expect(kernel.calls.map((call) => call.operation)).toEqual(["admit_direct_attempt", "cancel_direct_attempt"])
      })
    },
  )

  it.instance("an admitted dispatch binds the child to the Attempt and settles with a receipt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted: SessionPrompt.PromptInput | undefined
      const metadata: Array<Record<string, unknown>> = []

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: (input, directAttempt) =>
                  Effect.gen(function* () {
                    prompted = input
                    expect(directAttempt).toBeDefined()
                    const scope = directAttempt!.currentScope()
                    expect(scope.childSessionID).toBe(input.sessionID)
                    const bound = yield* ManagedControl.bindDirectAttemptEffects({
                      scope,
                      effectIDs: ["effect_child_write", "effect_child_shell"],
                    }).pipe(
                      Effect.catchTag("ManagedControlError", (error) =>
                        Effect.fail(
                          new SessionSupervisorError({ stage: "host-kernel", reason: error.message }),
                        ),
                      ),
                    )
                    yield* Effect.try({
                      try: () =>
                        directAttempt!.acceptRefreshedScope({
                          previous: scope,
                          refreshed: bound.directAttempt,
                          transition: "batch_bind",
                        }),
                      catch: (error) =>
                        new SessionSupervisorError({
                          stage: "host-kernel",
                          reason: error instanceof Error ? error.message : "direct Attempt bind failed",
                        }),
                    })
                    expect(directAttempt!.currentScope().expectedRevision).toBe("2")
                    return outputText({ info: assistant, text: "child output" })
                  }).pipe(Effect.provide(testSupervisorLayer)),
              }),
            },
            metadata: (input) => Effect.sync(() => void metadata.push(input.metadata ?? {})),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) throw new Error("expected the admitted task to complete")
      const admitted = kernel.calls[0]!
      expect(admitted.operation).toBe("admit_direct_attempt")
      expect(admitted.deliveryID).toMatch(/^att_[a-f0-9]{32}$/)
      const admittedChild = SessionID.make(String(admitted.body.childSessionID))
      const admittedDigest = String(admitted.body.scopeDigest)
      expect(admittedDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(admitted.body.locationID).toBe(`loc_${"c".repeat(64)}`)
      expect(admitted.body.workspaceID).toBe("wrk_task_test")
      expect(admitted.body.capabilityDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(admitted.body.permissionsDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(admitted.body.budgetDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      // The child session is the exact id the Attempt was admitted for, and it is a
      // real child of the requesting session.
      expect(prompted?.sessionID).toBe(admittedChild)
      expect((yield* sessions.get(admittedChild)).parentID).toBe(chat.id)
      const bind = kernel.calls.find((call) => call.operation === "bind_direct_attempt_effects")!
      expect(bind.body.attemptID).toBe(admitted.body.attemptID)
      expect(bind.body.locationID).toBe(admitted.body.locationID)
      expect(bind.body.sessionID).toBe(admitted.body.childSessionID)
      expect(bind.body.effectIDs).toEqual(["effect_child_write", "effect_child_shell"])
      expect(kernel.boundEffectIDs).toEqual([["effect_child_write", "effect_child_shell"]])

      const settle = kernel.calls.find((call) => call.operation === "settle_direct_attempt")!
      expect(String(settle.body.outcome)).toBe("succeeded")
      expect(String(settle.body.resultDigest)).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(settle.body.expectedRevision).toBe(2n)
      expect(settle.deliveryID).toBe(`${admitted.deliveryID}.settle`)

      expect(kernel.attempts.get(String(admitted.body.attemptID))!.phase).toBe("SUCCEEDED")
      expect(exit.value.output).toContain(`attempt="${String(admitted.body.attemptID)}"`)
      expect(exit.value.output).toContain(`receipt="${RECEIPT}"`)
      expect(exit.value.metadata.attemptReceipt).toBe(RECEIPT)
      expect(exit.value.metadata.attemptID).toBe(String(admitted.body.attemptID))
      expect(metadata.some((entry) => entry.attemptID === String(admitted.body.attemptID))).toBe(true)
    })
  })

  it.instance("a child failure is settled as a typed failure, not as success", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.die(new Error("model unavailable")),
              }),
            },
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("model unavailable")
      const settle = kernel.calls.find((call) => call.operation === "settle_direct_attempt")!
      expect(String(settle.body.outcome)).toBe("failed")
      expect(String(settle.body.failureCode)).toBe("child_failed")
      expect(String(settle.body.resultDigest)).toMatch(/^sha256:[a-f0-9]{64}$/)
    })
  })

  it.instance("cancellation records the durable cancel fence for the Attempt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const controller = new AbortController()
      let prompts = 0
      let cancelled = 0

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, controller.signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                cancel: () =>
                  Effect.sync(() => {
                    cancelled += 1
                  }),
                prompt: () =>
                  Effect.gen(function* () {
                    prompts += 1
                    // The child is in flight while the user aborts the parent Task. The
                    // parent registers its abort listener before the child prompt starts,
                    // so both the parent-side cancel and the durable Attempt fence run.
                    yield* Effect.sleep("50 millis")
                    controller.abort()
                    yield* Effect.sleep("25 millis")
                    return yield* Effect.die(new Error("child cancelled"))
                  }),
              }),
            },
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("child cancelled")
      expect(prompts).toBe(1)
      yield* pollWithTimeout(
        Effect.sync(() => (cancelled === 1 ? (true as const) : undefined)),
        "aborting the parent Task never cancelled the child session run",
      )
      const attempt = [...kernel.attempts.values()][0]!
      expect(attempt.phase).toBe("CANCELLED")
      const cancel = kernel.calls.find((call) => call.operation === "cancel_direct_attempt")!
      expect(cancel.body.expectedRevision).toBe(1n)
      // A cancelled Attempt is never settled as success afterwards.
      expect(kernel.calls.some((call) => call.operation === "settle_direct_attempt")).toBe(false)
    })
  })

  it.instance("an UNKNOWN Attempt after restart cannot be settled as a verified result", () => {
    const kernel = freshKernel()
    kernel.failSettlement = "admitted direct Attempt is UNKNOWN after recovery and must be reconciled"
    kernel.failSettlementCode = "managed_attempt_unknown"
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.sync(() => outputText({ info: assistant, text: "child output" })),
              }),
            },
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      // The parent never sees a completed result: the unreconciled Attempt is
      // surfaced with the kernel's own typed code and the tool fails closed.
      expect(error.message).toContain("could not be settled as attempt")
      expect(error.message).toContain("managed_attempt_unknown")
      const attempt = [...kernel.attempts.values()][0]!
      expect(attempt.phase).toBe("EXECUTING")
      expect(kernel.calls.some((call) => call.operation === "cancel_direct_attempt")).toBe(false)
    })
  })

  it.instance("a stale revision fence is surfaced as a typed conflict, never retried blindly", () => {
    const kernel = freshKernel()
    kernel.failSettlement = "stale direct Attempt revision"
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.sync(() => outputText({ info: assistant, text: "child output" })),
              }),
            },
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("managed_conflict")
      expect(error.message).toContain("stale")
      // Exactly one settlement attempt: a stale fence is never silently retried.
      expect(kernel.calls.filter((call) => call.operation === "settle_direct_attempt")).toHaveLength(1)
    })
  })

  it.instance("a settlement refusal fails closed instead of claiming a verified result", () => {
    const kernel = freshKernel()
    kernel.failSettlement = "settlement refused by the kernel"
    return Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.sync(() => outputText({ info: assistant, text: "child output" })),
              }),
            },
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("could not be settled as attempt")
      expect(error.message).toContain("managed_conflict")
    })
  })

  it.instance("resuming a parent-owned child is fenced by the same Attempt boundary", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let metadataUpdates = 0

      // A real first dispatch is what writes the immutable profile/attempt pins
      // into the child's metadata and admits the durable Attempt a resume must
      // later snapshot — a hand-crafted child can never satisfy the authenticated
      // live-Attempt match (`task_id does not identify...` /
      // `resuming a child without its immutable AgentProfileV2 pin`).
      const initial = yield* def
        .execute(
          { description: "initial task", prompt: "start the existing task", subagent_type: "general" },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () => Effect.sync(() => outputText({ info: assistant, text: "child output" })),
              }),
            },
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isSuccess(initial)).toBe(true)
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      const child = children[0]!
      const attemptID = String(kernel.calls[0]!.body.attemptID)
      expect(String(kernel.calls[0]!.body.childSessionID)).toBe(child.id)

      // Recreate the mid-flight state a real resume observes: the Attempt is
      // admitted and still EXECUTING (pre-bind, no terminal receipt), and the
      // one-use delivery keys are free for the resumed settlement.
      const inFlight = kernel.attempts.get(attemptID)!
      inFlight.phase = "EXECUTING"
      inFlight.revision = 1
      inFlight.receiptDigest = null
      inFlight.resultDigest = null
      inFlight.failureCode = null
      inFlight.retryable = null
      kernel.deliveries.clear()
      // The existing child carries its own restriction on top of the derived
      // rules; the resume merge must preserve it.
      yield* sessions.setPermission({
        sessionID: child.id,
        permission: [
          ...(child.permission ?? []),
          { permission: "read", pattern: "*", action: "deny" as const },
        ],
      })

      const callsBeforeResume = kernel.calls.length
      let resumePrompts = 0
      const exit = yield* def
        .execute(
          { description: "resume child", prompt: "continue the existing task", subagent_type: "general", task_id: child.id },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              bypassAgentCheck: true,
              promptOps: promptOps({
                prompt: () =>
                  Effect.sync(() => {
                    resumePrompts += 1
                    return outputText({ info: assistant, text: "resumed output" })
                  }),
              }),
            },
            metadata: () => Effect.sync(() => metadataUpdates++),
          },
        )
        .pipe(Effect.exit)

      // Fencing contract while `DIRECT_CHILD_TURN_RPC_ENABLED` stays false
      // (resume/follow-up is closed until the integrated P1 Guard/lease path and
      // P8 recovery acceptance — see the flag's own comment in
      // `src/session/managed-control.ts`): the resume resolves the SAME Attempt
      // through the authenticated live snapshot first — never admitting a
      // replacement (the test's namesake boundary) — and is then refused by the
      // direct-turn lifecycle gate before any prompt, settlement or child
      // mutation. RE-ARM: when that flag opens, restore the successful-resume
      // assertions (snapshot + settle + metadataUpdates === 1) recorded in
      // `reports/phases/P2.md` continuation 30.
      const error = expectFailure(exit)
      expect(error.message).toContain("direct child turns remain disabled")
      const resumeCalls = kernel.calls.slice(callsBeforeResume)
      expect(resumeCalls.map((call) => call.operation)).toEqual(["direct_attempt_snapshot"])
      expect(resumePrompts).toBe(0)
      expect(kernel.calls.filter((call) => call.operation === "admit_direct_attempt")).toHaveLength(1)
      // The existing child keeps its original deny rule, untouched by the refusal.
      const existing = yield* sessions.get(child.id)
      expect(existing.permission).toContainEqual({ permission: "read", pattern: "*", action: "deny" })
    })
  })

  it.instance("foreign task IDs cannot acquire any Attempt", () => {
    const kernel = freshKernel()
    return Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const otherParent = yield* sessions.create({ title: "Other parent" })
      const foreign = yield* sessions.create({
        parentID: otherParent.id,
        agent: "general",
        permission: Permission.fromConfig({ read: "deny" }),
        title: "Foreign child",
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let metadataUpdates = 0

      const exit = yield* def
        .execute(
          {
            description: "resume foreign task",
            prompt: "continue the task",
            subagent_type: "general",
            task_id: foreign.id,
          },
          {
            ...baseContext(chat, assistant, new AbortController().signal),
            extra: {
              promptOps: promptOps({ prompt: () => Effect.die("unexpected foreign prompt") }),
            },
            metadata: () => Effect.sync(() => metadataUpdates++),
          },
        )
        .pipe(Effect.exit)

      const error = expectFailure(exit)
      expect(error.message).toContain("task_id does not identify a child session")
      expect(kernel.calls).toHaveLength(0)
      expect((yield* sessions.get(foreign.id)).permission).toEqual(Permission.fromConfig({ read: "deny" }))
      expect(metadataUpdates).toBe(0)
    })
  })
})
