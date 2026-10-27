import { describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Location } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import {
  DEFAULT_IDLE_TTL_MS,
  CallbackAdmissionError,
  CallbackCapabilityDeniedError,
  DeadlineLimitError,
  Operation as ReplOperationSchema,
  ReplLifecycle,
  StaleRefError,
  TransitionError,
  UnavailableError,
  authorizeEffect,
  availability,
  dispatchSupervisedReplOperationV1,
  isDefinitiveReplOperationFailure,
  guardActionID,
  makeRegistry,
  projectReplCallbackInvocationV1,
  replCallbackIngressAvailable,
  readSupervisedStatusV1,
  replEffectRouteAvailable,
  requireEffectAllowed,
  setReplEffectRoute,
  validateExecutionReplOperationRequestV1,
  validateExecutionReplOperationReceiptV1,
  validateExecutionReplNextSequenceV1,
  type ReplEffectRequest,
  type Operation,
} from "@/repl/lifecycle"
import {
  cancelSupervisedReplV1,
  readSupervisedReplOutputV1,
  readSupervisedReplStatusV1,
  ReplProcessUnavailableError,
} from "@/repl/supervised"
import {
  MAX_CALLBACK_CAPABILITIES,
  MAX_CODE_BYTES,
  MAX_OUTPUT_REFERENCES_PER_GENERATION,
  MAX_SCOPE_BYTES,
  ProtocolError,
  parseExecuteRequest,
  type ExecuteResult,
} from "@/repl/protocol"
import { it } from "../lib/effect"

const ALL_OPERATIONS: readonly Operation[] = [
  "repl.start", "repl.execute", "repl.callback", "repl.reset", "repl.status", "repl.output_range", "repl.stop",
]
const resourceLimits = { maxMemoryBytes: 512 * 1024 * 1024, maxWallTimeMs: 30_000, maxOutputBytes: 1024 * 1024 }
const resourceGuarantees = {
  cpuTimeEnforced: true,
  memoryEnforced: true,
  processCountEnforced: true,
  fileDescriptorsEnforced: true,
}
const interpreterProcessRef = {
  executionID: "repl-process-1",
  generation: "1",
  ownerEpoch: "7",
  kind: "interpreter" as const,
  profileID: "repl-python",
  profileRevision: "1",
  profileDigest: "blake3:" + "c".repeat(64),
  executableDigest: "blake3:" + "d".repeat(64),
}
const authority = {
  ownerId: "principal-1",
  locationID: "location-1",
  workspaceId: "ws-1",
  workspaceRevision: "blake3:" + "1".repeat(64),
  ownerEpoch: "7",
  sourceGeneration: "source-1",
  sandboxGeneration: 1,
  policyGeneration: "policy-1",
  capabilityCeilingDigest: "blake3:" + "a".repeat(64),
  directAttemptScope: {
    attemptID: "attempt-direct-1",
    parentSessionID: "parent-session-1",
    childSessionID: "repl-1",
    ownerEpoch: "7",
    expectedRevision: "1",
    locationID: "location-1",
    workspaceID: "ws-1",
    workspaceRevision: "blake3:" + "1".repeat(64),
    profileID: "profile-python",
    profileRevision: "1",
    profileDigest: "blake3:" + "f".repeat(64),
    capabilityDigest: "blake3:" + "b".repeat(64),
    permissionsDigest: "blake3:" + "c".repeat(64),
    budgetDigest: "blake3:" + "d".repeat(64),
    scopeDigest: "blake3:" + "e".repeat(64),
  },
}

type CreateInput = Parameters<ReplLifecycle.Registry["create"]>[0]
function createSession(
  registry: ReplLifecycle.Registry,
  input: Omit<CreateInput, keyof typeof authority | "launchProfileRef"> & Partial<typeof authority>,
) {
  const scope = input.managedAttemptScope
    ? { directAttemptScope: undefined }
    : {
        directAttemptScope: input.directAttemptScope ?? {
          ...authority.directAttemptScope,
          childSessionID: input.sessionID ?? "repl-1",
          ownerEpoch: input.ownerEpoch ?? authority.ownerEpoch,
          locationID: input.locationID ?? authority.locationID,
          workspaceID: input.workspaceId ?? authority.workspaceId,
          workspaceRevision: input.workspaceRevision ?? authority.workspaceRevision,
        },
      }
  return registry.create({
    ...authority,
    launchProfileRef: { profileId: "repl-python", revision: "1", profileDigest: "blake3:" + "c".repeat(64) },
    ...scope,
    ...input,
  })
}

const authorityFor = (session: ReplLifecycle.ReplSession) => ({
  ownerId: session.ownerId,
  locationID: session.locationID,
  workspaceId: session.workspaceId,
  workspaceRevision: session.workspaceRevision,
  ownerEpoch: session.ownerEpoch,
  managedAttemptScope: session.managedAttemptScope,
  directAttemptScope: session.directAttemptScope,
  sourceGeneration: session.sourceGeneration,
  sandboxGeneration: session.sandboxGeneration,
  policyGeneration: session.policyGeneration,
  capabilityCeilingDigest: session.capabilityCeilingDigest,
})

const effectRequest = (operation: Operation, over: Partial<ReplEffectRequest> = {}): ReplEffectRequest => ({
  operation,
  sessionID: "repl-1",
  generation: 1,
  language: "python",
  scope: "workspace://ws-1",
  resourceLimits,
  callbackCapabilities: ["files.read"],
  ...authority,
  ...(!["repl.start"].includes(operation) ? { processRef: interpreterProcessRef } : {}),
  ...(["repl.start", "repl.reset"].includes(operation)
    ? {
        launchProfileRef: {
          profileId: "repl-python",
          revision: "1",
          profileDigest: "blake3:" + "c".repeat(64),
        },
      }
    : {}),
  ...over,
})

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

const created = (registry: ReplLifecycle.Registry, nowMs = 1_000) =>
  createSession(registry, {
    sessionID: "repl-1",
    language: "python",
    scope: "workspace://ws-1",
    nowMs,
    resourceLimits,
    callbackCapabilities: ["files.read"],
  })

const result = (generation: number, over: Partial<ExecuteResult> = {}): ExecuteResult => ({
  generation,
  status: "ok",
  value: "2",
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...over,
})

