import { describe, expect, spyOn, test } from "bun:test"
import {
  DEFAULT_IDLE_TTL_MS,
  ReplLifecycle,
  StaleRefError,
  TransitionError,
  UnavailableError,
  availability,
  makeRegistry,
  requireEffectAllowed,
  type Operation,
} from "@/repl/lifecycle"
import type { ExecuteResult } from "@/repl/protocol"

const ALL_OPERATIONS: readonly Operation[] = ["repl.start", "repl.execute", "repl.callback", "repl.stop"]

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

const created = (registry: ReplLifecycle.Registry, nowMs = 1_000) =>
  registry.create({
    sessionID: "repl-1",
    language: "python",
    scope: "workspace://ws-1",
    nowMs,
    callbackCapabilities: ["files.read"],
  })

const result = (generation: number): ExecuteResult => ({
  generation,
  status: "ok",
  value: "2",
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
})

describe("repl.lifecycle generation lifecycle", () => {
  test("create is bookkeeping and the generation is not live until activation", () => {
    const registry = makeRegistry()
    const session = created(registry)
    expect(session).toMatchObject({ state: "created", generation: 1, idleTtlMs: DEFAULT_IDLE_TTL_MS })
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.require({ sessionID: "repl-1", generation: 1 })).reason).toBe(
      "not_active",
    )
  })

  test("activate makes the generation live and touch keeps it alive", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    expect(registry.activate(ref, 2_000).state).toBe("active")
    expect(registry.touch(ref, 5_000).lastActivityMs).toBe(5_000)
    expect(registry.require(ref).state).toBe("active")
  })

  test("idle expiry invalidates the generation", () => {
    const registry = makeRegistry()
    created(registry, 1_000)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 1_000)

    expect(registry.expireIdle(1_000 + DEFAULT_IDLE_TTL_MS - 1)).toEqual([])
    expect(registry.expireIdle(1_000 + DEFAULT_IDLE_TTL_MS)).toEqual([ref])

    expect(capture<ReplLifecycle.StaleRefError>(() => registry.require(ref)).reason).toBe("expired")
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
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.require(ref)).reason).toBe("crashed")
  })

  test("reset opens a new generation and stales every old reference", () => {
    const registry = makeRegistry()
    created(registry, 1_000)
    const oldRef = { sessionID: "repl-1", generation: 1 }
    registry.activate(oldRef, 1_000)
    registry.touch(oldRef, 2_000)

    const reset = registry.reset(oldRef, 3_000)
    expect(reset).toMatchObject({ state: "created", generation: 2, lastActivityMs: 3_000 })

    const error = capture<ReplLifecycle.StaleRefError>(() => registry.require(oldRef))
    expect(error.reason).toBe("generation_replaced")
    expect(error.current).toBe(2)

    const newRef = { sessionID: "repl-1", generation: 2 }
    expect(registry.activate(newRef, 4_000).state).toBe("active")
    expect(registry.require(newRef).generation).toBe(2)
  })

  test("stop is terminal and session refs expire with it", () => {
    const registry = makeRegistry()
    created(registry)
    const ref = { sessionID: "repl-1", generation: 1 }
    registry.activate(ref, 2_000)
    registry.stop(ref)
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.require(ref)).reason).toBe("stopped")
    expect(capture<ReplLifecycle.TransitionError>(() => registry.stop(ref))._tag).toBe("ReplSessionTransitionError")
  })

  test("unknown sessions and stale results are rejected", () => {
    const registry = makeRegistry()
    expect(capture<ReplLifecycle.StaleRefError>(() => registry.require({ sessionID: "none", generation: 1 })).reason).toBe(
      "session_lost",
    )

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

  test("idle TTL input is bounded and recorded per generation", () => {
    const registry = makeRegistry()
    expect(() => registry.create({ sessionID: "repl-2", language: "python", scope: "s", nowMs: 0, idleTtlMs: 10 })).toThrow()
    const session = registry.create({ sessionID: "repl-3", language: "javascript", scope: "s", nowMs: 0, idleTtlMs: 60_000 })
    expect(session.idleTtlMs).toBe(60_000)
    registry.activate({ sessionID: "repl-3", generation: 1 }, 0)
    expect(registry.expireIdle(59_999)).toEqual([])
    expect(registry.expireIdle(60_000)).toHaveLength(1)
  })

  test("list reports every tracked generation", () => {
    const registry = makeRegistry()
    created(registry)
    registry.create({ sessionID: "repl-2", language: "javascript", scope: "s", nowMs: 0 })
    expect(registry.list()).toHaveLength(2)
  })
})

describe("repl.lifecycle fail-closed boundary", () => {
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
    expect(registry.require(ref).callbackCapabilities).toEqual(["files.read"])
    expect(capture<ReplLifecycle.UnavailableError>(() => requireEffectAllowed("repl.callback")).operation).toBe(
      "repl.callback",
    )
  })

  test("lifecycle and boundary calls spawn no process", () => {
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
      capture(() => registry.require(ref))

      const other = registry.create({ sessionID: "repl-2", language: "javascript", scope: "s", nowMs: 0 })
      const otherRef = { sessionID: "repl-2", generation: other.generation }
      registry.activate(otherRef, 1_000)
      registry.crash(otherRef)
      const reset = registry.reset(otherRef, 4_000)
      const resetRef = { sessionID: "repl-2", generation: reset.generation }
      registry.activate(resetRef, 5_000)
      registry.acceptResult(resetRef, result(reset.generation))
      registry.stop(resetRef)
      capture(() => registry.require(resetRef))
      registry.list()

      for (const operation of ALL_OPERATIONS) {
        availability(operation)
        capture(() => requireEffectAllowed(operation))
      }
    } finally {
      spawnSpy.mockRestore()
      writeSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
