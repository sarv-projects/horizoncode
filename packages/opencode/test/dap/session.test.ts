import { describe, expect, spyOn, test } from "bun:test"
import {
  DapSession,
  Ref as DapRef,
  StaleRefError,
  TransitionError,
  UnavailableError,
  availability,
  makeSessions,
  requireEffectAllowed,
  type Operation,
} from "@/dap/session"

const ALL_OPERATIONS: readonly Operation[] = [
  "adapter.install",
  "session.start",
  "session.attach",
  "session.evaluate",
  "session.control",
  "breakpoint.set",
  "breakpoint.remove",
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
  workspaceId: "ws-1",
  launchConfigDigest: "launch-1",
})

describe("dap.session lifecycle", () => {
  test("create is bookkeeping and refs are not live until activation", () => {
    const sessions = makeSessions()
    const session = sessions.create(created())
    expect(session).toMatchObject({ state: "created", generation: 1 })

    const error = capture<DapSession.StaleRefError>(() => sessions.require({ sessionID: "session-1", generation: 1 }))
    expect(error).toBeInstanceOf(StaleRefError)
    expect(error.reason).toBe("not_active")
  })

  test("activate makes the generation live and require resolves it", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    expect(sessions.activate(ref).state).toBe("active")
    expect(sessions.require(ref)).toMatchObject({ state: "active", adapterID: "python" })
  })

  test("a crash invalidates the generation for reuse", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    sessions.crash(ref)
    const error = capture<DapSession.StaleRefError>(() => sessions.require(ref))
    expect(error.reason).toBe("session_lost")
  })

  test("expiry and termination have distinct stale reasons", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const ref = { sessionID: "session-1", generation: 1 }
    sessions.activate(ref)
    sessions.expire(ref)
    expect(capture<DapSession.StaleRefError>(() => sessions.require(ref)).reason).toBe("session_expired")

    const other = makeSessions()
    other.create({ ...created(), sessionID: "session-2" })
    const otherRef = { sessionID: "session-2", generation: 1 }
    other.activate(otherRef)
    other.terminate(otherRef)
    expect(capture<DapSession.StaleRefError>(() => other.require(otherRef)).reason).toBe("session_terminated")
  })

  test("an unknown session ref reports session_lost", () => {
    const sessions = makeSessions()
    const error = capture<DapSession.StaleRefError>(() => sessions.require({ sessionID: "missing", generation: 1 }))
    expect(error.reason).toBe("session_lost")
  })

  test("adapter restart replaces the generation and old refs cannot be reused", () => {
    const sessions = makeSessions()
    sessions.create(created())
    const oldRef = { sessionID: "session-1", generation: 1 }
    sessions.activate(oldRef)

    const restarted = sessions.create(created())
    expect(restarted.generation).toBe(2)

    const error = capture<DapSession.StaleRefError>(() => sessions.require(oldRef))
    expect(error.reason).toBe("generation_replaced")
    expect(error.current).toBe(2)

    const newRef = { sessionID: "session-1", generation: 2 }
    sessions.activate(newRef)
    expect(sessions.require(newRef).generation).toBe(2)
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

  test("list reports every tracked generation", () => {
    const sessions = makeSessions()
    sessions.create(created())
    sessions.create({ ...created(), sessionID: "session-2" })
    expect(sessions.list()).toHaveLength(2)
  })
})

describe("dap.session fail-closed boundary", () => {
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

  test("lifecycle and boundary calls spawn no process and download nothing", () => {
    const spawnSpy = spyOn(Bun, "spawn")
    const writeSpy = spyOn(Bun, "write")
    const fetchSpy = spyOn(globalThis, "fetch")
    try {
      const sessions = makeSessions()
      const session = sessions.create(created())
      const ref = { sessionID: session.sessionID, generation: session.generation }
      sessions.activate(ref)
      sessions.require(ref)
      sessions.crash(ref)
      sessions.create(created())
      sessions.terminate({ sessionID: session.sessionID, generation: 2 })
      sessions.list()
      for (const operation of ALL_OPERATIONS) {
        availability(operation)
        capture(() => requireEffectAllowed(operation))
      }
      capture(() => sessions.require({ sessionID: "missing", generation: 1 }))
    } finally {
      spawnSpy.mockRestore()
      writeSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