describe("repl.lifecycle generation lifecycle", () => {
  test("create is bookkeeping and the generation is not live until activation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    expect(session).toMatchObject({ state: "created", generation: 1, idleTtlMs: DEFAULT_IDLE_TTL_MS })
    expect(Object.isFrozen(session)).toBe(true)
    expect(Object.isFrozen(session.callbackCapabilities)).toBe(true)
    expect(Reflect.set(session, "state", "active")).toBe(false)
    expect(
      capture<ReplLifecycle.StaleRefError>(() =>
        registry.requireOwned({ sessionID: "repl-1", generation: 1 }, authority),
      ).reason,
    ).toBe("not_active")
  })

  test("binds one HostKernel interpreter identity to its authenticated generation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    const bound = registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)
    expect(bound.processRef).toEqual(interpreterProcessRef)
    expect(Object.isFrozen(bound.processRef)).toBe(true)
    expect(registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)).toBe(bound)
    expect(() => registry.bindProcessRefOwned(ref, authorityFor(session), {
      ...interpreterProcessRef,
      executionID: "other-execution",
    })).toThrow(ReplLifecycle.TransitionError)
    expect(() => registry.bindProcessRefOwned(ref, { ...authorityFor(session), ownerId: "other-owner" }, interpreterProcessRef))
      .toThrow(ReplLifecycle.StaleRefError)
  })

  test("reconciles only the process identity retained by the owned REPL generation", async () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)
    let request: Readonly<Record<string, unknown>> | undefined
    const status = await readSupervisedStatusV1({
      registry,
      ref,
      authority: authorityFor(session),
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async (_service, operation, body) => {
        expect(operation).toBe("status")
        request = body
        return {
          executionID: interpreterProcessRef.executionID,
          generation: interpreterProcessRef.generation,
          state: "RUNNING",
          stdoutSequence: "0",
          stderrSequence: "0",
          exitCode: null,
          stdoutDigest: "blake3:" + "1".repeat(64),
          stderrDigest: "blake3:" + "2".repeat(64),
          outputBytes: "0",
          truncated: false,
          receiptDigest: null,
          hostProcessRef: interpreterProcessRef,
          resourceGuarantees,
        }
      },
    })
    expect(status.state).toBe("RUNNING")
    expect(request).toMatchObject({
      executionID: interpreterProcessRef.executionID,
      effectID: "effect-1",
      challengeID: "challenge-1",
      directAttempt: session.directAttemptScope,
    })
    expect(request).not.toHaveProperty("processRef")
  })

  test("retained managed Attempt scope is an immutable copy", () => {
    const managedAttemptScope = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      requestSequence: "1",
      requestID: "request-1",
      contextSelectionDigest: "blake3:" + "9".repeat(64),
      locationID: "location-1",
      sessionID: "repl-1",
      workspaceRevision: authority.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
      permissionScopeDigest: "blake3:" + "a".repeat(64),
      worktreeTarget: {
        worktreeID: "worktree-1",
        worktreeBaseRevision: "blake3:" + "5".repeat(64),
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "ws-1",
        workspaceRef: "worktree-1",
        canonicalRoot: "/workspace/ws-1",
        workspaceRevision: authority.workspaceRevision,
      },
    }
    const session = createSession(makeRegistry(), {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      managedAttemptScope,
    })
    expect(session.managedAttemptScope).toEqual(managedAttemptScope)
    expect(session.managedAttemptScope).not.toBe(managedAttemptScope)
    expect(Object.isFrozen(session.managedAttemptScope)).toBe(true)
  })

  test("managed Attempt scopes missing the provider-request pin or worktree target are rejected", () => {
    const registry = makeRegistry()
    const full = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      requestSequence: "1",
      requestID: "request-1",
      contextSelectionDigest: "blake3:" + "9".repeat(64),
      locationID: "location-1",
      sessionID: "repl-stale-scope",
      workspaceRevision: authority.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
      permissionScopeDigest: "blake3:" + "a".repeat(64),
      worktreeTarget: {
        worktreeID: "worktree-1",
        worktreeBaseRevision: "blake3:" + "5".repeat(64),
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "ws-1",
        workspaceRef: "worktree-1",
        canonicalRoot: "/workspace/ws-1",
        workspaceRevision: authority.workspaceRevision,
      },
    }
    const create = (managedAttemptScope: Record<string, unknown>) =>
      () =>
        registry.create({
          ...authority,
          launchProfileRef: { profileId: "repl-python", revision: "1", profileDigest: "blake3:" + "c".repeat(64) },
          directAttemptScope: undefined,
          sessionID: "repl-stale-scope",
          language: "python",
          scope: "workspace://ws-1",
          nowMs: 1_000,
          resourceLimits,
          managedAttemptScope: managedAttemptScope as never,
        })
    // The pre-provider-pin 12-field shape must not be treated as authority.
    const { requestSequence: _sequence, requestID: _id, contextSelectionDigest: _selection, ...legacy } = full
    expect(create(legacy)).toThrow("exact ManagedAttemptScopeV1 fields")
    // A malformed leased worktree target is rejected by its exact key set.
    expect(create({
      ...full,
      worktreeTarget: { ...full.worktreeTarget, worktreeID: "" },
    })).toThrow("worktreeTarget worktreeID is required")
    expect(create({
      ...full,
      worktreeTarget: { ...full.worktreeTarget, pid: 1 },
    })).toThrow("exact ManagedWorktreeTargetV1 fields")
    // The request sequence stays inside the bounded HostKernel window.
    expect(create({ ...full, requestSequence: "1025" })).toThrow("requestSequence must be within the HostKernel window")
    expect(create({ ...full, requestSequence: "01" })).toThrow("canonical u64 decimal string")
    // Every digest field is exact.
    expect(create({ ...full, permissionScopeDigest: "sha256:" + "a".repeat(64) })).toThrow(
      "permissionScopeDigest must be a BLAKE3 digest",
    )
    expect(create({ ...full, contextSelectionDigest: "sha256:" + "9".repeat(64) })).toThrow(
      "contextSelectionDigest must be a BLAKE3 digest",
    )
  })

  test("retained direct Attempt scope is an immutable copy", () => {
    const directAttemptScope = {
      attemptID: "attempt-direct-1",
      parentSessionID: "parent-session-1",
      childSessionID: "repl-1",
      ownerEpoch: "7",
      expectedRevision: "9",
      locationID: "location-1",
      workspaceID: "ws-1",
      workspaceRevision: authority.workspaceRevision,
      profileID: "profile-python",
      profileRevision: "3",
      profileDigest: "blake3:" + "f".repeat(64),
      capabilityDigest: "blake3:" + "b".repeat(64),
      permissionsDigest: "blake3:" + "c".repeat(64),
      budgetDigest: "blake3:" + "d".repeat(64),
      scopeDigest: "blake3:" + "e".repeat(64),
    }
    const session = createSession(makeRegistry(), {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      directAttemptScope,
    })
    expect(session.directAttemptScope).toEqual(directAttemptScope)
    expect(session.directAttemptScope).not.toBe(directAttemptScope)
    expect(Object.isFrozen(session.directAttemptScope)).toBe(true)
  })

  test("session authority bindings survive reset only under a new sandbox generation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    expect(session).toMatchObject(authority)
    registry.activate({ sessionID: session.sessionID, generation: session.generation }, 2_000)
    const reset = registry.resetOwned({ sessionID: session.sessionID, generation: session.generation }, authority, 3_000)
    expect(reset).toMatchObject({ ...authority, sandboxGeneration: 2, generation: 2, state: "created" })
  })

  test("session refs reject different owner, workspace revision, source generation, sandbox, policy, or ceiling", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)
    const outputRef = registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-owned" }))!

    expect(registry.requireOwned(ref, authority).sessionID).toBe(session.sessionID)
    expect(registry.statusOwned(ref, authority).state).toBe("active")
    expect(registry.resolveOutputRefOwned(outputRef, authority).artifactRef).toBe("artifact-owned")
    for (const mismatched of [
      { ...authority, ownerId: "principal-2" },
      { ...authority, workspaceId: "ws-2" },
      { ...authority, workspaceRevision: "blake3:" + "2".repeat(64) },
      { ...authority, ownerEpoch: "8" },
      { ...authority, locationID: "location-2" },
      { ...authority, sourceGeneration: "source-2" },
      { ...authority, sandboxGeneration: authority.sandboxGeneration + 1 },
      { ...authority, policyGeneration: "policy-2" },
      { ...authority, capabilityCeilingDigest: "blake3:" + "f".repeat(64) },
    ]) {
      expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, mismatched))).toMatchObject({
        reason: "invalidated",
      })
      expect(capture<ReplLifecycle.StaleRefError>(() => registry.statusOwned(ref, mismatched))).toMatchObject({
        reason: "invalidated",
      })
      expect(
        capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(outputRef, mismatched)),
      ).toMatchObject({ reason: "invalidated" })
    }
  })

  test("registry creation rejects oversized scopes when called without the protocol parser", () => {
    const registry = makeRegistry()

    expect(() =>
      createSession(registry, {
        sessionID: "repl-large-scope",
        language: "python",
        scope: "s".repeat(MAX_SCOPE_BYTES + 1),
        nowMs: 1_000,
        resourceLimits,
      }),
    ).toThrow(ProtocolError)
  })

  test("registry creation rejects oversized callback sets when called without the protocol parser", () => {
    const registry = makeRegistry()

    expect(() =>
      createSession(registry, {
        sessionID: "repl-many-callbacks",
        language: "python",
        scope: "workspace://ws-1",
        nowMs: 1_000,
        resourceLimits,
        callbackCapabilities: Array.from({ length: MAX_CALLBACK_CAPABILITIES + 1 }, (_, index) => `cap.${index}`),
      }),
    ).toThrow(ProtocolError)
  })

  test("activate makes the generation live and touch keeps it alive", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    expect(registry.activate(ref, 2_000).state).toBe("active")
    expect(registry.touch(ref, 5_000).lastActivityMs).toBe(5_000)
    expect(registry.requireOwned(ref, authority).state).toBe("active")
  })

  test("status exposes a frozen summary without workspace, callback, or output data", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }

    const status = registry.statusOwned(ref, authority)

    expect(status).toEqual({
      sessionID: "repl-1",
      generation: 1,
      language: "python",
      state: "created",
      createdAtMs: 1_000,
      lastActivityMs: 1_000,
      idleTtlMs: DEFAULT_IDLE_TTL_MS,
    })
    expect(Object.isFrozen(status)).toBe(true)
  })

  test("status remains readable for a quarantined generation that cannot execute", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    registry.acceptResult(ref, result(session.generation, { status: "unknown" }))

    expect(registry.statusOwned(ref, authority).state).toBe("unknown")
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
    expect(() => registry.resetOwned(ref, authority, 3_000)).toThrow(ReplLifecycle.TransitionError)
    expect(() => registry.stopOwned(ref, authority)).toThrow(ReplLifecycle.TransitionError)
  })

  test("status rejects a replaced generation rather than returning the new generation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const oldRef = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(oldRef, 2_000)
    const replacement = registry.reset(oldRef, 3_000)

    const error = capture<ReplLifecycle.StaleRefError>(() => registry.statusOwned(oldRef, authority))

    expect(error.reason).toBe("generation_replaced")
    expect(error.current).toBe(replacement.generation)
  })

  test("idle expiry invalidates the generation", () => {
    const registry = makeRegistry()
    created(registry, 1_000)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 1_000)

    expect(registry.expireIdle(1_000 + DEFAULT_IDLE_TTL_MS - 1)).toEqual([])
    expect(registry.expireIdle(1_000 + DEFAULT_IDLE_TTL_MS)).toEqual([ref])

    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe("expired")
    // An expired generation cannot be revived by activation.
    expect(capture<ReplLifecycle.TransitionError>(() => registry.activate(ref, 99_999))._tag).toBe(
      "ReplSessionTransitionError",
    )
  })

  test("crash invalidates the generation", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 2_000)
    registry.crash(ref)
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe("crashed")
  })

  test("reset opens a new generation and stales every old reference", () => {
    const registry = makeRegistry()
    created(registry, 1_000)
    const oldRef = { sessionID: "repl-1", generation: 1 }
    registry.activate(oldRef, 1_000)
    registry.touch(oldRef, 2_000)

    const reset = registry.reset(oldRef, 3_000)
    expect(reset).toMatchObject({ state: "created", generation: 2, lastActivityMs: 3_000 })

    const error = capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(oldRef, authority))
    expect(error.reason).toBe("generation_replaced")
    expect(error.current).toBe(2)

    const newRef = { sessionID: "repl-1", generation: 2 }
    expect(registry.activate(newRef, 4_000).state).toBe("active")
    expect(registry.requireOwned(newRef, authorityFor(reset)).generation).toBe(2)
  })

  test("local reset and stop lifecycle never unlock REPL execution", () => {
    const registry = makeRegistry()
    const session = created(registry, 1_000)
    const oldRef = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(oldRef, 1_000)

    expect(replEffectRouteAvailable()).toBe(false)
    const reset = registry.reset(oldRef, 2_000)
    const currentRef = { sessionID: reset.sessionID, generation: reset.generation }
    expect(reset.state).toBe("created")
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(oldRef, authority)).reason).toBe(
      "generation_replaced",
    )
    registry.activate(currentRef, 3_000)
    registry.stop(currentRef)
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(currentRef, authority)).reason).toBe(
      "stopped",
    )
    expect(replEffectRouteAvailable()).toBe(false)
  })

  test("stop is terminal and session refs expire with it", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 2_000)
    registry.stop(ref)
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe("stopped")
    expect(capture<ReplLifecycle.TransitionError>(() => registry.stop(ref))._tag).toBe("ReplSessionTransitionError")
  })

  test("unknown sessions and stale results are rejected", () => {
    const registry = makeRegistry()
    expect(
      capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned({ sessionID: "none", generation: 1 }, authority))
        .reason,
    ).toBe("session_lost")

    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 2_000)
    expect(registry.acceptResult(ref, result(1))).toEqual(result(1))
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.acceptResult(ref, result(2))).reason).toBe(
      "generation_replaced",
    )

    registry.reset(ref, 3_000)
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.acceptResult(ref, result(1))).reason).toBe(
      "generation_replaced",
    )
  })

  test("binds output artifact references to the active REPL generation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    const outputRef = registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-1" }))

    expect(outputRef).toEqual({ ...ref, artifactRef: "artifact-1" })
    expect(Object.isFrozen(outputRef)).toBe(true)
    expect(registry.resolveOutputRefOwned(outputRef!, authority)).toEqual({
      session: registry.requireOwned(ref, authority),
      artifactRef: "artifact-1",
    })
  })

  test("caps retained output references per generation without revoking earlier refs", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)
    let last!: ReplLifecycle.OutputRef

    for (let index = 0; index < MAX_OUTPUT_REFERENCES_PER_GENERATION; index++) {
      last = registry.bindOutputRef(ref, result(session.generation, { artifactRef: `artifact-${index}` }))!
    }
    expect(
      registry.bindOutputRef(
        ref,
        result(session.generation, { artifactRef: `artifact-${MAX_OUTPUT_REFERENCES_PER_GENERATION - 1}` }),
      ),
    ).toEqual(last)

    const error = capture<{ _tag: string; maximumReferences: number }>(() =>
      registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-over-limit" })),
    )
    expect(error).toMatchObject({
      _tag: "ReplOutputReferenceLimitError",
      maximumReferences: MAX_OUTPUT_REFERENCES_PER_GENERATION,
    })
    expect(registry.resolveOutputRefOwned(last, authority).artifactRef).toBe(
      `artifact-${MAX_OUTPUT_REFERENCES_PER_GENERATION - 1}`,
    )
    expect(registry.requireOwned(ref, authority).state).toBe("active")
  })

  test("does not create an output reference when the result has no artifact", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(registry.bindOutputRef(ref, result(session.generation))).toBeUndefined()
  })

  test("output references become stale after the REPL generation is reset", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)
    const outputRef = registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-1" }))!
    const replacement = registry.reset(ref, 3_000)

    expect(
      capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(outputRef, authority)),
    ).toMatchObject({
      reason: "generation_replaced",
      current: replacement.generation,
    })
  })

  test("output references become stale when the REPL worker crashes or expires", () => {
    for (const endGeneration of [
      (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => registry.crash(ref),
      (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => registry.expireIdle(20_000),
    ]) {
      const registry = makeRegistry()
      const session = createSession(registry, {
        sessionID: "repl-1",
        language: "python",
        scope: "workspace://ws-1",
        nowMs: 1_000,
        resourceLimits,
        callbackCapabilities: ["files.read"],
        idleTtlMs: 10_000,
      })
      const ref = { sessionID: session.sessionID, generation: session.generation }
      registry.activate(ref, 2_000)
      const outputRef = registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-1" }))!
      endGeneration(registry, ref)

      expect(
        capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(outputRef, authority)).reason,
      ).toMatch(/crashed|expired/)
    }
  })

  test("output references become stale when cancellation is uncertain, stopped or quarantined", () => {
    const enders: {
      end: (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => unknown
      reason: ReplLifecycle.StaleReason
    }[] = [
      {
        end: (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => registry.cancel(ref),
        reason: "outcome_unknown",
      },
      {
        end: (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => {
          registry.acceptResult(ref, result(ref.generation, { status: "unknown" }))
        },
        reason: "outcome_unknown",
      },
      {
        end: (registry: ReplLifecycle.Registry, ref: ReplLifecycle.Ref) => registry.stop(ref),
        reason: "stopped",
      },
    ]
    for (const { end, reason } of enders) {
      const registry = makeRegistry()
      const session = created(registry)
      const ref = { sessionID: session.sessionID, generation: session.generation }
      registry.activate(ref, 2_000)
      const outputRef = registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-1" }))!

      end(registry, ref)

      expect(
        capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(outputRef, authority)).reason,
      ).toBe(reason)
    }
  })

  test("a new generation can issue fresh output references while the old ones stay stale", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const oldRef = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(oldRef, 2_000)
    const oldOutput = registry.bindOutputRef(oldRef, result(session.generation, { artifactRef: "artifact-1" }))!
    const replacement = registry.reset(oldRef, 3_000)
    const newRef = { sessionID: replacement.sessionID, generation: replacement.generation }
    registry.activate(newRef, 3_000)

    const newOutput = registry.bindOutputRef(newRef, result(replacement.generation, { artifactRef: "artifact-2" }))!
    expect(newOutput.generation).toBe(replacement.generation)
    expect(registry.resolveOutputRefOwned(newOutput, authorityFor(replacement))).toEqual({
      session: registry.requireOwned(newRef, authorityFor(replacement)),
      artifactRef: "artifact-2",
    })

    // Even when the replacement reuses the same artifact string, the old
    // generation's reference never resolves against it.
    const reused = registry.bindOutputRef(newRef, result(replacement.generation, { artifactRef: "artifact-1" }))!
    expect(registry.resolveOutputRefOwned(reused, authorityFor(replacement)).artifactRef).toBe("artifact-1")
    expect(
      capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(oldOutput, authority)).reason,
    ).toBe("generation_replaced")
  })

  test("restarting one REPL owner does not invalidate another owner's output reference", () => {
    const registry = makeRegistry()
    const first = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
    })
    const second = createSession(registry, {
      sessionID: "repl-2",
      language: "javascript",
      scope: "workspace://ws-2",
      nowMs: 1_000,
      resourceLimits,
    })
    const firstRef = { sessionID: first.sessionID, generation: first.generation }
    const secondRef = { sessionID: second.sessionID, generation: second.generation }
    registry.activate(firstRef, 2_000)
    registry.activate(secondRef, 2_000)
    const firstOutput = registry.bindOutputRef(firstRef, result(first.generation, { artifactRef: "artifact-first" }))!
    const secondOutput = registry.bindOutputRef(
      secondRef,
      result(second.generation, { artifactRef: "artifact-second" }),
    )!

    registry.crash(firstRef)
    expect(
      capture<ReplLifecycle.StaleRefError>(() => registry.resolveOutputRefOwned(firstOutput, authority)).reason,
    ).toBe("crashed")

    const restarted = createSession(registry, {
      sessionID: first.sessionID,
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 3_000,
      resourceLimits,
    })
    expect(restarted.generation).toBe(2)
    expect(registry.resolveOutputRefOwned(secondOutput, authorityFor(second))).toMatchObject({
      session: { sessionID: "repl-2", generation: 1 },
      artifactRef: "artifact-second",
    })
  })

  test("a never-issued or misgenerationed output reference never resolves as current output", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)
    registry.bindOutputRef(ref, result(session.generation, { artifactRef: "artifact-1" }))

    // Forged artifact reference against the live generation.
    const forged = capture<ReplLifecycle.StaleRefError>(() =>
      registry.resolveOutputRefOwned({ ...ref, artifactRef: "artifact-forged" }, authority),
    )
    expect(forged.reason).toBe("invalidated")

    // An output reference for a session that does not exist is lost, not empty output.
    expect(
      capture<ReplLifecycle.StaleRefError>(() =>
        registry.resolveOutputRefOwned({ sessionID: "repl-none", generation: 1, artifactRef: "artifact-1" }, authority),
      ).reason,
    ).toBe("session_lost")

    // Binding a result produced by another generation is rejected outright.
    const staleBind = capture<ReplLifecycle.StaleRefError>(() =>
      registry.bindOutputRef(ref, result(session.generation + 1, { artifactRef: "artifact-2" })),
    )
    expect(staleBind).toMatchObject({ reason: "generation_replaced", current: session.generation })
  })

  test("blank artifact references never produce an output reference", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    for (const artifactRef of ["", "   "]) {
      expect(() => registry.bindOutputRef(ref, result(session.generation, { artifactRef }))).toThrow(ProtocolError)
    }
    expect(
      capture<ReplLifecycle.StaleRefError>(() =>
        registry.resolveOutputRefOwned({ ...ref, artifactRef: "   " }, authority),
      ).reason,
    ).toBe("invalidated")
  })

  test("output references cannot resolve before the generation is activated", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }

    expect(
      capture<ReplLifecycle.StaleRefError>(() =>
        registry.resolveOutputRefOwned({ ...ref, artifactRef: "artifact-1" }, authority),
      ).reason,
    ).toBe("not_active")
    expect(
      capture<ReplLifecycle.StaleRefError>(() => registry.bindOutputRef(ref, result(1, { artifactRef: "a" }))).reason,
    ).toBe("not_active")
  })

  test("an UNKNOWN execution outcome quarantines the generation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    registry.acceptResult(ref, result(session.generation, { status: "unknown" }))

    expect(registry.listOwned(authority)[0]?.state).toBe("unknown")
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
    expect(capture<ReplLifecycle.TransitionError>(() => registry.reset(ref, 3_000))._tag).toBe(
      "ReplSessionTransitionError",
    )
  })

  test("a timed-out execution quarantines the generation before it can be reused", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    registry.acceptResult(ref, result(session.generation, { status: "timeout" }))

    expect(registry.listOwned(authority)[0]?.state).toBe("unknown")
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
  })

  test("an execute deadline cannot exceed the generation wall-time budget", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    const atLimit = parseExecuteRequest({ generation: session.generation, code: "1 + 1", deadlineMs: 30_000 })
    expect(registry.validateExecuteRequest(ref, atLimit)).toEqual(atLimit)

    const overLimit = parseExecuteRequest({ generation: session.generation, code: "1 + 1", deadlineMs: 30_001 })
    const error = capture<ReplLifecycle.DeadlineLimitError>(() => registry.validateExecuteRequest(ref, overLimit))
    expect(error).toBeInstanceOf(DeadlineLimitError)
    expect(error).toMatchObject({ _tag: "ReplDeadlineLimitError", maximumMs: 30_000, requestedMs: 30_001 })
  })

  test("registry execute validation enforces protocol bounds when called without the parser", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(() =>
      registry.validateExecuteRequest(ref, {
        generation: session.generation,
        code: "x".repeat(MAX_CODE_BYTES + 1),
        deadlineMs: 10_000,
      }),
    ).toThrow(ProtocolError)
    expect(() =>
      registry.validateExecuteRequest(ref, {
        generation: session.generation,
        code: "1 + 1",
        deadlineMs: 99,
      }),
    ).toThrow(ProtocolError)
    expect(registry.requireOwned(ref, authority).state).toBe("active")
  })

  test("registry result acceptance enforces protocol truncation rules when called without the parser", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(() => registry.acceptResult(ref, result(session.generation, { stdoutTruncated: true }))).toThrow(
      ProtocolError,
    )
    expect(registry.requireOwned(ref, authority).state).toBe("active")
  })

  test("output reference binding refuses malformed results when called without the parser", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(() =>
      registry.bindOutputRef(ref, result(session.generation, { stdoutTruncated: true, artifactRef: undefined })),
    ).toThrow(ProtocolError)
    expect(registry.requireOwned(ref, authority).state).toBe("active")
  })

  test("output reference binding enforces the per-session output budget", () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-output-budget",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits: { ...resourceLimits, maxOutputBytes: 4 },
    })
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(() =>
      registry.bindOutputRef(ref, result(session.generation, { stdout: "12345", artifactRef: "artifact-1" })),
    ).toThrow(ReplLifecycle.OutputLimitError)
    expect(registry.statusOwned(ref, authorityFor(session)).state).toBe("unknown")
  })

  test("output reference binding quarantines an uncertain execution result", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    const error = capture<ReplLifecycle.StaleRefError>(() =>
      registry.bindOutputRef(ref, result(session.generation, { status: "unknown", artifactRef: "artifact-1" })),
    )
    expect(error.reason).toBe("outcome_unknown")
    expect(registry.statusOwned(ref, authority).state).toBe("unknown")
  })

  test("an output over the session budget invalidates the worker generation", () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-bounded",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits: { maxMemoryBytes: 1024 * 1024, maxWallTimeMs: 1_000, maxOutputBytes: 4 },
    })
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 1_000)

    const error = capture<{ _tag: string; maximumBytes: number; observedBytes: number }>(() =>
      registry.acceptResult(ref, result(session.generation, { value: "", stdout: "12345" })),
    )
    expect(error).toMatchObject({ _tag: "ReplOutputLimitError", maximumBytes: 4, observedBytes: 5 })
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
  })

  test("structured values and artifact references count toward the session output budget", () => {
    for (const output of [{ value: "12345" }, { value: "", artifactRef: "12345" }]) {
      const registry = makeRegistry()
      const session = createSession(registry, {
        sessionID: "repl-bounded",
        language: "python",
        scope: "workspace://ws-1",
        nowMs: 1_000,
        resourceLimits: { maxMemoryBytes: 1024 * 1024, maxWallTimeMs: 1_000, maxOutputBytes: 4 },
      })
      const ref = { sessionID: session.sessionID, generation: session.generation }
      registry.activate(ref, 1_000)

      const error = capture<{ _tag: string; maximumBytes: number; observedBytes: number }>(() =>
        registry.acceptResult(ref, result(session.generation, output)),
      )
      expect(error).toMatchObject({ _tag: "ReplOutputLimitError", maximumBytes: 4, observedBytes: 5 })
      expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
        "outcome_unknown",
      )
    }
  })

  test("cancellation invalidates the generation and rejects late results", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    registry.cancel(ref)

    expect(registry.listOwned(authority)[0]?.state).toBe("unknown")
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
    expect(() => created(registry)).toThrow(ReplLifecycle.TransitionError)
    expect(() => registry.acceptResult(ref, result(session.generation))).toThrow()
  })

  test("idle TTL input is bounded and recorded per generation", () => {
    const registry = makeRegistry()
    expect(() =>
      createSession(registry, {
        sessionID: "repl-2",
        language: "python",
        scope: "s",
        nowMs: 0,
        resourceLimits,
        idleTtlMs: 10,
      }),
    ).toThrow()
    const session = createSession(registry, {
      sessionID: "repl-3",
      language: "javascript",
      scope: "s",
      nowMs: 0,
      resourceLimits,
      idleTtlMs: 60_000,
    })
    expect(session.idleTtlMs).toBe(60_000)
    registry.activate({ sessionID: "repl-3", generation: 1 }, 0)
    expect(registry.expireIdle(59_999)).toEqual([])
    expect(registry.expireIdle(60_000)).toHaveLength(1)
  })

  test("session listing is restricted to the authenticated owner and workspace", () => {
    const registry = makeRegistry()
    created(registry)
    createSession(registry, {
      sessionID: "repl-2",
      language: "javascript",
      scope: "s",
      nowMs: 0,
      resourceLimits,
      ownerId: "principal-2",
      workspaceId: "ws-2",
      workspaceRevision: "blake3:" + "2".repeat(64),
      sourceGeneration: "source-2",
      sandboxGeneration: 2,
      policyGeneration: "policy-2",
      capabilityCeilingDigest: "blake3:" + "b".repeat(64),
    })
    expect(registry.listOwned(authority).map((session) => session.sessionID)).toEqual(["repl-1"])
  })
})

