import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ServiceUnavailableError } from "../errors"
import { WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"

const root = "/experimental/control-plane"
export const MoveSessionPayload = Schema.Struct({ ...MoveSession.Input.fields })

export class ApiMoveSessionError extends Schema.ErrorClass<ApiMoveSessionError>("MoveSessionError")(
  {
    name: Schema.Literal("MoveSessionError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

/** One pending SpecVersion proposal projected for Goal review. */
export const GoalReviewProposalPayload = Schema.Struct({
  goalId: Schema.String,
  goalRevision: Schema.String,
  specVersionId: Schema.String,
  parentVersionId: Schema.NullOr(Schema.String),
  proposedBy: Schema.String,
  reviewAvailability: Schema.Union([
    Schema.Struct({ available: Schema.Literal(true) }),
    Schema.Struct({ available: Schema.Literal(false), reason: Schema.String }),
  ]),
  specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  objective: Schema.String,
  projectRef: Schema.String,
  workspaceRef: Schema.String,
  capabilityScope: Schema.Array(Schema.String),
  scope: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  criteria: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
  budget: Schema.Struct({
    maxTasks: Schema.Int,
    maxAttemptsPerTask: Schema.Int,
    maxRunDurationMs: Schema.Int,
    maxWorkers: Schema.Int,
    maxMemoryBytes: Schema.NullOr(Schema.String),
    maxDiskBytes: Schema.NullOr(Schema.String),
    maxTokens: Schema.NullOr(Schema.String),
    maxCostMicros: Schema.NullOr(Schema.String),
  }),
  sourceDigests: Schema.Array(Schema.String),
})

export const GoalReviewSnapshotPayload = Schema.Struct({
  goalID: Schema.String,
  goalRevision: Schema.String,
  projectRef: Schema.String,
  workspaceRef: Schema.String,
  proposals: Schema.Array(GoalReviewProposalPayload),
  acceptedSpecs: Schema.Array(Schema.Struct({
    specID: Schema.String,
    specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    objective: Schema.String,
    scope: Schema.Array(Schema.String),
    capabilityScope: Schema.Array(Schema.String),
    constraints: Schema.Array(Schema.String),
    criteria: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
    budget: GoalReviewProposalPayload.fields.budget,
  })),
  eligibleProfiles: Schema.Array(Schema.Struct({
    profileId: Schema.String,
    revision: Schema.String,
    name: Schema.String,
    roles: Schema.Array(Schema.String),
    capabilityCeiling: Schema.Array(Schema.String),
    tokenBudget: Schema.NullOr(Schema.Int),
  })),
  eligibleProfilesTruncated: Schema.Boolean,
  runs: Schema.Array(Schema.Struct({ runID: Schema.String, specID: Schema.String, runPhase: Schema.String })),
})

export const GoalReviewInboxPayload = Schema.Struct({
  goals: Schema.Array(GoalReviewSnapshotPayload),
  nextAfterGoalID: Schema.NullOr(Schema.String),
})

export const GoalReviewQuery = Schema.Struct({ goalID: Schema.String, ...WorkspaceRoutingQueryFields })
export const GoalReviewInboxQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  afterGoalID: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(64),
    ),
  ),
})
export const GoalReviewDecisionQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields })

/** The route derives its workspace, Location and reviewer from trusted context. */
const ManagedIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._-]{1,256}$/),
)
const DecimalU64 = Schema.String.check(Schema.makeFilter((value) => {
  const max = "18446744073709551615"
  return /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    (value.length < max.length || (value.length === max.length && value <= max))
    ? undefined
    : "must be a canonical unsigned 64-bit decimal string"
}))
const CapabilityId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)).check(Schema.isMaxLength(128))
export const GoalVerificationInputV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: ManagedIdentifier,
  runID: ManagedIdentifier,
})
export const GoalRunControlInputV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  action: Schema.Literals(["pause", "resume", "cancel"]),
  goalID: ManagedIdentifier,
  runID: ManagedIdentifier,
  expectedRevision: DecimalU64,
})
/** Explicit confirmation of a previously persisted plan. The actor is always
 * derived from authenticated ServerAuth middleware, never from this body. */
