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
import { Effect, Schema } from "effect"
import { Location } from "@opencode-ai/core/location"
import { AgentProfileService, Service as CoreConfigService } from "@opencode-ai/core/config"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import type { ManagedRootSessionLinkProjectionV1 } from "./session"
import { ContextSelectionV1, type ContextSelectionV1 as ContextSelection } from "@opencode-ai/schema/context-selection-v1"
import {
  type ManagedVerifierGuardChallengeV1,
  type GuardArgumentSummaryV1,
  type GuardGuaranteeAssessmentV1,
  type ManagedVerifierApprovalCollectionV1,
  Service as SessionSupervisorService,
  SessionSupervisor,
  SessionSupervisorError,
} from "@opencode-ai/core/session/supervisor"

const MANAGED_SERVICE = "managed.v1"
const IDENTIFIER = /^[A-Za-z0-9._-]{1,256}$/
const ATTEMPT_ID = /^att_[a-z0-9]{16,64}$/
const CANONICAL_DIGEST = /^(sha256|blake3):[0-9a-f]{64}$/
const MAX_LIST_ITEMS = 256
const MAX_TEXT_BYTES = 16 * 1024
const MAX_VERIFIER_CRITERIA = 32
const MAX_RAW_DELIVERY_KEY_BYTES = 200

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
  readonly acceptedSpecs: readonly { readonly specID: string; readonly specDigest: string }[]
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
  readonly runPhase: string
  readonly taskIDs: readonly string[]
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
  readonly revision: number
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
  readonly profile: {
    readonly profileID: string
    readonly profileRevision: string
    readonly profileDigest: string
  }
  /** Full HostKernel-minted scope; never reconstructed from admission request fields. */
  readonly managedAttempt: ManagedAttemptScopeV1
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
}

/** Core-owned durable child-session facts supplied only by Session service code. */
export type ManagedChildSessionCompletionProjectionV1 = {
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  readonly childSessionStateDigest: string
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
  readonly deliveryID: string
  readonly managedRevision: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly receiptDigest: string
}

/** P8's durable release/quarantine receipt for a fully settled logical child. */
export type ManagedDispatchSettlementReceiptV1 = {
  readonly status: "SETTLED"
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
  readonly workerExecutionID: string
  readonly disposition: "RELEASED" | "WORKTREE_QUARANTINED"
  readonly proofDigest: string
  readonly ownerLogID: string
  readonly ownerLogSequence: string
  readonly ownerLogEventDigest: string
  readonly workerPoolRevision: string
  readonly receiptDigest: string
}

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
    readonly candidateAttemptID: string
    readonly attemptCount: string
    readonly candidateGeneration: string
    readonly taskRevision: string
    readonly dependencies: readonly string[]
    readonly criterionIDs: readonly string[]
    readonly criteria: readonly { readonly criterionID: string; readonly description: string }[]
    readonly requiredCapabilities: readonly string[]
    readonly profile: {
      readonly profileID: string
      readonly revision: string
      readonly definitionDigest: string
      readonly ownerBindingDigest: string
    }
  }
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
  readonly locationID: string
  readonly sessionID: string
  readonly workspaceRevision: string
  /** Required immutable Rust-owned DelegationBindingV1 digest. */
  readonly delegationBindingDigest: string
}

/**
 * Mutable authority for one live managed prompt. Scope updates must come from
 * HostKernel responses after a durable transition; callers cannot edit fields or
 * skip an intervening mutation with a request-body revision. Each accepted
 * transition represents one exact OwnerLog append.
 */
export type ManagedAttemptAuthority = {
  readonly currentScope: () => ManagedAttemptScopeV1
  readonly acceptRefreshedScope: (input: {
    readonly previous: ManagedAttemptScopeV1
    readonly refreshed: ManagedAttemptScopeV1
    readonly transition: "batch_bind" | "effect_receipt"
  }) => void
}

export function managedAttemptScopeToWire(scope: ManagedAttemptScopeV1): ManagedAttemptScopeV1 {
  const operation = "managed_attempt_scope"
  return managedAttemptScopeValue(operation, scope)
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
    BigInt(right.expectedManagedRevision) === BigInt(left.expectedManagedRevision) + 1n
}