describe("repl.lifecycle fail-closed boundary", () => {
  test("reset has an explicit fail-closed operation", () => {
    expect(Schema.decodeUnknownSync(ReplOperationSchema)("repl.reset")).toBe("repl.reset")
  })

  test("start, execute, callback and stop are unavailable and throw", () => {
    for (const operation of ALL_OPERATIONS) {
      const report = availability(operation)
      expect(report).toMatchObject({ operation, available: false, reason: "guard_not_verified" })
      const error = capture<ReplLifecycle.UnavailableError>(() => requireEffectAllowed(operation))
      expect(error).toBeInstanceOf(UnavailableError)
      expect(error._tag).toBe("ReplUnavailableError")
      expect(error.operation).toBe(operation)
      expect(error.reason).toBe("guard_not_verified")
    }
  })

  test("recorded callback capabilities do not authorize callback invocation", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 2_000)
    expect(registry.requireOwned(ref, authority).callbackCapabilities).toEqual(["files.read"])
    expect(capture<ReplLifecycle.UnavailableError>(() => requireEffectAllowed("repl.callback")).operation).toBe(
      "repl.callback",
    )
  })

  test("callback preflight enforces the generation's declared capability ceiling and owner scope", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(registry.requireCallbackCapability(ref, authority, "files.read").callbackCapabilities).toEqual([
      "files.read",
    ])
    expect(() => registry.requireCallbackCapability(ref, authority, "files.write")).toThrow(
      CallbackCapabilityDeniedError,
    )
    expect(() =>
      registry.requireCallbackCapability(ref, { ...authority, ownerId: "principal-2" }, "files.read"),
    ).toThrow(StaleRefError)
  })

  test("callback admissions are generation scoped, bounded, and UNKNOWN quarantines the session", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)
    const request = {
      generation: session.generation,
      callbackID: "cb-1",
      capabilityID: "files.read",
      arguments: { path: "src/main.ts" },
    }
    expect(registry.admitCallback(ref, authority, request)).toMatchObject({ callbackID: "cb-1" })
    expect(() => registry.admitCallback(ref, authority, request)).toThrow(CallbackAdmissionError)
    for (let index = 2; index <= 16; index++) {
      registry.admitCallback(ref, authority, { ...request, callbackID: `cb-${index}` })
    }
    const overflow = capture<CallbackAdmissionError>(() =>
      registry.admitCallback(ref, authority, { ...request, callbackID: "cb-17" }),
    )
    expect(overflow.reason).toBe("too_many_in_flight")
    registry.acceptCallbackResult(ref, authority, {
      generation: session.generation,
      callbackID: "cb-1",
      status: "unknown",
      message: "host outcome could not be reconciled",
    })
    expect(registry.statusOwned(ref, authority).state).toBe("unknown")
    expect(() => registry.admitCallback(ref, authority, { ...request, callbackID: "cb-2" })).toThrow(StaleRefError)
  })

  test("owned reset and stop reject a foreign principal before changing generation state", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.activate(ref, 2_000)

    expect(() => registry.resetOwned(ref, { ...authority, ownerId: "principal-2" }, 3_000)).toThrow(StaleRefError)
    expect(() => registry.stopOwned(ref, { ...authority, workspaceId: "ws-2" })).toThrow(StaleRefError)
    expect(registry.requireOwned(ref, authority).generation).toBe(1)
  })

  it.live("lifecycle and boundary calls spawn no process", () =>
    Effect.sync(() => {
      const spawnSpy = spyOn(Bun, "spawn")
      const writeSpy = spyOn(Bun, "write")
      const fetchSpy = spyOn(globalThis, "fetch")
      try {
        const registry = makeRegistry()
        created(registry)
        const ref = { sessionID: "repl-1", generation: 1 }
        registry.activate(ref, 2_000)
        registry.touch(ref, 3_000)
        registry.acceptResult(ref, result(1))
        registry.expireIdle(1_000_000)
        capture(() => registry.requireOwned(ref, authority))

        const other = createSession(registry, {
          sessionID: "repl-2",
          language: "javascript",
          scope: "s",
          nowMs: 0,
          resourceLimits,
        })
        const otherRef = { sessionID: "repl-2", generation: other.generation }
        registry.activate(otherRef, 1_000)
        registry.crash(otherRef)
        const reset = registry.reset(otherRef, 4_000)
        const resetRef = { sessionID: "repl-2", generation: reset.generation }
        registry.activate(resetRef, 5_000)
        registry.acceptResult(resetRef, result(reset.generation))
        const outputRef = registry.bindOutputRef(resetRef, result(reset.generation, { artifactRef: "artifact-1" }))
        registry.resolveOutputRefOwned(outputRef!, authorityFor(reset))
        capture(() =>
          registry.resolveOutputRefOwned({ ...outputRef!, artifactRef: "artifact-forged" }, authorityFor(reset)),
        )
        registry.stop(resetRef)
        capture(() => registry.requireOwned(resetRef, authorityFor(reset)))
        registry.listOwned(authority)

        for (const operation of ALL_OPERATIONS) {
          availability(operation)
          capture(() => requireEffectAllowed(operation))
        }
      } finally {
        spawnSpy.mockRestore()
        writeSpy.mockRestore()
        fetchSpy.mockRestore()
      }
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }),
  )
})