export const GoalRunStartInputV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: ManagedIdentifier,
  runID: ManagedIdentifier,
  expectedGoalRevision: DecimalU64,
  specID: ManagedIdentifier,
  specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  /** Core-verified active top-level Session selector; Rust pins it atomically. */
  sessionID: ManagedIdentifier,
  idempotencyKey: ManagedIdentifier,
})
export const GoalRunStartPayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: ManagedIdentifier,
  runID: ManagedIdentifier,
  specID: ManagedIdentifier,
  sessionID: ManagedIdentifier,
  runPhase: Schema.String,
  revision: DecimalU64,
  dispatchStatus: Schema.Literals(["DISABLED", "NO_TASK", "PROMPT_RETURNED", "PROMPT_RETURNED_ERROR", "PROMPT_UNKNOWN", "UNAVAILABLE"]),
})

/**
 * A user-approved, non-effectful Run plan. The Task IDs are stable idempotency
 * keys; profile definitions, reviewer identity, workspace revision, readiness,
 * Attempt IDs and EffectIntents are deliberately absent from this wire contract.
 */
export const GoalRunPlanInputV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: ManagedIdentifier,
  specID: ManagedIdentifier,
  specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  expectedGoalRevision: DecimalU64,
  runID: ManagedIdentifier,
  tasks: Schema.Array(Schema.Struct({
    taskID: ManagedIdentifier,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
    dependencies: Schema.Array(ManagedIdentifier).check(Schema.isMaxLength(128)),
    criterionIDs: Schema.Array(ManagedIdentifier).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    requiredCapabilities: Schema.Array(CapabilityId).check(Schema.isMaxLength(64)),
    profileSelection: Schema.Struct({
      profileId: ManagedIdentifier,
      revision: DecimalU64,
    }),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})

export const GoalRunPlanPayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("PLAN_ONLY"),
  executionAvailable: Schema.Literal(false),
  goalID: Schema.String,
  runID: Schema.String,
  specID: Schema.String,
  specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  revision: DecimalU64,
  runPhase: Schema.String,
  taskIDs: Schema.Array(Schema.String),
  taskPins: Schema.Array(Schema.Struct({
    taskID: Schema.String,
    goalID: Schema.String,
    runID: Schema.String,
    runRevision: DecimalU64,
    specID: Schema.String,
    specDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    profileID: Schema.String,
    profileRevision: DecimalU64,
    profileDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    acceptedScopeDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    profilePermissionCeilingDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  })),
  tasksReady: Schema.Literal(false),
  reason: Schema.String,
})

const ManagedUsageStatusV1 = Schema.Literals(["provider-reported", "measured", "estimated", "unknown", "mixed"])
const ManagedUsageSummaryPayloadV1 = Schema.Struct({
  accountingCursor: DecimalU64,
  tokenKnownSubtotal: DecimalU64,
  costKnownSubtotalMicros: DecimalU64,
  tokenRemainderStatus: Schema.Literals(["KNOWN", "ESTIMATED", "UNKNOWN"]),
  costRemainderStatus: Schema.Literals(["KNOWN", "ESTIMATED", "UNKNOWN"]),
  usageState: Schema.Literals(["KNOWN", "ESTIMATED", "UNKNOWN"]),
  stopReason: Schema.Literals(["NONE", "TOKEN_CEILING", "COST_CEILING", "USAGE_UNCERTAIN"]),
  ceilingDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  costStatus: ManagedUsageStatusV1,
  metricStatuses: Schema.Struct({
    input: ManagedUsageStatusV1,
    output: ManagedUsageStatusV1,
    reasoning: ManagedUsageStatusV1,
    "cache.read": ManagedUsageStatusV1,
    "cache.write": ManagedUsageStatusV1,
  }),
  receiptCount: DecimalU64,
  receiptChainDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
})