export function isReceiptAdvancedManagedAttemptScope(
  previous: ManagedAttemptScopeV1,
  next: ManagedAttemptScopeV1,
): boolean {
  const left = managedAttemptScopeValue("managed_attempt_scope", previous)
  const right = managedAttemptScopeValue("managed_attempt_scope", next)
  return sameManagedAttemptIdentity(left, right) &&
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
    left.delegationBindingDigest === right.delegationBindingDigest
}

export function createManagedAttemptAuthority(initial: ManagedAttemptScopeV1): ManagedAttemptAuthority {
  let current = managedAttemptScopeToWire(initial)
  return Object.freeze({
    currentScope: () => current,
    acceptRefreshedScope: ({ previous, refreshed, transition }) => {
      const prior = managedAttemptScopeToWire(previous)
      const next = managedAttemptScopeToWire(refreshed)
      const validTransition = transition === "batch_bind"
        ? isNextManagedAttemptScope(prior, next)
        : transition === "effect_receipt" && isReceiptAdvancedManagedAttemptScope(prior, next)
      if (!sameManagedAttemptScope(current, prior) || !validTransition) {
        throw new Error("HostKernel returned a stale or mismatched managed Attempt scope")
      }
      current = next
    },
  })
}

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

type VerificationStarted = {
  readonly status: "NEEDS_APPROVAL"
  readonly goalID: string
  readonly runID: string
  /** Kernel-computed final integrated Revision the verifier is bound to. */
  readonly finalRevision: string
  readonly verificationRunID: string
  /** Digest of the exact HostKernel-owned challenge set, used for atomic resolution. */
  readonly challengeSetDigest: string
  readonly challenges: ReadonlyArray<VerifierApprovalChallenge>
  readonly revision: string
}

/** Safe public projection; challenge, lease, output and artifact facts stay private. */
export type VerificationRunResult =
  | {
      readonly status: "ABORTED"
      readonly goalID: string
      readonly runID: string
      readonly verificationRunID: string
      readonly reason: VerificationAbortReason
      readonly revision: string
    }
  | {
      readonly status: VerificationExecutionStatus
      readonly goalID: string
      readonly runID: string
      readonly verificationRunID: string
      readonly revision: string
    }

type VerificationAbortReason = "reviewer_denied" | "cancelled" | "expired" | "transport_lost"
type VerificationExecutionStatus =
  | "VERIFYING"
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
  readonly allowEnabled: boolean
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

/** The intersected facts one direct subagent dispatch is bound to. */
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
   */
  readonly admitAttempt: (input: {
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly parentSessionID: string
    readonly locationID: string
    readonly sessionID: string
    readonly expectedRevision: ManagedRevision
    readonly profileSelection: { readonly profileId: string; readonly revision: string }
    readonly contextSelection: ContextSelection
  }) => Effect.Effect<ManagedAttemptAdmission, ManagedControlError, SessionSupervisorService | AgentProfileService>
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
  /** Selects exactly one Task through Rust's authoritative bounded DAG scheduler. */
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
  }) => Effect.Effect<ManagedDispatchSettlementReceiptV1, ManagedControlError, SessionSupervisorService>
  readonly pauseRun: (input: {
    readonly goalID: string
    readonly runID: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<ManagedRunPhaseChange, ManagedControlError, SessionSupervisorService>
  readonly resumeRun: (input: {
    readonly goalID: string
    readonly runID: string
    readonly expectedRevision: ManagedRevision
  }) => Effect.Effect<ManagedRunPhaseChange, ManagedControlError, SessionSupervisorService>
  /**
   * Records the durable cancellation intent. Cancellation completes only once no
   * Attempt is active or UNKNOWN; repeating the call is idempotent.
   */
  readonly cancelRun: (input: {
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
    readonly expectedRevision: number
    readonly resultDigest?: string
    readonly failureCode?: string
    readonly retryable?: boolean
  }) => Effect.Effect<DirectAttemptSettlement, ManagedControlError, SessionSupervisorService>
  readonly cancelDirectAttempt: (input: {
    readonly attemptID: string
    readonly expectedRevision: number
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
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_U64) {
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
  const keys = [...stringKeys, "resourceLeaseIDs"].toSorted()
  if (Object.keys(value).toSorted().join("\0") !== keys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "managed dispatch handoff has an invalid shape" })
  }
  const result = Object.fromEntries(stringKeys.map((key) => [key, requiredText(operation, value, key, 256)])) as unknown as Omit<ManagedDispatchHandoffV1, "resourceLeaseIDs" | "expectedManagedRevision" | "ownerEpoch" | "profileRevision" | "budgetAmount" | "leaseExpiresAtMs" | "claimOwnerLogSequence" | "workerPoolRevision" | "worktreePoolRevision">
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
  if (new Set(resourceLeaseIDs).size !== resourceLeaseIDs.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "resourceLeaseIDs contains duplicates" })
  }
  for (const key of ["handoffDigest", "profileDigest", "permissionScopeDigest", "acceptedSpecDigest", "workspaceRevision", "contextSelectionDigest", "acceptedScopeDigest", "capabilityCeilingDigest", "claimOwnerLogEventDigest", "claimedProofDigest", "claimNonce", "bindingDigest", "pinsDigest"] as const) {
    digestValue(operation, value[key] as string, key)
  }
  return { ...result, ...Object.fromEntries(["expectedManagedRevision", "ownerEpoch", "profileRevision", "budgetAmount", "leaseExpiresAtMs", "claimOwnerLogSequence", "workerPoolRevision", "worktreePoolRevision"].map((key) => [key, value[key]])), resourceLeaseIDs } as ManagedDispatchHandoffV1
}