describe("repl.lifecycle canonical Guard effect route", () => {
  test("a managed Attempt cannot reach a registered route or callback ingress before acceptance", async () => {
    const managedAttemptScope = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      requestSequence: "1",
      requestID: "request-1",
      contextSelectionDigest: "blake3:" + "9".repeat(64),
      locationID: "location-1",
      sessionID: "repl-1",
      workspaceRevision: authority.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
      permissionScopeDigest: "blake3:" + "a".repeat(64),
      worktreeTarget: {
        worktreeID: "worktree-1",
        worktreeBaseRevision: "blake3:" + "5".repeat(64),
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "ws-1",
        workspaceRef: "worktree-1",
        canonicalRoot: "/workspace/ws-1",
        workspaceRevision: authority.workspaceRevision,
      },
    }
    let received: ReplEffectRequest | undefined
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async (request) => {
        received = request
        return {
          capabilityID: "repl.execute",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "b".repeat(64),
        }
      },
    })
    try {
      expect(replEffectRouteAvailable()).toBe(false)
      expect(replCallbackIngressAvailable()).toBe(false)
      await expect(authorizeEffect(effectRequest("repl.execute", { managedAttemptScope, directAttemptScope: undefined })))
        .rejects.toBeInstanceOf(UnavailableError)
      expect(received).toBeUndefined()
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("no registered route keeps every interpreter effect typed-unavailable", async () => {
    expect(replEffectRouteAvailable()).toBe(false)
    for (const operation of ALL_OPERATIONS) {
      let thrown: unknown
      try {
        await authorizeEffect(effectRequest(operation))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(UnavailableError)
      expect((thrown as ReplLifecycle.UnavailableError).operation).toBe(operation)
      expect((thrown as ReplLifecycle.UnavailableError).reason).toBe("guard_not_verified")
    }
  })

  test("DEC-V1-27 requires each OS-enforced dimension independently", () => {
    expect(ReplLifecycle.validateReplResourceGuaranteesV1(resourceGuarantees)).toEqual(resourceGuarantees)
    for (const field of ["cpuTimeEnforced", "memoryEnforced", "processCountEnforced", "fileDescriptorsEnforced"] as const) {
      expect(() => ReplLifecycle.validateReplResourceGuaranteesV1({ ...resourceGuarantees, [field]: false })).toThrow(
        "REPL execution requires HostKernel-confirmed OS enforcement for CPU time, memory, process count, and file descriptors",
      )
    }
    expect(() => ReplLifecycle.validateReplResourceGuaranteesV1(undefined)).toThrow(
      "REPL execution requires HostKernel-confirmed OS enforcement for CPU time, memory, process count, and file descriptors",
    )
  })

  test("REPL worker dispatch is refused unless the host reports every required OS resource limit", async () => {
    let dispatched = false
    setReplEffectRoute({
      resourceGuarantees: {
        cpuTimeEnforced: false,
        memoryEnforced: false,
        processCountEnforced: false,
        fileDescriptorsEnforced: false,
      },
      authorize: async () => {
        dispatched = true
        return {
          capabilityID: "repl.start",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "b".repeat(64),
        }
      },
    })
    try {
      await expect(authorizeEffect(effectRequest("repl.start"))).rejects.toBeInstanceOf(UnavailableError)
      expect(dispatched).toBe(false)
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("a registered boundary cannot dispatch before the hard runtime gate passes", async () => {
    const requests: Array<Record<string, unknown>> = []
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async (request) => {
        requests.push({ ...request })
        return { capabilityID: "repl.execute", challengeID: "ch_1", effectID: "", capabilityLeaseDigest: "" } as never
      },
    })
    try {
      expect(replEffectRouteAvailable()).toBe(false)
      await expect(authorizeEffect(effectRequest("repl.execute", { generation: 3 }))).rejects.toThrow(UnavailableError)
      expect(requests).toEqual([])
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("malformed launch profile and authority bindings are rejected before worker dispatch", async () => {
    const requests: unknown[] = []
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async (request) => {
        requests.push(request)
        return {
          capabilityID: "repl.start",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "b".repeat(64),
        }
      },
    })
    try {
      await expect(
        authorizeEffect(
          effectRequest("repl.start", {
            launchProfileRef: {
              profileId: "repl-python",
              revision: "01",
              profileDigest: "blake3:" + "c".repeat(64),
            },
          }),
        ),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(authorizeEffect(effectRequest("repl.execute", { workspaceRevision: " " }))).rejects.toBeInstanceOf(
        UnavailableError,
      )
      await expect(authorizeEffect(effectRequest("repl.reset", { launchProfileRef: undefined }))).rejects.toBeInstanceOf(
        UnavailableError,
      )
      expect(requests).toEqual([])
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("an authorization for a different canonical action is refused", async () => {
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async () => ({
        capabilityID: "repl.start",
        challengeID: "ch_1",
        effectID: "eff_1",
        capabilityLeaseDigest: "blake3:" + "b".repeat(64),
      }),
    })
    try {
      await expect(authorizeEffect(effectRequest("repl.execute"))).rejects.toBeInstanceOf(UnavailableError)
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("callbacks without a single canonical action never reach the registered boundary", async () => {
    const requests: Array<Record<string, unknown>> = []
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async (request) => {
        requests.push({ ...request })
        return {
          capabilityID: "repl.execute",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "b".repeat(64),
        }
      },
    })
    try {
      await expect(authorizeEffect(effectRequest("repl.callback"))).rejects.toBeInstanceOf(UnavailableError)
      expect(requests).toEqual([])
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("even a route claiming complete OS limits cannot unlock REPL effects", async () => {
    let dispatched = false
    setReplEffectRoute({
      resourceGuarantees,
      authorize: async () => {
        dispatched = true
        return {
          capabilityID: "repl.start",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "b".repeat(64),
        }
      },
    })
    try {
      expect(replEffectRouteAvailable()).toBe(false)
      await expect(authorizeEffect(effectRequest("repl.start", { language: "python" })))
        .rejects.toBeInstanceOf(UnavailableError)
      expect(dispatched).toBe(false)
    } finally {
      setReplEffectRoute(undefined)
    }
  })

  test("per-call dispatcher remains closed before Guard or HostKernel invocation", async () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)
    registry.activateOwned(ref, authorityFor(session), Date.now())
    let guardCalled = false
    let hostCalled = false
    await expect(dispatchSupervisedReplOperationV1({
      registry,
      ref,
      authority: authorityFor(session),
      operation: { kind: "execute", request: { generation: session.generation, code: "print(1)", deadlineMs: 1000 } },
      // The test authority's synthetic workspace ID is not a schema-valid
      // WorkspaceV2.ID, so the trusted input is built directly (file-local
      // fixture pattern) rather than through the validating constructor.
      locationRef: { directory: "/workspace", workspaceID: "ws-1" } as never,
      supervisor: {
        authorizeReplOperation: (() => {
          guardCalled = true
          throw new Error("must remain gated")
        }) as never,
      },
      runTrustedEffect: (effect) => Promise.resolve(effect as never),
      requestHostKernel: async () => {
        hostCalled = true
        throw new Error("must remain gated")
      },
    })).rejects.toThrow()
    expect(guardCalled).toBe(false)
    expect(hostCalled).toBe(false)
  })

  test("rejects a LocationRef for another workspace before the route gate and any Guard or HostKernel call", async () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)
    registry.activateOwned(ref, authorityFor(session), Date.now())
    let guardCalled = false
    let hostCalled = false
    await expect(dispatchSupervisedReplOperationV1({
      registry,
      ref,
      authority: authorityFor(session),
      operation: { kind: "execute", request: { generation: session.generation, code: "print(1)", deadlineMs: 1000 } },
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make("/workspace"),
        workspaceID: WorkspaceV2.ID.make("wrk_foreign"),
      }),
      supervisor: {
        authorizeReplOperation: (() => {
          guardCalled = true
          throw new Error("must not be reached")
        }) as never,
      },
      runTrustedEffect: (effect) => Promise.resolve(effect as never),
      requestHostKernel: async () => {
        hostCalled = true
        throw new Error("must not be reached")
      },
    })).rejects.toThrow("REPL operation location pin does not match the authenticated session workspace")
    expect(guardCalled).toBe(false)
    expect(hostCalled).toBe(false)
  })

  test("canonical action IDs are the Rust Guard constants", async () => {
    const guard = await Bun.file(path.resolve(import.meta.dir, "../../../../kernel/src/guard.rs")).text()
    for (const action of ["repl.start", "repl.execute", "repl.reset", "repl.stop"]) {
      expect(guard).toContain(`"${action}"`)
    }
    expect(guardActionID("repl.start")).toBe("repl.start")
    expect(guardActionID("repl.execute")).toBe("repl.execute")
    expect(guardActionID("repl.reset")).toBe("repl.reset")
    expect(guardActionID("repl.stop")).toBe("repl.stop")
    expect(guardActionID("repl.callback")).toBeUndefined()
  })

  test("validates per-call execute and reset dispatch envelopes against exact process scope", () => {
    const base = {
      schemaVersion: 1,
      executionID: interpreterProcessRef.executionID,
      hostProcessRef: interpreterProcessRef,
      sessionID: "repl-1",
      locationID: authority.locationID,
      workspaceRevision: authority.workspaceRevision,
      requestSequence: "1",
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityLeaseDigest: "blake3:" + "b".repeat(64),
      directAttempt: authority.directAttemptScope,
    }
    const execute = validateExecutionReplOperationRequestV1({
      ...base,
      capabilityID: "repl.execute",
      operation: { kind: "execute", code: "print(1)", deadlineMs: 10_000, maxOutputBytes: 4096 },
    })
    expect(execute.hostProcessRef.kind).toBe("interpreter")
    expect(execute.requestSequence).toBe("1")
    const receipt = validateExecutionReplOperationReceiptV1({
      schemaVersion: 1,
      status: "DISPATCHED",
      hostProcessRef: interpreterProcessRef,
      requestSequence: "1",
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "repl.execute",
      capabilityLeaseDigest: "blake3:" + "b".repeat(64),
      operationDigest: "blake3:" + "c".repeat(64),
      dispatchReceiptDigest: "blake3:" + "d".repeat(64),
    }, execute)
    expect(receipt.status).toBe("DISPATCHED")
    expect(() => validateExecutionReplOperationReceiptV1({
      schemaVersion: 1,
      status: "DISPATCHED",
      hostProcessRef: { ...interpreterProcessRef, generation: "2" },
      requestSequence: "1",
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityID: "repl.execute",
      capabilityLeaseDigest: "blake3:" + "b".repeat(64),
      operationDigest: "blake3:" + "c".repeat(64),
      dispatchReceiptDigest: "blake3:" + "d".repeat(64),
    }, execute)).toThrow("different interpreter generation")
    expect(() => validateExecutionReplOperationRequestV1({
      ...base,
      executionID: "other-process",
      capabilityID: "repl.execute",
      operation: { kind: "execute", code: "1", deadlineMs: 10_000, maxOutputBytes: 4096 },
    })).toThrow("executionID differs from HostProcessRef")
    expect(() => validateExecutionReplOperationRequestV1({
      ...base,
      requestSequence: "01",
      capabilityID: "repl.execute",
      operation: { kind: "execute", code: "1", deadlineMs: 10_000, maxOutputBytes: 4096 },
    })).toThrow("canonical positive u64")
    expect(() => validateExecutionReplOperationRequestV1({
      ...base,
      capabilityID: "repl.execute",
      operation: { kind: "execute", code: "1", deadlineMs: 10_000, maxOutputBytes: MAX_OUTPUT_REFERENCES_PER_GENERATION },
      pid: 1234,
    })).toThrow("missing or unknown fields")
    expect(() => validateExecutionReplOperationRequestV1({
      ...base,
      capabilityID: "repl.reset",
      operation: {
        kind: "reset",
        profileRef: { profileId: "other-profile", revision: "1", profileDigest: "blake3:" + "c".repeat(64) },
      },
    })).toThrow("reset launch profile differs")
    const reset = validateExecutionReplOperationRequestV1({
      ...base,
      capabilityID: "repl.reset",
      operation: {
        kind: "reset",
        profileRef: { profileId: "repl-python", revision: "1", profileDigest: "blake3:" + "c".repeat(64) },
      },
    })
    expect(reset.operation.kind).toBe("reset")
  })

  test("binds the next REPL operation sequence to the exact HostKernel process", () => {
    expect(validateExecutionReplNextSequenceV1({
      schemaVersion: 1,
      hostProcessRef: interpreterProcessRef,
      nextRequestSequence: "7",
    }, interpreterProcessRef)).toBe("7")
    expect(() => validateExecutionReplNextSequenceV1({
      schemaVersion: 1,
      hostProcessRef: { ...interpreterProcessRef, generation: "2" },
      nextRequestSequence: "7",
    }, interpreterProcessRef)).toThrow("differs from the retained interpreter")
    expect(() => validateExecutionReplNextSequenceV1({
      schemaVersion: 1,
      hostProcessRef: interpreterProcessRef,
      nextRequestSequence: "07",
    }, interpreterProcessRef)).toThrow("canonical positive u64")
  })

  test("treats sequence conflicts as pre-dispatch and unknown receipts as ambiguous", () => {
    expect(isDefinitiveReplOperationFailure({ hostCode: "effect_conflict" })).toBe(true)
    expect(isDefinitiveReplOperationFailure({ hostCode: "capability_unavailable" })).toBe(true)
    expect(isDefinitiveReplOperationFailure({ hostCode: "effect_outcome_unknown" })).toBe(false)
    expect(isDefinitiveReplOperationFailure(new Error("transport disconnected"))).toBe(false)
  })

  test("keeps callback projection closed until HostKernel event and reply receipts exist", () => {
    const registry = makeRegistry()
    const session = created(registry)
    const ref = { sessionID: session.sessionID, generation: session.generation }
    registry.bindProcessRefOwned(ref, authorityFor(session), interpreterProcessRef)
    const active = registry.activateOwned(ref, authorityFor(session), Date.now())
    expect(replCallbackIngressAvailable()).toBe(false)
    expect(() => projectReplCallbackInvocationV1({
      session: active,
      event: {
        eventSequence: "1",
        hostProcessRef: interpreterProcessRef,
        sessionID: active.sessionID,
        locationID: active.locationID,
        workspaceRevision: active.workspaceRevision,
        callback: {
          generation: active.generation,
          callbackID: "callback-1",
          capabilityID: "files.read",
          arguments: { path: "src/main.ts" },
        },
      },
    })).toThrow("callback ingress is unavailable")
  })
})

const validSupervisedStatusResponse = (over: Record<string, unknown> = {}) => ({
  executionID: "repl-process-1",
  generation: "1",
  state: "RUNNING",
  stdoutSequence: "0",
  stderrSequence: "0",
  exitCode: null,
  stdoutDigest: "blake3:" + "0".repeat(64),
  stderrDigest: "blake3:" + "0".repeat(64),
  outputBytes: "0",
  truncated: false,
  receiptDigest: null,
  resourceGuarantees,
  ...over,
})

describe("supervised REPL process lifecycle", () => {
  test("readSupervisedReplStatusV1 rejects non-matching process references", async () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      callbackCapabilities: ["files.read"],
    })
    const ref = { sessionID: "repl-1", generation: session.generation }

    // Wrong kind
    await expect(readSupervisedReplStatusV1({
      registry,
      ref,
      authority,
      processRef: { ...interpreterProcessRef, kind: "language_server" as any },
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async () => ({}),
    })).rejects.toThrow("HostKernel interpreter reference does not match the authenticated REPL generation and profile")

    // Wrong owner epoch
    await expect(readSupervisedReplStatusV1({
      registry,
      ref,
      authority,
      processRef: { ...interpreterProcessRef, ownerEpoch: "99" },
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async () => ({}),
    })).rejects.toThrow("HostKernel interpreter reference does not match the authenticated REPL generation and profile")

    // Wrong profileId
    await expect(readSupervisedReplStatusV1({
      registry,
      ref,
      authority,
      processRef: { ...interpreterProcessRef, profileID: "other-profile" },
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async () => ({}),
    })).rejects.toThrow("HostKernel interpreter reference does not match the authenticated REPL generation and profile")
  })

  test("readSupervisedReplStatusV1 rejects when HostKernel does not confirm OS resource limits", async () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      callbackCapabilities: ["files.read"],
    })
    const ref = { sessionID: "repl-1", generation: session.generation }

    await expect(readSupervisedReplStatusV1({
      registry,
      ref,
      authority,
      processRef: interpreterProcessRef,
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async () =>
        validSupervisedStatusResponse({
          resourceGuarantees: {
            cpuTimeEnforced: true,
            memoryEnforced: false,
            processCountEnforced: true,
            fileDescriptorsEnforced: true,
          },
        }),
    })).rejects.toBeInstanceOf(ReplProcessUnavailableError)
  })

  test("readSupervisedReplStatusV1 returns status when OS resource guarantees are confirmed", async () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      callbackCapabilities: ["files.read"],
    })
    const ref = { sessionID: "repl-1", generation: session.generation }

    const status = await readSupervisedReplStatusV1({
      registry,
      ref,
      authority,
      processRef: interpreterProcessRef,
      effectID: "effect-1",
      challengeID: "challenge-1",
      requestHostKernel: async () => validSupervisedStatusResponse(),
    })
    expect(status.state).toBe("RUNNING")
    expect(status.resourceGuarantees?.memoryEnforced).toBe(true)
  })

  test("readSupervisedReplOutputV1 enforces resource guarantees before returning output", async () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      callbackCapabilities: ["files.read"],
    })
    const ref = { sessionID: "repl-1", generation: session.generation }

    // Missing CPU guarantee
    await expect(readSupervisedReplOutputV1({
      registry,
      ref,
      authority,
      processRef: interpreterProcessRef,
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityLeaseDigest: "blake3:" + "2".repeat(64),
      afterStdoutSequence: "0",
      afterStderrSequence: "0",
      maxBytes: 1024,
      requestHostKernel: async () =>
        validSupervisedStatusResponse({
          resourceGuarantees: { ...resourceGuarantees, cpuTimeEnforced: false },
        }),
    })).rejects.toBeInstanceOf(ReplProcessUnavailableError)

    // Confirmed guarantees
    let outputRequested = false
    const output = await readSupervisedReplOutputV1({
      registry,
      ref,
      authority,
      processRef: interpreterProcessRef,
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityLeaseDigest: "blake3:" + "2".repeat(64),
      afterStdoutSequence: "0",
      afterStderrSequence: "0",
      maxBytes: 1024,
      requestHostKernel: async (_domain: string, op: string) => {
        if (op === "read") {
          outputRequested = true
          return {
            executionID: "repl-process-1",
            generation: "1",
            records: [],
            nextStdoutSequence: "0",
            nextStderrSequence: "0",
            eof: false,
            truncated: false,
            state: "RUNNING",
            receiptDigest: null,
          }
        }
        return validSupervisedStatusResponse()
      },
    })
    expect(outputRequested).toBe(true)
    expect(output.records).toEqual([])
  })

  test("cancelSupervisedReplV1 fails closed when repl.stop process effect is not allowed", async () => {
    const registry = makeRegistry()
    const session = createSession(registry, {
      sessionID: "repl-1",
      language: "python",
      scope: "workspace://ws-1",
      nowMs: 1_000,
      resourceLimits,
      callbackCapabilities: ["files.read"],
    })
    const ref = { sessionID: "repl-1", generation: session.generation }

    await expect(cancelSupervisedReplV1({
      registry,
      ref,
      authority,
      processRef: interpreterProcessRef,
      effectID: "effect-1",
      challengeID: "challenge-1",
      capabilityLeaseDigest: "blake3:" + "2".repeat(64),
      requestHostKernel: async () => ({}),
    })).rejects.toMatchObject({
      _tag: "LanguageServiceProcessError",
      operation: "repl.stop",
      reason: "guard_not_verified",
    })
  })
})
