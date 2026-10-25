import { createHash, randomUUID } from "node:crypto"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolFailure,
  isContextOverflowFailure,
  type ToolCall,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import type { DirectProviderJournalBindingV1 } from "@opencode-ai/llm/route"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import {
  contextCompilePolicyDigestV1,
  decideContextCompileOverlapV1,
  resolveContextCompilePolicyV1,
  resolveContextSpeedPlanV1,
  type ContextCompileOverlapDecisionV1,
  type ContextSpeedPlanV1,
} from "../context-compile-policy"
import { PrefixCacheSupportV1 as PrefixCacheSupportSchema, type ContextCompilePolicyV1 } from "@opencode-ai/schema/context-compile-policy-v1"
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
import { SessionMessage } from "../message"
import { SessionStore } from "../store"
import * as ContextSelection from "../context-selection"
import { compileContextLedgerV2 } from "../context-ledger"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { SessionSupervisor, SessionSupervisorError } from "../../session/supervisor"
import {
  DirectReadBatch,
  type DirectReadHostV1,
  type DirectReadProjectionV1,
  type DirectReadSettledResultV1,
  type DirectReadWaveOutcomeV1,
} from "../direct-read-batch"
import { Pty } from "../../pty"
import { TrustedPrincipalContext } from "../../trusted-principal"
import type { EffectAdmission, EffectLease } from "../../session/supervisor"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { builtinHarnessProfileV1 } from "../../harness-profile"

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

/** §30.28 SP-B/C/D plan for a direct turn; cold index never blocks Send. */
export function directContextSpeedPlanV1(input: {
  readonly modelContextLimit?: number
  readonly nativeTools: boolean
}): ContextSpeedPlanV1 {
  const limit = input.modelContextLimit
  const contextLimitTokens =
    limit !== undefined && Number.isSafeInteger(limit) && limit > 0 && limit <= 100_000_000 ? limit : undefined
  return resolveContextSpeedPlanV1({
    // Honest cold state: no authenticated RepoIntel index-status producer is
    // bound to the direct lane. Never infer "current" from a cached file.
    indexStatus: "absent",
    ...(contextLimitTokens === undefined ? {} : { contextLimitTokens }),
    nativeTools: input.nativeTools,
  })
}

/** §30.28 SP-A compile-overlap decision at the immutable-ledger boundary. */
export function directContextCompileOverlapV1(input: {
  readonly previous?: { readonly ledgerDigest: string; readonly compilePolicyDigest?: string }
  readonly current: { readonly ledgerDigest: string; readonly compilePolicyDigest?: string }
}): ContextCompileOverlapDecisionV1 {
  return decideContextCompileOverlapV1(input)
}

/**
 * §14.3.1 / `DEC-V1-36` read fast path, wired at the runner's tool-batch
 * decision. One authenticated `effects.v2/prepare_tool_batch_read` admission
 * covers a read-class wave of 1..8 `files.read` calls, and the envelope
 * `requestID minted here is carried in `options.requestID` so every
 * projection row matches it exactly (P1's read-path-only envelope binding).
 *
 * Lane scope is deliberately narrow and encoded here rather than inferred by
 * callers: only an authenticated **direct** Session qualifies. Managed
 * Attempts, direct-Attempt lanes, child sessions and CodeMode waves return
 * `unavailable`, and the runner keeps the ordinary Guard admission path —
 * §14.3.1 keeps the managed lane "off by default" and DEC-V1-36 keeps managed
 * chains strict.
 */