function decodeManagedDispatchConsumeReceipt(operation: string, response: Record<string, unknown>): ManagedDispatchConsumeReceiptV1 {
  requireStatus(operation, response, "CONSUMED")
  const textFields = [
    "goalID", "runID", "taskID", "parentSessionID", "sessionID", "attemptID", "handoffID", "handoffDigest", "claimedProofDigest", "workerExecutionID",
    "pinsDigest", "bindingDigest", "claimNonce", "claimOwnerLogID", "claimOwnerLogSequence", "claimOwnerLogEventDigest",
    "workerPoolRevision", "ownerEpoch", "processIncarnation", "deliveryID", "coreStartIdentity", "coreExecutableDigest",
    "consumedManagedRevision", "receiptDigest",
  ] as const
  const keys = [...textFields, "status", "corePID", "coreUID", "coreGID"].toSorted()
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
  return Object.fromEntries([...textFields.map((key) => [key, requiredText(operation, response, key, 256)]), ...(["corePID", "coreUID", "coreGID"] as const).map((key) => [key, requiredInteger(operation, response, key)]) , ["status", "CONSUMED"]]) as unknown as ManagedDispatchConsumeReceiptV1
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
    const taskKeys = ["taskID", "candidateAttemptID", "attemptCount", "candidateGeneration", "taskRevision", "dependencies", "criterionIDs", "criteria", "requiredCapabilities", "profile"].toSorted()
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
    const profileDigest = digestValue(operation, requiredText(operation, profileValue, "definitionDigest", 256), "profile.definitionDigest")
    if (!profileDigest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: "profile definition digest must use BLAKE3" })
    task = {
      taskID: identifier(operation, requiredText(operation, value, "taskID", 256), "taskID"),
      candidateAttemptID: identifier(operation, requiredText(operation, value, "candidateAttemptID", 256), "candidateAttemptID"),
      attemptCount: value.attemptCount as string,
      candidateGeneration: value.candidateGeneration as string,
      taskRevision: value.taskRevision as string,
      dependencies: stringList(operation, value.dependencies as readonly string[], "dependencies").map((id) => identifier(operation, id, "dependencies")),
      criterionIDs,
      criteria,
      requiredCapabilities: stringList(operation, value.requiredCapabilities as readonly string[], "requiredCapabilities").map((id) => identifier(operation, id, "requiredCapabilities")),
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
  const profileRevision = requiredRevision(operation, value, "profileRevision")
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
    ownerEpoch: requiredRevision(operation, value, "ownerEpoch"),
    expectedRevision: requiredRevision(operation, value, "expectedRevision"),
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
  const acceptedSpecs: Array<{ specID: string; specDigest: string }> = []
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
      acceptedSpecs.push({
        specID,
        specDigest: digestValue(operation, requiredText(operation, spec, "specDigest", 256), "specDigest"),
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

  return { goalID, goalRevision, projectRef, workspaceRef, proposals, acceptedSpecs, runs }
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

function decodeManagedDispatchSettlementReceipt(
  operation: string,
  response: Record<string, unknown>,
): ManagedDispatchSettlementReceiptV1 {
  requireStatus(operation, response, "SETTLED")
  const fields = [
    "goalID", "runID", "taskID", "attemptID", "workerExecutionID", "disposition", "proofDigest",
    "ownerLogID", "ownerLogSequence", "ownerLogEventDigest", "workerPoolRevision", "receiptDigest",
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
  return Object.fromEntries([
    ...fields.map((key) => [key, requiredText(operation, response, key, 256)]),
    ["status", "SETTLED"],
  ]) as unknown as ManagedDispatchSettlementReceiptV1
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

function decodeVerificationStarted(operation: string, response: Record<string, unknown>): VerificationStarted {
  requireStatus(operation, response, "NEEDS_APPROVAL")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  if (
    !Array.isArray(response.challenges) ||
    response.challenges.length === 0 ||
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
          ? { status: "unavailable", reason: requiredText(operation, argumentSummaryValue, "reason", 128) }
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
      requestedGuarantees.length > 64 ||
      !requestedGuarantees.every((item) => typeof item === "string" && item.length <= 128)
    ) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier Guard projection is invalid" })
    }
    const guaranteeValue = requiredRecord(operation, challenge.guaranteeAssessment, "guaranteeAssessment")
    const guaranteeStatus = requiredText(operation, guaranteeValue, "status", 32)
    const guaranteeResidual = guaranteeValue.residual
    const guaranteeAssessment: GuardGuaranteeAssessmentV1 =
      guaranteeStatus === "not_assessed" && guaranteeResidual === null
        ? { status: "not_assessed", residual: null }
        : guaranteeStatus === "assessed" && Array.isArray(guaranteeResidual) &&
            guaranteeResidual.every((item) => typeof item === "string" && item.length <= 128)
          ? { status: "assessed", residual: guaranteeResidual }
          : (() => {
              throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier guarantee assessment is invalid" })
            })()
    return {
      criterionID: identifier(operation, requiredText(operation, challenge, "criterionID", 256), "criterionID"),
      challengeID: identifier(operation, requiredText(operation, challenge, "challengeID", 256), "challengeID"),
      effectID: identifier(operation, requiredText(operation, challenge, "effectID", 256), "effectID"),
      capabilityID,
      locationID: identifier(operation, requiredText(operation, challenge, "locationID", 256), "locationID"),
      inputDigest: digestValue(operation, requiredText(operation, challenge, "inputDigest", 256), "inputDigest"),
      normalizedTargets,
      expiresAtUnixMs,
      policySummary: requiredText(operation, challenge, "policySummary", 1024),
      origin,
      source,
      policyID: identifier(operation, requiredText(operation, challenge, "policyID", 256), "policyID"),
      policyDigest: digestValue(operation, requiredText(operation, challenge, "policyDigest", 256), "policyDigest"),
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
      allowEnabled: requiredBoolean(operation, challenge, "allowEnabled"),
    }
  })
  const criteria = new Set(challenges.map((challenge) => challenge.criterionID))
  const challengeIDs = new Set(challenges.map((challenge) => challenge.challengeID))
  const effectIDs = new Set(challenges.map((challenge) => challenge.effectID))
  if (criteria.size !== challenges.length || challengeIDs.size !== challenges.length || effectIDs.size !== challenges.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verifier challenges are duplicated" })
  }
  return {
    status: "NEEDS_APPROVAL",
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID,
    finalRevision: digestValue(operation, requiredText(operation, response, "finalRevision", 256), "finalRevision"),
    verificationRunID: identifier(operation, requiredText(operation, response, "verificationRunID", 256), "verificationRunID"),
    challengeSetDigest: digestValue(operation, requiredText(operation, response, "challengeSetDigest", 256), "challengeSetDigest"),
    challenges,
    revision: requiredRevision(operation, response, "revision"),
  }
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
  expected: VerificationStarted,
): VerificationApprovalResolution {
  const goalID = identifier(operation, requiredText(operation, response, "goalID", 256), "goalID")
  const runID = identifier(operation, requiredText(operation, response, "runID", 256), "runID")
  const verificationRunID = identifier(
    operation,
    requiredText(operation, response, "verificationRunID", 256),
    "verificationRunID",
  )
  const challengeSetDigest = digestValue(
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
  if (!Array.isArray(response.leases) || response.leases.length !== expected.challenges.length) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "approved lease set is incomplete" })
  }
  const expectedByChallenge = new Map(expected.challenges.map((challenge) => [challenge.challengeID, challenge]))
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
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN",
    "NEEDS_YOU",
    "CANCELLING",
    "CANCELLED",
  ])
  if (!statuses.has(status)) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "verification result status is invalid" })
  }
  return {
    status: status as VerificationExecutionStatus,
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    verificationRunID: identifier(
      operation,
      requiredText(operation, response, "verificationRunID", 256),
      "verificationRunID",
    ),
    revision: requiredRevision(operation, response, "revision"),
  }
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
  return {
    goalID: identifier(operation, requiredText(operation, response, "goalID", 256), "goalID"),
    runID: identifier(operation, requiredText(operation, response, "runID", 256), "runID"),
    runPhase: managedRunPhase(operation, response.runPhase),
    revision: requiredRevision(operation, response, "revision"),
  }
}

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
  const body = {
    goalID: identifier(operation, input.goalID, "goalID"),
    specID: identifier(operation, input.specID, "specID"),
    objective: input.objective,
    projectRef: identifier(operation, input.projectRef, "projectRef"),
    workspaceRef: identifier(operation, input.workspaceRef, "workspaceRef"),
    capabilityScope: stringList(operation, input.capabilityScope, "capabilityScope"),
    scope: stringList(operation, input.scope, "scope"),
    constraints: stringList(operation, input.constraints, "constraints"),
    criteria: input.criteria.map((criterion) => ({
      id: identifier(operation, criterion.id, "criterion id"),
      description: criterion.description,
    })),
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
  if (input.objective.trim().length === 0 || Buffer.byteLength(input.objective, "utf8") > MAX_TEXT_BYTES) {
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
  return {
    ...snapshot,
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
  if (!/^(0|[1-9][0-9]{0,19})$/.test(expectedGoalRevision) || BigInt(expectedGoalRevision) > 18_446_744_073_709_551_615n) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedGoalRevision is not a canonical u64" })
  }
  if (input.tasks.length === 0 || input.tasks.length > 64) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "V1 Run plan must contain between one and 64 Tasks" })
  }
  const projectRef = identifier(operation, input.projectRef, "projectRef")
  const workspaceRef = identifier(operation, input.workspaceRef, "workspaceRef")
  const response = yield* call(operation, { goalID }, undefined, trustedPrincipal)
  const snapshot = yield* decode(operation, response, (name, value) => {
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
        return { taskID, dependencies, criterionIDs, requiredCapabilities, profileSelection }
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
    const phase = requiredText(name, value, "runPhase", 32)
    if (phase !== "PLAN_ONLY" || requiredBoolean(name, value, "tasksReady")) {
      throw new ManagedControlError({ operation: name, code: "managed_protocol", reason: "kernel returned a dispatchable plan" })
    }
    return { revision: requiredRevision(name, value, "revision") }
  })
  return {
    status: "PLAN_ONLY" as const,
    executionAvailable: false as const,
    goalID,
    runID,
    specID,
    runPhase: "PLAN_ONLY",
    taskIDs: tasks.map((task) => task.taskID),
    tasksReady: false as const,
    revision: planned.revision,
    reason: "Tasks are recorded for review only; guarded Attempt admission is unavailable until its authenticated P1/P8 owner proofs are accepted.",
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
  if (!/^(0|[1-9][0-9]{0,19})$/.test(expectedGoalRevision) || BigInt(expectedGoalRevision) > 18_446_744_073_709_551_615n) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedGoalRevision is not a canonical u64" })
  }
  const idempotencyKey = identifier(operation, input.idempotencyKey, "idempotencyKey")
  const sessionID = identifier(operation, input.sessionID, "sessionID")
  const projectRef = identifier(operation, input.projectRef, "projectRef")
  const workspaceRef = identifier(operation, input.workspaceRef, "workspaceRef")
  const link = input.sessionLink
  const linkSessionID = identifier(operation, link.sessionID, "sessionLink.sessionID")
  const sourceStoreID = identifier(operation, link.sourceStoreID, "sessionLink.sourceStoreID")
  const sourceInstanceID = identifier(operation, link.sourceInstanceID, "sessionLink.sourceInstanceID")
  const sourceEpoch = canonicalDecimalU64(operation, link.sourceEpoch, "sessionLink.sourceEpoch")
  const protocolVersion = 1
  const cursorSeq = canonicalDecimalU64(operation, link.sourceCursor.seq, "sessionLink.sourceCursor.seq")
  if (linkSessionID !== sessionID || link.sourceCursor.ownerKind !== "session" ||
    link.sourceCursor.ownerId !== sessionID || cursorSeq < 1n || sourceEpoch < 1n ||
    !/^blake3:[0-9a-f]{64}$/.test(link.sourceCursor.eventDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(link.sourceDigest) ||
    link.redactionProfile !== "horizon.session-link.ids-only.v1" || link.protocolVersion !== protocolVersion ||
    link.goalID !== goalID || link.projectID !== projectRef || link.workspaceID !== workspaceRef ||
    (link.latestObservedMessageID !== null && !IDENTIFIER.test(link.latestObservedMessageID)) ||
    (link.latestObservedPartID !== null && !IDENTIFIER.test(link.latestObservedPartID))) {
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
  readonly contextSelection: ContextSelection
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
  const profileRevisionNumber = Number(profileRevision)
  if (!Number.isSafeInteger(profileRevisionNumber) || profileRevisionNumber < 1) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "AgentProfile revision exceeds the Core Config revision range" })
  }
  const profiles = yield* AgentProfileService
  const configuredProfile = yield* Effect.mapError(
    profiles.agentProfile(profileID, profileRevisionNumber),
    (error) => new ManagedControlError({ operation, code: "agent_profile_unavailable", reason: error.message }),
  )
  const profileDefinition = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2, { onExcessProperty: "error" })(configuredProfile),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "AgentProfile definition is invalid" }),
  })
  if (profileDefinition.profileId !== profileID || String(profileDefinition.revision) !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "agent_profile_stale", reason: "AgentProfile definition does not match the exact selection" })
  }
  const contextSelection = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(input.contextSelection),
    catch: () => new ManagedControlError({ operation, code: "managed_protocol", reason: "ContextSelectionV1 is invalid" }),
  })
  if (contextSelection.sessionID === input.sessionID) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "managed child context must be selected from the authorized parent Session" })
  }
  const response = yield* call(
    operation,
    {
      goalID,
      runID,
      taskID,
      attemptID,
      parentSessionID: identifier(operation, input.parentSessionID, "parentSessionID"),
      locationID: identifier(operation, input.locationID, "locationID"),
      sessionID: identifier(operation, input.sessionID, "sessionID"),
      expectedRevision: expectedRevision(operation, input.expectedRevision),
      profileSelection: { profileId: profileID, revision: profileRevision.toString() },
      profileDefinition,
      contextSelection,
    },
    oneUseKey(attemptID, "admit"),
  )
  const decoded = yield* decode(operation, response, decodeManagedAttemptAdmission)
  yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID, taskID, attemptID }))
  if (decoded.profile.profileID !== profileID || decoded.profile.profileRevision !== profileRevision.toString()) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "HostKernel admitted a different AgentProfile revision" })
  }
  return decoded
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
    profiles.agentProfile(profileID, Number(profileRevision)),
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
    receipt.claimedProofDigest !== handoff.claimedProofDigest || receipt.pinsDigest !== handoff.pinsDigest || receipt.deliveryID !== deliveryID) {
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
  }, deliveryID, input.trustedPrincipal)
  const receipt = yield* decode(operation, response, decodeManagedDispatchQuiescedReceipt)
  if (receipt.goalID !== handoff.goalID || receipt.runID !== handoff.runID || receipt.taskID !== handoff.taskID ||
    receipt.parentSessionID !== handoff.parentSessionID || receipt.sessionID !== handoff.sessionID ||
    receipt.attemptID !== handoff.attemptID || receipt.handoffID !== handoff.handoffID ||
    receipt.handoffDigest !== handoff.handoffDigest || receipt.consumeDeliveryID !== consumed.deliveryID ||
    receipt.consumeReceiptDigest !== consumed.receiptDigest || receipt.ownerEpoch !== handoff.ownerEpoch ||
    receipt.processIncarnation !== handoff.processIncarnation || receipt.childSessionSequence !== childSessionSequence.toString() ||
    receipt.childSessionEventDigest !== childSessionEventDigest || receipt.childSessionStateDigest !== childSessionStateDigest ||
    receipt.deliveryID !== deliveryID) {
    return yield* Effect.fail(new ManagedControlError({
      operation, code: "managed_protocol", reason: "HostKernel quiescence receipt does not match the exact completed child",
    }))
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
    "childSessionEventDigest", "childSessionStateDigest", "deliveryID", "managedRevision", "ownerLogID",
    "ownerLogSequence", "ownerLogEventDigest", "receiptDigest",
  ] as const
  const expectedKeys = [...stringFields, "status"].toSorted()
  if (Object.keys(response).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new ManagedControlError({ operation, code: "managed_protocol", reason: "quiescence receipt has an invalid shape" })
  }
  for (const key of ["ownerEpoch", "childSessionSequence", "managedRevision", "ownerLogSequence"] as const) {
    requiredDecimalU64(operation, response, key)
  }
  for (const key of ["handoffDigest", "consumeReceiptDigest", "childSessionEventDigest", "childSessionStateDigest", "ownerLogEventDigest", "receiptDigest"] as const) {
    const digest = digestValue(operation, requiredText(operation, response, key, 256), key)
    if (!digest.startsWith("blake3:")) throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${key} must use BLAKE3` })
  }
  for (const key of ["goalID", "runID", "taskID", "parentSessionID", "sessionID", "attemptID", "handoffID", "consumeDeliveryID", "processIncarnation", "deliveryID", "ownerLogID"] as const) {
    identifier(operation, requiredText(operation, response, key, 256), key)
  }
  return Object.fromEntries([...stringFields.map((key) => [key, requiredText(operation, response, key, 256)]), ["status", "QUIESCED"]]) as unknown as ManagedDispatchQuiescedReceiptV1
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

function managedAttemptScopeValue(operation: string, scope: ManagedAttemptScopeV1) {
  const keys = [
    "goalID",
    "runID",
    "taskID",
    "attemptID",
    "ownerEpoch",
    "expectedManagedRevision",
    "locationID",
    "sessionID",
    "workspaceRevision",
    "delegationBindingDigest",
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
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
      throw new ManagedControlError({ operation, code: "managed_protocol", reason: `${name} is not a canonical u64 string` })
    }
    return value
  }
  return {
    goalID: identifier(operation, scope.goalID, "goalID"),
    runID: identifier(operation, scope.runID, "runID"),
    taskID: identifier(operation, scope.taskID, "taskID"),
    attemptID: identifier(operation, scope.attemptID, "attemptID"),
    ownerEpoch: counter("ownerEpoch", scope.ownerEpoch),
    expectedManagedRevision: counter("expectedManagedRevision", scope.expectedManagedRevision),
    locationID: identifier(operation, scope.locationID, "locationID"),
    sessionID: identifier(operation, scope.sessionID, "sessionID"),
    workspaceRevision: digestValue(operation, scope.workspaceRevision, "workspaceRevision"),
    delegationBindingDigest: digestValue(operation, scope.delegationBindingDigest, "delegationBindingDigest"),
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
  const response = yield* call(operation, body, oneUseKey(attemptID, "settle"))
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
}) {
  const operation = "settle_dispatch"
  const trustedPrincipal = yield* serverAuthPrincipal(operation, input.trustedPrincipal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const taskID = identifier(operation, input.taskID, "taskID")
  const attemptID = identifier(operation, input.attemptID, "attemptID")
  const deliveryID = identifier(operation, input.deliveryID, "deliveryID")
  const response = yield* call(operation, { goalID, runID, taskID, attemptID }, deliveryID, trustedPrincipal)
  const receipt = yield* decode(operation, response, decodeManagedDispatchSettlementReceipt)
  if (receipt.goalID !== goalID || receipt.runID !== runID || receipt.taskID !== taskID || receipt.attemptID !== attemptID) {
    return yield* new ManagedControlError({ operation, code: "managed_protocol", reason: "P8 settlement receipt identifies another managed child" })
  }
  return receipt
})

const phaseChange = (
  operation: "pause_run" | "resume_run",
  expected: { readonly status: "PAUSED" | "RUNNING"; readonly runPhase: ManagedRunPhase },
  input: { readonly goalID: string; readonly runID: string; readonly expectedRevision: ManagedRevision },
) =>
  Effect.gen(function* () {
    const goalID = identifier(operation, input.goalID, "goalID")
    const runID = identifier(operation, input.runID, "runID")
    const revision = expectedRevision(operation, input.expectedRevision)
    const response = yield* call(
      operation,
      { goalID, runID, expectedRevision: revision },
      oneUseKey(runID, operation === "pause_run" ? "pause" : "resume", revision.toString()),
    )
    const decoded = yield* decode(operation, response, (name, value) => decodeRunPhaseChange(name, value, expected))
    yield* decode(operation, { ...decoded }, (name, value) => expectEcho(name, value, { goalID, runID }))
    return decoded
  })

export const pauseRun = Effect.fn("ManagedControl.pauseRun")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* phaseChange("pause_run", { status: "PAUSED", runPhase: "PAUSED" }, input)
})

export const resumeRun = Effect.fn("ManagedControl.resumeRun")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  return yield* phaseChange("resume_run", { status: "RUNNING", runPhase: "RUNNING" }, input)
})

export const cancelRun = Effect.fn("ManagedControl.cancelRun")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly expectedRevision: ManagedRevision
}) {
  const operation = "cancel"
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  const revision = expectedRevision(operation, input.expectedRevision)
  const response = yield* call(
    operation,
    { goalID, runID, expectedRevision: revision },
    oneUseKey(runID, "cancel", revision.toString()),
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
  readonly locationRef: typeof Location.Ref.Type
  readonly sessionID?: string
}) {
  const operation = "begin_verification"
  const authenticated = yield* TrustedPrincipalContext
  const trustedPrincipal = yield* serverAuthPrincipal(operation, authenticated.principal)
  const goalID = identifier(operation, input.goalID, "goalID")
  const runID = identifier(operation, input.runID, "runID")
  // A fresh user lifecycle gets a distinct delivery key so a terminal aborted
  // challenge set does not block a later deliberate retry. Keep this UUID stable
  // for every begin request made during this lifecycle.
  const deliveryID = randomUUID()
  const started = yield* beginVerification({ trustedPrincipal, goalID, runID, deliveryID })
  const supervisor = yield* SessionSupervisor.Service
  const challenges: ManagedVerifierGuardChallengeV1[] = started.challenges.map(({ criterionID: _criterionID, ...item }) => item)

  const resolve = (resolution: Readonly<Record<string, unknown>>) =>
    call(
      "resolve_verification_approvals",
      {
        goalID,
        runID,
        verificationRunID: started.verificationRunID,
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
        verificationRunID: started.verificationRunID,
        reason,
        revision: decoded.revision,
      }
    })

  const collection: ManagedVerifierApprovalCollectionV1 = yield* supervisor
    .awaitManagedVerifierApprovals({
      locationRef: input.locationRef,
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
      verificationRunID: started.verificationRunID,
      reason: resolved.reason,
      revision: resolved.revision,
    }
  }

  const executeOperation = "execute_verification"
  const execution = yield* call(
    executeOperation,
    { goalID, runID, verificationRunID: started.verificationRunID, challengeSetDigest: started.challengeSetDigest },
    oneUseKey(started.verificationRunID, "execute"),
    trustedPrincipal,
  )
  const result = yield* decode(executeOperation, execution, decodeVerificationRunResult)
  yield* decode(executeOperation, { ...result }, (name, value) =>
    expectEcho(name, value, { goalID, runID, verificationRunID: started.verificationRunID }),
  )
  return result
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
    ownerEpoch: expectedRevision(operation, scope.ownerEpoch),
    expectedRevision: expectedRevision(operation, scope.expectedRevision),
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
  readonly expectedRevision: number
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
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedRevision is invalid" }),
    )
  }
  const body: Record<string, unknown> = {
    attemptID,
    outcome: input.outcome,
    expectedRevision: input.expectedRevision,
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
  readonly expectedRevision: number
}) {
  const operation = "cancel_direct_attempt"
  if (!ATTEMPT_ID.test(input.attemptID)) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "attemptID is invalid" }),
    )
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return yield* Effect.fail(
      new ManagedControlError({ operation, code: "managed_protocol", reason: "expectedRevision is invalid" }),
    )
  }
  const response = yield* call(
    operation,
    { attemptID: input.attemptID, expectedRevision: input.expectedRevision },
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
  return yield* decode(operation, response, decodeDirectAttempt)
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
