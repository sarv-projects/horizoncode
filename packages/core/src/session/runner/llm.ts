import { createHash, randomUUID } from "node:crypto"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ToolCall,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { SessionSupervisor, SessionSupervisorError } from "../../session/supervisor"
import { TrustedPrincipalContext } from "../../trusted-principal"
import type { EffectAdmission, EffectLease } from "../../session/supervisor"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Persist provider tool-call events; local calls dispatch only after complete-batch input validation.
 *   - [x] Settle local calls through the core registry and persist local/hosted outcomes.
 *   - [ ] Authorize every effectful call through Rust Guard/EffectIntent/lease and execute it through ExecutionHost.
 *   - [x] Collect local calls through terminal provider response and validate the full batch before dispatch.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const permission = yield* PermissionV2.Service
    const supervisor = yield* SessionSupervisor.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const configEntries = yield* config.entries()
    const makeTurnCompaction = Effect.fn("SessionRunner.makeTurnCompaction")(function* () {
      const turnSnapshot = config.turnSnapshot ? yield* config.turnSnapshot() : {}
      return SessionCompaction.make({ events, llm, config: configEntries, turnSnapshot })
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      compaction: ReturnType<typeof SessionCompaction.make>,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      const trustedPrincipal = (yield* TrustedPrincipalContext).principal
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const policySnapshotDigest = yield* permission.policySnapshotDigest({ agent: agent.id })
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let providerFinished = false
      const localToolCalls: ToolCall[] = []
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type === "finish") providerFinished = true
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            localToolCalls.push(event)
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const materialization = toolMaterialization
          if (
            stream._tag === "Success" &&
            !overflowFailure &&
            !publisher.hasProviderError() &&
            materialization &&
            localToolCalls.length > 0
          ) {
            if (!providerFinished || !publisher.stepSettlement()) {
              yield* withPublication(publisher.failUnsettledTools("Provider response ended before a complete tool batch"))
              yield* withPublication(publisher.failAssistant("Provider response ended before a complete tool batch"))
              needsContinuation = false
            } else {
              const validation = yield* Effect.forEach(localToolCalls, (call) => materialization.validate(call))
              const invalid = validation.some((message) => message !== undefined)
              let admission: EffectAdmission | undefined
              const leasesByCallID = new Map<string, EffectLease>()
              if (!invalid) {
                const capabilities = localToolCalls.map((call) => materialization.classify(call))
                const guarded = capabilities.some(
                  (capability) => capability.effectClass === "effect" || capability.effectClass === "unknown",
                )
                if (guarded) {
                  admission = yield* supervisor
                    .prepareToolBatch({
                      sessionID: session.id,
                      locationRef: session.location,
                      batchID: `batch_${randomUUID().replaceAll("-", "")}`,
                      turnContextDigest: `sha256:${createHash("sha256")
                        .update(
                          JSON.stringify({
                            runner: "SessionRunnerLLM",
                            sessionID: session.id,
                            agentID: agent.id,
                            providerID: model.provider,
                            modelID: model.id,
                            modelVariant: session.model?.variant ?? null,
                            agentPermissions: agent.info?.permissions ?? [],
                            permissionPolicyDigest: policySnapshotDigest,
                            toolDefinitions: materialization.definitions,
                          }),
                        )
                        .digest("hex")}`,
                      calls: localToolCalls.map((call, index) => ({
                        callID: call.id,
                        capabilityID: capabilities[index]!.id,
                        arguments: call.input,
                      })),
                    })
                    .pipe(
                      Effect.catch((error) => {
                        const reason =
                          error instanceof SessionSupervisorError
                            ? [error.hostCode, error.reason].filter(Boolean).join(": ")
                            : "Rust Guard is unavailable"
                        return Effect.succeed({
                          status: "denied" as const,
                          reason: reason.slice(0, 512),
                        })
                      }),
                    )
                  if (admission.status === "prepared") {
                    if (
                      localToolCalls.length !== 1 ||
                      capabilities[0]?.id !== "files.write" ||
                      !admission.lease.effectID ||
                      !/^blake3:[0-9a-f]{64}$/.test(admission.lease.capabilityLeaseDigest)
                    ) {
                      admission = { status: "denied", reason: "Rust Guard returned an invalid prepared lease" }
                    } else {
                      leasesByCallID.set(localToolCalls[0]!.id, admission.lease)
                    }
                  } else if (admission.status === "prepared_batch") {
                    const expected = new Map<string, string>()
                    for (const [index, call] of localToolCalls.entries()) {
                      if (expected.has(call.id)) continue
                      expected.set(call.id, capabilities[index]!.id)
                    }
                    const seenCalls = new Set<string>()
                    const seenEffects = new Set<string>()
                    let validBatch =
                      localToolCalls.length >= 2 &&
                      expected.size === localToolCalls.length &&
                      capabilities.every((capability) => capability.effectClass === "effect") &&
                      admission.calls.length === localToolCalls.length
                    const serialAttempt = Boolean(admission.leaseNext)
                    if (serialAttempt && !admission.directAttempt && !admission.managedAttempt) validBatch = false
                    for (const member of admission.calls) {
                      const callIndex = localToolCalls.findIndex((item) => item.id === member.callID)
                      const hasLease = Boolean(member.lease)
                      if (
                        !expected.has(member.callID) ||
                        expected.get(member.callID) !== member.capabilityID ||
                        seenCalls.has(member.callID) ||
                        (!hasLease && (!serialAttempt || callIndex === 0)) ||
                        (hasLease && (!member.lease!.effectID ||
                          seenEffects.has(member.lease!.effectID) ||
                          !/^blake3:[0-9a-f]{64}$/.test(member.lease!.capabilityLeaseDigest)))
                      ) {
                        validBatch = false
                        continue
                      }
                      seenCalls.add(member.callID)
                      if (member.lease) {
                        seenEffects.add(member.lease.effectID)
                        leasesByCallID.set(member.callID, member.lease)
                      }
                    }
                    if (!validBatch || seenCalls.size !== expected.size ||
                      (serialAttempt && leasesByCallID.size !== 1) ||
                      (!serialAttempt && leasesByCallID.size !== expected.size)) {
                      leasesByCallID.clear()
                      admission = { status: "denied", reason: "Rust Guard returned a mismatched prepared ToolBatch" }
                    }
                  } else if (admission.status !== "denied") {
                    admission = { status: "denied", reason: "Rust Guard returned no prepared lease" }
                  }
                }
              }
              let previousEffectID: string | undefined
              for (const [index, call] of localToolCalls.entries()) {
                const validationError = validation[index]
                if (invalid) {
                  yield* publish(
                    LLMEvent.toolResult({
                      id: call.id,
                      name: call.name,
                      result: {
                        type: "error",
                        value: validationError ?? "Tool batch rejected because another call failed validation",
                      },
                    }),
                  )
                  continue
                }
                if (admission?.status === "denied") {
                  yield* publish(
                    LLMEvent.toolResult({
                      id: call.id,
                      name: call.name,
                      result: { type: "error", value: admission.reason },
                    }),
                  )
                  continue
                }
                const assistantMessageID = yield* publisher.assistantMessageID(call.id)
                let effect = leasesByCallID.get(call.id)
                if (!effect && admission?.status === "prepared_batch" && admission.leaseNext) {
                  if (!previousEffectID) {
                    yield* Effect.fail(new Error("Attempt ToolBatch has no prior settled effect for next lease"))
                  }
                  const next = yield* admission.leaseNext({ callID: call.id, previousEffectID })
                  if (next.callID !== call.id || !next.lease?.effectID) {
                    yield* Effect.fail(new Error("Rust Guard returned an out-of-order Attempt lease"))
                  }
                  effect = next.lease
                }
                const settlementEffect = Effect.uninterruptibleMask((restore) =>
                  restore(
                    materialization.settle({
                      sessionID: session.id,
                      agent: agent.id,
                      assistantMessageID,
                      call,
                      trustedPrincipal,
                      ...(effect ? { effect } : {}),
                    }),
                  ).pipe(
                    Effect.flatMap((settlement) =>
                      publish(
                        LLMEvent.toolResult({
                          id: call.id,
                          name: call.name,
                          result: settlement.result,
                          output: settlement.output,
                        }),
                        settlement.outputPaths ?? [],
                      ),
                    ),
                  ),
                )
                if (admission?.status === "prepared_batch" && admission.leaseNext) {
                  yield* settlementEffect
                  previousEffectID = effect?.effectID
                } else {
                  yield* settlementEffect.pipe(FiberSet.run(toolFibers))
                }
              }
            }
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a complete tool batch"))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          const userDeclined = settled._tag === "Failure" && isUserDeclined(settled.cause)
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) ||
            userDeclined
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (userDeclined) return yield* Effect.interrupt
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const assistantMessageID = yield* publisher.startAssistant()
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID,
                finish: stepSettlement.finish,
                usageProvenance: {
                  providerID: ProviderV2.ID.make(model.provider),
                  modelID: ModelV2.ID.make(model.id),
                  operationID: assistantMessageID,
                  cost: { status: "unknown" },
                  tokens: stepSettlement.tokens,
                },
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      compaction: ReturnType<typeof SessionCompaction.make>,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError, TrustedPrincipalContext>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, compaction) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, compaction)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, compaction) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, compaction)
            return yield* runTurn(sessionID, undefined, defect.transition.step, compaction)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        const compaction = yield* makeTurnCompaction()
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step, compaction)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    PermissionV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    SessionSupervisor.node,
  ],
})