export const directReadFastPathV1 = Effect.fn("SessionRunnerLLM.directReadFastPathV1")(function* (input: {
  readonly host: DirectReadHostV1
  readonly sessionID: string
  readonly locationRef: Parameters<DirectReadHostV1["registerHostLocation"]>[0]
  readonly lane: "direct_session" | "managed_attempt" | "direct_attempt"
  readonly codeMode: boolean
  readonly parentSessionID?: string
  readonly requestID?: string
  readonly calls: ReadonlyArray<{
    readonly callID: string
    readonly capabilityID: string
    readonly arguments: unknown
  }>
  /** Canonical execution of the admitted reads, in admitted order. */
  readonly execute: (
    projections: ReadonlyArray<DirectReadProjectionV1>,
  ) => Effect.Effect<ReadonlyArray<DirectReadSettledResultV1>, unknown>
}) {
  const outcome: DirectReadWaveOutcomeV1 = yield* DirectReadBatch.runWave({
    host: input.host,
    sessionID: input.sessionID,
    locationRef: input.locationRef,
    requestID: input.requestID ?? `req_${randomUUID().replaceAll("-", "")}`,
    lane: input.lane,
    codeMode: input.codeMode,
    ...(input.parentSessionID === undefined ? {} : { parentSessionID: input.parentSessionID }),
    calls: input.calls,
    execute: input.execute,
  }).pipe(
    // A failure that escapes the wave's own control flow never becomes a
    // partial success: whole-wave denial, receiptless and replay-forbidden.
    Effect.catch((error) =>
      Effect.succeed({
        status: "denied" as const,
        failure: {
          status: "failed" as const,
          phase: "result" as const,
          unknown: true,
          replay: "forbidden" as const,
          reason: `direct read wave execution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      } as DirectReadWaveOutcomeV1),
    ),
  )
  return outcome
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const permission = yield* PermissionV2.Service
    const supervisor = yield* SessionSupervisor.Service
    const pty = yield* Pty.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const agentProfiles = yield* Config.AgentProfileService
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

    /**
     * §30.28 SP-A..D planners at the direct compile boundary.
     *
     * `indexStatus: "absent"` is the honest contract state while no authenticated
     * RepoIntel index-status producer is bound to the direct lane: the plan may
     * bias tools (symbol-first) and prefer a small harness, but it must never
     * block Send or claim a warm index/cache.
     */
    const directCompileLedger = new Map<
      string,
      { readonly ledgerDigest: string; readonly compilePolicyDigest?: string }
    >()

    /** Compile one immutable, Core-owned request context before the transport can dispatch. */
    const prepareDirectProviderContext = Effect.fn("SessionRunner.prepareDirectProviderContext")(function* (input: {
      readonly session: SessionSchema.Info
      readonly requestID: string
      readonly sourceRevision: string
      readonly request: ReturnType<typeof LLM.request>
      readonly messages: readonly SessionMessage.Message[]
      readonly principal: import("../../trusted-principal").TrustedPrincipal
      readonly policyDigest: string
      readonly selectedRoute?: {
        readonly providerID: string
        readonly modelID: string
        readonly routeID: string
        readonly routeRevision: string
        readonly endpointRevision: string
        readonly endpointBase: string
        /**
         * Route prefix-cache capability. The producer is P6's ProviderTransport
         * projection; while it is absent the runner fails closed to `unknown`
         * (never `cache_anchor`), matching §30.26.4.
         */
        readonly prefixCacheSupport?: (typeof PrefixCacheSupportSchema)["Type"]
      }
      /** Supplied only by the authenticated HostKernel projection; never inferred from Core policy. */
      readonly authority?: {
        readonly permissionScopeDigest: string
      }
    }) {
      if (!input.authority || !input.selectedRoute ||
        input.selectedRoute.providerID !== input.request.model.provider ||
        input.selectedRoute.modelID !== input.request.model.id ||
        !input.selectedRoute.routeID || !input.selectedRoute.routeRevision || !input.selectedRoute.endpointRevision) return undefined
      const authority = input.authority
      const selectedRoute = input.selectedRoute
      const profile = yield* agentProfiles.primaryAgentProfile().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!profile || profile.model.providerId !== input.request.model.provider || profile.model.modelId !== input.request.model.id) return undefined
      const harness = builtinHarnessProfileV1(profile.harness)
      if (!harness) return undefined
      // §30.28 speed plan is resolved from the pinned model limit and this
      // turn's actual native tool definitions. It is advisory: the profile-
      // selected harness/model never changes here. A cold index must never
      // block Send (SP-C).
      const speedPlan = directContextSpeedPlanV1({
        modelContextLimit: input.request.model.defaults?.limits?.context,
        nativeTools: input.request.tools.length > 0,
      })
      if (speedPlan.sendBlocked !== false) return undefined
      yield* Effect.logDebug("direct context speed plan", {
        sessionID: input.session.id,
        indexMode: speedPlan.indexMode,
        indexWarming: speedPlan.indexWarming,
        harnessPreference: speedPlan.harnessPreference,
        selectedHarness: harness.harnessId,
        toolBias: speedPlan.toolBias,
      })
      // The durable generation is the last user message, or the compaction row
      // itself: toLLMMessages lowers a completed checkpoint to the exact
      // user-role `<conversation-checkpoint>` message this request carries.
      const generation = input.messages
        .filter((message) => message.type === "user" || message.type === "compaction")
        .at(-1)
      if (!generation || (generation.type !== "user" && generation.type !== "compaction")) return undefined

      const requestID = input.requestID
      const providerInput: ContextSelection.ProviderInputV1 = {
        system: input.request.system,
        messages: input.request.messages,
        tools: input.request.tools,
        ...(input.request.toolChoice === undefined ? {} : { toolChoice: input.request.toolChoice.type }),
        ...(input.request.generation?.maxTokens === undefined ? {} : { maxOutputTokens: input.request.generation.maxTokens }),
        ...(input.request.generation?.temperature === undefined ? {} : { temperature: input.request.generation.temperature }),
        ...(input.request.generation?.topP === undefined ? {} : { topP: input.request.generation.topP }),
        ...(input.request.generation?.topK === undefined ? {} : { topK: input.request.generation.topK }),
        ...(input.request.providerOptions === undefined ? {} : { providerOptions: input.request.providerOptions }),
      }
      let frozenContext: import("@opencode-ai/llm/route").DirectProviderRequestContextV1 | undefined
      let providerJournal: DirectProviderJournalBindingV1 | undefined
      let providerDispatchStarted = false
      const pin = (pinInput: { readonly endpointRevision: string; readonly transportRequestDigest: string }) =>
        Effect.gen(function* () {
          const context = frozenContext
          if (!context) return yield* Effect.die(new Error("Direct provider context was not frozen before transport admission"))
          if (pinInput.endpointRevision !== context.route.endpointRevision) {
            return yield* Effect.die(new Error("Direct provider endpoint differs from the trusted route projection"))
          }
          const normalizedInputDigest = context.contextSelection.sources.find(
            (source) => source.kind === "provider-input" && source.sourceID === context.requestID,
          )?.contentDigest
          if (!normalizedInputDigest) return yield* Effect.die(new Error("Direct ContextSelection lacks its exact provider-input digest"))
          const pinned = yield* store.pinProviderRequest({
            principal: input.principal,
            pins: {
              sessionID: context.sessionID as SessionSchema.ID,
              requestID: context.requestID,
              sourceRevision: context.sourceRevision,
              profileID: context.profile.profileID,
              profileRevision: context.profile.revision,
              profileDigest: context.profile.profileDigest,
              permissionScopeDigest: context.permissionScopeDigest,
              contextSelection: context.contextSelection,
              providerID: context.providerID,
              modelID: context.modelID,
              harnessID: context.harnessID,
              harnessRevision: context.harnessRevision,
              routeRevision: context.route.routeRevision,
              endpointRevision: pinInput.endpointRevision,
              policyDigest: input.policyDigest,
              normalizedInputDigest,
              transportRequestDigest: pinInput.transportRequestDigest,
            },
          })
          if (pinned.state !== "PINNED" || pinned.sessionID !== context.sessionID || pinned.requestID !== context.requestID ||
            pinned.transportRequestDigest !== pinInput.transportRequestDigest || pinned.endpointRevision !== pinInput.endpointRevision ||
            pinned.routeRevision !== context.route.routeRevision || pinned.providerID !== context.providerID ||
            pinned.modelID !== context.modelID || pinned.harnessID !== context.harnessID) {
            return yield* Effect.die(new Error("Direct provider journal returned a mismatched immutable pin"))
          }
          const binding = {
            sessionID: pinned.sessionID,
            requestID: pinned.requestID,
            state: "PINNED" as const,
            pinDigest: pinned.pinDigest,
            providerID: pinned.providerID,
            modelID: pinned.modelID,
            harnessID: pinned.harnessID,
            routeRevision: pinned.routeRevision,
            endpointRevision: pinned.endpointRevision,
            transportRequestDigest: pinned.transportRequestDigest,
            beginDispatch: () => store.markProviderDispatching({
              principal: input.principal,
              sessionID: context.sessionID as SessionSchema.ID,
              requestID: context.requestID,
              pinDigest: pinned.pinDigest,
            }).pipe(Effect.flatMap((row) => row.state === "DISPATCHING" && row.pinDigest === pinned.pinDigest
              ? Effect.sync(() => {
                  providerDispatchStarted = true
                  return { state: "DISPATCHING" as const, pinDigest: row.pinDigest, transportRequestDigest: row.transportRequestDigest }
                })
              : Effect.die(new Error("Direct provider dispatch compare-and-set did not bind the pinned request")))),
            markUnknown: (_reason: string) => store.markProviderRequestUnknown({
              principal: input.principal,
              sessionID: context.sessionID as SessionSchema.ID,
              requestID: context.requestID,
              pinDigest: pinned.pinDigest,
            }).pipe(Effect.asVoid),
          } satisfies DirectProviderJournalBindingV1
          providerJournal = binding
          return binding
        })
      const directContext = yield* Effect.try({
        try: () => ContextSelection.compileDirectProviderRequestContextV1({
          sessionID: input.session.id,
          requestID,
          mode: profile.context.isolation,
          agentProfile: profile,
          sourceRevision: input.sourceRevision,
          messages: input.messages,
          providerInput,
          authority: {
            permissionScopeDigest: authority.permissionScopeDigest,
            policyDigest: input.policyDigest,
            providerID: input.request.model.provider,
            modelID: input.request.model.id,
            harnessID: harness.harnessId,
            harnessRevision: String(harness.revision),
            routeID: selectedRoute.routeID,
            routeRevision: selectedRoute.routeRevision,
            endpointRevision: selectedRoute.endpointRevision,
            endpointBase: selectedRoute.endpointBase,
          },
          pin,
        }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!directContext) return undefined
      frozenContext = directContext
      const selection = directContext.contextSelection

      const canonical = ContextSelection.canonicalProviderInputJson(providerInput)
      const entries = selection.sources.map((source) => {
        const message = source.kind === "session-message" ? input.messages.find((item) => item.id === source.sourceID) : undefined
        const kind = source.kind === "session-message"
          ? message?.type === "user" ? "user" as const : message?.type === "system" ? "system" as const : "assistant" as const
          : source.kind === "agent-profile" ? "system" as const : "environment" as const
        const bytes = source.kind === "session-message" && message
          ? ContextSelection.sessionMessageSourceBytesV1(message)
          : source.kind === "agent-profile"
            ? ContextSelection.agentProfileSourceBytesV1(profile)
            : undefined
        const bytesKind = bytes === undefined ? "unknown" as const : "exact" as const
        return {
          entryID: `${source.kind}:${source.sourceID}`,
          kind,
          sourceRef: `${source.kind}:${source.sourceID}`,
          sourceRevision: source.sourceRevision,
          trust: source.trust,
          ...(bytes === undefined ? {} : { bytes }),
          bytesKind,
          tokens: { kind: "unknown" as const },
          included: true,
          inclusionReason: source.inclusionReason,
          protected: source.kind === "agent-profile",
          cacheClass: source.kind === "agent-profile" ? "static" as const : source.kind === "provider-input" ? "turn" as const : "history" as const,
          digest: source.contentDigest.startsWith("blake3:")
            ? source.contentDigest
            : `blake3:${bytesToHex(blake3(new TextEncoder().encode(`${source.kind}:${source.contentDigest}`)))}`,
        }
      })
      // §30.26 catalog provenance is *advisory*: it may refine a cache tier but
      // can never authorize, block, or delay a direct turn. No authenticated
      // catalog producer is bound to the pinned route yet, so the runner pins
      // the contract's fail-closed provenance (`unavailable`/`unknown`) instead
      // of reading a developer-global cache on the provider hot path. With that
      // provenance `catalog_hint` is ineligible, so the effective tier stays
      // `minimize_tokens` until a real producer lands.
      const catalogSnapshot = {
        source: "unavailable" as const,
        freshness: "unknown" as const,
      }
      let compilePolicy: ContextCompilePolicyV1 | undefined
      try {
        compilePolicy = resolveContextCompilePolicyV1({
          route: {
            providerID: selectedRoute.providerID,
            modelID: selectedRoute.modelID,
            routeRevision: selectedRoute.routeRevision,
            endpointRevision: selectedRoute.endpointRevision,
          },
          // P6's route capability producer has not landed: stay `unknown`
          // (never infer `cache_anchor` support from the catalog).
          prefixCacheSupport: selectedRoute.prefixCacheSupport ?? "unknown",
          catalogSnapshot: { source: catalogSnapshot.source, freshness: catalogSnapshot.freshness },
        })
      } catch {
        // Fail closed exactly like the other prerequisite gates: an unresolvable
        // policy blocks this direct turn instead of downgrading silently.
        return undefined
      }
      const projection = yield* Effect.try({
        try: () => compileContextLedgerV2({
          lane: "direct",
          sessionID: input.session.id,
          requestID,
          sourceRevision: input.sourceRevision,
          providerID: input.request.model.provider,
          modelID: input.request.model.id,
          harnessID: harness.harnessId,
          harnessRevision: harness.revision,
          requestPayloadDigest: `blake3:${bytesToHex(blake3(Buffer.from(canonical, "utf8")))}`,
          requestBytes: Buffer.byteLength(canonical, "utf8"),
          contextSelection: selection,
          entries,
          ...(compilePolicy === undefined ? {} : { compilePolicy }),
        }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (projection) {
        const compilePolicyDigest = compilePolicy === undefined
          ? undefined
          : contextCompilePolicyDigestV1(compilePolicy)
        const currentCompile = {
          ledgerDigest: projection.ledgerDigest,
          ...(compilePolicyDigest === undefined ? {} : { compilePolicyDigest }),
        }
        const previousCompile = directCompileLedger.get(input.session.id)
        const overlap = directContextCompileOverlapV1({
          ...(previousCompile === undefined ? {} : { previous: previousCompile }),
          current: currentCompile,
        })
        directCompileLedger.delete(input.session.id)
        directCompileLedger.set(input.session.id, currentCompile)
        if (directCompileLedger.size > 256) {
          const oldest = directCompileLedger.keys().next().value
          if (oldest !== undefined) directCompileLedger.delete(oldest)
        }
        yield* Effect.logDebug("direct context compile overlap", {
          sessionID: input.session.id,
          overlap: overlap.overlap,
          reason: overlap.reason,
          maxOverlapMs: overlap.maxOverlapMs,
        })
        const timestamp = yield* DateTime.now
        const event = {
          timestamp,
          sessionID: input.session.id,
          requestID,
          sourceRevision: input.sourceRevision,
          sourceGeneration: generation.id,
          ledger: projection.ledger,
          ledgerDigest: projection.ledgerDigest,
        } satisfies SessionEvent.ContextLedger["data"]
        // §30.28 SP-A: only an exactly unchanged ledger + policy may reuse the
        // already-published projection and let provider start proceed against
        // it. Any drift publishes the freshly compiled ledger before transport;
        // a stale payload is never dispatched.
        if (!overlap.overlap && Buffer.byteLength(JSON.stringify(event), "utf8") <= 48 * 1024) {
          // Attempt delivery before the provider stream starts so the context
          // projection is ordered ahead of this request's streamed response.
          // It is a best-effort UI event: publication failure never authorizes
          // or blocks the provider request.
          yield* events.publish(SessionEvent.ContextLedger, event, { location: input.session.location })
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      return {
        directContext,
        profile,
        harness,
        providerJournal: () => providerJournal,
        providerDispatchStarted: () => providerDispatchStarted,
      }
    })

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
      // The direct-provider route must come from the trusted catalog selection.
      // Do not infer routing from the model request or the SDK's normalized route.
      const selectedModel = models.resolveSelection
        ? yield* models.resolveSelection(session)
        : undefined
      if (!selectedModel?.directProviderRoute) {
        return yield* Effect.fail(new Error("Direct provider route is unavailable for the selected model"))
      }
      const model = selectedModel.model
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      // `LLMRequest.id` survives prepare/stream and is consumed by P6's
      // protected RequestExecutor journal seam. The same ID binds the
      // ContextSelection and subsequent PINNED/DISPATCHING/SETTLED lifecycle.
      const providerRequestID = `req_${randomUUID().replaceAll("-", "")}`
      const request = LLM.request({
        id: providerRequestID,
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
      const contextSourceRevision = yield* EventV2.latestSequence(db, session.id)
        .pipe(Effect.map((sequence) => Math.max(0, sequence).toString()))
      const providerPermissionScope = yield* supervisor.directProviderPermissionScope({
        sessionID: session.id,
        locationRef: session.location,
      }).pipe(Effect.map((scope) => ({
        permissionScopeDigest: scope.permissionScopeDigest,
        policyDigest: scope.policyDigest,
      })), Effect.catch(() => Effect.succeed(undefined)))
      const directProviderContext = yield* prepareDirectProviderContext({
        session,
        requestID: providerRequestID,
        sourceRevision: contextSourceRevision,
        request,
        messages: context,
        principal: trustedPrincipal,
        policyDigest: policySnapshotDigest,
        selectedRoute: {
          providerID: selectedModel.directProviderRoute.providerID,
          modelID: selectedModel.directProviderRoute.modelID,
          routeID: selectedModel.directProviderRoute.routeID,
          routeRevision: selectedModel.directProviderRoute.routeRevision,
          endpointRevision: selectedModel.directProviderRoute.endpointRevision,
          endpointBase: selectedModel.directProviderRoute.endpointBase,
        },
        ...(providerPermissionScope ? {
          authority: {
            permissionScopeDigest: providerPermissionScope.permissionScopeDigest,
          },
        } : {}),
      })
      if (!directProviderContext) {
        return yield* Effect.fail(new Error("Direct provider request lacks authenticated permission scope, selected-route, AgentProfileV2, or ContextSelection pins"))
      }
      const requestExecutorContext = {
        requestID: providerRequestID,
        directContext: directProviderContext.directContext,
      } as const
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
      // The only valid nested CodeMode path is the HostKernel-owned lifecycle
      // that starts/binds the helper, admits the complete wave, settles each
      // ordinary ToolBatch call, and returns authenticated per-call receipts.
      // The typed supervisor DTOs exist, but P2's Rust HostKernel lifecycle,
      // authenticated wave receipt handlers, and integrated acceptance are
      // incomplete. Do not substitute a plain prepareToolBatch call here:
      // without the CodeMode execution/wave binding it cannot supply the exact
      // receipt projection required by §§12.21/37.24. Keep this fail-closed.
      const dispatchPreparedToolBatch = toolMaterialization
        ? Effect.fn("SessionRunner.dispatchPreparedToolBatch")(function* (_input: {
            readonly calls: ReadonlyArray<{
              readonly callID: string
              readonly toolName: string
              readonly capabilityID: string
              readonly arguments: Readonly<Record<string, unknown>>
            }>
          }) {
            return yield* Effect.fail(new ToolFailure({
              message: "CodeMode nested dispatch is unavailable until HostKernel owns the execution and receipt lifecycle",
            }))
          })
        : undefined
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request, requestExecutorContext).pipe(
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
              const normalizedCallsByCallID = new Map<string, import("../../session/supervisor").GuardedToolCall>()
              const workspaceCommandProfilesByCallID = new Map<string, import("../../pty").WorkspaceCommandProfileBindingV1>()
              // §14.3.1 / DEC-V1-36 read fast path: a read-class wave in an
              // authenticated direct Session is admitted once for the whole
              // wave and published only after the workspace fence. Anything
              // else (mixed/effect/unknown, managed Attempt, child session,
              // CodeMode) leaves `readWave` unavailable and keeps today's
              // ordinary Guard admission path unchanged.
              let readWave: DirectReadWaveOutcomeV1 | undefined
              const readWavePublish: Array<ReturnType<typeof publish>> = []
              if (!invalid) {
                const capabilities = localToolCalls.map((call) => materialization.classify(call))
                const guarded = capabilities.some(
                  (capability) => capability.effectClass === "effect" || capability.effectClass === "unknown",
                )
                if (guarded) {
                  const prepared = yield* pty
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
                          admission: { status: "denied" as const, reason: reason.slice(0, 512) },
                          calls: [],
                          workspaceCommandProfiles: [],
                        })
                      }),
                    )
                  admission = prepared.admission
                  for (const call of prepared.calls) normalizedCallsByCallID.set(call.callID, call)
                  for (const binding of prepared.workspaceCommandProfiles)
                    workspaceCommandProfilesByCallID.set(binding.callID, binding)
                  if (admission.status === "prepared") {
                    if (
                      localToolCalls.length !== 1 ||
                      (capabilities[0]?.id !== "files.write" && capabilities[0]?.id !== "terminal.run") ||
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
                } else {
                  readWave = yield* directReadFastPathV1({
                    host: supervisor,
                    sessionID: session.id,
                    locationRef: session.location,
                    // Managed Attempt sessions are created as children of the
                    // managed root (they carry `parentID`), so the child-lane
                    // rule refuses them here; a root Session with no parent is
                    // the only shape that can reach this path. §14.3.1 keeps the
                    // managed lane off by default and DEC-V1-36 keeps those
                    // chains strict — both are encoded in the classifier, and
                    // `lane` stays the explicit hook for a caller that holds
                    // lane authority to refuse outright.
                    lane: "direct_session",
                    codeMode: false,
                    ...(session.parentID === undefined ? {} : { parentSessionID: session.parentID }),
                    calls: localToolCalls.map((call, index) => ({
                      callID: call.id,
                      capabilityID: capabilities[index]!.id,
                      arguments: call.input,
                    })),
                    execute: (projections) =>
                      Effect.gen(function* () {
                        const settled: DirectReadSettledResultV1[] = []
                        for (const projection of projections) {
                          const admitted = localToolCalls.find((item) => item.id === projection.callID)
                          if (!admitted)
                            return yield* Effect.die(
                              new Error("Admitted direct read call is absent from the provider batch"),
                            )
                          const assistantMessageID = yield* publisher.assistantMessageID(admitted.id)
                          const settlement = yield* materialization.settle({
                            sessionID: session.id,
                            agent: agent.id,
                            assistantMessageID,
                            call: admitted,
                            trustedPrincipal,
                            locationRef: session.location,
                          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
                          const encoded = settlement?.result as { readonly value?: unknown } | undefined
                          const output =
                            encoded !== undefined && typeof encoded.value === "string" ? encoded.value : undefined
                          if (settlement === undefined || output === undefined) {
                            // No bounded text to fence ⇒ this member does not
                            // settle, and the publication gate denies the wave.
                            settled.push({ callID: projection.callID, status: "rejected" })
                            continue
                          }
                          // Publication is deferred until the authenticated
                          // workspace fence passes; `runWave` gates it.
                          readWavePublish.push(
                            publish(
                              LLMEvent.toolResult({
                                id: admitted.id,
                                name: admitted.name,
                                result: settlement.result,
                                output: settlement.output,
                              }),
                            ),
                          )
                          settled.push({
                            callID: projection.callID,
                            status: "settled",
                            output,
                          })
                        }
                        return settled
                      }),
                  })
                }
              }
              // Whole-wave publication: the fence already passed (published) or
              // the wave is denied outright — in both cases every call is
              // handled once, here, and the ordinary per-call path is skipped.
              if (readWave?.status === "published") {
                for (const publishEffect of readWavePublish) yield* publishEffect
              } else if (readWave?.status === "denied") {
                for (const call of localToolCalls) {
                  yield* publish(
                    LLMEvent.toolResult({
                      id: call.id,
                      name: call.name,
                      result: { type: "error", value: readWave.failure.reason },
                    }),
                  )
                }
              }
              let previousEffectID: string | undefined
              for (const [index, call] of localToolCalls.entries()) {
                if (readWave !== undefined && readWave.status !== "unavailable") continue
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
                    return yield* Effect.fail(new Error("Attempt ToolBatch has no prior settled effect for next lease"))
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
                      ...(dispatchPreparedToolBatch ? { dispatchPreparedToolBatch } : {}),
                      ...(normalizedCallsByCallID.get(call.id) ? { guardedCall: normalizedCallsByCallID.get(call.id)! } : {}),
                      ...(workspaceCommandProfilesByCallID.get(call.id) ? { workspaceCommandProfile: workspaceCommandProfilesByCallID.get(call.id)! } : {}),
                      locationRef: session.location,
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
            const usageProvenance = {
              providerID: ProviderV2.ID.make(model.provider),
              modelID: ModelV2.ID.make(model.id),
              operationID: assistantMessageID,
              requestID: providerRequestID,
              cost: { status: "unknown" as const },
              tokens: stepSettlement.tokens,
            }
            const journal = directProviderContext.providerJournal()
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID,
                finish: stepSettlement.finish,
                usageProvenance,
                snapshot: endSnapshot,
                files,
              }, {
                // EventV2 commits the assistant projection first, then settles
                // the provider journal in the same database transaction. A
                // lost/ambiguous dispatch cannot be made successful by a later
                // best-effort usage event.
                commit: () => {
                  if (!journal || !directProviderContext.providerDispatchStarted()) {
                    return Effect.die(new Error("Provider result has no exact durable DISPATCHING journal binding"))
                  }
                  return store.settleProviderRequest({
                    principal: trustedPrincipal,
                    sessionID: session.id,
                    requestID: providerRequestID,
                    pinDigest: journal.pinDigest,
                    assistantMessageID,
                    usage: usageProvenance,
                  }).pipe(Effect.asVoid)
                },
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

    // UNKNOWN model outcomes are reported once per process/session. The
    // unresolved request is never replayed; a later explicit prompt creates a
    // fresh request ID and follows the normal selected-route admission path.
    const surfacedUnknownProviderSessions = new Set<string>()
    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      const principal = (yield* TrustedPrincipalContext).principal
      const providerRequests = yield* store.recoverProviderRequests({
        principal,
        sessionID: input.sessionID,
      })
      const unknownRequests = providerRequests.filter((request) => request.state === "UNKNOWN")
      if (unknownRequests.length > 0 && !surfacedUnknownProviderSessions.has(input.sessionID)) {
        surfacedUnknownProviderSessions.add(input.sessionID)
        const requestIDs = unknownRequests.map((request) => request.requestID).slice(0, 8).join(", ")
        return yield* Effect.fail(new Error(
          `A previous provider request has an UNKNOWN outcome (${requestIDs}). HorizonCode will not replay it; submit an explicit new continuation to start a fresh request.`,
        ))
      }
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
    Config.agentProfileNode,
    Snapshot.node,
    Database.node,
    SessionSupervisor.node,
    Pty.node,
  ],
})