export const GoalVerificationPayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals([
    "ABORTED",
    "VERIFYING",
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN",
    "NEEDS_YOU",
    "CANCELLING",
    "CANCELLED",
  ]),
  goalID: Schema.String,
  runID: Schema.String,
  taskID: Schema.String,
  attemptID: Schema.String,
  finalRevision: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  /** HostKernel-derived verifier-set identity echoed by the durable P8 settlement receipt. */
  setIdentityDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  challengeSetDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  sourceRevision: Schema.optional(Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/))),
  evidenceDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/))),
  artifactRefs: Schema.optional(Schema.Array(Schema.Struct({
    criterionID: Schema.String,
    artifactRefs: Schema.Array(Schema.Struct({
      artifactID: Schema.String,
      digest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      byteLength: DecimalU64,
      mediaType: Schema.String,
      classification: Schema.Literals(["PUBLIC", "WORKSPACE", "SENSITIVE"]),
    })).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  recoveredArtifactRefs: Schema.optional(Schema.Array(Schema.Struct({
    artifactID: Schema.String,
    digest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    byteLength: DecimalU64,
    mediaType: Schema.String,
    classification: Schema.Literals(["PUBLIC", "WORKSPACE", "SENSITIVE"]),
  })).check(Schema.isMaxLength(256))),
  /** Exact terminal accounting from Rust; absent on nonterminal/pre-provider results. */
  usageAccounting: Schema.optional(ManagedUsageSummaryPayloadV1),
  dispatchSettlement: Schema.optional(Schema.Union(Schema.Struct({
    status: Schema.Literal("SETTLED"),
    goalID: Schema.String,
    runID: Schema.String,
    taskID: Schema.String,
    attemptID: Schema.String,
    verificationRunID: Schema.String,
    setIdentityDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    challengeSetDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    workerExecutionID: Schema.String,
    disposition: Schema.Literals(["RELEASED", "WORKTREE_QUARANTINED"]),
    proofDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    ownerLogID: Schema.String,
    ownerLogSequence: DecimalU64,
    ownerLogEventDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    workerPoolRevision: DecimalU64,
    receiptDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    worktreeDisposition: Schema.Struct({
      ownerEpoch: DecimalU64,
      disposition: Schema.Literals(["REUSABLE", "QUARANTINED"]),
      settlementReceiptDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      finalWorktreeOperationID: Schema.String,
      finalWorktreeHostReceiptRef: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      observedWorkspaceRevision: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      inspectReceiptDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      ownerLogID: Schema.String,
      ownerLogSequence: DecimalU64,
      ownerLogEventDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
      workerPoolRevision: DecimalU64,
      receiptDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    }),
  }), Schema.Struct({
    status: Schema.Literal("QUARANTINED"),
    goalID: Schema.String,
    runID: Schema.String,
    taskID: Schema.String,
    attemptID: Schema.String,
    workerExecutionID: Schema.String,
    ownerEpoch: DecimalU64,
    reservationID: Schema.String,
    worktreeLeaseID: Schema.String,
    reason: Schema.Literals(["FAILED_ATTEMPT", "CANCELLED_TASK"]),
    terminalProofDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    ownerLogID: Schema.String,
    ownerLogSequence: DecimalU64,
    ownerLogEventDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
    workerPoolRevision: DecimalU64,
    receiptDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  }))),
  verificationRunID: Schema.String,
  reason: Schema.optional(Schema.Literals([
    "reviewer_denied",
    "cancelled",
    "expired",
    "transport_lost",
    "cancelled_before_next_test",
    "guarded_execution_unavailable",
    "execution_outcome_unknown",
    "workspace_revision_changed",
    "verification_incomplete",
  ])),
  revision: DecimalU64,
})
export const GoalRunControlPayloadV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: Schema.String,
  runID: Schema.String,
  status: Schema.Literals(["PAUSED", "RUNNING", "CANCELLED", "CANCELLING"]),
  runPhase: Schema.String,
  revision: DecimalU64,
})


/** Versioned user-authored draft accepted by the bounded `goal.propose` route. */
const DraftText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))
export const GoalProposalDraftV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  objective: DraftText,
  capabilityScope: Schema.Array(CapabilityId).check(Schema.isMaxLength(64)),
  scope: Schema.Array(DraftText).check(Schema.isMaxLength(32)),
  constraints: Schema.Array(DraftText).check(Schema.isMaxLength(32)),
  criteria: Schema.Array(Schema.Struct({ id: DraftText, description: DraftText })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  budget: Schema.Struct({
    maxTasks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(128)),
    maxAttemptsPerTask: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
    maxRunDurationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3_600_000)),
    maxWorkers: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
    maxMemoryBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxDiskBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxCostMicros: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  sourceDigests: Schema.Array(DraftText).check(Schema.isMaxLength(32)),
})
export const GoalProposalCreatedPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goalID: Schema.String,
  specID: Schema.String,
  specDigest: Schema.String,
  proposedBy: Schema.String,
  accepted: Schema.Boolean,
  revision: Schema.Number,
})

