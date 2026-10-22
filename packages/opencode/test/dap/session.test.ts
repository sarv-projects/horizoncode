import { describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import {
  DapSession,
  Ref as DapRef,
  StaleRefError,
  TransitionError,
  UnavailableError,
  authorizeEffect,
  availability,
  debugEffectRouteAvailable,
  guardActionID,
  makeSessions,
  operationForCommand,
  Operation as DapOperationSchema,
  requireEffectAllowed,
  setDebugEffectRoute,
  type DebugEffectRequest,
  type Operation,
} from "@/dap/session"
import { it } from "../lib/effect"

const ALL_OPERATIONS: readonly Operation[] = [
  "adapter.install",
  "session.start",
  "session.attach",
  "session.stop",
  "session.evaluate",
  "session.control",
  "breakpoint.set",
  "breakpoint.remove",
  "debug.breakpoints",
  "debug.continue",
  "debug.pause",
  "debug.step.over",
  "debug.step.into",
  "debug.step.out",
  "debug.stack",
  "debug.scopes",
  "run_in_terminal",
]

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

const created = () => ({
  sessionID: "session-1",
  adapterID: "python",
  principalId: "principal-1",
  locationID: "location-1",
  workspaceId: "ws-1",
  workspaceRevision: "blake3:" + "1".repeat(64),
  ownerEpoch: "7",
  policyGeneration: "policy-1",
  sandboxGeneration: 1,
  capabilityCeilingDigest: "blake3:" + "a".repeat(64),
  launchConfigDigest: "blake3:" + "d".repeat(64),
  launchProfileRef: { profileId: "dap-python", revision: "1", profileDigest: "blake3:" + "c".repeat(64) },
  processRef: {
    executionID: "adapter-exec-1",
    generation: "1",
    ownerEpoch: "7",
    kind: "debug_adapter" as const,
    profileID: "dap-python",
    profileRevision: "1",
    profileDigest: "blake3:" + "c".repeat(64),
    executableDigest: "blake3:" + "e".repeat(64),
  },
})

const authority = {
  sessionID: "session-1",
  generation: 1,
  principalId: "principal-1",
  locationID: "location-1",
  workspaceId: "ws-1",
  workspaceRevision: "blake3:" + "1".repeat(64),
  ownerEpoch: "7",
  policyGeneration: "policy-1",
  sandboxGeneration: 1,
  capabilityCeilingDigest: "blake3:" + "a".repeat(64),
}

const effectRequest = (operation: Operation, over: Partial<DebugEffectRequest> = {}): DebugEffectRequest => ({
  operation,
  ...authority,
  ...(!["session.start", "session.attach"].includes(operation)
    ? {
        adapterProcessRef: {
          executionID: "adapter-exec-1",
          generation: "3",
          ownerEpoch: "7",
          kind: "debug_adapter" as const,
          profileID: "dap-gdb",
          profileRevision: "1",
          profileDigest: "blake3:" + "c".repeat(64),
          executableDigest: "blake3:" + "e".repeat(64),
        },
      }
    : {}),
  ...(["session.start", "session.attach"].includes(operation)
    ? {
        launchConfigDigest: "blake3:" + "d".repeat(64),
        launchProfileRef: {
          profileId: "dap-gdb",
          revision: "1",
          profileDigest: "blake3:" + "c".repeat(64),
        },
        ...(operation === "session.attach"
          ? {
              targetProcessRef: {
                executionID: "exec-1",
                generation: "2",
                ownerEpoch: "7",
                kind: "terminal_run" as const,
                profileID: "shell-default",
                profileRevision: "1",
                profileDigest: "blake3:" + "d".repeat(64),
                executableDigest: "blake3:" + "e".repeat(64),
              },
            }
          : {}),
      }
    : {}),
  ...over,
})

describe("dap.session lifecycle", () => {
  test("create is bookkeeping and refs are not live until activation", () => {
    const sessions = makeSessions()
    const session = sessions.create(created())
    expect(session).toMatchObject({ state: "created", generation: 1 })
    expect(Object.isFrozen(session)).toBe(true)
    expect(Reflect.set(session, "state", "active")).toBe(false)

    const error = capture<DapSession.StaleRefError>(() =>
      sessions.requireOwned({ sessionID: "session-1", generation: 1 }, authority),
    )
    expect(error).toBeInstanceOf(StaleRefError)
    expect(error.reason).toBe("not_active")
  })

  test("debug sessions retain trusted owner, workspace revision and sandbox bindings", () => {
    const sessions = makeSessions()
    const session = sessions.create(created())
    expect(session).toMatchObject({
      principalId: "principal-1",
      locationID: "location-1",
      workspaceId: "ws-1",
      workspaceRevision: "blake3:" + "1".repeat(64),
      policyGeneration: "policy-1",
      sandboxGeneration: 1,
      capabilityCeilingDigest: "blake3:" + "a".repeat(64),
    })
    expect(() => sessions.create({ ...created(), principalId: " " })).toThrow(
      "debug session principalId must be non-empty",
    )
  })

  test("retained managed scope and HostKernel process ref are immutable copies", () => {
    const managedAttemptScope = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      locationID: "location-1",
      sessionID: "session-1",
      workspaceRevision: authority.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
    }
    const session = makeSessions().create({ ...created(), managedAttemptScope })
    expect(session.managedAttemptScope).toEqual(managedAttemptScope)
    expect(Object.isFrozen(session.managedAttemptScope)).toBe(true)
    expect(session.launchProfileRef).toEqual(created().launchProfileRef)
    expect(Object.isFrozen(session.launchProfileRef)).toBe(true)
    expect(Object.isFrozen(session.processRef)).toBe(true)
  })

  test("session admission rejects a process ref from a different immutable profile revision", () => {
    const value = created()
    const mismatched = {
      ...value,
      processRef: { ...value.processRef, profileRevision: "2", profileDigest: "blake3:" + "f".repeat(64) },
    }
    expect(() => makeSessions().create(mismatched)).toThrow("does not match the retained launch profile pin")
  })

  test("activate makes the generation live and require resolves it", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    expect(sessions.activate(ref).state).toBe("active")
    expect(sessions.requireOwned(ref, authority)).toMatchObject({ state: "active", adapterID: "python" })
  })

  test("session and object reads require the full authenticated owner binding", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    const objectRef = sessions.bindObjectRefOwned(ref, "frame", 7, authority)

    expect(sessions.requireOwned(ref, authority).sessionID).toBe("session-1")
    expect(sessions.resolveObjectRefOwned(objectRef, authority).id).toBe(7)
    for (const mismatched of [
      { ...authority, principalId: "principal-2" },
      { ...authority, locationID: "location-2" },
      { ...authority, ownerEpoch: "8" },
      { ...authority, workspaceId: "ws-2" },
      { ...authority, workspaceRevision: "blake3:" + "2".repeat(64) },
      { ...authority, policyGeneration: "policy-2" },
      { ...authority, sandboxGeneration: 2 },
      { ...authority, capabilityCeilingDigest: "blake3:" + "f".repeat(64) },
    ]) {
      expect(capture<DapSession.StaleRefError>(() => sessions.requireOwned(ref, mismatched))).toMatchObject({
        reason: "session_lost",
      })
      expect(
        capture<DapSession.StaleRefError>(() => sessions.resolveObjectRefOwned(objectRef, mismatched)),
      ).toMatchObject({ reason: "session_lost" })
    }
  })

  test("adapter object references resolve only inside their active session generation", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    const session = sessions.activate(ref)
    const objectRefs = [
      sessions.bindObjectRefOwned(ref, "thread", 1, authority),
      sessions.bindObjectRefOwned(ref, "frame", 2, authority),
      sessions.bindObjectRefOwned(ref, "variables", 3, authority),
    ]

    expect(objectRefs).toEqual([
      { ...ref, kind: "thread", id: 1 },
      { ...ref, kind: "frame", id: 2 },
      { ...ref, kind: "variables", id: 3 },
    ])
    expect(objectRefs.map((objectRef) => sessions.resolveObjectRefOwned(objectRef, authority))).toEqual(
      objectRefs.map((objectRef) => ({ session, kind: objectRef.kind, id: objectRef.id })),
    )
  })

  test("adapter object references become stale after crash or generation replacement", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const oldRef = { sessionID: "session-1", generation: 1 }
    sessions.activate(oldRef)
    const frameRef = sessions.bindObjectRefOwned(oldRef, "frame", 7, authority)
    sessions.crash(oldRef)

    expect(capture<DapSession.StaleRefError>(() => sessions.resolveObjectRefOwned(frameRef, authority)).reason).toBe(
      "session_lost",
    )

    sessions.create(created())
    const replacement = capture<DapSession.StaleRefError>(() => sessions.resolveObjectRefOwned(frameRef, authority))
    expect(replacement.reason).toBe("generation_replaced")
    expect(replacement.current).toBe(2)
  })

  test("adapter object references report expiry and termination reasons distinctly", () => {
    const expired = makeSessions()
    expired.create(created())
    const expiredRef = { sessionID: "session-1", generation: 1 }
    expired.activate(expiredRef)
    const expiredFrame = expired.bindObjectRefOwned(expiredRef, "frame", 1, authority)
    expired.expire(expiredRef)
    expect(capture<DapSession.StaleRefError>(() => expired.resolveObjectRefOwned(expiredFrame, authority)).reason).toBe(
      "session_expired",
    )

    const terminated = makeSessions()
    terminated.create(created())
    const terminatedRef = { sessionID: "session-1", generation: 1 }
    terminated.activate(terminatedRef)
    const terminatedFrame = terminated.bindObjectRefOwned(terminatedRef, "frame", 1, authority)
    terminated.terminate(terminatedRef)
    expect(
      capture<DapSession.StaleRefError>(() => terminated.resolveObjectRefOwned(terminatedFrame, authority)).reason,
    ).toBe("session_terminated")

    // A frame reference from a session that never existed is lost, not empty.
    expect(
      capture<DapSession.StaleRefError>(() =>
        terminated.resolveObjectRefOwned({ sessionID: "missing", generation: 1, kind: "frame", id: 1 }, authority),
      ).reason,
    ).toBe("session_lost")
  })

  test("adapter object references reject zero or invalid adapter IDs", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)

    expect(() => sessions.bindObjectRefOwned(ref, "variables", 0, authority)).toThrow()
    expect(() => sessions.bindObjectRefOwned(ref, "frame", Number.NaN, authority)).toThrow()
  })

  test("a crash invalidates the generation for reuse", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    sessions.crash(ref)
    const error = capture<DapSession.StaleRefError>(() => sessions.requireOwned(ref, authority))
    expect(error.reason).toBe("session_lost")
  })

  test("an uncertain adapter command quarantines its generation and cannot be terminated away", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    sessions.markUnknown(ref)

    expect(capture<DapSession.StaleRefError>(() => sessions.requireOwned(ref, authority)).reason).toBe(
      "outcome_unknown",
    )
    expect(capture<DapSession.TransitionError>(() => sessions.terminate(ref)).state).toBe("unknown")
    expect(capture<DapSession.TransitionError>(() => sessions.create(created())).state).toBe("unknown")
  })

  test("expiry and termination have distinct stale reasons", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    sessions.expire(ref)
    expect(capture<DapSession.StaleRefError>(() => sessions.requireOwned(ref, authority)).reason).toBe(
      "session_expired",
    )

    const other = makeSessions()
    other.create({ ...created(), sessionID: "session-2" })
    const otherRef = { sessionID: "session-2", generation: 1 }
    other.activate(otherRef)
    other.terminate(otherRef)
    expect(capture<DapSession.StaleRefError>(() => other.requireOwned(otherRef, authority)).reason).toBe(
      "session_terminated",
    )
  })

  test("an unknown session ref reports session_lost", () => {
    const sessions = makeSessions()
    const error = capture<DapSession.StaleRefError>(() =>
      sessions.requireOwned({ sessionID: "missing", generation: 1 }, authority),
    )
    expect(error.reason).toBe("session_lost")
  })

  test("adapter restart replaces the generation and old refs cannot be reused", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const oldRef = { sessionID: "session-1", generation: 1 }
    sessions.activate(oldRef)

    expect(capture<DapSession.TransitionError>(() => sessions.create(created())).state).toBe("active")
    sessions.terminate(oldRef)
    const restarted = sessions.create(created())
    expect(restarted.generation).toBe(2)

    const error = capture<DapSession.StaleRefError>(() => sessions.requireOwned(oldRef, authority))
    expect(error.reason).toBe("generation_replaced")
    expect(error.current).toBe(2)

    const newRef = { sessionID: "session-1", generation: 2 }
    sessions.activate(newRef)
    expect(sessions.requireOwned(newRef, authority).generation).toBe(2)
  })

  test("crashing and restarting one adapter does not stale another session's object refs", () => {
    const sessions = makeSessions()
    sessions.create(created())
    sessions.create({ ...created(), sessionID: "session-2" })
    const firstRef = { sessionID: "session-1", generation: 1 }
    const secondRef = { sessionID: "session-2", generation: 1 }
    sessions.activate(firstRef)
    sessions.activate(secondRef)
    const firstObject = sessions.bindObjectRefOwned(firstRef, "frame", 11, authority)
    const secondObject = sessions.bindObjectRefOwned(secondRef, "variables", 22, authority)

    sessions.crash(firstRef)
    expect(capture<DapSession.StaleRefError>(() => sessions.resolveObjectRefOwned(firstObject, authority)).reason).toBe(
      "session_lost",
    )

    const restarted = sessions.create(created())
    expect(restarted.generation).toBe(2)
    sessions.activate({ sessionID: "session-1", generation: 2 })
    expect(sessions.resolveObjectRefOwned(secondObject, authority)).toMatchObject({
      session: { sessionID: "session-2", generation: 1 },
      kind: "variables",
      id: 22,
    })
  })

  test("invalid transitions are rejected with a typed error", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    expect(capture<DapSession.TransitionError>(() => sessions.activate(ref))._tag).toBe("DAPSessionTransitionError")

    sessions.terminate(ref)
    expect(capture<DapSession.TransitionError>(() => sessions.crash(ref)).state).toBe("terminated")
  })

  test("session listing is restricted to the authenticated owner and scope", () => {
    const sessions = makeSessions()
    sessions.create(created())
    sessions.create({ ...created(), sessionID: "session-2", principalId: "principal-2" })
    expect(sessions.listOwned(authority).map((session) => session.sessionID)).toEqual(["session-1"])
  })

  test("owned lifecycle mutations require the full authenticated workspace binding", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }

    expect(() => sessions.activateOwned(ref, { ...authority, workspaceRevision: "foreign-revision" })).toThrow(
      DapSession.StaleRefError,
    )
    expect(sessions.activateOwned(ref, authority).state).toBe("active")
    expect(() => sessions.markUnknownOwned(ref, { ...authority, principalId: "principal-2" })).toThrow(
      DapSession.StaleRefError,
    )
    expect(sessions.markUnknownOwned(ref, authority).state).toBe("unknown")
  })
})

