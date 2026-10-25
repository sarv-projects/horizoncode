import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import type { ManagedRootSessionLinkProjectionV1 } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { ManagedControl, ManagedControlError } from "@/session/managed-control"

// Finalization stays unavailable until the integrated P1/P2/P8 evidence gate is accepted.
const MANAGED_VERIFICATION_ENABLED = false
import { executeNextManagedTask } from "@/session/managed-run-coordinator"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceHttpApi } from "../api"
import {
  ApiGoalReviewConflictError,
  ApiGoalReviewError,
  ApiGoalReviewForbiddenError,
  ApiGoalReviewNotFoundError,
  ApiGoalReviewUnavailableError,
  GoalReviewDecisionInput,
  GoalReviewInboxQuery,
  GoalReviewQuery,
  GoalRunControlInputV1,
  GoalRunStartInputV1,
  GoalProposalDraftV1,
  GoalRunPlanInputV1,
  GoalVerificationInputV1,
} from "../groups/control-plane"

export const goalReviewHandlers = HttpApiBuilder.group(InstanceHttpApi, "goalReview", (handlers) =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const sessions = yield* Session.Service

    const currentScope = Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      return workspaceID
        ? { projectRef: instance.project.id, workspaceRef: workspaceID }
        : undefined
    })

    /** Project managed verification execution statuses onto the route's wire union. */
    const verificationWireStatus = (
      status: string,
    ):
      | "ABORTED"
      | "CANCELLED"
      | "CANCELLING"
      | "FAILED"
      | "NEEDS_YOU"
      | "SUCCEEDED"
      | "UNKNOWN"
      | "VERIFYING"
      | undefined => {
      const table: Record<string, "ABORTED" | "CANCELLED" | "CANCELLING" | "FAILED" | "NEEDS_YOU" | "SUCCEEDED" | "UNKNOWN" | "VERIFYING"> = {
        ABORTED: "ABORTED",
        CANCELLED: "CANCELLED",
        CANCELLING: "CANCELLING",
        FAILED: "FAILED",
        NEEDS_YOU: "NEEDS_YOU",
        SUCCEEDED: "SUCCEEDED",
        UNKNOWN: "UNKNOWN",
        VERIFYING: "VERIFYING",
        // In-progress settlement is reported as verifying on this route.
        SETTLING: "VERIFYING",
      }
      for (const [key, value] of Object.entries(table)) {
        if (key === status) return value
      }
      return undefined
    }

    // The public control-plane schema admits only the fixed usage-status
    // vocabulary and the five canonical metric keys. ManagedControl keeps its
    // HostKernel projections loose (string) because Rust owns the vocabulary;
    // the HTTP boundary is where that projection must be proven wire-safe.
    type UsageStatusWire = "provider-reported" | "measured" | "estimated" | "unknown" | "mixed"
    type UsageRemainderWire = "KNOWN" | "ESTIMATED" | "UNKNOWN"
    type UsageAccountingWire = {
      readonly accountingCursor: string
      readonly tokenKnownSubtotal: string
      readonly costKnownSubtotalMicros: string
      readonly tokenRemainderStatus: UsageRemainderWire
      readonly costRemainderStatus: UsageRemainderWire
      readonly usageState: UsageRemainderWire
      readonly stopReason: "NONE" | "TOKEN_CEILING" | "COST_CEILING" | "USAGE_UNCERTAIN"
      readonly ceilingDigest: string
      readonly costStatus: UsageStatusWire
      readonly metricStatuses: Readonly<Record<"input" | "output" | "reasoning" | "cache.read" | "cache.write", UsageStatusWire>>
      readonly receiptCount: string
      readonly receiptChainDigest: string
    }
    const usageStatusWire = (value: string): UsageStatusWire | undefined => {
      switch (value) {
        case "provider-reported":
        case "measured":
        case "estimated":
        case "unknown":
        case "mixed":
          return value
        default:
          return undefined
      }
    }
    const usageRemainderWire = (value: string): UsageRemainderWire | undefined => {
      switch (value) {
        case "KNOWN":
        case "ESTIMATED":
        case "UNKNOWN":
          return value
        default:
          return undefined
      }
    }
    const canonicalDecimal = (value: string) => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
    const blake3Digest = (value: string) => /^blake3:[0-9a-f]{64}$/.test(value)
    type VerificationUsageAccounting = {
      readonly accountingCursor: string
      readonly tokenKnownSubtotal: string
      readonly costKnownSubtotalMicros: string
      readonly tokenRemainderStatus: string
      readonly costRemainderStatus: string
      readonly usageState: string
      readonly stopReason: string
      readonly ceilingDigest: string
      readonly costStatus: string
      readonly metricStatuses: Readonly<Record<string, string>>
      readonly receiptCount: string
      readonly receiptChainDigest: string
    }
    const verificationUsageAccountingWire = (
      value: VerificationUsageAccounting,
    ): UsageAccountingWire | undefined => {
      const tokenRemainderStatus = usageRemainderWire(value.tokenRemainderStatus)
      const costRemainderStatus = usageRemainderWire(value.costRemainderStatus)
      const usageState = usageRemainderWire(value.usageState)
      const costStatus = usageStatusWire(value.costStatus)
      const metricKeys = ["input", "output", "reasoning", "cache.read", "cache.write"] as const
      if (Object.keys(value.metricStatuses).toSorted().join("\0") !== [...metricKeys].toSorted().join("\0")) return undefined
      const metrics = metricKeys.map((key) => usageStatusWire(value.metricStatuses[key] ?? ""))
      if (!tokenRemainderStatus || !costRemainderStatus || !usageState || !costStatus ||
        metrics.some((status) => status === undefined) ||
        (value.stopReason !== "NONE" && value.stopReason !== "TOKEN_CEILING" &&
          value.stopReason !== "COST_CEILING" && value.stopReason !== "USAGE_UNCERTAIN") ||
        !canonicalDecimal(value.accountingCursor) || !canonicalDecimal(value.tokenKnownSubtotal) ||
        !canonicalDecimal(value.costKnownSubtotalMicros) || !canonicalDecimal(value.receiptCount) ||
        !blake3Digest(value.ceilingDigest) || !blake3Digest(value.receiptChainDigest)) {
        return undefined
      }
      return {
        accountingCursor: value.accountingCursor,
        tokenKnownSubtotal: value.tokenKnownSubtotal,
        costKnownSubtotalMicros: value.costKnownSubtotalMicros,
        tokenRemainderStatus,
        costRemainderStatus,
        usageState,
        stopReason: value.stopReason,
        ceilingDigest: value.ceilingDigest,
        costStatus,
        metricStatuses: {
          input: metrics[0]!,
          output: metrics[1]!,
          reasoning: metrics[2]!,
          "cache.read": metrics[3]!,
          "cache.write": metrics[4]!,
        },
        receiptCount: value.receiptCount,
        receiptChainDigest: value.receiptChainDigest,
      }
    }

    const failure = (
      error: ManagedControlError,
    ):
      | ApiGoalReviewError
      | ApiGoalReviewNotFoundError
      | ApiGoalReviewConflictError
      | ApiGoalReviewForbiddenError
      | ApiGoalReviewUnavailableError => {
      const data = { code: error.code, reason: error.reason }
      if (error.code === "managed_not_found") {
        return new ApiGoalReviewNotFoundError({ name: "GoalReviewNotFoundError", data })
      }
      if (error.code === "managed_conflict" || error.code === "managed_goal_limit") {
        return new ApiGoalReviewConflictError({ name: "GoalReviewConflictError", data })
      }
      if (error.code === "independent_verifier_required") {
        return new ApiGoalReviewForbiddenError({ name: "GoalReviewForbiddenError", data })
      }
      if (error.code === "managed_unavailable" || error.code === "capability_unavailable") {
        return new ApiGoalReviewUnavailableError({ name: "GoalReviewUnavailableError", data })
      }
      return new ApiGoalReviewError({ name: "GoalReviewError", data })
    }

    const principal = Effect.gen(function* () {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (!Option.isSome(authenticated) || authenticated.value.principal.kind !== "server_auth") {
        return yield* Effect.fail(
          new ApiGoalReviewForbiddenError({
            name: "GoalReviewForbiddenError",
            data: {
              code: "independent_verifier_required",
              reason: "managed Goal review and planning require an authenticated ServerAuth principal",
            },
          }),
        )
      }
      return authenticated.value.principal
    })

    const goalReview = Effect.fn("GoalReviewHttpApi.goalReview")(function* (ctx: {
      query: typeof GoalReviewQuery.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "no current workspace is selected" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      const snapshot = yield* ManagedControl.goalReviewSnapshot(ctx.query.goalID, trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      if (snapshot.projectRef !== scope.projectRef || snapshot.workspaceRef !== scope.workspaceRef) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "Goal is outside the current project and workspace" },
          }),
        )
      }
      return snapshot
    })

    const goalReviews = Effect.fn("GoalReviewHttpApi.goalReviews")(function* (ctx: {
      query: typeof GoalReviewInboxQuery.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      const inbox = yield* ManagedControl.listPendingReviews(trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      const after = ctx.query.afterGoalID
      const scoped = inbox.goals
        .filter(
          (goal) =>
            goal.projectRef === scope.projectRef &&
            goal.workspaceRef === scope.workspaceRef &&
            (after === undefined || goal.goalID > after),
        )
        .sort((left, right) => left.goalID.localeCompare(right.goalID))
      const limit = ctx.query.limit ?? 32
      const goals = scoped.slice(0, limit)
      return {
        goals,
        nextAfterGoalID: scoped.length > limit ? goals.at(-1)?.goalID ?? null : null,
      }
    })

    const goalReviewDecision = Effect.fn("GoalReviewHttpApi.goalReviewDecision")(function* (ctx: {
      payload: typeof GoalReviewDecisionInput.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "no current workspace is selected" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      const snapshot = yield* ManagedControl.goalReviewSnapshot(ctx.payload.goalID, trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      if (snapshot.projectRef !== scope.projectRef || snapshot.workspaceRef !== scope.workspaceRef) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "Goal is outside the current project and workspace" },
          }),
        )
      }
      const proposal = snapshot.proposals.find(
        (item) => item.specVersionId === ctx.payload.specID && item.specDigest === ctx.payload.specDigest,
      )
      if (!proposal) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "pending SpecVersion proposal was not found" },
          }),
        )
      }
      if (!proposal.reviewAvailability.available) {
        return yield* Effect.fail(
          new ApiGoalReviewForbiddenError({
            name: "GoalReviewForbiddenError",
            data: { code: "independent_verifier_required", reason: proposal.reviewAvailability.reason },
          }),
        )
      }
      const decide = ctx.payload.decision === "accept" ? ManagedControl.acceptSpec : ManagedControl.rejectSpec
      return yield* decide({
        trustedPrincipal,
        goalID: ctx.payload.goalID,
        specID: ctx.payload.specID,
        specDigest: ctx.payload.specDigest,
        expectedRevision: ctx.payload.expectedRevision,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
    })

    const goalPropose = Effect.fn("GoalReviewHttpApi.goalPropose")(function* (ctx: {
      payload: typeof GoalProposalDraftV1.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
          }),
        )
      }
      if (Buffer.byteLength(JSON.stringify(ctx.payload), "utf8") > 32 * 1024) {
        return yield* Effect.fail(
          new ApiGoalReviewError({
            name: "GoalReviewError",
            data: { code: "managed_protocol", reason: "proposal draft exceeds the 32 KiB limit" },
          }),
        )
      }

      const goalID = `goal_${randomUUID()}`
      const specID = `spec_${randomUUID()}`
      const trustedPrincipal = yield* principal
      const proposal = yield* ManagedControl.createGoalProposal({
        trustedPrincipal,
        goalID,
        specID,
        objective: ctx.payload.objective,
        projectRef: scope.projectRef,
        workspaceRef: scope.workspaceRef,
        capabilityScope: ctx.payload.capabilityScope,
        scope: ctx.payload.scope,
        constraints: ctx.payload.constraints,
        criteria: ctx.payload.criteria,
        budget: {
          ...ctx.payload.budget,
          maxMemoryBytes: ctx.payload.budget.maxMemoryBytes ?? null,
          maxDiskBytes: ctx.payload.budget.maxDiskBytes ?? null,
          maxTokens: ctx.payload.budget.maxTokens ?? null,
          maxCostMicros: ctx.payload.budget.maxCostMicros ?? null,
        },
        sourceDigests: ctx.payload.sourceDigests,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      return {
        schemaVersion: 1 as const,
        goalID: proposal.goalID,
        specID: proposal.specID,
        specDigest: proposal.specDigest,
        proposedBy: proposal.proposedBy,
        accepted: false,
        revision: proposal.revision,
      }
    })

    const goalVerification = Effect.fn("GoalReviewHttpApi.goalVerification")(function* (ctx: {
      payload: typeof GoalVerificationInputV1.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      if (trustedPrincipal.kind !== "server_auth") {
        return yield* Effect.fail(
          new ApiGoalReviewForbiddenError({
            name: "GoalReviewForbiddenError",
            data: {
              code: "independent_verifier_required",
              reason: "Goal verification requires an authenticated reviewer",
            },
          }),
        )
      }
      if (!MANAGED_VERIFICATION_ENABLED) {
        return yield* Effect.fail(new ApiGoalReviewUnavailableError({
          name: "GoalReviewUnavailableError",
          data: { code: "managed_unavailable", reason: "independent verification and Run finalization remain disabled pending integrated Guard and settlement acceptance" },
        }))
      }
      const snapshot = yield* ManagedControl.goalReviewSnapshot(ctx.payload.goalID, trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      if (snapshot.projectRef !== scope.projectRef || snapshot.workspaceRef !== scope.workspaceRef) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "Goal is outside the current project and workspace" },
          }),
        )
      }
      const result = yield* ManagedControl.runVerification({
        goalID: ctx.payload.goalID,
        runID: ctx.payload.runID,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        // The principal is supplied only from the authenticated HTTP middleware projection.
        Effect.provideService(TrustedPrincipalContext, TrustedPrincipalContext.of({ principal: trustedPrincipal })),
        // Verification can surface a HostKernel/session supervisor failure next to
        // the managed-control failure; both become route-level Api errors here.
        Effect.mapError((error) =>
          error._tag === "SessionSupervisorError"
            ? new ApiGoalReviewUnavailableError({
                name: "GoalReviewUnavailableError",
                data: { code: error.hostCode ?? "managed_unavailable", reason: error.reason },
              })
            : failure(error)),
      )
      const status = verificationWireStatus(result.status)
      if (status === undefined) {
        return yield* Effect.fail(
          new ApiGoalReviewError({
            name: "GoalReviewError",
            data: {
              code: "managed_protocol",
              reason: `verification status "${String(result.status)}" is not representable on this route`,
            },
          }),
        )
      }
      const usageAccounting = "usageAccounting" in result ? result.usageAccounting : undefined
      const usageAccountingWire = usageAccounting === undefined
        ? undefined
        : verificationUsageAccountingWire(usageAccounting)
      if (usageAccounting !== undefined && usageAccountingWire === undefined) {
        return yield* Effect.fail(
          new ApiGoalReviewError({
            name: "GoalReviewError",
            data: {
              code: "managed_protocol",
              reason: "verification usage accounting is not representable on this route",
            },
          }),
        )
      }
      // The spread keeps the authenticated verifier projection, while status
      // and usageAccounting are replaced by their proven wire-safe forms.
      return {
        schemaVersion: 1 as const,
        ...result,
        status,
        usageAccounting: usageAccountingWire,
      }
    })

    const goalRunControl = Effect.fn("GoalReviewHttpApi.goalRunControl")(function* (ctx: {
      payload: typeof GoalRunControlInputV1.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      const snapshot = yield* ManagedControl.goalReviewSnapshot(ctx.payload.goalID, trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      if (snapshot.projectRef !== scope.projectRef || snapshot.workspaceRef !== scope.workspaceRef) {
        return yield* Effect.fail(
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "Goal is outside the current project and workspace" },
          }),
        )
      }
      if (snapshot.goalRevision !== ctx.payload.expectedRevision) {
        return yield* Effect.fail(
          new ApiGoalReviewConflictError({
            name: "GoalReviewConflictError",
            data: {
              code: "managed_conflict",
              reason: `Goal changed after the Run control view was read (expected ${ctx.payload.expectedRevision}, current ${snapshot.goalRevision})`,
            },
          }),
        )
      }
      const runControl = {
        trustedPrincipal,
        goalID: ctx.payload.goalID,
        runID: ctx.payload.runID,
        expectedRevision: ctx.payload.expectedRevision,
      }
      const result = yield* (ctx.payload.action === "pause"
        ? ManagedControl.pauseRun(runControl)
        : ctx.payload.action === "resume"
          ? ManagedControl.resumeRun(runControl)
          : ManagedControl.cancelRun(runControl)).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      // Persist the Rust cancellation fence first, then interrupt only the exact
      // Core child Session that Rust still identifies as this Run's live Attempt.
      // The child prompt's normal interruption path lets Guard/ExecutionHost
      // settle or retain any dispatched effect as UNKNOWN; a UI cancel alone is
      // never treated as proof that an external process/effect stopped.
      if (ctx.payload.action === "cancel" && result.status === "CANCELLING") {
        const run = snapshot.runs.find((candidate) => candidate.runID === ctx.payload.runID)
        const pinned = run?.sessionLink
        if (!pinned || pinned.sessionID.length === 0) {
          return yield* Effect.fail(new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "managed_recovery_unavailable", reason: "cancellation is durable but its pinned root Session is unavailable for child interruption" },
          }))
        }
        const rootSession = yield* sessions.get(SessionID.make(pinned.sessionID)).pipe(
          Effect.mapError(() => new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "managed_recovery_unavailable", reason: "cancellation is durable but the pinned root Session is unavailable" },
          })),
        )
        const rootBinding = rootSession.metadata?.horizonManagedRoot
        if (rootSession.parentID || typeof rootBinding !== "object" || rootBinding === null || Array.isArray(rootBinding) ||
          rootBinding.schemaVersion !== 1 || rootBinding.goalID !== ctx.payload.goalID || rootBinding.runID !== ctx.payload.runID) {
          return yield* Effect.fail(new ApiGoalReviewConflictError({
            name: "GoalReviewConflictError",
            data: { code: "managed_conflict", reason: "cancellation root Session no longer matches the pinned Goal and Run" },
          }))
        }
        const instance = yield* InstanceState.context
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
        const locationID = yield* supervisor.registerHostLocation(locationRef).pipe(
          Effect.provideService(TrustedPrincipalContext, TrustedPrincipalContext.of({ principal: trustedPrincipal })),
          Effect.mapError((error) => new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: error.hostCode ?? "managed_unavailable", reason: error.reason },
          })),
        )
        const active = yield* ManagedControl.activeAttemptRecovery({
          trustedPrincipal,
          goalID: ctx.payload.goalID,
          runID: ctx.payload.runID,
          locationID,
          sessionID: rootSession.id,
          expectedRevision: result.revision,
        }).pipe(
          Effect.provideService(SessionSupervisor.Service, supervisor),
          Effect.mapError(failure),
        )
        if (active.status === "ACTIVE_ATTEMPT" && active.attempt) {
          // This targets the Rust-pinned child Session only. The Run remains
          // CANCELLING until Rust reconciles Attempt/effect receipts.
          const runState = yield* Effect.serviceOption(SessionRunState.Service)
          if (Option.isSome(runState)) yield* runState.value.cancel(SessionID.make(active.attempt.sessionID))
        }
      }
      return { schemaVersion: 1 as const, ...result }
    })

    const goalRunPlan = Effect.fn("GoalReviewHttpApi.goalRunPlan")(function* (ctx: {
      payload: typeof GoalRunPlanInputV1.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
          }),
        )
      }
      if (Buffer.byteLength(JSON.stringify(ctx.payload), "utf8") > 32 * 1024) {
        return yield* Effect.fail(
          new ApiGoalReviewError({
            name: "GoalReviewError",
            data: { code: "managed_protocol", reason: "Run plan exceeds the 32 KiB limit" },
          }),
        )
      }
      const trustedPrincipal = yield* principal
      const result = yield* ManagedControl.createRunPlan({
        trustedPrincipal,
        goalID: ctx.payload.goalID,
        specID: ctx.payload.specID,
        specDigest: ctx.payload.specDigest,
        expectedGoalRevision: ctx.payload.expectedGoalRevision,
        runID: ctx.payload.runID,
        projectRef: scope.projectRef,
        workspaceRef: scope.workspaceRef,
        tasks: ctx.payload.tasks,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      return { schemaVersion: 1 as const, ...result }
    })

    const goalRunStart = Effect.fn("GoalReviewHttpApi.goalRunStart")(function* (ctx: {
      payload: typeof GoalRunStartInputV1.Type
    }) {
      const scope = yield* currentScope
      if (!scope) {
        return yield* Effect.fail(new ApiGoalReviewUnavailableError({
          name: "GoalReviewUnavailableError",
          data: { code: "workspace_unavailable", reason: "no current workspace is selected" },
        }))
      }
      const trustedPrincipal = yield* principal
      const snapshot = yield* ManagedControl.goalReviewSnapshot(ctx.payload.goalID, trustedPrincipal).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      const run = snapshot.runs.find((candidate) => candidate.runID === ctx.payload.runID)
      const acceptedSpec = snapshot.acceptedSpecs.find((candidate) => candidate.specID === ctx.payload.specID)
      if (!run || run.specID !== ctx.payload.specID || !acceptedSpec || acceptedSpec.specDigest !== ctx.payload.specDigest) {
        return yield* Effect.fail(new ApiGoalReviewConflictError({
          name: "GoalReviewConflictError",
          data: { code: "managed_conflict", reason: "goal.start must name the current Run and its exact accepted SpecVersion" },
        }))
      }
      if (run.runPhase !== "PLAN_ONLY" && run.runPhase !== "RUNNING") {
        return yield* Effect.fail(new ApiGoalReviewConflictError({
          name: "GoalReviewConflictError",
          data: { code: "managed_conflict", reason: "goal.start cannot replay a Run outside PLAN_ONLY or RUNNING" },
        }))
      }
      if (snapshot.projectRef !== scope.projectRef || snapshot.workspaceRef !== scope.workspaceRef) {
        return yield* Effect.fail(new ApiGoalReviewNotFoundError({
          name: "GoalReviewNotFoundError",
          data: { code: "managed_not_found", reason: "Goal is outside the current project and workspace" },
        }))
      }
      const rootSession = yield* sessions.get(ctx.payload.sessionID as SessionID).pipe(
        Effect.mapError(() =>
          new ApiGoalReviewNotFoundError({
            name: "GoalReviewNotFoundError",
            data: { code: "managed_not_found", reason: "selected root Session does not exist" },
          })),
      )
      if (rootSession.parentID || rootSession.projectID !== scope.projectRef || rootSession.workspaceID !== scope.workspaceRef) {
        return yield* Effect.fail(new ApiGoalReviewNotFoundError({
          name: "GoalReviewNotFoundError",
          data: { code: "managed_not_found", reason: "goal.start requires the current durable top-level Session in the Goal workspace" },
        }))
      }
      const owner = rootSession.metadata?.horizonPrincipalOwner
      if (typeof owner !== "object" || owner === null || Array.isArray(owner) ||
        owner.kind !== "server_auth" || owner.subject !== trustedPrincipal.subject) {
        return yield* Effect.fail(new ApiGoalReviewForbiddenError({
          name: "GoalReviewForbiddenError",
          data: { code: "principal_mismatch", reason: "goal.start requires a Session durably created by the authenticated principal" },
        }))
      }
      const goalBinding = rootSession.metadata?.horizonManagedRoot
      if (goalBinding !== undefined && (typeof goalBinding !== "object" || goalBinding === null || Array.isArray(goalBinding) ||
        goalBinding.schemaVersion !== 1 || goalBinding.goalID !== snapshot.goalID || goalBinding.runID !== ctx.payload.runID ||
        goalBinding.specID !== ctx.payload.specID || goalBinding.specDigest !== ctx.payload.specDigest ||
        goalBinding.projectID !== snapshot.projectRef || goalBinding.workspaceID !== snapshot.workspaceRef ||
        typeof goalBinding.sessionLinkDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(goalBinding.sessionLinkDigest))) {
        return yield* Effect.fail(new ApiGoalReviewConflictError({
          name: "GoalReviewConflictError",
          data: { code: "managed_conflict", reason: "Session is already bound to a different Goal or workspace" },
        }))
      }
      let sessionLink: ManagedRootSessionLinkProjectionV1
      if (run.runPhase === "RUNNING") {
        const pinned = run.sessionLink
        if (!pinned || pinned.sessionID !== rootSession.id) {
          return yield* Effect.fail(new ApiGoalReviewConflictError({
            name: "GoalReviewConflictError",
            data: { code: "managed_conflict", reason: "started Run has no SessionLink for the selected root Session" },
          }))
        }
        // Use Rust's immutable Run link on retries. The current Core transcript
        // cursor may have advanced since start, and must not change replay input.
        sessionLink = {
          sessionID: pinned.sessionID,
          sourceStoreID: pinned.sourceStoreID,
          sourceInstanceID: pinned.sourceInstanceID,
          sourceCursor: pinned.sourceCursor,
          sourceEpoch: pinned.sourceEpoch,
          latestObservedMessageID: pinned.latestObservedMessageID,
          latestObservedPartID: pinned.latestObservedPartID,
          sourceDigest: pinned.sourceDigest,
          redactionProfile: pinned.redactionProfile,
          protocolVersion: pinned.protocolVersion,
          ownerEpoch: pinned.ownerEpoch,
          goalID: snapshot.goalID,
          projectID: snapshot.projectRef,
          workspaceID: snapshot.workspaceRef,
        }
      } else {
        if (run.sessionLink !== null) {
          return yield* Effect.fail(new ApiGoalReviewConflictError({
            name: "GoalReviewConflictError",
            data: { code: "managed_conflict", reason: "planned Run unexpectedly contains a pinned SessionLink" },
          }))
        }
        sessionLink = yield* sessions.managedRootSessionLink({
          sessionID: rootSession.id,
          principalSubject: trustedPrincipal.subject,
          goalID: snapshot.goalID,
          runID: ctx.payload.runID,
          projectID: snapshot.projectRef,
          workspaceID: snapshot.workspaceRef,
        }).pipe(
          Effect.provideService(SessionSupervisor.Service, supervisor),
          Effect.mapError((error) => new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "session_link_unavailable", reason: error.message },
          })),
        )
      }
      const result = yield* ManagedControl.startPlannedRun({
        trustedPrincipal,
        goalID: ctx.payload.goalID,
        runID: ctx.payload.runID,
        specID: ctx.payload.specID,
        specDigest: ctx.payload.specDigest,
        expectedGoalRevision: ctx.payload.expectedGoalRevision,
        idempotencyKey: ctx.payload.idempotencyKey,
        sessionID: rootSession.id,
        projectRef: snapshot.projectRef,
        workspaceRef: snapshot.workspaceRef,
        sessionLink,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      // Complete Core's local projection only after Rust confirms the atomic
      // Run+SessionLink transition. A crash between the Rust append and this
      // metadata write is safely repairable by the exact start replay.
      const persistedRoot = yield* sessions.get(rootSession.id).pipe(
        Effect.mapError(() =>
          new ApiGoalReviewUnavailableError({
            name: "GoalReviewUnavailableError",
            data: { code: "managed_unavailable", reason: "confirmed root Session could not be re-read for the durable binding check" },
          })),
      )
      const persistedBinding = persistedRoot.metadata?.horizonManagedRoot
      if (persistedBinding !== undefined && (typeof persistedBinding !== "object" || persistedBinding === null ||
        Array.isArray(persistedBinding) || persistedBinding.goalID !== ctx.payload.goalID ||
        persistedBinding.schemaVersion !== 1 || persistedBinding.runID !== ctx.payload.runID ||
        persistedBinding.specID !== ctx.payload.specID || persistedBinding.specDigest !== ctx.payload.specDigest ||
        persistedBinding.projectID !== snapshot.projectRef ||
        persistedBinding.workspaceID !== snapshot.workspaceRef ||
        persistedBinding.sessionLinkDigest !== sessionLink.sourceDigest)) {
        return yield* Effect.fail(new ApiGoalReviewConflictError({
          name: "GoalReviewConflictError",
          data: { code: "managed_conflict", reason: "Core Session has a different durable managed root binding" },
        }))
      }
      yield* sessions.setMetadata({
        sessionID: persistedRoot.id,
        metadata: {
          ...(persistedRoot.metadata ?? {}),
          horizonManagedRoot: {
            schemaVersion: 1,
            goalID: ctx.payload.goalID,
            runID: ctx.payload.runID,
            specID: ctx.payload.specID,
            specDigest: ctx.payload.specDigest,
            projectID: snapshot.projectRef,
            workspaceID: snapshot.workspaceRef,
            sessionLinkDigest: sessionLink.sourceDigest,
          },
        },
      }).pipe(
        Effect.mapError(() => new ApiGoalReviewUnavailableError({
          name: "GoalReviewUnavailableError",
          data: { code: "session_link_projection_unavailable", reason: "could not persist the confirmed managed root binding in the Core Session" },
        })),
      )
      // Run start and root registration are separate durable owners. Start has
      // already atomically pinned the trusted SessionLink; registering this
      // authenticated Core process is the next required gate before the Rust
      // scheduler can admit any Task. A retry of goal.start replays the same
      // start and root-registration deliveries.
      const instance = yield* InstanceState.context
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const locationID = yield* supervisor.registerHostLocation(locationRef).pipe(
        Effect.provideService(TrustedPrincipalContext, TrustedPrincipalContext.of({ principal: trustedPrincipal })),
        Effect.mapError((error) => new ApiGoalReviewUnavailableError({
          name: "GoalReviewUnavailableError",
          data: { code: error.hostCode ?? "managed_unavailable", reason: error.reason },
        })),
      )
      yield* ManagedControl.registerRootCoordinator({
        trustedPrincipal,
        goalID: ctx.payload.goalID,
        runID: ctx.payload.runID,
        sessionID: rootSession.id,
        locationID,
      }).pipe(
        Effect.provideService(SessionSupervisor.Service, supervisor),
        Effect.mapError(failure),
      )
      const runtimeFlags = yield* RuntimeFlags.Service
      let dispatchStatus: "DISABLED" | "NO_TASK" | "PROMPT_RETURNED" | "PROMPT_RETURNED_ERROR" | "PROMPT_UNKNOWN" | "UNAVAILABLE" = "DISABLED"
      if (runtimeFlags.managedTaskDispatch) {
        const dispatch = yield* executeNextManagedTask({
          trustedPrincipal,
          goalID: ctx.payload.goalID,
          runID: ctx.payload.runID,
          rootSessionID: rootSession.id,
          locationID,
          expectedRevision: result.revision,
        }).pipe(Effect.result)
        dispatchStatus = dispatch._tag === "Failure" ? "UNAVAILABLE" : dispatch.success.status
      }
      return { schemaVersion: 1 as const, ...result, sessionID: rootSession.id, dispatchStatus }
    })

    return handlers
      .handle("goalReview", goalReview)
      .handle("goalReviews", goalReviews)
      .handle("goalPropose", goalPropose)
      .handle("goalReviewDecision", goalReviewDecision)
      .handle("goalVerification", goalVerification)
      .handle("goalRunControl", goalRunControl)
      .handle("goalRunPlan", goalRunPlan)
      .handle("goalRunStart", goalRunStart)
  }),
)