export const GoalReviewDecisionInput = Schema.Struct({
  decision: Schema.Literals(["accept", "reject"]),
  goalID: Schema.String,
  specID: Schema.String,
  specDigest: Schema.String,
  expectedRevision: Schema.Union([Schema.String, Schema.Number]),
})

export const SpecDecisionPayload = Schema.Struct({
  goalID: Schema.String,
  specID: Schema.String,
  specDigest: Schema.String,
  decision: Schema.Literals(["ACCEPTED", "REJECTED"]),
  decidedBy: Schema.String,
  decidedAtMs: Schema.Number,
  reviewedRevision: Schema.String,
  revision: Schema.String,
})

/**
 * Kernel-refusal envelope shared by every Goal-review failure status. `code` is the
 * kernel's own typed code (`managed_conflict`, `managed_unavailable`, ...) so a caller
 * never has to infer the durable outcome from the HTTP status alone.
 */
const GoalReviewFailureData = Schema.Struct({
  code: Schema.String,
  reason: Schema.String,
})

export class ApiGoalReviewError extends Schema.ErrorClass<ApiGoalReviewError>("GoalReviewError")(
  {
    name: Schema.Literal("GoalReviewError"),
    data: GoalReviewFailureData,
  },
  { httpApiStatus: 400 },
) {}

export class ApiGoalReviewNotFoundError extends Schema.ErrorClass<ApiGoalReviewNotFoundError>("GoalReviewNotFoundError")(
  {
    name: Schema.Literal("GoalReviewNotFoundError"),
    data: GoalReviewFailureData,
  },
  { httpApiStatus: 404 },
) {}

export class ApiGoalReviewConflictError extends Schema.ErrorClass<ApiGoalReviewConflictError>("GoalReviewConflictError")(
  {
    name: Schema.Literal("GoalReviewConflictError"),
    data: GoalReviewFailureData,
  },
  { httpApiStatus: 409 },
) {}

export class ApiGoalReviewForbiddenError extends Schema.ErrorClass<ApiGoalReviewForbiddenError>("GoalReviewForbiddenError")(
  {
    name: Schema.Literal("GoalReviewForbiddenError"),
    data: GoalReviewFailureData,
  },
  { httpApiStatus: 403 },
) {}

export class ApiGoalReviewUnavailableError extends Schema.ErrorClass<ApiGoalReviewUnavailableError>(
  "GoalReviewUnavailableError",
)(
  {
    name: Schema.Literal("GoalReviewUnavailableError"),
    data: GoalReviewFailureData,
  },
  { httpApiStatus: 503 },
) {}

const goalReviewErrors = [
  ApiGoalReviewError,
  ApiGoalReviewNotFoundError,
  ApiGoalReviewConflictError,
  ApiGoalReviewForbiddenError,
  ApiGoalReviewUnavailableError,
] as const

