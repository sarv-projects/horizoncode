import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

/**
 * DebugAdapterBrokerV1 session bookkeeping and generation-scoped references
 * (§37.7, §32.28).
 *
 * Scope of this module: lifecycle state, generation-scoped refs and the
 * fail-closed effect boundary. It must never spawn or attach a debug adapter,
 * download/install one, execute `runInTerminal`, set/remove breakpoints,
 * control execution or evaluate an expression. Those are effects and stay
 * UNAVAILABLE until the Rust Guard/ExecutionHost mediation for this origin is
 * implemented and verified.
 *
 * The lifecycle registry below is driven explicitly (activation, crash,
 * expiry, reset). It is the reusable half that a future Guard-mediated
 * adapter session will feed; until then nothing in production calls it and
 * every effectful operation throws `UnavailableError`.
 *
 * Session-loss rule (§37.7): a crashed, expired, replaced or terminated
 * generation can never be reused — refs to it fail with `StaleRefError`.
 */

export const SessionState = Schema.Literals(["created", "active", "crashed", "expired", "terminated"])
export type SessionState = typeof SessionState.Type

export const Ref = Schema.Struct({
  sessionID: Schema.String,
  generation: PositiveInt,
}).annotate({ identifier: "DAPSessionRefV1" })
export type Ref = typeof Ref.Type

export interface Session {
  readonly sessionID: string
  readonly generation: number
  readonly adapterID: string
  readonly workspaceId: string
  readonly launchConfigDigest: string
  readonly state: SessionState
}

export class TransitionError extends Schema.TaggedErrorClass<TransitionError>()("DAPSessionTransitionError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  state: SessionState,
  action: Schema.String,
}) {}

export const StaleReason = Schema.Literals([
  "generation_replaced",
  "not_active",
  "session_lost",
  "session_expired",
  "session_terminated",
])
export type StaleReason = typeof StaleReason.Type

/**
 * A frame/variable/thread reference no longer names a live adapter session.
 * Session loss invalidates every generation-scoped reference with it.
 */
export class StaleRefError extends Schema.TaggedErrorClass<StaleRefError>()("DAPStaleRefError", {
  sessionID: Schema.String,
  generation: PositiveInt,
  reason: StaleReason,
  current: Schema.optional(PositiveInt),
}) {}

export const Operation = Schema.Literals([
  "adapter.install",
  "session.start",
  "session.attach",
  "session.evaluate",
  "session.control",
  "breakpoint.set",
  "breakpoint.remove",
  "run_in_terminal",
])
export type Operation = typeof Operation.Type

export const UnavailableReason = Schema.Literals(["guard_not_verified"])
export type UnavailableReason = typeof UnavailableReason.Type

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("DAPUnavailableError", {
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
 * Non-throwing availability report. No debug-adapter effect is available yet:
 * adapter installation, start/attach, runInTerminal, breakpoint mutation,
 * execution control and evaluate all require the canonical Guard/
 * ExecutionHost route, which is not verified for this origin.
 */
export function availability(operation: Operation): Availability {
  return {
    operation,
    available: false,
    reason: "guard_not_verified",
    detail: "debug-adapter effects need the Rust Guard/ExecutionHost route, which is not verified for this origin",
  }
}

/** Fail-closed enforcement; always throws `UnavailableError` today. */
export function requireEffectAllowed(operation: Operation): never {
  const report = availability(operation)
  throw new UnavailableError({ operation, reason: report.reason, detail: report.detail })
}

export interface Sessions {
  /**
   * Bookkeeping only: registers a session generation. Calling this does not
   * launch anything; a future Guard-mediated launcher registers the session
   * after its process effect is admitted and receipted.
   * Registering an existing sessionID replaces the generation.
   */
  readonly create: (input: {
    sessionID: string
    adapterID: string
    workspaceId: string
    launchConfigDigest: string
  }) => Session
  readonly activate: (ref: Ref) => Session
  readonly crash: (ref: Ref) => Session
  readonly expire: (ref: Ref) => Session
  readonly terminate: (ref: Ref) => Session
  /** Throws `StaleRefError` unless the reference names the active generation. */
  readonly require: (ref: Ref) => Session
  readonly list: () => readonly Session[]
}

export function makeSessions(): Sessions {
  const generations = new Map<string, number>()
  const sessions = new Map<string, Session>()

  const update = (ref: Ref, action: string, next: (session: Session) => Session | undefined): Session => {
    const session = sessions.get(ref.sessionID)
    if (!session || session.generation !== ref.generation) {
      throw new StaleRefError({
        sessionID: ref.sessionID,
        generation: ref.generation,
        reason: session ? "generation_replaced" : "session_lost",
        current: session?.generation,
      })
    }
    const updated = next(session)
    if (!updated) throw new TransitionError({ sessionID: ref.sessionID, generation: ref.generation, state: session.state, action })
    sessions.set(ref.sessionID, updated)
    return updated
  }

  return {
    create(input) {
      const generation = (generations.get(input.sessionID) ?? 0) + 1
      generations.set(input.sessionID, generation)
      const session: Session = { ...input, generation, state: "created" }
      sessions.set(input.sessionID, session)
      return session
    },
    activate(ref) {
      return update(ref, "activate", (session) => (session.state === "created" ? { ...session, state: "active" } : undefined))
    },
    crash(ref) {
      return update(ref, "crash", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "crashed" } : undefined,
      )
    },
    expire(ref) {
      return update(ref, "expire", (session) =>
        session.state === "created" || session.state === "active" ? { ...session, state: "expired" } : undefined,
      )
    },
    terminate(ref) {
      return update(ref, "terminate", (session) =>
        session.state === "terminated" ? undefined : { ...session, state: "terminated" },
      )
    },
    require(ref) {
      const session = sessions.get(ref.sessionID)
      if (!session) {
        throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason: "session_lost" })
      }
      if (session.generation !== ref.generation) {
        throw new StaleRefError({
          sessionID: ref.sessionID,
          generation: ref.generation,
          reason: "generation_replaced",
          current: session.generation,
        })
      }
      if (session.state === "active") return session
      const reason: StaleReason =
        session.state === "created"
          ? "not_active"
          : session.state === "crashed"
            ? "session_lost"
            : session.state === "expired"
              ? "session_expired"
              : "session_terminated"
      throw new StaleRefError({ sessionID: ref.sessionID, generation: ref.generation, reason })
    },
    list() {
      return [...sessions.values()]
    },
  }
}

export * as DapSession from "./session"
