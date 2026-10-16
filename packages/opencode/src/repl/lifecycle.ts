import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import type { ExecuteResult, ReplLanguage } from "./protocol"
import { DEFAULT_IDLE_TTL_MS, validateIdleTtl } from "./protocol"

export { DEFAULT_IDLE_TTL_MS }

/**
 * ReplBrokerV1 session lifecycle (§37.8, §32.28) — bounded, Python-first
 * generation bookkeeping.
 *
 * Scope of this module: session generations, idle-expiry, crash/reset
 * invalidation and generation-scoped result acceptance. It must never start
 * an interpreter, execute code or invoke an agent-tool callback. Execution,
 * callbacks and interpreter stop stay UNAVAILABLE until the Rust Guard/
 * ExecutionHost mediation for this origin is implemented and verified.
 *
 * Rules enforced here:
 * - state persists only inside one REPL generation; refs to a replaced,
 *   expired, crashed or stopped generation always fail with `StaleRefError`;
 * - idle expiry invalidates the generation (`expireIdle`);
 * - `reset` bumps the generation, so every old reference is stale by
 *   construction;
 * - a result envelope is accepted only for the live generation it was
 *   produced by (`acceptResult`);
 * - callbacks to agent tools must re-enter the canonical ActionDescriptor/
 *   Guard path; this module only records the declared capability set and
 *   reports the effect as unavailable.
 *
 * The registry is driven explicitly. It is the reusable half that a future
 * Guard-mediated interpreter session will feed; until then nothing in
 * production calls it and every effectful operation throws `UnavailableError`.
 */

export const ReplState = Schema.Literals(["created", "active", "expired", "crashed", "stopped"])
export type ReplState = typeof ReplState.Type

export const Ref = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
}).annotate({ identifier: "ReplRefV1" })
export type Ref = typeof Ref.Type

export interface ReplSession {
  readonly sessionID: string
  readonly generation: number
  readonly language: ReplLanguage
  readonly state: ReplState
  readonly scope: string
  readonly idleTtlMs: number
  readonly createdAtMs: number
  readonly lastActivityMs: number
  readonly callbackCapabilities: readonly string[]
}

export class TransitionError extends Schema.TaggedErrorClass<TransitionError>()("ReplSessionTransitionError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  state: ReplState,
  action: Schema.String,
}) {}

export const StaleReason = Schema.Literals([
  "generation_replaced",
  "not_active",
  "expired",
  "crashed",
  "stopped",
  "session_lost",
])
export type StaleReason = typeof StaleReason.Type

export class StaleRefError extends Schema.TaggedErrorClass<StaleRefError>()("ReplStaleRefError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  reason: StaleReason,
  current: Schema.optional(PositiveInt),
}) {}

export const Operation = Schema.Literals(["repl.start", "repl.execute", "repl.callback", "repl.stop"])
export type Operation = typeof Operation.Type

export const UnavailableReason = Schema.Literals(["guard_not_verified"])
export type UnavailableReason = typeof UnavailableReason.Type

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("ReplUnavailableError", {
  operation: Operation,
  reason: UnavailableReason,
  detail: Schema.optional(Schema.String),
}) {}

export interface Availability {
  readonly operation: Operation
  readonly available: false
  readonly reason: UnavailableReason
  readonly detail: string
}

/**
 * Non-throwing availability report. Starting/executing/stopping an
 * interpreter and invoking an agent-tool callback are process/tool effects
 * and require the canonical Guard/ExecutionHost route, which is not verified
 * for this origin.
 */
export function availability(operation: Operation): Availability {
  return {
    operation,
    available: false,
    reason: "guard_not_verified",
    detail: "REPL execution and callbacks need the Rust Guard/ExecutionHost route, which is not verified for this origin",
  }
}

/** Fail-closed enforcement; always throws `UnavailableError` today. */
export function requireEffectAllowed(operation: Operation): never {
  const report = availability(operation)
  throw new UnavailableError({ operation, reason: report.reason, detail: report.detail })
}

