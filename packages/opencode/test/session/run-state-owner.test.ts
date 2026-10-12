import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { SessionSupervisor as SessionSupervisorRelative } from "../../../core/src/session/supervisor"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const runStateLayer = LayerNode.compile(SessionRunState.node, [
  [
    BackgroundJob.node,
    Layer.mock(BackgroundJob.Service, {
      list: () => Effect.succeed([]),
      cancel: () => Effect.succeed(undefined),
    }),
  ],
  [SessionStatus.node, Layer.mock(SessionStatus.Service, { set: () => Effect.void })],
])

const it = testEffect(runStateLayer)

function resultFor(sessionID: SessionID): SessionV1.WithParts {
  return {
    info: {
      id: SessionV1.MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "test",
      model: {
        providerID: ProviderV2.ID.make("test-provider"),
        modelID: ModelV2.ID.make("test-model"),
      },
    },
    parts: [],
  }
}

it.instance("V1 loop and shell respect a shared Session owner and recover after release", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    expect(SessionSupervisorRelative.acquireExecutionOwner).toBe(SessionSupervisor.acquireExecutionOwner)
    const sessionID = SessionID.make("ses_shared_execution_owner_test")
    const result = resultFor(sessionID)
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const owner = yield* Effect.gen(function* () {
      yield* SessionSupervisor.acquireExecutionOwner(sessionID, "core-v2")
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
    }).pipe(Effect.scoped, Effect.forkScoped)
    yield* Deferred.await(started)

    let workCalls = 0
    const work = Effect.sync(() => {
      workCalls++
      return result
    })
    const loop = yield* runState.ensureRunning(sessionID, Effect.succeed(result), work).pipe(Effect.exit)
    expect(Exit.isFailure(loop)).toBe(true)
    if (Exit.isFailure(loop)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(loop.cause))).toMatchObject({
        _tag: "SessionBusyError",
        sessionID,
      })
    }

    const shell = yield* runState.startShell(sessionID, Effect.succeed(result), work).pipe(Effect.exit)
    expect(Exit.isFailure(shell)).toBe(true)
    if (Exit.isFailure(shell)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(shell.cause))).toMatchObject({
        _tag: "SessionBusyError",
        sessionID,
      })
    }
    expect(workCalls).toBe(0)
    const preflight = yield* runState.withExecutionOwner(sessionID, work).pipe(Effect.exit)
    expect(Exit.isFailure(preflight)).toBe(true)
    if (Exit.isFailure(preflight)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(preflight.cause))).toMatchObject({
        _tag: "SessionBusyError",
        sessionID,
      })
    }
    expect(workCalls).toBe(0)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(owner)
    expect(yield* runState.ensureRunning(sessionID, Effect.succeed(result), work)).toBe(result)
    expect(workCalls).toBe(1)
  }),
)
