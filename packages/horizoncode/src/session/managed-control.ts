/**
 * Typed client for the authenticated `managed.v1` kernel RPC.
 *
 * HorizonCode's Rust kernel owns Goal/SpecVersion/Run/Task/Attempt admission. Core
 * reaches it only through the authenticated host-kernel channel: every request is
 * fenced to the negotiated owner epoch and process incarnation, and every mutating
 * operation carries a one-use delivery key. A refusal rejects with a typed
 * `ManagedControlError` carrying the kernel's own error code; a transport or
 * configuration failure is reported as `managed_unavailable` and never retried
 * silently, so an unsupported path stays fail-closed instead of bypassing the Guard.
 *
 * Two shapes are exposed:
 *
 * - **Plan ingress** (`createGoalProposal` … `createRunPlan`) creates the durable managed
 *   chain for a governed Run. The kernel records `createdBy`/`proposedBy`/
 *   `acceptedBy`/`rejectedBy` from the authenticated connection principal, and the
 *   state machine refuses self-approval: a SpecVersion author cannot approve it.
 *
 *   The HTTP review route receives its ServerAuth subject from middleware context,
 *   and the kernel durably assigns the distinct reviewer before a revision-bound
 *   decision. Request-body identity is never accepted as reviewer authority. The
 *   verifier lifecycle gathers distinct-reviewer Guard approvals and delegates
 *   execution/evidence binding to HostKernel. Nothing here schedules or dispatches
 *   work or accepts model-supplied completion evidence.
 *
 * - **Managed (Goal-scoped) Run control** (`admitAttempt` … `finalizeRun`) drives the
 *   managed Run vertical: dependency-ready Tasks admit one Attempt at a time, only settled Location
 *   effects can back a `succeeded` settlement, and every revision-fenced command is
 *   compare-and-swap on the exact decimal Goal revision the caller last observed.
 *   `settleAttempt unknown` durably fences the Run as RECONCILING; cancellation stays
 *   CANCELLING while any Attempt is active or UNKNOWN. Verification keeps its one
 *   coding Attempt live through Guarded verifier receipts and typed evidence; Run
 *   finalization remains bound to that evidence and frozen workspace revision.
 *
 * - **Direct (Goal-less) Attempt scope** (`admitDirectAttempt` … `snapshotDirectAttempt`)
 *   is the durable dispatch fence for direct-session subagent work (`Task`). Direct
 *   coding does not require a Goal, so the Attempt is bound to the parent/child
 *   sessions, the agent and a Core-computed `sha256:` digest of the intersected
 *   dispatch scope (permissions, model, workspace, budget). The kernel derives and
 *   records a BLAKE3 receipt for every settled attempt.
 */

import { createHash, randomUUID } from "node:crypto"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Effect, Schema } from "effect"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { AgentProfileService, Service as CoreConfigService } from "@horizoncode/core/config"
import { LocationServiceMap } from "@horizoncode/core/location-service-map"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { SessionMessage as SessionMessageSchema } from "@horizoncode/schema/session-message"
import { encodeCanonicalMessagePackV1 } from "@horizoncode/schema"
import { managedRouteProjection } from "@/provider/provider"
import { Auth } from "@/auth"
import { Service as ProviderService } from "@/provider/provider"
import {
  retainManagedProviderSendAuthorization,
  type ManagedProviderAuthorizationHandleV1,
} from "@/auth/provider-transport"
import type { ManagedRootSessionLinkProjectionV1 } from "./session"
import { managedMessageConsumptionAckDigest, managedMessageInboxReceiptDigest } from "./managed-subagent-inbox"
import type { ManagedSubagentConsumptionProofV1 } from "./managed-subagent-inbox"
import { ContextSelectionV1, type ContextSelectionV1 as ContextSelection } from "@horizoncode/schema/context-selection-v1"
import {
  type ManagedVerifierGuardChallengeV1,
  type ManagedProviderGuardChallengeV1 as SupervisorManagedProviderGuardChallengeV1,
  type ManagedProviderApprovalResultV1,
  type ManagedRootGuardChallengeV1,
  type GuardArgumentSummaryV1,
  type GuardGuaranteeAssessmentV1,
  type ManagedVerifierApprovalCollectionV1,
  validateManagedRootGuardChallenge,
  Service as SessionSupervisorService,
  SessionSupervisor,
  SessionSupervisorError,
} from "@horizoncode/core/session/supervisor"

const MANAGED_SERVICE = "managed.v1"
const DIRECT_MESSAGE_SERVICE = "direct.message.v1"
// Enable only after the integrated P1 Guard/lease path and P8 recovery acceptance.
const DIRECT_CHILD_TURN_RPC_ENABLED = false
const IDENTIFIER = /^[A-Za-z0-9._-]{1,256}$/
const ATTEMPT_ID = /^att_[a-z0-9]{16,64}$/
const MANAGED_CANDIDATE_ATTEMPT_ID = /^attempt_[0-9a-f]{64}$/
const CANONICAL_DIGEST = /^(sha256|blake3):[0-9a-f]{64}$/
const MAX_LIST_ITEMS = 256
const MAX_TEXT_BYTES = 16 * 1024
const MAX_SPEC_CRITERIA = 256
const MAX_PLAN_ITEM_BYTES = 4 * 1024
const MAX_VERIFIER_CRITERIA = 32
const MAX_VERIFIER_ARTIFACTS = MAX_VERIFIER_CRITERIA * 64
// Mirror ArtifactStore's verifier manifest limits so malformed RPC projections
// cannot bypass the storage bounds before they reach the UI or durable reducer.
const MAX_VERIFIER_ARTIFACT_BYTES = 64 * 1024
const MAX_VERIFIER_AGGREGATE_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_RAW_DELIVERY_KEY_BYTES = 200
const MAX_MANAGED_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024

/** Canonical child Session ID for a Rust-selected candidate Attempt. */
export const managedTaskSessionID = (candidateAttemptID: string): string => {
  if (!MANAGED_CANDIDATE_ATTEMPT_ID.test(candidateAttemptID)) {
    throw new Error("managed child Session ID requires a canonical candidate Attempt ID")
  }
  return `ses_managed_${candidateAttemptID}`
}

/** Stable idempotency key for prompt-return quiescence and exact response replay. */
export const managedCompletionDeliveryID = (attemptID: string, handoffDigest: string, consumeReceiptDigest: string): string => {
  if (!MANAGED_CANDIDATE_ATTEMPT_ID.test(attemptID) || !/^blake3:[0-9a-f]{64}$/.test(handoffDigest) || !/^blake3:[0-9a-f]{64}$/.test(consumeReceiptDigest)) {
    throw new Error("managed completion delivery identity requires exact Attempt and receipt pins")
  }
  const hash = createHash("sha256").update("horizoncode.managed-completion-delivery.v1\0", "utf8")
  for (const field of [attemptID, handoffDigest, consumeReceiptDigest]) {
    const bytes = Buffer.from(field, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length).update(bytes)
  }
  return `managed_dispatch_${hash.digest("hex")}`
}

export class ManagedControlError extends Schema.TaggedErrorClass<ManagedControlError>()(
  "ManagedControlError",
  {
    operation: Schema.String,
    code: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Managed control ${this.operation} failed (${this.code}): ${this.reason}`
  }
}

export type SpecBudget = {
  readonly maxTasks: number
  readonly maxAttemptsPerTask: number
  readonly maxRunDurationMs: number
  readonly maxMemoryBytes: number | null
  readonly maxDiskBytes: number | null
  readonly maxWorkers: number
  readonly maxTokens: number | null
  readonly maxCostMicros: number | null
}

export type GoalProposalInput = {
  readonly goalID: string
  readonly specID: string
  readonly objective: string
  readonly projectRef: string
  readonly workspaceRef: string
  readonly capabilityScope: readonly string[]
  readonly scope: readonly string[]
  readonly constraints: readonly string[]
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly description: string }>
  readonly budget: SpecBudget
  readonly sourceDigests: readonly string[]
}

export type GoalProposalCreated = {
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly createdBy: string
  readonly proposedBy: string
  readonly revision: number
}

export type SpecDecision = {
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly decision: "ACCEPTED" | "REJECTED"
  readonly decidedBy: string
  readonly decidedAtMs: number
  /** Exact Goal revision observed by the reviewer and enforced by the kernel CAS. */
  readonly reviewedRevision: string
  /** Decimal string preserves the kernel's full u64 Goal revision exactly. */
  readonly revision: string
}

/** A revision returned by the TUI projection may be larger than JS's safe integer range. */
export type ManagedRevision = number | bigint | string

export type GoalReviewProposal = {
  readonly goalId: string
  readonly goalRevision: string
  readonly specVersionId: string
  readonly parentVersionId: string | null
  readonly proposedBy: string
  readonly reviewAvailability: { readonly available: true } | { readonly available: false; readonly reason: string }
  readonly specDigest: string
  readonly objective: string
  readonly projectRef: string
  readonly workspaceRef: string
  readonly capabilityScope: readonly string[]
  readonly scope: readonly string[]
  readonly constraints: readonly string[]
  readonly criteria: readonly { readonly id: string; readonly description: string }[]
  readonly budget: {
    readonly maxTasks: number
    readonly maxAttemptsPerTask: number
    readonly maxRunDurationMs: number
    readonly maxWorkers: number
    readonly maxMemoryBytes: string | null
    readonly maxDiskBytes: string | null
    readonly maxTokens: string | null
    readonly maxCostMicros: string | null
  }
  readonly sourceDigests: readonly string[]
}

export type GoalReviewSnapshot = {
  readonly goalID: string
  /** Exact decimal string for the Rust u64 revision used by review CAS. */
  readonly goalRevision: string
  readonly projectRef: string
  readonly workspaceRef: string
  readonly proposals: readonly GoalReviewProposal[]
  readonly acceptedSpecs: readonly {
    readonly specID: string
    readonly specDigest: string
    readonly objective: string
    readonly scope: readonly string[]
    readonly capabilityScope: readonly string[]
    readonly constraints: readonly string[]
    readonly criteria: readonly { readonly id: string; readonly description: string }[]
    readonly budget: GoalReviewProposal["budget"]
  }[]
  /** Trusted Core Config projection; IDs/revisions/ceilings only, never client authority. */
  readonly eligibleProfiles: readonly {
    readonly profileId: string
    readonly revision: string
    readonly name: string
    readonly roles: readonly string[]
    readonly capabilityCeiling: readonly string[]
    readonly tokenBudget: string | null
  }[]
  readonly eligibleProfilesTruncated: boolean
  readonly runs: readonly {
    readonly runID: string
    readonly specID: string
    readonly runPhase: ManagedRunPhase
    /** Exact source projection pinned by Rust at goal.start; null only for PLANNED/legacy Runs. */
    readonly sessionLink: ManagedPinnedRootSessionLinkV1 | null
  }[]
}

type ManagedPinnedRootSessionLinkV1 = Omit<ManagedRootSessionLinkProjectionV1, "goalID" | "projectID" | "workspaceID"> & {
  readonly ownerEpoch: string
}

export type PendingGoalReviews = { readonly goals: readonly GoalReviewSnapshot[] }

export type RunStarted = {
  readonly goalID: string
  readonly runID: string
  readonly specID: string
  readonly sessionID: string
  readonly runPhase: ManagedRunPhase
  readonly revision: string
}

export type GoalRunStartInput = {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly specID: string
  readonly specDigest: string
  readonly expectedGoalRevision: string
  readonly idempotencyKey: string
  /** Active authenticated top-level Core Session selected by the TUI. */
  readonly sessionID: string
  /** Trusted project/workspace from the authorized Rust Goal snapshot. */
  readonly projectRef: string
  readonly workspaceRef: string
  /** Fresh Core projection omits ownerEpoch; a RUNNING replay carries Rust's exact pinned link. */
  readonly sessionLink: ManagedRootSessionLinkProjectionV1
}

export type GoalRunPlanTaskInput = {
  readonly taskID: string
  /** Immutable reviewed text; descriptive only and never an authority source. */
  readonly title: string
  readonly purpose: string
  readonly dependencies: readonly string[]
  readonly criterionIDs: readonly string[]
  readonly requiredCapabilities: readonly string[]
  /** Canonical decimal u64; retained as text across the Core/HTTP boundary. */
  readonly profileSelection: { readonly profileId: string; readonly revision: string }
}

export type GoalRunPlanInput = {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly expectedGoalRevision: string
  readonly runID: string
  readonly projectRef: string
  readonly workspaceRef: string
  readonly tasks: readonly GoalRunPlanTaskInput[]
}

export type GoalRunPlanResult = {
  readonly status: "PLAN_ONLY"
  readonly executionAvailable: false
  readonly goalID: string
  readonly runID: string
  readonly specID: string
  readonly specDigest: string
  readonly runPhase: string
  readonly taskIDs: readonly string[]
  readonly taskPins: readonly {
    readonly taskID: string
    readonly goalID: string
    readonly runID: string
    readonly runRevision: string
    readonly specID: string
    readonly specDigest: string
    readonly profileID: string
    readonly profileRevision: string
    readonly profileDigest: string
    readonly acceptedScopeDigest: string
    readonly profilePermissionCeilingDigest: string
  }[]
  readonly tasksReady: false
  readonly revision: string
  readonly reason: string
}

export type DirectAttemptPhase = "EXECUTING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED"

export type DirectAttemptSnapshot = {
  readonly attemptID: string
  readonly phase: DirectAttemptPhase
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly agent: string
  readonly scopeDigest: string
  readonly receiptDigest: string | null
  readonly resultDigest: string | null
  readonly failureCode: string | null
  readonly retryable: boolean | null
  readonly revision: string
  /** HostKernel-minted live authority; never reconstructed from Session metadata. */
  readonly directAttempt?: DirectAttemptScopeV1
}

export type DirectAttemptScopeV1 = {
  readonly attemptID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly profileID: string
  /** Canonical decimal u64, pinned to the immutable Core Config revision. */
  readonly profileRevision: string
  readonly profileDigest: string
  readonly ownerEpoch: string
  readonly expectedRevision: string
  readonly locationID: string
  readonly workspaceID: string
  readonly workspaceRevision: string
  readonly capabilityDigest: string
  readonly permissionsDigest: string
  readonly budgetDigest: string
  readonly scopeDigest: string
}

export type DirectAttemptAdmission = DirectAttemptSnapshot & {
  readonly ownerEpoch: string
  readonly locationID: string
  readonly workspaceID: string
  readonly workspaceRevision: string
  readonly directAttempt: DirectAttemptScopeV1
}

export type DirectAttemptEffectBound = {
  readonly attemptID: string
  readonly effectIDs: readonly string[]
  readonly locationID: string
  readonly revision: string
  /** Refreshed scope for the next batch; the just-bound batch keeps its original scope. */
  readonly directAttempt: DirectAttemptScopeV1
}

export type DirectAttemptSettlement = DirectAttemptSnapshot & {
  readonly outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN"
}

export type DirectMessageMode = "queued" | "follow_up"
export type DirectMessagePinsV1 = {
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly childOwnerEpoch: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  /** Exact Core child-owned DirectAttempt row to resolve in HostKernel OwnerLog. */
  readonly directAttemptID: string
  readonly messageID: string
  readonly deliveryMode: DirectMessageMode
  readonly payloadDigest: string
  readonly payloadBytes: number
  readonly mailboxSequence: string
  readonly mailboxCapacity: number
}
export type DirectMessageInboxReceiptV1 = {
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly deliveryMode: DirectMessageMode
  readonly mailboxSequence: string
  readonly receiptDigest: string
}
export type DirectMessagePrepareResultV1 =
  | { readonly status: "DENIED"; readonly reasonCode: string; readonly pinsDigest: string }
  | {
    readonly status: "NEEDS_APPROVAL"
    readonly challengeID: string
    readonly effectID: string
    readonly capabilityID: "agents.message"
    readonly locationID: string
    readonly inputDigest: string
    readonly expiresAtUnixMs: number
    readonly argumentSummary: GuardArgumentSummaryV1
    readonly policySummary: string
  }
  | {
    readonly status: "ADMITTED"
    readonly messageID: string
    readonly capabilityID: "agents.message"
    readonly locationID: string
    readonly capabilityLeaseDigest: string
    readonly expiresAtUnixMs: number
    readonly pinsDigest: string
      readonly authorityPins: DirectMessagePinsV1
  }
export type DirectMessageReceiptV1 = {
  readonly status: "QUEUED" | "FOLLOW_UP_SCHEDULED" | "UNKNOWN"
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly deliveryMode: DirectMessageMode
  readonly mailboxSequence: string
  readonly receiptDigest: string
}

/** Lane-tagged authority for messages delivered to a Rust-managed Task Attempt.
 * The caller supplies comparison pins only; HostKernel resolves the binding. */
export type ManagedMessagePinsV1 = {
  readonly lane: "managed_attempt"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly ownerEpoch: string
  readonly bindingDigest: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly messageID: string
  readonly deliveryMode: DirectMessageMode
  readonly payloadDigest: string
  readonly payloadBytes: number
  readonly mailboxSequence: string
  readonly mailboxCapacity: number
}
export type ManagedMessageReceiptV1 = {
  readonly status: "QUEUED" | "FOLLOW_UP_SCHEDULED" | "UNKNOWN"
  readonly messageID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly deliveryMode: DirectMessageMode
  readonly mailboxSequence: string
  readonly receiptDigest: string
  readonly wakeReceiptDigest?: string
  readonly nextRequestSequence?: string
}
export type ManagedMessageConsumptionAckReceiptV1 = {
  readonly status: "ACKNOWLEDGED"
  readonly ack: Readonly<Record<string, unknown>>
  readonly receiptDigest: string
}
export type ManagedMessageWakeClaimReceiptV1 = {
  readonly status: "CLAIMED"
  readonly authorityPins: Readonly<Record<string, unknown>>
  readonly inboxReceiptDigest: string
  readonly completedTurnReceiptDigest: string
  readonly wakeReceiptDigest: string
  readonly nextRequestSequence: string
  readonly requestID: string
  readonly currentConsumer: ManagedAttemptScopeV1
  readonly wakeClaimDigest: string
  readonly wakeClaimReceiptDigest: string
}

/** Read-only exact Guard receipts for one committed managed ToolBatch wave. */
export type ManagedEffectWaveReceiptsV1 = {
  readonly status: "RECOVERED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly batchID: string
  readonly waveIndex: number
  readonly sourceScopeDigest: string
  readonly waveDigest: string
  readonly effects: ReadonlyArray<{
    readonly callIndex: number
    readonly callID: string
    readonly effectID: string
    readonly receiptRef: string | null
    readonly capabilityID: string
    readonly attemptScopeDigest: string
    readonly status: string
    readonly receiptKind: "effect" | "decision" | null
    readonly receiptDigest: string | null
  }>
}
export type ManagedMessagePrepareResultV1 =
  | { readonly status: "DENIED"; readonly reasonCode: string; readonly pinsDigest: string }
  | Extract<DirectMessagePrepareResultV1, { readonly status: "NEEDS_APPROVAL" }>
  | {
    readonly status: "ADMITTED"
    readonly messageID: string
    readonly capabilityID: "agents.message"
    readonly locationID: string
    readonly capabilityLeaseDigest: string
    readonly expiresAtUnixMs: number
    readonly pinsDigest: string
    readonly authorityPins: ManagedMessagePinsV1
  }

/** HostKernel-issued scope for exactly one serialized provider turn. */
export type DirectTurnScopeV1 = {
  readonly directAttempt: DirectAttemptScopeV1
  readonly runnerCycleID: string
  readonly turnSequence: string
  readonly cycleDigest: string
}

/** Mutable Core projection for one HostKernel-owned child turn. The persistence
 * callback must finish before another effect can be dispatched with a refreshed
 * full-snapshot cycle digest. */
export type DirectTurnAuthority = {
  readonly currentScope: () => DirectTurnScopeV1
  readonly acceptRefreshedScope: (input: {
    readonly previous: DirectTurnScopeV1
    readonly refreshed: DirectTurnScopeV1
    readonly transition: "batch_bind" | "batch_complete"
  }) => void
  readonly persistRefreshedScope: (scope: DirectTurnScopeV1) => Promise<void>
}

/** One-use HostKernel proof for one explicitly requested follow-up turn. */
export type FreshTurnAuthorizationV1 = {
  readonly authorityPins: DirectMessagePinsV1
  readonly completedTurnScope: DirectTurnScopeV1
  readonly nextTurnSequence: string
  readonly issuanceID: string
  readonly expiresAtUnixMs: string
  readonly authorizationDigest: string
}

/** Durable phase of one Goal-scoped (managed) Attempt. */
export type ManagedAttemptPhase = "ADMITTED" | "EXECUTING" | "SETTLING" | "SUCCEEDED" | "UNKNOWN" | "FAILED"

/** Durable phase of one managed Run. */
export type ManagedRunPhase =
  | "PLAN_ONLY"
  | "RUNNING"
  | "PAUSED"
  | "RECONCILING"
  | "CANCELLING"
  | "CANCELLED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "NEEDS_YOU"
  | "FAILED"

/** One admitted Attempt on a ready managed Task. */
export type ManagedAttemptAdmission = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly parentSessionID: string
  readonly ownerEpoch: string
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRevision: string
  readonly attemptPhase: ManagedAttemptPhase
  readonly runPhase: ManagedRunPhase
  /** Decimal string preserves the kernel's full u64 revision exactly. */
  readonly revision: string
  readonly requestSequence: string
  readonly requestID: string
  readonly contextSelectionDigest: string
  readonly profile: {
    readonly profileID: string
    readonly profileRevision: string
    readonly profileDigest: string
  }
  /** Exact Core Provider/SecretBroker metadata projection pinned by Rust at admission. */
  readonly managedProviderRoute: ManagedProviderRouteProjectionV1
  /** Full HostKernel-minted scope; never reconstructed from admission request fields. */
  readonly managedAttempt: ManagedAttemptScopeV1
}

/** Durable request-bound ContextSelection advance for one live managed Attempt. */
export type ManagedContextAdvanceReceiptV1 = {
  readonly status: "ADMITTED" | "REPLAY"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly ownerEpoch: string
  readonly sessionID: string
  readonly requestSequence: string
  readonly requestID: string
  readonly contextSelectionDigest: string
  readonly revision: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

/** HostKernel-authenticated route and protected references resolved by the provider owner. */
export type ManagedProviderRouteProjectionV1 = {
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly routeID: string
  readonly endpointRevision: string
  /** Null is only the trusted provider owner's explicit anonymous-route projection. */
  readonly credentialLeaseRef: string | null
}

/** Exact request identity, separated from the trusted selected-route projection. */
export type ManagedProviderInputPinsV1 = {
  readonly requestID: string
  readonly requestSequence: string
  readonly contextSelectionDigest: string
  readonly requestDigest: string
  readonly transportRequestDigest: string
  readonly operationDigest: string
}

/** Combined immutable route and normalized provider-input identity for one call. */
export type ManagedProviderRequestPinsV1 = ManagedProviderRouteProjectionV1 & ManagedProviderInputPinsV1

/** Host-created Guard challenge returned from prepare; never request authority. */
export type ManagedProviderGuardChallengeV1 = {
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "providers.infer"
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: "managed_run"
  readonly source: "host.managed_provider"
  readonly policyID: "provider-inference.managed.v1"
  readonly policyDigest: string
  readonly normalizedAction: "providers.infer"
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly runID: string
  readonly sessionID: string
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: boolean
}

export type ManagedProviderRequestPreparedV1 = ManagedProviderRequestPinsV1 & {
  readonly status: "PREPARED" | "REPLAY" | "UNAVAILABLE"
  readonly providerRequestID: string | null
  readonly prepareDigest: string | null
  /** Present only when HostKernel prepared or recovered the exact Guard challenge. */
  readonly guardChallenge: ManagedProviderGuardChallengeV1 | null
  readonly revision: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

export type ManagedProviderRequestDispatchV1 = ManagedProviderRequestPinsV1 & {
  readonly status: "DISPATCHING" | "REPLAY" | "UNAVAILABLE"
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string | null
  /** HostKernel-minted Guard identity, separate from caller route/request pins. */
  readonly guardChallengeID: string | null
  /** Guard action identity bound by the HostKernel to the send authorization. */
  readonly effectID: string | null
  /** Exact approved Guard lease; null when unavailable. */
  readonly capabilityLeaseDigest: string | null
  /** P1 EffectHost binding digest, echoed into Auth's one-use consume boundary. */
  readonly authorizationBindingDigest: string | null
  /** Present only for the first durable PREPARED→DISPATCHING transition. */
  /** In-process capability retained in a WeakMap; the raw HostKernel token is discarded here. */
  readonly sendAuthorization: ManagedProviderAuthorizationHandleV1 | null
  readonly revision: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

export type ManagedProviderRequestSettlementV1 = ManagedProviderRequestPinsV1 & {
  readonly status: "SETTLED" | "REPLAY"
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string
  readonly assistantEntryID: string
  readonly stepFinishIndex: number
  readonly responseDigest: string
  readonly usageDigest: string
  readonly revision: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

export type ManagedProviderRequestUnknownV1 = ManagedProviderRequestPinsV1 & {
  readonly status: "UNKNOWN" | "REPLAY"
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string
  readonly reasonCode: string
  readonly revision: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

/** HostKernel proof that the exact latest settled provider response ended a managed turn. */
export type ManagedProviderTurnCompletionV1 = {
  readonly status: "COMPLETED" | "REPLAY"
  readonly providerRequestID: string
  readonly assistantEntryID: string
  readonly responseDigest: string
  readonly usageDigest: string
  readonly dispatchSettlementDigest: string
  readonly requestSequence: string
  readonly completionReceiptDigest: string
  readonly managedAttempt: ManagedAttemptScopeV1
}

/** Authenticated projection of the exact P8 registered worktree selected by HostKernel. */
export type ManagedWorktreeTargetV1 = {
  readonly worktreeID: string
  readonly worktreeBaseRevision: string
  readonly worktreePoolRevision: string
  readonly locationID: string
  readonly workspaceID: string
  readonly workspaceRef: string
  /** HostKernel/P8-derived root used only to resolve Core Location services. */
  readonly canonicalRoot: string
  readonly workspaceRevision: string
}

/** Opaque proof for the same P8 reservation across pre-admission stages. */
type ManagedPreAdmissionProofPinsV1 = {
  readonly pinsDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly ownerEpoch: string
  readonly workerPoolRevision: string
  readonly workerExecutionID: string
  readonly ticketID: string
}

export type ManagedPreAdmissionProofV1 =
  | (ManagedPreAdmissionProofPinsV1 & { readonly proofDigest: string; readonly receiptDigest?: never; readonly leaseProofDigest: string })
  | (ManagedPreAdmissionProofPinsV1 & { readonly proofDigest: string; readonly receiptDigest: string; readonly leaseProofDigest: string })

export type ManagedPreAdmissionReservationV1 = {
  readonly status: "RESERVED_CONTEXT_UNBOUND" | "RESERVED_CONTEXT_BOUND"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly candidateAttemptID: string
  readonly taskRevision: string
  readonly preAdmissionProof: ManagedPreAdmissionProofV1
  readonly preAdmissionTarget: ManagedWorktreeTargetV1
  readonly contextSelectionDigest?: string
}

/** HostKernel-minted immutable pins for one logical managed child prompt. */
export type ManagedDispatchHandoffV1 = {
  readonly handoffID: string
  readonly handoffDigest: string
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly parentSessionID: string
  readonly attemptID: string
  readonly expectedManagedRevision: string
  readonly workerExecutionID: string
  readonly ownerEpoch: string
  readonly processIncarnation: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly acceptedSpecDigest: string
  readonly workspaceRevision: string
  readonly locationID: string
  readonly sessionID: string
  readonly contextSelectionDigest: string
  readonly acceptedScopeDigest: string
  readonly capabilityCeilingDigest: string
  readonly budgetDimension: string
  readonly budgetAmount: string
  readonly leaseExpiresAtMs: string
  readonly claimOwnerLogID: string
  readonly claimOwnerLogSequence: string
  readonly claimOwnerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly claimNonce: string
  readonly claimedProofDigest: string
  readonly workspaceLeaseID: string
  readonly budgetLeaseID: string
  readonly resourceLeaseIDs: readonly string[]
  readonly worktreeID: string
  readonly worktreeBaseRevision: string
  readonly worktreePoolRevision: string
  readonly worktreeTarget: ManagedWorktreeTargetV1
  readonly bindingDigest: string
  readonly pinsDigest: string
}

/** Durable no-replay fence receipt. It never authorizes a retry after ambiguity. */
export type ManagedDispatchConsumeReceiptV1 = {
  readonly status: "CONSUMED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly parentSessionID: string
  readonly sessionID: string
  readonly attemptID: string
  readonly handoffID: string
  readonly handoffDigest: string
  readonly claimedProofDigest: string
  readonly workerExecutionID: string
  readonly pinsDigest: string
  readonly bindingDigest: string
  readonly claimNonce: string
  readonly claimOwnerLogID: string
  readonly claimOwnerLogSequence: string
  readonly claimOwnerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly ownerEpoch: string
  readonly processIncarnation: string
  readonly deliveryID: string
  readonly corePID: number
  readonly coreStartIdentity: string
  readonly coreUID: number
  readonly coreGID: number
  readonly coreExecutableDigest: string
  readonly consumedManagedRevision: string
  readonly receiptDigest: string
  readonly worktreeTarget: ManagedWorktreeTargetV1
}

/** Core-owned durable child-session facts supplied only by Session service code. */
export type ManagedChildSessionCompletionProjectionV1 = {
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  readonly childSessionStateDigest: string
  readonly childSessionOutputDigest: string
  readonly childSessionOutputBytes: number
  readonly childSessionOutcomeKind: "assistant_completed" | "assistant_error" | "tool_error"
}

/** Durable proof that one consumed managed prompt callback returned. */
export type ManagedDispatchQuiescedReceiptV1 = {
  readonly status: "QUIESCED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly parentSessionID: string
  readonly sessionID: string
  readonly attemptID: string
  readonly handoffID: string
  readonly handoffDigest: string
  readonly consumeDeliveryID: string
  readonly consumeReceiptDigest: string
  readonly ownerEpoch: string
  readonly processIncarnation: string
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  readonly childSessionStateDigest: string
  readonly childSessionOutputDigest: string
  readonly childSessionOutputBytes: number
  readonly childSessionOutcomeKind: "assistant_completed" | "assistant_error" | "tool_error"
  readonly deliveryID: string
  readonly managedRevision: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly receiptDigest: string
}

/** P8 receipt for a successfully verified child; quarantine may retain the workspace. */
export type ManagedDispatchSettlementReceiptV1 = {
  readonly status: "SETTLED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly verificationRunID: string
  readonly setIdentityDigest: string
  readonly challengeSetDigest: string
  readonly workerExecutionID: string
  readonly disposition: "RELEASED" | "WORKTREE_QUARANTINED"
  readonly proofDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly receiptDigest: string
  readonly worktreeDisposition: {
    readonly ownerEpoch: string
    readonly disposition: "REUSABLE" | "QUARANTINED"
    readonly settlementReceiptDigest: string
    readonly finalWorktreeOperationID: string
    readonly finalWorktreeHostReceiptRef: string
    readonly observedWorkspaceRevision: string
    readonly inspectReceiptDigest: string
    readonly ownerLogID: string
    readonly ownerLogSequence: string
    readonly ownerLogEventDigest: string
    readonly workerPoolRevision: string
    readonly receiptDigest: string
  }
}

/** P8 quarantine receipt for failed/cancelled children; it carries no verifier-set pins. */
export type ManagedDispatchQuarantineReceiptV1 = {
  readonly status: "QUARANTINED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly workerExecutionID: string
  readonly ownerEpoch: string
  readonly reservationID: string
  readonly worktreeLeaseID: string
  readonly reason: "FAILED_ATTEMPT" | "CANCELLED_TASK"
  readonly terminalProofDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly receiptDigest: string
}

export type ManagedDispatchSettlementResultV1 = ManagedDispatchSettlementReceiptV1 | ManagedDispatchQuarantineReceiptV1

/** Bounded read from Rust's canonical DAG scheduler; task/Attempt selectors are never inferred by Core. */
export type ManagedReadyTaskSelectionV1 = {
  readonly status: "NO_TASK" | "READY_TASK"
  readonly goalID: string
  readonly runID: string
  readonly revision: string
  readonly runPhase: ManagedRunPhase
  readonly specID: string
  readonly specDigest: string
  readonly goalObjective: string
  readonly specConstraints: readonly string[]
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRef: string
  readonly task: null | {
    readonly taskID: string
    readonly title: string
    readonly purpose: string
    readonly candidateAttemptID: string
    readonly attemptCount: string
    readonly candidateGeneration: string
    readonly taskRevision: string
    readonly contextDigest: string
    readonly dependencies: readonly string[]
    readonly criterionIDs: readonly string[]
    readonly criteria: readonly { readonly criterionID: string; readonly description: string }[]
    readonly requiredCapabilities: readonly string[]
    /** Rust-derived token ceiling and remainder for this exact Task Attempt. */
    readonly effectiveMaxTokens: string
    readonly remainingTokens: string
    readonly profile: {
      readonly profileID: string
      readonly revision: string
      readonly definitionDigest: string
      readonly ownerBindingDigest: string
    }
  }
}

/** Authenticated read-only projection used only to reconcile an existing child after Core restart. */
export type ManagedActiveAttemptRecoveryV1 = {
  readonly goalID: string
  readonly runID: string
  readonly locationID: string
  readonly sessionID: string
  readonly revision: string
  readonly runPhase: ManagedRunPhase
} & (
  | {
    readonly status: "NO_ACTIVE_ATTEMPT"
    readonly task: null
    readonly attempt: null
  }
  | {
    readonly status: "ACTIVE_ATTEMPT"
    readonly specID: string
    readonly specDigest: string
    readonly goalObjective: string
    readonly specConstraints: readonly string[]
    readonly workspaceRef: string
    readonly task: {
      readonly taskID: string
      readonly title: string
      readonly purpose: string
      readonly candidateAttemptID: string
      readonly attemptCount: string
      readonly candidateGeneration: string
      readonly taskRevision: string
      readonly contextDigest: string
      readonly dependencies: readonly string[]
      readonly criterionIDs: readonly string[]
      readonly criteria: readonly { readonly criterionID: string; readonly description: string }[]
      readonly requiredCapabilities: readonly string[]
      /** Absent in Rust's read-only active-recovery projection; never inferred. */
      readonly effectiveMaxTokens?: string
      readonly remainingTokens?: string
      readonly profile: {
        readonly profileID: string
        readonly revision: string
        readonly definitionDigest: string
        readonly ownerBindingDigest: string
      }
    }
    readonly attempt: {
      readonly attemptID: string
      readonly sessionID: string
      readonly ownerEpoch: string
      readonly phase: "ADMITTED" | "EXECUTING" | "SETTLING" | "UNKNOWN" | "SUCCEEDED" | "FAILED"
      readonly runPhase: ManagedRunPhase
      readonly bindingDigest: string
      readonly unknownEffect: boolean
      readonly consumed: ManagedDispatchConsumeReceiptV1 | null
      readonly quiescence: ManagedDispatchQuiescedReceiptV1 | null
      readonly requestID?: string
      readonly requestSequence?: string
      readonly contextSelectionDigest?: string
      /** Full HostKernel authority scope, if a future producer can prove every pin. */
      readonly managedAttempt?: ManagedAttemptScopeV1
      /** Current producer's compact read-only pins; never usable for admission/effects. */
      readonly managedAttemptRecovery?: ManagedAttemptRecoveryPinsV1
      /** Exact durable initial provider selection, required to recover before consume. */
      readonly contextSelection?: ContextSelection
    }
  }
)

/**
 * Subset emitted by HostKernel while recovering an active managed Attempt.
 * Missing scope facts are intentionally not inferred; this type must never be
 * passed to admission or effect APIs that require ManagedAttemptScopeV1.
 */
export type ManagedAttemptRecoveryPinsV1 = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly ownerEpoch: string
  readonly expectedManagedRevision: string
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRevision: string
  readonly delegationBindingDigest: string
  readonly requestID: string | null
  readonly requestSequence: string | null
  readonly contextSelectionDigest: string | null
}

/** Exact authority envelope shared by the managed scheduler and Guard lease. */
export type ManagedAttemptScopeV1 = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  /** Canonical u64 decimal strings required by the private MessagePack contract. */
  readonly ownerEpoch: string
  readonly expectedManagedRevision: string
  /** Latest exact Core-compiled request context admitted at a provider boundary. */
  readonly requestSequence: string
  readonly requestID: string
  readonly contextSelectionDigest: string
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRevision: string
  /** HostKernel-computed min(SpecVersion.maxTokens, pinned profile tokenBudget). */
  readonly effectiveMaxTokens: string
  /** Durable usage ledger remainder bound into the authority digest; zero is exhausted and cannot dispatch. */
  readonly remainingTokens: string
  /** Required immutable Rust-owned DelegationBindingV1 digest. */
  readonly delegationBindingDigest: string
  /** Exact immutable permission set digest from the HostKernel DelegationBindingV1. */
  readonly permissionScopeDigest: string
  readonly worktreeTarget: ManagedWorktreeTargetV1
}

/** Usage receipts may report exhaustion; this projection is never a dispatch authority. */
export type ManagedAttemptUsageScopeV1 = Omit<ManagedAttemptScopeV1, "remainingTokens"> & {
  readonly remainingTokens: string
}

/**
 * Mutable authority for one live managed prompt. Scope updates must come from
 * HostKernel responses after a durable transition; callers cannot edit fields or
 * skip an intervening mutation with a request-body revision. Each accepted
 * transition represents one exact OwnerLog append.
 */
export type ManagedAttemptAuthority = {
  readonly currentScope: () => ManagedAttemptScopeV1
  readonly effectiveMaxTokens: () => string
  readonly remainingTokens: () => string
  readonly contextSelectionPin: () => Pick<ManagedAttemptScopeV1, "requestSequence" | "requestID" | "contextSelectionDigest">
  readonly markUsageStopped?: () => void
  readonly usageStopped?: () => boolean
  /** Latest exact HostKernel settlement recorded by settleManagedProviderRequest. */
  readonly latestProviderSettlement: () => ManagedProviderRequestSettlementV1 | undefined
  /** Internal callback used only after the strict SETTLED/REPLAY DTO has decoded. */
  readonly rememberProviderSettlement: (settlement: ManagedProviderRequestSettlementV1) => void
  readonly acceptRefreshedScope: (input: {
    readonly previous: ManagedAttemptScopeV1
    readonly refreshed: ManagedAttemptScopeV1
    readonly transition: "batch_bind" | "effect_receipt" | "usage_accounting" | "context_selection" | "provider_request" | "provider_settlement"
  }) => void
}

export function managedAttemptScopeToWire(scope: ManagedAttemptScopeV1): ManagedAttemptScopeV1 {
  const operation = "managed_attempt_scope"
  return managedAttemptScopeValue(operation, scope)
}

/** HostKernel's exact BLAKE3 digest of the current managed effect scope. */
export function managedAttemptEffectScopeDigest(scope: ManagedAttemptScopeV1): string {
  const wire = managedAttemptScopeValue("managed_attempt_scope_digest", scope)
  const bytes = encodeCanonicalMessagePackV1(wire, {
    maxEncodedBytes: 16 * 1024, maxDepth: 16, maxNodes: 512, maxCollectionItems: 128, maxScalarBytes: 4096,
  })
  return `blake3:${Array.from(blake3(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function sameManagedAttemptScope(left: ManagedAttemptScopeV1, right: ManagedAttemptScopeV1): boolean {
  return JSON.stringify(managedAttemptScopeValue("managed_attempt_scope", left)) ===
    JSON.stringify(managedAttemptScopeValue("managed_attempt_scope", right))
}

export function isNextManagedAttemptScope(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptScopeV1,
): boolean {
  const left = managedAttemptScopeValue("managed_attempt_scope", previous)
  const right = managedAttemptScopeValue("managed_attempt_scope", next)
  return sameManagedAttemptIdentity(left, right) &&
    left.workspaceRevision === right.workspaceRevision &&
    left.requestSequence === right.requestSequence && left.requestID === right.requestID && left.contextSelectionDigest === right.contextSelectionDigest &&
    left.remainingTokens === right.remainingTokens &&
    BigInt(right.expectedManagedRevision) === BigInt(left.expectedManagedRevision) + 1n
}

export function isReceiptAdvancedManagedAttemptScope(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptUsageScopeV1,
): boolean {
  const left = managedAttemptScopeValue("managed_attempt_scope", previous)
  const right = managedAttemptUsageScopeValue("managed_attempt_scope", next)
  return sameManagedAttemptIdentity(left, right) &&
    left.requestSequence === right.requestSequence && left.requestID === right.requestID && left.contextSelectionDigest === right.contextSelectionDigest &&
    BigInt(right.remainingTokens) <= BigInt(left.remainingTokens) &&
    BigInt(right.expectedManagedRevision) === BigInt(left.expectedManagedRevision) + 1n
}

/** Context may advance only one request at a time under a fresh durable revision. */
export function isContextAdvancedManagedAttemptScope(previous: ManagedAttemptScopeV1, next: ManagedAttemptScopeV1): boolean {
  const left = managedAttemptScopeValue("managed_context.advance", previous)
  const right = managedAttemptScopeValue("managed_context.advance", next)
  return sameManagedAttemptIdentity(left, right) &&
    left.workspaceRevision === right.workspaceRevision &&
    left.remainingTokens === right.remainingTokens &&
    BigInt(right.requestSequence) === BigInt(left.requestSequence) + 1n &&
    right.requestID !== left.requestID && right.contextSelectionDigest !== left.contextSelectionDigest &&
    BigInt(right.expectedManagedRevision) === BigInt(left.expectedManagedRevision) + 1n
}

function sameManagedAttemptIdentity(
  left: ManagedAttemptScopeV1,
  right: ManagedAttemptScopeV1,
): boolean {
  return left.goalID === right.goalID &&
    left.runID === right.runID &&
    left.taskID === right.taskID &&
    left.attemptID === right.attemptID &&
    left.ownerEpoch === right.ownerEpoch &&
    left.locationID === right.locationID &&
    left.sessionID === right.sessionID &&
    left.effectiveMaxTokens === right.effectiveMaxTokens &&
    left.delegationBindingDigest === right.delegationBindingDigest &&
    left.permissionScopeDigest === right.permissionScopeDigest &&
    JSON.stringify(left.worktreeTarget) === JSON.stringify(right.worktreeTarget)
}

export function createManagedAttemptAuthority(initial: ManagedAttemptScopeV1): ManagedAttemptAuthority {
  let current = managedAttemptScopeToWire(initial)
  let stopped = false
  let latestSettlement: ManagedProviderRequestSettlementV1 | undefined
  return Object.freeze({
    currentScope: () => current,
    effectiveMaxTokens: () => current.effectiveMaxTokens,
    remainingTokens: () => current.remainingTokens,
    contextSelectionPin: () => ({ requestSequence: current.requestSequence, requestID: current.requestID, contextSelectionDigest: current.contextSelectionDigest }),
    markUsageStopped: () => { stopped = true },
    usageStopped: () => stopped,
    latestProviderSettlement: () => latestSettlement,
    rememberProviderSettlement: (settlement) => {
      const exact = managedAttemptScopeToWire(settlement.managedAttempt)
      if (exact.attemptID !== current.attemptID || exact.ownerEpoch !== current.ownerEpoch ||
        exact.goalID !== current.goalID || exact.runID !== current.runID || exact.taskID !== current.taskID ||
        exact.sessionID !== current.sessionID || exact.requestSequence !== settlement.requestSequence ||
        exact.requestID !== settlement.requestID || exact.contextSelectionDigest !== settlement.contextSelectionDigest ||
        (!sameManagedAttemptScope(current, exact) && !isReceiptAdvancedManagedAttemptScope(current, exact))) {
        throw new Error("HostKernel provider settlement does not follow the current managed Attempt scope")
      }
      latestSettlement = Object.freeze({ ...settlement, managedAttempt: exact })
    },
    acceptRefreshedScope: ({ previous, refreshed, transition }) => {
      const prior = managedAttemptScopeToWire(previous)
      const next = managedAttemptScopeToWire(refreshed)
      const validTransition = transition === "batch_bind"
        ? isNextManagedAttemptScope(prior, next)
        : transition === "context_selection"
          ? isContextAdvancedManagedAttemptScope(prior, next)
          : transition === "provider_request"
            ? isNextManagedAttemptScope(prior, next)
            : (transition === "effect_receipt" || transition === "usage_accounting" || transition === "provider_settlement") && isReceiptAdvancedManagedAttemptScope(prior, next)
      if (!sameManagedAttemptScope(current, prior) || !validTransition) {
        throw new Error("HostKernel returned a stale or mismatched managed Attempt scope")
      }
      if (next.effectiveMaxTokens !== current.effectiveMaxTokens ||
        BigInt(next.remainingTokens) > BigInt(current.remainingTokens) ||
        (transition !== "usage_accounting" && next.remainingTokens !== current.remainingTokens)) {
        throw new Error("HostKernel changed the managed token ceiling outside its durable usage receipt")
      }
      current = next
      if (transition === "context_selection" || transition === "provider_request") latestSettlement = undefined
      if (next.remainingTokens === "0") stopped = true
    },
  })
}

export type ManagedAttemptUsageReceiptV1 = {
  readonly status: "ACCOUNTED" | "STOPPED"
  readonly operationKey: string
  readonly usageDigest: string
  readonly managedRevision: string
  readonly accountingCursor: string
  readonly tokenTotal: string
  readonly costMicrosTotal: string
  readonly providerID: string
  readonly modelID: string
  readonly operationID: string | null
  readonly requestID: string | null
  readonly costStatus: "provider-reported" | "measured" | "estimated" | "unknown"
  readonly metricStatuses: Readonly<Record<string, string>>
  readonly usageState: "KNOWN" | "ESTIMATED" | "UNKNOWN"
  readonly stopReason: "NONE" | "TOKEN_CEILING" | "COST_CEILING" | "USAGE_UNCERTAIN"
  readonly ceilingDigest: string
  readonly receiptDigest: string
  readonly managedAttempt: ManagedAttemptUsageScopeV1
}

/** Charge one provider step before the session processor can dispatch another. */
export const recordAttemptUsage = Effect.fn("ManagedControl.recordAttemptUsage")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly assistantMessageID: string
  readonly stepFinishIndex: number
  readonly usageProvenance: unknown
}) {
  const operation = "record_usage"
  const scope = yield* Effect.try({
    try: () => managedAttemptScopeValue(operation, input.scope),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope is malformed" }),
  })
  if (!Number.isSafeInteger(input.stepFinishIndex) || input.stepFinishIndex < 0) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "step finish index is invalid" }))
  }
  const provenance = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(SessionMessageSchema.UsageProvenance, { onExcessProperty: "error" })(input.usageProvenance),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "usage provenance is malformed" }),
  })
  const response = yield* call(operation, {
    managedAttempt: scope,
    assistantMessageID: identifier(operation, input.assistantMessageID, "assistantMessageID"),
    stepFinishIndex: String(input.stepFinishIndex),
    usageProvenance: provenance,
  })
  const expectedKeys = ["status", "goalID", "attemptID", "operationKey", "usageDigest", "managedRevision", "accountingCursor", "tokenTotal", "costMicrosTotal", "providerID", "modelID", "operationID", "requestID", "costStatus", "metricStatuses", "usageState", "stopReason", "ceilingDigest", "receiptDigest", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "usage receipt has an invalid shape" }))
  }
  const status = response.status
  if (status !== "ACCOUNTED" && status !== "STOPPED") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "usage accounting status is invalid" }))
  }
  const refreshed = managedAttemptUsageScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptUsageScopeV1)
  const operationKey = requiredText(operation, response, "operationKey", 256)
  if (!/^managed_usage_[0-9a-f]{64}$/.test(operationKey) || response.goalID !== scope.goalID || response.attemptID !== scope.attemptID) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "usage receipt identity is invalid" }))
  }
  const usageDigest = digestValue(operation, requiredText(operation, response, "usageDigest", 256), "usageDigest")
  const managedRevision = requiredRevision(operation, response, "managedRevision")
  const accountingCursor = requiredRevision(operation, response, "accountingCursor")
  const tokenTotal = requiredRevision(operation, response, "tokenTotal")
  const costMicrosTotal = requiredRevision(operation, response, "costMicrosTotal")
  const providerID = identifier(operation, requiredText(operation, response, "providerID", 256), "providerID")
  const modelID = identifier(operation, requiredText(operation, response, "modelID", 256), "modelID")
  const operationID = optionalText(operation, response, "operationID")
  const requestID = optionalText(operation, response, "requestID")
  const costStatus = requiredText(operation, response, "costStatus", 32) as ManagedAttemptUsageReceiptV1["costStatus"]
  if (!["provider-reported", "measured", "estimated", "unknown"].includes(costStatus)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "cost status is invalid" })
  const metricStatusesValue = requiredRecord(operation, response.metricStatuses, "metricStatuses")
  const metricStatuses: Record<string, string> = {}
  for (const [key, value] of Object.entries(metricStatusesValue)) {
    if (typeof value !== "string" || !["provider-reported", "measured", "estimated", "unknown"].includes(value)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "metric provenance status is invalid" })
    metricStatuses[key] = value
  }
  if (Object.keys(metricStatuses).toSorted().join("\0") !== ["cache.read", "cache.write", "input", "output", "reasoning"].toSorted().join("\0")) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "usage metric status set is incomplete" }))
  }
  const usageState = requiredText(operation, response, "usageState", 16) as ManagedAttemptUsageReceiptV1["usageState"]
  const stopReason = requiredText(operation, response, "stopReason", 32) as ManagedAttemptUsageReceiptV1["stopReason"]
  if (!["KNOWN", "ESTIMATED", "UNKNOWN"].includes(usageState) || !["NONE", "TOKEN_CEILING", "COST_CEILING", "USAGE_UNCERTAIN"].includes(stopReason) || (status === "STOPPED") !== (stopReason !== "NONE")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "usage stop projection is invalid" })
  if ((BigInt(refreshed.remainingTokens) === 0n) !== (status === "STOPPED")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "an exhausted Attempt must be stopped before another managed step" })
  const ceilingDigest = digestValue(operation, requiredText(operation, response, "ceilingDigest", 256), "ceilingDigest")
  const receiptDigest = digestValue(operation, requiredText(operation, response, "receiptDigest", 256), "receiptDigest")
  // The authority pins must be unchanged; only the usage-driven remainder and
  // the managed revision may differ, because the receipt itself reports the
  // new durable remainder (including exhaustion to zero).
  const sameAuthorityPins = (() => {
    const stripUsage = (value: unknown) =>
      JSON.stringify(value, (key, entry) => (key === "remainingTokens" ? undefined : entry))
    return (
      stripUsage(managedAttemptScopeValue("managed_attempt_scope", scope)) ===
      stripUsage(
        managedAttemptScopeValue("managed_attempt_scope", {
          ...refreshed,
          expectedManagedRevision: scope.expectedManagedRevision,
        }),
      )
    )
  })()
  if (!isReceiptAdvancedManagedAttemptScope(scope, refreshed) || refreshed.expectedManagedRevision !== managedRevision || accountingCursor !== managedRevision || !sameAuthorityPins) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "usage receipt does not advance the exact live Attempt" })
  }
  return {
    status, operationKey, usageDigest, managedRevision, accountingCursor, tokenTotal, costMicrosTotal,
    providerID, modelID, operationID, requestID, costStatus, metricStatuses, usageState, stopReason,
    ceilingDigest, receiptDigest, managedAttempt: refreshed,
  } satisfies ManagedAttemptUsageReceiptV1
})

/** One durable Attempt-to-effect edge for a settled effect of this Location. */
export type AttemptEffectBound = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly effectID: string
  readonly locationID: string
  readonly revision: string
}

export type ManagedAttemptSettlement = {
  readonly outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly attemptPhase: ManagedAttemptPhase
  readonly runPhase: ManagedRunPhase
  /** Kernel-computed composite receipt; null when no effect backed this settlement. */
  readonly receiptDigest: string | null
  readonly revision: string
}

/** Durable Run phase change from pause, resume or cancel. */
export type ManagedRunPhaseChange = {
  readonly status: "PAUSED" | "RUNNING" | "CANCELLED" | "CANCELLING"
  readonly goalID: string
  readonly runID: string
  readonly runPhase: ManagedRunPhase
  readonly revision: string
}

type VerificationStartedBase = {
  readonly schemaVersion: 1
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly ownerEpoch: string
  readonly specID: string
  readonly specDigest: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly evidencePlanDigest: string
  /** Kernel-computed final integrated Revision the verifier is bound to. */
  readonly finalRevision: string
  readonly verificationRunID: string
  readonly setIdentityDigest: string
  /** Digest of the exact HostKernel-owned challenge set, used for atomic resolution. */
  readonly challengeSetDigest: string
  readonly revision: string
}

type ManagedVerificationApprovalLocationV1 = {
  readonly locationID: string
  readonly workspaceID: string
  readonly canonicalRoot: string
  readonly workspaceRevision: string
}

type VerificationStarted = VerificationStartedBase & (
  | {
    readonly status: "NEEDS_APPROVAL" | "RESUME_EXECUTION"
    readonly approvalLocation: ManagedVerificationApprovalLocationV1
    readonly challenges: ReadonlyArray<VerifierApprovalChallenge>
  }
  | {
    readonly status: "SETTLING"
    readonly approvalLocation: ManagedVerificationApprovalLocationV1
    readonly challenges: readonly []
    readonly sourceRevision: string
    readonly evidenceDigest: string
    readonly artifactRefs: readonly VerifierCriterionArtifactsV1[]
    readonly settlementCandidate: ManagedSettlementCandidateV1
  }
  | {
    readonly status: "UNKNOWN"
    readonly sourceRevision: string
    readonly reason: ManagedVerifierUnknownReasonV1
  }
)

type ManagedSettlementCandidateV1 = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly bindingDigest: string
  readonly specID: string
  readonly specDigest: string
  readonly evidenceDigest: string
  readonly finalRevision: string
  readonly effectChainDigest: string
  readonly attemptStateDigest: string
  readonly usageAccounting: ManagedAttemptUsageSummaryV1
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly managedRevision: string
}

type ManagedAttemptUsageSummaryV1 = {
  readonly accountingCursor: string
  readonly tokenKnownSubtotal: string
  readonly costKnownSubtotalMicros: string
  readonly tokenRemainderStatus: "KNOWN" | "ESTIMATED" | "UNKNOWN"
  readonly costRemainderStatus: "KNOWN" | "ESTIMATED" | "UNKNOWN"
  readonly usageState: "KNOWN" | "ESTIMATED" | "UNKNOWN"
  readonly stopReason: "NONE" | "TOKEN_CEILING" | "COST_CEILING" | "USAGE_UNCERTAIN"
  readonly ceilingDigest: string
  readonly costStatus: string
  readonly metricStatuses: Readonly<Record<string, string>>
  readonly receiptCount: string
  readonly receiptChainDigest: string
}

type ManagedFinalInspectReceiptV1 = {
  readonly operationID: string
  readonly hostReceiptRef: string
  readonly workspaceRevision: string
  readonly worktreeStatus: "CLEAN" | "DIRTY_OWNED" | "DIRTY_UNATTRIBUTED" | "MISSING" | "UNKNOWN"
  readonly dirtyEntryCount: string
  readonly dirtyEntriesDigest: string
  readonly containsUserOwnedChanges: boolean
  readonly owned: boolean
  readonly noFollow: boolean
}

export type VerifierArtifactRefV1 = {
  readonly artifactID: string
  readonly digest: string
  readonly byteLength: string
  readonly mediaType: string
  readonly classification: "PUBLIC" | "WORKSPACE" | "SENSITIVE"
}

export type VerifierCriterionArtifactsV1 = {
  readonly criterionID: string
  readonly artifactRefs: readonly VerifierArtifactRefV1[]
}

/** Safe public projection; challenge, lease, output and artifact facts stay private. */
export type VerificationRunResult =
  | {
      readonly status: "ABORTED"
      readonly goalID: string
      readonly runID: string
      readonly taskID: string
      readonly attemptID: string
      readonly finalRevision: string
      readonly verificationRunID: string
      readonly setIdentityDigest: string
      readonly challengeSetDigest: string
      readonly reason: VerificationAbortReason
      readonly revision: string
    }
  | {
      readonly status: VerificationExecutionStatus
      readonly goalID: string
      readonly runID: string
      readonly taskID: string
      readonly attemptID: string
      readonly finalRevision: string
      readonly challengeSetDigest: string
      readonly setIdentityDigest: string
      /** HostKernel workspace revision observed when this verifier execution settled. */
      readonly sourceRevision: string
      /** HostKernel reason for an UNKNOWN execution; never a completion verdict. */
      readonly reason?: ManagedVerifierUnknownReasonV1
      readonly evidenceDigest?: string
      readonly artifactRefs?: readonly VerifierCriterionArtifactsV1[]
      readonly usageAccounting?: ManagedAttemptUsageSummaryV1
      /** Flat durable refs used only by the terminal restart-recovery projection. */
      readonly recoveredArtifactRefs?: readonly VerifierArtifactRefV1[]
      /** Private HostKernel proof pin consumed before the independent Inspect/settlement sequence. */
      readonly settlementCandidate?: ManagedSettlementCandidateV1
      readonly dispatchSettlement?: ManagedDispatchSettlementResultV1
      readonly verificationRunID: string
      readonly revision: string
    }

type VerificationAbortReason = "reviewer_denied" | "cancelled" | "expired" | "transport_lost"
type ManagedVerifierUnknownReasonV1 =
  | "cancelled_before_next_test"
  | "guarded_execution_unavailable"
  | "execution_outcome_unknown"
  | "workspace_revision_changed"
  | "verification_incomplete"

const MANAGED_VERIFIER_UNKNOWN_REASONS = new Set<ManagedVerifierUnknownReasonV1>([
  "cancelled_before_next_test",
  "guarded_execution_unavailable",
  "execution_outcome_unknown",
  "workspace_revision_changed",
  "verification_incomplete",
])

type VerificationExecutionStatus =
  | "VERIFYING"
  | "SETTLING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "NEEDS_YOU"
  | "CANCELLING"
  | "CANCELLED"

type VerifierApprovalChallenge = {
  readonly criterionID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityID: "builtin.verifier"
  readonly locationID: string
  readonly inputDigest: string
  readonly normalizedTargets: ReadonlyArray<unknown>
  readonly expiresAtUnixMs: number
  readonly policySummary: string
  readonly origin: "managed_run"
  readonly source: "host.managed_verifier"
  readonly policyID: string
  readonly policyDigest: string
  readonly normalizedAction: "builtin.verifier"
  readonly argumentSummary: GuardArgumentSummaryV1
  readonly requestedGuarantees: ReadonlyArray<string>
  readonly guaranteeAssessment: GuardGuaranteeAssessmentV1
  readonly runID: string
  readonly noResponse: "deny_and_expire"
  readonly allowEnabled: false
}

export type TaskVerified = {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly verifierID: string
  readonly sourceRevision: string
  readonly evidenceDigest: string
  readonly revision: string
}

export type CriterionEvidenceRecorded = {
  readonly goalID: string
  readonly runID: string
  readonly criterionID: string
  readonly sourceRevision: string
  readonly evidenceDigest: string
  readonly revision: string
}

export type RunFinalized = {
  readonly goalID: string
  readonly runID: string
  readonly runPhase: ManagedRunPhase
  readonly revision: string
}

export interface HostRunDispatchBindingV1 {
  readonly schemaVersion: 1
  readonly dispatchKeyDigest: string
  readonly manifestDigest: string
  readonly evaluatorTaskId: string
  readonly armId: string
  readonly taskGroup: string
  readonly runId: string
  readonly managedTaskId: string
  readonly attemptId: string
  readonly evaluationSessionId: string
  readonly coreProcessGeneration: string
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly workerExecutionId: string
  readonly delegationBindingDigest: string
  readonly acceptedSpecDigest: string
  readonly providerSelectionDigest: string
  readonly workspaceBindingDigest: string
  readonly admittedWorkspaceRevision: string
  readonly attemptScopeDigest: string
  readonly ownerPrincipalBindingDigest: string
  readonly bindingDigest: string
}

export interface HostRunDispatchBindingReceiptV1 {
  readonly schemaVersion: 1
  readonly dispatchKeyDigest: string
  readonly bindingDigest: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly bindingManagedRevision: string
}

export interface HostRunDispatchP8OwnerReceiptV1 {
  readonly schemaVersion: 1
  readonly dispatchKeyDigest: string
  readonly bindingDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
}

export interface HostRunReconciliationV1 {
  readonly schemaVersion: 1
  readonly dispatchKeyDigest: string
  readonly status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN"
  readonly unknownReason?: string
  readonly binding?: HostRunDispatchBindingV1
  readonly bindingDigest?: string
  readonly attemptReceiptDigest?: string
  readonly verifiedRevision?: string
}

export interface HostRunBindResultV1 {
  readonly schemaVersion: 1
  readonly binding: HostRunDispatchBindingV1
  readonly receipt: HostRunDispatchBindingReceiptV1
}

export interface HostRunBindReceiptResultV1 {
  readonly schemaVersion: 1
  readonly status: "RECORDED"
  readonly receipt: HostRunDispatchP8OwnerReceiptV1
}

/**
 * The intersected facts one direct subagent dispatch is bound to.
 *
 * Contract decision (P2, 2026-10-25): `profileRevision`/`profileHarness`/
 * `profileDefinition` are intentionally **not** part of this bundle. The profile
 * pin is bound on the `DirectAttemptScopeV1` wire envelope
 * (`profileID`/`profileRevision`/`profileDigest`), which HostKernel validates
 * with its owner binding, while these facts pin the effective dispatch policy
 * the digest exists to detect changing (agent/provider/model, permission rules,
 * denied tools, budget, depth). Neither `arch_V1/12-DOMAIN-SCHEMAS.md` nor
 * `contracts-v2` defines a schema for this TS-local bundle, so adding profile
 * fields would be a wire-visible digest change with no added authority. The
 * three excess call-site facts removed by P7 stay removed.
 */
export type DirectScopeFacts = {
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly agent: string
  readonly providerID: string
  readonly modelID: string
  readonly workspaceRoot: string
  /** Canonical `permission:pattern:action` rules the child inherits. */
  readonly permissionRules: readonly string[]
  /** Tools the child may not call, sorted. */
  readonly deniedTools: readonly string[]
  readonly background: boolean
  readonly maxAttempts: number
  readonly subagentDepth: number
}

/** Typed child result whose digest is recorded on a settlement. */
export type DirectResultPayload = {
  readonly childSessionID: string
  readonly agent: string
  readonly state: "completed" | "failed"
  /** `sha256:` digest of the exact child output text. */
  readonly outputDigest: string
  readonly outputBytes: number
}

export interface Interface {
  /** True when this build has an authenticated host-kernel channel. */
  readonly available: () => Effect.Effect<boolean, never, SessionSupervisorService>
  /** Creates the Goal and its first immutable proposal in one durable event. */
  readonly createGoalProposal: (
    input: GoalProposalInput & { readonly trustedPrincipal?: TrustedPrincipal },
  ) => Effect.Effect<GoalProposalCreated, ManagedControlError, SessionSupervisorService>
  /** Read-only, bounded projection of pending proposals for one durable Goal. */
  readonly goalReviewSnapshot: (
    goalID: string,
    trustedPrincipal: TrustedPrincipal,
  ) => Effect.Effect<GoalReviewSnapshot, ManagedControlError, SessionSupervisorService>
  /** Bounded durable discovery projection for the Core-to-TUI review inbox. */
  readonly listPendingReviews: (
    trustedPrincipal: TrustedPrincipal,
  ) => Effect.Effect<PendingGoalReviews, ManagedControlError, SessionSupervisorService>
  /** Claims one pending proposal for the authenticated ServerAuth reviewer. */
  readonly assignSpecReviewer: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly specID: string
    readonly specDigest: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<{ readonly reviewerID: string; readonly decisionRevision: string }, ManagedControlError, SessionSupervisorService>
  /**
   * Accepts one proposed SpecVersion digest. Requires an authenticated reviewer
   * principal distinct from the proposer. The HTTP ServerAuth middleware must
   * derive that principal from a configured distinct reviewer credential; local
   * host identity cannot claim the reviewer role. Rust durably assigns that
   * identity before the revision-bound decision.
   */
  readonly acceptSpec: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly specID: string
    readonly specDigest: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<SpecDecision, ManagedControlError, SessionSupervisorService>
  readonly rejectSpec: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly specID: string
    readonly specDigest: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<SpecDecision, ManagedControlError, SessionSupervisorService>
  /** Creates an accepted-SpecVersion Run and pinned-profile Tasks, without readiness or dispatch. */
  readonly createRunPlan: (
    input: GoalRunPlanInput,
  ) => Effect.Effect<GoalRunPlanResult, ManagedControlError, SessionSupervisorService | AgentProfileService | TrustedPrincipalContext>
  readonly startPlannedRun: (
    input: GoalRunStartInput,
  ) => Effect.Effect<RunStarted, ManagedControlError, SessionSupervisorService | TrustedPrincipalContext>
  /** Registers the authenticated Core process as this Run's logical root coordinator after start. */
  readonly registerRootCoordinator: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly sessionID: string
    readonly locationID: string
  }) => Effect.Effect<void, ManagedControlError, SessionSupervisorService>
  /** Registers only the explicit user-configured Git executable before worktree-backed admission. */
  readonly registerTrustedGitProfile: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly locationRef: typeof Location.Ref.Type
  }) => Effect.Effect<void, ManagedControlError, SessionSupervisorService | LocationServiceMap.Service>
  /**
   * Admits and starts one Attempt for a ready managed Task. The authenticated
   * executor principal is derived by the kernel from the connection; a stale
   * revision, a reused Attempt id or a non-ready Task fails closed.
   *
   * The emitted body is exactly Rust's closed `admit` key set: the 12
   * pre-admission common keys plus `managedProviderRoute` and `attemptID`, with
   * no optional keys. `profileSelection` selects and validates the profile but is
   * deliberately **not** sent — HostKernel rejects any unlisted key. The two
   * `resourcePolicyProjection*` values are the HostKernel-minted pin for this
   * exact candidate (`resource-policy.ingress-v1` / `project_policy`); without
   * them this function fails closed instead of sending a body Rust refuses.
   */
  readonly admitAttempt: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly verifier?: ManagedVerifierSettlementPinsV1
    readonly parentSessionID: string
    readonly locationID: string
    readonly sessionID: string
    readonly expectedRevision: ManagedRevision
    readonly profileSelection: { readonly profileId: string; readonly revision: string }
    /** Stable Stage-B receipt identity from the same P8 reservation; HostKernel resolves the current lease proof. */
    readonly preAdmissionProofDigest: string
    readonly contextSelection: ContextSelection
    /** Canonical decimal projection revision from `project_policy`; required by Rust `admit`. */
    readonly resourcePolicyProjectionRevision: string
    /** BLAKE3 projection digest from `project_policy`; required by Rust `admit`. */
    readonly resourcePolicyProjectionDigest: string
  }) => Effect.Effect<ManagedAttemptAdmission, ManagedControlError, SessionSupervisorService | AgentProfileService | ProviderService | Auth.Service>
  /** Persist the exact next model-visible selection before its provider request. */
  readonly advanceManagedContext: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly contextSelection: ContextSelection
  }) => Effect.Effect<ManagedContextAdvanceReceiptV1, ManagedControlError, SessionSupervisorService>
  /** Persist an exact provider route/input intent before taking one-use send authority. */
  readonly prepareManagedProviderRequest: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly routeProjection: ManagedProviderRouteProjectionV1
    readonly requestPins: ManagedProviderInputPinsV1
    readonly contextSelection: ContextSelection
    readonly profileSelection: { readonly profileId: string; readonly revision: string }
  }) => Effect.Effect<ManagedProviderRequestPreparedV1, ManagedControlError, SessionSupervisorService | AgentProfileService>
  /** Present the host-minted provider challenge through the Guard UI and durably
   * resolve the exact decision before any begin/send transition. */
  readonly awaitManagedProviderApproval: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly routeProjection: ManagedProviderRouteProjectionV1
    readonly requestPins: ManagedProviderInputPinsV1
    readonly challenge: ManagedProviderGuardChallengeV1
  }) => Effect.Effect<ManagedProviderApprovalResultV1, ManagedControlError, SessionSupervisorService | TrustedPrincipalContext>
  /** Consume PREPARED once, immediately before network dispatch. Replay has no send authorization. */
  readonly beginManagedProviderRequest: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly providerRequestID: string
    readonly prepareDigest: string
    readonly routeProjection: ManagedProviderRouteProjectionV1
    readonly requestPins: ManagedProviderInputPinsV1
  }) => Effect.Effect<ManagedProviderRequestDispatchV1, ManagedControlError, SessionSupervisorService>
  /** Settle only after the exact assistant response entry is durably committed. */
  readonly settleManagedProviderRequest: (input: {
    readonly authority: ManagedAttemptAuthority
    readonly scope: ManagedAttemptScopeV1
    readonly providerRequestID: string
    readonly prepareDigest: string
    readonly dispatchDigest: string
    readonly transportRequestDigest: string
    readonly operationDigest: string
    readonly assistantEntryID: string
    readonly stepFinishIndex: number
    readonly responseDigest: string
    readonly usageProvenance: SessionMessageSchema.UsageProvenance
  }) => Effect.Effect<ManagedProviderRequestSettlementV1, ManagedControlError, SessionSupervisorService>
  /** Rehydrate an exact latest settlement from HostKernel after Core restart. */
  readonly inspectLatestManagedProviderSettlement: (input: {
    readonly scope: ManagedAttemptScopeV1
  }) => Effect.Effect<ManagedProviderRequestSettlementV1, ManagedControlError, SessionSupervisorService>
  /** Mint a one-use fresh-turn receipt from the latest exact provider settlement. */
  readonly completeManagedProviderTurn: (input: {
    readonly authority: ManagedAttemptAuthority
    readonly assistantEntryID: string
  }) => Effect.Effect<ManagedProviderTurnCompletionV1, ManagedControlError, SessionSupervisorService>
  /** Fence an uncertain DISPATCHING request; owner/restart recovery never grants retry. */
  readonly markManagedProviderRequestUnknown: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly providerRequestID: string
    readonly prepareDigest: string
    readonly dispatchDigest: string
    readonly transportRequestDigest: string
    readonly operationDigest: string
    readonly reasonCode: string
  }) => Effect.Effect<ManagedProviderRequestUnknownV1, ManagedControlError, SessionSupervisorService>
  /** Claims the exact live P8-bound Attempt and returns a HostKernel-pinned profile projection. */
  readonly claimManagedDispatch: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly parentSessionID: string
    readonly attemptID: string
    readonly profileSelection: { readonly profileId: string; readonly revision: string }
    readonly deliveryID: string
  }) => Effect.Effect<ManagedDispatchHandoffV1 & { readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2 }, ManagedControlError, SessionSupervisorService | AgentProfileService>
  /** Durably consumes one handoff before Core may invoke the provider; never grants retry. */
  readonly consumeManagedDispatch: (input: {
    readonly handoff: ManagedDispatchHandoffV1
    readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2
    readonly deliveryID: string
  }) => Effect.Effect<ManagedDispatchConsumeReceiptV1, ManagedControlError, SessionSupervisorService>
  /** Selects one dependency-ready Task through Rust's authoritative bounded DAG scheduler. */
  readonly nextSchedulableTask: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly locationID: string
    readonly sessionID: string
    readonly expectedRevision: string
  }) => Effect.Effect<ManagedReadyTaskSelectionV1, ManagedControlError, SessionSupervisorService>
  /**
   * Binds the one pre-dispatch EffectIntent to the Attempt and exact Guard scope.
   */
  readonly bindAttemptEffect: (input: {
    readonly scope: ManagedAttemptScopeV1
    readonly effectID: string
  }) => Effect.Effect<AttemptEffectBound, ManagedControlError, SessionSupervisorService>
  /**
   * Settles one executing Attempt. A `succeeded` outcome requires at least one
   * bound effect with an authoritative kernel receipt; `unknown` durably fences
   * the Run as RECONCILING.
   */
  readonly settleAttempt: (input: {
    readonly trustedPrincipal?: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly outcome: "succeeded" | "failed" | "unknown"
    readonly expectedRevision: ManagedRevision
    readonly failureCode?: string
    readonly retryable?: boolean
  }) => Effect.Effect<ManagedAttemptSettlement, ManagedControlError, SessionSupervisorService>
  /** Releases/quarantines the logical WorkerPool lease after terminal settlement and quiescence. */
  readonly settleManagedDispatch: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly deliveryID: string
    readonly finalRevision?: string
    readonly finalInspect?: ManagedFinalInspectReceiptV1
    readonly verifier?: ManagedVerifierSettlementPinsV1
  }) => Effect.Effect<ManagedDispatchSettlementResultV1, ManagedControlError, SessionSupervisorService>
  readonly pauseRun: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<ManagedRunPhaseChange, ManagedControlError, SessionSupervisorService>
  readonly resumeRun: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<ManagedRunPhaseChange, ManagedControlError, SessionSupervisorService>
  /**
   * Records the durable cancellation intent. Cancellation completes only once no
   * Attempt is active or UNKNOWN; repeating the call is idempotent.
   */
  readonly cancelRun: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly runID: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<ManagedRunPhaseChange, ManagedControlError, SessionSupervisorService>
  /**
   * Runs the HostKernel verifier lifecycle: freezes the final integrated Revision,
   * gathers distinct-reviewer Guard approvals, and accepts only typed independent
   * evidence bound to the same live Attempt and workspace revision.
   */
  readonly runVerification: (input: {
    readonly goalID: string
    readonly runID: string
    readonly locationRef: typeof Location.Ref.Type
    readonly sessionID?: string
  }) => Effect.Effect<VerificationRunResult, ManagedControlError, SessionSupervisorService | TrustedPrincipalContext>
  /**
   * Verifies one settled Attempt as an authenticated independent verifier.
   * Refused with `independent_verifier_required` for the local OS-uid principal.
   */
  readonly verifyTask: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
  }) => Effect.Effect<TaskVerified, ManagedControlError, SessionSupervisorService>
  /**
   * Legacy digest-only criterion evidence is unavailable. Typed criterion evidence
   * is recorded only from the HostKernel verifier lifecycle above.
   */
  readonly recordCriterionEvidence: (input: {
    readonly goalID: string
    readonly runID: string
    readonly criterionID: string
  }) => Effect.Effect<CriterionEvidenceRecorded, ManagedControlError, SessionSupervisorService>
  /**
   * Finalizes a Run only after fresh typed verifier evidence covers every accepted
   * criterion at the frozen finalRevision.
   */
  readonly finalizeRun: (input: {
    readonly goalID: string
    readonly runID: string
  }) => Effect.Effect<RunFinalized, ManagedControlError, SessionSupervisorService>
  /** Read-only HostRun reconciliation/inspect join. Resolves durable pre-dispatch binding and joins with P1 ToolBatch projection. */
  readonly hostRunInspect: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly dispatchKeyDigest: string
  }) => Effect.Effect<HostRunReconciliationV1, ManagedControlError, SessionSupervisorService>
  /** Authenticated pre-dispatch append for the private HostRunDispatchBindingV1. */
  readonly hostRunBind: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly attemptID: string
    readonly dispatchKeyDigest: string
  }) => Effect.Effect<HostRunBindResultV1, ManagedControlError, SessionSupervisorService>
  /** Authenticated post-commit OwnerLog receipt append for an already-committed HostRun binding. */
  readonly hostRunBindReceipt: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly dispatchKeyDigest: string
    readonly bindingDigest: string
    readonly ownerLogID: string
    readonly ownerLogSequence: string
    readonly ownerLogEventDigest: string
  }) => Effect.Effect<HostRunBindReceiptResultV1, ManagedControlError, SessionSupervisorService>
  /** Full reconciliation chain for HostRun: verifies terminal status and authority chain. */
  readonly reconcileHostRun: (input: {
    readonly trustedPrincipal: TrustedPrincipal
    readonly goalID: string
    readonly dispatchKeyDigest: string
  }) => Effect.Effect<HostRunReconciliationV1, ManagedControlError, SessionSupervisorService>
  readonly admitDirectAttempt: (input: {
    readonly attemptID: string
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly agent: string
    readonly scopeDigest: string
    readonly locationID: string
    readonly workspaceID: string
    readonly capabilityDigest: string
    readonly permissionsDigest: string
    readonly budgetDigest: string
  }) => Effect.Effect<DirectAttemptAdmission, ManagedControlError, SessionSupervisorService>
  readonly bindDirectAttemptEffects: (input: {
    readonly scope: DirectAttemptScopeV1
    readonly effectIDs: readonly string[]
  }) => Effect.Effect<DirectAttemptEffectBound, ManagedControlError, SessionSupervisorService>
  readonly settleDirectAttempt: (input: {
    readonly attemptID: string
    readonly outcome: "succeeded" | "failed" | "unknown"
    readonly expectedRevision: string | number
    readonly resultDigest?: string
    readonly failureCode?: string
    readonly retryable?: boolean
  }) => Effect.Effect<DirectAttemptSettlement, ManagedControlError, SessionSupervisorService>
  readonly cancelDirectAttempt: (input: {
    readonly attemptID: string
    readonly expectedRevision: string | number
  }) => Effect.Effect<DirectAttemptSnapshot, ManagedControlError, SessionSupervisorService>
  readonly snapshotDirectAttempt: (
    attemptID: string,
  ) => Effect.Effect<DirectAttemptSnapshot, ManagedControlError, SessionSupervisorService>
  /** Fresh one-use Attempt id for one dispatch. */
  readonly newAttemptID: () => string
  /** Canonical `sha256:` digest of the intersected dispatch scope. */
  readonly scopeDigest: (facts: DirectScopeFacts) => string
  /** Canonical `sha256:` digest of a typed child result payload. */
  readonly resultDigest: (payload: DirectResultPayload) => string
  /** `sha256:` digest of arbitrary output text, as recorded in a result payload. */
  readonly outputDigest: (output: string) => string
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

function identifier(operation: string, value: string, key: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a bounded identifier` })
  }
  return value
}

function digestValue(operation: string, value: string, key: string): string {
  if (typeof value !== "string" || !CANONICAL_DIGEST.test(value)) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: `${key} is not a canonical digest`,
    })
  }
  return value
}

function decodeSha256Digest(operation: string, value: string, key: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a canonical SHA-256 digest` })
  }
  return value
}

function decodeBlake3Digest(operation: string, value: string, key: string): string {
  const digest = digestValue(operation, value, key)
  if (!digest.startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
  }
  return digest
}

function ownerEventDigest(operation: string, value: unknown): string {
  if (typeof value !== "string" || !/^(?:blake3:)?[0-9a-f]{64}$/.test(value)) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "ownerLogEventDigest is not a canonical OwnerLog event digest",
    })
  }
  return value
}

function requiredText(operation: string, source: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = source[key]
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is missing or invalid` })
  }
  return value
}

function optionalText(operation: string, source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is invalid` })
  }
  return value
}

function integer(operation: string, value: unknown, key: string): number {
  // Rust encodes unsigned integers with the smallest MessagePack form, so larger values
  // arrive as BigInt while small ones arrive as numbers.
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is out of range` })
    }
    return Number(value)
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a safe integer` })
  }
  return value
}

function requiredInteger(operation: string, source: Record<string, unknown>, key: string): number {
  return integer(operation, source[key], key)
}

const MAX_U64 = (1n << 64n) - 1n

function unsignedRevision(operation: string, value: unknown, key: string): bigint {
  const revision =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : undefined
  if (revision === undefined || revision < 0n || revision > MAX_U64) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a u64 revision` })
  }
  return revision
}

function directAttemptExpectedRevision(operation: string, value: unknown): bigint {
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
      throw new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "expectedRevision is not a canonical decimal u64",
      })
    }
    const revision = BigInt(value)
    if (revision > MAX_U64) {
      throw new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "expectedRevision is not a u64 revision",
      })
    }
    return revision
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }
  if (typeof value === "bigint" && value >= 0n && value <= MAX_U64) {
    return value
  }
  throw new ManagedControlError({
    operation,
    code: "managed_protocol",
    reason: "expectedRevision is not a canonical decimal revision",
  })
}

function expectedRevision(operation: string, value: unknown): bigint {
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) {
      throw new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "expectedRevision is not a canonical decimal u64",
      })
    }
    return unsignedRevision(operation, BigInt(value), "expectedRevision")
  }
  return unsignedRevision(operation, value, "expectedRevision")
}

function requiredRevision(operation: string, source: Record<string, unknown>, key: string): string {
  return unsignedRevision(operation, source[key], key).toString()
}

function optionalRevision(operation: string, source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (value === null || value === undefined) return null
  return unsignedRevision(operation, value, key).toString()
}

function optionalDecimalU64(operation: string, source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a canonical decimal u64 string` })
  }
  canonicalDecimalU64(operation, value, key)
  return value
}

function requiredBoolean(operation: string, source: Record<string, unknown>, key: string): boolean {
  const value = source[key]
  if (typeof value !== "boolean") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a boolean` })
  }
  return value
}

function optionalBoolean(operation: string, source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "boolean") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a boolean` })
  }
  return value
}

function stringList(operation: string, value: readonly string[], key: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a bounded list` })
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > 4096) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} contains an invalid item` })
    }
    return item
  })
}

function sortedUniqueIdentifiers(operation: string, value: readonly string[], key: string): string[] {
  const list = stringList(operation, value, key).map((item) => identifier(operation, item, key))
  for (let index = 1; index < list.length; index++) {
    if (list[index - 1] >= list[index]) {
      throw new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: `${key} must be strictly sorted and contain no duplicates`,
      })
    }
  }
  return list
}

function canonicalDecimalU64(operation: string, value: string, key: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_U64) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a canonical u64` })
  }
  return BigInt(value)
}

function requiredDecimalU64(operation: string, source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== "string") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a canonical decimal u64 string` })
  }
  canonicalDecimalU64(operation, value, key)
  return value
}

function requiredPositiveDecimalU64(operation: string, source: Record<string, unknown>, key: string): string {
  const value = requiredDecimalU64(operation, source, key)
  if (value === "0") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must be a positive decimal u64` })
  }
  return value
}

function decodeManagedWorktreeTarget(operation: string, raw: unknown): ManagedWorktreeTargetV1 {
  const value = requiredRecord(operation, raw, "worktreeTarget")
  const keys = ["worktreeID", "worktreeBaseRevision", "worktreePoolRevision", "locationID", "workspaceID", "workspaceRef", "canonicalRoot", "workspaceRevision"]
  if (Object.keys(value).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed worktree target has an invalid shape" })
  }
  const result = {
    worktreeID: identifier(operation, requiredText(operation, value, "worktreeID", 256), "worktreeID"),
    worktreeBaseRevision: requiredText(operation, value, "worktreeBaseRevision", 256),
    worktreePoolRevision: requiredDecimalU64(operation, value, "worktreePoolRevision"),
    locationID: identifier(operation, requiredText(operation, value, "locationID", 256), "locationID"),
    workspaceID: identifier(operation, requiredText(operation, value, "workspaceID", 256), "workspaceID"),
    workspaceRef: requiredText(operation, value, "workspaceRef", 2048),
    canonicalRoot: requiredText(operation, value, "canonicalRoot", 4096),
    workspaceRevision: digestValue(operation, requiredText(operation, value, "workspaceRevision", 256), "workspaceRevision"),
  }
  if (!result.worktreeBaseRevision || !result.workspaceRef || !result.canonicalRoot || BigInt(result.worktreePoolRevision) === 0n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed worktree target is incomplete" })
  }
  return result
}

function decodeManagedPreAdmissionProof(operation: string, raw: unknown, bound: boolean): ManagedPreAdmissionProofV1 {
  const value = requiredRecord(operation, raw, "preAdmissionProof")
  const keys = ["pinsDigest", "ownerLogID", "ownerLogSequence", "ownerLogEventDigest", "ownerEpoch", "workerPoolRevision", "workerExecutionID", "ticketID", ...(bound ? ["proofDigest", "receiptDigest", "leaseProofDigest"] : ["proofDigest", "leaseProofDigest"])].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission proof has an invalid shape" })
  }
  const proof = {
    proofDigest: decodeBlake3Digest(operation, requiredText(operation, value, "proofDigest", 256), "proofDigest"),
    ...(bound ? { receiptDigest: decodeBlake3Digest(operation, requiredText(operation, value, "receiptDigest", 256), "receiptDigest") } : {}),
    leaseProofDigest: decodeBlake3Digest(operation, requiredText(operation, value, "leaseProofDigest", 256), "leaseProofDigest"),
    pinsDigest: decodeBlake3Digest(operation, requiredText(operation, value, "pinsDigest", 256), "pinsDigest"),
    ownerLogID: identifier(operation, requiredText(operation, value, "ownerLogID", 256), "ownerLogID"),
    ownerLogSequence: requiredDecimalU64(operation, value, "ownerLogSequence"),
    ownerLogEventDigest: decodeBlake3Digest(operation, requiredText(operation, value, "ownerLogEventDigest", 256), "ownerLogEventDigest"),
    ownerEpoch: requiredDecimalU64(operation, value, "ownerEpoch"),
    workerPoolRevision: requiredDecimalU64(operation, value, "workerPoolRevision"),
    workerExecutionID: identifier(operation, requiredText(operation, value, "workerExecutionID", 256), "workerExecutionID"),
    ticketID: identifier(operation, requiredText(operation, value, "ticketID", 256), "ticketID"),
  }
  if ([proof.ownerLogSequence, proof.ownerEpoch, proof.workerPoolRevision].some((item) => BigInt(item) === 0n)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission proof contains a zero sequence or generation" })
  }
  return proof
}

function decodeManagedPreAdmissionReservation(
  operation: string,
  response: Record<string, unknown>,
  expected: { readonly status: ManagedPreAdmissionReservationV1["status"] | "RESERVED_CONTEXT_BOUND_OR_UNBOUND"; readonly goalID: string; readonly runID: string; readonly taskID: string; readonly workspaceRef: string; readonly locationID: string; readonly candidateAttemptID?: string; readonly contextSelection?: ContextSelection },
): ManagedPreAdmissionReservationV1 {
  const responseBound = response.status === "RESERVED_CONTEXT_BOUND"
  if ((expected.status === "RESERVED_CONTEXT_BOUND" && !responseBound) ||
    (expected.status === "RESERVED_CONTEXT_UNBOUND" && responseBound) ||
    (expected.status === "RESERVED_CONTEXT_BOUND_OR_UNBOUND" && response.status !== "RESERVED_CONTEXT_BOUND" && response.status !== "RESERVED_CONTEXT_UNBOUND") ||
    (expected.contextSelection !== undefined && !responseBound)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Stage-B decoding requires the exact submitted ContextSelection" })
  }
  const baseKeys = ["status", "goalID", "runID", "taskID", "candidateAttemptID", "taskRevision", "preAdmissionProof", "preAdmissionTarget"]
  const keys = [...baseKeys, ...(responseBound ? ["contextSelectionDigest"] : [])].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") ||
    (expected.status !== "RESERVED_CONTEXT_BOUND_OR_UNBOUND" && response.status !== expected.status)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission reservation response has an invalid shape or status" })
  }
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const taskID = identifier(operation, requiredText(operation, response, "taskID", 256), "taskID")
  const candidateAttemptID = requiredText(operation, response, "candidateAttemptID", 256)
  if (!MANAGED_CANDIDATE_ATTEMPT_ID.test(candidateAttemptID)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission candidate Attempt ID is not canonical" })
  }
  const taskRevision = requiredDecimalU64(operation, response, "taskRevision")
  if (BigInt(taskRevision) === 0n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission Task revision must be positive" })
  }
  const preAdmissionProof = decodeManagedPreAdmissionProof(operation, response.preAdmissionProof, responseBound)
  const preAdmissionTarget = decodeManagedWorktreeTarget(operation, response.preAdmissionTarget)
  const contextSelectionDigest = responseBound
    ? decodeBlake3Digest(operation, requiredText(operation, response, "contextSelectionDigest", 256), "contextSelectionDigest")
    : undefined
  if (goalID !== expected.goalID || runID !== expected.runID || taskID !== expected.taskID ||
    (expected.candidateAttemptID !== undefined && candidateAttemptID !== expected.candidateAttemptID) ||
    preAdmissionTarget.workspaceRef !== expected.workspaceRef || preAdmissionTarget.locationID !== expected.locationID ||
    (expected.contextSelection !== undefined && (expected.contextSelection.attemptID !== candidateAttemptID ||
      expected.contextSelection.sessionID !== managedTaskSessionID(candidateAttemptID) ||
      expected.contextSelection.requestID !== `req_managed_${candidateAttemptID}_1` ||
      expected.contextSelection.requestSequence !== "1"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission reservation changed its Task, target or ContextSelection pins" })
  }
  return {
    status: responseBound ? "RESERVED_CONTEXT_BOUND" : "RESERVED_CONTEXT_UNBOUND",
    goalID,
    runID,
    taskID,
    candidateAttemptID,
    taskRevision,
    preAdmissionProof,
    preAdmissionTarget,
    ...(contextSelectionDigest === undefined ? {} : { contextSelectionDigest }),
  }
}

function decodeManagedDispatchHandoff(operation: string, raw: unknown): ManagedDispatchHandoffV1 {
  const value = requiredRecord(operation, raw, "handoff")
  const stringKeys = [
    "handoffID", "handoffDigest", "goalID", "runID", "taskID", "parentSessionID", "attemptID", "expectedManagedRevision",
    "workerExecutionID", "ownerEpoch", "processIncarnation", "profileID", "profileRevision", "profileDigest",
    "permissionScopeDigest", "acceptedSpecDigest", "workspaceRevision", "locationID", "sessionID",
    "contextSelectionDigest", "acceptedScopeDigest", "capabilityCeilingDigest", "budgetDimension", "budgetAmount",
    "leaseExpiresAtMs", "claimOwnerLogID", "claimOwnerLogSequence", "claimOwnerLogEventDigest", "workerPoolRevision",
    "claimNonce", "claimedProofDigest", "workspaceLeaseID", "budgetLeaseID", "worktreeID", "worktreeBaseRevision",
    "worktreePoolRevision", "bindingDigest", "pinsDigest",
  ] as const
  const keys = [...stringKeys, "resourceLeaseIDs", "worktreeTarget"].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed dispatch handoff has an invalid shape" })
  }
  const result = Object.fromEntries(stringKeys.map((key) => [key, requiredText(operation, value, key, 256)])) as unknown as Omit<ManagedDispatchHandoffV1, "resourceLeaseIDs" | "worktreeTarget" | "expectedManagedRevision" | "ownerEpoch" | "profileRevision" | "budgetAmount" | "leaseExpiresAtMs" | "claimOwnerLogSequence" | "workerPoolRevision" | "worktreePoolRevision">
  for (const key of ["expectedManagedRevision", "ownerEpoch", "profileRevision", "budgetAmount", "leaseExpiresAtMs", "claimOwnerLogSequence", "workerPoolRevision", "worktreePoolRevision"] as const) {
    requiredDecimalU64(operation, value, key)
  }
  for (const key of ["ownerEpoch", "profileRevision", "budgetAmount", "leaseExpiresAtMs", "claimOwnerLogSequence", "workerPoolRevision"] as const) {
    if (BigInt(value[key] as string) === 0n) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must be positive` })
    }
  }
  if (value.budgetDimension !== "ActiveWorkers" || value.profileDigest && !(value.profileDigest as string).startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed handoff profile or budget pin is invalid" })
  }
  const resourceLeaseIDs = stringList(operation, value.resourceLeaseIDs as readonly string[], "resourceLeaseIDs").map((id) => identifier(operation, id, "resourceLeaseIDs"))
  const worktreeTarget = decodeManagedWorktreeTarget(operation, value.worktreeTarget)
  if (worktreeTarget.worktreeID !== value.worktreeID || worktreeTarget.worktreeBaseRevision !== value.worktreeBaseRevision ||
      worktreeTarget.worktreePoolRevision !== value.worktreePoolRevision || worktreeTarget.locationID !== value.locationID ||
      worktreeTarget.workspaceRevision !== value.workspaceRevision) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed worktree target differs from the handoff pins" })
  }
  if (new Set(resourceLeaseIDs).size !== resourceLeaseIDs.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "resourceLeaseIDs contains duplicates" })
  }
  for (const key of ["handoffDigest", "profileDigest", "permissionScopeDigest", "acceptedSpecDigest", "workspaceRevision", "contextSelectionDigest", "acceptedScopeDigest", "capabilityCeilingDigest", "claimOwnerLogEventDigest", "claimedProofDigest", "claimNonce", "bindingDigest", "pinsDigest"] as const) {
    digestValue(operation, value[key] as string, key)
  }
  return {
    ...result,
    expectedManagedRevision: requiredDecimalU64(operation, value, "expectedManagedRevision"),
    ownerEpoch: requiredDecimalU64(operation, value, "ownerEpoch"),
    profileRevision: requiredDecimalU64(operation, value, "profileRevision"),
    budgetAmount: requiredDecimalU64(operation, value, "budgetAmount"),
    leaseExpiresAtMs: requiredDecimalU64(operation, value, "leaseExpiresAtMs"),
    claimOwnerLogSequence: requiredDecimalU64(operation, value, "claimOwnerLogSequence"),
    workerPoolRevision: requiredDecimalU64(operation, value, "workerPoolRevision"),
    worktreePoolRevision: requiredDecimalU64(operation, value, "worktreePoolRevision"),
    resourceLeaseIDs,
    worktreeTarget,
  } satisfies ManagedDispatchHandoffV1
}

function decodeManagedDispatchConsumeReceipt(operation: string, response: Record<string, unknown>): ManagedDispatchConsumeReceiptV1 {
  requireStatus(operation, response, "CONSUMED")
  const textFields = [
    "goalID", "runID", "taskID", "parentSessionID", "sessionID", "attemptID", "handoffID", "handoffDigest", "claimedProofDigest", "workerExecutionID",
    "pinsDigest", "bindingDigest", "claimNonce", "claimOwnerLogID", "claimOwnerLogSequence", "claimOwnerLogEventDigest",
    "workerPoolRevision", "ownerEpoch", "processIncarnation", "deliveryID", "coreStartIdentity", "coreExecutableDigest",
    "consumedManagedRevision", "receiptDigest",
  ] as const
  const keys = [...textFields, "status", "corePID", "coreUID", "coreGID", "worktreeTarget"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed consume receipt has an invalid shape" })
  }
  for (const key of ["claimOwnerLogSequence", "workerPoolRevision", "ownerEpoch", "coreStartIdentity", "consumedManagedRevision"] as const) {
    requiredDecimalU64(operation, response, key)
  }
  for (const key of ["handoffDigest", "claimedProofDigest", "pinsDigest", "bindingDigest", "claimNonce", "claimOwnerLogEventDigest", "coreExecutableDigest", "receiptDigest"] as const) {
    digestValue(operation, requiredText(operation, response, key, 256), key)
  }
  for (const key of ["corePID", "coreUID", "coreGID"] as const) requiredInteger(operation, response, key)
  const worktreeTarget = decodeManagedWorktreeTarget(operation, response.worktreeTarget)
  return Object.fromEntries([...textFields.map((key) => [key, requiredText(operation, response, key, 256)]), ...(["corePID", "coreUID", "coreGID"] as const).map((key) => [key, requiredInteger(operation, response, key)]) , ["status", "CONSUMED"], ["worktreeTarget", worktreeTarget]]) as unknown as ManagedDispatchConsumeReceiptV1
}

function decodeManagedReadyTaskSelection(operation: string, response: Record<string, unknown>): ManagedReadyTaskSelectionV1 {
  const status = requiredText(operation, response, "status", 32)
  if (status !== "NO_TASK" && status !== "READY_TASK") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "scheduler status is invalid" })
  }
  const fixedKeys = [
    "status", "goalID", "runID", "revision", "runPhase", "specID", "specDigest", "goalObjective", "specConstraints",
    "locationID", "sessionID", "workspaceRef",
  ]
  const expectedKeys = [...fixedKeys, ...(Object.hasOwn(response, "task") ? ["task"] : [])].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "scheduler projection has an invalid shape" })
  }
  const runPhase = managedRunPhase(operation, response.runPhase)
  if ((status === "READY_TASK" && runPhase !== "RUNNING") || (status === "NO_TASK" && runPhase === "PLAN_ONLY")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "scheduler status conflicts with Run phase" })
  }
  const constraints = stringList(operation, response.specConstraints as readonly string[], "specConstraints")
  if (constraints.length > 64) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "specConstraints exceeds its bound" })
  let task: ManagedReadyTaskSelectionV1["task"] = null
  if (status === "READY_TASK") {
    const value = requiredRecord(operation, response.task, "task")
    const taskKeys = ["taskID", "title", "purpose", "candidateAttemptID", "attemptCount", "candidateGeneration", "taskRevision", "contextDigest", "dependencies", "criterionIDs", "criteria", "requiredCapabilities", "effectiveMaxTokens", "remainingTokens", "profile"].toSorted()
    if (Object.keys(value).toSorted().join("\0") !== taskKeys.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "ready Task projection has an invalid shape" })
    }
    const profileValue = requiredRecord(operation, value.profile, "task.profile")
    if (Object.keys(profileValue).toSorted().join("\0") !== ["profileID", "revision", "definitionDigest", "ownerBindingDigest"].toSorted().join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "ready Task profile pin has an invalid shape" })
    }
    const criteriaValue = value.criteria
    if (!Array.isArray(criteriaValue) || criteriaValue.length === 0 || criteriaValue.length > 32) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "ready Task criteria are invalid" })
    }
    const criteria = criteriaValue.map((raw) => {
      const item = requiredRecord(operation, raw, "criteria")
      if (Object.keys(item).toSorted().join("\0") !== ["criterionID", "description"].toSorted().join("\0")) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "criterion projection has an invalid shape" })
      }
      return {
        criterionID: identifier(operation, requiredText(operation, item, "criterionID", 256), "criterionID"),
        description: requiredText(operation, item, "description", 4096),
      }
    })
    const criterionIDs = stringList(operation, value.criterionIDs as readonly string[], "criterionIDs").map((id) => identifier(operation, id, "criterionIDs"))
    if (criteria.some((criterion) => !criterionIDs.includes(criterion.criterionID)) ||
      criteria.length !== criterionIDs.length || new Set(criterionIDs).size !== criterionIDs.length) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Task criterion details do not match its criterion IDs" })
    }
    for (const key of ["attemptCount", "candidateGeneration", "taskRevision"] as const) requiredDecimalU64(operation, value, key)
    const effectiveMaxTokens = requiredDecimalU64(operation, value, "effectiveMaxTokens")
    const remainingTokens = requiredDecimalU64(operation, value, "remainingTokens")
    if (BigInt(effectiveMaxTokens) === 0n || BigInt(remainingTokens) === 0n || BigInt(remainingTokens) > BigInt(effectiveMaxTokens)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "ready Task token budget is absent, exhausted, or inconsistent" })
    }
    const profileDigest = digestValue(operation, requiredText(operation, profileValue, "definitionDigest", 256), "profile.definitionDigest")
    if (!profileDigest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "profile definition digest must use BLAKE3" })
    task = {
      taskID: identifier(operation, requiredText(operation, value, "taskID", 256), "taskID"),
      title: requiredText(operation, value, "title", 256),
      purpose: requiredText(operation, value, "purpose", 8192),
      candidateAttemptID: (() => {
        const candidateAttemptID = requiredText(operation, value, "candidateAttemptID", 256)
        if (!MANAGED_CANDIDATE_ATTEMPT_ID.test(candidateAttemptID)) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: "candidate Attempt ID is not the canonical Rust-managed identity" })
        }
        return candidateAttemptID
      })(),
      attemptCount: value.attemptCount as string,
      candidateGeneration: value.candidateGeneration as string,
      taskRevision: value.taskRevision as string,
      contextDigest: decodeBlake3Digest(operation, requiredText(operation, value, "contextDigest", 256), "contextDigest"),
      dependencies: stringList(operation, value.dependencies as readonly string[], "dependencies").map((id) => identifier(operation, id, "dependencies")),
      criterionIDs,
      criteria,
      requiredCapabilities: stringList(operation, value.requiredCapabilities as readonly string[], "requiredCapabilities").map((id) => identifier(operation, id, "requiredCapabilities")),
      effectiveMaxTokens,
      remainingTokens,
      profile: {
        profileID: identifier(operation, requiredText(operation, profileValue, "profileID", 256), "profile.profileID"),
        revision: requiredDecimalU64(operation, profileValue, "revision"),
        definitionDigest: profileDigest,
        ownerBindingDigest: digestValue(operation, requiredText(operation, profileValue, "ownerBindingDigest", 256), "profile.ownerBindingDigest"),
      },
    }
  } else if (Object.hasOwn(response, "task") && response.task !== null) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "NO_TASK projection unexpectedly contains a Task" })
  }
  if ((status === "READY_TASK") !== (task !== null)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "scheduler status and Task projection disagree" })
  }
  for (const key of ["revision"] as const) requiredDecimalU64(operation, response, key)
  const specDigest = digestValue(operation, requiredText(operation, response, "specDigest", 256), "specDigest")
  if (!specDigest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "accepted Spec digest must use BLAKE3" })
  return {
    status,
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    revision: response.revision as string,
    runPhase,
    specID: identifier(operation, requiredText(operation, response, "specID", 256), "specID"),
    specDigest,
    goalObjective: requiredText(operation, response, "goalObjective", 4096),
    specConstraints: constraints,
    locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
    sessionID: identifier(operation, requiredText(operation, response, "sessionID", 256), "sessionID"),
    workspaceRef: requiredText(operation, response, "workspaceRef", 4096),
    task,
  }
}

function decodeManagedActiveAttemptRecovery(
  operation: string,
  response: Record<string, unknown>,
): ManagedActiveAttemptRecoveryV1 {
  // Validated against both variants below; unknown values fail closed. The
  // literal union keeps the recovery result discriminant-exact.
  const status = requiredText(operation, response, "status", 32) as
    | "NO_ACTIVE_ATTEMPT"
    | "ACTIVE_ATTEMPT"
  if (status !== "NO_ACTIVE_ATTEMPT" && status !== "ACTIVE_ATTEMPT") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active Attempt recovery status is invalid" })
  }
  const commonKeys = ["goalID", "runID", "locationID", "sessionID", "revision", "runPhase", "status"]
  const activeKeys = ["specID", "specDigest", "goalObjective", "specConstraints", "workspaceRef", "task", "attempt"]
  const expectedKeys = [...commonKeys, ...(status === "ACTIVE_ATTEMPT" ? activeKeys : [])].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active Attempt recovery projection has an invalid shape" })
  }
  const runPhase = managedRunPhase(operation, response.runPhase)
  const base = {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
    sessionID: identifier(operation, requiredText(operation, response, "sessionID", 256), "sessionID"),
    revision: requiredDecimalU64(operation, response, "revision"),
    runPhase,
  }
  if (status === "NO_ACTIVE_ATTEMPT") return { ...base, status, task: null, attempt: null }
  const specDigest = digestValue(operation, requiredText(operation, response, "specDigest", 256), "specDigest")
  if (!specDigest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery accepted Spec digest must use BLAKE3" })
  const constraints = stringList(operation, response.specConstraints as readonly string[], "specConstraints")
  if (constraints.length > 64) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery Spec constraints exceed their bound" })
  const activeBase = {
    ...base,
    status,
    specID: identifier(operation, requiredText(operation, response, "specID", 256), "specID"),
    specDigest,
    goalObjective: requiredText(operation, response, "goalObjective", MAX_TEXT_BYTES),
    specConstraints: constraints,
    workspaceRef: requiredText(operation, response, "workspaceRef", 4096),
  }

  const taskValue = requiredRecord(operation, response.task, "recovery Task")
  const taskKeys = ["taskID", "title", "purpose", "candidateAttemptID", "attemptCount", "candidateGeneration", "taskRevision", "contextDigest", "dependencies", "criterionIDs", "criteria", "requiredCapabilities", "profile"].toSorted()
  if (Object.keys(taskValue).toSorted().join("\0") !== taskKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Task has an invalid shape" })
  }
  const candidateAttemptID = requiredText(operation, taskValue, "candidateAttemptID", 256)
  if (!MANAGED_CANDIDATE_ATTEMPT_ID.test(candidateAttemptID)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery candidate Attempt ID is invalid" })
  for (const key of ["attemptCount", "candidateGeneration", "taskRevision"] as const) requiredDecimalU64(operation, taskValue, key)
  const profileValue = requiredRecord(operation, taskValue.profile, "recovery Task profile")
  if (Object.keys(profileValue).toSorted().join("\0") !== ["profileID", "revision", "definitionDigest", "ownerBindingDigest"].toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Task profile has an invalid shape" })
  }
  const profileDigest = digestValue(operation, requiredText(operation, profileValue, "definitionDigest", 256), "profile.definitionDigest")
  if (!profileDigest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery profile digest must use BLAKE3" })
  const criteriaValue = taskValue.criteria
  if (!Array.isArray(criteriaValue) || criteriaValue.length < 1 || criteriaValue.length > 32) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Task criteria are invalid" })
  }
  const criteria = criteriaValue.map((raw) => {
    const item = requiredRecord(operation, raw, "recovery criterion")
    if (Object.keys(item).toSorted().join("\0") !== ["criterionID", "description"].toSorted().join("\0")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery criterion has an invalid shape" })
    return { criterionID: identifier(operation, requiredText(operation, item, "criterionID", 256), "criterionID"), description: requiredText(operation, item, "description", 4096) }
  })
  const criterionIDs = stringList(operation, taskValue.criterionIDs as readonly string[], "recovery criterionIDs").map((id) => identifier(operation, id, "criterionID"))
  if (criteria.length !== criterionIDs.length || new Set(criterionIDs).size !== criterionIDs.length || criteria.some((item) => !criterionIDs.includes(item.criterionID))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Task criterion pins disagree" })
  }
  const task = {
    taskID: identifier(operation, requiredText(operation, taskValue, "taskID", 256), "taskID"),
    title: requiredText(operation, taskValue, "title", 256),
    purpose: requiredText(operation, taskValue, "purpose", 8192),
    candidateAttemptID,
    attemptCount: taskValue.attemptCount as string,
    candidateGeneration: taskValue.candidateGeneration as string,
    taskRevision: taskValue.taskRevision as string,
    contextDigest: decodeBlake3Digest(operation, requiredText(operation, taskValue, "contextDigest", 256), "contextDigest"),
    dependencies: stringList(operation, taskValue.dependencies as readonly string[], "recovery dependencies").map((id) => identifier(operation, id, "dependency")),
    criterionIDs,
    criteria,
    requiredCapabilities: stringList(operation, taskValue.requiredCapabilities as readonly string[], "recovery requiredCapabilities").map((id) => identifier(operation, id, "capability")),
    profile: {
      profileID: identifier(operation, requiredText(operation, profileValue, "profileID", 256), "profileID"),
      revision: requiredDecimalU64(operation, profileValue, "revision"),
      definitionDigest: profileDigest,
      ownerBindingDigest: digestValue(operation, requiredText(operation, profileValue, "ownerBindingDigest", 256), "profile owner binding digest"),
    },
  }
  const attemptValue = requiredRecord(operation, response.attempt, "recovery Attempt")
  const attemptKeys = ["attemptID", "sessionID", "ownerEpoch", "phase", "runPhase", "bindingDigest", "unknownEffect", "consumed", "quiescence", ...["managedAttempt", "contextSelectionDigest", "contextSelection", "requestID", "requestSequence"].filter((key) => Object.hasOwn(attemptValue, key))].toSorted()
  if (Object.keys(attemptValue).toSorted().join("\0") !== attemptKeys.join("\0")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Attempt has an invalid shape" })
  const attemptID = identifier(operation, requiredText(operation, attemptValue, "attemptID", 256), "attemptID")
  const sessionID = identifier(operation, requiredText(operation, attemptValue, "sessionID", 256), "sessionID")
  if (attemptID !== candidateAttemptID || sessionID !== managedTaskSessionID(attemptID)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Attempt differs from its canonical Task child mapping" })
  const phase = requiredText(operation, attemptValue, "phase", 32)
  if (!["ADMITTED", "EXECUTING", "SETTLING", "UNKNOWN", "SUCCEEDED", "FAILED"].includes(phase)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Attempt phase is invalid" })
  if (managedRunPhase(operation, attemptValue.runPhase) !== runPhase) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery Run phase changed within the projection" })
  const consumed = attemptValue.consumed === null ? null : decodeManagedDispatchConsumeReceipt(operation, requiredRecord(operation, attemptValue.consumed, "recovery consume receipt"))
  const quiescence = attemptValue.quiescence === null ? null : decodeManagedDispatchQuiescedReceipt(operation, requiredRecord(operation, attemptValue.quiescence, "recovery quiescence receipt"))
  const contextSelection = Object.hasOwn(attemptValue, "contextSelection")
    ? (() => {
      try {
        return Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(attemptValue.contextSelection)
      } catch {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery ContextSelection is invalid" })
      }
    })()
    : undefined
  const managedAttemptRecovery = Object.hasOwn(attemptValue, "managedAttempt")
    ? (() => {
      const value = requiredRecord(operation, attemptValue.managedAttempt, "recovery managed Attempt")
      const keys = ["goalID", "runID", "taskID", "attemptID", "ownerEpoch", "expectedManagedRevision", "locationID", "sessionID", "workspaceRevision", "delegationBindingDigest", "requestID", "requestSequence", "contextSelectionDigest"].toSorted()
      if (Object.keys(value).toSorted().join("\0") !== keys.join("\0")) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery managed Attempt pins have an invalid shape" })
      }
      const nullableText = (key: "requestID" | "requestSequence" | "contextSelectionDigest"): string | null => {
        const raw = value[key]
        if (raw === null) return null
        if (typeof raw !== "string") throw new ManagedControlError({ operation, code: "managed_protocol", reason: `recovery managed Attempt ${key} is invalid` })
        return raw
      }
      const requestID = nullableText("requestID")
      const requestSequence = nullableText("requestSequence")
      const selectionDigest = nullableText("contextSelectionDigest")
      if ((requestID === null) !== (requestSequence === null) || (requestID === null) !== (selectionDigest === null)) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery managed Attempt request pins are incomplete" })
      }
      return {
        goalID: identifier(operation, requiredText(operation, value, "goalID", 256), "goalID"),
        runID: identifier(operation, requiredText(operation, value, "runID", 256), "runID"),
        taskID: identifier(operation, requiredText(operation, value, "taskID", 256), "taskID"),
        attemptID: requiredText(operation, value, "attemptID", 256),
        ownerEpoch: requiredPositiveDecimalU64(operation, value, "ownerEpoch"),
        expectedManagedRevision: requiredDecimalU64(operation, value, "expectedManagedRevision"),
        locationID: identifier(operation, requiredText(operation, value, "locationID", 256), "locationID"),
        sessionID: identifier(operation, requiredText(operation, value, "sessionID", 256), "sessionID"),
        workspaceRevision: digestValue(operation, requiredText(operation, value, "workspaceRevision", 256), "workspaceRevision"),
        delegationBindingDigest: decodeBlake3Digest(operation, requiredText(operation, value, "delegationBindingDigest", 256), "delegationBindingDigest"),
        requestID: requestID === null ? null : identifier(operation, requestID, "requestID"),
        requestSequence: requestSequence === null ? null : (() => {
          canonicalDecimalU64(operation, requestSequence, "requestSequence")
          return requestSequence
        })(),
        contextSelectionDigest: selectionDigest === null ? null : decodeBlake3Digest(operation, selectionDigest, "contextSelectionDigest"),
      } satisfies ManagedAttemptRecoveryPinsV1
    })()
    : undefined
  const contextSelectionDigest = Object.hasOwn(attemptValue, "contextSelectionDigest")
    ? decodeBlake3Digest(operation, requiredText(operation, attemptValue, "contextSelectionDigest", 256), "contextSelectionDigest")
    : undefined
  const requestID = Object.hasOwn(attemptValue, "requestID") ? identifier(operation, requiredText(operation, attemptValue, "requestID", 256), "requestID") : undefined
  const requestSequence = Object.hasOwn(attemptValue, "requestSequence") ? requiredDecimalU64(operation, attemptValue, "requestSequence") : undefined
  if ((requestID === undefined) !== (requestSequence === undefined) ||
    (contextSelection !== undefined) !== (requestID !== undefined) ||
    (contextSelectionDigest !== undefined) !== (contextSelection !== undefined) ||
    (managedAttemptRecovery !== undefined && (managedAttemptRecovery.goalID !== base.goalID ||
      managedAttemptRecovery.runID !== base.runID || managedAttemptRecovery.taskID !== task.taskID ||
      managedAttemptRecovery.attemptID !== attemptID || managedAttemptRecovery.ownerEpoch !== requiredDecimalU64(operation, attemptValue, "ownerEpoch") ||
      managedAttemptRecovery.expectedManagedRevision !== base.revision || managedAttemptRecovery.sessionID !== sessionID ||
      managedAttemptRecovery.delegationBindingDigest !== requiredText(operation, attemptValue, "bindingDigest", 256)))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery managed Attempt pins do not match the enclosing projection" })
  }
  if (contextSelection && (!managedAttemptRecovery || contextSelection.sessionID !== sessionID ||
    contextSelection.attemptID !== attemptID || contextSelection.requestSequence !== requestSequence ||
    contextSelection.requestID !== requestID || managedAttemptRecovery.requestSequence !== requestSequence ||
    managedAttemptRecovery.requestID !== requestID || managedAttemptRecovery.requestSequence !== "1" ||
    contextSelectionDigest !== managedAttemptRecovery.contextSelectionDigest ||
    !contextSelection.sources.some((source) => source.kind === "provider-input" && source.sourceID === requestID && source.sourceRevision === "1"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery ContextSelection does not match the persisted initial Attempt request pins" })
  }
  const attempt = {
    attemptID,
    sessionID,
    ownerEpoch: requiredDecimalU64(operation, attemptValue, "ownerEpoch"),
    phase: phase as NonNullable<ManagedActiveAttemptRecoveryV1["attempt"]>["phase"],
    runPhase,
    bindingDigest: digestValue(operation, requiredText(operation, attemptValue, "bindingDigest", 256), "bindingDigest"),
    unknownEffect: requiredBoolean(operation, attemptValue, "unknownEffect"),
    consumed,
    quiescence,
    ...(contextSelectionDigest ? { contextSelectionDigest } : {}),
    ...(requestID ? { requestID } : {}),
    ...(requestSequence ? { requestSequence } : {}),
    ...(managedAttemptRecovery ? { managedAttemptRecovery } : {}),
    ...(contextSelection ? { contextSelection } : {}),
  }
  if (managedAttemptRecovery && managedAttemptRecovery.ownerEpoch !== attempt.ownerEpoch) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery managed Attempt owner epoch changed within the projection" })
  if (attempt.ownerEpoch === "0" || !attempt.bindingDigest.startsWith("blake3:") ||
    (quiescence && !consumed) || (consumed && (consumed.attemptID !== attemptID || consumed.sessionID !== sessionID)) ||
    (quiescence && (quiescence.attemptID !== attemptID || quiescence.sessionID !== sessionID))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "active recovery receipts do not match the exact child Attempt" })
  }
  if (consumed && (consumed.goalID !== base.goalID || consumed.runID !== base.runID || consumed.taskID !== task.taskID ||
    consumed.parentSessionID !== base.sessionID || consumed.sessionID !== sessionID || consumed.bindingDigest !== attempt.bindingDigest ||
    consumed.ownerEpoch !== attempt.ownerEpoch)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery consumed receipt does not match the exact managed Attempt" })
  }
  if (quiescence && consumed) {
    let expectedCompletionDeliveryID: string
    try {
      expectedCompletionDeliveryID = managedCompletionDeliveryID(attemptID, consumed.handoffDigest, consumed.receiptDigest)
    } catch {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery consumed receipt cannot derive its stable completion delivery ID" })
    }
    if (quiescence.goalID !== consumed.goalID || quiescence.runID !== consumed.runID || quiescence.taskID !== consumed.taskID ||
      quiescence.parentSessionID !== consumed.parentSessionID || quiescence.sessionID !== consumed.sessionID ||
      quiescence.attemptID !== consumed.attemptID || quiescence.handoffID !== consumed.handoffID ||
      quiescence.handoffDigest !== consumed.handoffDigest || quiescence.consumeDeliveryID !== consumed.deliveryID ||
      quiescence.consumeReceiptDigest !== consumed.receiptDigest || quiescence.ownerEpoch !== consumed.ownerEpoch ||
      quiescence.processIncarnation !== consumed.processIncarnation || quiescence.deliveryID !== expectedCompletionDeliveryID) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery quiescence receipt does not match the exact consumed dispatch receipt" })
    }
  }
  return { ...activeBase, task, attempt }
}

function phase(operation: string, value: unknown): DirectAttemptPhase {
  if (value !== "EXECUTING" && value !== "SUCCEEDED" && value !== "FAILED" && value !== "UNKNOWN" && value !== "CANCELLED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "attempt phase is invalid" })
  }
  return value
}

function decodeDirectAttempt(operation: string, response: Record<string, unknown>): DirectAttemptSnapshot {
  const attemptID = identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID")
  return Object.freeze({
    attemptID,
    phase: phase(operation, response.attemptPhase),
    parentSessionID: requiredText(operation, response, "parentSessionID", 256),
    childSessionID: requiredText(operation, response, "childSessionID", 256),
    agent: requiredText(operation, response, "agent", 256),
    scopeDigest: digestValue(operation, requiredText(operation, response, "scopeDigest", 256), "scopeDigest"),
    receiptDigest: optionalText(operation, response, "receiptDigest"),
    resultDigest: optionalText(operation, response, "resultDigest"),
    failureCode: optionalText(operation, response, "failureCode"),
    retryable: optionalBoolean(operation, response, "retryable"),
    revision: requiredRevision(operation, response, "revision"),
    ...(Object.hasOwn(response, "directAttempt") ? { directAttempt: decodeDirectAttemptScope(operation, response) } : {}),
  })
}

function decodeDirectAttemptScope(operation: string, response: Record<string, unknown>): DirectAttemptScopeV1 {
  const value = requiredRecord(operation, response.directAttempt, "directAttempt")
  const keys = [
    "attemptID", "parentSessionID", "childSessionID", "profileID", "profileRevision", "profileDigest",
    "ownerEpoch", "expectedRevision", "locationID", "workspaceID", "workspaceRevision", "capabilityDigest",
    "permissionsDigest", "budgetDigest", "scopeDigest",
  ]
  if (Object.keys(value).toSorted().join("\0") !== keys.toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct Attempt scope has an invalid shape" })
  }
  const profileDigest = digestValue(operation, requiredText(operation, value, "profileDigest", 256), "profileDigest")
  const profileRevision = requiredDecimalU64(operation, value, "profileRevision")
  if (BigInt(profileRevision) < 1n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "profileRevision must be positive" })
  }
  if (!profileDigest.startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "profileDigest must use BLAKE3" })
  }
  return {
    attemptID: identifier(operation, requiredText(operation, value, "attemptID", 256), "attemptID"),
    parentSessionID: identifier(operation, requiredText(operation, value, "parentSessionID", 256), "parentSessionID"),
    childSessionID: identifier(operation, requiredText(operation, value, "childSessionID", 256), "childSessionID"),
    profileID: identifier(operation, requiredText(operation, value, "profileID", 256), "profileID"),
    profileRevision,
    profileDigest,
    ownerEpoch: expectedRevision(operation, value.ownerEpoch).toString(),
    expectedRevision: expectedRevision(operation, value.expectedRevision).toString(),
    locationID: identifier(operation, requiredText(operation, value, "locationID", 256), "locationID"),
    workspaceID: identifier(operation, requiredText(operation, value, "workspaceID", 256), "workspaceID"),
    workspaceRevision: digestValue(operation, requiredText(operation, value, "workspaceRevision", 256), "workspaceRevision"),
    capabilityDigest: digestValue(operation, requiredText(operation, value, "capabilityDigest", 256), "capabilityDigest"),
    permissionsDigest: digestValue(operation, requiredText(operation, value, "permissionsDigest", 256), "permissionsDigest"),
    budgetDigest: digestValue(operation, requiredText(operation, value, "budgetDigest", 256), "budgetDigest"),
    scopeDigest: digestValue(operation, requiredText(operation, value, "scopeDigest", 256), "scopeDigest"),
  }
}

function decodeDirectAttemptAdmission(operation: string, response: Record<string, unknown>): DirectAttemptAdmission {
  requireStatus(operation, response, "ADMITTED")
  const snapshot = decodeDirectAttempt(operation, response)
  const ownerEpoch = requiredRevision(operation, response, "ownerEpoch")
  const locationID = identifier(operation, requiredText(operation, response, "locationID", 256), "locationID")
  const workspaceID = identifier(operation, requiredText(operation, response, "workspaceID", 256), "workspaceID")
  const directAttempt = decodeDirectAttemptScope(operation, response)
  if (
    directAttempt.attemptID !== snapshot.attemptID ||
    directAttempt.parentSessionID !== snapshot.parentSessionID ||
    directAttempt.childSessionID !== snapshot.childSessionID ||
    directAttempt.scopeDigest !== snapshot.scopeDigest ||
    directAttempt.ownerEpoch !== ownerEpoch ||
    directAttempt.locationID !== locationID ||
    directAttempt.workspaceID !== workspaceID
    || !directAttempt.workspaceRevision.startsWith("blake3:")
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct Attempt scope does not match admission" })
  }
  return {
    ...snapshot,
    ownerEpoch,
    locationID,
    workspaceID,
    workspaceRevision: directAttempt.workspaceRevision,
    directAttempt,
  }
}

function decodeGoalProposalCreated(operation: string, response: Record<string, unknown>): GoalProposalCreated {
  requireStatus(operation, response, "PROPOSED")
  const createdBy = requiredText(operation, response, "createdBy", 256)
  const proposedBy = requiredText(operation, response, "proposedBy", 256)
  if (createdBy !== proposedBy) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "Goal creator and initial SpecVersion proposer differ",
    })
  }
  const revision = requiredInteger(operation, response, "revision")
  if (revision !== 1) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "atomic Goal proposal did not commit as one revision",
    })
  }
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    specID: identifier(operation, requiredText(operation, response, "specID", 256), "specID"),
    specDigest: digestValue(operation, requiredText(operation, response, "specDigest", 256), "specDigest"),
    createdBy,
    proposedBy,
    revision,
  }
}

function requiredRecord(operation: string, value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not an object` })
  }
  return value as Record<string, unknown>
}

function snapshotTextList(operation: string, value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} is not a bounded list` })
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > MAX_TEXT_BYTES) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} contains an invalid item` })
    }
    return item
  })
}

function decodePinnedRunSessionLink(operation: string, raw: unknown): ManagedPinnedRootSessionLinkV1 | null {
  if (raw === null) return null
  const value = requiredRecord(operation, raw, "Run.sessionLink")
  const expected = [
    "latestObservedMessageID", "latestObservedPartID", "ownerEpoch", "protocolVersion", "redactionProfile",
    "sessionID", "sourceCursor", "sourceDigest", "sourceEpoch", "sourceInstanceID", "sourceStoreID",
  ].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== expected.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Run SessionLink has an invalid shape" })
  }
  const cursor = requiredRecord(operation, value.sourceCursor, "Run.sessionLink.sourceCursor")
  if (Object.keys(cursor).toSorted().join("\0") !== ["eventDigest", "ownerID", "ownerKind", "seq"].join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Run SessionLink cursor has an invalid shape" })
  }
  const sessionID = identifier(operation, requiredText(operation, value, "sessionID", 256), "sessionLink.sessionID")
  const sourceStoreID = identifier(operation, requiredText(operation, value, "sourceStoreID", 256), "sessionLink.sourceStoreID")
  const sourceInstanceID = identifier(operation, requiredText(operation, value, "sourceInstanceID", 256), "sessionLink.sourceInstanceID")
  const sourceEpoch = requiredRevision(operation, value, "sourceEpoch")
  const ownerEpoch = requiredRevision(operation, value, "ownerEpoch")
  const seq = requiredText(operation, cursor, "seq", 20)
  const cursorSeq = canonicalDecimalU64(operation, seq, "sessionLink.sourceCursor.seq")
  const ownerKind = requiredText(operation, cursor, "ownerKind", 32)
  const ownerID = identifier(operation, requiredText(operation, cursor, "ownerID", 256), "sessionLink.sourceCursor.ownerID")
  const eventDigest = requiredText(operation, cursor, "eventDigest", 80)
  const sourceDigest = requiredText(operation, value, "sourceDigest", 80)
  const redactionProfile = requiredText(operation, value, "redactionProfile", 128)
  const protocolVersion = requiredInteger(operation, value, "protocolVersion")
  const latestObservedMessageID = value.latestObservedMessageID === null
    ? null
    : identifier(operation, requiredText(operation, value, "latestObservedMessageID", 256), "sessionLink.latestObservedMessageID")
  const latestObservedPartID = value.latestObservedPartID === null
    ? null
    : identifier(operation, requiredText(operation, value, "latestObservedPartID", 256), "sessionLink.latestObservedPartID")
  if (ownerKind !== "session" || ownerID !== sessionID || cursorSeq < 1n || BigInt(sourceEpoch) < 1n || BigInt(ownerEpoch) < 1n ||
    !/^blake3:[0-9a-f]{64}$/.test(eventDigest) || !/^sha256:[0-9a-f]{64}$/.test(sourceDigest) ||
    redactionProfile !== "horizon.session-link.ids-only.v1" || protocolVersion !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Run SessionLink contains invalid pinned source facts" })
  }
  return {
    sessionID,
    sourceStoreID,
    sourceInstanceID,
    sourceCursor: { ownerKind, ownerId: ownerID, seq: cursorSeq.toString(), eventDigest },
    sourceEpoch,
    latestObservedMessageID,
    latestObservedPartID,
    sourceDigest,
    redactionProfile,
    ownerEpoch,
    protocolVersion: 1,
  }
}

function decodeGoalReviewSnapshot(operation: string, response: Record<string, unknown>, requestedGoalID?: string): GoalReviewSnapshot {
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  if (requestedGoalID !== undefined && goalID !== requestedGoalID) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "snapshot belongs to a different Goal" })
  }
  const goalRevision = requiredRevision(operation, response, "revision")
  const goal = response.goal === null ? null : requiredRecord(operation, response.goal, "goal")
  const specs = response.specs
  if (!Array.isArray(specs) || specs.length > MAX_LIST_ITEMS) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "specs is not a bounded list" })
  }
  if (goal === null && specs.length > 0) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "snapshot has SpecVersions without a Goal" })
  }
  if (goal === null) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "snapshot has no durable Goal" })
  }
  const projectRef = identifier(operation, requiredText(operation, goal, "projectRef", 256), "projectRef")
  const workspaceRef = identifier(operation, requiredText(operation, goal, "workspaceRef", 256), "workspaceRef")
  const runValues = response.runs
  if (!Array.isArray(runValues) || runValues.length > MAX_LIST_ITEMS) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "runs is not a bounded list" })
  }
  const runs = runValues.map((value) => {
    const run = requiredRecord(operation, value, "Run")
    return {
      runID: identifier(operation, requiredText(operation, run, "runID", 256), "runID"),
      specID: identifier(operation, requiredText(operation, run, "specID", 256), "specID"),
      runPhase: managedRunPhase(operation, requiredText(operation, run, "phase", 32)),
      sessionLink: decodePinnedRunSessionLink(operation, run.sessionLink),
    }
  })

  const proposals: GoalReviewProposal[] = []
  const acceptedSpecs: GoalReviewSnapshot["acceptedSpecs"][number][] = []
  for (const value of specs) {
    const spec = requiredRecord(operation, value, "spec")
    const specID = identifier(operation, requiredText(operation, spec, "specID", 256), "specID")
    const accepted = requiredBoolean(operation, spec, "accepted")
    const acceptedBy = optionalText(operation, spec, "acceptedBy")
    const acceptedAtMs = spec.acceptedAtMs === null ? null : requiredInteger(operation, spec, "acceptedAtMs")
    const rejectedBy = optionalText(operation, spec, "rejectedBy")
    const rejectedAtMs = spec.rejectedAtMs === null ? null : requiredInteger(operation, spec, "rejectedAtMs")
    const isPending = !accepted && acceptedBy === null && acceptedAtMs === null && rejectedBy === null && rejectedAtMs === null
    const isAccepted = accepted && acceptedBy !== null && acceptedAtMs !== null && rejectedBy === null && rejectedAtMs === null
    const isRejected = !accepted && acceptedBy === null && acceptedAtMs === null && rejectedBy !== null && rejectedAtMs !== null
    if (!isPending && !isAccepted && !isRejected) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `SpecVersion ${specID} has inconsistent review provenance` })
    }
    if (isAccepted) {
      const budget = requiredRecord(operation, spec.budget, "accepted SpecVersion budget")
      const criteriaValue = spec.criteria
      if (!Array.isArray(criteriaValue) || criteriaValue.length > MAX_LIST_ITEMS) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "accepted criteria is not a bounded list" })
      }
      const criteria = criteriaValue.map((item) => {
        const criterion = requiredRecord(operation, item, "accepted criterion")
        return {
          id: identifier(operation, requiredText(operation, criterion, "id", 256), "criterion.id"),
          description: requiredText(operation, criterion, "description", MAX_TEXT_BYTES),
        }
      })
      if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "accepted criteria contain duplicate IDs" })
      }
      acceptedSpecs.push({
        specID,
        specDigest: digestValue(operation, requiredText(operation, spec, "specDigest", 256), "specDigest"),
        objective: requiredText(operation, spec, "objective", MAX_TEXT_BYTES),
        scope: snapshotTextList(operation, spec.scope, "scope"),
        capabilityScope: snapshotTextList(operation, spec.capabilityScope, "capabilityScope"),
        constraints: snapshotTextList(operation, spec.constraints, "constraints"),
        criteria,
        budget: {
          maxTasks: requiredInteger(operation, budget, "maxTasks"),
          maxAttemptsPerTask: requiredInteger(operation, budget, "maxAttemptsPerTask"),
          maxRunDurationMs: requiredInteger(operation, budget, "maxRunDurationMs"),
          maxWorkers: requiredInteger(operation, budget, "maxWorkers"),
          maxMemoryBytes: optionalRevision(operation, budget, "maxMemoryBytes"),
          maxDiskBytes: optionalRevision(operation, budget, "maxDiskBytes"),
          maxTokens: optionalRevision(operation, budget, "maxTokens"),
          maxCostMicros: optionalRevision(operation, budget, "maxCostMicros"),
        },
      })
      continue
    }
    if (!isPending) continue

    const budget = requiredRecord(operation, spec.budget, "budget")
    const criteriaValue = spec.criteria
    if (!Array.isArray(criteriaValue) || criteriaValue.length > MAX_LIST_ITEMS) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "criteria is not a bounded list" })
    }
    const criteria = criteriaValue.map((item) => {
      const criterion = requiredRecord(operation, item, "criterion")
      return {
        id: identifier(operation, requiredText(operation, criterion, "id", 256), "criterion.id"),
        description: requiredText(operation, criterion, "description", MAX_TEXT_BYTES),
      }
    })

    proposals.push({
      goalId: goalID,
      goalRevision,
      specVersionId: specID,
      parentVersionId: optionalText(operation, spec, "parentVersionID"),
      proposedBy: requiredText(operation, spec, "proposedBy", 256),
      reviewAvailability: {
        available: false,
        reason: "Review availability requires a trusted request context.",
      },
      specDigest: digestValue(operation, requiredText(operation, spec, "specDigest", 256), "specDigest"),
      objective: requiredText(operation, spec, "objective", MAX_TEXT_BYTES),
      projectRef: requiredText(operation, spec, "projectRef", 4096),
      workspaceRef: requiredText(operation, spec, "workspaceRef", 4096),
      capabilityScope: snapshotTextList(operation, spec.capabilityScope, "capabilityScope"),
      scope: snapshotTextList(operation, spec.scope, "scope"),
      constraints: snapshotTextList(operation, spec.constraints, "constraints"),
      criteria,
      budget: {
        maxTasks: requiredInteger(operation, budget, "maxTasks"),
        maxAttemptsPerTask: requiredInteger(operation, budget, "maxAttemptsPerTask"),
        maxRunDurationMs: requiredInteger(operation, budget, "maxRunDurationMs"),
        maxWorkers: requiredInteger(operation, budget, "maxWorkers"),
        maxMemoryBytes: optionalRevision(operation, budget, "maxMemoryBytes"),
        maxDiskBytes: optionalRevision(operation, budget, "maxDiskBytes"),
        maxTokens: optionalRevision(operation, budget, "maxTokens"),
        maxCostMicros: optionalRevision(operation, budget, "maxCostMicros"),
      },
      sourceDigests: snapshotTextList(operation, spec.sourceDigests, "sourceDigests"),
    })
  }

  return { goalID, goalRevision, projectRef, workspaceRef, proposals, acceptedSpecs, eligibleProfiles: [], eligibleProfilesTruncated: false, runs }
}

function projectEligibleProfiles(profiles: readonly AgentProfileV2.AgentProfileDefinitionV2[]) {
  const eligible = profiles
    .filter((profile) => profile.enabled && profile.source === "user" && profile.roles.includes("subagent") &&
      profile.limits.tokenBudget !== undefined && BigInt(profile.limits.tokenBudget) > 0n)
  return {
    truncated: eligible.length > 128,
    profiles: eligible.slice(0, 128)
    .map((profile) => ({
      profileId: profile.profileId,
      revision: String(profile.revision),
      name: profile.name,
      roles: [...profile.roles],
      capabilityCeiling: [...profile.capabilityCeiling],
      tokenBudget: profile.limits.tokenBudget ?? null,
    })),
  }
}

function reviewAvailability(proposal: GoalReviewProposal, principal: TrustedPrincipal): GoalReviewProposal {
  const available =
    principal.kind === "server_auth" &&
    IDENTIFIER.test(principal.subject) &&
    proposal.proposedBy !== `server_auth:${principal.subject}`
  return {
    ...proposal,
    reviewAvailability: available
      ? { available: true }
      : {
          available: false,
          reason:
            principal.kind !== "server_auth"
              ? "Review requires an authenticated ServerAuth principal."
              : proposal.proposedBy === `server_auth:${principal.subject}`
                ? "The authenticated proposer cannot review their own SpecVersion."
                : "The authenticated reviewer identity is invalid.",
        },
  }
}

function decodeSpecDecision(
  operation: string,
  decision: "ACCEPTED" | "REJECTED",
  response: Record<string, unknown>,
): SpecDecision {
  if (response.status !== decision) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: `host decision status does not match ${decision}`,
    })
  }
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    specID: identifier(operation, requiredText(operation, response, "specID", 256), "specID"),
    specDigest: digestValue(operation, requiredText(operation, response, "specDigest", 256), "specDigest"),
    decision,
    decidedBy: requiredText(operation, response, decision === "ACCEPTED" ? "acceptedBy" : "rejectedBy", 256),
    decidedAtMs: requiredInteger(operation, response, decision === "ACCEPTED" ? "acceptedAtMs" : "rejectedAtMs"),
    reviewedRevision: requiredRevision(operation, response, "reviewedRevision"),
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeRunStarted(operation: string, response: Record<string, unknown>): RunStarted {
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    specID: identifier(operation, requiredText(operation, response, "specID", 256), "specID"),
    sessionID: identifier(operation, requiredText(operation, response, "sessionID", 256), "sessionID"),
    runPhase: managedRunPhase(operation, requiredText(operation, response, "runPhase", 32)),
    revision: requiredRevision(operation, response, "revision"),
  }
}

const MANAGED_ATTEMPT_PHASES = ["ADMITTED", "EXECUTING", "SETTLING", "SUCCEEDED", "UNKNOWN", "FAILED"] as const
const MANAGED_RUN_PHASES = [
  "PLAN_ONLY",
  "RUNNING",
  "PAUSED",
  "RECONCILING",
  "CANCELLING",
  "CANCELLED",
  "VERIFYING",
  "SUCCEEDED",
  "NEEDS_YOU",
  "FAILED",
] as const

function managedAttemptPhase(operation: string, value: unknown): ManagedAttemptPhase {
  if (typeof value !== "string" || !(MANAGED_ATTEMPT_PHASES as readonly string[]).includes(value)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "attempt phase is invalid" })
  }
  return value as ManagedAttemptPhase
}

function managedRunPhase(operation: string, value: unknown): ManagedRunPhase {
  if (typeof value !== "string" || !(MANAGED_RUN_PHASES as readonly string[]).includes(value)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "run phase is invalid" })
  }
  return value as ManagedRunPhase
}

/**
 * One-use delivery key for a managed command. Short joined identifiers stay
 * readable up to 200 UTF-8 bytes; longer keys are replaced by a stable digest,
 * staying below the kernel's 256-byte identity limit while preserving the exact
 * same key for a lost-response retry.
 */
function oneUseKey(...parts: string[]): string {
  const raw = parts.join(".")
  if (Buffer.byteLength(raw, "utf8") <= MAX_RAW_DELIVERY_KEY_BYTES) return raw
  return `key.${createHash("sha256").update(raw, "utf8").digest("hex")}`
}

function requireStatus(operation: string, response: Record<string, unknown>, expected: string) {
  if (response.status !== expected) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: `host status does not match ${expected}`,
    })
  }
}

function decodeManagedAttemptAdmission(operation: string, response: Record<string, unknown>): ManagedAttemptAdmission {
  requireStatus(operation, response, "ADMITTED")
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const taskID = identifier(operation, requiredText(operation, response, "taskID", 256), "taskID")
  const attemptID = identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID")
  const parentSessionID = identifier(operation, requiredText(operation, response, "parentSessionID", 256), "parentSessionID")
  const ownerEpoch = requiredRevision(operation, response, "ownerEpoch")
  const locationID = identifier(operation, requiredText(operation, response, "locationID", 256), "locationID")
  const sessionID = identifier(operation, requiredText(operation, response, "sessionID", 256), "sessionID")
  const workspaceRevision = digestValue(operation, requiredText(operation, response, "workspaceRevision", 256), "workspaceRevision")
  const revision = requiredRevision(operation, response, "revision")
  const profileValue = requiredRecord(operation, response.profile, "profile")
  if (
    Object.keys(profileValue).toSorted().join("\0") !== ["profileID", "profileRevision", "profileDigest"].toSorted().join("\0")
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt profile pin has an invalid shape" })
  }
  const profile = {
    profileID: identifier(operation, requiredText(operation, profileValue, "profileID", 256), "profile.profileID"),
    profileRevision: requiredRevision(operation, profileValue, "profileRevision"),
    profileDigest: digestValue(operation, requiredText(operation, profileValue, "profileDigest", 256), "profile.profileDigest"),
  }
  if (!profile.profileDigest.startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed AgentProfile digest must use BLAKE3" })
  }
  const managedProviderRoute = managedProviderRouteValue(
    operation,
    requiredRecord(operation, response.managedProviderRoute, "managedProviderRoute") as unknown as ManagedProviderRouteProjectionV1,
  )
  const managedAttempt = managedAttemptScopeValue(
    operation,
    requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1,
  )
  if (
    managedAttempt.goalID !== goalID ||
    managedAttempt.runID !== runID ||
    managedAttempt.taskID !== taskID ||
    managedAttempt.attemptID !== attemptID ||
    managedAttempt.ownerEpoch !== ownerEpoch ||
    managedAttempt.locationID !== locationID ||
    managedAttempt.sessionID !== sessionID ||
    managedAttempt.workspaceRevision !== workspaceRevision ||
    managedAttempt.expectedManagedRevision !== revision
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "admission scope does not match its durable Attempt" })
  }
  const requestSequence = requiredRevision(operation, response, "requestSequence")
  const requestID = identifier(operation, requiredText(operation, response, "requestID", 256), "requestID")
  const contextSelectionDigest = decodeBlake3Digest(operation, requiredText(operation, response, "contextSelectionDigest", 256), "contextSelectionDigest")
  if (requestSequence !== "1" || managedAttempt.requestSequence !== requestSequence || managedAttempt.requestID !== requestID ||
    managedAttempt.contextSelectionDigest !== contextSelectionDigest) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "initial ContextSelection pin does not match the admitted child scope" })
  }
  if (managedAttempt.effectiveMaxTokens === "0" || managedAttempt.remainingTokens === "0") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "new managed Attempt admission requires a positive token allowance" })
  }
  return {
    goalID,
    runID,
    taskID,
    attemptID,
    parentSessionID,
    ownerEpoch,
    locationID,
    sessionID,
    workspaceRevision,
    profile,
    managedProviderRoute,
    requestSequence,
    requestID,
    contextSelectionDigest,
    attemptPhase: managedAttemptPhase(operation, response.attemptPhase),
    runPhase: managedRunPhase(operation, response.runPhase),
    revision,
    managedAttempt,
  }
}

function decodeAttemptEffectBound(operation: string, response: Record<string, unknown>): AttemptEffectBound {
  requireStatus(operation, response, "BOUND")
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
    attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
    effectID: identifier(operation, requiredText(operation, response, "effectID", 256), "effectID"),
    locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeManagedAttemptSettlement(
  operation: string,
  response: Record<string, unknown>,
): ManagedAttemptSettlement {
  requireStatus(operation, response, "SETTLED")
  const outcome = response.outcome
  if (outcome !== "SUCCEEDED" && outcome !== "FAILED" && outcome !== "UNKNOWN") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement outcome is invalid" })
  }
  const attemptPhase = managedAttemptPhase(operation, response.attemptPhase)
  // The terminal phase of a settlement is exactly the reported outcome; a host that
  // answers with any other phase must not be treated as settled.
  if (attemptPhase !== outcome) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "settlement does not match the reported attempt phase",
    })
  }
  return {
    outcome,
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
    attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
    attemptPhase,
    runPhase: managedRunPhase(operation, response.runPhase),
    receiptDigest: optionalText(operation, response, "receiptDigest"),
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeManagedUsageSummary(operation: string, raw: unknown, label: string): ManagedAttemptUsageSummaryV1 {
  const value = requiredRecord(operation, raw, label)
  const keys = [
    "accountingCursor", "tokenKnownSubtotal", "costKnownSubtotalMicros", "tokenRemainderStatus",
    "costRemainderStatus", "usageState", "stopReason", "ceilingDigest", "costStatus",
    "metricStatuses", "receiptCount", "receiptChainDigest",
  ].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label} has an invalid shape` })
  }
  const decimal = (key: "accountingCursor" | "tokenKnownSubtotal" | "costKnownSubtotalMicros" | "receiptCount") =>
    canonicalDecimalU64(operation, requiredText(operation, value, key, 32), `${label}.${key}`).toString()
  const remainder = (key: "tokenRemainderStatus" | "costRemainderStatus") => {
    const status = requiredText(operation, value, key, 16)
    if (status !== "KNOWN" && status !== "ESTIMATED" && status !== "UNKNOWN") {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.${key} is invalid` })
    }
    return status
  }
  const usageState = requiredText(operation, value, "usageState", 16)
  if (usageState !== "KNOWN" && usageState !== "ESTIMATED" && usageState !== "UNKNOWN") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.usageState is invalid` })
  }
  const stopReason = requiredText(operation, value, "stopReason", 32)
  if (!["NONE", "TOKEN_CEILING", "COST_CEILING", "USAGE_UNCERTAIN"].includes(stopReason)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.stopReason is invalid` })
  }
  const costStatus = requiredText(operation, value, "costStatus", 32)
  const allowedStatuses = ["provider-reported", "measured", "estimated", "unknown", "mixed"]
  if (!allowedStatuses.includes(costStatus)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.costStatus is invalid` })
  }
  const metrics = requiredRecord(operation, value.metricStatuses, `${label}.metricStatuses`)
  const metricKeys = ["input", "output", "reasoning", "cache.read", "cache.write"].toSorted()
  if (Object.keys(metrics).toSorted().join("\0") !== metricKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.metricStatuses has an invalid shape` })
  }
  const metricStatuses = Object.fromEntries(metricKeys.map((key) => {
    const status = requiredText(operation, metrics, key, 32)
    if (!allowedStatuses.includes(status)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label}.metricStatuses.${key} is invalid` })
    }
    return [key, status]
  }))
  const ceilingDigest = digestValue(operation, requiredText(operation, value, "ceilingDigest", 256), `${label}.ceilingDigest`)
  const receiptChainDigest = digestValue(operation, requiredText(operation, value, "receiptChainDigest", 256), `${label}.receiptChainDigest`)
  const accountingCursor = decimal("accountingCursor")
  const receiptCount = decimal("receiptCount")
  const hasUnknown = remainder("tokenRemainderStatus") === "UNKNOWN" || remainder("costRemainderStatus") === "UNKNOWN" ||
    Object.values(metricStatuses).some((status) => status === "unknown")
  const hasEstimated = remainder("tokenRemainderStatus") === "ESTIMATED" || remainder("costRemainderStatus") === "ESTIMATED" ||
    Object.values(metricStatuses).some((status) => status === "estimated")
  const expectedUsageState = hasUnknown ? "UNKNOWN" : hasEstimated ? "ESTIMATED" : "KNOWN"
  if (accountingCursor === "0" || receiptCount === "0" || BigInt(receiptCount) > 4096n ||
    BigInt(receiptCount) > BigInt(accountingCursor) || usageState !== expectedUsageState ||
    (stopReason === "USAGE_UNCERTAIN" && usageState === "KNOWN")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label} usage state, cursor or receipt count is inconsistent` })
  }
  if (!/^blake3:[0-9a-f]{64}$/.test(ceilingDigest) || !/^blake3:[0-9a-f]{64}$/.test(receiptChainDigest)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${label} digests must be complete canonical BLAKE3 values` })
  }
  return {
    accountingCursor, tokenKnownSubtotal: decimal("tokenKnownSubtotal"),
    costKnownSubtotalMicros: decimal("costKnownSubtotalMicros"),
    tokenRemainderStatus: remainder("tokenRemainderStatus") as ManagedAttemptUsageSummaryV1["tokenRemainderStatus"],
    costRemainderStatus: remainder("costRemainderStatus") as ManagedAttemptUsageSummaryV1["costRemainderStatus"],
    usageState: usageState as ManagedAttemptUsageSummaryV1["usageState"],
    stopReason: stopReason as ManagedAttemptUsageSummaryV1["stopReason"],
    ceilingDigest, costStatus, metricStatuses, receiptCount, receiptChainDigest,
  }
}

function decodeManagedSettlementCandidate(operation: string, raw: unknown): ManagedSettlementCandidateV1 {
  const candidate = requiredRecord(operation, raw, "settlementCandidate")
  const candidateKeys = [
    "goalID", "runID", "taskID", "attemptID", "bindingDigest", "specID", "specDigest", "evidenceDigest",
    "finalRevision", "effectChainDigest", "attemptStateDigest", "ownerLogID", "ownerLogSequence",
    "ownerLogEventDigest", "managedRevision", "usageAccounting",
  ].toSorted()
  if (Object.keys(candidate).toSorted().join("\0") !== candidateKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verification settlement candidate has an invalid shape" })
  }
  const decoded: ManagedSettlementCandidateV1 = {
    goalID: identifier(operation, requiredText(operation, candidate, "goalID", 256), "settlementCandidate.goalID"),
    runID: identifier(operation, requiredText(operation, candidate, "runID", 256), "settlementCandidate.runID"),
    taskID: identifier(operation, requiredText(operation, candidate, "taskID", 256), "settlementCandidate.taskID"),
    attemptID: identifier(operation, requiredText(operation, candidate, "attemptID", 256), "settlementCandidate.attemptID"),
    bindingDigest: digestValue(operation, requiredText(operation, candidate, "bindingDigest", 256), "settlementCandidate.bindingDigest"),
    specID: identifier(operation, requiredText(operation, candidate, "specID", 256), "settlementCandidate.specID"),
    specDigest: digestValue(operation, requiredText(operation, candidate, "specDigest", 256), "settlementCandidate.specDigest"),
    evidenceDigest: digestValue(operation, requiredText(operation, candidate, "evidenceDigest", 256), "settlementCandidate.evidenceDigest"),
    finalRevision: digestValue(operation, requiredText(operation, candidate, "finalRevision", 256), "settlementCandidate.finalRevision"),
    effectChainDigest: digestValue(operation, requiredText(operation, candidate, "effectChainDigest", 256), "settlementCandidate.effectChainDigest"),
    attemptStateDigest: digestValue(operation, requiredText(operation, candidate, "attemptStateDigest", 256), "settlementCandidate.attemptStateDigest"),
    usageAccounting: decodeManagedUsageSummary(operation, candidate.usageAccounting, "settlementCandidate.usageAccounting"),
    ownerLogID: identifier(operation, requiredText(operation, candidate, "ownerLogID", 256), "settlementCandidate.ownerLogID"),
    ownerLogSequence: canonicalDecimalU64(operation, requiredText(operation, candidate, "ownerLogSequence", 32), "settlementCandidate.ownerLogSequence").toString(),
    ownerLogEventDigest: digestValue(operation, requiredText(operation, candidate, "ownerLogEventDigest", 256), "settlementCandidate.ownerLogEventDigest"),
    managedRevision: canonicalDecimalU64(operation, requiredText(operation, candidate, "managedRevision", 32), "settlementCandidate.managedRevision").toString(),
  }
  for (const key of ["bindingDigest", "specDigest", "evidenceDigest", "finalRevision", "effectChainDigest", "attemptStateDigest", "ownerLogEventDigest"] as const) {
    if (!decoded[key].startsWith("blake3:")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `settlement candidate ${key} must use BLAKE3` })
    }
  }
  if (BigInt(decoded.usageAccounting.accountingCursor) > BigInt(decoded.managedRevision)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement candidate accounting cursor exceeds its managed revision" })
  }
  return decoded
}

function decodeManagedDispatchSettlementReceipt(
  operation: string,
  response: Record<string, unknown>,
  expected: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly verifier?: ManagedVerifierSettlementPinsV1
    readonly finalRevision?: string
    readonly finalInspect?: ManagedFinalInspectReceiptV1
  },
): ManagedDispatchSettlementResultV1 {
  if (response.status === "QUARANTINED") {
    const fields = [
      "status", "goalID", "runID", "taskID", "attemptID", "workerExecutionID", "ownerEpoch",
      "reservationID", "worktreeLeaseID", "reason", "terminalProofDigest", "ownerLogID",
      "ownerLogSequence", "ownerLogEventDigest", "workerPoolRevision", "receiptDigest",
    ].toSorted()
    if (expected.verifier || Object.keys(response).toSorted().join("\0") !== fields.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "non-success P8 quarantine receipt contains verifier pins or has an invalid shape" })
    }
    if (response.reason !== "FAILED_ATTEMPT" && response.reason !== "CANCELLED_TASK") {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 quarantine reason is invalid" })
    }
    for (const key of ["ownerLogSequence", "workerPoolRevision"] as const) requiredDecimalU64(operation, response, key)
    for (const key of ["terminalProofDigest", "ownerLogEventDigest", "receiptDigest"] as const) {
      decodeBlake3Digest(operation, requiredText(operation, response, key, 256), key)
    }
    for (const key of ["goalID", "runID", "taskID", "attemptID", "workerExecutionID", "reservationID", "worktreeLeaseID", "ownerLogID"] as const) {
      identifier(operation, requiredText(operation, response, key, 256), key)
    }
    const receipt: ManagedDispatchQuarantineReceiptV1 = {
      status: "QUARANTINED",
      goalID: requiredText(operation, response, "goalID", 256),
      runID: requiredText(operation, response, "runID", 256),
      taskID: requiredText(operation, response, "taskID", 256),
      attemptID: requiredText(operation, response, "attemptID", 256),
      workerExecutionID: requiredText(operation, response, "workerExecutionID", 256),
      ownerEpoch: requiredDecimalU64(operation, response, "ownerEpoch"),
      reservationID: requiredText(operation, response, "reservationID", 256),
      worktreeLeaseID: requiredText(operation, response, "worktreeLeaseID", 256),
      reason: response.reason,
      terminalProofDigest: requiredText(operation, response, "terminalProofDigest", 256),
      ownerLogID: requiredText(operation, response, "ownerLogID", 256),
      ownerLogSequence: requiredDecimalU64(operation, response, "ownerLogSequence"),
      ownerLogEventDigest: requiredText(operation, response, "ownerLogEventDigest", 256),
      workerPoolRevision: requiredDecimalU64(operation, response, "workerPoolRevision"),
      receiptDigest: requiredText(operation, response, "receiptDigest", 256),
    }
    if (BigInt(receipt.ownerEpoch) < 1n || BigInt(receipt.ownerLogSequence) < 1n || BigInt(receipt.workerPoolRevision) < 1n) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 quarantine receipt epoch and revisions must be positive" })
    }
    if (receipt.goalID !== expected.goalID || receipt.runID !== expected.runID || receipt.taskID !== expected.taskID || receipt.attemptID !== expected.attemptID) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 quarantine receipt identifies another exact Attempt" })
    }
    return receipt
  }
  requireStatus(operation, response, "SETTLED")
  if (!expected.verifier) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verified P8 settlement requires the exact ChallengeSet tuple" })
  }
  const fields = [
    "goalID", "runID", "taskID", "attemptID", "verificationRunID", "setIdentityDigest", "challengeSetDigest", "workerExecutionID", "disposition", "proofDigest",
    "ownerLogID", "ownerLogSequence", "ownerLogEventDigest", "workerPoolRevision", "receiptDigest", "worktreeDisposition",
  ] as const
  if (Object.keys(response).toSorted().join("\0") !== [...fields, "status"].toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "WorkerPool settlement receipt has an invalid shape" })
  }
  if (response.disposition !== "RELEASED" && response.disposition !== "WORKTREE_QUARANTINED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "WorkerPool settlement disposition is invalid" })
  }
  for (const key of ["ownerLogSequence", "workerPoolRevision"] as const) requiredDecimalU64(operation, response, key)
  for (const key of ["proofDigest", "ownerLogEventDigest", "receiptDigest"] as const) {
    const digest = digestValue(operation, requiredText(operation, response, key, 256), key)
    if (!digest.startsWith("blake3:")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
    }
  }
  for (const key of ["goalID", "runID", "taskID", "attemptID", "workerExecutionID", "ownerLogID"] as const) {
    identifier(operation, requiredText(operation, response, key, 256), key)
  }
  if (requiredText(operation, response, "verificationRunID", 256) !== expected.verifier.verificationRunID ||
      decodeBlake3Digest(operation, requiredText(operation, response, "setIdentityDigest", 256), "setIdentityDigest") !== expected.verifier.setIdentityDigest ||
      decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest") !== expected.verifier.challengeSetDigest) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 settlement receipt changed the exact verified ChallengeSet identity" })
  }
  const disposition = requiredRecord(operation, response.worktreeDisposition, "worktreeDisposition")
  const dispositionKeys = [
    "ownerEpoch", "disposition", "settlementReceiptDigest", "finalWorktreeOperationID",
    "finalWorktreeHostReceiptRef", "observedWorkspaceRevision", "inspectReceiptDigest", "ownerLogID",
    "ownerLogSequence", "ownerLogEventDigest", "workerPoolRevision", "receiptDigest",
  ].toSorted()
  if (Object.keys(disposition).toSorted().join("\0") !== dispositionKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 worktree disposition receipt has an invalid shape" })
  }
  if (disposition.disposition !== "REUSABLE" && disposition.disposition !== "QUARANTINED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 worktree disposition is invalid" })
  }
  for (const key of ["ownerEpoch", "ownerLogSequence", "workerPoolRevision"] as const) {
    const value = requiredText(operation, disposition, key, 32)
    if (canonicalDecimalU64(operation, value, key) < 1n) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `P8 ${key} must be positive` })
    }
  }
  if (requiredDecimalU64(operation, disposition, "ownerEpoch") !== expected.verifier.ownerEpoch) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 worktree disposition belongs to another HostKernel owner epoch" })
  }
  for (const key of ["settlementReceiptDigest", "finalWorktreeHostReceiptRef", "observedWorkspaceRevision", "inspectReceiptDigest", "ownerLogEventDigest", "receiptDigest"] as const) {
    const value = digestValue(operation, requiredText(operation, disposition, key, 256), key)
    if (!value.startsWith("blake3:")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `P8 ${key} must use BLAKE3` })
    }
  }
  const finalWorktreeOperationID = identifier(operation, requiredText(operation, disposition, "finalWorktreeOperationID", 256), "finalWorktreeOperationID")
  const dispositionOwnerLogID = identifier(operation, requiredText(operation, disposition, "ownerLogID", 256), "worktreeDisposition.ownerLogID")
  const nestedSequence = requiredText(operation, disposition, "ownerLogSequence", 32)
  const nestedPoolRevision = requiredText(operation, disposition, "workerPoolRevision", 32)
  const nestedEventDigest = requiredText(operation, disposition, "ownerLogEventDigest", 256)
  const nestedReceiptDigest = requiredText(operation, disposition, "receiptDigest", 256)
  const exactAttempt = (key: "goalID" | "runID" | "taskID" | "attemptID") => requiredText(operation, response, key, 256)
  if (exactAttempt("goalID") !== expected.goalID || exactAttempt("runID") !== expected.runID ||
      exactAttempt("taskID") !== expected.taskID || exactAttempt("attemptID") !== expected.attemptID) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 settlement receipt identifies another exact Attempt" })
  }
  if (disposition.settlementReceiptDigest !== response.receiptDigest) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 disposition receipt is not bound to the exact logical settlement receipt" })
  }
  if ((response.disposition === "RELEASED" && disposition.disposition !== "REUSABLE") ||
      (response.disposition === "WORKTREE_QUARANTINED" && disposition.disposition !== "QUARANTINED")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 logical and worktree dispositions conflict" })
  }
  if (expected.finalRevision !== undefined && disposition.observedWorkspaceRevision !== expected.finalRevision) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 disposition receipt is not bound to the exact final workspace revision" })
  }
  if (expected.finalInspect && (finalWorktreeOperationID !== expected.finalInspect.operationID ||
      disposition.finalWorktreeHostReceiptRef !== expected.finalInspect.hostReceiptRef ||
      disposition.observedWorkspaceRevision !== expected.finalInspect.workspaceRevision)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 disposition receipt does not match the final Inspect receipt" })
  }
  if (expected.finalInspect && ((expected.finalInspect.worktreeStatus === "DIRTY_OWNED" && disposition.disposition !== "QUARANTINED") ||
      (expected.finalInspect.worktreeStatus === "CLEAN" && disposition.disposition !== "REUSABLE"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 disposition does not match the final Inspect worktree status" })
  }
  const worktreeDisposition = {
    ownerEpoch: requiredText(operation, disposition, "ownerEpoch", 32),
    disposition: disposition.disposition as "REUSABLE" | "QUARANTINED",
    settlementReceiptDigest: requiredText(operation, disposition, "settlementReceiptDigest", 256),
    finalWorktreeOperationID,
    finalWorktreeHostReceiptRef: requiredText(operation, disposition, "finalWorktreeHostReceiptRef", 256),
    observedWorkspaceRevision: requiredText(operation, disposition, "observedWorkspaceRevision", 256),
    inspectReceiptDigest: requiredText(operation, disposition, "inspectReceiptDigest", 256),
    ownerLogID: dispositionOwnerLogID,
    ownerLogSequence: nestedSequence,
    ownerLogEventDigest: nestedEventDigest,
    workerPoolRevision: nestedPoolRevision,
    receiptDigest: nestedReceiptDigest,
  }
  return Object.fromEntries([
    ...fields.filter((key) => key !== "worktreeDisposition").map((key) => [key, requiredText(operation, response, key, 256)]),
    ["status", "SETTLED"],
    ["worktreeDisposition", worktreeDisposition],
  ]) as unknown as ManagedDispatchSettlementReceiptV1
}

type ManagedTerminalSettlementRecoveryV1 = {
  readonly status: "SETTLEMENT_PENDING"
  readonly verification: ManagedVerifierSettlementPinsV1
  /** Rust reducer may have committed the terminal Attempt immediately before Run finalization. */
  readonly runPhase: "VERIFYING" | "SUCCEEDED"
  readonly finalRevision: string
  readonly evidenceDigest: string
  readonly usageAccounting: ManagedAttemptUsageSummaryV1
  readonly managedRevision: string
  readonly recoveredArtifactRefs: readonly VerifierArtifactRefV1[]
}

declare const verifierSettlementPinsBrand: unique symbol
type ManagedVerifierSettlementPinsV1 = Pick<VerificationStarted,
  "schemaVersion" | "goalID" | "runID" | "taskID" | "attemptID" | "ownerEpoch" |
  "specID" | "specDigest" | "profileID" | "profileRevision" | "profileDigest" |
  "finalRevision" | "evidencePlanDigest" | "verificationRunID" | "setIdentityDigest" | "challengeSetDigest"
> & { readonly [verifierSettlementPinsBrand]: true }

const authenticatedVerifierSettlementPins = new WeakSet<object>()

function trustVerifierSettlementPins(
  value: Omit<ManagedVerifierSettlementPinsV1, typeof verifierSettlementPinsBrand>,
): ManagedVerifierSettlementPinsV1 {
  const pins = { ...value } as ManagedVerifierSettlementPinsV1
  authenticatedVerifierSettlementPins.add(pins)
  return pins
}

function decodeManagedSettlementRecovery(
  operation: string,
  response: Record<string, unknown>,
  expected: { readonly goalID: string; readonly runID: string },
): ManagedTerminalSettlementRecoveryV1 | { readonly status: "NO_SETTLEMENT_PENDING"; readonly goalID: string; readonly runID: string } {
  const status = requiredText(operation, response, "status", 32)
  if (status === "NO_SETTLEMENT_PENDING") {
    if (Object.keys(response).toSorted().join("\0") !== ["status", "goalID", "runID"].toSorted().join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "empty settlement recovery projection has an invalid shape" })
    }
    const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
    const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
    if (goalID !== expected.goalID || runID !== expected.runID) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement recovery changed its requested Goal or Run" })
    }
    return { status, goalID, runID }
  }
  const pinKeys = ["schemaVersion", "taskID", "attemptID", "ownerEpoch", "specID", "specDigest", "profileID", "profileRevision", "profileDigest", "finalRevision", "evidencePlanDigest", "verificationRunID", "setIdentityDigest", "challengeSetDigest"]
  if (status !== "SETTLEMENT_PENDING" || Object.keys(response).toSorted().join("\0") !== ["status", "goalID", "runID", ...pinKeys, "terminalSnapshot"].toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "pending settlement recovery projection has an invalid shape" })
  }
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  if (goalID !== expected.goalID || runID !== expected.runID) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement recovery changed its requested Goal or Run" })
  }
  const snapshot = requiredRecord(operation, response.terminalSnapshot, "terminalSnapshot")
  const keys = [
    "goalID", "runID", "taskID", "attemptID", "taskRevision", "attemptRevision", "managedRevision",
    "admissionWorkspaceRevision", "observedWorkspaceHead", "finalRevision", "evidenceRefs", "specID", "specDigest", "runPhase", "taskState",
    "attemptState", "childPromptState", "childPromptQuiescenceDigest", "bindingDigest", "ownerLogID",
    "ownerLogSequence", "ownerLogEventDigest", "attemptStateDigest", "effectChainState", "effectChainDigest", "evidenceDigest", "usageAccounting",
  ].toSorted()
  if (Object.keys(snapshot).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal settlement snapshot has an invalid shape" })
  }
  const snapshotGoalID = identifier(operation, requiredText(operation, snapshot, "goalID", 256), "terminalSnapshot.goalID")
  const snapshotRunID = identifier(operation, requiredText(operation, snapshot, "runID", 256), "terminalSnapshot.runID")
  const taskID = identifier(operation, requiredText(operation, snapshot, "taskID", 256), "terminalSnapshot.taskID")
  const attemptID = identifier(operation, requiredText(operation, snapshot, "attemptID", 256), "terminalSnapshot.attemptID")
  const identity = decodeVerifierChallengeIdentity(operation, response)
  const responseTaskID = identifier(operation, requiredText(operation, response, "taskID", 256), "taskID")
  const responseAttemptID = identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID")
  const states = ["runPhase", "taskState", "attemptState", "childPromptState", "effectChainState"] as const
  const stateValues = Object.fromEntries(states.map((key) => [key, requiredText(operation, snapshot, key, 64)]))
  if (snapshotGoalID !== goalID || snapshotRunID !== runID || responseTaskID !== taskID || responseAttemptID !== attemptID ||
      !["Verifying", "Succeeded"].includes(stateValues.runPhase) ||
      stateValues.taskState !== "Verified" || stateValues.attemptState !== "Succeeded" ||
      stateValues.childPromptState !== "Quiesced" || stateValues.effectChainState !== "AllSettled") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal snapshot is not the exact verified, quiesced, all-settled child" })
  }
  const finalRevision = digestValue(operation, requiredText(operation, snapshot, "finalRevision", 256), "finalRevision")
  const responseFinalRevision = digestValue(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision")
  const observedWorkspaceHead = digestValue(operation, requiredText(operation, snapshot, "observedWorkspaceHead", 256), "observedWorkspaceHead")
  const evidenceDigest = digestValue(operation, requiredText(operation, snapshot, "evidenceDigest", 256), "evidenceDigest")
  const usageAccounting = decodeManagedUsageSummary(operation, snapshot.usageAccounting, "terminalSnapshot.usageAccounting")
  if (!finalRevision.startsWith("blake3:") || responseFinalRevision !== finalRevision || observedWorkspaceHead !== finalRevision || !evidenceDigest.startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal workspace/evidence pin must use BLAKE3" })
  }
  if (!Array.isArray(snapshot.evidenceRefs) || snapshot.evidenceRefs.length < 1 || snapshot.evidenceRefs.length > 256) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal evidence refs are not a bounded nonempty list" })
  }
  const recoveredArtifactRefs = snapshot.evidenceRefs.map((raw): VerifierArtifactRefV1 => {
    const artifact = requiredRecord(operation, raw, "terminal evidence ref")
    const artifactKeys = ["artifactId", "digest", "byteLength", "mediaType", "classification"].toSorted()
    if (Object.keys(artifact).toSorted().join("\0") !== artifactKeys.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal evidence ref has an invalid shape" })
    }
    identifier(operation, requiredText(operation, artifact, "artifactId", 256), "artifactId")
    const digest = digestValue(operation, requiredText(operation, artifact, "digest", 256), "artifact.digest")
    if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal artifact digest must use BLAKE3" })
    requiredDecimalU64(operation, artifact, "byteLength")
    const mediaType = requiredText(operation, artifact, "mediaType", 256)
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal artifact media type is invalid" })
    }
    const classification = requiredText(operation, artifact, "classification", 32)
    if (!["public", "workspace", "sensitive"].includes(classification)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal artifact classification is invalid" })
    }
    return {
      artifactID: requiredText(operation, artifact, "artifactId", 256),
      digest,
      byteLength: requiredDecimalU64(operation, artifact, "byteLength"),
      mediaType,
      classification: classification.toUpperCase() as VerifierArtifactRefV1["classification"],
    }
  })
  for (const key of ["taskRevision", "attemptRevision", "managedRevision", "ownerLogSequence"] as const) requiredDecimalU64(operation, snapshot, key)
  for (const key of ["admissionWorkspaceRevision", "childPromptQuiescenceDigest"] as const) {
    const value = snapshot[key]
    if (value !== null) {
      const digest = digestValue(operation, requiredText(operation, snapshot, key, 256), key)
      if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
    }
  }
  for (const key of ["specDigest", "bindingDigest", "ownerLogEventDigest", "attemptStateDigest", "effectChainDigest"] as const) {
    const digest = digestValue(operation, requiredText(operation, snapshot, key, 256), key)
    if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
  }
  if (BigInt(usageAccounting.accountingCursor) > BigInt(requiredDecimalU64(operation, snapshot, "managedRevision"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "terminal accounting cursor exceeds its managed revision" })
  }
  identifier(operation, requiredText(operation, snapshot, "specID", 256), "specID")
  const specID = identifier(operation, requiredText(operation, snapshot, "specID", 256), "terminalSnapshot.specID")
  const specDigest = decodeBlake3Digest(operation, requiredText(operation, snapshot, "specDigest", 256), "terminalSnapshot.specDigest")
  if (identity.specID !== specID || identity.specDigest !== specDigest) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovered verifier Spec pins differ from the terminal Attempt" })
  }
  identifier(operation, requiredText(operation, snapshot, "ownerLogID", 256), "ownerLogID")
  const verificationRunID = identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID")
  const challengeSetDigest = decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest")
  const setIdentityDigest = decodeBlake3Digest(operation, requiredText(operation, response, "setIdentityDigest", 256), "setIdentityDigest")
  if (identity.setIdentityDigest !== setIdentityDigest || responseFinalRevision !== finalRevision ||
      verificationRunID !== `verification_${setIdentityDigest.slice(7)}`) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "recovered challenge-set identity changed its durable pins" })
  }
  const verification = trustVerifierSettlementPins({
      ...identity, goalID, runID, taskID, attemptID,
      finalRevision: responseFinalRevision,
      verificationRunID,
      setIdentityDigest,
      challengeSetDigest,
  })
  return {
    status: "SETTLEMENT_PENDING",
    verification,
    runPhase: stateValues.runPhase === "Succeeded" ? "SUCCEEDED" : "VERIFYING",
    finalRevision, evidenceDigest, usageAccounting,
    managedRevision: requiredDecimalU64(operation, snapshot, "managedRevision"),
    recoveredArtifactRefs,
  }
}

function decodeRunPhaseChange(
  operation: string,
  response: Record<string, unknown>,
  expected: { readonly status: "PAUSED" | "RUNNING" | "CANCELLED" | "CANCELLING"; readonly runPhase: ManagedRunPhase },
): ManagedRunPhaseChange {
  requireStatus(operation, response, expected.status)
  const runPhase = managedRunPhase(operation, response.runPhase)
  if (runPhase !== expected.runPhase) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: `run phase does not match ${expected.runPhase}`,
    })
  }
  return {
    status: expected.status,
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    runPhase,
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeVerificationApprovalLocation(
  operation: string,
  raw: unknown,
  finalRevision: string,
  challenges: ReadonlyArray<{ readonly locationID: string }>,
): ManagedVerificationApprovalLocationV1 {
  const approvalValue = requiredRecord(operation, raw, "approvalLocation")
  const approvalKeys = ["locationID", "workspaceID", "canonicalRoot", "workspaceRevision"].toSorted()
  if (Object.keys(approvalValue).toSorted().join("\0") !== approvalKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier approval Location projection has an invalid shape" })
  }
  const approvalLocation = {
    locationID: identifier(operation, requiredText(operation, approvalValue, "locationID", 256), "approvalLocation.locationID"),
    workspaceID: identifier(operation, requiredText(operation, approvalValue, "workspaceID", 256), "approvalLocation.workspaceID"),
    canonicalRoot: requiredText(operation, approvalValue, "canonicalRoot", 4096),
    workspaceRevision: digestValue(operation, requiredText(operation, approvalValue, "workspaceRevision", 256), "approvalLocation.workspaceRevision"),
  }
  if (!approvalLocation.canonicalRoot.startsWith("/") || approvalLocation.workspaceRevision !== finalRevision ||
      challenges.some((challenge) => challenge.locationID !== approvalLocation.locationID)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier approval Location does not match the frozen child Attempt revision and challenge set" })
  }
  return approvalLocation
}

type VerifierChallengeIdentityV1 = Pick<VerificationStarted,
  "schemaVersion" | "ownerEpoch" | "specID" | "specDigest" | "profileID" |
  "profileRevision" | "profileDigest" | "evidencePlanDigest" | "setIdentityDigest"
>

/** Decode the complete HostKernel-authored challenge identity; callers never provide these pins. */
function decodeVerifierChallengeIdentity(
  operation: string,
  value: Record<string, unknown>,
): VerifierChallengeIdentityV1 {
  if (requiredInteger(operation, value, "schemaVersion") !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge identity schema version is unsupported" })
  }
  const ownerEpoch = requiredDecimalU64(operation, value, "ownerEpoch")
  const profileRevision = requiredDecimalU64(operation, value, "profileRevision")
  if (BigInt(ownerEpoch) < 1n || BigInt(profileRevision) < 1n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge identity counters must be positive" })
  }
  const specDigest = decodeBlake3Digest(operation, requiredText(operation, value, "specDigest", 256), "specDigest")
  const profileDigest = decodeBlake3Digest(operation, requiredText(operation, value, "profileDigest", 256), "profileDigest")
  const evidencePlanDigest = decodeBlake3Digest(operation, requiredText(operation, value, "evidencePlanDigest", 256), "evidencePlanDigest")
  const setIdentityDigest = decodeBlake3Digest(operation, requiredText(operation, value, "setIdentityDigest", 256), "setIdentityDigest")
  return {
    schemaVersion: 1,
    ownerEpoch,
    specID: identifier(operation, requiredText(operation, value, "specID", 256), "specID"),
    specDigest,
    profileID: identifier(operation, requiredText(operation, value, "profileID", 256), "profileID"),
    profileRevision,
    profileDigest,
    evidencePlanDigest,
    setIdentityDigest,
  }
}

function decodeVerificationStarted(operation: string, response: Record<string, unknown>): VerificationStarted {
  const status = requiredText(operation, response, "status", 32)
  if (!["NEEDS_APPROVAL", "RESUME_EXECUTION", "SETTLING", "UNKNOWN"].includes(status)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier start status is invalid" })
  }
  const identity = decodeVerifierChallengeIdentity(operation, response)
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const pinKeys = ["schemaVersion", "ownerEpoch", "specID", "specDigest", "profileID", "profileRevision", "profileDigest", "evidencePlanDigest", "setIdentityDigest"]
  if (status === "UNKNOWN") {
    const expectedKeys = ["status", "goalID", "runID", "taskID", "attemptID", ...pinKeys, "verificationRunID", "challengeSetDigest", "finalRevision", "sourceRevision", "reason", "revision"].toSorted()
    if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "UNKNOWN verifier recovery projection has an invalid shape" })
    }
    const reason = requiredText(operation, response, "reason", 64)
    const reasons: ManagedVerifierUnknownReasonV1[] = ["cancelled_before_next_test", "guarded_execution_unavailable", "execution_outcome_unknown", "workspace_revision_changed", "verification_incomplete"]
    if (!reasons.includes(reason as ManagedVerifierUnknownReasonV1)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "UNKNOWN verifier recovery reason is invalid" })
    }
    const verificationRunID = identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID")
    if (verificationRunID !== `verification_${identity.setIdentityDigest.slice(7)}`) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "UNKNOWN verifier run ID is not derived from the stable ChallengeSet identity" })
    }
    return {
      status,
      ...identity,
      goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
      runID,
      taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
      attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
      finalRevision: decodeBlake3Digest(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision"),
      verificationRunID,
      challengeSetDigest: decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest"),
      sourceRevision: decodeBlake3Digest(operation, requiredText(operation, response, "sourceRevision", 256), "sourceRevision"),
      reason: reason as ManagedVerifierUnknownReasonV1,
      revision: requiredRevision(operation, response, "revision"),
    }
  }
  const expectedKeys = ["status", "goalID", "runID", "taskID", "attemptID", ...pinKeys, "verificationRunID", "challengeSetDigest", "finalRevision", "approvalLocation", "evidenceDigest", "artifactRefs", "challenges", "revision"].toSorted()
  const settlingKeys = ["status", "goalID", "runID", "taskID", "attemptID", ...pinKeys, "verificationRunID", "challengeSetDigest", "finalRevision", "sourceRevision", "approvalLocation", "evidenceDigest", "artifactRefs", "settlementCandidate", "revision"].toSorted()
  if (status === "SETTLING") {
    if (Object.keys(response).toSorted().join("\0") !== settlingKeys.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settling verifier recovery projection has an invalid shape" })
    }
    const finalRevision = decodeBlake3Digest(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision")
    const sourceRevision = digestValue(operation, requiredText(operation, response, "sourceRevision", 256), "sourceRevision")
    const evidenceDigest = digestValue(operation, requiredText(operation, response, "evidenceDigest", 256), "evidenceDigest")
    const settlementCandidate = decodeManagedSettlementCandidate(operation, response.settlementCandidate)
    const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
    const taskID = identifier(operation, requiredText(operation, response, "taskID", 256), "taskID")
    const attemptID = identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID")
    const revision = requiredRevision(operation, response, "revision")
    if (sourceRevision !== finalRevision || settlementCandidate.finalRevision !== finalRevision ||
        settlementCandidate.evidenceDigest !== evidenceDigest || settlementCandidate.goalID !== goalID || settlementCandidate.runID !== runID ||
        settlementCandidate.specID !== identity.specID || settlementCandidate.specDigest !== identity.specDigest ||
        settlementCandidate.managedRevision !== revision ||
        !Array.isArray(response.artifactRefs)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settling recovery evidence or final revision changed" })
    }
    const artifactRefs = decodeVerifierArtifactRefs(operation, response.artifactRefs)
    if (settlementCandidate.taskID !== taskID || settlementCandidate.attemptID !== attemptID) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settling recovery candidate identifies another Task or Attempt" })
    }
    const approvalLocation = decodeVerificationApprovalLocation(operation, response.approvalLocation, finalRevision, [])
    const verificationRunID = identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID")
    const challengeSetDigest = decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest")
    if (verificationRunID !== `verification_${identity.setIdentityDigest.slice(7)}`) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier run ID is not derived from the stable ChallengeSet identity" })
    }
    return {
      status: "SETTLING",
      ...identity,
      goalID,
      runID,
      taskID,
      attemptID,
      finalRevision,
      approvalLocation,
      verificationRunID,
      challengeSetDigest,
      challenges: [],
      revision,
      sourceRevision,
      evidenceDigest,
      artifactRefs,
      settlementCandidate,
    }
  }
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0") || response.evidenceDigest !== null || !Array.isArray(response.artifactRefs) || response.artifactRefs.length !== 0) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier start projection has an invalid shape or contains premature evidence" })
  }
  if (
    !Array.isArray(response.challenges) ||
    (status === "NEEDS_APPROVAL" && response.challenges.length === 0) ||
    (status === "RESUME_EXECUTION" && response.challenges.length !== 0) ||
    response.challenges.length > MAX_VERIFIER_CRITERIA
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge set is invalid" })
  }
  const challenges = response.challenges.map((value): VerifierApprovalChallenge => {
    const challenge = requiredRecord(operation, value, "verifier challenge")
    const challengeKeys = [
      "criterionID",
      "challengeID",
      "effectID",
      "capabilityID",
      "locationID",
      "inputDigest",
      "normalizedTargets",
      "expiresAtUnixMs",
      "policySummary",
      "origin",
      "source",
      "policyID",
      "policyDigest",
      "normalizedAction",
      "argumentSummary",
      "requestedGuarantees",
      "guaranteeAssessment",
      "runID",
      "noResponse",
      "allowEnabled",
    ]
    if (Object.keys(challenge).toSorted().join("\0") !== challengeKeys.toSorted().join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge has an invalid shape" })
    }
    const capabilityID = requiredText(operation, challenge, "capabilityID", 256)
    const normalizedTargets = challenge.normalizedTargets
    const expiresAtUnixMs = requiredInteger(operation, challenge, "expiresAtUnixMs")
    if (
      capabilityID !== "builtin.verifier" ||
      !Array.isArray(normalizedTargets) ||
      normalizedTargets.length === 0 ||
      normalizedTargets.length > 64 ||
      expiresAtUnixMs <= Date.now() ||
      expiresAtUnixMs > Date.now() + 5 * 60 * 1000
    ) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge is invalid" })
    }
    const origin = requiredText(operation, challenge, "origin", 64)
    const source = requiredText(operation, challenge, "source", 128)
    const normalizedAction = requiredText(operation, challenge, "normalizedAction", 256)
    const noResponse = requiredText(operation, challenge, "noResponse", 64)
    const argumentSummaryValue = requiredRecord(operation, challenge.argumentSummary, "argumentSummary")
    const argumentSummaryStatus = requiredText(operation, argumentSummaryValue, "status", 32)
    const argumentSummary: GuardArgumentSummaryV1 =
      argumentSummaryStatus === "available"
        ? { status: "available", text: requiredText(operation, argumentSummaryValue, "text", 512) }
        : argumentSummaryStatus === "unavailable"
          ? (() => {
              if (requiredText(operation, argumentSummaryValue, "reason", 128) !== "safe_argument_summary_unavailable") {
                throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier argument summary reason is invalid" })
              }
              return { status: "unavailable" as const, reason: "safe_argument_summary_unavailable" }
            })()
          : (() => {
              throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier argument summary is invalid" })
            })()
    const requestedGuarantees = challenge.requestedGuarantees
    if (
      origin !== "managed_run" ||
      source !== "host.managed_verifier" ||
      normalizedAction !== "builtin.verifier" ||
      noResponse !== "deny_and_expire" ||
      !Array.isArray(requestedGuarantees) ||
      requestedGuarantees.length === 0 ||
      requestedGuarantees.length > 16 ||
      !requestedGuarantees.every((item) => typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item))
    ) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier Guard projection is invalid" })
    }
    const guaranteeValue = requiredRecord(operation, challenge.guaranteeAssessment, "guaranteeAssessment")
    const guaranteeStatus = requiredText(operation, guaranteeValue, "status", 32)
    if (Object.keys(guaranteeValue).toSorted().join("\0") !== "residual\0status" ||
        guaranteeStatus !== "not_assessed" || guaranteeValue.residual !== null) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier guarantee assessment must remain not_assessed with null residual" })
    }
    const guaranteeAssessment: GuardGuaranteeAssessmentV1 = { status: "not_assessed", residual: null }
    return {
      criterionID: identifier(operation, requiredText(operation, challenge, "criterionID", 256), "criterionID"),
      challengeID: identifier(operation, requiredText(operation, challenge, "challengeID", 256), "challengeID"),
      effectID: identifier(operation, requiredText(operation, challenge, "effectID", 256), "effectID"),
      capabilityID,
      locationID: identifier(operation, requiredText(operation, challenge, "locationID", 256), "locationID"),
      inputDigest: decodeBlake3Digest(operation, requiredText(operation, challenge, "inputDigest", 256), "inputDigest"),
      normalizedTargets,
      expiresAtUnixMs,
      policySummary: requiredText(operation, challenge, "policySummary", 512),
      origin,
      source,
      policyID: identifier(operation, requiredText(operation, challenge, "policyID", 256), "policyID"),
      policyDigest: decodeBlake3Digest(operation, requiredText(operation, challenge, "policyDigest", 256), "policyDigest"),
      normalizedAction,
      argumentSummary,
      requestedGuarantees,
      guaranteeAssessment,
      runID: (() => {
        const challengeRunID = identifier(operation, requiredText(operation, challenge, "runID", 256), "runID")
        if (challengeRunID !== runID) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenge belongs to a different Run" })
        }
        return challengeRunID
      })(),
      noResponse,
      allowEnabled: (() => {
        if (requiredBoolean(operation, challenge, "allowEnabled")) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed verifier approval must remain deny-only" })
        }
        return false as const
      })(),
    }
  })
  const finalRevision = decodeBlake3Digest(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision")
  const approvalLocation = decodeVerificationApprovalLocation(operation, response.approvalLocation, finalRevision, challenges)
  const criteria = new Set(challenges.map((challenge) => challenge.criterionID))
  const challengeIDs = new Set(challenges.map((challenge) => challenge.challengeID))
  const effectIDs = new Set(challenges.map((challenge) => challenge.effectID))
  if (criteria.size !== challenges.length || challengeIDs.size !== challenges.length || effectIDs.size !== challenges.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenges are duplicated" })
  }
  const verificationRunID = identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID")
  const challengeSetDigest = decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest")
  if (verificationRunID !== `verification_${identity.setIdentityDigest.slice(7)}`) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier run ID is not derived from the stable ChallengeSet identity" })
  }
  return {
    status: status as "NEEDS_APPROVAL" | "RESUME_EXECUTION",
    ...identity,
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID,
    taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
    attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
    finalRevision,
    approvalLocation,
    verificationRunID,
    setIdentityDigest: decodeBlake3Digest(operation, requiredText(operation, response, "setIdentityDigest", 256), "setIdentityDigest"),
    challengeSetDigest,
    challenges,
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeManagedRootInspectChallenge(
  operation: string,
  response: Record<string, unknown>,
  registeredLocationID: string,
): ManagedRootGuardChallengeV1 {
  const expectedKeys = [
    "status", "challengeID", "effectID", "capabilityID", "locationID", "inputDigest", "targets",
    "normalizedTargets", "expiresAtUnixMs", "policySummary", "origin", "source", "policyID", "policyDigest",
    "normalizedAction", "argumentSummary", "requestedGuarantees", "guaranteeAssessment",
  ].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect challenge has an invalid shape" })
  }
  const value = {
    ...response,
    noResponse: "deny_and_expire",
    allowEnabled: (() => {
      const assessment = response.guaranteeAssessment
      return typeof assessment === "object" && assessment !== null && !Array.isArray(assessment) &&
        (assessment as Record<string, unknown>).status === "assessed" &&
        Array.isArray((assessment as Record<string, unknown>).residual) &&
        ((assessment as Record<string, unknown>).residual as unknown[]).length === 0 &&
        (response.argumentSummary as Record<string, unknown> | undefined)?.status === "available"
    })(),
  }
  const challenge = validateManagedRootGuardChallenge(registeredLocationID, value)
  if (challenge.locationID !== registeredLocationID || challenge.normalizedAction !== "git.worktree.list") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect challenge changed its admitted child Location" })
  }
  return challenge
}

function decodeManagedFinalInspectReceipt(
  operation: string,
  response: Record<string, unknown>,
  expected: { readonly attemptID: string; readonly locationID: string; readonly finalRevision: string },
): ManagedFinalInspectReceiptV1 {
  const keys = [
    "status", "operationID", "hostReceiptRef", "workspaceRevision", "worktreeStatus", "dirtyEntryCount",
    "dirtyEntriesDigest", "containsUserOwnedChanges", "owned", "noFollow",
  ].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.status !== "INSPECTED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect receipt has an invalid shape" })
  }
  const worktreeStatus = requiredText(operation, response, "worktreeStatus", 32)
  if (!["CLEAN", "DIRTY_OWNED", "DIRTY_UNATTRIBUTED", "MISSING", "UNKNOWN"].includes(worktreeStatus)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect worktree status is invalid" })
  }
  const hostReceiptRef = requiredText(operation, response, "hostReceiptRef", 256)
  if (!/^blake3:[0-9a-f]{64}$/.test(hostReceiptRef)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect host receipt reference is invalid" })
  }
  const workspaceRevision = digestValue(operation, requiredText(operation, response, "workspaceRevision", 256), "workspaceRevision")
  const dirtyEntryCount = requiredText(operation, response, "dirtyEntryCount", 32)
  const dirtyCount = canonicalDecimalU64(operation, dirtyEntryCount, "dirtyEntryCount")
  const dirtyEntriesDigest = response.dirtyEntriesDigest
  if (typeof dirtyEntriesDigest !== "string" || Buffer.byteLength(dirtyEntriesDigest, "utf8") > 256 ||
      (dirtyCount === 0n ? dirtyEntriesDigest !== "" : !/^blake3:[0-9a-f]{64}$/.test(dirtyEntriesDigest))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect dirty-entry digest does not match its count" })
  }
  const receipt = {
    operationID: identifier(operation, requiredText(operation, response, "operationID", 256), "operationID"),
    hostReceiptRef,
    workspaceRevision,
    worktreeStatus: worktreeStatus as ManagedFinalInspectReceiptV1["worktreeStatus"],
    dirtyEntryCount,
    dirtyEntriesDigest,
    containsUserOwnedChanges: requiredBoolean(operation, response, "containsUserOwnedChanges"),
    owned: requiredBoolean(operation, response, "owned"),
    noFollow: requiredBoolean(operation, response, "noFollow"),
  }
  if ((receipt.worktreeStatus === "CLEAN" && dirtyCount !== 0n) ||
      (receipt.worktreeStatus === "DIRTY_OWNED" && dirtyCount === 0n)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect status conflicts with its dirty-entry count" })
  }
  if (!/^attempt_[0-9a-f]{64}$/.test(expected.attemptID) || !/^loc_[0-9a-f]{64}$/.test(expected.locationID) || receipt.workspaceRevision !== expected.finalRevision) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "final Inspect receipt is not bound to the frozen child revision" })
  }
  return receipt
}

type ResolvedVerifierLease = {
  readonly criterionID: string
  readonly challengeID: string
  readonly effectID: string
  readonly capabilityLeaseDigest: string
}

type VerificationApprovalResolution =
  | {
      readonly status: "APPROVED"
      readonly goalID: string
      readonly runID: string
      readonly verificationRunID: string
      readonly challengeSetDigest: string
      readonly leases: ReadonlyArray<ResolvedVerifierLease>
      readonly revision: string
    }
  | {
      readonly status: "ABORTED"
      readonly goalID: string
      readonly runID: string
      readonly verificationRunID: string
      readonly challengeSetDigest: string
      readonly reason: VerificationAbortReason
      readonly revision: string
    }

function decodeVerificationApprovalResolution(
  operation: string,
  response: Record<string, unknown>,
  expected: Pick<VerificationStartedBase, "goalID" | "runID" | "verificationRunID" | "challengeSetDigest"> & {
    readonly challenges?: ReadonlyArray<VerifierApprovalChallenge>
  },
): VerificationApprovalResolution {
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const verificationRunID = identifier(
    operation,
    requiredText(operation, response, "verificationRunID", 256),
    "verificationRunID",
  )
  const challengeSetDigest = decodeBlake3Digest(
    operation,
    requiredText(operation, response, "challengeSetDigest", 256),
    "challengeSetDigest",
  )
  if (
    goalID !== expected.goalID ||
    runID !== expected.runID ||
    verificationRunID !== expected.verificationRunID ||
    challengeSetDigest !== expected.challengeSetDigest
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "approval resolution binding changed" })
  }
  const revision = requiredRevision(operation, response, "revision")
  if (response.status === "ABORTED") {
    const reason = requiredText(operation, response, "reason", 64)
    if (
      !["reviewer_denied", "cancelled", "expired", "transport_lost"].includes(reason) ||
      !Array.isArray(response.leases) ||
      response.leases.length !== 0
    ) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "abort resolution is invalid" })
    }
    return {
      status: "ABORTED",
      goalID,
      runID,
      verificationRunID,
      challengeSetDigest,
      reason: reason as VerificationAbortReason,
      revision,
    }
  }
  requireStatus(operation, response, "APPROVED")
  const expectedChallenges = expected.challenges ?? []
  if (!Array.isArray(response.leases) || response.leases.length !== expectedChallenges.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "approved lease set is incomplete" })
  }
  const expectedByChallenge = new Map(expectedChallenges.map((challenge) => [challenge.challengeID, challenge]))
  const seen = new Set<string>()
  const leases = response.leases.map((value): ResolvedVerifierLease => {
    const lease = requiredRecord(operation, value, "verification lease")
    const criterionID = identifier(operation, requiredText(operation, lease, "criterionID", 256), "criterionID")
    const challengeID = identifier(operation, requiredText(operation, lease, "challengeID", 256), "challengeID")
    const effectID = identifier(operation, requiredText(operation, lease, "effectID", 256), "effectID")
    const capabilityLeaseDigest = digestValue(
      operation,
      requiredText(operation, lease, "capabilityLeaseDigest", 256),
      "capabilityLeaseDigest",
    )
    const challenge = expectedByChallenge.get(challengeID)
    if (
      !challenge ||
      seen.has(challengeID) ||
      challenge.criterionID !== criterionID ||
      challenge.effectID !== effectID
    ) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "approved lease binding is invalid" })
    }
    seen.add(challengeID)
    return { criterionID, challengeID, effectID, capabilityLeaseDigest }
  })
  return { status: "APPROVED", goalID, runID, verificationRunID, challengeSetDigest, leases, revision }
}

function decodeVerificationRunResult(operation: string, response: Record<string, unknown>): VerificationRunResult {
  const status = requiredText(operation, response, "status", 32)
  const statuses: ReadonlySet<string> = new Set([
    "VERIFYING",
    "SETTLING",
    "FAILED",
    "UNKNOWN",
    "NEEDS_YOU",
    "CANCELLING",
    "CANCELLED",
  ])
  if (!statuses.has(status)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verification result status is invalid" })
  }
  const success = status === "SETTLING"
  const base = [
    "status", "goalID", "runID", "taskID", "attemptID",
    "schemaVersion", "ownerEpoch", "specID", "specDigest", "profileID", "profileRevision",
    "profileDigest", "evidencePlanDigest", "setIdentityDigest",
    "verificationRunID", "challengeSetDigest", "finalRevision", "revision",
  ]
  const unknown = status === "UNKNOWN"
  const expectedKeys = [...base, "sourceRevision", ...(unknown ? ["reason"] : []), ...(success ? ["approvalLocation", "evidenceDigest", "artifactRefs", "settlementCandidate"] : [])].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verification result has an invalid shape" })
  }
  const result = {
    status: status as VerificationExecutionStatus,
    setIdentityDigest: decodeBlake3Digest(operation, requiredText(operation, response, "setIdentityDigest", 256), "setIdentityDigest"),
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
    attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
    verificationRunID: identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID"),
    challengeSetDigest: decodeBlake3Digest(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest"),
    finalRevision: digestValue(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision"),
    sourceRevision: digestValue(operation, requiredText(operation, response, "sourceRevision", 256), "sourceRevision"),
    revision: requiredRevision(operation, response, "revision"),
  }
  if (!result.finalRevision.startsWith("blake3:") || !result.sourceRevision.startsWith("blake3:") || result.sourceRevision !== result.finalRevision) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier result is not bound to the exact pinned workspace revision" })
  }
  if (unknown) {
    const reason = requiredText(operation, response, "reason", 128)
    if (!MANAGED_VERIFIER_UNKNOWN_REASONS.has(reason as ManagedVerifierUnknownReasonV1)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier UNKNOWN reason is not a recognized bounded HostKernel state" })
    }
    return { ...result, reason: reason as ManagedVerifierUnknownReasonV1 }
  }
  if (!success) return result
  const evidenceDigest = digestValue(operation, requiredText(operation, response, "evidenceDigest", 256), "evidenceDigest")
  if (!evidenceDigest.startsWith("blake3:")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "successful verifier evidence is not bound to its exact final workspace revision" })
  }
  const settlementCandidate = decodeManagedSettlementCandidate(operation, response.settlementCandidate)
  if (settlementCandidate.goalID !== result.goalID || settlementCandidate.runID !== result.runID ||
      settlementCandidate.taskID !== result.taskID || settlementCandidate.attemptID !== result.attemptID ||
      settlementCandidate.evidenceDigest !== evidenceDigest || settlementCandidate.finalRevision !== result.finalRevision) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement candidate changed the verifier evidence or managed child identity" })
  }
  return { ...result, evidenceDigest, artifactRefs: decodeVerifierArtifactRefs(operation, response.artifactRefs), settlementCandidate }
}

function decodeVerifierArtifactRefs(operation: string, value: unknown): readonly VerifierCriterionArtifactsV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERIFIER_CRITERIA) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact evidence is not a bounded nonempty criterion list" })
  }
  const criteria = new Set<string>()
  let total = 0
  let totalBytes = 0n
  return value.map((item) => {
    const group = requiredRecord(operation, item, "criterion artifact refs")
    if (Object.keys(group).toSorted().join("\0") !== ["criterionID", "artifactRefs"].toSorted().join("\0") || !Array.isArray(group.artifactRefs) || group.artifactRefs.length < 1 || group.artifactRefs.length > 64) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "criterion artifact evidence has an invalid shape" })
    }
    const criterionID = identifier(operation, requiredText(operation, group, "criterionID", 256), "criterionID")
    if (criteria.has(criterionID)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact criteria are duplicated" })
    criteria.add(criterionID)
    const artifactRefs = group.artifactRefs.map((raw): VerifierArtifactRefV1 => {
      total++
      if (total > MAX_VERIFIER_ARTIFACTS) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact count exceeds its bound" })
      const artifact = requiredRecord(operation, raw, "verifier artifact ref")
      if (Object.keys(artifact).toSorted().join("\0") !== ["artifactID", "digest", "byteLength", "mediaType", "classification"].toSorted().join("\0")) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact ref has an invalid shape" })
      }
      const classification = requiredText(operation, artifact, "classification", 32)
      if (!["PUBLIC", "WORKSPACE", "SENSITIVE"].includes(classification)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact classification is invalid" })
      const digest = digestValue(operation, requiredText(operation, artifact, "digest", 256), "artifact digest")
      if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact digest must use BLAKE3" })
      const byteLength = requiredText(operation, artifact, "byteLength", 32)
      canonicalDecimalU64(operation, byteLength, "artifact byteLength")
      const artifactBytes = BigInt(byteLength)
      totalBytes += artifactBytes
      if (artifactBytes > BigInt(MAX_VERIFIER_ARTIFACT_BYTES) || totalBytes > BigInt(MAX_VERIFIER_AGGREGATE_ARTIFACT_BYTES)) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier artifact bytes exceed their per-item or aggregate bound" })
      }
      return {
        artifactID: identifier(operation, requiredText(operation, artifact, "artifactID", 256), "artifactID"),
        digest,
        byteLength,
        mediaType: requiredText(operation, artifact, "mediaType", 128),
        classification: classification as VerifierArtifactRefV1["classification"],
      }
    })
    return { criterionID, artifactRefs }
  })
}

function decodeTaskVerified(operation: string, response: Record<string, unknown>): TaskVerified {
  requireStatus(operation, response, "VERIFIED")
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    taskID: identifier(operation, requiredText(operation, response, "taskID", 256), "taskID"),
    attemptID: identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID"),
    verifierID: requiredText(operation, response, "verifierID", 256),
    sourceRevision: requiredText(operation, response, "sourceRevision", 256),
    evidenceDigest: digestValue(operation, requiredText(operation, response, "evidenceDigest", 256), "evidenceDigest"),
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeCriterionEvidence(operation: string, response: Record<string, unknown>): CriterionEvidenceRecorded {
  requireStatus(operation, response, "EVIDENCE_RECORDED")
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    criterionID: identifier(operation, requiredText(operation, response, "criterionID", 256), "criterionID"),
    sourceRevision: requiredText(operation, response, "sourceRevision", 256),
    evidenceDigest: digestValue(operation, requiredText(operation, response, "evidenceDigest", 256), "evidenceDigest"),
    revision: requiredRevision(operation, response, "revision"),
  }
}

function decodeRunFinalized(operation: string, response: Record<string, unknown>): RunFinalized {
  requireStatus(operation, response, "SUCCEEDED")
  const runPhase = managedRunPhase(operation, response.runPhase)
  if (runPhase !== "SUCCEEDED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "finalize_run status is SUCCEEDED but Run phase is not SUCCEEDED" })
  }
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    runPhase,
    revision: requiredRevision(operation, response, "revision"),
  }
}

export function decodeHostRunDispatchBinding(operation: string, value: unknown): HostRunDispatchBindingV1 {
  const source = value as Record<string, unknown>
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch binding payload is not an object" })
  }
  if (source.schemaVersion !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch binding schemaVersion must be 1" })
  }
  return {
    schemaVersion: 1,
    dispatchKeyDigest: digestValue(operation, source.dispatchKeyDigest as string, "dispatchKeyDigest"),
    manifestDigest: digestValue(operation, source.manifestDigest as string, "manifestDigest"),
    evaluatorTaskId: identifier(operation, source.evaluatorTaskId as string, "evaluatorTaskId"),
    armId: identifier(operation, source.armId as string, "armId"),
    taskGroup: identifier(operation, source.taskGroup as string, "taskGroup"),
    runId: identifier(operation, source.runId as string, "runId"),
    managedTaskId: identifier(operation, source.managedTaskId as string, "managedTaskId"),
    attemptId: identifier(operation, source.attemptId as string, "attemptId"),
    evaluationSessionId: identifier(operation, source.evaluationSessionId as string, "evaluationSessionId"),
    coreProcessGeneration: requiredDecimalU64(operation, source, "coreProcessGeneration"),
    ownerId: identifier(operation, source.ownerId as string, "ownerId"),
    ownerEpoch: requiredDecimalU64(operation, source, "ownerEpoch"),
    workerExecutionId: identifier(operation, source.workerExecutionId as string, "workerExecutionId"),
    delegationBindingDigest: digestValue(operation, source.delegationBindingDigest as string, "delegationBindingDigest"),
    acceptedSpecDigest: digestValue(operation, source.acceptedSpecDigest as string, "acceptedSpecDigest"),
    providerSelectionDigest: digestValue(operation, source.providerSelectionDigest as string, "providerSelectionDigest"),
    workspaceBindingDigest: digestValue(operation, source.workspaceBindingDigest as string, "workspaceBindingDigest"),
    admittedWorkspaceRevision: requiredText(operation, source, "admittedWorkspaceRevision", 256),
    attemptScopeDigest: digestValue(operation, source.attemptScopeDigest as string, "attemptScopeDigest"),
    ownerPrincipalBindingDigest: digestValue(operation, source.ownerPrincipalBindingDigest as string, "ownerPrincipalBindingDigest"),
    bindingDigest: digestValue(operation, source.bindingDigest as string, "bindingDigest"),
  }
}

export function decodeHostRunDispatchBindingReceipt(operation: string, value: unknown): HostRunDispatchBindingReceiptV1 {
  const source = value as Record<string, unknown>
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch binding receipt payload is not an object" })
  }
  if (source.schemaVersion !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch binding receipt schemaVersion must be 1" })
  }
  return {
    schemaVersion: 1,
    dispatchKeyDigest: digestValue(operation, source.dispatchKeyDigest as string, "dispatchKeyDigest"),
    bindingDigest: digestValue(operation, source.bindingDigest as string, "bindingDigest"),
    ownerLogSequence: requiredPositiveDecimalU64(operation, source, "ownerLogSequence"),
    ownerLogEventDigest: ownerEventDigest(operation, source.ownerLogEventDigest),
    bindingManagedRevision: requiredDecimalU64(operation, source, "bindingManagedRevision"),
  }
}

export function decodeHostRunDispatchP8OwnerReceipt(operation: string, value: unknown): HostRunDispatchP8OwnerReceiptV1 {
  const source = value as Record<string, unknown>
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch P8 owner receipt payload is not an object" })
  }
  if (source.schemaVersion !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun dispatch P8 owner receipt schemaVersion must be 1" })
  }
  return {
    schemaVersion: 1,
    dispatchKeyDigest: digestValue(operation, source.dispatchKeyDigest as string, "dispatchKeyDigest"),
    bindingDigest: digestValue(operation, source.bindingDigest as string, "bindingDigest"),
    ownerLogID: identifier(operation, source.ownerLogID as string, "ownerLogID"),
    ownerLogSequence: requiredPositiveDecimalU64(operation, source, "ownerLogSequence"),
    ownerLogEventDigest: ownerEventDigest(operation, source.ownerLogEventDigest),
  }
}

export function decodeHostRunReconciliation(operation: string, value: unknown): HostRunReconciliationV1 {
  const source = value as Record<string, unknown>
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun reconciliation payload is not an object" })
  }
  if (source.schemaVersion !== 1) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "HostRun reconciliation schemaVersion must be 1" })
  }
  const status = requiredText(operation, source, "status", 32)
  if (status !== "SUCCEEDED" && status !== "FAILED" && status !== "CANCELLED" && status !== "UNKNOWN") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: `HostRun reconciliation status '${status}' is invalid` })
  }
  if (status === "UNKNOWN" && source.unknownReason === undefined) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "unknownReason is required for UNKNOWN HostRun reconciliation" })
  }
  if (status !== "UNKNOWN" && source.unknownReason !== undefined) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "unknownReason is only valid for UNKNOWN HostRun reconciliation" })
  }
  const dispatchKeyDigest = digestValue(operation, source.dispatchKeyDigest as string, "dispatchKeyDigest")
  const unknownReason = source.unknownReason !== undefined ? requiredText(operation, source, "unknownReason", 256) : undefined
  if (unknownReason !== undefined && !(HOST_RUN_UNKNOWN_REASONS as readonly string[]).includes(unknownReason)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "unknownReason is not a canonical HostRun reconciliation reason" })
  }
  const binding = source.binding !== undefined ? decodeHostRunDispatchBinding(operation, source.binding) : undefined
  const bindingDigest = source.bindingDigest !== undefined ? digestValue(operation, source.bindingDigest as string, "bindingDigest") : undefined
  const attemptReceiptDigest = source.attemptReceiptDigest !== undefined ? digestValue(operation, source.attemptReceiptDigest as string, "attemptReceiptDigest") : undefined
  const verifiedRevision = source.verifiedRevision !== undefined
    ? digestValue(operation, source.verifiedRevision as string, "verifiedRevision")
    : undefined

  return {
    schemaVersion: 1,
    dispatchKeyDigest,
    status,
    unknownReason,
    binding,
    bindingDigest,
    attemptReceiptDigest,
    verifiedRevision,
  }
}

const HOST_RUN_UNKNOWN_REASONS = [
  "host_run_binding_absent",
  "host_run_binding_identity_mismatch",
  "host_run_effect_projection_unavailable",
  "host_run_effect_projection_incomplete",
  "host_run_effect_projection_identity_mismatch",
  "host_run_effect_projection_ambiguous",
  "host_run_managed_terminal_unsettled",
  "host_run_task_unverified",
  "host_run_attempt_unknown",
  "host_run_attempt_receipt_missing",
  "host_run_binding_receipt_missing",
  "host_run_verifier_evidence_missing",
  "host_run_verifier_pins_unavailable",
  "host_run_p8_owner_receipt_missing",
  "host_run_p8_settlement_missing",
] as const

/**
 * Sends one authenticated `managed.v1` request. A host refusal rejects with the
 * kernel's own typed code; an unavailable channel becomes `managed_unavailable`
 * so an unsupported path never silently degrades into an unguarded dispatch.
 */
const call = (
  operation: string,
  body: Readonly<Record<string, unknown>>,
  deliveryID?: string,
  trustedPrincipal?: TrustedPrincipal,
): Effect.Effect<Record<string, unknown>, ManagedControlError, SessionSupervisorService> =>
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const options =
      deliveryID === undefined && trustedPrincipal === undefined
        ? undefined
        : {
            ...(deliveryID === undefined ? {} : { deliveryID }),
            ...(trustedPrincipal === undefined ? {} : { trustedPrincipal }),
          }
    const response = yield* supervisor
      .requestHostKernel(MANAGED_SERVICE, operation, body, options)
      .pipe(
        Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
          Effect.fail(
            new ManagedControlError({
              operation,
              code: error.hostCode ?? "managed_unavailable",
              reason: error.reason,
            }),
          ),
        ),
      )
    return response as Record<string, unknown>
  })

/** Recover exact nested Guard outcomes from HostKernel's OwnerLog + EffectHost journals. */
export const managedEffectWaveReceipts = Effect.fn("ManagedControl.managedEffectWaveReceipts")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly batchID: string
  readonly waveIndex: number
}) {
  const operation = "effect_wave_receipts"
  if (input.trustedPrincipal.kind !== "server_auth") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "authorization_denied", reason: "managed effect receipt lookup requires authenticated ServerAuth" }))
  }
  if (!Number.isSafeInteger(input.waveIndex) || input.waveIndex < 0 || input.waveIndex > 63) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "managed effect wave index is invalid" }))
  }
  const pins = {
    goalID: identifier(operation, input.goalID, "goalID"),
    runID: identifier(operation, input.runID, "runID"),
    taskID: identifier(operation, input.taskID, "taskID"),
    attemptID: identifier(operation, input.attemptID, "attemptID"),
    batchID: identifier(operation, input.batchID, "batchID"),
    waveIndex: input.waveIndex,
  }
  const response = yield* call(operation, pins, undefined, input.trustedPrincipal)
  return yield* decode(operation, response, (name, value): ManagedEffectWaveReceiptsV1 => {
    const expected = ["status", "goalID", "runID", "taskID", "attemptID", "batchID", "waveIndex", "sourceScopeDigest", "waveDigest", "effects"].toSorted()
    if (Object.keys(value).toSorted().join("\0") !== expected.join("\0") || value.status !== "RECOVERED" ||
      value.goalID !== pins.goalID || value.runID !== pins.runID || value.taskID !== pins.taskID ||
      value.attemptID !== pins.attemptID || value.batchID !== pins.batchID || value.waveIndex !== pins.waveIndex ||
      !Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 32) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel effect wave receipt projection has an invalid shape or authority binding" })
    }
    const sourceScopeDigest = digestValue(name, requiredText(name, value, "sourceScopeDigest", 256), "sourceScopeDigest")
    const waveDigest = digestValue(name, requiredText(name, value, "waveDigest", 256), "waveDigest")
    if (!sourceScopeDigest.startsWith("blake3:") || !waveDigest.startsWith("blake3:")) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "effect wave digests must use BLAKE3" })
    }
    const effects = value.effects.map((raw, index) => {
      const effect = requiredRecord(name, raw, `effect[${index}]`)
      const keys = ["callIndex", "callID", "effectID", "receiptRef", "capabilityID", "attemptScopeDigest", "status", "receiptKind", "receiptDigest"].toSorted()
      if (Object.keys(effect).toSorted().join("\0") !== keys.join("\0") || effect.callIndex !== index) {
        throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "managed wave receipt edge is missing, reordered, or oversized" })
      }
      const callID = identifier(name, requiredText(name, effect, "callID", 256), "callID")
      const effectID = identifier(name, requiredText(name, effect, "effectID", 256), "effectID")
      const receiptRef = effect.receiptRef === null ? null : identifier(name, requiredText(name, effect, "receiptRef", 256), "receiptRef")
      const capabilityID = identifier(name, requiredText(name, effect, "capabilityID", 256), "capabilityID")
      const attemptScopeDigest = digestValue(name, requiredText(name, effect, "attemptScopeDigest", 256), "attemptScopeDigest")
      const status = requiredText(name, effect, "status", 64)
      const receiptKind = effect.receiptKind === null ? null : requiredText(name, effect, "receiptKind", 32)
      const receiptDigest = effect.receiptDigest === null ? null : digestValue(name, requiredText(name, effect, "receiptDigest", 256), "receiptDigest")
      const terminalStatuses = ["SETTLED", "NOT_APPLIED", "DENIED", "EXPIRED", "CANCELLED"]
      if (!attemptScopeDigest.startsWith("blake3:") || (receiptDigest !== null && !receiptDigest.startsWith("blake3:")) ||
        ![...terminalStatuses, "UNKNOWN"].includes(status) ||
        (status === "UNKNOWN" && (receiptDigest !== null || receiptRef !== null || receiptKind !== null)) ||
        (status === "SETTLED" && (receiptDigest === null || receiptRef === null || receiptKind !== "effect")) ||
        (status !== "UNKNOWN" && (!receiptDigest || !receiptRef || !["effect", "decision"].includes(String(receiptKind)))) ||
        (status !== "UNKNOWN" && status !== "SETTLED" && receiptKind !== "decision")) {
        throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "managed wave receipt edge lacks its exact terminal receipt digest" })
      }
      return { callIndex: index, callID, effectID, receiptRef, capabilityID, attemptScopeDigest, status, receiptKind: receiptKind as "effect" | "decision" | null, receiptDigest }
    })
    if (new Set(effects.map((effect) => effect.callID)).size !== effects.length ||
      new Set(effects.map((effect) => effect.effectID)).size !== effects.length) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "managed wave receipt identities are duplicated" })
    }
    return { status: "RECOVERED", ...pins, sourceScopeDigest, waveDigest, effects }
  })
})

const decode = <A>(
  operation: string,
  response: Record<string, unknown>,
  decoder: (operation: string, response: Record<string, unknown>) => A,
): Effect.Effect<A, ManagedControlError> =>
  Effect.try({
    try: () => decoder(operation, response),
    catch: (error) =>
      error instanceof ManagedControlError
        ? error
        : new ManagedControlError({ operation, code: "managed_protocol", reason: "host response is malformed" }),
  })

export const available = Effect.fn("ManagedControl.available")(function* () {
  const supervisor = yield* SessionSupervisor.Service
  return yield* supervisor.hostOwnerEpoch().pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
})

export const createGoalProposal = Effect.fn("ManagedControl.createGoalProposal")(function* (
  input: GoalProposalInput & { readonly trustedPrincipal?: TrustedPrincipal },
) {
  const operation = "create_goal_proposal"
  const criteria = yield* Effect.try({
    try: () => {
      if (!Array.isArray(input.criteria) || input.criteria.length === 0 || input.criteria.length > MAX_SPEC_CRITERIA) {
        throw new ManagedControlError({ operation, code: "managed_protocol", reason: "criteria is not a non-empty bounded list" })
      }
      return input.criteria.map((raw, index) => {
        const criterion = requiredRecord(operation, raw, `criteria[${index}]`)
        const id = identifier(operation, requiredText(operation, criterion, "id", 256), "criterion id")
        const description = requiredText(operation, criterion, "description", MAX_PLAN_ITEM_BYTES)
        if (description.trim().length === 0) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: `criteria[${index}].description is invalid` })
        }
        return { id, description }
      })
    },
    catch: (error) =>
      error instanceof ManagedControlError
        ? error
        : new ManagedControlError({ operation, code: "managed_protocol", reason: "criteria is malformed" }),
  })
  const body = {
    goalID: identifier(operation, input.goalID, "goalID"),
    specID: identifier(operation, input.specID, "specID"),
    objective: input.objective,
    projectRef: identifier(operation, input.projectRef, "projectRef"),
    workspaceRef: identifier(operation, input.workspaceRef, "workspaceRef"),
    capabilityScope: stringList(operation, input.capabilityScope, "capabilityScope"),
    scope: stringList(operation, input.scope, "scope"),
    constraints: stringList(operation, input.constraints, "constraints"),
    criteria,
    budget: {
      maxTasks: input.budget.maxTasks,
      maxAttemptsPerTask: input.budget.maxAttemptsPerTask,
      maxRunDurationMs: input.budget.maxRunDurationMs,
      maxMemoryBytes: input.budget.maxMemoryBytes,
      maxDiskBytes: input.budget.maxDiskBytes,
      maxWorkers: input.budget.maxWorkers,
      maxTokens: input.budget.maxTokens,
      maxCostMicros: input.budget.maxCostMicros,
    },
    sourceDigests: stringList(operation, input.sourceDigests, "sourceDigests"),
  }
  if (
    typeof input.objective !== "string" ||
    input.objective.trim().length === 0 ||
    Buffer.byteLength(input.objective, "utf8") > MAX_TEXT_BYTES
  ) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "objective is invalid" }),
    )
  }
  const response = yield* call(operation, body, String(body.goalID), input.trustedPrincipal)
  return yield* decode(operation, response, decodeGoalProposalCreated)
})

export const goalReviewSnapshot = Effect.fn("ManagedControl.goalReviewSnapshot")(function* (
  goalID: string,
  trustedPrincipal: TrustedPrincipal,
) {
  const operation = "snapshot"
  const id = identifier(operation, goalID, "goalID")
  const response = yield* call(operation, { goalID: id })
  const snapshot = yield* decode(operation, response, (name, value) => decodeGoalReviewSnapshot(name, value, id))
  const profiles = yield* AgentProfileService
  const configuredProfiles = yield* Effect.mapError(
    profiles.agentProfiles(),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const eligible = projectEligibleProfiles(configuredProfiles)
  return {
    ...snapshot,
    eligibleProfiles: eligible.profiles,
    eligibleProfilesTruncated: eligible.truncated,
    proposals: snapshot.proposals.map((proposal) => reviewAvailability(proposal, trustedPrincipal)),
  }
})

export const listPendingReviews = Effect.fn("ManagedControl.listPendingReviews")(function* (
  trustedPrincipal: TrustedPrincipal,
) {
  const operation = "list_pending_reviews"
  const response = yield* call(operation, {})
  const values = response.goals
  if (!Array.isArray(values) || values.length > MAX_LIST_ITEMS) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "goals is not a bounded list" }),
    )
  }
  const goals: GoalReviewSnapshot[] = []
  for (const value of values) {
    const item = yield* decode(operation, { value }, (name, wrapper) => {
      const raw = requiredRecord(name, wrapper.value, "Goal snapshot")
      return decodeGoalReviewSnapshot(name, raw)
    })
    goals.push({ ...item, proposals: item.proposals.map((proposal) => reviewAvailability(proposal, trustedPrincipal)) })
  }
  return { goals }
})

const decision = (
  operation: "accept_spec" | "reject_spec",
  applied: "ACCEPTED" | "REJECTED",
  principal: TrustedPrincipal,
  input: {
    readonly goalID: string
    readonly specID: string
    readonly specDigest: string
    readonly expectedRevision: ManagedRevision
  },
) =>
  Effect.gen(function* () {
    const trustedPrincipal = yield* serverAuthPrincipal(operation, principal)
    const goalID = identifier(operation, input.goalID, "goalID")
    const specID = identifier(operation, input.specID, "specID")
    const specDigest = digestValue(operation, input.specDigest, "specDigest")
    const observedRevision = expectedRevision(operation, input.expectedRevision)
    const assignment = yield* claimSpecReviewer({
      trustedPrincipal: principal,
      goalID,
      specID,
      specDigest,
      expectedRevision: observedRevision,
    })
    const reviewedRevision = BigInt(assignment.decisionRevision)
    const response = yield* call(
      operation,
      { goalID, specID, specDigest, expectedRevision: reviewedRevision },
      specID,
      trustedPrincipal,
    )
    const result = yield* decode(operation, response, (name, value) => decodeSpecDecision(name, applied, value))
    if (
      result.goalID !== goalID ||
      result.specID !== specID ||
      result.specDigest !== specDigest ||
      result.reviewedRevision !== reviewedRevision.toString()
    ) {
      return yield* Effect.fail(
        new ManagedControlError({
          operation,
          code: "managed_protocol",
          reason: "host decision does not match the requested Goal, SpecVersion, digest and reviewed revision",
        }),
      )
    }
    return result
  })

const claimSpecReviewer = Effect.fn("ManagedControl.claimSpecReviewer")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly expectedRevision: ManagedRevision
}) {
  const operation = "assign_spec_reviewer"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const specID = identifier(operation, input.specID, "specID")
  const specDigest = digestValue(operation, input.specDigest, "specDigest")
  const revision = expectedRevision(operation, input.expectedRevision)
  const response = yield* call(
    operation,
    { goalID, specID, specDigest, expectedRevision: revision },
    specID,
    trustedPrincipal,
  )
  const reviewerID = requiredText(operation, response, "reviewerID", 256)
  const assignedAtRevision = requiredRevision(operation, response, "assignedAtRevision")
  const decisionRevision = requiredRevision(operation, response, "decisionRevision")
  if (input.trustedPrincipal.kind !== "server_auth") {
    return yield* Effect.fail(
      new ManagedControlError({
        operation,
        code: "independent_verifier_required",
        reason: "reviewer assignment requires an authenticated ServerAuth principal",
      }),
    )
  }
  if (
    response.status !== "ASSIGNED" ||
    reviewerID !== `server_auth:${input.trustedPrincipal.subject}` ||
    BigInt(decisionRevision) !== BigInt(assignedAtRevision) + 1n
  ) {
    return yield* Effect.fail(
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "host reviewer assignment does not match the authenticated reviewer or revision",
      }),
    )
  }
  return { reviewerID, decisionRevision }
})

export const assignSpecReviewer = claimSpecReviewer

export const acceptSpec = Effect.fn("ManagedControl.acceptSpec")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* decision("accept_spec", "ACCEPTED", input.trustedPrincipal, input)
})

export const rejectSpec = Effect.fn("ManagedControl.rejectSpec")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly specID: string
  readonly specDigest: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* decision("reject_spec", "REJECTED", input.trustedPrincipal, input)
})

function serverAuthPrincipal(
  operation: string,
  principal: TrustedPrincipal,
): Effect.Effect<TrustedPrincipal, ManagedControlError> {
  if (principal.kind !== "server_auth" || !IDENTIFIER.test(principal.subject)) {
    return Effect.fail(
      new ManagedControlError({
        operation,
        code: "independent_verifier_required",
        reason: "Goal review requires an authenticated ServerAuth principal",
      }),
    )
  }
  return Effect.succeed(principal)
}

/**
 * Builds durable, visible plan state from the exact accepted SpecVersion. This
 * path intentionally stops before explicit `startPlannedRun`: a plan does not establish a
 * P1 Guard binding, P8 live lease, Attempt, or authority to dispatch.
 */
export const createRunPlan = Effect.fn("ManagedControl.createRunPlan")(function* (input: GoalRunPlanInput) {
  const operation = "plan_run"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const specID = identifier(operation, input.specID, "specID")
  const specDigest = digestValue(operation, input.specDigest, "specDigest")
  const runID = identifier(operation, input.runID, "runID")
  const expectedGoalRevision = input.expectedGoalRevision
  if (
    typeof expectedGoalRevision !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(expectedGoalRevision) ||
    BigInt(expectedGoalRevision) > 18_446_744_073_709_551_615n
  ) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedGoalRevision is not a canonical u64" })
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > MAX_LIST_ITEMS) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "Task plan is empty or exceeds the bounded V1 task limit" })
  }
  const projectRef = identifier(operation, input.projectRef, "projectRef")
  const workspaceRef = identifier(operation, input.workspaceRef, "workspaceRef")
  const snapshotResponse = yield* call(operation, { goalID }, undefined, trustedPrincipal)
  const snapshot = yield* decode(operation, snapshotResponse, (name, value) => {
    const revision = requiredRevision(name, value, "revision")
    const goal = requiredRecord(name, value.goal, "goal")
    const specs = value.specs
    if (!Array.isArray(specs) || specs.length > MAX_LIST_ITEMS) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "spec list is outside bounds" })
    }
    const selected = specs.map((item) => requiredRecord(name, item, "spec")).find((item) => item.specID === specID)
    if (!selected) throw new ManagedControlError({ operation: name, code: "managed_not_found", reason: "selected SpecVersion is unknown" })
    const budget = requiredRecord(name, selected.budget, "accepted SpecVersion budget")
    const criteria = selected.criteria
    const capabilityScope = snapshotTextList(name, selected.capabilityScope, "capabilityScope")
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > MAX_LIST_ITEMS) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "accepted criteria are malformed" })
    }
    const acceptedCriteria = criteria.map((item) => {
      const criterion = requiredRecord(name, item, "criterion")
      return identifier(name, requiredText(name, criterion, "id", 256), "criterionID")
    })
    const criterionIDs = new Set(acceptedCriteria)
    if (criterionIDs.size !== acceptedCriteria.length) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "accepted SpecVersion contains duplicate criterion IDs" })
    }
    const isAccepted = requiredBoolean(name, selected, "accepted")
    const acceptedBy = optionalText(name, selected, "acceptedBy")
    const acceptedAtMs = selected.acceptedAtMs === null ? null : requiredInteger(name, selected, "acceptedAtMs")
    const activeSpecID = optionalText(name, goal, "activeSpecVersionID")
    const selectedProjectRef = identifier(name, requiredText(name, selected, "projectRef", 256), "spec.projectRef")
    const selectedWorkspaceRef = identifier(name, requiredText(name, selected, "workspaceRef", 256), "spec.workspaceRef")
    const runsValue = value.runs
    if (!Array.isArray(runsValue) || runsValue.length > MAX_LIST_ITEMS) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "Run list is outside bounds" })
    }
    const existingRun = runsValue.map((item) => requiredRecord(name, item, "run")).find((item) => item.runID === runID)
    const existingTasks = existingRun
      ? (() => {
          const list = existingRun.tasks
          if (!Array.isArray(list) || list.length > MAX_LIST_ITEMS) {
            throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "existing Task list is outside bounds" })
          }
          return list.map((item) => {
            const task = requiredRecord(name, item, "existing Task")
            const profile = task.agentProfileRevision
            const profileRef = profile === null || profile === undefined ? null : requiredRecord(name, profile, "AgentProfile revision")
            return {
              taskID: identifier(name, requiredText(name, task, "taskID", 256), "taskID"),
              title: typeof task.title === "string" ? task.title : "",
              purpose: typeof task.purpose === "string" ? task.purpose : "",
              dependencies: snapshotTextList(name, task.dependencies, "dependencies"),
              criterionIDs: snapshotTextList(name, task.criterionIDs, "criterionIDs"),
              requiredCapabilities: snapshotTextList(name, task.requiredCapabilities, "requiredCapabilities"),
              profileId: profileRef ? identifier(name, requiredText(name, profileRef, "profileId", 256), "profileId") : null,
              profileRevision: profileRef ? requiredRevision(name, profileRef, "revision") : null,
              ready: requiredBoolean(name, task, "ready"),
            }
          })
        })()
      : []
    if (
      (existingRun === undefined && revision !== expectedGoalRevision) ||
      requiredText(name, selected, "specDigest", 256) !== specDigest ||
      !isAccepted || acceptedBy === null || acceptedAtMs === null ||
      activeSpecID !== specID ||
      identifier(name, requiredText(name, goal, "projectRef", 256), "projectRef") !== projectRef ||
      identifier(name, requiredText(name, goal, "workspaceRef", 256), "workspaceRef") !== workspaceRef ||
      selectedProjectRef !== projectRef || selectedWorkspaceRef !== workspaceRef ||
      (existingRun !== undefined && requiredText(name, existingRun, "specID", 256) !== specID)
    ) {
      throw new ManagedControlError({ operation: name, code: "managed_conflict", reason: "accepted SpecVersion revision, digest, or workspace changed" })
    }
    return {
      criterionIDs,
      capabilityScope: new Set(capabilityScope),
      maxTasks: requiredInteger(name, budget, "maxTasks"),
      revision,
      existingTasks,
    }
  })
  if (input.tasks.length > snapshot.maxTasks) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "Task plan exceeds the accepted SpecVersion budget" })
  }

  const tasks = yield* Effect.try({
    try: () => {
      const seenTasks = new Set<string>()
      const coveredCriteria = new Set<string>()
      const planned = input.tasks.map((task) => {
        const taskID = identifier(operation, task.taskID, "taskID")
        const title = task.title.trim()
        const purpose = task.purpose.trim()
        if (!title || Buffer.byteLength(task.title, "utf8") > 256 || /[\u0000-\u001f\u007f]/.test(task.title) ||
          !purpose || Buffer.byteLength(task.purpose, "utf8") > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(task.purpose)) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: `Task ${taskID} title or purpose is invalid or over its UTF-8 byte limit` })
        }
        if (seenTasks.has(taskID)) {
          throw new ManagedControlError({ operation, code: "managed_protocol", reason: "Task IDs must be unique" })
        }
        const dependencies = sortedUniqueIdentifiers(operation, task.dependencies, "dependencies")
        if (dependencies.includes(taskID)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: `Task ${taskID} cannot depend on itself` })
        const criterionIDs = sortedUniqueIdentifiers(operation, task.criterionIDs, "criterionIDs")
        if (criterionIDs.length === 0 || criterionIDs.some((criterion) => !snapshot.criterionIDs.has(criterion))) {
          throw new ManagedControlError({ operation, code: "managed_conflict", reason: `Task ${taskID} must cover one or more accepted SpecVersion criteria` })
        }
        for (const criterion of criterionIDs) {
          if (coveredCriteria.has(criterion)) throw new ManagedControlError({ operation, code: "managed_conflict", reason: `accepted criterion ${criterion} is assigned to more than one Task` })
          coveredCriteria.add(criterion)
        }
        const requiredCapabilities = sortedUniqueIdentifiers(operation, task.requiredCapabilities, "requiredCapabilities")
        if (requiredCapabilities.some((capability) => !snapshot.capabilityScope.has(capability))) {
          throw new ManagedControlError({ operation, code: "managed_conflict", reason: "Task capabilities must be a sorted, unique subset of the accepted SpecVersion" })
        }
        const profileRevision = canonicalDecimalU64(operation, task.profileSelection.revision, "profileSelection.revision")
        if (profileRevision < 1n) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "profile revision must be positive" })
        const profileSelection = {
          profileId: identifier(operation, task.profileSelection.profileId, "profileSelection.profileId"),
          revision: profileRevision.toString(),
        }
        seenTasks.add(taskID)
        return { taskID, title: task.title, purpose: task.purpose, dependencies, criterionIDs, requiredCapabilities, profileSelection }
      })
      if (coveredCriteria.size !== snapshot.criterionIDs.size || [...snapshot.criterionIDs].some((criterion) => !coveredCriteria.has(criterion))) {
        throw new ManagedControlError({ operation, code: "managed_conflict", reason: "planned Task set must cover every accepted criterion exactly once" })
      }
      for (const task of planned) {
        if (task.dependencies.some((dependency) => !seenTasks.has(dependency))) {
          throw new ManagedControlError({ operation, code: "managed_conflict", reason: `Task ${task.taskID} has a dependency outside the plan` })
        }
      }
      const resolved = new Set<string>()
      while (resolved.size < planned.length) {
        const previousSize = resolved.size
        for (const task of planned) {
          if (!resolved.has(task.taskID) && task.dependencies.every((dependency) => resolved.has(dependency))) resolved.add(task.taskID)
        }
        if (resolved.size === previousSize) {
          throw new ManagedControlError({ operation, code: "managed_conflict", reason: "Task plan dependency graph contains a cycle" })
        }
      }
      return planned
    },
    catch: (error) => error instanceof ManagedControlError
      ? error
      : new ManagedControlError({ operation, code: "managed_protocol", reason: "Task plan is malformed" }),
  })

  const requestedByID = new Map(tasks.map((task) => [task.taskID, task]))
  for (const existing of snapshot.existingTasks) {
    const requested = requestedByID.get(existing.taskID)
    if (!requested || existing.ready ||
      existing.title !== requested.title || existing.purpose !== requested.purpose ||
      JSON.stringify(existing.dependencies) !== JSON.stringify(requested.dependencies) ||
      JSON.stringify(existing.criterionIDs) !== JSON.stringify(requested.criterionIDs) ||
      JSON.stringify(existing.requiredCapabilities) !== JSON.stringify(requested.requiredCapabilities) ||
      existing.profileId !== requested.profileSelection.profileId ||
      existing.profileRevision !== requested.profileSelection.revision) {
      return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "existing Run Tasks differ from this retry or are no longer plan-only" })
    }
  }

  // Resolve each exact profile definition from the trusted Core Config owner,
  // then submit the whole plan as one durable reducer event. The delivery key
  // is stable for this Run ID; OwnerLog rejects a changed plan under that key.
  const profiles = yield* AgentProfileService
  const pinnedTasks = yield* Effect.forEach(tasks, (task) => Effect.gen(function* () {
    const profileDefinition = (yield* Effect.mapError(
      profiles.agentProfiles(),
      (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
    )).find((profile) => profile.profileId === task.profileSelection.profileId && String(profile.revision) === task.profileSelection.revision)
    if (!profileDefinition) {
      return yield* new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: "selected AgentProfile revision is unavailable" })
    }
    const definition = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2)(profileDefinition),
      catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "selected AgentProfile definition is invalid" }),
    })
    return { ...task, profileDefinition: definition }
  }))
  const response = yield* call(operation, {
    goalID,
    runID,
    specID,
    specDigest,
    expectedGoalRevision,
    idempotencyKey: runID,
    tasks: pinnedTasks,
  }, runID, trustedPrincipal)
  const planned = yield* decode(operation, response, (name, value) => {
    if (value.schemaVersion !== 1) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel PLAN_ONLY response has an unsupported schema version" })
    }
    const phase = requiredText(name, value, "runPhase", 32)
    if (phase !== "PLAN_ONLY" || requiredBoolean(name, value, "tasksReady")) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "kernel returned a dispatchable plan" })
    }
    const taskPinsValue = value.taskPins
    if (!Array.isArray(taskPinsValue) || taskPinsValue.length !== tasks.length || taskPinsValue.length > MAX_LIST_ITEMS) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel did not return one immutable authority pin for each planned Task" })
    }
    const taskPins = taskPinsValue.map((item) => {
      const pin = requiredRecord(name, item, "Task authority pin")
      return {
        taskID: identifier(name, requiredText(name, pin, "taskID", 256), "taskID"),
        goalID: identifier(name, requiredText(name, pin, "goalID", 256), "goalID"),
        runID: identifier(name, requiredText(name, pin, "runID", 256), "runID"),
        runRevision: requiredRevision(name, pin, "runRevision"),
        specID: identifier(name, requiredText(name, pin, "specID", 256), "specID"),
        specDigest: decodeBlake3Digest(name, requiredText(name, pin, "specDigest", 256), "specDigest"),
        profileID: identifier(name, requiredText(name, pin, "profileID", 256), "profileID"),
        profileRevision: requiredRevision(name, pin, "profileRevision"),
        profileDigest: decodeBlake3Digest(name, requiredText(name, pin, "profileDigest", 256), "profileDigest"),
        acceptedScopeDigest: decodeBlake3Digest(name, requiredText(name, pin, "acceptedScopeDigest", 256), "acceptedScopeDigest"),
        profilePermissionCeilingDigest: decodeBlake3Digest(name, requiredText(name, pin, "profilePermissionCeilingDigest", 256), "profilePermissionCeilingDigest"),
      }
    })
    const revision = requiredRevision(name, value, "revision")
    const responseGoalID = identifier(name, requiredText(name, value, "goalID", 256), "goalID")
    const responseRunID = identifier(name, requiredText(name, value, "runID", 256), "runID")
    const responseSpecID = identifier(name, requiredText(name, value, "specID", 256), "specID")
    const responseSpecDigest = decodeBlake3Digest(name, requiredText(name, value, "specDigest", 256), "specDigest")
    const taskIDsValue = value.taskIDs
    if (!Array.isArray(taskIDsValue) || taskIDsValue.length !== tasks.length || taskIDsValue.some((taskID, index) => taskID !== tasks[index]?.taskID)) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel returned Task IDs that differ from the submitted plan" })
    }
    const byTask = new Map(tasks.map((task) => [task.taskID, task]))
    for (const [index, pin] of taskPins.entries()) {
      const task = byTask.get(pin.taskID)
      if (!task || task.taskID !== tasks[index]?.taskID || responseGoalID !== goalID || responseRunID !== runID || responseSpecID !== specID || responseSpecDigest !== specDigest ||
        pin.goalID !== goalID || pin.runID !== runID || pin.runRevision !== revision ||
        pin.specID !== specID || pin.specDigest !== specDigest ||
        pin.profileID !== task.profileSelection.profileId || pin.profileRevision !== task.profileSelection.revision) {
        throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel returned a Task authority pin that differs from the requested immutable plan" })
      }
    }
    return { revision, specDigest: responseSpecDigest, taskPins }
  })
  return {
    status: "PLAN_ONLY" as const,
    executionAvailable: false as const,
    goalID,
    runID,
    specID,
    specDigest: planned.specDigest,
    runPhase: "PLAN_ONLY",
    taskIDs: tasks.map((task) => task.taskID),
    taskPins: planned.taskPins,
    tasksReady: false as const,
    revision: planned.revision,
    reason: "Tasks remain non-dispatchable until goal.start names this exact accepted SpecVersion and Run; after start, Task admission still requires authenticated P1/P8 owner proofs.",
  }
})

/** Starts one exact persisted plan; no Task/profile authority is accepted here. */
export const startPlannedRun = Effect.fn("ManagedControl.startPlannedRun")(function* (input: GoalRunStartInput) {
  const operation = "start_planned_run"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const specID = identifier(operation, input.specID, "specID")
  const specDigest = digestValue(operation, input.specDigest, "specDigest")
  const expectedGoalRevision = input.expectedGoalRevision
  if (
    typeof expectedGoalRevision !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(expectedGoalRevision) ||
    BigInt(expectedGoalRevision) > 18_446_744_073_709_551_615n
  ) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedGoalRevision is not a canonical u64" })
  }
  const idempotencyKey = identifier(operation, input.idempotencyKey, "idempotencyKey")
  const sessionID = identifier(operation, input.sessionID, "sessionID")
  const projectRef = identifier(operation, input.projectRef, "projectRef")
  const workspaceRef = identifier(operation, input.workspaceRef, "workspaceRef")
  const link = input.sessionLink
  if (
    link === null || typeof link !== "object" || Array.isArray(link) ||
    link.sourceCursor === null || typeof link.sourceCursor !== "object" || Array.isArray(link.sourceCursor)
  ) {
    return yield* new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "Core SessionLink projection or source cursor is malformed",
    })
  }
  const linkSessionID = identifier(operation, link.sessionID, "sessionLink.sessionID")
  const sourceStoreID = identifier(operation, link.sourceStoreID, "sessionLink.sourceStoreID")
  const sourceInstanceID = identifier(operation, link.sourceInstanceID, "sessionLink.sourceInstanceID")
  const sourceEpoch = canonicalDecimalU64(operation, link.sourceEpoch, "sessionLink.sourceEpoch")
  const protocolVersion = 1
  const cursorSeq = canonicalDecimalU64(operation, link.sourceCursor.seq, "sessionLink.sourceCursor.seq")
  if (linkSessionID !== sessionID || link.sourceCursor.ownerKind !== "session" ||
    link.sourceCursor.ownerId !== sessionID || cursorSeq < 1n || sourceEpoch < 1n ||
    typeof link.sourceCursor.eventDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(link.sourceCursor.eventDigest) ||
    typeof link.sourceDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(link.sourceDigest) ||
    link.redactionProfile !== "horizon.session-link.ids-only.v1" || link.protocolVersion !== protocolVersion ||
    link.goalID !== goalID || link.projectID !== projectRef || link.workspaceID !== workspaceRef ||
    (link.latestObservedMessageID !== null &&
      (typeof link.latestObservedMessageID !== "string" || !IDENTIFIER.test(link.latestObservedMessageID))) ||
    (link.latestObservedPartID !== null &&
      (typeof link.latestObservedPartID !== "string" || !IDENTIFIER.test(link.latestObservedPartID)))) {
    return yield* new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "Core SessionLink projection is incomplete or does not match the selected Goal/Session",
    })
  }
  if (link.ownerEpoch !== undefined && canonicalDecimalU64(operation, link.ownerEpoch, "sessionLink.ownerEpoch") < 1n) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "pinned SessionLink ownerEpoch must be positive" })
  }
  const response = yield* call(operation, {
    goalID,
    runID,
    specID,
    specDigest,
    expectedGoalRevision,
    sessionID,
    sessionLink: {
      ...link,
      sourceStoreID,
      sourceInstanceID,
      sourceEpoch: sourceEpoch.toString(),
      sourceCursor: { ...link.sourceCursor, seq: cursorSeq.toString() },
    },
    idempotencyKey,
  }, idempotencyKey, trustedPrincipal)
  return yield* decode(operation, response, (name, value) => {
    const decoded = decodeRunStarted(name, value)
    if (decoded.goalID !== goalID || decoded.runID !== runID || decoded.specID !== specID || decoded.sessionID !== sessionID) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "kernel returned a different managed Run" })
    }
    return decoded
  })
})

/** Persist P8 root-coordinator lineage after the atomic Run start; retries use the same delivery. */
export const registerRootCoordinator = Effect.fn("ManagedControl.registerRootCoordinator")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly sessionID: string
  readonly locationID: string
}) {
  const operation = "register_root_coordinator"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const sessionID = identifier(operation, input.sessionID, "sessionID")
  const locationID = identifier(operation, input.locationID, "locationID")
  const response = yield* call(
    operation,
    { goalID, runID, locationID },
    oneUseKey(runID, "root-coordinator"),
    trustedPrincipal,
  )
  yield* decode(operation, response, (name, value) => {
    requireStatus(name, value, "registered")
    if (value.goalID !== goalID || value.runID !== runID || value.locationID !== locationID || value.sessionID !== sessionID) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "root coordinator receipt does not match the started Run and Location" })
    }
    identifier(name, requiredText(name, value, "rootExecutionID", 256), "rootExecutionID")
    identifier(name, requiredText(name, value, "ownerLogID", 256), "ownerLogID")
    const sequence = requiredText(name, value, "ownerLogSequence", 32)
    canonicalDecimalU64(name, sequence, "ownerLogSequence")
    if (!/^blake3:[0-9a-f]{64}$/.test(requiredText(name, value, "ownerLogEventDigest", 128))) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "root coordinator OwnerLog digest is invalid" })
    }
    requiredRevision(name, value, "workerPoolRevision")
  })
})

export const registerTrustedGitProfile = Effect.fn("ManagedControl.registerTrustedGitProfile")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly locationRef: typeof Location.Ref.Type
}) {
  const operation = "register_git_profile"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const locations = yield* LocationServiceMap.Service
  const trustedGitExecutable = yield* Effect.gen(function* () {
    const config = yield* CoreConfigService
    return yield* config.trustedGitExecutable()
  }).pipe(Effect.provide(locations.get(input.locationRef)))
  if (!trustedGitExecutable) {
    return yield* new ManagedControlError({
      operation,
      code: "capability_unavailable",
      reason: "managed worktree execution requires one valid user-configured absolute Git executable",
    })
  }
  const supervisor = yield* SessionSupervisor.Service
  const gitProfile = yield* supervisor.requestHostKernel(
    "terminal.v1",
    "register_git_profile",
    { executable: trustedGitExecutable },
    { trustedPrincipal },
  ).pipe(
    Effect.mapError((error) => new ManagedControlError({
      operation,
      code: error.hostCode ?? "managed_unavailable",
      reason: error.reason,
    })),
  )
  if (gitProfile.selector !== "horizoncode:git:git" || gitProfile.profileID !== "git-worktree" ||
    gitProfile.profileRevision !== "1" || typeof gitProfile.profileDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(gitProfile.profileDigest) || typeof gitProfile.executableDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(gitProfile.executableDigest)) {
    return yield* new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "HostKernel returned a malformed or mismatched trusted Git execution profile",
    })
  }
})

/** Fails when a host response does not echo the immutable ids of the request. */
function expectEcho<T extends Record<string, unknown>>(
  operation: string,
  response: T,
  expected: Readonly<Record<string, string>>,
): T {
  for (const [key, value] of Object.entries(expected)) {
    if (response[key] !== value) {
      throw new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: `host response does not echo ${key}`,
      })
    }
  }
  return response
}

/**
 * The exact body key set HostKernel's `strict_fields(body, required, &[])`
 * accepts for `admit`: the 12 pre-admission common keys (`goalID`, `runID`,
 * `taskID`, `expectedRevision`, `parentSessionID`, `locationID`, `sessionID`,
 * `profileDefinition`, `contextSelection`, `resourcePolicyProjectionRevision`,
 * `resourcePolicyProjectionDigest`, `preAdmissionProofDigest`) plus
 * `managedProviderRoute` and `attemptID`. `admit` has **no optional keys**, so
 * an unlisted key such as the previously sent `profileSelection` is rejected
 * with `invalid_effect_request` before any admission logic runs.
 */
export const ADMIT_BODY_KEYS: ReadonlyArray<string> = Object.freeze([
  "attemptID",
  "contextSelection",
  "expectedRevision",
  "goalID",
  "locationID",
  "managedProviderRoute",
  "parentSessionID",
  "preAdmissionProofDigest",
  "profileDefinition",
  "resourcePolicyProjectionDigest",
  "resourcePolicyProjectionRevision",
  "runID",
  "sessionID",
  "taskID",
])

/** Fail closed before dispatch if the admit body drifts from the Rust closed set. */
export function requireClosedAdmitBody(operation: string, body: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(body)
  if (keys.length !== ADMIT_BODY_KEYS.length || keys.some((key) => !ADMIT_BODY_KEYS.includes(key))) {
    throw new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: `admit body must carry exactly the HostKernel closed key set; got [${keys.toSorted().join(", ")}]`,
    })
  }
}

export const admitAttempt = Effect.fn("ManagedControl.admitAttempt")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly parentSessionID: string
  readonly locationID: string
  readonly sessionID: string
  readonly expectedRevision: ManagedRevision
  readonly profileSelection: { readonly profileId: string; readonly revision: string }
  readonly preAdmissionProofDigest: string
  readonly contextSelection: ContextSelection
  readonly resourcePolicyProjectionRevision?: string
  readonly resourcePolicyProjectionDigest?: string
}) {
  const operation = "admit"
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const profileID = identifier(operation, input.profileSelection.profileId, "profileSelection.profileId")
  const profileRevision = canonicalDecimalU64(operation, input.profileSelection.revision, "profileSelection.revision")
  if (profileRevision < 1n) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "AgentProfile revision must be positive" })
  }
  const profiles = yield* AgentProfileService
  const configuredProfile = yield* Effect.mapError(
    profiles.agentProfile(profileID, profileRevision.toString()),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(configuredProfile),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "AgentProfile definition is invalid" }),
  })
  if (profileDefinition.profileId !== profileID || String(profileDefinition.revision) !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "AgentProfile definition does not match the exact selection" })
  }
  const managedProviderRoute = yield* Effect.mapError(
    managedRouteProjection({
      providerID: ProviderV2.ID.make(profileDefinition.model.providerId),
      modelID: ModelV2.ID.make(profileDefinition.model.modelId),
      harnessID: profileDefinition.harness,
    }),
    (error) => new ManagedControlError({ operation, code: "provider_route_unavailable", reason: error.message }),
  )
  const contextSelection = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(input.contextSelection),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "ContextSelectionV1 is invalid" }),
  })
  if (contextSelection.sessionID !== input.sessionID || contextSelection.attemptID !== attemptID || contextSelection.requestSequence !== "1") {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed admission requires the exact child Session, Attempt and first request sequence" })
  }
  const preAdmissionProofDigest = decodeBlake3Digest(operation, input.preAdmissionProofDigest, "preAdmissionProofDigest")
  // HostKernel's `admit` requires the exact resource-policy projection pin for
  // this candidate. Missing or malformed values fail closed here instead of
  // sending a body Rust rejects before any admission logic runs.
  const resourcePolicyProjectionRevision = yield* Effect.try({
    try: () =>
      canonicalDecimalU64(operation, input.resourcePolicyProjectionRevision ?? "", "resourcePolicyProjectionRevision"),
    catch: () =>
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "resourcePolicyProjectionRevision is not a canonical u64",
      }),
  })
  const resourcePolicyProjectionDigest = yield* Effect.try({
    try: () => decodeBlake3Digest(operation, input.resourcePolicyProjectionDigest ?? "", "resourcePolicyProjectionDigest"),
    catch: () =>
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "resourcePolicyProjectionDigest is not a canonical BLAKE3 digest",
      }),
  })
  const body: Record<string, unknown> = {
    goalID,
    runID,
    taskID,
    attemptID,
    parentSessionID: identifier(operation, input.parentSessionID, "parentSessionID"),
    locationID: identifier(operation, input.locationID, "locationID"),
    sessionID: identifier(operation, input.sessionID, "sessionID"),
    // Rust reads this with `canonical_decimal_revision`, i.e. a canonical
    // decimal *string* exactly like Stage-A `reserve`, not a MessagePack uint64.
    expectedRevision: expectedRevision(operation, input.expectedRevision).toString(),
    profileDefinition,
    contextSelection,
    resourcePolicyProjectionRevision: resourcePolicyProjectionRevision.toString(),
    resourcePolicyProjectionDigest,
    preAdmissionProofDigest,
    managedProviderRoute,
  }
  yield* Effect.try({
    try: () => requireClosedAdmitBody(operation, body),
    catch: (error: unknown) =>
      error instanceof ManagedControlError
        ? error
        : new ManagedControlError({
            operation,
            code: "managed_protocol",
            reason: "admit body does not match the HostKernel closed key set",
          }),
  })
  const response = yield* call(operation, body, oneUseKey(attemptID, "admit"))
  const decoded = yield* decode(operation, response, decodeManagedAttemptAdmission)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, taskID, attemptID }))
  if (decoded.requestSequence !== contextSelection.requestSequence || decoded.requestID !== contextSelection.requestID ||
    decoded.managedAttempt.sessionID !== contextSelection.sessionID || contextSelection.attemptID !== attemptID ||
    decoded.contextSelectionDigest !== decoded.managedAttempt.contextSelectionDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted a different first provider ContextSelection" })
  }
  if (decoded.profile.profileID !== profileID || decoded.profile.profileRevision !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted a different AgentProfile revision" })
  }
  if (JSON.stringify(decoded.managedProviderRoute) !== JSON.stringify(managedProviderRoute)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted a different Provider/SecretBroker route projection" })
  }
  return decoded
})

/**
 * Persist a fresh request selection before dispatch. The durable HostKernel event is
 * the ordering fence: no managed provider request may proceed until this receipt is
 * decoded and its refreshed scope is accepted by ManagedAttemptAuthority.
 */
export const advanceManagedContext = Effect.fn("ManagedControl.advanceManagedContext")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly contextSelection: ContextSelection
  /** Required when the previous provider request completed the managed turn. */
  readonly wakeClaim?: ManagedMessageWakeClaimReceiptV1
}) {
  const operation = "managed_context.advance"
  const scope = yield* Effect.try({
    try: () => managedAttemptScopeValue(operation, input.scope),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope is malformed" }),
  })
  const contextSelection = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(input.contextSelection),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "ContextSelectionV1 is invalid" }),
  })
  const expectedSequence = BigInt(scope.requestSequence) + 1n
  if (expectedSequence > 1024n || contextSelection.attemptID !== scope.attemptID ||
    contextSelection.sessionID !== scope.sessionID || contextSelection.requestSequence !== expectedSequence.toString() ||
    contextSelection.requestID === scope.requestID) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "selection is not the exact next provider request for the live Attempt" })
  }
  if (input.wakeClaim && (input.wakeClaim.status !== "CLAIMED" ||
    input.wakeClaim.currentConsumer.requestID !== scope.requestID ||
    input.wakeClaim.currentConsumer.requestSequence !== scope.requestSequence ||
    input.wakeClaim.requestID !== contextSelection.requestID ||
    input.wakeClaim.nextRequestSequence !== contextSelection.requestSequence ||
    stableManagedJSON(input.wakeClaim.currentConsumer) !== stableManagedJSON(scope))) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "follow-up ContextSelection differs from its one-use wake claim" })
  }
  const response = yield* call(operation, {
    managedAttempt: scope,
    contextSelection,
    ...(input.wakeClaim ? { wakeClaim: input.wakeClaim } : {}),
  },
    `managed_context_${scope.attemptID}_${contextSelection.requestSequence}`)
  const keys = ["status", "goalID", "runID", "taskID", "attemptID", "ownerEpoch", "sessionID", "requestSequence", "requestID", "contextSelectionDigest", "revision", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || (response.status !== "ADMITTED" && response.status !== "REPLAY")) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "context-selection receipt has an invalid shape or status" })
  }
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const taskID = identifier(operation, requiredText(operation, response, "taskID", 256), "taskID")
  const attemptID = identifier(operation, requiredText(operation, response, "attemptID", 256), "attemptID")
  const ownerEpoch = requiredRevision(operation, response, "ownerEpoch")
  const sessionID = identifier(operation, requiredText(operation, response, "sessionID", 256), "sessionID")
  const requestSequence = requiredRevision(operation, response, "requestSequence")
  const requestID = identifier(operation, requiredText(operation, response, "requestID", 256), "requestID")
  const contextSelectionDigest = decodeBlake3Digest(operation, requiredText(operation, response, "contextSelectionDigest", 256), "contextSelectionDigest")
  const revision = requiredRevision(operation, response, "revision")
  const refreshed = managedAttemptScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1)
  const identityMatches = goalID === scope.goalID && runID === scope.runID && taskID === scope.taskID && attemptID === scope.attemptID &&
    ownerEpoch === scope.ownerEpoch && sessionID === scope.sessionID && requestSequence === contextSelection.requestSequence &&
    requestID === contextSelection.requestID && refreshed.requestSequence === requestSequence && refreshed.requestID === requestID &&
    refreshed.contextSelectionDigest === contextSelectionDigest && refreshed.expectedManagedRevision === revision &&
    contextSelectionDigest !== scope.contextSelectionDigest && isContextAdvancedManagedAttemptScope(scope, refreshed)
  if (!identityMatches) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel context receipt does not advance the exact live Attempt selection" })
  }
  return {
    status: response.status,
    goalID,
    runID,
    taskID,
    attemptID,
    ownerEpoch,
    sessionID,
    requestSequence,
    requestID,
    contextSelectionDigest,
    revision,
    managedAttempt: refreshed,
  } satisfies ManagedContextAdvanceReceiptV1
})

function managedProviderRouteValue(operation: string, raw: ManagedProviderRouteProjectionV1): ManagedProviderRouteProjectionV1 {
  const keys = ["providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef"].toSorted()
  if (typeof raw !== "object" || raw === null || Object.keys(raw).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "trusted managed provider route projection has an invalid shape" })
  }
  return {
    providerID: identifier(operation, raw.providerID, "providerID"),
    modelID: identifier(operation, raw.modelID, "modelID"),
    harnessID: identifier(operation, raw.harnessID, "harnessID"),
    routeID: identifier(operation, raw.routeID, "routeID"),
    endpointRevision: decodeBlake3Digest(operation, raw.endpointRevision, "endpointRevision"),
    credentialLeaseRef: raw.credentialLeaseRef === null ? null : identifier(operation, raw.credentialLeaseRef, "credentialLeaseRef"),
  }
}

function managedProviderInputPinsValue(operation: string, raw: ManagedProviderInputPinsV1, scope: ManagedAttemptScopeV1): ManagedProviderInputPinsV1 {
  const keys = ["requestID", "requestSequence", "contextSelectionDigest", "requestDigest", "transportRequestDigest", "operationDigest"].toSorted()
  if (typeof raw !== "object" || raw === null || Object.keys(raw).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed provider request pins have an invalid shape" })
  }
  const pins = {
    requestID: identifier(operation, raw.requestID, "requestID"),
    requestSequence: requiredRevision(operation, { requestSequence: raw.requestSequence }, "requestSequence"),
    contextSelectionDigest: decodeBlake3Digest(operation, raw.contextSelectionDigest, "contextSelectionDigest"),
    requestDigest: decodeBlake3Digest(operation, raw.requestDigest, "requestDigest"),
    transportRequestDigest: decodeBlake3Digest(operation, raw.transportRequestDigest, "transportRequestDigest"),
    operationDigest: decodeSha256Digest(operation, raw.operationDigest, "operationDigest"),
  }
  if (BigInt(pins.requestSequence) < 1n || BigInt(pins.requestSequence) > 1024n ||
    pins.requestID !== scope.requestID || pins.requestSequence !== scope.requestSequence ||
    pins.contextSelectionDigest !== scope.contextSelectionDigest) {
    throw new ManagedControlError({ operation, code: "managed_conflict", reason: "provider request pins do not match the current HostKernel ContextSelection" })
  }
  return pins
}

function managedProviderRequestPinsValue(operation: string, route: ManagedProviderRouteProjectionV1, raw: ManagedProviderInputPinsV1, scope: ManagedAttemptScopeV1): ManagedProviderRequestPinsV1 {
  return { ...managedProviderRouteValue(operation, route), ...managedProviderInputPinsValue(operation, raw, scope) }
}

function providerRequestScopeTransition(operation: string, previous: ManagedAttemptScopeV1, value: unknown, pins: ManagedProviderRequestPinsV1, response: Record<string, unknown>) {
  const refreshed = managedAttemptScopeValue(operation, requiredRecord(operation, value, "managedAttempt") as unknown as ManagedAttemptScopeV1)
  const revision = requiredRevision(operation, response, "revision")
  if (!isNextManagedAttemptScope(previous, refreshed) || refreshed.expectedManagedRevision !== revision ||
    refreshed.requestID !== pins.requestID || refreshed.requestSequence !== pins.requestSequence ||
    refreshed.contextSelectionDigest !== pins.contextSelectionDigest) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider request transition changed stale Attempt or ContextSelection authority" })
  }
  return { revision, managedAttempt: refreshed }
}

function providerRequestPinsFromResponse(operation: string, value: Record<string, unknown>, scope: ManagedAttemptScopeV1): ManagedProviderRequestPinsV1 {
  return managedProviderRequestPinsValue(operation, {
    providerID: requiredText(operation, value, "providerID", 256),
    modelID: requiredText(operation, value, "modelID", 256),
    harnessID: requiredText(operation, value, "harnessID", 256),
    routeID: requiredText(operation, value, "routeID", 256),
    endpointRevision: requiredText(operation, value, "endpointRevision", 256),
    credentialLeaseRef: value.credentialLeaseRef === null ? null : requiredText(operation, value, "credentialLeaseRef", 256),
  }, {
    requestID: requiredText(operation, value, "requestID", 256),
    requestSequence: requiredText(operation, value, "requestSequence", 20),
    contextSelectionDigest: requiredText(operation, value, "contextSelectionDigest", 256),
    requestDigest: requiredText(operation, value, "requestDigest", 256),
    transportRequestDigest: requiredText(operation, value, "transportRequestDigest", 256),
    operationDigest: decodeSha256Digest(operation, requiredText(operation, value, "operationDigest", 256), "operationDigest"),
    }, scope)
}

/** Persist a single exact managed provider input/route before any network dispatch. */
export const prepareManagedProviderRequest = Effect.fn("ManagedControl.prepareManagedProviderRequest")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly routeProjection: ManagedProviderRouteProjectionV1
  readonly requestPins: ManagedProviderInputPinsV1
  readonly contextSelection: ContextSelection
  readonly profileSelection: { readonly profileId: string; readonly revision: string }
}) {
  const operation = "managed_provider.prepare"
  const scope = yield* Effect.try({
    try: () => managedAttemptScopeValue(operation, input.scope),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope is malformed" }),
  })
  const pins = yield* Effect.try({
    try: () => managedProviderRequestPinsValue(operation, input.routeProjection, input.requestPins, scope),
    catch: (error) => error instanceof ManagedControlError ? error : new ManagedControlError({ operation, code: "managed_protocol", reason: "provider request pins are malformed" }),
  })
  const contextSelection = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(input.contextSelection),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "provider ContextSelection is invalid" }),
  })
  const providerInputs = contextSelection.sources.filter((source) => source.kind === "provider-input")
  if (contextSelection.sessionID !== scope.sessionID || contextSelection.attemptID !== scope.attemptID ||
    contextSelection.requestID !== pins.requestID || contextSelection.requestSequence !== pins.requestSequence ||
    providerInputs.length !== 1 || providerInputs[0]!.contentDigest !== pins.requestDigest) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_conflict", reason: "provider input digest or request selection does not match the live ContextSelection" }))
  }
  const profileID = identifier(operation, input.profileSelection.profileId, "profileSelection.profileId")
  const profileRevision = canonicalDecimalU64(operation, input.profileSelection.revision, "profileSelection.revision")
  if (profileRevision < 1n || profileRevision > BigInt(Number.MAX_SAFE_INTEGER)) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: "profile revision is outside the trusted Core Config range" }))
  }
  const profiles = yield* AgentProfileService
  const configured = yield* Effect.mapError(
    profiles.agentProfile(profileID, profileRevision.toString()),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(configured),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "trusted AgentProfileV2 definition is invalid" }),
  })
  if (profileDefinition.profileId !== profileID || String(profileDefinition.revision) !== profileRevision.toString() ||
    profileDefinition.harness !== pins.harnessID) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "agent_profile_stale", reason: "provider harness differs from the exact trusted Task-pinned AgentProfileV2" }))
  }
  const routeProjection = managedProviderRouteValue(operation, input.routeProjection)
  const requestPins = managedProviderInputPinsValue(operation, input.requestPins, scope)
  const response = yield* call(operation, { managedAttempt: scope, profileDefinition, routeProjection, requestPins },
    `managed_provider_prepare_${scope.attemptID}_${pins.requestSequence}`)
  const pinsKeys = ["requestID", "requestSequence", "contextSelectionDigest", "providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef", "requestDigest", "transportRequestDigest", "operationDigest"]
  const keys = [...pinsKeys, "guardChallenge", "status", "revision", "managedAttempt"].toSorted()
  const activeKeys = [...keys, "providerRequestID", "prepareDigest"].toSorted()
  if ((response.status === "UNAVAILABLE"
      ? Object.keys(response).toSorted().join("\0") !== keys.join("\0")
      : Object.keys(response).toSorted().join("\0") !== activeKeys.join("\0") || (response.status !== "PREPARED" && response.status !== "REPLAY"))) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider prepare receipt has an invalid shape or status" }))
  }
  const echoed = providerRequestPinsFromResponse(operation, response, scope)
  if (JSON.stringify(echoed) !== JSON.stringify(pins)) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider prepare receipt changed an exact route or request pin" }))
  const providerRequestID = response.status === "UNAVAILABLE" ? null : identifier(operation, requiredText(operation, response, "providerRequestID", 256), "providerRequestID")
  const prepareDigest = response.status === "UNAVAILABLE" ? null : decodeBlake3Digest(operation, requiredText(operation, response, "prepareDigest", 256), "prepareDigest")
  const guardChallenge = response.status === "UNAVAILABLE" ? null : (() => {
    const value = requiredRecord(operation, response.guardChallenge, "guardChallenge")
    const challengeKeys = ["allowEnabled", "argumentSummary", "capabilityID", "challengeID", "effectID", "expiresAtUnixMs", "guaranteeAssessment", "inputDigest", "normalizedAction", "normalizedTargets", "noResponse", "origin", "policyDigest", "policyID", "policySummary", "requestedGuarantees", "runID", "sessionID", "source"].toSorted()
    if (Object.keys(value).toSorted().join("\0") !== challengeKeys.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard challenge has an invalid shape" })
    }
    const expiresAtUnixMs = value.expiresAtUnixMs
    if (typeof expiresAtUnixMs !== "number" || !Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= Date.now() || expiresAtUnixMs > Date.now() + 5 * 60 * 1000 ||
      value.capabilityID !== "providers.infer" || value.origin !== "managed_run" || value.source !== "host.managed_provider" ||
      value.policyID !== "provider-inference.managed.v1" || value.normalizedAction !== "providers.infer" ||
      value.runID !== scope.runID || value.sessionID !== scope.sessionID || value.noResponse !== "deny_and_expire" || value.allowEnabled !== true) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard challenge expiry is invalid" })
    }
    const normalizedTargets = value.normalizedTargets
    if (!Array.isArray(normalizedTargets) || normalizedTargets.length !== 1) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard challenge targets are invalid" })
    const target = requiredRecord(operation, normalizedTargets[0], "normalized provider target")
    const targetKeys = ["endpointRevision", "harnessID", "maxCostMicros", "maxTokens", "modelID", "providerID", "routeID"].toSorted()
    if (Object.keys(target).toSorted().join("\0") !== targetKeys.join("\0") || target.providerID !== input.routeProjection.providerID ||
      target.modelID !== input.routeProjection.modelID || target.harnessID !== input.routeProjection.harnessID || target.routeID !== input.routeProjection.routeID ||
      target.endpointRevision !== input.routeProjection.endpointRevision || target.maxTokens !== scope.remainingTokens ||
      typeof target.maxCostMicros !== "string" || !/^(0|[1-9][0-9]*)$/.test(target.maxCostMicros)) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard challenge target differs from the selected route or budget" })
    }
    const expectedGuarantees = ["live_managed_attempt", "selected_route_revision", "normalized_request_digest", "transport_request_digest", "secret_operation_digest", "explicit_route_consent", "budget_bound", "one_use", "no_fallback"]
    if (!Array.isArray(value.requestedGuarantees) || value.requestedGuarantees.join("\0") !== expectedGuarantees.join("\0")) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard guarantee set is invalid" })
    }
    const summary = requiredRecord(operation, value.argumentSummary, "provider argument summary")
    if (Object.keys(summary).toSorted().join("\0") !== "status\0text" || summary.status !== "available") {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard summary is invalid" })
    }
    const assessment = requiredRecord(operation, value.guaranteeAssessment, "provider guarantee assessment")
    if (Object.keys(assessment).toSorted().join("\0") !== "residual\0status" || assessment.status !== "assessed" || !Array.isArray(assessment.residual) || assessment.residual.length !== 0) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider Guard guarantees are not fully assessed" })
    }
    return {
      challengeID: identifier(operation, requiredText(operation, value, "challengeID", 256), "challengeID"),
      effectID: identifier(operation, requiredText(operation, value, "effectID", 256), "effectID"),
      capabilityID: "providers.infer" as const,
      inputDigest: decodeBlake3Digest(operation, requiredText(operation, value, "inputDigest", 256), "inputDigest"),
      normalizedTargets,
      expiresAtUnixMs,
      policySummary: requiredText(operation, value, "policySummary", 512),
      origin: "managed_run" as const,
      source: "host.managed_provider" as const,
      policyID: "provider-inference.managed.v1" as const,
      policyDigest: decodeBlake3Digest(operation, requiredText(operation, value, "policyDigest", 256), "policyDigest"),
      normalizedAction: "providers.infer" as const,
      argumentSummary: { status: "available", text: requiredText(operation, summary, "text", 512) },
      requestedGuarantees: expectedGuarantees,
      guaranteeAssessment: { status: "assessed", residual: [] },
      runID: scope.runID,
      sessionID: scope.sessionID,
      noResponse: "deny_and_expire" as const,
      allowEnabled: true,
    } satisfies ManagedProviderGuardChallengeV1
  })()
  if (providerRequestID !== null && providerRequestID !== `mpr_${scope.attemptID}_${pins.requestSequence}`) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider request identity is not the canonical Attempt sequence" }))
  if (response.status === "UNAVAILABLE") {
    const revision = requiredRevision(operation, response, "revision")
    const unchanged = managedAttemptScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1)
    if (revision !== scope.expectedManagedRevision || !sameManagedAttemptScope(scope, unchanged)) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "unavailable provider route changed durable Attempt state" }))
    if (response.guardChallenge !== null) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "unavailable provider prepare carried a Guard challenge" }))
    return { status: "UNAVAILABLE", providerRequestID: null, prepareDigest: null, guardChallenge: null, ...echoed, revision, managedAttempt: unchanged } satisfies ManagedProviderRequestPreparedV1
  }
  const { revision, managedAttempt } = providerRequestScopeTransition(operation, scope, response.managedAttempt, pins, response)
  return { status: response.status as "PREPARED" | "REPLAY", providerRequestID, prepareDigest, guardChallenge, ...echoed, revision, managedAttempt } satisfies ManagedProviderRequestPreparedV1
})

/** Await a real authenticated user decision for the exact HostKernel challenge. */
export const awaitManagedProviderApproval = Effect.fn("ManagedControl.awaitManagedProviderApproval")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly routeProjection: ManagedProviderRouteProjectionV1
  readonly requestPins: ManagedProviderInputPinsV1
  readonly challenge: ManagedProviderGuardChallengeV1
}) {
  const supervisor = yield* SessionSupervisor.Service
  return yield* supervisor.awaitManagedProviderApproval({
    locationRef: Location.Ref.make({
      directory: AbsolutePath.make(input.scope.worktreeTarget.canonicalRoot),
      workspaceID: WorkspaceV2.ID.make(input.scope.worktreeTarget.workspaceID),
    }),
    scope: input.scope,
    routeProjection: input.routeProjection,
    requestPins: input.requestPins,
    challenge: { ...input.challenge, locationID: input.scope.locationID } satisfies SupervisorManagedProviderGuardChallengeV1,
  }).pipe(Effect.mapError((error: SessionSupervisorError) => new ManagedControlError({
    operation: "managed_provider.resolve_approval",
    code: error.hostCode ?? "managed_unavailable",
    reason: error.message,
  })))
})

/** Durable one-use send transition. A replay never contains a send authorization. */
export const beginManagedProviderRequest = Effect.fn("ManagedControl.beginManagedProviderRequest")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly routeProjection: ManagedProviderRouteProjectionV1
  readonly requestPins: ManagedProviderInputPinsV1
}) {
  const operation = "managed_provider.begin"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const providerRequestID = identifier(operation, input.providerRequestID, "providerRequestID")
  const prepareDigest = decodeBlake3Digest(operation, input.prepareDigest, "prepareDigest")
  const pins = managedProviderRequestPinsValue(operation, input.routeProjection, input.requestPins, scope)
  if (providerRequestID !== `mpr_${scope.attemptID}_${scope.requestSequence}`) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_conflict", reason: "provider request ID is not the canonical Attempt sequence" }))
  }
  const routeProjection = managedProviderRouteValue(operation, input.routeProjection)
  const requestPins = managedProviderInputPinsValue(operation, input.requestPins, scope)
  const request = { managedAttempt: scope, providerRequestID, prepareDigest, routeProjection, requestPins }
  const response = yield* call(operation, request, `managed_provider_begin_${scope.attemptID}_${scope.requestSequence}`)
  const pinsKeys = ["requestID", "requestSequence", "contextSelectionDigest", "providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef", "requestDigest", "transportRequestDigest", "operationDigest"]
  const unavailableKeys = [...pinsKeys, "status", "revision", "managedAttempt", "sendAuthorization", "guardChallengeID", "effectID", "capabilityLeaseDigest", "authorizationBindingDigest"].toSorted()
  const keys = [...pinsKeys, "status", "providerRequestID", "prepareDigest", "dispatchDigest", "sendAuthorization", "guardChallengeID", "effectID", "capabilityLeaseDigest", "authorizationBindingDigest", "revision", "managedAttempt"].toSorted()
  const freshKeys = [...keys, "secretUseContext"].toSorted()
  if (response.status === "UNAVAILABLE" ? Object.keys(response).toSorted().join("\0") !== unavailableKeys.join("\0") :
    Object.keys(response).toSorted().join("\0") !== (response.status === "DISPATCHING" ? freshKeys : keys).join("\0") || (response.status !== "DISPATCHING" && response.status !== "REPLAY")) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider begin receipt has an invalid shape or status" }))
  }
  const echoed = providerRequestPinsFromResponse(operation, response, scope)
  if (JSON.stringify(echoed) !== JSON.stringify(pins)) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider begin receipt changed an exact route or request pin" }))
  if (response.status === "UNAVAILABLE") {
    if (response.sendAuthorization !== null || response.guardChallengeID !== null || response.effectID !== null || response.capabilityLeaseDigest !== null || response.authorizationBindingDigest !== null) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "unavailable provider route cannot carry Guard or send authority" }))
    const revision = requiredRevision(operation, response, "revision")
    const unchanged = managedAttemptScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1)
    if (revision !== scope.expectedManagedRevision || !sameManagedAttemptScope(scope, unchanged)) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "unavailable provider begin changed durable Attempt state" }))
    return { status: "UNAVAILABLE", providerRequestID, prepareDigest, dispatchDigest: null, ...echoed, guardChallengeID: null, effectID: null, capabilityLeaseDigest: null, authorizationBindingDigest: null, sendAuthorization: null, revision, managedAttempt: unchanged } satisfies ManagedProviderRequestDispatchV1
  }
  if (requiredText(operation, response, "providerRequestID", 256) !== providerRequestID || decodeBlake3Digest(operation, requiredText(operation, response, "prepareDigest", 256), "prepareDigest") !== prepareDigest) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider begin receipt is for another prepared request" }))
  }
  const dispatchDigest = decodeBlake3Digest(operation, requiredText(operation, response, "dispatchDigest", 256), "dispatchDigest")
  const guardChallengeID = identifier(operation, requiredText(operation, response, "guardChallengeID", 256), "guardChallengeID")
  const effectID = identifier(operation, requiredText(operation, response, "effectID", 256), "effectID")
  const capabilityLeaseDigest = decodeBlake3Digest(operation, requiredText(operation, response, "capabilityLeaseDigest", 256), "capabilityLeaseDigest")
  const authorizationBindingDigest = decodeBlake3Digest(operation, requiredText(operation, response, "authorizationBindingDigest", 256), "authorizationBindingDigest")
  const rawAuthorization = response.sendAuthorization
  if (rawAuthorization !== null && typeof rawAuthorization !== "string") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider begin authorization is malformed" }))
  }
  const secretUseContext = response.secretUseContext
  if (response.status === "DISPATCHING" && (!secretUseContext || typeof secretUseContext !== "object" || Array.isArray(secretUseContext))) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh provider begin lacks its trusted SecretBroker context" }))
  }
  const sendAuthorization = response.status === "DISPATCHING" && typeof rawAuthorization === "string"
    ? retainManagedProviderSendAuthorization({
        ...echoed,
        guardChallengeID,
        effectID,
        capabilityLeaseDigest,
        authorizationBindingDigest,
        providerRequestID,
        prepareDigest,
        dispatchDigest,
        sendAuthorization: rawAuthorization,
        attemptID: scope.attemptID,
        ownerEpoch: scope.ownerEpoch,
        secretUseContext,
      }, {
        ...echoed,
        guardChallengeID,
        effectID,
        capabilityLeaseDigest,
        authorizationBindingDigest,
        providerRequestID,
        prepareDigest,
        dispatchDigest,
        attemptID: scope.attemptID,
        ownerEpoch: scope.ownerEpoch,
      })
    : null
  if ((response.status === "DISPATCHING") !== (sendAuthorization !== null)) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "only a fresh provider begin may carry one-use send authorization" }))
  }
  const { revision, managedAttempt } = providerRequestScopeTransition(operation, scope, response.managedAttempt, pins, response)
  return { status: response.status as "DISPATCHING" | "REPLAY", providerRequestID, prepareDigest, dispatchDigest, ...pins, guardChallengeID, effectID, capabilityLeaseDigest, authorizationBindingDigest, sendAuthorization, revision, managedAttempt } satisfies ManagedProviderRequestDispatchV1
})

/** Complete the durable call only after its exact assistant response entry exists in Session. */
export const settleManagedProviderRequest = Effect.fn("ManagedControl.settleManagedProviderRequest")(function* (input: {
  readonly authority: ManagedAttemptAuthority
  readonly scope: ManagedAttemptScopeV1
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string
  readonly transportRequestDigest: string
  readonly operationDigest: string
  readonly assistantEntryID: string
  readonly stepFinishIndex: number
  readonly responseDigest: string
  readonly usageProvenance: SessionMessageSchema.UsageProvenance
}) {
  const operation = "managed_provider.settle"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const providerRequestID = identifier(operation, input.providerRequestID, "providerRequestID")
  const prepareDigest = decodeBlake3Digest(operation, input.prepareDigest, "prepareDigest")
  const dispatchDigest = decodeBlake3Digest(operation, input.dispatchDigest, "dispatchDigest")
  const transportRequestDigest = decodeBlake3Digest(operation, input.transportRequestDigest, "transportRequestDigest")
  const operationDigest = decodeSha256Digest(operation, input.operationDigest, "operationDigest")
  const assistantEntryID = identifier(operation, input.assistantEntryID, "assistantEntryID")
  const stepFinishIndex = input.stepFinishIndex
  if (!Number.isSafeInteger(stepFinishIndex) || stepFinishIndex < 0 || stepFinishIndex > 1024) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider step-finish index is outside its bound" }))
  }
  const responseDigest = decodeBlake3Digest(operation, input.responseDigest, "responseDigest")
  const usageProvenance = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(SessionMessageSchema.UsageProvenance, { onExcessProperty: "error" })(input.usageProvenance),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "provider usage provenance is invalid" }),
  })
  const response = yield* call(operation, { managedAttempt: scope, providerRequestID, prepareDigest, dispatchDigest, transportRequestDigest, operationDigest, assistantEntryID, stepFinishIndex, responseDigest, usageProvenance },
    `managed_provider_settle_${scope.attemptID}_${scope.requestSequence}`)
  const keys = ["status", "providerRequestID", "prepareDigest", "dispatchDigest", "assistantEntryID", "stepFinishIndex", "responseDigest", "usageDigest", "requestID", "requestSequence", "contextSelectionDigest", "providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef", "requestDigest", "transportRequestDigest", "operationDigest", "revision", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || (response.status !== "SETTLED" && response.status !== "REPLAY")) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider settle receipt has an invalid shape or status" }))
  }
  if (requiredText(operation, response, "providerRequestID", 256) !== providerRequestID ||
    decodeBlake3Digest(operation, requiredText(operation, response, "prepareDigest", 256), "prepareDigest") !== prepareDigest ||
    decodeBlake3Digest(operation, requiredText(operation, response, "dispatchDigest", 256), "dispatchDigest") !== dispatchDigest ||
    decodeBlake3Digest(operation, requiredText(operation, response, "transportRequestDigest", 256), "transportRequestDigest") !== transportRequestDigest ||
    decodeSha256Digest(operation, requiredText(operation, response, "operationDigest", 256), "operationDigest") !== operationDigest ||
    requiredText(operation, response, "assistantEntryID", 256) !== assistantEntryID || response.stepFinishIndex !== stepFinishIndex ||
    decodeBlake3Digest(operation, requiredText(operation, response, "responseDigest", 256), "responseDigest") !== responseDigest) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider settle receipt changed an exact dispatch or response pin" }))
  }
  const usageDigest = decodeBlake3Digest(operation, requiredText(operation, response, "usageDigest", 256), "usageDigest")
  const pins = providerRequestPinsFromResponse(operation, response, scope)
  const { revision, managedAttempt } = providerRequestScopeTransition(operation, scope, response.managedAttempt, pins, response)
  const settlement = { status: response.status, providerRequestID, prepareDigest, dispatchDigest, ...pins, assistantEntryID, stepFinishIndex, responseDigest, usageDigest, revision, managedAttempt } satisfies ManagedProviderRequestSettlementV1
  input.authority.rememberProviderSettlement(settlement)
  return settlement
})

/** Recover settlement pins from the durable HostKernel OwnerLog, never transcript text. */
export const inspectLatestManagedProviderSettlement = Effect.fn("ManagedControl.inspectLatestManagedProviderSettlement")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
}) {
  const operation = "managed_provider.inspect_settlement"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const response = yield* call(operation, { managedAttempt: scope },
    `managed_provider_inspect_settlement_${scope.attemptID}_${scope.requestSequence}`)
  const keys = ["status", "providerRequestID", "prepareDigest", "dispatchDigest", "assistantEntryID", "stepFinishIndex", "responseDigest", "usageDigest", "requestID", "requestSequence", "contextSelectionDigest", "providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef", "requestDigest", "transportRequestDigest", "operationDigest", "revision", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.status !== "SETTLED") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "durable provider settlement projection has an invalid shape or status" }))
  }
  const pins = providerRequestPinsFromResponse(operation, response, scope)
  if (pins.requestSequence !== scope.requestSequence || pins.requestID !== scope.requestID ||
    pins.contextSelectionDigest !== scope.contextSelectionDigest ||
    requiredText(operation, response, "providerRequestID", 256) !== `mpr_${scope.attemptID}_${scope.requestSequence}` ||
    requiredRevision(operation, response, "revision") !== scope.expectedManagedRevision) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_conflict", reason: "durable settlement projection does not identify the exact current managed request" }))
  }
  const managedAttempt = managedAttemptScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1)
  if (!sameManagedAttemptScope(scope, managedAttempt)) return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "durable settlement projection changed the current Attempt scope" }))
  return {
    status: "REPLAY" as const,
    providerRequestID: requiredText(operation, response, "providerRequestID", 256),
    prepareDigest: decodeBlake3Digest(operation, requiredText(operation, response, "prepareDigest", 256), "prepareDigest"),
    dispatchDigest: decodeBlake3Digest(operation, requiredText(operation, response, "dispatchDigest", 256), "dispatchDigest"),
    ...pins,
    assistantEntryID: identifier(operation, requiredText(operation, response, "assistantEntryID", 256), "assistantEntryID"),
    stepFinishIndex: (() => { const index = response.stepFinishIndex; if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1024) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "provider step-finish index is invalid" }); return index })(),
    responseDigest: decodeBlake3Digest(operation, requiredText(operation, response, "responseDigest", 256), "responseDigest"),
    usageDigest: decodeBlake3Digest(operation, requiredText(operation, response, "usageDigest", 256), "usageDigest"),
    revision: requiredRevision(operation, response, "revision"),
    managedAttempt,
  } satisfies ManagedProviderRequestSettlementV1
})

/**
 * Complete a managed turn only from the exact settlement retained by the
 * authority object. The caller supplies the final transcript entry ID, never
 * response/usage digests or provider request pins.
 */
export const completeManagedProviderTurn = Effect.fn("ManagedControl.completeManagedProviderTurn")(function* (input: {
  readonly authority: ManagedAttemptAuthority
  readonly assistantEntryID: string
}) {
  const operation = "managed_provider.complete_turn"
  let settlement = input.authority.latestProviderSettlement()
  if (!settlement) {
    const inspected = yield* inspectLatestManagedProviderSettlement({ scope: input.authority.currentScope() })
    input.authority.rememberProviderSettlement(inspected)
    settlement = inspected
  }
  if (!settlement || settlement.assistantEntryID !== input.assistantEntryID) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_conflict", reason: "final assistant entry has no matching authenticated provider settlement" }))
  }
  const scope = managedAttemptScopeValue(operation, input.authority.currentScope())
  if (scope.goalID !== settlement.managedAttempt.goalID || scope.runID !== settlement.managedAttempt.runID ||
    scope.taskID !== settlement.managedAttempt.taskID || scope.attemptID !== settlement.managedAttempt.attemptID ||
    scope.ownerEpoch !== settlement.managedAttempt.ownerEpoch || scope.sessionID !== settlement.managedAttempt.sessionID ||
    scope.requestSequence !== settlement.requestSequence || scope.requestID !== settlement.requestID ||
    scope.contextSelectionDigest !== settlement.contextSelectionDigest) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_conflict", reason: "latest managed Attempt scope no longer names the settled provider request" }))
  }
  const response = yield* call(operation, {
    managedAttempt: scope,
    providerRequestID: settlement.providerRequestID,
    assistantEntryID: settlement.assistantEntryID,
    responseDigest: settlement.responseDigest,
    usageDigest: settlement.usageDigest,
  }, `managed_provider_complete_turn_${scope.attemptID}_${scope.requestSequence}`)
  const keys = ["status", "providerRequestID", "assistantEntryID", "responseDigest", "usageDigest", "dispatchSettlementDigest", "requestSequence", "completionReceiptDigest", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || (response.status !== "COMPLETED" && response.status !== "REPLAY") ||
    requiredText(operation, response, "providerRequestID", 256) !== settlement.providerRequestID ||
    requiredText(operation, response, "assistantEntryID", 256) !== settlement.assistantEntryID ||
    decodeBlake3Digest(operation, requiredText(operation, response, "responseDigest", 256), "responseDigest") !== settlement.responseDigest ||
    decodeBlake3Digest(operation, requiredText(operation, response, "usageDigest", 256), "usageDigest") !== settlement.usageDigest ||
    canonicalDecimalU64(operation, requiredText(operation, response, "requestSequence", 20), "requestSequence").toString() !== settlement.requestSequence) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "completed-turn receipt changed its exact settled provider response pins" }))
  }
  const completionReceiptDigest = decodeBlake3Digest(operation, requiredText(operation, response, "completionReceiptDigest", 256), "completionReceiptDigest")
  const dispatchSettlementDigest = decodeBlake3Digest(operation, requiredText(operation, response, "dispatchSettlementDigest", 256), "dispatchSettlementDigest")
  const managedAttempt = managedAttemptScopeValue(operation, requiredRecord(operation, response.managedAttempt, "managedAttempt") as unknown as ManagedAttemptScopeV1)
  if (!sameManagedAttemptScope(scope, managedAttempt)) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "completed-turn receipt changed the settled Attempt scope" }))
  }
  return { status: response.status, providerRequestID: settlement.providerRequestID,
    assistantEntryID: settlement.assistantEntryID, responseDigest: settlement.responseDigest,
    usageDigest: settlement.usageDigest, dispatchSettlementDigest, requestSequence: settlement.requestSequence,
    completionReceiptDigest, managedAttempt } satisfies ManagedProviderTurnCompletionV1
})

/** Fence an uncertain request; no receipt from this operation grants retry. */
export const markManagedProviderRequestUnknown = Effect.fn("ManagedControl.markManagedProviderRequestUnknown")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string
  readonly transportRequestDigest: string
  readonly operationDigest: string
  readonly reasonCode: string
}) {
  const operation = "managed_provider.unknown"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const providerRequestID = identifier(operation, input.providerRequestID, "providerRequestID")
  const prepareDigest = decodeBlake3Digest(operation, input.prepareDigest, "prepareDigest")
  const dispatchDigest = decodeBlake3Digest(operation, input.dispatchDigest, "dispatchDigest")
  const transportRequestDigest = decodeBlake3Digest(operation, input.transportRequestDigest, "transportRequestDigest")
  const operationDigest = decodeSha256Digest(operation, input.operationDigest, "operationDigest")
  const reasonCode = identifier(operation, input.reasonCode, "reasonCode")
  const response = yield* call(operation, { managedAttempt: scope, providerRequestID, prepareDigest, dispatchDigest, transportRequestDigest, operationDigest, reasonCode },
    `managed_provider_unknown_${scope.attemptID}_${scope.requestSequence}`)
  const keys = ["status", "providerRequestID", "prepareDigest", "dispatchDigest", "reasonCode", "requestID", "requestSequence", "contextSelectionDigest", "providerID", "modelID", "harnessID", "routeID", "endpointRevision", "credentialLeaseRef", "requestDigest", "transportRequestDigest", "operationDigest", "revision", "managedAttempt"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || (response.status !== "UNKNOWN" && response.status !== "REPLAY")) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider UNKNOWN receipt has an invalid shape or status" }))
  }
  if (requiredText(operation, response, "providerRequestID", 256) !== providerRequestID ||
    decodeBlake3Digest(operation, requiredText(operation, response, "prepareDigest", 256), "prepareDigest") !== prepareDigest ||
    decodeBlake3Digest(operation, requiredText(operation, response, "dispatchDigest", 256), "dispatchDigest") !== dispatchDigest ||
    decodeBlake3Digest(operation, requiredText(operation, response, "transportRequestDigest", 256), "transportRequestDigest") !== transportRequestDigest ||
    decodeSha256Digest(operation, requiredText(operation, response, "operationDigest", 256), "operationDigest") !== operationDigest ||
    requiredText(operation, response, "reasonCode", 128) !== reasonCode) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "provider UNKNOWN receipt changed its exact request identity" }))
  }
  const pins = providerRequestPinsFromResponse(operation, response, scope)
  const { revision, managedAttempt } = providerRequestScopeTransition(operation, scope, response.managedAttempt, pins, response)
  return { status: response.status, providerRequestID, prepareDigest, dispatchDigest, ...pins, reasonCode, revision, managedAttempt } satisfies ManagedProviderRequestUnknownV1
})

/** Resolve the profile only from the trusted Config owner, then request HostKernel's live claim. */
export const claimManagedDispatch = Effect.fn("ManagedControl.claimManagedDispatch")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly parentSessionID: string
  readonly attemptID: string
  readonly profileSelection: { readonly profileId: string; readonly revision: string }
  readonly deliveryID: string
}) {
  const operation = "claim_dispatch"
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const deliveryID = identifier(operation, input.deliveryID, "deliveryID")
  const profileID = identifier(operation, input.profileSelection.profileId, "profileSelection.profileId")
  const profileRevision = canonicalDecimalU64(operation, input.profileSelection.revision, "profileSelection.revision")
  if (profileRevision < 1n || profileRevision > BigInt(Number.MAX_SAFE_INTEGER)) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: "profile revision is outside the trusted Core Config range" })
  }
  const profiles = yield* AgentProfileService
  const configured = yield* Effect.mapError(
    profiles.agentProfile(profileID, profileRevision.toString()),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(configured),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "trusted AgentProfileV2 definition is invalid" }),
  })
  if (profileDefinition.profileId !== profileID || String(profileDefinition.revision) !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "trusted Config returned a different AgentProfileV2 revision" })
  }
  const parentSessionID = identifier(operation, input.parentSessionID, "parentSessionID")
  const response = yield* call(operation, { goalID, runID, taskID, parentSessionID, attemptID, profileDefinition }, deliveryID)
  const handoff = yield* decode(operation, response, (name, value) => {
    requireStatus(name, value, "HANDOFF_READY")
    const decoded = decodeManagedDispatchHandoff(name, value.handoff)
    if (decoded.goalID !== goalID || decoded.runID !== runID || decoded.taskID !== taskID || decoded.parentSessionID !== parentSessionID || decoded.attemptID !== attemptID ||
      decoded.profileID !== profileID || decoded.profileRevision !== profileRevision.toString()) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "HostKernel returned a handoff for different managed/profile pins" })
    }
    return decoded
  })
  return Object.freeze({ ...handoff, profileDefinition })
})

/** Consume the exact handoff once. Persist this receipt and a prompt-pending marker before provider dispatch. */
export const consumeManagedDispatch = Effect.fn("ManagedControl.consumeManagedDispatch")(function* (input: {
  readonly handoff: ManagedDispatchHandoffV1
  readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2
  readonly deliveryID: string
}) {
  const operation = "consume_dispatch"
  const handoff = decodeManagedDispatchHandoff(operation, input.handoff)
  const deliveryID = identifier(operation, input.deliveryID, "deliveryID")
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(input.profileDefinition),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "AgentProfileV2 definition is invalid" }),
  })
  if (profileDefinition.profileId !== handoff.profileID || String(profileDefinition.revision) !== handoff.profileRevision) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "profile definition does not match the claimed managed handoff" })
  }
  const response = yield* call(operation, {
    goalID: handoff.goalID,
    runID: handoff.runID,
    taskID: handoff.taskID,
    parentSessionID: handoff.parentSessionID,
    attemptID: handoff.attemptID,
    handoffID: handoff.handoffID,
    handoffDigest: handoff.handoffDigest,
    profileDefinition,
  }, deliveryID)
  const receipt = yield* decode(operation, response, decodeManagedDispatchConsumeReceipt)
  if (receipt.goalID !== handoff.goalID || receipt.runID !== handoff.runID || receipt.taskID !== handoff.taskID ||
    receipt.parentSessionID !== handoff.parentSessionID ||
    receipt.sessionID !== handoff.sessionID ||
    receipt.attemptID !== handoff.attemptID || receipt.handoffID !== handoff.handoffID || receipt.handoffDigest !== handoff.handoffDigest ||
    receipt.workerExecutionID !== handoff.workerExecutionID || receipt.bindingDigest !== handoff.bindingDigest ||
    receipt.claimedProofDigest !== handoff.claimedProofDigest || receipt.pinsDigest !== handoff.pinsDigest || receipt.deliveryID !== deliveryID ||
    JSON.stringify(receipt.worktreeTarget) !== JSON.stringify(handoff.worktreeTarget)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "consume receipt does not match the exact one-use handoff" })
  }
  return receipt
})

/**
 * Persist prompt quiescence after promptManaged returned and the child Session
 * outcome is durable. This private HostKernel call cannot dispatch or settle work.
 */
export const completeManagedDispatch = Effect.fn("ManagedControl.completeManagedDispatch")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly handoff: ManagedDispatchHandoffV1
  readonly consumeReceipt: ManagedDispatchConsumeReceiptV1
  readonly childSession: ManagedChildSessionCompletionProjectionV1
  readonly deliveryID: string
}) {
  const operation = "complete_dispatch"
  const handoff = decodeManagedDispatchHandoff(operation, input.handoff)
  const consumed = input.consumeReceipt
  const deliveryID = identifier(operation, input.deliveryID, "deliveryID")
  if (input.trustedPrincipal.kind !== "server_auth") {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "authorization_denied", reason: "managed prompt completion requires authenticated ServerAuth",
    }))
  }
  if (consumed.status !== "CONSUMED" || consumed.goalID !== handoff.goalID ||
    consumed.runID !== handoff.runID || consumed.taskID !== handoff.taskID ||
    consumed.parentSessionID !== handoff.parentSessionID || consumed.sessionID !== handoff.sessionID ||
    consumed.attemptID !== handoff.attemptID || consumed.handoffID !== handoff.handoffID ||
    consumed.handoffDigest !== handoff.handoffDigest || consumed.workerExecutionID !== handoff.workerExecutionID ||
    consumed.bindingDigest !== handoff.bindingDigest || consumed.claimedProofDigest !== handoff.claimedProofDigest ||
    consumed.pinsDigest !== handoff.pinsDigest || consumed.ownerEpoch !== handoff.ownerEpoch ||
    consumed.processIncarnation !== handoff.processIncarnation) {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "managed_protocol", reason: "consume receipt differs from the exact child handoff",
    }))
  }
  const childSessionSequence = canonicalDecimalU64(operation, input.childSession.childSessionSequence, "childSessionSequence")
  if (childSessionSequence < 1n) {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "managed_protocol", reason: "child Session projection has no durable acknowledged cursor",
    }))
  }
  const childSessionEventDigest = digestValue(operation, input.childSession.childSessionEventDigest, "childSessionEventDigest")
  const childSessionStateDigest = digestValue(operation, input.childSession.childSessionStateDigest, "childSessionStateDigest")
  if (!childSessionEventDigest.startsWith("blake3:") || !childSessionStateDigest.startsWith("blake3:")) {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "managed_protocol", reason: "child Session completion digests must use BLAKE3",
    }))
  }
  const childSessionOutputDigest = digestValue(operation, input.childSession.childSessionOutputDigest, "childSessionOutputDigest")
  const childSessionOutcomeKind = input.childSession.childSessionOutcomeKind
  if (!["assistant_completed", "assistant_error", "tool_error"].includes(childSessionOutcomeKind)) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "child Session outcome kind is invalid" }))
  }
  if (!Number.isSafeInteger(input.childSession.childSessionOutputBytes) || input.childSession.childSessionOutputBytes < 0 || input.childSession.childSessionOutputBytes > MAX_MANAGED_CHILD_OUTPUT_BYTES) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "child Session output byte count is invalid" }))
  }
  const response = yield* call(operation, {
    goalID: handoff.goalID,
    runID: handoff.runID,
    taskID: handoff.taskID,
    parentSessionID: handoff.parentSessionID,
    sessionID: handoff.sessionID,
    attemptID: handoff.attemptID,
    handoffID: handoff.handoffID,
    handoffDigest: handoff.handoffDigest,
    consumeDeliveryID: consumed.deliveryID,
    consumeReceiptDigest: consumed.receiptDigest,
    childSessionSequence: childSessionSequence.toString(),
    childSessionEventDigest,
    childSessionStateDigest,
    childSessionOutputDigest,
    childSessionOutputBytes: String(input.childSession.childSessionOutputBytes),
    childSessionOutcomeKind,
  }, deliveryID, input.trustedPrincipal)
  const receipt = yield* decode(operation, response, decodeManagedDispatchQuiescedReceipt)
  if (receipt.goalID !== handoff.goalID || receipt.runID !== handoff.runID || receipt.taskID !== handoff.taskID ||
    receipt.parentSessionID !== handoff.parentSessionID || receipt.sessionID !== handoff.sessionID ||
    receipt.attemptID !== handoff.attemptID || receipt.handoffID !== handoff.handoffID ||
    receipt.handoffDigest !== handoff.handoffDigest || receipt.consumeDeliveryID !== consumed.deliveryID ||
    receipt.consumeReceiptDigest !== consumed.receiptDigest || receipt.ownerEpoch !== handoff.ownerEpoch ||
    receipt.processIncarnation !== handoff.processIncarnation || receipt.childSessionSequence !== childSessionSequence.toString() ||
    receipt.childSessionEventDigest !== childSessionEventDigest || receipt.childSessionStateDigest !== childSessionStateDigest ||
    receipt.childSessionOutputDigest !== childSessionOutputDigest || receipt.childSessionOutputBytes !== input.childSession.childSessionOutputBytes ||
    receipt.childSessionOutcomeKind !== childSessionOutcomeKind ||
    receipt.deliveryID !== deliveryID) {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "managed_protocol", reason: "HostKernel quiescence receipt does not match the exact completed child",
    }))
  }
  return receipt
})

/** Reconcile a durable returned child after restart without reconstructing or replaying its prompt. */
export const completeRecoveredManagedDispatch = Effect.fn("ManagedControl.completeRecoveredManagedDispatch")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly consumeReceipt: ManagedDispatchConsumeReceiptV1
  readonly childSession: ManagedChildSessionCompletionProjectionV1
}) {
  const operation = "complete_dispatch"
  if (input.trustedPrincipal.kind !== "server_auth") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "authorization_denied", reason: "managed prompt recovery requires authenticated ServerAuth" }))
  }
  const consumed = input.consumeReceipt
  if (consumed.status !== "CONSUMED") {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "recovery receipt does not identify the child completion" }))
  }
  const deliveryID = managedCompletionDeliveryID(consumed.attemptID, consumed.handoffDigest, consumed.receiptDigest)
  const sequence = canonicalDecimalU64(operation, input.childSession.childSessionSequence, "childSessionSequence")
  if (sequence < 1n || !/^blake3:[0-9a-f]{64}$/.test(input.childSession.childSessionEventDigest) ||
    !/^blake3:[0-9a-f]{64}$/.test(input.childSession.childSessionStateDigest) ||
    !/^(sha256|blake3):[0-9a-f]{64}$/.test(input.childSession.childSessionOutputDigest) ||
    !Number.isSafeInteger(input.childSession.childSessionOutputBytes) || input.childSession.childSessionOutputBytes < 0 ||
    input.childSession.childSessionOutputBytes > MAX_MANAGED_CHILD_OUTPUT_BYTES ||
    !["assistant_completed", "assistant_error", "tool_error"].includes(input.childSession.childSessionOutcomeKind)) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "recovered child Session completion projection is invalid or over its bound" }))
  }
  const response = yield* call(operation, {
    goalID: consumed.goalID,
    runID: consumed.runID,
    taskID: consumed.taskID,
    parentSessionID: consumed.parentSessionID,
    sessionID: consumed.sessionID,
    attemptID: consumed.attemptID,
    handoffID: consumed.handoffID,
    handoffDigest: consumed.handoffDigest,
    consumeDeliveryID: consumed.deliveryID,
    consumeReceiptDigest: consumed.receiptDigest,
    childSessionSequence: sequence.toString(),
    childSessionEventDigest: input.childSession.childSessionEventDigest,
    childSessionStateDigest: input.childSession.childSessionStateDigest,
    childSessionOutputDigest: input.childSession.childSessionOutputDigest,
    childSessionOutputBytes: String(input.childSession.childSessionOutputBytes),
    childSessionOutcomeKind: input.childSession.childSessionOutcomeKind,
  }, deliveryID, input.trustedPrincipal)
  const receipt = yield* decode(operation, response, decodeManagedDispatchQuiescedReceipt)
  if (receipt.goalID !== consumed.goalID || receipt.runID !== consumed.runID || receipt.taskID !== consumed.taskID ||
    receipt.parentSessionID !== consumed.parentSessionID || receipt.sessionID !== consumed.sessionID ||
    receipt.attemptID !== consumed.attemptID || receipt.handoffID !== consumed.handoffID ||
    receipt.handoffDigest !== consumed.handoffDigest || receipt.consumeDeliveryID !== consumed.deliveryID ||
    receipt.consumeReceiptDigest !== consumed.receiptDigest || receipt.ownerEpoch !== consumed.ownerEpoch ||
    receipt.processIncarnation !== consumed.processIncarnation || receipt.childSessionSequence !== sequence.toString() ||
    receipt.childSessionEventDigest !== input.childSession.childSessionEventDigest ||
    receipt.childSessionStateDigest !== input.childSession.childSessionStateDigest ||
    receipt.childSessionOutputDigest !== input.childSession.childSessionOutputDigest ||
    receipt.childSessionOutputBytes !== input.childSession.childSessionOutputBytes ||
    receipt.childSessionOutcomeKind !== input.childSession.childSessionOutcomeKind || receipt.deliveryID !== deliveryID) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel recovery receipt differs from the exact consumed child" }))
  }
  return receipt
})

function decodeManagedDispatchQuiescedReceipt(
  operation: string,
  response: Record<string, unknown>,
): ManagedDispatchQuiescedReceiptV1 {
  requireStatus(operation, response, "QUIESCED")
  const stringFields = [
    "goalID", "runID", "taskID", "parentSessionID", "sessionID", "attemptID", "handoffID", "handoffDigest",
    "consumeDeliveryID", "consumeReceiptDigest", "ownerEpoch", "processIncarnation", "childSessionSequence",
    "childSessionEventDigest", "childSessionStateDigest", "childSessionOutputDigest", "deliveryID", "managedRevision", "ownerLogID",
    "ownerLogSequence", "ownerLogEventDigest", "receiptDigest",
  ] as const
  const expectedKeys = [...stringFields, "childSessionOutputBytes", "childSessionOutcomeKind", "status"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "quiescence receipt has an invalid shape" })
  }
  for (const key of ["ownerEpoch", "childSessionSequence", "managedRevision", "ownerLogSequence"] as const) {
    requiredDecimalU64(operation, response, key)
  }
  const outputBytes = requiredDecimalU64(operation, response, "childSessionOutputBytes")
  const numericOutputBytes = Number(outputBytes)
  if (!Number.isSafeInteger(numericOutputBytes) || numericOutputBytes > MAX_MANAGED_CHILD_OUTPUT_BYTES) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "quiescence output byte count exceeds its bound" })
  const outcomeKind = requiredText(operation, response, "childSessionOutcomeKind", 64)
  if (!["assistant_completed", "assistant_error", "tool_error"].includes(outcomeKind)) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "quiescence outcome kind is invalid" })
  for (const key of ["handoffDigest", "consumeReceiptDigest", "childSessionEventDigest", "childSessionStateDigest", "childSessionOutputDigest", "ownerLogEventDigest", "receiptDigest"] as const) {
    const digest = digestValue(operation, requiredText(operation, response, key, 256), key)
    if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
  }
  for (const key of ["goalID", "runID", "taskID", "parentSessionID", "sessionID", "attemptID", "handoffID", "consumeDeliveryID", "processIncarnation", "deliveryID", "ownerLogID"] as const) {
    identifier(operation, requiredText(operation, response, key, 256), key)
  }
  return {
    ...Object.fromEntries(stringFields.map((key) => [key, requiredText(operation, response, key, 256)])),
    childSessionOutputBytes: numericOutputBytes,
    childSessionOutcomeKind: outcomeKind,
    status: "QUIESCED",
  } as unknown as ManagedDispatchQuiescedReceiptV1
}

/** Ask Rust for one bounded DAG-ready candidate at an exact observed OwnerLog revision. */
export const nextSchedulableTask = Effect.fn("ManagedControl.nextSchedulableTask")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly locationID: string
  readonly sessionID: string
  readonly expectedRevision: string
}) {
  const operation = "next_schedulable_task"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const locationID = identifier(operation, input.locationID, "locationID")
  const sessionID = identifier(operation, input.sessionID, "sessionID")
  const expectedRevision = input.expectedRevision
  canonicalDecimalU64(operation, expectedRevision, "expectedRevision")
  const response = yield* call(operation, { goalID, runID, locationID, sessionID, expectedRevision }, undefined, trustedPrincipal)
  const result = yield* decode(operation, response, decodeManagedReadyTaskSelection)
  if (result.goalID !== goalID || result.runID !== runID || result.locationID !== locationID || result.sessionID !== sessionID || result.revision !== expectedRevision) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "Rust scheduler returned a stale or mismatched selection" })
  }
  return result
})

function* trustedManagedProfileDefinition(operation: string, profileIDRaw: string, revisionRaw: string) {
  const profileID = identifier(operation, profileIDRaw, "profileID")
  const profileRevision = canonicalDecimalU64(operation, revisionRaw, "profileRevision")
  if (profileRevision < 1n || profileRevision > BigInt(Number.MAX_SAFE_INTEGER)) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: "profile revision is outside the trusted Core Config range" })
  }
  const profiles = yield* AgentProfileService
  const configured = yield* Effect.mapError(
    profiles.agentProfile(profileID, profileRevision.toString()),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(configured),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "trusted AgentProfileV2 definition is invalid" }),
  })
  if (profileDefinition.profileId !== profileID || String(profileDefinition.revision) !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "trusted Config returned a different AgentProfileV2 revision" })
  }
  return profileDefinition
}

/** Stage A reserves the exact Rust-selected candidate before Core compiles its prompt. */
export const reserveManagedPreAdmissionTarget = Effect.fn("ManagedControl.reserveManagedPreAdmissionTarget")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly selection: ManagedReadyTaskSelectionV1
}) {
  const operation = "managed.pre_admission_target.reserve"
  const principal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const selection = input.selection
  const task = selection.task
  if (selection.status !== "READY_TASK" || !task || selection.runPhase !== "RUNNING") {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "pre-admission reservation requires the exact Rust READY_TASK selection" })
  }
  const profileDefinition = yield* trustedManagedProfileDefinition(operation, task.profile.profileID, task.profile.revision)
  if (profileDefinition.profileId !== task.profile.profileID || String(profileDefinition.revision) !== task.profile.revision) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "READY_TASK profile pin differs from the trusted Core Config revision" })
  }
  const sessionID = identifier(operation, managedTaskSessionID(task.candidateAttemptID), "sessionID")
  const response = yield* call(operation, {
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    expectedRevision: selection.revision,
    parentSessionID: selection.sessionID,
    locationID: selection.locationID,
    sessionID,
    profileDefinition,
  }, undefined, principal)
  const reservation = yield* decode(operation, response, (name, value) => decodeManagedPreAdmissionReservation(name, value, {
    status: "RESERVED_CONTEXT_BOUND_OR_UNBOUND",
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    candidateAttemptID: task.candidateAttemptID,
    workspaceRef: selection.workspaceRef,
    locationID: selection.locationID,
  }))
  if (reservation.taskRevision !== task.taskRevision ||
    !reservation.preAdmissionTarget.canonicalRoot ||
    reservation.preAdmissionTarget.workspaceRef !== selection.workspaceRef) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "reserved target no longer matches the exact READY_TASK revision and workspace" })
  }
  return reservation
})

/** Stage B binds Core's exact no-dispatch prompt selection to Stage A's same reservation. */
export const bindManagedPreAdmissionContext = Effect.fn("ManagedControl.bindManagedPreAdmissionContext")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly selection: ManagedReadyTaskSelectionV1
  readonly reservation: ManagedPreAdmissionReservationV1
  readonly contextSelection: ContextSelection
}) {
  const operation = "managed.pre_admission_target.bind_context"
  const principal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const selection = input.selection
  const task = selection.task
  const reservation = input.reservation
  if (!task || selection.status !== "READY_TASK" ||
    !("proofDigest" in reservation.preAdmissionProof) ||
    reservation.goalID !== selection.goalID || reservation.runID !== selection.runID || reservation.taskID !== task.taskID ||
    reservation.candidateAttemptID !== task.candidateAttemptID || reservation.taskRevision !== task.taskRevision ||
    reservation.preAdmissionTarget.workspaceRef !== selection.workspaceRef ||
    reservation.preAdmissionTarget.locationID !== selection.locationID) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "Stage B does not reference the exact reserved READY_TASK candidate" })
  }
  const contextSelection = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(input.contextSelection),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "pre-admission ContextSelectionV1 is invalid" }),
  })
  const sessionID = identifier(operation, managedTaskSessionID(task.candidateAttemptID), "sessionID")
  if (contextSelection.sessionID !== sessionID || contextSelection.attemptID !== task.candidateAttemptID ||
    contextSelection.requestID !== `req_managed_${task.candidateAttemptID}_1` || contextSelection.requestSequence !== "1") {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "Stage B requires the exact candidate child Session and first request selection" })
  }
  const profileDefinition = yield* trustedManagedProfileDefinition(operation, task.profile.profileID, task.profile.revision)
  const response = yield* call(operation, {
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    expectedRevision: selection.revision,
    parentSessionID: selection.sessionID,
    locationID: selection.locationID,
    sessionID,
    profileDefinition,
    candidateAttemptID: task.candidateAttemptID,
    preAdmissionProofDigest: reservation.preAdmissionProof.proofDigest,
    contextSelection,
  }, undefined, principal)
  const bound = yield* decode(operation, response, (name, value) => decodeManagedPreAdmissionReservation(name, value, {
    status: "RESERVED_CONTEXT_BOUND",
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    candidateAttemptID: task.candidateAttemptID,
    workspaceRef: selection.workspaceRef,
    locationID: selection.locationID,
    contextSelection,
  }))
  if (bound.taskRevision !== reservation.taskRevision ||
    JSON.stringify(bound.preAdmissionTarget) !== JSON.stringify(reservation.preAdmissionTarget) ||
    bound.preAdmissionProof.pinsDigest !== reservation.preAdmissionProof.pinsDigest ||
    !("receiptDigest" in bound.preAdmissionProof) ||
    bound.preAdmissionProof.proofDigest !== reservation.preAdmissionProof.proofDigest ||
    bound.preAdmissionProof.ticketID !== reservation.preAdmissionProof.ticketID ||
    bound.preAdmissionProof.workerExecutionID !== reservation.preAdmissionProof.workerExecutionID ||
    bound.preAdmissionProof.ownerEpoch !== reservation.preAdmissionProof.ownerEpoch) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "Stage B changed the original P8 reservation identity or target" })
  }
  if (reservation.status === "RESERVED_CONTEXT_BOUND" &&
    (reservation.contextSelectionDigest !== bound.contextSelectionDigest ||
      !("receiptDigest" in reservation.preAdmissionProof) ||
      reservation.preAdmissionProof.receiptDigest !== bound.preAdmissionProof.receiptDigest)) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "Stage-B replay changed the persisted ContextSelection or immutable bound receipt" })
  }
  return bound
})

/** Read-only restart reconciliation for the one Rust-selected active child. */
export const activeAttemptRecovery = Effect.fn("ManagedControl.activeAttemptRecovery")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly locationID: string
  readonly sessionID: string
  readonly expectedRevision: string
}) {
  const operation = "active_attempt_recovery"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const locationID = identifier(operation, input.locationID, "locationID")
  const sessionID = identifier(operation, input.sessionID, "sessionID")
  canonicalDecimalU64(operation, input.expectedRevision, "expectedRevision")
  const response = yield* call(operation, {
    goalID,
    runID,
    locationID,
    sessionID,
    expectedRevision: input.expectedRevision,
  }, undefined, trustedPrincipal)
  const result = yield* decode(operation, response, decodeManagedActiveAttemptRecovery)
  if (result.goalID !== goalID || result.runID !== runID || result.locationID !== locationID ||
    result.sessionID !== sessionID || result.revision !== input.expectedRevision) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "Rust recovery projection is stale or belongs to another root" })
  }
  if (result.status === "ACTIVE_ATTEMPT" && (!result.task || !result.attempt)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "ACTIVE_ATTEMPT omitted its immutable Task or Attempt projection" })
  }
  return result
})

function managedAttemptScopeValue(operation: string, scope: ManagedAttemptScopeV1) {
  return managedAttemptScopeValueWithExhaustion(operation, scope)
}

function managedAttemptUsageScopeValue(operation: string, scope: ManagedAttemptUsageScopeV1) {
  return managedAttemptScopeValueWithExhaustion(operation, scope)
}

function managedAttemptScopeValueWithExhaustion(
  operation: string,
  scope: ManagedAttemptScopeV1 | ManagedAttemptUsageScopeV1,
) {
  const keys = [
    "goalID",
    "runID",
    "taskID",
    "attemptID",
    "ownerEpoch",
    "expectedManagedRevision",
    "requestSequence",
    "requestID",
    "contextSelectionDigest",
    "locationID",
    "sessionID",
    "workspaceRevision",
    "effectiveMaxTokens",
    "remainingTokens",
    "delegationBindingDigest",
    "permissionScopeDigest",
    "worktreeTarget",
  ]
  if (
    typeof scope !== "object" ||
    scope === null ||
    Array.isArray(scope) ||
    Object.keys(scope).toSorted().join("\0") !== keys.toSorted().join("\0")
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope has an invalid shape" })
  }
  const counter = (name: string, value: string) => {
    return canonicalDecimalU64(operation, value, name).toString()
  }
  const effectiveMaxTokens = counter("effectiveMaxTokens", scope.effectiveMaxTokens)
  const remainingTokens = counter("remainingTokens", scope.remainingTokens)
  if (BigInt(effectiveMaxTokens) === 0n || BigInt(remainingTokens) > BigInt(effectiveMaxTokens)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt token ceiling is absent or inconsistent" })
  }
  const worktreeTarget = decodeManagedWorktreeTarget(operation, scope.worktreeTarget)
  const requestSequence = counter("requestSequence", scope.requestSequence)
  if (BigInt(requestSequence) < 1n || BigInt(requestSequence) > 1024n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "requestSequence is outside the managed context bound" })
  }
  if (worktreeTarget.locationID !== scope.locationID) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope worktree differs from its registered Location" })
  }
  return {
    goalID: identifier(operation, scope.goalID, "goalID"),
    runID: identifier(operation, scope.runID, "runID"),
    taskID: identifier(operation, scope.taskID, "taskID"),
    attemptID: identifier(operation, scope.attemptID, "attemptID"),
    ownerEpoch: counter("ownerEpoch", scope.ownerEpoch),
    expectedManagedRevision: counter("expectedManagedRevision", scope.expectedManagedRevision),
    requestSequence: requestSequence.toString(),
    requestID: identifier(operation, scope.requestID, "requestID"),
    contextSelectionDigest: decodeBlake3Digest(operation, scope.contextSelectionDigest, "contextSelectionDigest"),
    locationID: identifier(operation, scope.locationID, "locationID"),
    sessionID: identifier(operation, scope.sessionID, "sessionID"),
    workspaceRevision: decodeBlake3Digest(operation, scope.workspaceRevision, "workspaceRevision"),
    effectiveMaxTokens,
    remainingTokens,
    delegationBindingDigest: digestValue(operation, scope.delegationBindingDigest, "delegationBindingDigest"),
    permissionScopeDigest: decodeBlake3Digest(operation, scope.permissionScopeDigest, "permissionScopeDigest"),
    worktreeTarget,
  }
}

export const bindAttemptEffect = Effect.fn("ManagedControl.bindAttemptEffect")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly effectID: string
}) {
  const operation = "bind_attempt_effect"
  const scope = yield* Effect.try({
    try: () => managedAttemptScopeValue(operation, input.scope),
    catch: (error) =>
      error instanceof ManagedControlError
        ? error
        : new ManagedControlError({ operation, code: "managed_protocol", reason: "managed Attempt scope is malformed" }),
  })
  const { goalID, runID, taskID, attemptID } = scope
  const response = yield* call(
    operation,
    {
      goalID,
      runID,
      taskID,
      attemptID,
      effectID: identifier(operation, input.effectID, "effectID"),
      locationID: scope.locationID,
      sessionID: scope.sessionID,
      managedAttempt: scope,
    },
    oneUseKey(attemptID, "bind"),
  )
  const decoded = yield* decode(operation, response, decodeAttemptEffectBound)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, taskID, attemptID }))
  return decoded
})

export const settleAttempt = Effect.fn("ManagedControl.settleAttempt")(function* (input: {
  readonly trustedPrincipal?: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly outcome: "succeeded" | "failed" | "unknown"
  readonly expectedRevision: ManagedRevision
  readonly failureCode?: string
  readonly retryable?: boolean
}) {
  const operation = "settle"
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  // The kernel's outcome shapes are exact: a failure names a bounded code and
  // whether it is retryable, and no other outcome may carry either field.
  if (input.outcome === "failed") {
    if (input.failureCode === undefined || input.retryable === undefined) {
      return yield* Effect.fail(
        new ManagedControlError({
          operation,
          code: "managed_protocol",
          reason: "a failed settlement requires a failure code and retryable flag",
        }),
      )
    }
  } else if (input.failureCode !== undefined || input.retryable !== undefined) {
    return yield* Effect.fail(
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: `${input.outcome} settlement cannot carry a failure code or retryable flag`,
      }),
    )
  }
  const body: Record<string, unknown> = {
    goalID,
    runID,
    taskID,
    attemptID,
    outcome: input.outcome,
    expectedRevision: expectedRevision(operation, input.expectedRevision),
  }
  if (input.outcome === "failed") {
    body.failureCode = identifier(operation, input.failureCode!, "failureCode")
    body.retryable = input.retryable
  }
  const trustedPrincipal = input.trustedPrincipal === undefined
    ? undefined
    : yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const response = yield* call(operation, body, oneUseKey(attemptID, "settle"), trustedPrincipal)
  const decoded = yield* decode(operation, response, decodeManagedAttemptSettlement)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, taskID, attemptID }))
  return decoded
})

/**
 * Settle the P8 logical-worker lease only after canonical Attempt settlement.
 * HostKernel independently requires the durable quiescence marker, terminal
 * receipt chain, live root/peer proof, and current P8 claim before releasing or
 * quarantining capacity.
 */
export const settleManagedDispatch = Effect.fn("ManagedControl.settleManagedDispatch")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly deliveryID: string
  readonly finalRevision?: string
  readonly finalInspect?: ManagedFinalInspectReceiptV1
  /** Exact HostKernel-authored ChallengeSet tuple; never reconstructed from caller input. */
  readonly verifier?: ManagedVerifierSettlementPinsV1
}) {
  const operation = "settle_dispatch"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const deliveryID = identifier(operation, input.deliveryID, "deliveryID")
  const verifier = input.verifier
  if (verifier && (!authenticatedVerifierSettlementPins.has(verifier) || verifier.goalID !== goalID || verifier.runID !== runID || verifier.taskID !== taskID || verifier.attemptID !== attemptID ||
      (input.finalRevision !== undefined && verifier.finalRevision !== input.finalRevision))) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement verifier pins do not identify the exact managed child and final revision" })
  }
  if (verifier === undefined && (input.finalRevision !== undefined || input.finalInspect !== undefined)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "non-success quarantine cannot carry verified revision or Inspect authority" })
  }
  const response = yield* call(operation, {
    goalID, runID, taskID, attemptID,
    ...(verifier === undefined ? {} : {
      schemaVersion: verifier.schemaVersion,
      ownerEpoch: verifier.ownerEpoch,
      specID: verifier.specID,
      specDigest: verifier.specDigest,
      profileID: verifier.profileID,
      profileRevision: verifier.profileRevision,
      profileDigest: verifier.profileDigest,
      finalRevision: verifier.finalRevision,
      evidencePlanDigest: verifier.evidencePlanDigest,
      verificationRunID: verifier.verificationRunID,
      setIdentityDigest: verifier.setIdentityDigest,
      challengeSetDigest: verifier.challengeSetDigest,
    }),
  }, deliveryID, trustedPrincipal)
  const receipt = yield* decode(operation, response, (name, value) => decodeManagedDispatchSettlementReceipt(name, value, {
    goalID, runID, taskID, attemptID,
    ...(verifier === undefined ? {} : { verifier }),
    ...(input.finalRevision === undefined ? {} : { finalRevision: input.finalRevision }),
    ...(input.finalInspect === undefined ? {} : { finalInspect: input.finalInspect }),
  }))
  if (receipt.goalID !== goalID || receipt.runID !== runID || receipt.taskID !== taskID || receipt.attemptID !== attemptID) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 settlement receipt identifies another managed child" })
  }
  return receipt
})

const phaseChange = (
  operation: "pause_run" | "resume_run",
  expected: { readonly status: "PAUSED" | "RUNNING"; readonly runPhase: ManagedRunPhase },
  input: { readonly trustedPrincipal: TrustedPrincipal; readonly goalID: string; readonly runID: string; readonly expectedRevision: ManagedRevision },
) =>
  Effect.gen(function* () {
    const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
    // Validation throws stay typed failures: a caller must observe a
    // managed_protocol refusal through the error channel, never a defect.
    const goalID = yield* Effect.try({
      try: () => identifier(operation, input.goalID, "goalID"),
      catch: (error) => error as ManagedControlError,
    })
    const runID = yield* Effect.try({
      try: () => identifier(operation, input.runID, "runID"),
      catch: (error) => error as ManagedControlError,
    })
    const revision = yield* Effect.try({
      try: () => expectedRevision(operation, input.expectedRevision),
      catch: (error) => error as ManagedControlError,
    })
    const response = yield* call(
      operation,
      { goalID, runID, expectedRevision: revision },
      oneUseKey(runID, operation === "pause_run" ? "pause" : "resume", revision.toString()),
      trustedPrincipal,
    )
    const decoded = yield* decode(operation, response, (name, value) => decodeRunPhaseChange(name, value, expected))
    yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID }))
    return decoded
  })

export const pauseRun = Effect.fn("ManagedControl.pauseRun")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* phaseChange("pause_run", { status: "PAUSED", runPhase: "PAUSED" }, input)
})

export const resumeRun = Effect.fn("ManagedControl.resumeRun")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* phaseChange("resume_run", { status: "RUNNING", runPhase: "RUNNING" }, input)
})

export const cancelRun = Effect.fn("ManagedControl.cancelRun")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  const operation = "cancel"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const revision = expectedRevision(operation, input.expectedRevision)
  const response = yield* call(
    operation,
    { goalID, runID, expectedRevision: revision },
    oneUseKey(runID, "cancel", revision.toString()),
    trustedPrincipal,
  )
  const status = response.status
  if (status !== "CANCELLED" && status !== "CANCELLING") {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "cancellation status is invalid" }),
    )
  }
  const decoded = yield* decode(operation, response, (name, value) =>
    decodeRunPhaseChange(name, value, { status, runPhase: status }),
  )
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID }))
  return decoded
})

const beginVerification = Effect.fn("ManagedControl.beginVerification")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly deliveryID: string
}) {
  const operation = "begin_verification"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const response = yield* call(operation, { goalID, runID }, oneUseKey(runID, "verify", input.deliveryID), trustedPrincipal)
  const decoded = yield* decode(operation, response, decodeVerificationStarted)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID }))
  return decoded
})

/**
 * Runs the complete user-approved verifier lifecycle. Guard decisions are gathered
 * in bounded TUI windows, resolved as one exact set, and executed by the HostKernel
 * aggregate operation. Lease digests never leave this trusted Core process.
 */
export const runVerification = Effect.fn("ManagedControl.runVerification")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly sessionID?: string
}) {
  const operation = "begin_verification"
  const authenticated = yield* TrustedPrincipalContext
  const trustedPrincipal = yield* serverAuthPrincipal(operation, authenticated.principal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  // A terminal Attempt may have been durably committed just before Core lost
  // the P8 release response. Recover from Rust's authenticated terminal snapshot
  // first; only the existing P8 settlement operation can release the worker.
  const recoveryOperation = "settlement_recovery"
  const recoveryResponse = yield* call(recoveryOperation, { goalID, runID }, undefined, trustedPrincipal)
  const recovered = yield* decode(recoveryOperation, recoveryResponse, (name, value) =>
    decodeManagedSettlementRecovery(name, value, { goalID, runID }),
  )
  if (recovered.status === "SETTLEMENT_PENDING") {
    // SettleAttempt and FinalizeRun are separate durable owner transitions. A
    // crash between them leaves a verified terminal Attempt on a still
    // VERIFYING Run; replay only the exact authenticated finalizer before P8
    // settlement. Never retry the verifier or a consumed effect in this path.
    let finalizedManagedRevision = recovered.managedRevision
    const verifier = recovered.verification
    const current = yield* goalReviewSnapshot(goalID, trustedPrincipal)
    if (!current.acceptedSpecs.some((spec) => spec.specID === verifier.specID && spec.specDigest === verifier.specDigest) ||
        !current.runs.some((run) => run.runID === runID && run.specID === verifier.specID)) {
      return yield* new ManagedControlError({ operation: recoveryOperation, code: "managed_protocol", reason: "recovered verifier pins no longer match the live accepted SpecVersion and Run" })
    }
    if (recovered.runPhase === "VERIFYING") {
      const finalized = yield* finalizeRun({ trustedPrincipal, goalID, runID })
      if (finalized.runPhase !== "SUCCEEDED") {
        return yield* new ManagedControlError({ operation: "finalize_run", code: "managed_protocol", reason: "verified terminal Attempt did not finalize its Run" })
      }
      finalizedManagedRevision = finalized.revision
    }
    const dispatchSettlement = yield* settleManagedDispatch({
      trustedPrincipal,
      goalID,
      runID,
      taskID: verifier.taskID,
      attemptID: verifier.attemptID,
      deliveryID: `managed_settle_${verifier.attemptID}`,
      finalRevision: recovered.finalRevision,
      verifier,
    })
    if (dispatchSettlement.status !== "SETTLED") {
      return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "verified terminal recovery received a non-success P8 quarantine receipt" })
    }
    // A successful exact-revision Attempt may settle while its worktree remains
    // DIRTY_OWNED. P8's WORKTREE_QUARANTINED disposition is terminal evidence
    // that capacity was retained safely; it must never be treated as reusable.
    return {
      status: "SUCCEEDED",
      goalID,
      runID,
      taskID: verifier.taskID,
      attemptID: verifier.attemptID,
      finalRevision: recovered.finalRevision,
      sourceRevision: recovered.finalRevision,
      evidenceDigest: recovered.evidenceDigest,
      usageAccounting: recovered.usageAccounting,
      recoveredArtifactRefs: recovered.recoveredArtifactRefs,
      verificationRunID: verifier.verificationRunID,
      setIdentityDigest: verifier.setIdentityDigest,
      challengeSetDigest: verifier.challengeSetDigest,
      revision: finalizedManagedRevision,
      dispatchSettlement,
    }
  }
  // A fresh user lifecycle gets a distinct delivery key so a terminal aborted
  // challenge set does not block a later deliberate retry. Keep this UUID stable
  // for every begin request made during this lifecycle.
  const deliveryID = randomUUID()
  const started = yield* beginVerification({ trustedPrincipal, goalID, runID, deliveryID })
  const current = yield* goalReviewSnapshot(goalID, trustedPrincipal)
  if (!current.acceptedSpecs.some((spec) => spec.specID === started.specID && spec.specDigest === started.specDigest) ||
      !current.runs.some((run) => run.runID === runID && run.specID === started.specID)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel verifier pins do not match the live accepted SpecVersion and Run" })
  }
  if (started.status === "UNKNOWN") {
    return {
      status: "UNKNOWN" as const,
      goalID,
      runID,
      taskID: started.taskID,
      attemptID: started.attemptID,
      finalRevision: started.finalRevision,
      sourceRevision: started.sourceRevision,
      verificationRunID: started.verificationRunID,
      setIdentityDigest: started.setIdentityDigest,
      challengeSetDigest: started.challengeSetDigest,
      reason: started.reason,
      revision: started.revision,
    }
  }
  const supervisor = yield* SessionSupervisor.Service
  const challenges: ManagedVerifierGuardChallengeV1[] = started.challenges.map(({ criterionID: _criterionID, ...item }) => item)

  const resolve = (resolution: Readonly<Record<string, unknown>>) =>
    call(
      "resolve_verification_approvals",
      {
        goalID,
        runID,
        verificationRunID: started.verificationRunID,
        setIdentityDigest: started.setIdentityDigest,
        challengeSetDigest: started.challengeSetDigest,
        resolution,
      },
      oneUseKey(started.verificationRunID, "resolve"),
      trustedPrincipal,
    )

  const abort = (reason: VerificationAbortReason, decisions: ReadonlyArray<{ challengeID: string; decision: "allow_once" | "deny" }>) =>
    Effect.gen(function* () {
      const response = yield* resolve({ kind: "abort", reason, decisions })
      const decoded = yield* decode(operation, response, (name, value) =>
        decodeVerificationApprovalResolution(name, value, started),
      )
      if (decoded.status !== "ABORTED" || decoded.reason !== reason) {
        return yield* Effect.fail(
          new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel did not persist verifier abort" }),
        )
      }
      return {
        status: "ABORTED" as const,
        goalID,
        runID,
        taskID: started.taskID,
        attemptID: started.attemptID,
        finalRevision: started.finalRevision,
        verificationRunID: started.verificationRunID,
        setIdentityDigest: started.setIdentityDigest,
        challengeSetDigest: started.challengeSetDigest,
        reason,
        revision: decoded.revision,
      }
    })

  if (started.status === "NEEDS_APPROVAL") {
  const collection: ManagedVerifierApprovalCollectionV1 = yield* supervisor
    .awaitManagedVerifierApprovals({
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make(started.approvalLocation.canonicalRoot),
        workspaceID: WorkspaceV2.ID.make(started.approvalLocation.workspaceID),
      }),
      ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
      challenges,
    })
    .pipe(
      Effect.catchTag("SessionSupervisorError", (error) =>
        Effect.gen(function* () {
          yield* abort("transport_lost", [])
          return yield* Effect.fail(
            new ManagedControlError({
              operation,
              code: error.hostCode ?? "managed_unavailable",
              reason: error.reason,
            }),
          )
        }),
      ),
      Effect.onInterrupt(() => abort("cancelled", []).pipe(Effect.ignore)),
    )

  const decisions = collection.decisions
  const challengeIDs = new Set(started.challenges.map((challenge) => challenge.challengeID))
  const decisionCounts = new Map<string, number>()
  for (const item of decisions) {
    decisionCounts.set(item.challengeID, (decisionCounts.get(item.challengeID) ?? 0) + 1)
  }
  const actualDecisions = decisions
    .filter(
      (item) =>
        challengeIDs.has(item.challengeID) &&
        decisionCounts.get(item.challengeID) === 1 &&
        (item.decision === "allow_once" || item.decision === "deny"),
    )
    .map(({ challengeID, decision }) => ({ challengeID, decision }))
  const malformedDecisions = actualDecisions.length !== decisions.length
  if (malformedDecisions) {
    // A broken bridge result is not a reviewer choice. Preserve only unique,
    // in-set responses, and close the full host group with a system transport fence.
    return yield* abort("transport_lost", actualDecisions)
  }
  if (collection.kind === "abort") {
    // The supervisor preserves only actual decisions and tags the reason that
    // ended collection. Persist that exact partial set; never manufacture votes.
    const hasActualDenial = actualDecisions.some((item) => item.decision === "deny")
    const abortReason = hasActualDenial
      ? "reviewer_denied"
      : collection.reason === "reviewer_denied"
        ? "transport_lost"
        : collection.reason
    return yield* abort(abortReason, actualDecisions)
  }
  if (actualDecisions.some((item) => item.decision === "deny")) {
    return yield* abort("reviewer_denied", actualDecisions)
  }
  if (actualDecisions.length !== started.challenges.length) {
    return yield* abort("transport_lost", actualDecisions)
  }

  const decisionsByID = new Map(actualDecisions.map((item) => [item.challengeID, item]))
  const exactDecisions = started.challenges.map((challenge) => decisionsByID.get(challenge.challengeID)!)
  const resolvedResponse = yield* resolve({ kind: "decisions", decisions: exactDecisions })
  const resolved = yield* decode(operation, resolvedResponse, (name, value) =>
    decodeVerificationApprovalResolution(name, value, started),
  )
  if (resolved.status === "ABORTED") {
    return {
      status: "ABORTED" as const,
      goalID,
      runID,
      taskID: started.taskID,
      attemptID: started.attemptID,
      finalRevision: started.finalRevision,
      verificationRunID: started.verificationRunID,
      setIdentityDigest: started.setIdentityDigest,
      challengeSetDigest: started.challengeSetDigest,
      reason: resolved.reason,
      revision: resolved.revision,
    }
  }
  }

  const executeOperation = "execute_verification"
  let result: VerificationRunResult
  if (started.status === "SETTLING") {
    if (!started.sourceRevision || !started.evidenceDigest || !started.artifactRefs?.length || !started.settlementCandidate) {
      return yield* new ManagedControlError({ operation: "begin_verification", code: "managed_protocol", reason: "SETTLING recovery omitted durable evidence pins" })
    }
    result = {
      status: "SETTLING",
      goalID,
      runID,
      taskID: started.taskID,
      attemptID: started.attemptID,
      finalRevision: started.finalRevision,
      sourceRevision: started.sourceRevision,
      evidenceDigest: started.evidenceDigest,
      artifactRefs: started.artifactRefs,
      settlementCandidate: started.settlementCandidate,
      verificationRunID: started.verificationRunID,
      setIdentityDigest: started.setIdentityDigest,
      challengeSetDigest: started.challengeSetDigest,
      revision: started.revision,
    }
  } else {
    const execution = yield* call(
      executeOperation,
      { goalID, runID, verificationRunID: started.verificationRunID, challengeSetDigest: started.challengeSetDigest },
      oneUseKey(started.verificationRunID, "execute"),
      trustedPrincipal,
    )
    result = yield* decode(executeOperation, execution, decodeVerificationRunResult)
  }
  yield* decode(executeOperation, { ...result }, (name, value) =>
    expectEcho(name, value, { goalID, runID, verificationRunID: started.verificationRunID }),
  )
  if (result.taskID !== started.taskID || result.attemptID !== started.attemptID ||
    result.finalRevision !== started.finalRevision || result.verificationRunID !== started.verificationRunID ||
    result.setIdentityDigest !== started.setIdentityDigest || result.challengeSetDigest !== started.challengeSetDigest) {
    return yield* new ManagedControlError({ operation: executeOperation, code: "managed_protocol", reason: "verifier terminal result changed its authenticated Task/Attempt, challenge set or final revision" })
  }
  if (result.status === "FAILED" || result.status === "CANCELLED") {
    const dispatchSettlement = yield* settleManagedDispatch({
      trustedPrincipal,
      goalID,
      runID,
      taskID: started.taskID,
      attemptID: started.attemptID,
      deliveryID: `managed_settle_${started.attemptID}`,
    })
    const expectedReason = result.status === "FAILED" ? "FAILED_ATTEMPT" : "CANCELLED_TASK"
    if (dispatchSettlement.status !== "QUARANTINED" || dispatchSettlement.reason !== expectedReason) {
      return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "P8 did not quarantine the exact failed/cancelled managed Attempt" })
    }
    return { ...result, setIdentityDigest: started.setIdentityDigest, dispatchSettlement }
  }
  if (result.status !== "SETTLING") return { ...result, setIdentityDigest: started.setIdentityDigest }
  if (!result.sourceRevision || result.sourceRevision !== started.finalRevision || !result.evidenceDigest || !result.artifactRefs?.length) {
    return yield* new ManagedControlError({ operation: executeOperation, code: "managed_protocol", reason: "successful verification has no durable evidence bound to the pinned final revision" })
  }
  if (started.status === "NEEDS_APPROVAL") {
    const expectedCriteria = started.challenges.map((challenge) => challenge.criterionID).toSorted()
    const observedCriteria = result.artifactRefs.map((item) => item.criterionID).toSorted()
    if (expectedCriteria.length !== observedCriteria.length || expectedCriteria.some((criterionID, index) => criterionID !== observedCriteria[index])) {
      return yield* new ManagedControlError({ operation: executeOperation, code: "managed_protocol", reason: "verifier evidence does not cover the exact approved criterion set" })
    }
  }
  const candidate = result.settlementCandidate
  if (!candidate || candidate.managedRevision !== result.revision ||
      candidate.goalID !== goalID || candidate.runID !== runID || candidate.taskID !== result.taskID || candidate.attemptID !== result.attemptID) {
    return yield* new ManagedControlError({ operation: executeOperation, code: "managed_protocol", reason: "verification did not provide the exact current settlement candidate" })
  }
  const inspectPrepared = yield* call(
    "prepare_final_inspect",
    { goalID, runID, taskID: result.taskID, attemptID: result.attemptID },
    oneUseKey(result.attemptID, "final_inspect_prepare"),
    trustedPrincipal,
  )
  const challenge = yield* decode("prepare_final_inspect", inspectPrepared, (name, value) =>
    decodeManagedRootInspectChallenge(name, value, started.approvalLocation.locationID),
  )
  const inspectLease = yield* supervisor.awaitManagedRootApproval({
    locationRef: Location.Ref.make({ directory: AbsolutePath.make(started.approvalLocation.canonicalRoot), workspaceID: WorkspaceV2.ID.make(started.approvalLocation.workspaceID) }),
    runID,
    challenge,
  })
  const inspectResponse = yield* call("execute_final_inspect", {
    goalID,
    runID,
    taskID: result.taskID,
    attemptID: result.attemptID,
    challengeID: challenge.challengeID,
    effectID: challenge.effectID,
    locationID: inspectLease.locationID,
    capabilityLeaseDigest: inspectLease.capabilityLeaseDigest,
  }, oneUseKey(result.attemptID, "final_inspect_execute"), trustedPrincipal)
  const inspected = yield* decode("execute_final_inspect", inspectResponse, (name, value) =>
    decodeManagedFinalInspectReceipt(name, value, { attemptID: result.attemptID, locationID: challenge.locationID, finalRevision: started.finalRevision }),
  )
  if (!inspected.owned || !inspected.noFollow || inspected.containsUserOwnedChanges ||
      (inspected.worktreeStatus !== "CLEAN" && inspected.worktreeStatus !== "DIRTY_OWNED")) {
    return yield* new ManagedControlError({ operation: "execute_final_inspect", code: "managed_conflict", reason: "final Inspect found missing, unknown, unattributed or user-owned workspace changes; Attempt remains SETTLING" })
  }
  const settled = yield* settleAttempt({
    trustedPrincipal,
    goalID,
    runID,
    taskID: result.taskID,
    attemptID: result.attemptID,
    outcome: "succeeded",
    expectedRevision: candidate.managedRevision,
  })
  if (settled.outcome !== "SUCCEEDED" || settled.attemptID !== result.attemptID || settled.runID !== runID) {
    return yield* new ManagedControlError({ operation: "settle", code: "managed_protocol", reason: "HostKernel did not settle the inspected Attempt" })
  }
  // HostKernel's settle operation proves the exact Guarded final Inspect and
  // commits typed evidence on the same Attempt. Finalize the Run before P8
  // releases its reservation so terminal recovery has one durable success
  // boundary after a lost settlement response.
  const finalized = yield* finalizeRun({ trustedPrincipal, goalID, runID })
  if (finalized.runPhase !== "SUCCEEDED" || finalized.goalID !== goalID || finalized.runID !== runID) {
    return yield* new ManagedControlError({ operation: "finalize_run", code: "managed_protocol", reason: "HostKernel did not finalize the exact verified Run" })
  }
  const settlement = yield* settleManagedDispatch({
    trustedPrincipal,
    goalID,
    runID,
    taskID: started.taskID,
    attemptID: started.attemptID,
    deliveryID: `managed_settle_${started.attemptID}`,
    finalRevision: inspected.workspaceRevision,
    finalInspect: inspected,
    verifier: trustVerifierSettlementPins({
      schemaVersion: started.schemaVersion,
      goalID: started.goalID,
      runID: started.runID,
      taskID: started.taskID,
      attemptID: started.attemptID,
      ownerEpoch: started.ownerEpoch,
      specID: started.specID,
      specDigest: started.specDigest,
      profileID: started.profileID,
      profileRevision: started.profileRevision,
      profileDigest: started.profileDigest,
      finalRevision: started.finalRevision,
      evidencePlanDigest: started.evidencePlanDigest,
      verificationRunID: started.verificationRunID,
      setIdentityDigest: started.setIdentityDigest,
      challengeSetDigest: started.challengeSetDigest,
    }),
  })
  if (settlement.status !== "SETTLED") {
    return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "Verified Attempt was quarantined without its ChallengeSet settlement receipt" })
  }
  if (inspected.worktreeStatus === "DIRTY_OWNED" &&
      (settlement.disposition !== "WORKTREE_QUARANTINED" || settlement.worktreeDisposition.disposition !== "QUARANTINED")) {
    return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "P8 released a DIRTY_OWNED final worktree instead of quarantining it" })
  }
  if (inspected.worktreeStatus === "CLEAN" &&
      (settlement.disposition !== "RELEASED" || settlement.worktreeDisposition.disposition !== "REUSABLE")) {
    return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "P8 did not record the exact clean final worktree as reusable" })
  }
  // WORKTREE_QUARANTINED is a valid settlement for an exact DIRTY_OWNED
  // final Inspect. The successful Run remains complete; P8 retains the worker
  // and forbids reuse of that worktree until separate reconciliation.
  const { settlementCandidate: _privateCandidate, ...publicResult } = result
  return { ...publicResult, status: "SUCCEEDED", setIdentityDigest: started.setIdentityDigest, usageAccounting: candidate.usageAccounting, revision: finalized.revision, dispatchSettlement: settlement }
})

export const verifyTask = Effect.fn("ManagedControl.verifyTask")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
}) {
  const operation = "verify_task"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const response = yield* call(
    operation,
    { goalID, runID, taskID, attemptID },
    oneUseKey(attemptID, "verify_task"),
    trustedPrincipal,
  )
  const decoded = yield* decode(operation, response, decodeTaskVerified)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, taskID, attemptID }))
  return decoded
})

export const recordCriterionEvidence = Effect.fn("ManagedControl.recordCriterionEvidence")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
  readonly criterionID: string
}) {
  const operation = "record_criterion_evidence"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const criterionID = identifier(operation, input.criterionID, "criterionID")
  const response = yield* call(
    operation,
    { goalID, runID, criterionID },
    oneUseKey(runID, "evidence", criterionID),
    trustedPrincipal,
  )
  const decoded = yield* decode(operation, response, decodeCriterionEvidence)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, criterionID }))
  return decoded
})

export const finalizeRun = Effect.fn("ManagedControl.finalizeRun")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly runID: string
}) {
  const operation = "finalize_run"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const response = yield* call(operation, { goalID, runID }, oneUseKey(runID, "finalize"), trustedPrincipal)
  const decoded = yield* decode(operation, response, decodeRunFinalized)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID }))
  return decoded
})

export const hostRunDispatchKeyDigest = (dispatchKey: string): string =>
  `blake3:${bytesToHex(blake3(Buffer.from(dispatchKey, "utf8")))}`

export const hostRunInspect = Effect.fn("ManagedControl.hostRunInspect")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly dispatchKeyDigest: string
}) {
  const operation = "host_run.inspect"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const dispatchKeyDigest = digestValue(operation, input.dispatchKeyDigest, "dispatchKeyDigest")
  const response = yield* call(operation, { goalID, dispatchKeyDigest }, undefined, trustedPrincipal)
  const reconciliation = yield* decode(operation, response, (name, value) => {
    const responseDispatchKeyDigest = digestValue(
      name,
      value.dispatchKeyDigest as string,
      "dispatchKeyDigest",
    )
    if (responseDispatchKeyDigest !== dispatchKeyDigest) {
      throw new ManagedControlError({
        operation: name,
        code: "managed_protocol",
        reason: "HostRun reconciliation dispatch key identity differs from the queried key",
      })
    }
    return decodeHostRunReconciliation(name, value)
  })
  return reconciliation
})

export const hostRunBind = Effect.fn("ManagedControl.hostRunBind")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly attemptID: string
  readonly dispatchKeyDigest: string
}) {
  const operation = "host_run.bind"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const dispatchKeyDigest = digestValue(operation, input.dispatchKeyDigest, "dispatchKeyDigest")
  const response = yield* call(
    operation,
    {
      goalID,
      attemptID,
      dispatchKeyDigest,
    },
    oneUseKey(attemptID, "bind", dispatchKeyDigest),
    trustedPrincipal,
  )
  return yield* decode(operation, response, (name, value) => {
    if (value.schemaVersion !== 1) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "schemaVersion is not 1" })
    }
    const binding = decodeHostRunDispatchBinding(name, value.binding)
    const receipt = decodeHostRunDispatchBindingReceipt(name, value.receipt)
    if (
      binding.attemptId !== attemptID ||
      binding.dispatchKeyDigest !== dispatchKeyDigest ||
      receipt.dispatchKeyDigest !== dispatchKeyDigest ||
      receipt.bindingDigest !== binding.bindingDigest
    ) {
      throw new ManagedControlError({
        operation: name,
        code: "managed_protocol",
        reason: "HostRun binding identity does not match the requested Attempt/key and attached receipt",
      })
    }
    return {
      schemaVersion: 1,
      binding,
      receipt,
    } satisfies HostRunBindResultV1
  })
})

export const hostRunBindReceipt = Effect.fn("ManagedControl.hostRunBindReceipt")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly dispatchKeyDigest: string
  readonly bindingDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
}) {
  const operation = "host_run.bind_receipt"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const dispatchKeyDigest = digestValue(operation, input.dispatchKeyDigest, "dispatchKeyDigest")
  const bindingDigest = digestValue(operation, input.bindingDigest, "bindingDigest")
  const ownerLogID = identifier(operation, input.ownerLogID, "ownerLogID")
  const ownerLogSequence = requiredPositiveDecimalU64(
    operation,
    { ownerLogSequence: input.ownerLogSequence },
    "ownerLogSequence",
  )
  const ownerLogEventDigest = ownerEventDigest(operation, input.ownerLogEventDigest)
  const response = yield* call(
    operation,
    {
      goalID,
      dispatchKeyDigest,
      bindingDigest,
      ownerLogID,
      ownerLogSequence,
      ownerLogEventDigest,
    },
    oneUseKey(dispatchKeyDigest, "bind_receipt", ownerLogSequence),
    trustedPrincipal,
  )
  return yield* decode(operation, response, (name, value) => {
    if (value.schemaVersion !== 1) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "schemaVersion is not 1" })
    }
    if (value.status !== "RECORDED") {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "status is not RECORDED" })
    }
    const receipt = decodeHostRunDispatchP8OwnerReceipt(name, value.receipt)
    if (
      receipt.dispatchKeyDigest !== dispatchKeyDigest ||
      receipt.bindingDigest !== bindingDigest ||
      receipt.ownerLogID !== ownerLogID ||
      receipt.ownerLogSequence !== ownerLogSequence ||
      receipt.ownerLogEventDigest !== ownerLogEventDigest
    ) {
      throw new ManagedControlError({
        operation: name,
        code: "managed_protocol",
        reason: "HostRun P8 receipt identity does not match the submitted OwnerLog request",
      })
    }
    return {
      schemaVersion: 1,
      status: "RECORDED",
      receipt,
    } satisfies HostRunBindReceiptResultV1
  })
})

export const reconcileHostRun = Effect.fn("ManagedControl.reconcileHostRun")(function* (input: {
  readonly trustedPrincipal: TrustedPrincipal
  readonly goalID: string
  readonly dispatchKeyDigest: string
}) {
  const reconciliation = yield* hostRunInspect(input)
  if (reconciliation.status !== "UNKNOWN") {
    if (!reconciliation.binding || !reconciliation.bindingDigest) {
      return yield* new ManagedControlError({
        operation: "reconcile_host_run",
        code: "managed_protocol",
        reason: "terminal host run reconciliation is missing durable binding or digest",
      })
    }
    if (
      reconciliation.binding.dispatchKeyDigest !== reconciliation.dispatchKeyDigest ||
      reconciliation.binding.bindingDigest !== reconciliation.bindingDigest
    ) {
      return yield* new ManagedControlError({
        operation: "reconcile_host_run",
        code: "managed_protocol",
        reason: "terminal HostRun binding identity differs from its queried dispatch key or attached digest",
      })
    }
    if (
      reconciliation.status === "SUCCEEDED" &&
      (!reconciliation.attemptReceiptDigest || !reconciliation.verifiedRevision)
    ) {
      return yield* new ManagedControlError({
        operation: "reconcile_host_run",
        code: "managed_protocol",
        reason: "terminal HostRun evidence is missing its Attempt receipt or verified final revision",
      })
    }
  } else if (reconciliation.status === "UNKNOWN") {
    if (!reconciliation.unknownReason) {
      return yield* Effect.fail(
        new ManagedControlError({
          operation: "reconcile_host_run",
          code: "managed_protocol",
          reason: "unknown host run reconciliation is missing unknownReason",
        }),
      )
    }
  }
  return reconciliation
})

export const admitDirectAttempt = Effect.fn("ManagedControl.admitDirectAttempt")(function* (input: {
  readonly attemptID: string
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly agent: string
  readonly profileSelection: { readonly profileId: string; readonly revision: string }
  readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2
  readonly scopeDigest: string
  readonly locationID: string
  readonly workspaceID: string
  readonly capabilityDigest: string
  readonly permissionsDigest: string
  readonly budgetDigest: string
}) {
  const operation = "admit_direct_attempt"
  const attemptID = input.attemptID
  if (!ATTEMPT_ID.test(attemptID)) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "attemptID is invalid" }),
    )
  }
  const response = yield* call(
    operation,
    {
      attemptID,
      parentSessionID: identifier(operation, input.parentSessionID, "parentSessionID"),
      childSessionID: identifier(operation, input.childSessionID, "childSessionID"),
      agent: identifier(operation, input.agent, "agent"),
      profileSelection: {
        profileId: identifier(operation, input.profileSelection.profileId, "profileSelection.profileId"),
        revision: expectedRevision(operation, input.profileSelection.revision).toString(),
      },
      profileDefinition: input.profileDefinition,
      scopeDigest: digestValue(operation, input.scopeDigest, "scopeDigest"),
      locationID: identifier(operation, input.locationID, "locationID"),
      workspaceID: identifier(operation, input.workspaceID, "workspaceID"),
      capabilityDigest: digestValue(operation, input.capabilityDigest, "capabilityDigest"),
      permissionsDigest: digestValue(operation, input.permissionsDigest, "permissionsDigest"),
      budgetDigest: digestValue(operation, input.budgetDigest, "budgetDigest"),
    },
    attemptID,
  )
  const admission = yield* decode(operation, response, decodeDirectAttemptAdmission)
  if (
    admission.directAttempt.profileID !== input.profileSelection.profileId ||
    admission.directAttempt.profileRevision !== input.profileSelection.revision ||
    !admission.directAttempt.profileDigest.startsWith("blake3:")
  ) {
    return yield* new ManagedControlError({
      operation,
      code: "managed_protocol",
      reason: "HostKernel returned a Direct Attempt profile pin that does not match the selected AgentProfileV2 revision",
    })
  }
  return admission
})

function directAttemptScopeValue(operation: string, scope: DirectAttemptScopeV1) {
  const keys = [
    "attemptID", "parentSessionID", "childSessionID", "profileID", "profileRevision", "profileDigest",
    "ownerEpoch", "expectedRevision", "locationID", "workspaceID", "workspaceRevision", "capabilityDigest",
    "permissionsDigest", "budgetDigest", "scopeDigest",
  ]
  if (
    typeof scope !== "object" || scope === null || Array.isArray(scope) ||
    Object.keys(scope).toSorted().join("\0") !== keys.toSorted().join("\0")
  ) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct Attempt scope has an invalid shape" })
  }
  return {
    attemptID: identifier(operation, scope.attemptID, "attemptID"),
    parentSessionID: identifier(operation, scope.parentSessionID, "parentSessionID"),
    childSessionID: identifier(operation, scope.childSessionID, "childSessionID"),
    profileID: identifier(operation, scope.profileID, "profileID"),
    profileRevision: expectedRevision(operation, scope.profileRevision).toString(),
    profileDigest: digestValue(operation, scope.profileDigest, "profileDigest"),
    ownerEpoch: expectedRevision(operation, scope.ownerEpoch).toString(),
    expectedRevision: expectedRevision(operation, scope.expectedRevision).toString(),
    locationID: identifier(operation, scope.locationID, "locationID"),
    workspaceID: identifier(operation, scope.workspaceID, "workspaceID"),
    workspaceRevision: digestValue(operation, scope.workspaceRevision, "workspaceRevision"),
    capabilityDigest: digestValue(operation, scope.capabilityDigest, "capabilityDigest"),
    permissionsDigest: digestValue(operation, scope.permissionsDigest, "permissionsDigest"),
    budgetDigest: digestValue(operation, scope.budgetDigest, "budgetDigest"),
    scopeDigest: digestValue(operation, scope.scopeDigest, "scopeDigest"),
  }
}

export function sameDirectAttemptScope(left: DirectAttemptScopeV1, right: DirectAttemptScopeV1): boolean {
  const encode = (scope: DirectAttemptScopeV1) => JSON.stringify(
    directAttemptScopeValue("direct_attempt_scope", scope),
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  )
  return encode(left) === encode(right)
}

function sameDirectAttemptIdentity(left: DirectAttemptScopeV1, right: DirectAttemptScopeV1): boolean {
  return left.attemptID === right.attemptID &&
    left.parentSessionID === right.parentSessionID &&
    left.childSessionID === right.childSessionID &&
    left.profileID === right.profileID &&
    left.profileRevision === right.profileRevision &&
    left.profileDigest === right.profileDigest &&
    left.ownerEpoch === right.ownerEpoch &&
    left.locationID === right.locationID &&
    left.workspaceID === right.workspaceID &&
    left.capabilityDigest === right.capabilityDigest &&
    left.permissionsDigest === right.permissionsDigest &&
    left.budgetDigest === right.budgetDigest &&
    left.scopeDigest === right.scopeDigest
}

export function isNextDirectAttemptScope(previous: DirectAttemptScopeV1, next: DirectAttemptScopeV1): boolean {
  const left = directAttemptScopeValue("direct_attempt_scope", previous)
  const right = directAttemptScopeValue("direct_attempt_scope", next)
  return sameDirectAttemptIdentity(left, right) &&
    left.workspaceRevision === right.workspaceRevision &&
    BigInt(right.expectedRevision) === BigInt(left.expectedRevision) + 1n
}

export function isReceiptAdvancedDirectAttemptScope(previous: DirectAttemptScopeV1, next: DirectAttemptScopeV1): boolean {
  if (sameDirectAttemptScope(previous, next)) return true
  const left = directAttemptScopeValue("direct_attempt_scope", previous)
  const right = directAttemptScopeValue("direct_attempt_scope", next)
  return sameDirectAttemptIdentity(left, right) &&
    BigInt(right.expectedRevision) === BigInt(left.expectedRevision) + 1n
}

export const bindDirectAttemptEffects = Effect.fn("ManagedControl.bindDirectAttemptEffects")(function* (input: {
  readonly scope: DirectAttemptScopeV1
  readonly effectIDs: readonly string[]
}) {
  const operation = "bind_direct_attempt_effects"
  const scope = directAttemptScopeValue(operation, input.scope)
  const attemptID = scope.attemptID
  const locationID = scope.locationID
  if (
    !Array.isArray(input.effectIDs) ||
    input.effectIDs.length === 0 ||
    input.effectIDs.length > 64 ||
    new Set(input.effectIDs).size !== input.effectIDs.length
  ) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "effectIDs must be a unique nonempty batch of at most 64" }),
    )
  }
  const effectIDs = input.effectIDs.map((effectID) => identifier(operation, effectID, "effectID"))
  const response = yield* call(
    operation,
    {
      attemptID,
      locationID,
      sessionID: scope.childSessionID,
      effectIDs,
      directAttempt: scope,
    },
    oneUseKey(attemptID, `bind_direct_${scope.expectedRevision}`),
  )
  const result = yield* decode(operation, response, (name, value): DirectAttemptEffectBound => {
    if (value.status !== "BOUND") {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "host status does not match BOUND" })
    }
    const boundEffectIDs = stringList(name, value.effectIDs as readonly string[], "effectIDs")
    const directAttempt = decodeDirectAttemptScope(name, value)
    if (
      boundEffectIDs.length !== effectIDs.length ||
      boundEffectIDs.some((effectID, index) => effectID !== effectIDs[index]) ||
      directAttempt.expectedRevision !== requiredRevision(name, value, "revision") ||
      directAttempt.attemptID !== attemptID ||
      directAttempt.parentSessionID !== input.scope.parentSessionID ||
      directAttempt.childSessionID !== input.scope.childSessionID ||
      directAttempt.profileID !== input.scope.profileID ||
      directAttempt.profileRevision !== input.scope.profileRevision ||
      directAttempt.profileDigest !== input.scope.profileDigest ||
      directAttempt.ownerEpoch !== input.scope.ownerEpoch ||
      directAttempt.locationID !== input.scope.locationID ||
      directAttempt.workspaceID !== input.scope.workspaceID ||
      directAttempt.workspaceRevision !== input.scope.workspaceRevision ||
      directAttempt.capabilityDigest !== input.scope.capabilityDigest ||
      directAttempt.permissionsDigest !== input.scope.permissionsDigest ||
      directAttempt.budgetDigest !== input.scope.budgetDigest ||
      directAttempt.scopeDigest !== input.scope.scopeDigest
    ) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "bound effects or refreshed scope do not match the request" })
    }
    return {
      attemptID: identifier(name, requiredText(name, value, "attemptID", 256), "attemptID"),
      effectIDs: boundEffectIDs,
      locationID: identifier(name, requiredText(name, value, "locationID", 256), "locationID"),
      revision: requiredRevision(name, value, "revision"),
      directAttempt,
    }
  })
  if (result.attemptID !== attemptID || result.locationID !== locationID) {
    return yield* Effect.fail(new ManagedControlError({ operation, code: "managed_protocol", reason: "host response does not echo direct EffectIntent" }))
  }
  return result
})

export const settleDirectAttempt = Effect.fn("ManagedControl.settleDirectAttempt")(function* (input: {
  readonly attemptID: string
  readonly outcome: "succeeded" | "failed" | "unknown"
  /**
   * Canonical revision in any accepted JS form (canonical decimal string,
   * safe number, or bigint). It is always serialized to the private
   * MessagePack uint64 wire form (bigint) before `call(...)`, matching the
   * kernel's `get_unsigned` contract and Core's `DirectAttemptScopeWireV1`.
   */
  readonly expectedRevision: string | number | bigint
  readonly resultDigest?: string
  readonly failureCode?: string
  readonly retryable?: boolean
}) {
  const operation = "settle_direct_attempt"
  const attemptID = input.attemptID
  if (!ATTEMPT_ID.test(attemptID)) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "attemptID is invalid" }),
    )
  }
  const revision = yield* decode(operation, { expectedRevision: input.expectedRevision }, (name, value) => directAttemptExpectedRevision(name, value.expectedRevision))
  const body: Record<string, unknown> = {
    attemptID,
    outcome: input.outcome,
    expectedRevision: revision,
  }
  if (input.resultDigest !== undefined) {
    body.resultDigest = digestValue(operation, input.resultDigest, "resultDigest")
  }
  if (input.failureCode !== undefined) body.failureCode = identifier(operation, input.failureCode, "failureCode")
  if (input.retryable !== undefined) body.retryable = input.retryable
  const response = yield* call(operation, body, `${attemptID}.settle`)
  const decoded = yield* decode(operation, response, decodeDirectAttempt)
  const outcome = response.outcome
  if (outcome !== "SUCCEEDED" && outcome !== "FAILED" && outcome !== "UNKNOWN") {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "settlement outcome is invalid" }),
    )
  }
  if (response.status !== "SETTLED" || decoded.attemptID !== attemptID || decoded.phase !== outcome) {
    return yield* Effect.fail(
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "settlement does not match the requested Attempt and terminal phase",
      }),
    )
  }
  return { ...decoded, outcome } satisfies DirectAttemptSettlement
})

export const cancelDirectAttempt = Effect.fn("ManagedControl.cancelDirectAttempt")(function* (input: {
  readonly attemptID: string
  /** Any accepted JS form; always serialized as the uint64 wire form (bigint). */
  readonly expectedRevision: string | number | bigint
}) {
  const operation = "cancel_direct_attempt"
  if (!ATTEMPT_ID.test(input.attemptID)) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "attemptID is invalid" }),
    )
  }
  const revision = yield* decode(operation, { expectedRevision: input.expectedRevision }, (name, value) => directAttemptExpectedRevision(name, value.expectedRevision))
  const response = yield* call(
    operation,
    { attemptID: input.attemptID, expectedRevision: revision },
    `${input.attemptID}.cancel`,
  )
  const cancelled = yield* decode(operation, response, decodeDirectAttempt)
  if (response.status !== "CANCELLED" || cancelled.attemptID !== input.attemptID || cancelled.phase !== "CANCELLED") {
    return yield* Effect.fail(
      new ManagedControlError({
        operation,
        code: "managed_protocol",
        reason: "cancellation does not match the requested Attempt and CANCELLED phase",
      }),
    )
  }
  return cancelled
})

export const snapshotDirectAttempt = Effect.fn("ManagedControl.snapshotDirectAttempt")(function* (attemptID: string) {
  const operation = "direct_attempt_snapshot"
  if (!ATTEMPT_ID.test(attemptID)) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "attemptID is invalid" }),
    )
  }
  const response = yield* call(operation, { attemptID })
  requireStatus(operation, response, "SNAPSHOT")
  const snapshot = yield* decode(operation, response, decodeDirectAttempt)
  const scope = snapshot.directAttempt
  if (snapshot.attemptID !== attemptID || (scope && (
    snapshot.phase !== "EXECUTING" || scope.attemptID !== snapshot.attemptID ||
    scope.parentSessionID !== snapshot.parentSessionID || scope.childSessionID !== snapshot.childSessionID ||
    scope.scopeDigest !== snapshot.scopeDigest || scope.expectedRevision !== snapshot.revision
  ))) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel snapshot authority does not match the live child Attempt" })
  }
  return snapshot
})

const directMessageModeToWire = (mode: DirectMessageMode) => mode === "queued" ? "queue" : "follow_up"

function directMessagePinsToWire(operation: string, pins: DirectMessagePinsV1) {
  const result = {
    parentSessionID: identifier(operation, pins.parentSessionID, "parentSessionID"),
    childSessionID: identifier(operation, pins.childSessionID, "childSessionID"),
    childOwnerEpoch: requiredDecimalU64(operation, { childOwnerEpoch: pins.childOwnerEpoch }, "childOwnerEpoch"),
    profileID: identifier(operation, pins.profileID, "profileID"),
    profileRevision: requiredDecimalU64(operation, { profileRevision: pins.profileRevision }, "profileRevision"),
    profileDigest: digestValue(operation, pins.profileDigest, "profileDigest"),
    permissionScopeDigest: digestValue(operation, pins.permissionScopeDigest, "permissionScopeDigest"),
    directAttemptID: identifier(operation, pins.directAttemptID, "directAttemptID"),
    messageID: identifier(operation, pins.messageID, "messageID"),
    deliveryMode: directMessageModeToWire(pins.deliveryMode),
    payloadDigest: digestValue(operation, pins.payloadDigest, "payloadDigest"),
    payloadBytes: pins.payloadBytes,
    mailboxSequence: requiredDecimalU64(operation, { mailboxSequence: pins.mailboxSequence }, "mailboxSequence"),
    mailboxCapacity: pins.mailboxCapacity,
  }
  if (result.parentSessionID === result.childSessionID || BigInt(result.childOwnerEpoch) === 0n || BigInt(result.profileRevision) === 0n ||
    BigInt(result.mailboxSequence) === 0n ||
    !result.profileDigest.startsWith("blake3:") || !Number.isSafeInteger(result.payloadBytes) || result.payloadBytes < 1 || result.payloadBytes > 16 * 1024 ||
    !Number.isSafeInteger(result.mailboxCapacity) || result.mailboxCapacity < 1 || result.mailboxCapacity > 32) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message authority pins are invalid" })
  }
  return result
}

function decodeDirectMessageReceipt(operation: string, response: Record<string, unknown>): DirectMessageReceiptV1 {
  const status = requiredText(operation, response, "status", 32)
  if (!["QUEUED", "FOLLOW_UP_SCHEDULED", "UNKNOWN"].includes(status)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message receipt status is invalid" })
  }
  const keys = ["status", "messageID", "parentSessionID", "childSessionID", "deliveryMode", "mailboxSequence", "receiptDigest"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message receipt has an invalid shape" })
  }
  const mode = requiredText(operation, response, "deliveryMode", 32)
  if (mode !== "queue" && mode !== "follow_up") throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message receipt mode is invalid" })
  const deliveryMode = mode === "queue" ? "queued" : "follow_up"
  if (status !== "UNKNOWN" && ((status === "QUEUED") !== (deliveryMode === "queued") || (status === "FOLLOW_UP_SCHEDULED") !== (deliveryMode === "follow_up"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message receipt status conflicts with its delivery mode" })
  }
  return {
    status: status as DirectMessageReceiptV1["status"],
    messageID: identifier(operation, requiredText(operation, response, "messageID", 256), "messageID"),
    parentSessionID: identifier(operation, requiredText(operation, response, "parentSessionID", 256), "parentSessionID"),
    childSessionID: identifier(operation, requiredText(operation, response, "childSessionID", 256), "childSessionID"),
    deliveryMode,
    mailboxSequence: requiredDecimalU64(operation, response, "mailboxSequence"),
    receiptDigest: digestValue(operation, requiredText(operation, response, "receiptDigest", 256), "receiptDigest"),
  }
}

function directWireDigest(value: unknown): string {
  return sha256(JSON.stringify(value, (_key, field) => typeof field === "bigint" ? field.toString() : field))
}

function callDirectMessage(operation: string, body: Readonly<Record<string, unknown>>, messageID: string) {
  return Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    return yield* supervisor.requestHostKernel(DIRECT_MESSAGE_SERVICE, operation, body, {
      deliveryID: `direct_message_${sha256(messageID).slice("sha256:".length)}_${operation}`,
    }).pipe(
      Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) => Effect.fail(
        new ManagedControlError({ operation: `direct.message.${operation}`, code: error.hostCode ?? "managed_unavailable", reason: error.reason }),
      )),
      Effect.map((response) => response as Record<string, unknown>),
    )
  })
}

function managedMessagePinsToWire(operation: string, pins: ManagedMessagePinsV1) {
  const result = {
    lane: "managed_attempt" as const,
    goalID: identifier(operation, pins.goalID, "goalID"),
    runID: identifier(operation, pins.runID, "runID"),
    taskID: identifier(operation, pins.taskID, "taskID"),
    attemptID: identifier(operation, pins.attemptID, "attemptID"),
    parentSessionID: identifier(operation, pins.parentSessionID, "parentSessionID"),
    childSessionID: identifier(operation, pins.childSessionID, "childSessionID"),
    ownerEpoch: requiredDecimalU64(operation, { ownerEpoch: pins.ownerEpoch }, "ownerEpoch"),
    bindingDigest: decodeBlake3Digest(operation, pins.bindingDigest, "bindingDigest"),
    profileID: identifier(operation, pins.profileID, "profileID"),
    profileRevision: requiredDecimalU64(operation, { profileRevision: pins.profileRevision }, "profileRevision"),
    profileDigest: decodeBlake3Digest(operation, pins.profileDigest, "profileDigest"),
    permissionScopeDigest: decodeBlake3Digest(operation, pins.permissionScopeDigest, "permissionScopeDigest"),
    messageID: identifier(operation, pins.messageID, "messageID"),
    deliveryMode: directMessageModeToWire(pins.deliveryMode),
    payloadDigest: digestValue(operation, pins.payloadDigest, "payloadDigest"),
    payloadBytes: pins.payloadBytes,
    mailboxSequence: requiredDecimalU64(operation, { mailboxSequence: pins.mailboxSequence }, "mailboxSequence"),
    mailboxCapacity: pins.mailboxCapacity,
  }
  if (BigInt(result.ownerEpoch) < 1n || BigInt(result.profileRevision) < 1n || BigInt(result.mailboxSequence) < 1n ||
    result.parentSessionID === result.childSessionID || !Number.isSafeInteger(result.payloadBytes) || result.payloadBytes < 1 || result.payloadBytes > MAX_TEXT_BYTES ||
    !Number.isSafeInteger(result.mailboxCapacity) || result.mailboxCapacity < 1 || result.mailboxCapacity > 32) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message authority pins are invalid or outside bounds" })
  }
  return result
}

function decodeManagedMessageReceipt(operation: string, raw: Record<string, unknown>): ManagedMessageReceiptV1 {
  const baseKeys = ["status", "messageID", "parentSessionID", "childSessionID", "deliveryMode", "mailboxSequence", "receiptDigest"].toSorted()
  const actualKeys = Object.keys(raw).toSorted()
  const scheduledKeys = [...baseKeys, "wakeReceiptDigest", "nextRequestSequence"].toSorted()
  if (actualKeys.join("\0") !== baseKeys.join("\0") && actualKeys.join("\0") !== scheduledKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message receipt has an invalid shape" })
  }
  const status = requiredText(operation, raw, "status", 32)
  if (status !== "QUEUED" && status !== "FOLLOW_UP_SCHEDULED" && status !== "UNKNOWN") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message receipt status is invalid" })
  }
  const wireMode = requiredText(operation, raw, "deliveryMode", 32)
  if (wireMode !== "queue" && wireMode !== "follow_up") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message delivery mode is invalid" })
  }
  const deliveryMode = wireMode === "queue" ? "queued" : "follow_up"
  if (status !== "UNKNOWN" && ((status === "QUEUED") !== (deliveryMode === "queued") || (status === "FOLLOW_UP_SCHEDULED") !== (deliveryMode === "follow_up"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message receipt status conflicts with its delivery mode" })
  }
  const scheduled = status === "FOLLOW_UP_SCHEDULED"
  if (scheduled !== (actualKeys.join("\0") === scheduledKeys.join("\0"))) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed follow-up receipt must carry its one-use wake pins" })
  }
  return {
    status: status as ManagedMessageReceiptV1["status"],
    messageID: identifier(operation, requiredText(operation, raw, "messageID", 256), "messageID"),
    parentSessionID: identifier(operation, requiredText(operation, raw, "parentSessionID", 256), "parentSessionID"),
    childSessionID: identifier(operation, requiredText(operation, raw, "childSessionID", 256), "childSessionID"),
    deliveryMode,
    mailboxSequence: requiredDecimalU64(operation, raw, "mailboxSequence"),
    receiptDigest: digestValue(operation, requiredText(operation, raw, "receiptDigest", 256), "receiptDigest"),
    ...(scheduled ? {
      wakeReceiptDigest: decodeBlake3Digest(operation, requiredText(operation, raw, "wakeReceiptDigest", 256), "wakeReceiptDigest"),
      nextRequestSequence: requiredDecimalU64(operation, raw, "nextRequestSequence"),
    } : {}),
  }
}

function stableManagedJSON(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]))
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

function decodeManagedMessageConsumptionAckReceipt(
  operation: string,
  raw: Record<string, unknown>,
): ManagedMessageConsumptionAckReceiptV1 {
  const expected = ["status", "ack", "receiptDigest"].toSorted()
  if (Object.keys(raw).toSorted().join("\0") !== expected.join("\0") || raw.status !== "ACKNOWLEDGED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed consumption receipt has an invalid shape" })
  }
  const ack = requiredRecord(operation, raw.ack, "ack")
  const ackKeys = ["authorityPins", "inboxReceiptDigest", "consumption", "consumptionAckDigest", "currentConsumer"].toSorted()
  if (Object.keys(ack).toSorted().join("\0") !== ackKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed consumption ACK has an invalid shape" })
  }
  const receiptDigest = decodeBlake3Digest(operation, requiredText(operation, raw, "receiptDigest", 256), "receiptDigest")
  const inboxReceiptDigest = requiredText(operation, ack, "inboxReceiptDigest", 256)
  const consumptionAckDigest = requiredText(operation, ack, "consumptionAckDigest", 256)
  digestValue(operation, inboxReceiptDigest, "inboxReceiptDigest")
  digestValue(operation, consumptionAckDigest, "consumptionAckDigest")
  requiredRecord(operation, ack.authorityPins, "authorityPins")
  requiredRecord(operation, ack.consumption, "consumption")
  requiredRecord(operation, ack.currentConsumer, "currentConsumer")
  return { status: "ACKNOWLEDGED", ack, receiptDigest }
}

function decodeManagedMessageWakeClaimReceipt(
  operation: string,
  raw: Record<string, unknown>,
): ManagedMessageWakeClaimReceiptV1 {
  const expected = ["authorityPins", "inboxReceiptDigest", "completedTurnReceiptDigest", "wakeReceiptDigest",
    "nextRequestSequence", "requestID", "currentConsumer", "wakeClaimDigest", "status", "wakeClaimReceiptDigest"].toSorted()
  if (Object.keys(raw).toSorted().join("\0") !== expected.join("\0") || raw.status !== "CLAIMED") {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed wake claim receipt has an invalid shape or status" })
  }
  const authorityPins = requiredRecord(operation, raw.authorityPins, "authorityPins")
  const currentConsumer = managedAttemptScopeValue(operation,
    requiredRecord(operation, raw.currentConsumer, "currentConsumer") as unknown as ManagedAttemptScopeV1)
  return {
    status: "CLAIMED",
    authorityPins,
    inboxReceiptDigest: digestValue(operation, requiredText(operation, raw, "inboxReceiptDigest", 256), "inboxReceiptDigest"),
    completedTurnReceiptDigest: decodeBlake3Digest(operation, requiredText(operation, raw, "completedTurnReceiptDigest", 256), "completedTurnReceiptDigest"),
    wakeReceiptDigest: decodeBlake3Digest(operation, requiredText(operation, raw, "wakeReceiptDigest", 256), "wakeReceiptDigest"),
    nextRequestSequence: requiredDecimalU64(operation, raw, "nextRequestSequence"),
    requestID: identifier(operation, requiredText(operation, raw, "requestID", 256), "requestID"),
    currentConsumer: currentConsumer as unknown as ManagedAttemptScopeV1,
    wakeClaimDigest: digestValue(operation, requiredText(operation, raw, "wakeClaimDigest", 256), "wakeClaimDigest"),
    wakeClaimReceiptDigest: decodeBlake3Digest(operation, requiredText(operation, raw, "wakeClaimReceiptDigest", 256), "wakeClaimReceiptDigest"),
  }
}

function callManagedMessage(operation: string, body: Readonly<Record<string, unknown>>, messageID: string) {
  return call(`managed_message.${operation}`, body,
    `managed_message_${sha256(messageID).slice("sha256:".length)}_${operation}`)
}

/** Guard-admit a managed-lane message before Core appends its payload. Payload bytes stay in Core. */
export const prepareManagedMessage = Effect.fn("ManagedControl.prepareManagedMessage")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly pins: ManagedMessagePinsV1
  readonly content: string
}) {
  const operation = "managed_message.prepare"
  if (typeof input.content !== "string") {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message content must be a string" })
  }
  const scope = managedAttemptScopeValue(operation, input.scope)
  const bytes = Buffer.byteLength(input.content, "utf8")
  if (bytes < 1 || bytes > MAX_TEXT_BYTES) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message payload is outside the 16 KiB bound" })
  const pins = managedMessagePinsToWire(operation, { ...input.pins, payloadDigest: sha256(input.content), payloadBytes: bytes })
  if (pins.goalID !== scope.goalID || pins.runID !== scope.runID || pins.taskID !== scope.taskID || pins.attemptID !== scope.attemptID ||
    pins.childSessionID !== scope.sessionID || pins.ownerEpoch !== scope.ownerEpoch || pins.bindingDigest !== scope.delegationBindingDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "managed message pins differ from the current authenticated Attempt scope" })
  }
  const response = yield* callManagedMessage("prepare", { managedAttempt: scope, authorityPins: pins }, pins.messageID)
  const status = requiredText(operation, response, "status", 32)
  if (status === "DENIED") {
    const keys = ["status", "reasonCode", "pinsDigest"].toSorted()
    if (Object.keys(response).toSorted().join("\0") !== keys.join("\0")) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message denial has an invalid shape" })
    return { status, reasonCode: requiredText(operation, response, "reasonCode", 128), pinsDigest: digestValue(operation, requiredText(operation, response, "pinsDigest", 256), "pinsDigest") } satisfies ManagedMessagePrepareResultV1
  }
  if (status === "NEEDS_APPROVAL") {
    const keys = ["status", "challengeID", "effectID", "capabilityID", "locationID", "inputDigest", "expiresAtUnixMs", "argumentSummary", "policySummary"].toSorted()
    if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.capabilityID !== "agents.message") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message approval challenge has an invalid shape" })
    const summary = requiredRecord(operation, response.argumentSummary, "argumentSummary")
    const summaryStatus = requiredText(operation, summary, "status", 32)
    const argumentSummary: GuardArgumentSummaryV1 = summaryStatus === "available" && Object.keys(summary).toSorted().join("\0") === ["status", "text"].toSorted().join("\0")
      ? { status: "available", text: requiredText(operation, summary, "text", 512) }
      : summaryStatus === "unavailable" && Object.keys(summary).toSorted().join("\0") === ["status", "reason"].toSorted().join("\0")
        ? { status: "unavailable", reason: requiredText(operation, summary, "reason", 128) }
        : (() => { throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message approval summary is malformed" }) })()
    return {
      status,
      challengeID: identifier(operation, requiredText(operation, response, "challengeID", 256), "challengeID"),
      effectID: identifier(operation, requiredText(operation, response, "effectID", 256), "effectID"),
      capabilityID: "agents.message" as const,
      locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
      inputDigest: digestValue(operation, requiredText(operation, response, "inputDigest", 256), "inputDigest"),
      expiresAtUnixMs: requiredInteger(operation, response, "expiresAtUnixMs"), argumentSummary,
      policySummary: requiredText(operation, response, "policySummary", 512),
    } satisfies ManagedMessagePrepareResultV1
  }
  const keys = ["status", "messageID", "capabilityID", "locationID", "capabilityLeaseDigest", "expiresAtUnixMs", "pinsDigest", "authorityPins"].toSorted()
  if (status !== "ADMITTED" || Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.capabilityID !== "agents.message") {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed message admission has an invalid shape" })
  }
  const echoed = requiredRecord(operation, response.authorityPins, "authorityPins")
  if (Object.keys(echoed).toSorted().join("\0") !== Object.keys(pins).toSorted().join("\0") ||
    Object.keys(pins).some((key) => echoed[key] !== (pins as unknown as Record<string, unknown>)[key])) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted different managed message pins" })
  }
  return {
    status,
    messageID: identifier(operation, requiredText(operation, response, "messageID", 256), "messageID"),
    capabilityID: "agents.message" as const,
    locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
    capabilityLeaseDigest: decodeBlake3Digest(operation, requiredText(operation, response, "capabilityLeaseDigest", 256), "capabilityLeaseDigest"),
    expiresAtUnixMs: requiredInteger(operation, response, "expiresAtUnixMs"),
    pinsDigest: decodeBlake3Digest(operation, requiredText(operation, response, "pinsDigest", 256), "pinsDigest"),
    authorityPins: { ...input.pins, payloadDigest: sha256(input.content), payloadBytes: bytes },
  } satisfies ManagedMessagePrepareResultV1
})

export const commitManagedMessage = Effect.fn("ManagedControl.commitManagedMessage")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly pins: ManagedMessagePinsV1
  readonly capabilityLeaseDigest: string
  readonly inboxReceipt: ManagedMessageReceiptV1
  readonly completedTurnReceiptDigest?: string
}) {
  const operation = "managed_message.commit"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const pins = managedMessagePinsToWire(operation, input.pins)
  const receipt = input.inboxReceipt
  if (receipt.messageID !== pins.messageID || receipt.parentSessionID !== pins.parentSessionID || receipt.childSessionID !== pins.childSessionID ||
    receipt.deliveryMode !== input.pins.deliveryMode || receipt.mailboxSequence !== pins.mailboxSequence ||
    (receipt.status !== "QUEUED" && receipt.status !== "FOLLOW_UP_SCHEDULED") ||
    (input.pins.deliveryMode === "queued" && input.completedTurnReceiptDigest !== undefined) ||
    (input.pins.deliveryMode === "follow_up" && (!input.completedTurnReceiptDigest || !/^blake3:[0-9a-f]{64}$/.test(input.completedTurnReceiptDigest)))) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "Core managed inbox receipt differs from the exact queued message pins" })
  }
  const response = yield* callManagedMessage("commit", {
    managedAttempt: scope,
    authorityPins: pins,
    capabilityLeaseDigest: decodeBlake3Digest(operation, input.capabilityLeaseDigest, "capabilityLeaseDigest"),
    inboxReceiptDigest: digestValue(operation, receipt.receiptDigest, "inboxReceiptDigest"),
    completedTurnReceiptDigest: input.completedTurnReceiptDigest ?? null,
  }, pins.messageID)
  const decoded = yield* decode(operation, response, decodeManagedMessageReceipt)
  const expectedStatus = input.pins.deliveryMode === "queued" ? "QUEUED" : "FOLLOW_UP_SCHEDULED"
  if (decoded.status !== expectedStatus || decoded.messageID !== pins.messageID || decoded.parentSessionID !== pins.parentSessionID ||
    decoded.childSessionID !== pins.childSessionID || decoded.deliveryMode !== input.pins.deliveryMode || decoded.mailboxSequence !== pins.mailboxSequence) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel committed a different managed message" })
  }
  return decoded
})

export const inspectManagedMessage = Effect.fn("ManagedControl.inspectManagedMessage")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly pins: ManagedMessagePinsV1
}) {
  const operation = "managed_message.inspect"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const pins = managedMessagePinsToWire(operation, input.pins)
  const response = yield* callManagedMessage("inspect", { managedAttempt: scope, authorityPins: pins }, pins.messageID)
  const decoded = yield* decode(operation, response, decodeManagedMessageReceipt)
  if (decoded.messageID !== pins.messageID || decoded.parentSessionID !== pins.parentSessionID || decoded.childSessionID !== pins.childSessionID ||
    decoded.deliveryMode !== input.pins.deliveryMode || decoded.mailboxSequence !== pins.mailboxSequence) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel inspected a different managed message" })
  }
  return decoded
})

/** Persist the exact Core safe-boundary proof and inspectable HostKernel ACK. */
export const acknowledgeManagedMessageConsumed = Effect.fn("ManagedControl.acknowledgeManagedMessageConsumed")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly pins: ManagedMessagePinsV1
  readonly proof: ManagedSubagentConsumptionProofV1
}) {
  const operation = "managed_message.acknowledge_consumed"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const pins = managedMessagePinsToWire(operation, input.pins)
  const proof = input.proof
  const { consumptionAckDigest: submittedAckDigest, ...digestInput } = proof
  const expectedAckDigest = managedMessageConsumptionAckDigest(digestInput)
  if (submittedAckDigest !== expectedAckDigest || proof.messageID !== pins.messageID ||
    proof.parentSessionID !== pins.parentSessionID || proof.childSessionID !== pins.childSessionID ||
    proof.deliveryMode !== (pins.deliveryMode === "queue" ? "queued" : "follow_up") ||
    proof.goalID !== pins.goalID || proof.runID !== pins.runID || proof.taskID !== pins.taskID ||
    proof.attemptID !== pins.attemptID || proof.mailboxSequence !== pins.mailboxSequence ||
    proof.consumingAttemptID !== pins.attemptID || proof.consumingOwnerEpoch !== pins.ownerEpoch ||
    proof.consumingRequestID !== input.scope.requestID || proof.consumingRequestSequence !== input.scope.requestSequence ||
    proof.consumingScopeDigest !== managedAttemptEffectScopeDigest(input.scope) ||
    proof.consumedPayloadDigest !== pins.payloadDigest ||
    proof.inboxReceiptDigest !== managedMessageInboxReceiptDigest({
      messageID: input.pins.messageID,
      parentSessionID: input.pins.parentSessionID,
      childSessionID: input.pins.childSessionID,
      requestID: "receipt-only",
      goalID: input.pins.goalID,
      runID: input.pins.runID,
      taskID: input.pins.taskID,
      attemptID: input.pins.attemptID,
      ownerEpoch: input.pins.ownerEpoch,
      bindingDigest: input.pins.bindingDigest,
      profileID: input.pins.profileID,
      profileRevision: input.pins.profileRevision,
      profileDigest: input.pins.profileDigest,
      permissionScopeDigest: input.pins.permissionScopeDigest,
      payload: "",
      payloadDigest: input.pins.payloadDigest,
      payloadBytes: pins.payloadBytes,
      deliveryMode: input.pins.deliveryMode === "queued" ? "queued" : "follow_up",
      mailboxCapacity: input.pins.mailboxCapacity,
      mailboxSequence: input.pins.mailboxSequence,
    })) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed consumption proof differs from exact inbox or Attempt pins" })
  }
  const consumption: Record<string, unknown> = {
    promptMessageID: proof.promptMessageID,
    consumingAttemptID: proof.consumingAttemptID,
    consumingOwnerEpoch: requiredDecimalU64(operation, { ownerEpoch: proof.consumingOwnerEpoch }, "consumingOwnerEpoch"),
    deliveryScopeDigest: digestValue(operation, proof.deliveryScopeDigest, "deliveryScopeDigest"),
    consumingScopeDigest: digestValue(operation, proof.consumingScopeDigest, "consumingScopeDigest"),
    consumedPayloadDigest: digestValue(operation, proof.consumedPayloadDigest, "consumedPayloadDigest"),
    ...(proof.deliveryMode === "follow_up" ? {
      completedTurnReceiptDigest: decodeBlake3Digest(operation, proof.completedTurnReceiptDigest ?? "", "completedTurnReceiptDigest"),
      wakeReceiptDigest: decodeBlake3Digest(operation, proof.wakeReceiptDigest ?? "", "wakeReceiptDigest"),
      wakeClaimReceiptDigest: decodeBlake3Digest(operation, proof.wakeClaimReceiptDigest ?? "", "wakeClaimReceiptDigest"),
      nextRequestSequence: requiredDecimalU64(operation, { nextRequestSequence: proof.nextRequestSequence }, "nextRequestSequence"),
    } : {}),
  }
  const ack = {
    authorityPins: pins,
    inboxReceiptDigest: digestValue(operation, proof.inboxReceiptDigest, "inboxReceiptDigest"),
    consumption,
    consumptionAckDigest: expectedAckDigest,
    currentConsumer: scope,
  }
  const response = yield* call(operation, ack, `managed_message_${sha256(pins.messageID).slice("sha256:".length)}_acknowledge_consumed`)
  const decoded = decodeManagedMessageConsumptionAckReceipt(operation, response)
  if (stableManagedJSON(decoded.ack) !== stableManagedJSON(ack)) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel consumption ACK differs from the submitted proof" })
  }
  const receiptBytes = encodeCanonicalMessagePackV1(decoded.ack, {
    maxEncodedBytes: 16 * 1024, maxDepth: 16, maxNodes: 512, maxCollectionItems: 128, maxScalarBytes: 4096,
  })
  const receiptPreimage = new Uint8Array(
    Buffer.byteLength("horizoncode.managed-message-consumption-ack-receipt.v1\0") + receiptBytes.byteLength,
  )
  receiptPreimage.set(new TextEncoder().encode("horizoncode.managed-message-consumption-ack-receipt.v1\0"))
  receiptPreimage.set(receiptBytes, Buffer.byteLength("horizoncode.managed-message-consumption-ack-receipt.v1\0"))
  if (`blake3:${bytesToHex(blake3(receiptPreimage))}` !== decoded.receiptDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel consumption receipt digest does not match the exact ACK" })
  }
  return decoded
})

/** Consume the committed managed follow-up wake once before the runner stores its next request. */
export const claimManagedMessageWake = Effect.fn("ManagedControl.claimManagedMessageWake")(function* (input: {
  readonly scope: ManagedAttemptScopeV1
  readonly pins: ManagedMessagePinsV1
  readonly inboxReceiptDigest: string
  readonly completedTurnReceiptDigest: string
  readonly wakeReceiptDigest: string
  readonly nextRequestSequence: string
  readonly requestID: string
}) {
  const operation = "managed_message.claim_wake"
  const scope = managedAttemptScopeValue(operation, input.scope)
  const pins = managedMessagePinsToWire(operation, input.pins)
  if (pins.deliveryMode !== "follow_up" || pins.goalID !== scope.goalID || pins.runID !== scope.runID ||
    pins.taskID !== scope.taskID || pins.attemptID !== scope.attemptID || pins.childSessionID !== scope.sessionID ||
    pins.ownerEpoch !== scope.ownerEpoch || pins.bindingDigest !== scope.delegationBindingDigest ||
    pins.permissionScopeDigest !== scope.permissionScopeDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_conflict", reason: "wake claim pins differ from the current managed Attempt" })
  }
  const inboxReceiptDigest = digestValue(operation, input.inboxReceiptDigest, "inboxReceiptDigest")
  const completedTurnReceiptDigest = decodeBlake3Digest(operation, input.completedTurnReceiptDigest, "completedTurnReceiptDigest")
  const wakeReceiptDigest = decodeBlake3Digest(operation, input.wakeReceiptDigest, "wakeReceiptDigest")
  const nextRequestSequence = requiredDecimalU64(operation, { nextRequestSequence: input.nextRequestSequence }, "nextRequestSequence")
  const requestID = identifier(operation, input.requestID, "requestID")
  const currentConsumerDigest = managedAttemptEffectScopeDigest(input.scope)
  const wakeClaimDigest = sha256(JSON.stringify({
    lane: "managed_attempt",
    messageID: pins.messageID,
    parentSessionID: pins.parentSessionID,
    childSessionID: pins.childSessionID,
    deliveryMode: pins.deliveryMode,
    goalID: pins.goalID,
    runID: pins.runID,
    taskID: pins.taskID,
    attemptID: pins.attemptID,
    mailboxSequence: pins.mailboxSequence,
    inboxReceiptDigest,
    completedTurnReceiptDigest,
    wakeReceiptDigest,
    nextRequestSequence,
    requestID,
    currentConsumerDigest,
  }))
  const request = {
    authorityPins: pins,
    inboxReceiptDigest,
    completedTurnReceiptDigest,
    wakeReceiptDigest,
    nextRequestSequence,
    requestID,
    currentConsumer: scope,
    wakeClaimDigest,
  }
  const response = yield* call(operation, request, `managed_message_${sha256(pins.messageID)}_claim_wake`)
  const decoded = decodeManagedMessageWakeClaimReceipt(operation, response)
  if (stableManagedJSON(decoded) !== stableManagedJSON({ ...request, status: "CLAIMED", wakeClaimReceiptDigest: decoded.wakeClaimReceiptDigest })) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel wake claim receipt differs from the exact request" })
  }
  const receiptBody = { ...request, status: "CLAIMED" }
  const receiptBytes = encodeCanonicalMessagePackV1(receiptBody, {
    maxEncodedBytes: 16 * 1024, maxDepth: 16, maxNodes: 512, maxCollectionItems: 128, maxScalarBytes: 4096,
  })
  const domain = "horizoncode.managed-message-wake-claim-receipt.v1\0"
  const preimage = new Uint8Array(Buffer.byteLength(domain) + receiptBytes.byteLength)
  preimage.set(new TextEncoder().encode(domain))
  preimage.set(receiptBytes, Buffer.byteLength(domain))
  if (`blake3:${bytesToHex(blake3(preimage))}` !== decoded.wakeClaimReceiptDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel wake claim receipt digest is invalid" })
  }
  return decoded
})

/** Decode replay material only. HostKernel must authenticate it before use. */
export function decodeDirectTurnScopeCandidate(raw: unknown): DirectTurnScopeV1 {
  return directTurnScopeToWire("direct_turn_recovery", raw)
}

function directTurnScopeToWire(operation: string, raw: unknown): DirectTurnScopeV1 {
  const value = requiredRecord(operation, raw, "directTurnScope")
  const keys = ["directAttempt", "runnerCycleID", "turnSequence", "cycleDigest"]
  if (Object.keys(value).toSorted().join("\0") !== keys.toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "direct turn scope has an invalid shape" })
  }
  const directAttempt = decodeDirectAttemptScope(operation, { directAttempt: value.directAttempt })
  const runnerCycleID = identifier(operation, requiredText(operation, value, "runnerCycleID", 256), "runnerCycleID")
  const turnSequence = requiredDecimalU64(operation, value, "turnSequence")
  const cycleDigest = decodeBlake3Digest(operation, requiredText(operation, value, "cycleDigest", 256), "cycleDigest")
  if (BigInt(turnSequence) < 1n) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "turnSequence must be positive" })
  return { directAttempt, runnerCycleID, turnSequence, cycleDigest }
}

function directTurnScopeValue(operation: string, scope: DirectTurnScopeV1) {
  const checked = directTurnScopeToWire(operation, scope)
  return {
    directAttempt: directAttemptScopeValue(operation, checked.directAttempt),
    runnerCycleID: checked.runnerCycleID,
    turnSequence: checked.turnSequence,
    cycleDigest: checked.cycleDigest,
  }
}

/** Exact batch-bind transition: same live cycle and workspace, one Attempt append. */
export function isNextDirectTurnScope(previous: DirectTurnScopeV1, next: DirectTurnScopeV1): boolean {
  if (sameDirectTurnScope(previous, next)) return true
  const left = directTurnScopeToWire("direct_turn_scope", previous)
  const right = directTurnScopeToWire("direct_turn_scope", next)
  return left.runnerCycleID === right.runnerCycleID && left.turnSequence === right.turnSequence &&
    left.directAttempt.attemptID === right.directAttempt.attemptID &&
    left.directAttempt.parentSessionID === right.directAttempt.parentSessionID &&
    left.directAttempt.childSessionID === right.directAttempt.childSessionID &&
    left.directAttempt.ownerEpoch === right.directAttempt.ownerEpoch &&
    left.directAttempt.profileID === right.directAttempt.profileID &&
    left.directAttempt.profileRevision === right.directAttempt.profileRevision &&
    left.directAttempt.profileDigest === right.directAttempt.profileDigest &&
    left.directAttempt.permissionsDigest === right.directAttempt.permissionsDigest &&
    left.directAttempt.capabilityDigest === right.directAttempt.capabilityDigest &&
    left.directAttempt.budgetDigest === right.directAttempt.budgetDigest &&
    left.directAttempt.scopeDigest === right.directAttempt.scopeDigest &&
    left.directAttempt.locationID === right.directAttempt.locationID &&
    left.directAttempt.workspaceID === right.directAttempt.workspaceID &&
    left.directAttempt.workspaceRevision === right.directAttempt.workspaceRevision &&
    left.directAttempt.expectedRevision !== "18446744073709551615" &&
    BigInt(right.directAttempt.expectedRevision) === BigInt(left.directAttempt.expectedRevision) + 1n
}

/** Exact end-of-batch transition. Mutable Attempt head may advance across all
 * terminal member receipts; the active runner-cycle identity cannot change. */
export function isCompletedDirectTurnBatchScope(previous: DirectTurnScopeV1, next: DirectTurnScopeV1): boolean {
  if (sameDirectTurnScope(previous, next)) return true
  const left = directTurnScopeToWire("direct_turn_scope", previous)
  const right = directTurnScopeToWire("direct_turn_scope", next)
  return left.runnerCycleID === right.runnerCycleID && left.turnSequence === right.turnSequence &&
    left.directAttempt.attemptID === right.directAttempt.attemptID &&
    left.directAttempt.parentSessionID === right.directAttempt.parentSessionID &&
    left.directAttempt.childSessionID === right.directAttempt.childSessionID &&
    left.directAttempt.ownerEpoch === right.directAttempt.ownerEpoch &&
    left.directAttempt.profileID === right.directAttempt.profileID &&
    left.directAttempt.profileRevision === right.directAttempt.profileRevision &&
    left.directAttempt.profileDigest === right.directAttempt.profileDigest &&
    left.directAttempt.permissionsDigest === right.directAttempt.permissionsDigest &&
    left.directAttempt.locationID === right.directAttempt.locationID &&
    left.directAttempt.workspaceID === right.directAttempt.workspaceID &&
    left.directAttempt.capabilityDigest === right.directAttempt.capabilityDigest &&
    left.directAttempt.budgetDigest === right.directAttempt.budgetDigest &&
    left.directAttempt.scopeDigest === right.directAttempt.scopeDigest &&
    BigInt(right.directAttempt.expectedRevision) > BigInt(left.directAttempt.expectedRevision)
}

export function createDirectTurnAuthority(
  initial: DirectTurnScopeV1,
  persistRefreshedScope: (scope: DirectTurnScopeV1) => Promise<void>,
): DirectTurnAuthority {
  let current = directTurnScopeToWire("direct_turn_scope", initial)
  return Object.freeze({
    currentScope: () => current,
    acceptRefreshedScope: ({ previous, refreshed, transition }) => {
      const prior = directTurnScopeToWire("direct_turn_scope", previous)
      const next = directTurnScopeToWire("direct_turn_scope", refreshed)
      const valid = transition === "batch_bind"
        ? isNextDirectTurnScope(prior, next)
        : transition === "batch_complete" && isCompletedDirectTurnBatchScope(prior, next)
      if (!sameDirectTurnScope(current, prior) || !valid) {
        throw new Error("HostKernel returned a stale or mismatched DirectTurnScope")
      }
      current = next
    },
    persistRefreshedScope,
  })
}

export function sameDirectTurnScope(left: DirectTurnScopeV1, right: DirectTurnScopeV1): boolean {
  return directWireDigest(directTurnScopeValue("direct_turn_scope", left)) ===
    directWireDigest(directTurnScopeValue("direct_turn_scope", right))
}

function freshTurnAuthorizationToWire(operation: string, raw: unknown): FreshTurnAuthorizationV1 {
  const value = requiredRecord(operation, raw, "freshTurnAuthorization")
  const keys = ["authorityPins", "completedTurnScope", "nextTurnSequence", "issuanceID", "expiresAtUnixMs", "authorizationDigest"]
  if (Object.keys(value).toSorted().join("\0") !== keys.toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn authorization has an invalid shape" })
  }
  const rawPins = requiredRecord(operation, value.authorityPins, "authorityPins")
  const pinKeys = [
    "parentSessionID", "childSessionID", "childOwnerEpoch", "profileID", "profileRevision", "profileDigest",
    "permissionScopeDigest", "directAttemptID", "messageID", "deliveryMode", "payloadDigest", "payloadBytes",
    "mailboxSequence", "mailboxCapacity",
  ]
  if (Object.keys(rawPins).toSorted().join("\0") !== pinKeys.toSorted().join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn message pins have an invalid shape" })
  }
  const wireMode = requiredText(operation, rawPins, "deliveryMode", 32)
  if (wireMode !== "follow_up") throw new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn authorization is not bound to follow_up" })
  const mode: DirectMessageMode = "follow_up"
  const authorityPins: DirectMessagePinsV1 = {
    parentSessionID: identifier(operation, requiredText(operation, rawPins, "parentSessionID", 256), "parentSessionID"),
    childSessionID: identifier(operation, requiredText(operation, rawPins, "childSessionID", 256), "childSessionID"),
    childOwnerEpoch: requiredDecimalU64(operation, rawPins, "childOwnerEpoch"),
    profileID: identifier(operation, requiredText(operation, rawPins, "profileID", 256), "profileID"),
    profileRevision: requiredDecimalU64(operation, rawPins, "profileRevision"),
    profileDigest: decodeBlake3Digest(operation, requiredText(operation, rawPins, "profileDigest", 256), "profileDigest"),
    permissionScopeDigest: digestValue(operation, requiredText(operation, rawPins, "permissionScopeDigest", 256), "permissionScopeDigest"),
    directAttemptID: identifier(operation, requiredText(operation, rawPins, "directAttemptID", 256), "directAttemptID"),
    messageID: identifier(operation, requiredText(operation, rawPins, "messageID", 256), "messageID"),
    deliveryMode: mode,
    payloadDigest: digestValue(operation, requiredText(operation, rawPins, "payloadDigest", 256), "payloadDigest"),
    payloadBytes: requiredInteger(operation, rawPins, "payloadBytes"),
    mailboxSequence: requiredDecimalU64(operation, rawPins, "mailboxSequence"),
    mailboxCapacity: requiredInteger(operation, rawPins, "mailboxCapacity"),
  }
  directMessagePinsToWire(operation, authorityPins)
  const completedTurnScope = directTurnScopeToWire(operation, value.completedTurnScope)
  const nextTurnSequence = requiredDecimalU64(operation, value, "nextTurnSequence")
  const issuanceID = identifier(operation, requiredText(operation, value, "issuanceID", 256), "issuanceID")
  const expiresAtUnixMs = requiredDecimalU64(operation, value, "expiresAtUnixMs")
  const authorizationDigest = decodeBlake3Digest(operation, requiredText(operation, value, "authorizationDigest", 256), "authorizationDigest")
  const scope = completedTurnScope.directAttempt
  if (authorityPins.parentSessionID !== scope.parentSessionID || authorityPins.childSessionID !== scope.childSessionID ||
    authorityPins.directAttemptID !== scope.attemptID || authorityPins.childOwnerEpoch !== scope.ownerEpoch ||
    authorityPins.profileID !== scope.profileID || authorityPins.profileRevision !== scope.profileRevision ||
    authorityPins.profileDigest !== scope.profileDigest || authorityPins.permissionScopeDigest !== scope.permissionsDigest ||
    BigInt(nextTurnSequence) !== BigInt(completedTurnScope.turnSequence) + 1n || authorityPins.payloadBytes < 1 || authorityPins.payloadBytes > 16 * 1024 ||
    authorityPins.mailboxCapacity < 1 || authorityPins.mailboxCapacity > 32 || BigInt(expiresAtUnixMs) < 1n) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn authorization pins do not match the completed child turn" })
  }
  return { authorityPins, completedTurnScope, nextTurnSequence, issuanceID, expiresAtUnixMs, authorizationDigest }
}

function freshTurnAuthorizationValue(operation: string, authorization: FreshTurnAuthorizationV1) {
  const checked = freshTurnAuthorizationToWire(operation, authorization)
  return {
    authorityPins: directMessagePinsToWire(operation, checked.authorityPins),
    completedTurnScope: directTurnScopeValue(operation, checked.completedTurnScope),
    nextTurnSequence: checked.nextTurnSequence,
    issuanceID: checked.issuanceID,
    expiresAtUnixMs: checked.expiresAtUnixMs,
    authorizationDigest: checked.authorizationDigest,
  }
}

/** Shared source gate: callers must check before reserving a follow-up inbox row. */
export const requireDirectTurnLifecycle = () => DIRECT_CHILD_TURN_RPC_ENABLED
  ? Effect.void
  : Effect.fail(new ManagedControlError({ operation: "turn_begin", code: "managed_unavailable", reason: "direct child turns remain disabled until HostKernel Guard and recovery acceptance" }))

/** Begin one child provider turn. Callers must keep this unavailable until the HostKernel Guard path is accepted. */
export const beginDirectTurn = Effect.fn("ManagedControl.beginDirectTurn")(function* (input: {
  readonly directAttempt: DirectAttemptScopeV1
  readonly freshTurnAuthorization?: FreshTurnAuthorizationV1
}) {
  const operation = "turn_begin"
  if (!DIRECT_CHILD_TURN_RPC_ENABLED) return yield* new ManagedControlError({ operation, code: "managed_unavailable", reason: "direct child turns remain disabled until HostKernel Guard and recovery acceptance" })
  const directAttempt = directAttemptScopeValue(operation, input.directAttempt)
  let freshTurnAuthorization: FreshTurnAuthorizationV1 | undefined
  if (input.freshTurnAuthorization) {
    freshTurnAuthorization = freshTurnAuthorizationToWire(operation, input.freshTurnAuthorization)
    const scope = freshTurnAuthorization.completedTurnScope.directAttempt
    if (scope.attemptID !== input.directAttempt.attemptID || scope.parentSessionID !== input.directAttempt.parentSessionID ||
      scope.childSessionID !== input.directAttempt.childSessionID || scope.ownerEpoch !== input.directAttempt.ownerEpoch ||
      scope.profileID !== input.directAttempt.profileID || scope.profileRevision !== input.directAttempt.profileRevision ||
      scope.profileDigest !== input.directAttempt.profileDigest || scope.permissionsDigest !== input.directAttempt.permissionsDigest) {
      return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn authorization belongs to a different live child Attempt" })
    }
  }
  const body = {
    directAttempt,
    ...(freshTurnAuthorization ? { freshTurnAuthorization: freshTurnAuthorizationValue(operation, freshTurnAuthorization) } : {}),
  }
  const response = yield* callDirectMessage(operation, body, directWireDigest(body))
  const keys = ["status", "directTurnScope"]
  if (Object.keys(response).toSorted().join("\0") !== keys.toSorted().join("\0") || response.status !== "ACTIVE") {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel returned an invalid active-turn receipt" })
  }
  const directTurnScope = yield* decode(operation, response, (name, value) => directTurnScopeToWire(name, value.directTurnScope))
  if (directTurnScope.directAttempt.attemptID !== input.directAttempt.attemptID ||
    directTurnScope.directAttempt.childSessionID !== input.directAttempt.childSessionID ||
    directTurnScope.directAttempt.parentSessionID !== input.directAttempt.parentSessionID ||
    directTurnScope.directAttempt.profileID !== input.directAttempt.profileID ||
    directTurnScope.directAttempt.profileRevision !== input.directAttempt.profileRevision ||
    directTurnScope.directAttempt.ownerEpoch !== input.directAttempt.ownerEpoch ||
    directTurnScope.directAttempt.permissionsDigest !== input.directAttempt.permissionsDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel began a turn for different child authority" })
  }
  return directTurnScope
})

/** Complete one child provider turn and retain the same still-live DirectAttempt. */
export const completeDirectTurn = Effect.fn("ManagedControl.completeDirectTurn")(function* (input: {
  readonly directTurnScope: DirectTurnScopeV1
  /** Child output pinned for this turn; digest is derived here, not supplied by callers. */
  readonly result: DirectResultPayload
}) {
  const operation = "turn_complete"
  if (!DIRECT_CHILD_TURN_RPC_ENABLED) return yield* new ManagedControlError({ operation, code: "managed_unavailable", reason: "direct child turns remain disabled until HostKernel Guard and recovery acceptance" })
  const scope = directTurnScopeToWire(operation, input.directTurnScope)
  const wireResultDigest = digestValue(operation, resultDigest(input.result), "resultDigest")
  if (!wireResultDigest.startsWith("sha256:")) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "resultDigest must use SHA-256" })
  const body = { directTurnScope: directTurnScopeValue(operation, scope), resultDigest: wireResultDigest }
  const response = yield* callDirectMessage(operation, body, directWireDigest(body))
  const keys = ["status", "nextTurnSequence", "receiptDigest"]
  if (Object.keys(response).toSorted().join("\0") !== keys.toSorted().join("\0") || response.status !== "COMPLETED") {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel returned an invalid turn-completion receipt" })
  }
  const nextTurnSequence = requiredDecimalU64(operation, response, "nextTurnSequence")
  const receiptDigest = decodeBlake3Digest(operation, requiredText(operation, response, "receiptDigest", 256), "receiptDigest")
  if (BigInt(nextTurnSequence) !== BigInt(scope.turnSequence) + 1n) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel turn-completion sequence is not the exact successor" })
  return { status: "COMPLETED" as const, nextTurnSequence, receiptDigest }
})

/** Request, but never synthesize, the one-use HostKernel proof for an explicit follow-up. */
export const issueFreshTurnAuthorization = Effect.fn("ManagedControl.issueFreshTurnAuthorization")(function* (input: {
  readonly pins: DirectMessagePinsV1
  readonly completedTurnScope: DirectTurnScopeV1
}) {
  const operation = "issue_fresh_turn_authorization"
  if (!DIRECT_CHILD_TURN_RPC_ENABLED) return yield* new ManagedControlError({ operation, code: "managed_unavailable", reason: "direct child turns remain disabled until HostKernel Guard and recovery acceptance" })
  if (input.pins.deliveryMode !== "follow_up") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "fresh-turn authorization requires explicit follow_up mode" })
  const pins = directMessagePinsToWire(operation, input.pins)
  const completedTurnScope = directTurnScopeToWire(operation, input.completedTurnScope)
  const scope = completedTurnScope.directAttempt
  if (pins.directAttemptID !== scope.attemptID || pins.parentSessionID !== scope.parentSessionID || pins.childSessionID !== scope.childSessionID ||
    pins.childOwnerEpoch !== scope.ownerEpoch || pins.profileID !== scope.profileID || pins.profileRevision !== scope.profileRevision ||
    pins.profileDigest !== scope.profileDigest || pins.permissionScopeDigest !== scope.permissionsDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "follow_up message pins do not match the completed child turn" })
  }
  const body = { authorityPins: pins, completedTurnScope: directTurnScopeValue(operation, completedTurnScope) }
  const response = yield* callDirectMessage(operation, body, directWireDigest(body))
  if (Object.keys(response).toSorted().join("\0") !== "freshTurnAuthorization") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel returned an invalid fresh-turn authorization reply" })
  const freshTurnAuthorization = yield* decode(operation, response, (name, value) => freshTurnAuthorizationToWire(name, value.freshTurnAuthorization))
  if (JSON.stringify(directMessagePinsToWire(operation, freshTurnAuthorization.authorityPins)) !== JSON.stringify(pins) ||
    freshTurnAuthorization.completedTurnScope.runnerCycleID !== completedTurnScope.runnerCycleID ||
    freshTurnAuthorization.completedTurnScope.turnSequence !== completedTurnScope.turnSequence ||
    freshTurnAuthorization.completedTurnScope.cycleDigest !== completedTurnScope.cycleDigest) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel authorized a different follow-up message or completed turn" })
  }
  return freshTurnAuthorization
})

/** Prepare a direct child inbox append; caller must durably append only under ADMITTED lease. */
export const prepareDirectMessage = Effect.fn("ManagedControl.prepareDirectMessage")(function* (input: {
  readonly pins: Omit<DirectMessagePinsV1, "payloadDigest" | "payloadBytes" | "mailboxCapacity">
  readonly content: string
  readonly mailboxCapacity: number
  /** Explicit one-use proof minted for this exact follow-up message by HostKernel. */
  readonly freshTurnAuthorization?: FreshTurnAuthorizationV1
  /** Legacy ordinary scope is accepted only so callers can be rejected before IPC. */
  readonly directAttempt?: DirectAttemptScopeV1
}) {
  const operation = "prepare"
  if (typeof input.content !== "string") {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_protocol", reason: "direct message content must be a string" })
  }
  const bytes = new TextEncoder().encode(input.content)
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 || !Number.isSafeInteger(input.mailboxCapacity) || input.mailboxCapacity < 1 || input.mailboxCapacity > 32) {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_protocol", reason: "direct message payload or available mailbox capacity is outside its bound" })
  }
  if (input.pins.deliveryMode === "follow_up" && (!DIRECT_CHILD_TURN_RPC_ENABLED || !input.freshTurnAuthorization)) {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_unavailable", reason: "follow_up requires accepted HostKernel turn recovery and a one-use fresh-turn authorization" })
  }
  if (input.pins.deliveryMode === "queued" && input.freshTurnAuthorization) {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_protocol", reason: "queued messages cannot consume follow-up authorization" })
  }
  if (input.directAttempt !== undefined) {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_protocol", reason: "queued direct messages cannot carry unused DirectAttempt turn authority" })
  }
  const payloadDigest = sha256(input.content)
  const pins = directMessagePinsToWire("direct.message.prepare", { ...input.pins, payloadDigest, payloadBytes: bytes.byteLength, mailboxCapacity: input.mailboxCapacity })
  const fresh = input.freshTurnAuthorization && freshTurnAuthorizationValue("direct.message.prepare", input.freshTurnAuthorization)
  if (fresh && JSON.stringify(fresh.authorityPins) !== JSON.stringify(pins)) {
    return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_protocol", reason: "fresh-turn authorization is bound to different message pins" })
  }
  const body = { authorityPins: pins, ...(fresh ? { freshTurnAuthorization: fresh } : {}) }
  const response = yield* callDirectMessage("prepare", body, pins.messageID)
  // The status text is validated against exactly one variant in every branch
  // below; unknown values fail closed. The literal union keeps each result
  // variant discriminant-exact so consumers retain narrowing.
  const status = requiredText(operation, response, "status", 32) as
    | "DENIED"
    | "NEEDS_APPROVAL"
    | "ADMITTED"
  if (status === "DENIED") {
    const keys = ["status", "reasonCode", "pinsDigest"].toSorted()
    if (Object.keys(response).toSorted().join("\0") !== keys.join("\0")) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message denial has an invalid shape" })
    return { status, reasonCode: requiredText(operation, response, "reasonCode", 128), pinsDigest: digestValue(operation, requiredText(operation, response, "pinsDigest", 256), "pinsDigest") } satisfies DirectMessagePrepareResultV1
  }
  if (status === "NEEDS_APPROVAL") {
    const keys = ["status", "challengeID", "effectID", "capabilityID", "locationID", "inputDigest", "expiresAtUnixMs", "argumentSummary", "policySummary"].toSorted()
    if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.capabilityID !== "agents.message") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message approval challenge has an invalid shape" })
    const summary = requiredRecord(operation, response.argumentSummary, "argumentSummary")
    const summaryStatus = requiredText(operation, summary, "status", 32)
    let argumentSummary: GuardArgumentSummaryV1
    if (summaryStatus === "available" && Object.keys(summary).toSorted().join("\0") === ["status", "text"].toSorted().join("\0")) argumentSummary = { status: "available", text: requiredText(operation, summary, "text", 512) }
    else if (summaryStatus === "unavailable" && Object.keys(summary).toSorted().join("\0") === ["status", "reason"].toSorted().join("\0")) argumentSummary = { status: "unavailable", reason: requiredText(operation, summary, "reason", 128) }
    else return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message argument summary has an invalid shape" })
    return {
      status,
      challengeID: identifier(operation, requiredText(operation, response, "challengeID", 256), "challengeID"),
      effectID: identifier(operation, requiredText(operation, response, "effectID", 256), "effectID"),
      capabilityID: "agents.message",
      locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
      inputDigest: digestValue(operation, requiredText(operation, response, "inputDigest", 256), "inputDigest"),
      expiresAtUnixMs: requiredInteger(operation, response, "expiresAtUnixMs"),
      argumentSummary,
      policySummary: requiredText(operation, response, "policySummary", 512),
    } satisfies DirectMessagePrepareResultV1
  }
  if (status !== "ADMITTED") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message prepare status is invalid" })
  const keys = ["status", "messageID", "capabilityID", "locationID", "capabilityLeaseDigest", "expiresAtUnixMs", "pinsDigest"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== keys.join("\0") || response.capabilityID !== "agents.message") return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "direct message admission has an invalid shape" })
  const result = {
    status,
    messageID: identifier(operation, requiredText(operation, response, "messageID", 256), "messageID"),
    capabilityID: "agents.message" as const,
    locationID: identifier(operation, requiredText(operation, response, "locationID", 256), "locationID"),
    capabilityLeaseDigest: digestValue(operation, requiredText(operation, response, "capabilityLeaseDigest", 256), "capabilityLeaseDigest"),
    expiresAtUnixMs: requiredInteger(operation, response, "expiresAtUnixMs"),
    pinsDigest: digestValue(operation, requiredText(operation, response, "pinsDigest", 256), "pinsDigest"),
    authorityPins: {
      ...input.pins,
      payloadDigest,
      payloadBytes: bytes.byteLength,
      mailboxCapacity: input.mailboxCapacity,
    } satisfies DirectMessagePinsV1,
  }
  if (result.messageID !== pins.messageID) return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted another direct message identity" })
  return result satisfies DirectMessagePrepareResultV1
})

export const commitDirectMessage = Effect.fn("ManagedControl.commitDirectMessage")(function* (input: {
  readonly pins: DirectMessagePinsV1
  readonly capabilityLeaseDigest: string
  readonly inboxReceipt: DirectMessageInboxReceiptV1
}) {
  const operation = "commit"
  const pins = directMessagePinsToWire(operation, input.pins)
  const receipt = input.inboxReceipt
  if (receipt.messageID !== pins.messageID || receipt.parentSessionID !== pins.parentSessionID || receipt.childSessionID !== pins.childSessionID ||
    receipt.deliveryMode !== input.pins.deliveryMode || receipt.mailboxSequence !== pins.mailboxSequence) {
    return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_protocol", reason: "Core inbox receipt does not match the exact prepared direct message pins" })
  }
  const body = {
    authorityPins: pins,
    capabilityLeaseDigest: digestValue(operation, input.capabilityLeaseDigest, "capabilityLeaseDigest"),
    inboxReceiptDigest: digestValue(operation, receipt.receiptDigest, "inboxReceiptDigest"),
  }
  const response = yield* callDirectMessage(operation, body, pins.messageID)
  const decoded = yield* decode(operation, response, decodeDirectMessageReceipt)
  if (decoded.messageID !== pins.messageID || decoded.parentSessionID !== pins.parentSessionID || decoded.childSessionID !== pins.childSessionID ||
    decoded.deliveryMode !== input.pins.deliveryMode || decoded.mailboxSequence !== pins.mailboxSequence) {
    return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_protocol", reason: "HostKernel returned a receipt for different direct message pins" })
  }
  return decoded
})

export const inspectDirectMessage = Effect.fn("ManagedControl.inspectDirectMessage")(function* (input: {
  readonly pins: DirectMessagePinsV1
}) {
  const operation = "inspect"
  const pins = directMessagePinsToWire(operation, input.pins)
  const response = yield* callDirectMessage(operation, { authorityPins: pins }, pins.messageID)
  const decoded = yield* decode(operation, response, decodeDirectMessageReceipt)
  if (decoded.messageID !== pins.messageID || decoded.parentSessionID !== pins.parentSessionID || decoded.childSessionID !== pins.childSessionID ||
    decoded.deliveryMode !== input.pins.deliveryMode || decoded.mailboxSequence !== pins.mailboxSequence) {
    return yield* new ManagedControlError({ operation: "direct.message.inspect", code: "managed_protocol", reason: "HostKernel inspected a different direct message identity" })
  }
  return decoded
})

export const newAttemptID = () => `att_${randomUUID().replaceAll("-", "")}`

/**
 * Canonical `sha256:` digest of the intersected dispatch scope. Fixed key order plus
 * sorted rule sets make it reproducible: the same dispatch facts always hash to the
 * same value, and any change to permissions, model, workspace or budget changes it.
 */
export const scopeDigest = (facts: DirectScopeFacts) =>
  sha256(
    JSON.stringify({
      parentSessionID: facts.parentSessionID,
      childSessionID: facts.childSessionID,
      agent: facts.agent,
      providerID: facts.providerID,
      modelID: facts.modelID,
      workspaceRoot: facts.workspaceRoot,
      permissionRules: [...facts.permissionRules].sort(),
      deniedTools: [...facts.deniedTools].sort(),
      background: facts.background,
      maxAttempts: facts.maxAttempts,
      subagentDepth: facts.subagentDepth,
    }),
  )

export const outputDigest = (output: string) => sha256(output)

/** Managed child output is pinned as BLAKE3 by the HostKernel quiescence receipt. */
export const managedOutputDigest = (output: string) => `blake3:${bytesToHex(blake3(Buffer.from(output, "utf8")))}`

export const resultDigest = (payload: DirectResultPayload) => {
  if (!CANONICAL_DIGEST.test(payload.outputDigest)) {
    throw new ManagedControlError({
      operation: "result_digest",
      code: "managed_protocol",
      reason: "outputDigest is not a canonical digest",
    })
  }
  if (!Number.isSafeInteger(payload.outputBytes) || payload.outputBytes < 0) {
    throw new ManagedControlError({
      operation: "result_digest",
      code: "managed_protocol",
      reason: "outputBytes is invalid",
    })
  }
  return sha256(
    JSON.stringify({
      childSessionID: payload.childSessionID,
      agent: payload.agent,
      state: payload.state,
      outputDigest: payload.outputDigest,
      outputBytes: payload.outputBytes,
    }),
  )
}

export * as ManagedControl from "./managed-control"