export interface Registry {
  /** Bookkeeping only; no interpreter is started by this call. */
  readonly create: (input: {
    sessionID: string
    language: ReplLanguage
    scope: string
    nowMs: number
    idleTtlMs?: number
    callbackCapabilities?: readonly string[]
  }) => ReplSession
  readonly activate: (ref: Ref, nowMs: number) => ReplSession
  readonly touch: (ref: Ref, nowMs: number) => ReplSession
  /** Expire every created/active generation idle past its TTL; returns the expired refs. */
  readonly expireIdle: (nowMs: number) => readonly Ref[]
  readonly crash: (ref: Ref) => ReplSession
  /** Invalidate the current generation and open a fresh one (old refs become stale). */
  readonly reset: (ref: Ref, nowMs: number) => ReplSession
  readonly stop: (ref: Ref) => ReplSession
  /** Throws `StaleRefError` unless the reference names the active generation. */
  readonly require: (ref: Ref) => ReplSession
  /** Accept a worker result only for the live generation that produced it. */
  readonly acceptResult: (ref: Ref, result: ExecuteResult) => ExecuteResult
  readonly list: () => readonly ReplSession[]
}

export function makeRegistry(): Registry {
  const generations = new Map<string, number>()
  const sessions = new Map<string, ReplSession>()

  const lookup = (ref: Ref): ReplSession => {
    const session = sessions.get(ref.sessionID)
    if (!session || session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: session ? "generation_replaced" : "session_lost",
        current: session?.generation,
      })
    }
    return session
  }

  const transition = (
    ref: Ref,
    action: string,
    allowed: readonly ReplState[],
    next: (session: ReplSession) => ReplSession,
  ): ReplSession => {
    const session = lookup(ref)
    if (!allowed.includes(session.state)) {
      throw new TransitionError({ sessionID: ref.sessionID, generation: ref.generation, state: session.state, action })
    }
    const updated = next(session)
    sessions.set(ref.sessionID, updated)
    return updated
  }

  const requireActive = (ref: Ref): ReplSession => {
    const session = lookup(ref)
    if (session.state === "active") return session
    const reason: StaleReason =
      session.state === "created"
        ? "not_active"
        : session.state === "expired"
          ? "expired"
          : session.state === "crashed"
            ? "crashed"
            : "stopped"
    throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason })
  }

  return {
    create(input) {
      const idleTtlMs = input.idleTtlMs === undefined ? DEFAULT_IDLE_TTL_MS : validateIdleTtl(input.idleTtlMs)
      const generation = (generations.get(input.sessionID) ?? 0) + 1
      generations.set(input.sessionID, generation)
      const session: ReplSession = {
        sessionID: input.sessionID,
        generation,
        language: input.language,
        state: "created",
        scope: input.scope,
        idleTtlMs,
        createdAtMs: input.nowMs,
        lastActivityMs: input.nowMs,
        callbackCapabilities: [...(input.callbackCapabilities ?? [])],
      }
      sessions.set(input.sessionID, session)
      return session
    },
    activate(ref, nowMs) {
      return transition(ref, "activate", ["created"], (session) => ({
        ...session,
        state: "active",
        lastActivityMs: nowMs,
      }))
    },
    touch(ref, nowMs) {
      const session = requireActive(ref)
      const updated = { ...session, lastActivityMs: nowMs }
      sessions.set(ref.sessionID, updated)
      return updated
    },
    expireIdle(nowMs) {
      const expired: Ref[] = []
      for (const session of sessions.values()) {
        if (session.state !== "created" && session.state !== "active") continue
        if (nowMs - session.lastActivityMs < session.idleTtlMs) continue
        sessions.set(session.sessionID, { ...session, state: "expired" })
        expired.push({ sessionID: session.sessionID, generation: session.generation })
      }
      return expired
    },
    crash(ref) {
      return transition(ref, "crash", ["created", "active"], (session) => ({ ...session, state: "crashed" }))
    },
    reset(ref, nowMs) {
      const session = transition(ref, "reset", ["created", "active", "crashed"], (current) => {
        const generation = (generations.get(current.sessionID) ?? current.generation) + 1
        generations.set(current.sessionID, generation)
        return {
          ...current,
          generation,
          state: "created",
          createdAtMs: nowMs,
          lastActivityMs: nowMs,
        }
      })
      return session
    },
    stop(ref) {
      return transition(ref, "stop", ["created", "active", "crashed", "expired"], (session) => ({
        ...session,
        state: "stopped",
      }))
    },
    require(ref) {
      return requireActive(ref)
    },
    acceptResult(ref, result) {
      const session = requireActive(ref)
      if (result.generation !== session.generation) {
        throw new StaleRefError({
          sessionID: ref.sessionID,
          generation: result.generation,
          reason: "generation_replaced",
          current: session.generation,
        })
      }
      return result
    },
    list() {
      return [...sessions.values()]
    },
  }
}

export * as ReplLifecycle from "./lifecycle"