export const ControlPlaneApi = HttpApi.make("controlPlane").add(
  HttpApiGroup.make("controlPlane")
    .add(
      HttpApiEndpoint.post("moveSession", `${root}/move-session`, {
        payload: MoveSessionPayload,
        success: described(HttpApiSchema.NoContent, "Session moved"),
        error: [ApiMoveSessionError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.controlPlane.moveSession",
          summary: "Move session",
          description:
            "Move a session to another project directory. Moving local changes is unavailable until files.patch is mediated by Rust Guard and ExecutionHost.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "controlPlane", description: "Control-plane orchestration routes." })),
)

/** Instance-scoped Goal review routes receive validated project/workspace context. */
export const GoalReviewApi = HttpApi.make("goalReview").add(
  HttpApiGroup.make("goalReview")
    .add(
      HttpApiEndpoint.get("goalReview", `${root}/goal-review`, {
        query: GoalReviewQuery,
        success: described(GoalReviewSnapshotPayload, "Pending SpecVersion proposals for the reviewed Goal"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalReview",
          summary: "Read pending Goal review proposals",
          description:
            "Read-only projection of pending SpecVersion proposals for one durable Goal, restricted to the authenticated current project and workspace.",
        }),
      ),
      HttpApiEndpoint.get("goalReviews", `${root}/goal-reviews`, {
        query: GoalReviewInboxQuery,
        success: described(GoalReviewInboxPayload, "Pending Goal review proposals visible in the current workspace"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalReviews",
          summary: "Discover pending Goal review proposals",
          description:
            "Bounded discovery inbox filtered by the authenticated current project and workspace. Each proposal carries reviewer availability derived from trusted ServerAuth context; local host identity remains read-only.",
        }),
      ),
      HttpApiEndpoint.post("goalPropose", `${root}/goal-proposals`, {
        query: GoalReviewDecisionQuery,
        payload: GoalProposalDraftV1,
        success: described(GoalProposalCreatedPayload, "New Goal and pending SpecVersion proposal"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalPropose",
          summary: "Propose a managed Goal",
          description:
            "Create a Goal and pending SpecVersion from a bounded schemaVersion 1 user draft. Project and workspace are derived from the authenticated instance route; IDs and proposer identity are assigned by the server. This is the canonical goal.propose capability.",
        }),
      ),
      HttpApiEndpoint.post("goalReviewDecision", `${root}/goal-review/decision`, {
        query: GoalReviewDecisionQuery,
        payload: GoalReviewDecisionInput,
        success: described(SpecDecisionPayload, "SpecVersion decision applied by the kernel"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalReviewDecision",
          summary: "Apply a Goal review decision",
          description:
            "Accept or reject one proposed SpecVersion digest at an exact reviewed Goal revision. Success requires authenticated ServerAuth distinct from the proposer.",
        }),
      ),
      HttpApiEndpoint.post("goalVerification", `${root}/goal-verification`, {
        query: GoalReviewDecisionQuery,
        payload: GoalVerificationInputV1,
        success: described(GoalVerificationPayloadV1, "Safe result of the current-workspace verifier flow"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalVerification",
          summary: "Run the managed independent verifier",
          description:
            "Begin the HostKernel-owned verifier for a Goal/Run using the authenticated current workspace. Guard approvals are collected through the existing Core flow; request bodies cannot choose the verifier, profile, tests, workspace revision, verdict, lease or artifacts.",
        }),
      ),
      HttpApiEndpoint.post("goalRunControl", `${root}/goal-run-control`, {
        query: GoalReviewDecisionQuery,
        payload: GoalRunControlInputV1,
        success: described(GoalRunControlPayloadV1, "Revision-fenced managed Run pause, resume, or cancellation"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalRunControl",
          summary: "Pause, resume, or cancel a managed Run",
          description:
            "Apply a durable Run control transition at the latest authenticated Goal revision. The server derives the revision from the current OwnerLog snapshot; request bodies cannot choose a stale or future revision.",
        }),
      ),
      HttpApiEndpoint.post("goalRunStart", `${root}/goal-run-start`, {
        query: GoalReviewDecisionQuery,
        payload: GoalRunStartInputV1,
        success: described(GoalRunStartPayloadV1, "Explicitly started accepted managed Run plan"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalRunStart",
          summary: "Start an accepted managed Run plan",
          description:
            "After explicit user confirmation, atomically transition the persisted PLANNED Run and its dependency-ready Task roots to RUNNING. ServerAuth supplies the actor; the body cannot change the accepted SpecVersion, Task plan, profile, workspace, Attempt, or effect authority.",
        }),
      ),
      HttpApiEndpoint.post("goalRunPlan", `${root}/goal-run-plan`, {
        query: GoalReviewDecisionQuery,
        payload: GoalRunPlanInputV1,
        success: described(GoalRunPlanPayloadV1, "Visible plan-only managed Run and Tasks"),
        error: goalReviewErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.goalReview.goalRunPlan",
          summary: "Prepare a managed Run plan",
          description:
            "Create an accepted-SpecVersion Run and pinned-profile Tasks for review in the current workspace. This records plan state only: Tasks are not marked ready, no Attempt is admitted, and no effect or worker is dispatched.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "goalReview", description: "Managed Goal review inbox and decisions." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