describe("dap.session fail-closed boundary", () => {
  test("DAP commands map to canonical actions and unsupported process commands stay unavailable", () => {
    expect(operationForCommand("attach")).toBe("session.attach")
    expect(operationForCommand("evaluate")).toBe("session.evaluate")
    expect(operationForCommand("setVariable")).toBeUndefined()
    expect(operationForCommand("setExpression")).toBeUndefined()
    expect(operationForCommand("setBreakpoints")).toBe("breakpoint.set")
    expect(operationForCommand("variables")).toBeUndefined()
    expect(operationForCommand("next")).toBe("debug.step.over")
    expect(operationForCommand("runInTerminal")).toBeUndefined()
    expect(operationForCommand("vendor.extensionCommand")).toBeUndefined()
  })

  test("stop has an explicit fail-closed operation", () => {
    expect(Schema.decodeUnknownSync(DapOperationSchema)("session.stop")).toBe("session.stop")
  })

  test("every effectful operation reports guard_not_verified and throws", () => {
    for (const operation of ALL_OPERATIONS) {
      const report = availability(operation)
      expect(report).toMatchObject({ operation, available: false, reason: "guard_not_verified" })
      const error = capture<DapSession.UnavailableError>(() => requireEffectAllowed(operation))
      expect(error).toBeInstanceOf(UnavailableError)
      expect(error._tag).toBe("DAPUnavailableError")
      expect(error.operation).toBe(operation)
      expect(error.reason).toBe("guard_not_verified")
    }
  })

  test("a live generation does not unlock adapter effects", () => {
    const sessions = makeSessions()
    sessions.create(created())
    sessions.activate({ sessionID: "session-1", generation: 1 })
    for (const operation of ["session.evaluate", "session.attach", "run_in_terminal"] as const) {
      expect(capture<DapSession.UnavailableError>(() => requireEffectAllowed(operation)).operation).toBe(operation)
    }
  })

  test("the Ref schema is exported through the module namespace", () => {
    expect(DapRef).toBeDefined()
    expect(DapSession.makeSessions).toBe(makeSessions)
  })

  it.live("lifecycle and boundary calls spawn no process and download nothing", () =>
    Effect.sync(() => {
      const spawnSpy = spyOn(Bun, "spawn")
      const writeSpy = spyOn(Bun, "write")
      const fetchSpy = spyOn(globalThis, "fetch")
      try {
        const sessions = makeSessions()
        const session = sessions.create(created())
        const ref = { sessionID: session.sessionID, generation: session.generation }
        sessions.activate(ref)
        sessions.requireOwned(ref, authority)
        sessions.crash(ref)
        sessions.create(created())
        sessions.terminate({ sessionID: session.sessionID, generation: 2 })
        sessions.listOwned(authority)
        for (const operation of ALL_OPERATIONS) {
          availability(operation)
          capture(() => requireEffectAllowed(operation))
        }
        capture(() => sessions.requireOwned({ sessionID: "missing", generation: 1 }, authority))
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

describe("dap.session canonical Guard effect route", () => {
  test("registering a route cannot unlock DAP before integrated Guard acceptance", async () => {
    const scope = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      locationID: "location-1",
      sessionID: "session-1",
      workspaceRevision: authority.workspaceRevision,
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
    }
    const requests: DebugEffectRequest[] = []
    setDebugEffectRoute({
      authorize: async (request) => {
        requests.push(request)
        return {
          capabilityID: "debug.stop",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "a".repeat(64),
        }
      },
    })
    try {
      expect(debugEffectRouteAvailable()).toBe(false)
      for (const operation of ["session.stop", "session.attach", "session.evaluate"] as const) {
        await expect(authorizeEffect(effectRequest(operation, { managedAttemptScope: scope })))
          .rejects.toBeInstanceOf(UnavailableError)
      }
      expect(requests).toHaveLength(0)
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("no registered route keeps every debug effect typed-unavailable", async () => {
    expect(debugEffectRouteAvailable()).toBe(false)
    for (const operation of ALL_OPERATIONS) {
      let thrown: unknown
      try {
        await authorizeEffect(effectRequest(operation))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(UnavailableError)
      expect((thrown as DapSession.UnavailableError).operation).toBe(operation)
      expect((thrown as DapSession.UnavailableError).reason).toBe("guard_not_verified")
    }
  })

  test("a registered boundary is not called before integrated acceptance", async () => {
    const requests: Array<Record<string, unknown>> = []
    setDebugEffectRoute({
      authorize: async (request) => {
        requests.push({ ...request })
        return { capabilityID: "debug.start", challengeID: "", effectID: "e", capabilityLeaseDigest: "" } as never
      },
    })
    try {
      expect(debugEffectRouteAvailable()).toBe(false)
      await expect(
        authorizeEffect(effectRequest("session.start")),
      ).rejects.toThrow(UnavailableError)
      expect(requests).toEqual([])
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("malformed launch profile and authority bindings are rejected before Guard dispatch", async () => {
    const requests: unknown[] = []
    setDebugEffectRoute({
      authorize: async (request) => {
        requests.push(request)
        return {
          capabilityID: "debug.start",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "a".repeat(64),
        }
      },
    })
    try {
      await expect(
        authorizeEffect(
          effectRequest("session.start", {
            launchProfileRef: {
              profileId: "dap-gdb",
              revision: "01",
              profileDigest: "blake3:" + "c".repeat(64),
            },
          }),
        ),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(authorizeEffect(effectRequest("session.attach", { principalId: " " }))).rejects.toBeInstanceOf(
        UnavailableError,
      )
      await expect(
        authorizeEffect(effectRequest("session.attach", { targetProcessRef: "1234" as never })),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(
        authorizeEffect(
          effectRequest("session.attach", {
            targetProcessRef: {
              executionID: "exec-1",
              generation: "02",
              ownerEpoch: "7",
              kind: "terminal_run",
              profileID: "shell-default",
              profileRevision: "1",
              profileDigest: "blake3:" + "d".repeat(64),
              executableDigest: "blake3:" + "e".repeat(64),
            } as never,
          }),
        ),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(
        authorizeEffect(
          effectRequest("session.attach", {
            targetProcessRef: {
              executionID: "exec-1",
              generation: "18446744073709551616",
              ownerEpoch: "7",
              kind: "terminal_run",
              profileID: "shell-default",
              profileRevision: "1",
              profileDigest: "blake3:" + "d".repeat(64),
              executableDigest: "blake3:" + "e".repeat(64),
            },
          }),
        ),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(
        authorizeEffect(
          effectRequest("session.attach", {
            targetProcessRef: {
              executionID: "exec-1",
              generation: "2",
              ownerEpoch: "7",
              kind: "terminal_run",
              profileID: "shell-default",
              profileRevision: "1",
              profileDigest: "blake3:" + "d".repeat(64),
              executableDigest: "blake3:" + "e".repeat(64),
              pid: 1234,
            } as never,
          }),
        ),
      ).rejects.toBeInstanceOf(UnavailableError)
      await expect(
        authorizeEffect(effectRequest("session.start", { launchProfileRef: undefined })),
      ).rejects.toBeInstanceOf(UnavailableError)
      expect(requests).toEqual([])
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("an authorization for a different canonical action is refused", async () => {
    const lease = "blake3:" + "a".repeat(64)
    setDebugEffectRoute({
      authorize: async () => ({
        capabilityID: "debug.evaluate",
        challengeID: "ch_1",
        effectID: "eff_1",
        capabilityLeaseDigest: lease,
      }),
    })
    try {
      await expect(authorizeEffect(effectRequest("session.start"))).rejects.toBeInstanceOf(UnavailableError)
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("operations without a canonical Guard action never reach the registered boundary", async () => {
    const requests: Array<Record<string, unknown>> = []
    setDebugEffectRoute({
      authorize: async (request) => {
        requests.push({ ...request })
        return {
          capabilityID: "debug.start",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: "blake3:" + "a".repeat(64),
        }
      },
    })
    try {
      for (const operation of [
        "adapter.install",
        "session.control",
        "run_in_terminal",
      ] as const) {
        await expect(authorizeEffect(effectRequest(operation))).rejects.toBeInstanceOf(UnavailableError)
      }
      expect(requests).toEqual([])
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("a registered route cannot enable DAP evaluate or expose its process pin", async () => {
    const lease = "blake3:" + "a".repeat(64)
    let routed: DapSession.DebugEffectRequest | undefined
    setDebugEffectRoute({
      authorize: async (request) => {
        routed = request
        return {
          capabilityID: "debug.evaluate",
          challengeID: "ch_1",
          effectID: "eff_1",
          capabilityLeaseDigest: lease,
        }
      },
    })
    try {
      expect(debugEffectRouteAvailable()).toBe(false)
      await expect(authorizeEffect(effectRequest("session.evaluate", { generation: 2 })))
        .rejects.toBeInstanceOf(UnavailableError)
      expect(routed).toBeUndefined()
    } finally {
      setDebugEffectRoute(undefined)
    }
  })

  test("canonical action IDs are the Rust Guard constants", async () => {
    const guard = await Bun.file(path.resolve(import.meta.dir, "../../../../kernel/src/guard.rs")).text()
    for (const action of ["debug.start", "debug.attach", "debug.stop", "debug.evaluate"]) {
      expect(guard).toContain(`"${action}"`)
    }
    expect(guardActionID("session.start")).toBe("debug.start")
    expect(guardActionID("session.attach")).toBe("debug.attach")
    expect(guardActionID("session.stop")).toBe("debug.stop")
    expect(guardActionID("session.evaluate")).toBe("debug.evaluate")
    expect(guardActionID("adapter.install")).toBeUndefined()
    expect(guardActionID("run_in_terminal")).toBeUndefined()
  })
})
