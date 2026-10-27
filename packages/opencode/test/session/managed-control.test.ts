import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  SessionSupervisor,
  SessionSupervisorError,
  type ManagedVerifierApprovalCollectionV1,
} from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentProfileService } from "@opencode-ai/core/config"
import { Effect, Layer, Schema, Stream } from "effect"
import { Info as ProviderInfoSchema, Service as ProviderService } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Service as AuthService } from "@/auth"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  ManagedControl,
  ManagedControlError,
  decodeHostRunDispatchBindingReceipt,
  decodeHostRunDispatchP8OwnerReceipt,
  decodeHostRunReconciliation,
  type VerificationRunResult,
} from "@/session/managed-control"
import { executeNextManagedTask } from "@/session/managed-run-coordinator"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { ContextSelectionV1 } from "@opencode-ai/schema/context-selection-v1"
import { testEffect } from "../lib/effect"

const RECEIPT = `blake3:${"a".repeat(64)}`
// Derived from the stable ChallengeSet identity, as HostKernel requires.
const VERIFICATION_RUN_ID = `verification_${"a".repeat(64)}`
// Final-Inspect binds the exact canonical child identity patterns.
const ATTEMPT_ID = `attempt_${"c".repeat(64)}`
const LOCATION_ID = `loc_${"d".repeat(64)}`
const SCOPE = `sha256:${"b".repeat(64)}`
const CONTEXT_SELECTION_DIGEST = `blake3:${"c".repeat(64)}`

const hostRunBindingFixture = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  dispatchKeyDigest: RECEIPT,
  manifestDigest: RECEIPT,
  evaluatorTaskId: "evaluator-one",
  armId: "arm-one",
  taskGroup: "group-one",
  runId: "run-one",
  managedTaskId: "task-one",
  attemptId: ATTEMPT_ID,
  evaluationSessionId: "ses_root000000000000000000000001",
  coreProcessGeneration: "1",
  ownerId: "owner-one",
  ownerEpoch: "1",
  workerExecutionId: "worker-one",
  delegationBindingDigest: RECEIPT,
  acceptedSpecDigest: RECEIPT,
  providerSelectionDigest: RECEIPT,
  workspaceBindingDigest: RECEIPT,
  admittedWorkspaceRevision: RECEIPT,
  attemptScopeDigest: RECEIPT,
  ownerPrincipalBindingDigest: RECEIPT,
  bindingDigest: RECEIPT,
  ...overrides,
})
// Exact deterministic route projection over the TEST_PROVIDER_INFO fixture,
// mirroring provider.ts's managed route derivation byte-for-byte.
const TEST_ROUTE_MATERIAL = JSON.stringify([
  "horizoncode.managed-provider-route.v1",
  "test",
  "test-model",
  "@ai-sdk/anthropic",
  "anthropic",
])
const TEST_ROUTE_ID = `llm_${bytesToHex(blake3(new TextEncoder().encode(TEST_ROUTE_MATERIAL)))}`
const TEST_ENDPOINT_REVISION = `blake3:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([
  "horizoncode.managed-provider-endpoint.v1",
  TEST_ROUTE_MATERIAL,
  "https://api.example.test/v1",
]))))}`
const DIRECT_FACTS = {
  locationID: "location-one",
  workspaceID: "workspace-one",
  capabilityDigest: `sha256:${"c".repeat(64)}`,
  permissionsDigest: `sha256:${"d".repeat(64)}`,
  budgetDigest: `sha256:${"e".repeat(64)}`,
  workspaceRevision: `blake3:${"f".repeat(64)}`,
} as const
const DIRECT_PROFILE = Schema.decodeUnknownSync(AgentProfileV2.AgentProfileDefinitionV2)({
  schemaVersion: 2,
  profileId: "specialist.reader",
  revision: "1",
  name: "Reader",
  description: "Read-only specialist",
  source: "user",
  roles: ["subagent"],
  purpose: "Inspect code",
  whenToUse: "When exploring",
  whenNotToUse: "When editing",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "test", modelId: "test-model" },
  harness: "native-rich",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: "4096" },
  tools: [{ effect: "allow", toolPattern: "files.read" }],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [],
  context: { isolation: "fresh", allowImages: true, allowDocuments: true, allowArtifacts: true },
  inputMode: "default",
  memoryPolicy: "none",
  isolation: "workspace",
  lifecycleHooks: [],
  capabilityCeiling: [],
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
})
const DIRECT_PROFILE_SELECTION = { profileId: "specialist.reader", revision: "1" } as const
const DIRECT_PROFILE_DIGEST = `blake3:${"f".repeat(64)}`
const REVIEWER = { kind: "server_auth", subject: "reviewer" } as const
const verifierGuardProjection = () => ({
  origin: "managed_run",
  source: "host.managed_verifier",
  policyID: "policy-verifier-v1",
  policyDigest: RECEIPT,
  normalizedAction: "builtin.verifier",
  argumentSummary: { status: "available", text: "Run the host-selected verifier for this accepted criterion" },
  requestedGuarantees: ["bounded_execution"],
  guaranteeAssessment: { status: "not_assessed", residual: null },
  runID: "run-client",
  noResponse: "deny_and_expire",
  allowEnabled: false,
} as const)

type Call = {
  readonly serviceID: string
  readonly operation: string
  readonly body: Record<string, unknown>
  readonly deliveryID?: string
  readonly trustedPrincipal?: { readonly kind: "server_auth"; readonly subject: string } | { readonly kind: "host_os" }
}

class FakeHostKernel {
  readonly calls: Call[] = []
  hosted = true
  failingOperation: { operation: string; code: string; reason: string } | null = null
  admitted = false
  specDecisionResponse: Record<string, unknown> | null = null
  directAttemptSettlementResponse: Record<string, unknown> | null = null
  directAttemptCancellationResponse: Record<string, unknown> | null = null
  goalSnapshotResponse: Record<string, unknown> | null = null
  /** Per-operation overrides modelling exact or malformed kernel responses. */
  managedResponses: Record<string, Record<string, unknown>> = {}
  approvalWindows: ReadonlyArray<unknown>[] = []
  approvalDecisions: ReadonlyArray<{ challengeID: string; decision: "allow_once" | "deny" }> | null = null
  approvalResult: ManagedVerifierApprovalCollectionV1 | null = null
  interruptApprovals = false

  handle(
    serviceID: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    options?: {
      readonly deliveryID?: string
      readonly trustedPrincipal?: Call["trustedPrincipal"]
    },
  ): Effect.Effect<Record<string, unknown>, SessionSupervisorError> {
    const self = this
    return Effect.gen(function* () {
      // Mirrors the real supervisor: with no host-kernel channel configured, every
      // host RPC fails before it is sent.
      if (!self.hosted) {
        return yield* Effect.fail(
          new SessionSupervisorError({ stage: "host-kernel", reason: "host kernel is unavailable" }),
        )
      }
      self.calls.push({
        serviceID,
        operation,
        body: { ...body },
        ...(options?.deliveryID === undefined ? {} : { deliveryID: options.deliveryID }),
        ...(options?.trustedPrincipal === undefined ? {} : { trustedPrincipal: options.trustedPrincipal }),
      })
      if (self.failingOperation && self.failingOperation.operation === operation) {
        const failure = self.failingOperation
        return yield* Effect.fail(
          new SessionSupervisorError({ stage: "effect", reason: failure.reason, hostCode: failure.code }),
        )
      }
      if (serviceID !== "managed.v1") {
        return yield* Effect.fail(new SessionSupervisorError({ stage: "effect", reason: "service is unavailable" }))
      }
      const override = self.managedResponses[operation]
      if (override) return override
      if (operation === "admit") {
        // Mirror HostKernel's `strict_fields(body, required, &[])`: any key
        // outside the closed admit set is rejected before admission logic.
        const bodyKeys = Object.keys(body)
        if (
          bodyKeys.length !== ManagedControl.ADMIT_BODY_KEYS.length ||
          bodyKeys.some((key) => !ManagedControl.ADMIT_BODY_KEYS.includes(key))
        ) {
          return yield* Effect.fail(
            new SessionSupervisorError({ stage: "effect", reason: "invalid_effect_request" }),
          )
        }
        // HostKernel derives the admitted profile from the validated
        // `profileDefinition` body key; `profileSelection` is not part of the
        // closed admit key set and is never sent.
        const selection = body.profileDefinition as { profileId: string; revision: string }
        const contextSelection = body.contextSelection as { requestID?: unknown }
        const requestID = String(contextSelection.requestID ?? `req_managed_${String(body.attemptID)}_1`)
        const managedAttempt = {
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: String(body.taskID),
          attemptID: String(body.attemptID),
          ownerEpoch: "7",
          expectedManagedRevision: "5",
          requestSequence: "1",
          requestID,
          contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
          locationID: String(body.locationID),
          sessionID: String(body.sessionID),
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          effectiveMaxTokens: "5000",
          remainingTokens: "5000",
          delegationBindingDigest: `blake3:${"a".repeat(64)}`,
          permissionScopeDigest: `blake3:${"d".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree-1",
            worktreeBaseRevision: "base-1",
            worktreePoolRevision: "3",
            locationID: String(body.locationID),
            workspaceID: "workspace-1",
            workspaceRef: "refs/heads/managed",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
          },
        }
        return {
          status: "ADMITTED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: String(body.taskID),
          attemptID: String(body.attemptID),
          parentSessionID: String(body.parentSessionID),
          ownerEpoch: 7n,
          locationID: String(body.locationID),
          sessionID: String(body.sessionID),
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          attemptPhase: "EXECUTING",
          runPhase: "RUNNING",
          revision: 5n,
          requestSequence: 1,
          requestID,
          contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
          profile: {
            profileID: selection.profileId,
            profileRevision: 1,
            profileDigest: DIRECT_PROFILE_DIGEST,
          },
          managedProviderRoute: body.managedProviderRoute,
          managedAttempt,
        }
      }
      if (operation === "bind_attempt_effect") {
        return {
          status: "BOUND",
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: String(body.taskID),
          attemptID: String(body.attemptID),
          effectID: String(body.effectID),
          locationID: String(body.locationID),
          revision: 6n,
        }
      }
      if (operation === "settle") {
        const outcome = String(body.outcome).toUpperCase()
        return {
          status: "SETTLED",
          outcome,
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: String(body.taskID),
          attemptID: String(body.attemptID),
          attemptPhase: outcome,
          runPhase: outcome === "UNKNOWN" ? "RECONCILING" : "RUNNING",
          receiptDigest: outcome === "SUCCEEDED" ? RECEIPT : null,
          revision: 7n,
        }
      }
      if (operation === "pause_run") {
        return {
          status: "PAUSED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          runPhase: "PAUSED",
          revision: 8n,
        }
      }
      if (operation === "resume_run") {
        return {
          status: "RUNNING",
          goalID: String(body.goalID),
          runID: String(body.runID),
          runPhase: "RUNNING",
          revision: 9n,
        }
      }
      if (operation === "cancel") {
        return {
          status: "CANCELLING",
          goalID: String(body.goalID),
          runID: String(body.runID),
          runPhase: "CANCELLING",
          revision: 10n,
        }
      }
      if (operation === "begin_verification") {
        const started = {
          status: "NEEDS_APPROVAL",
          schemaVersion: 1,
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: "task-client",
          attemptID: ATTEMPT_ID,
          ownerEpoch: "7",
          specID: "spec-client",
          specDigest: RECEIPT,
          profileID: DIRECT_PROFILE.profileId,
          profileRevision: "1",
          profileDigest: DIRECT_PROFILE_DIGEST,
          evidencePlanDigest: RECEIPT,
          setIdentityDigest: RECEIPT,
          verificationRunID: `verification_${"a".repeat(64)}`,
          challengeSetDigest: RECEIPT,
          finalRevision: RECEIPT,
          approvalLocation: {
            locationID: LOCATION_ID,
            workspaceID: "wrk_client_workspace",
            canonicalRoot: "/workspace/client",
            workspaceRevision: RECEIPT,
          },
          evidenceDigest: null,
          artifactRefs: [],
          challenges: [
            {
              ...verifierGuardProjection(),
              criterionID: "tests-pass",
              challengeID: "challenge-verifier-1",
              effectID: "effect-verifier-1",
              capabilityID: "builtin.verifier",
              locationID: LOCATION_ID,
              inputDigest: RECEIPT,
              normalizedTargets: [{ criterionID: "tests-pass" }],
              expiresAtUnixMs: Date.now() + 60_000,
              policySummary: "Run the approved verifier profile for this criterion.",
            },
          ],
          revision: 11n,
        }
        self.managedResponses.begin_verification = started
        return started
      }
      if (operation === "resolve_verification_approvals") {
        const challenges = self.managedResponses.begin_verification?.challenges as
          | ReadonlyArray<Record<string, unknown>>
          | undefined
        const resolution = body.resolution as Record<string, unknown> | undefined
        if (resolution?.kind === "abort") {
          return {
            status: "ABORTED",
            goalID: String(body.goalID),
            runID: String(body.runID),
            verificationRunID: String(body.verificationRunID),
            challengeSetDigest: String(body.challengeSetDigest),
            reason: resolution.reason,
            decisionsPersisted: Array.isArray(resolution.decisions) ? resolution.decisions.length : 0,
            leases: [],
            revision: 12n,
          }
        }
        return {
          status: "APPROVED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          verificationRunID: String(body.verificationRunID),
          challengeSetDigest: String(body.challengeSetDigest),
          leases: (challenges ?? []).map((challenge) => ({
            criterionID: challenge.criterionID,
            challengeID: challenge.challengeID,
            effectID: challenge.effectID,
            capabilityLeaseDigest: RECEIPT,
          })),
          revision: 12n,
        }
      }
      if (operation === "execute_verification") {
        const begun = self.managedResponses.begin_verification as
          | { challenges?: ReadonlyArray<Record<string, unknown>> }
          | undefined
        const artifactRefs = (begun?.challenges ?? []).map((challenge) => ({
          criterionID: challenge.criterionID,
          artifactRefs: [
            {
              artifactID: "artifact-verifier",
              digest: RECEIPT,
              byteLength: "12",
              mediaType: "text/plain",
              classification: "WORKSPACE",
            },
          ],
        }))
        return {
          status: "SETTLING",
          schemaVersion: 1,
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: "task-client",
          attemptID: ATTEMPT_ID,
          ownerEpoch: "7",
          specID: "spec-client",
          specDigest: RECEIPT,
          profileID: DIRECT_PROFILE.profileId,
          profileRevision: "1",
          profileDigest: DIRECT_PROFILE_DIGEST,
          evidencePlanDigest: RECEIPT,
          setIdentityDigest: RECEIPT,
          verificationRunID: VERIFICATION_RUN_ID,
          challengeSetDigest: RECEIPT,
          finalRevision: RECEIPT,
          sourceRevision: RECEIPT,
          approvalLocation: {
            locationID: LOCATION_ID,
            workspaceID: "wrk_client_workspace",
            canonicalRoot: "/workspace/client",
            workspaceRevision: RECEIPT,
          },
          evidenceDigest: RECEIPT,
          artifactRefs,
          settlementCandidate: {
            goalID: String(body.goalID),
            runID: String(body.runID),
            taskID: "task-client",
            attemptID: ATTEMPT_ID,
            bindingDigest: RECEIPT,
            specID: "spec-client",
            specDigest: RECEIPT,
            evidenceDigest: RECEIPT,
            finalRevision: RECEIPT,
            effectChainDigest: RECEIPT,
            attemptStateDigest: RECEIPT,
            ownerLogID: "owner-log-client",
            ownerLogSequence: "42",
            ownerLogEventDigest: RECEIPT,
            managedRevision: "13",
            usageAccounting: {
              accountingCursor: "12",
              tokenKnownSubtotal: "120",
              costKnownSubtotalMicros: "45",
              tokenRemainderStatus: "UNKNOWN",
              costRemainderStatus: "KNOWN",
              usageState: "UNKNOWN",
              stopReason: "USAGE_UNCERTAIN",
              ceilingDigest: RECEIPT,
              costStatus: "provider-reported",
              metricStatuses: {
                input: "provider-reported",
                output: "unknown",
                reasoning: "unknown",
                "cache.read": "unknown",
                "cache.write": "unknown",
              },
              receiptCount: "2",
              receiptChainDigest: RECEIPT,
            },
          },
          revision: 13n,
        }
      }
      if (operation === "prepare_final_inspect") {
        return {
          status: "needs_approval",
          challengeID: "challenge-root-inspect-1",
          effectID: "effect-root-inspect-1",
          capabilityID: "git.worktree.list",
          locationID: LOCATION_ID,
          inputDigest: RECEIPT,
          targets: [{ path: "." }],
          normalizedTargets: [{ path: "." }],
          expiresAtUnixMs: Date.now() + 60_000,
          policySummary: "List the final worktree state for the verified Run.",
          origin: "managed_root",
          source: "host.managed_worktree",
          policyID: "broker-process.local.v1",
          policyDigest: RECEIPT,
          normalizedAction: "git.worktree.list",
          argumentSummary: { status: "available", text: "git worktree list --porcelain ." },
          requestedGuarantees: [
            "configured_executable",
            "bounded_argv_env",
            "beneath_workspace_root",
            "one_use",
          ],
          guaranteeAssessment: { status: "not_assessed", residual: null },
        }
      }
      if (operation === "execute_final_inspect") {
        return {
          status: "INSPECTED",
          operationID: "inspect-final-op-1",
          hostReceiptRef: RECEIPT,
          workspaceRevision: RECEIPT,
          worktreeStatus: "CLEAN",
          dirtyEntryCount: "0",
          dirtyEntriesDigest: "",
          containsUserOwnedChanges: false,
          owned: true,
          noFollow: true,
        }
      }
      if (operation === "settle_dispatch") {
        return {
          status: "SETTLED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          verificationRunID: VERIFICATION_RUN_ID,
          setIdentityDigest: RECEIPT,
          challengeSetDigest: RECEIPT,
          taskID: "task-client",
          attemptID: ATTEMPT_ID,
          workerExecutionID: "worker-client",
          disposition: "RELEASED",
          proofDigest: RECEIPT,
          ownerLogID: "pool-log-client",
          ownerLogSequence: "8",
          ownerLogEventDigest: RECEIPT,
          workerPoolRevision: "9",
          receiptDigest: RECEIPT,
          worktreeDisposition: {
            ownerEpoch: "7",
            disposition: "REUSABLE",
            settlementReceiptDigest: RECEIPT,
            finalWorktreeOperationID: "inspect-final-op-1",
            finalWorktreeHostReceiptRef: RECEIPT,
            observedWorkspaceRevision: RECEIPT,
            inspectReceiptDigest: RECEIPT,
            ownerLogID: "worktree-log-client",
            ownerLogSequence: "27",
            ownerLogEventDigest: RECEIPT,
            workerPoolRevision: "10",
            receiptDigest: RECEIPT,
          },
        }
      }
      if (operation === "verify_task") {
        return {
          status: "VERIFIED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          taskID: String(body.taskID),
          attemptID: String(body.attemptID),
          verifierID: "server_auth:verifier",
          sourceRevision: RECEIPT,
          evidenceDigest: RECEIPT,
          revision: 12n,
        }
      }
      if (operation === "record_criterion_evidence") {
        return {
          status: "EVIDENCE_RECORDED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          criterionID: String(body.criterionID),
          sourceRevision: RECEIPT,
          evidenceDigest: RECEIPT,
          revision: 13n,
        }
      }
      if (operation === "finalize_run") {
        return {
          status: "SUCCEEDED",
          goalID: String(body.goalID),
          runID: String(body.runID),
          runPhase: "SUCCEEDED",
          revision: 14n,
        }
      }
      if (operation === "admit_direct_attempt") {
        self.admitted = true
        return {
          status: "ADMITTED",
          attemptID: String(body.attemptID),
          attemptPhase: "EXECUTING",
          parentSessionID: String(body.parentSessionID),
          childSessionID: String(body.childSessionID),
          agent: String(body.agent),
          scopeDigest: String(body.scopeDigest),
          ownerEpoch: 7n,
          locationID: String(body.locationID),
          workspaceID: String(body.workspaceID),
          directAttempt: {
            attemptID: body.attemptID,
            parentSessionID: body.parentSessionID,
            childSessionID: body.childSessionID,
            profileID: DIRECT_PROFILE_SELECTION.profileId,
            profileRevision: DIRECT_PROFILE_SELECTION.revision,
            profileDigest: DIRECT_PROFILE_DIGEST,
            ownerEpoch: 7n,
            expectedRevision: 1n,
            locationID: body.locationID,
            workspaceID: body.workspaceID,
            workspaceRevision: DIRECT_FACTS.workspaceRevision,
            capabilityDigest: body.capabilityDigest,
            permissionsDigest: body.permissionsDigest,
            budgetDigest: body.budgetDigest,
            scopeDigest: body.scopeDigest,
          },
          receiptDigest: null,
          resultDigest: null,
          failureCode: null,
          retryable: null,
          revision: 1,
        }
      }
      if (operation === "bind_direct_attempt_effects") {
        return {
          status: "BOUND",
          attemptID: String(body.attemptID),
          effectIDs: body.effectIDs,
          locationID: String(body.locationID),
          revision: 2n,
          directAttempt: {
            ...(body.directAttempt as Record<string, unknown>),
            expectedRevision: 2n,
          },
        }
      }
      if (operation === "settle_direct_attempt") {
        if (self.directAttemptSettlementResponse) return self.directAttemptSettlementResponse
        const outcome = String(body.outcome).toUpperCase()
        return {
          status: "SETTLED",
          outcome,
          attemptID: String(body.attemptID),
          attemptPhase: outcome === "UNKNOWN" ? "UNKNOWN" : outcome,
          parentSessionID: "ses_parent",
          childSessionID: "ses_child",
          agent: "general",
          scopeDigest: SCOPE,
          receiptDigest: outcome === "SUCCEEDED" || outcome === "FAILED" ? RECEIPT : null,
          resultDigest: typeof body.resultDigest === "string" ? body.resultDigest : null,
          failureCode: typeof body.failureCode === "string" ? body.failureCode : null,
          retryable: typeof body.retryable === "boolean" ? body.retryable : null,
          revision: 2,
        }
      }
      if (operation === "cancel_direct_attempt") {
        if (self.directAttemptCancellationResponse) return self.directAttemptCancellationResponse
        return {
          status: "CANCELLED",
          attemptID: String(body.attemptID),
          attemptPhase: "CANCELLED",
          parentSessionID: "ses_parent",
          childSessionID: "ses_child",
          agent: "general",
          scopeDigest: SCOPE,
          receiptDigest: null,
          resultDigest: null,
          failureCode: null,
          retryable: null,
          revision: 2,
        }
      }
      if (operation === "create_goal_proposal") {
        return {
          status: "PROPOSED",
          goalID: String(body.goalID),
          specID: String(body.specID),
          specDigest: RECEIPT,
          createdBy: "host_os_uid:1000",
          proposedBy: "host_os_uid:1000",
          revision: 1,
        }
      }
      if (operation === "assign_spec_reviewer") {
        if (self.managedResponses[operation]) return self.managedResponses[operation]
        const revision = BigInt(body.expectedRevision as bigint | number)
        const principal = self.calls.at(-1)?.trustedPrincipal
        return {
          status: "ASSIGNED",
          reviewerID: principal?.kind === "server_auth" ? `server_auth:${principal.subject}` : "host_os_uid:1000",
          assignedAtRevision: revision,
          decisionRevision: revision + 1n,
        }
      }
      if (operation === "accept_spec" || operation === "reject_spec") {
        if (self.specDecisionResponse) return self.specDecisionResponse
        const accepted = operation === "accept_spec"
        return {
          status: accepted ? "ACCEPTED" : "REJECTED",
          goalID: String(body.goalID),
          specID: String(body.specID),
          specDigest: String(body.specDigest),
          ...(accepted
            ? { acceptedBy: null, acceptedAtMs: null }
            : { rejectedBy: null, rejectedAtMs: null }),
          reviewedRevision: body.expectedRevision,
          revision: 3,
        }
      }
      if (operation === "snapshot") {
        if (self.goalSnapshotResponse) return self.goalSnapshotResponse
        // Default live Goal projection: one accepted SpecVersion and the
        // active Run, so verifier pin cross-checks can pass without a seed.
        return {
          goalID: String(body.goalID ?? "goal-client"),
          revision: 7n,
          goal: {
            objective: "Build a safe feature",
            projectRef: "project-client",
            workspaceRef: "workspace-client",
            createdBy: "server_auth:author",
            activeSpecVersionID: "spec-client",
          },
          specs: [
            {
              specID: "spec-client",
              specDigest: RECEIPT,
              accepted: true,
              acceptedBy: "server_auth:reviewer",
              acceptedAtMs: 123,
              rejectedBy: null,
              rejectedAtMs: null,
              parentVersionID: null,
              objective: "Build a safe feature",
              projectRef: "project-client",
              workspaceRef: "workspace-client",
              capabilityScope: [],
              scope: ["packages/opencode"],
              constraints: ["No effect bypass"],
              criteria: [{ id: "criterion-1", description: "The behavior is tested" }],
              budget: {
                maxTasks: 8,
                maxAttemptsPerTask: 2,
                maxRunDurationMs: 60_000,
                maxMemoryBytes: null,
                maxDiskBytes: null,
                maxWorkers: 1,
                maxTokens: null,
                maxCostMicros: null,
              },
              sourceDigests: [SCOPE],
              proposedBy: "server_auth:author",
            },
          ],
          runs: [
            { runID: String(body.runID ?? "run-client"), specID: "spec-client", phase: "RUNNING", sessionLink: null },
          ],
        }
      }
      if (operation === "settlement_recovery") {
        // No durable terminal settlement is pending unless a test overrides it;
        // runVerification then proceeds to the live verification path.
        return {
          status: "NO_SETTLEMENT_PENDING",
          goalID: String(body.goalID),
          runID: String(body.runID),
        }
      }
      return yield* Effect.fail(
        new SessionSupervisorError({
          stage: "effect",
          reason: `${operation} is unavailable`,
          hostCode: "capability_unavailable",
        }),
      )
    })
  }
}

let activeKernel = new FakeHostKernel()

function freshKernel() {
  activeKernel = new FakeHostKernel()
  return activeKernel
}

const testSupervisorLayer = Layer.succeed(
  SessionSupervisor.Service,
  SessionSupervisor.Service.of({
    open: () => Effect.die("unexpected direct supervisor open"),
    openForSession: () => Effect.die("unexpected direct supervisor open"),
    registerHostLocation: () => Effect.die("unexpected host location registration"),
    prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
    replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
    awaitManagedVerifierApprovals: (input) => {
      if (activeKernel.interruptApprovals) return Effect.interrupt
      if (activeKernel.approvalResult) return Effect.succeed(activeKernel.approvalResult)
      activeKernel.approvalWindows.push(input.challenges)
      const challengeIDs = new Set(input.challenges.map((challenge) => challenge.challengeID))
      const decisions = activeKernel.approvalDecisions
        ? activeKernel.approvalDecisions.filter((decision) => challengeIDs.has(decision.challengeID))
        : input.challenges.map((challenge) => ({ challengeID: challenge.challengeID, decision: "allow_once" as const }))
      const denied = decisions.some((decision) => decision.decision === "deny")
      const complete = decisions.length === input.challenges.length
      return Effect.succeed(
        denied || !complete
          ? { kind: "abort", reason: denied ? "reviewer_denied" : "transport_lost", decisions }
          : { kind: "decisions", decisions },
      )
    },
    prepareToolBatch: () => Effect.die("unexpected effect preparation"),
    executeWrite: () => Effect.die("unexpected effect execution"),
    executePatch: () => Effect.die("unexpected patch execution"),
    runPatch: () => Effect.die("unexpected patch execution"),
    requestHostKernel: (serviceID, operation, body, options) =>
      activeKernel.handle(serviceID, operation, body, options as Parameters<FakeHostKernel["handle"]>[3]),
    hostOwnerEpoch: () =>
      activeKernel.hosted
        ? Effect.succeed(1)
        : Effect.fail(new SessionSupervisorError({ stage: "host-kernel", reason: "host kernel is unavailable" })),
    subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
    watchSession: () => Effect.die("unexpected session watch"),
    directSessionPermissionModeSnapshot: () => Effect.die("unexpected direct permission mode snapshot"),
    directProviderPermissionScope: () => Effect.die("unexpected direct provider permission scope"),
    setDirectSessionPermissionMode: () => Effect.die("unexpected direct permission mode write"),
    issueDirectSessionGrant: () => Effect.die("unexpected direct session grant"),
    revokeDirectSessionGrant: () => Effect.die("unexpected direct session grant revoke"),
    resolveEditorProcessApproval: () => Effect.die("unexpected editor process approval"),
    authorizeEditorProtocolOperation: () => Effect.die("unexpected editor protocol authorization"),
    authorizeReplOperation: () => Effect.die("unexpected repl authorization"),
    awaitManagedProviderApproval: () => Effect.die("unexpected managed provider approval"),
    awaitManagedRootApproval: () =>
      Effect.succeed({ effectID: "effect-root-inspect-1", capabilityLeaseDigest: RECEIPT, locationID: LOCATION_ID }),
    hostFeatureEnabled: () => Effect.die("unexpected host feature probe"),
    directSessionWorkspaceSnapshot: () => Effect.die("unexpected direct workspace snapshot"),
    managedEffectWaveReceipts: () => Effect.die("unexpected managed wave receipts"),
    managedCurrentEpochRecoveryQuiescence: () => Effect.die("unexpected managed epoch quiescence"),
    directCodeModeWaveReceipts: () => Effect.die("unexpected direct codemode wave receipts"),
    codeModeHostRequest: () => Effect.die("unexpected codemode host request"),
    settleCodeModeToolResults: () => Effect.die("unexpected codemode tool result settlement"),
    prepareCodeModeToolBatch: () => Effect.die("unexpected codemode tool batch preparation"),
    codeModeWaveReceipts: () => Effect.die("unexpected codemode wave receipts"),
    listDirectAttemptArtifacts: () => Effect.die("unexpected direct attempt artifact listing"),
    listDirectSessionArtifacts: () => Effect.die("unexpected direct session artifact listing"),
    inspectDirectSessionArtifact: () => Effect.die("unexpected direct session artifact inspect"),
    readDirectSessionArtifactRange: () => Effect.die("unexpected direct session artifact range read"),
    sessionProjectionCursor: () => Effect.die("unexpected session projection cursor"),
  }),
)

const testSupervisorNode = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: testSupervisorLayer,
  deps: [],
  tag: SessionSupervisor.node.tag,
})

const testPrincipalNode = LayerNode.make({
  service: TrustedPrincipalContext,
  layer: Layer.succeed(TrustedPrincipalContext, TrustedPrincipalContext.of({ principal: REVIEWER })),
  deps: [],
})

const testAgentProfileNode = LayerNode.make({
  service: AgentProfileService,
  layer: Layer.succeed(AgentProfileService, AgentProfileService.of({
    agentProfiles: () => Effect.succeed([DIRECT_PROFILE]),
    agentProfileSelectors: () => Effect.succeed([]),
    agentProfile: (profileID, revision) => profileID === DIRECT_PROFILE.profileId && revision === DIRECT_PROFILE.revision
      ? Effect.succeed(DIRECT_PROFILE)
      : Effect.die("AgentProfile not found"),
    agentProfileSelector: () => Effect.die("AgentProfile selector not found"),
    primaryAgentProfile: () => Effect.die("unexpected primary AgentProfile resolution"),
  })),
  deps: [],
})

// Trusted Core registry fixture for the route projection used by managed
// admission: one bundled adapter with a fixed HTTPS endpoint and a stable
// SecretBroker lease reference for the exact Task-pinned provider/model.
const TEST_PROVIDER_INFO = Schema.decodeUnknownSync(ProviderInfoSchema)({
  id: "test",
  name: "Test Provider",
  source: "api",
  env: [],
  options: {},
  models: {
    "test-model": {
      id: "test-model",
      providerID: "test",
      api: { id: "anthropic", npm: "@ai-sdk/anthropic", url: "https://api.example.test/v1" },
      name: "Test Model",
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { cache: {} },
      limit: { context: 200000, output: 64000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2025-01-01",
    },
  },
})

const testProviderNode = LayerNode.make({
  service: ProviderService,
  layer: Layer.succeed(ProviderService, ProviderService.of({
    list: () => Effect.succeed({ test: TEST_PROVIDER_INFO } as never),
    getProvider: () => Effect.die("unexpected provider lookup"),
    getModel: () => Effect.die("unexpected model lookup"),
    getLanguage: () => Effect.die("unexpected language lookup"),
    getDirectLanguage: () => Effect.die("unexpected direct language lookup"),
    getManagedLanguage: () => Effect.die("unexpected managed language lookup"),
    getDirectFreeLanguage: () => Effect.die("unexpected direct free language lookup"),
    closest: () => Effect.die("unexpected closest model lookup"),
    getSmallModel: () => Effect.die("unexpected small model lookup"),
    defaultModel: () => Effect.die("unexpected default model lookup"),
  })),
  deps: [],
})

const testAuthNode = LayerNode.make({
  service: AuthService,
  layer: Layer.succeed(AuthService, AuthService.of({
    credentialRefsForProviders: (providerIDs) =>
      Effect.succeed(
        providerIDs.includes("test")
          ? { test: SecretBrokerV1.SecretRef.make("lease-test-0001") }
          : {},
      ),
    get: () => Effect.die("unexpected auth lookup"),
    all: () => Effect.die("unexpected auth listing"),
    set: () => Effect.die("unexpected auth write"),
    remove: () => Effect.die("unexpected auth removal"),
    issueCredentialHandle: () => Effect.die("unexpected credential handle"),
    credentialMutationAvailable: () => Effect.succeed(false),
    putCredential: () => Effect.die("unexpected credential put"),
    describeCredential: () => Effect.die("unexpected credential describe"),
    searchCredentialRefs: () => Effect.die("unexpected search credential refs"),
    revokeCredential: () => Effect.die("unexpected credential revoke"),
    authorizeCredentialUse: () => Effect.die("unexpected credential use authorization"),
    dispatchAuthorizedSearchRequest: () => Effect.die("unexpected authorized search dispatch"),
    dispatchAuthorizedManagedProviderRequest: () => Effect.die("unexpected authorized managed provider dispatch"),
    createPinnedDirectProviderFetch: () => Effect.die("unexpected pinned direct provider fetch"),
    dispatchPinnedDirectProviderRequest: () => Effect.die("unexpected pinned direct provider dispatch"),
  })),
  deps: [],
})

const it = testEffect(LayerNode.compile(LayerNode.group([testSupervisorNode, testPrincipalNode, testAgentProfileNode, testProviderNode, testAuthNode])))
const coordinatorSessionPromptNode = LayerNode.make({
  service: SessionPrompt.Service,
  layer: Layer.mock(SessionPrompt.Service, {}),
  deps: [],
  tag: SessionPrompt.node.tag,
})
const coordinatorSessionNode = LayerNode.make({
  service: Session.Service,
  layer: Layer.mock(Session.Service, {}),
  deps: [],
  tag: Session.node.tag,
})
// `executeNextManagedTask` declares `Agent.Service` (@horizoncode/Agent) in its
// requirement set through the managed prompt/session projections, even though
// these settle/cancel-only tests never resolve it. The coordinator group must
// still satisfy that requirement; a fail-closed mock keeps it unimplemented so
// any accidental reach fails loudly instead of silently.
const coordinatorAgentNode = LayerNode.make({
  service: Agent.Service,
  layer: Layer.mock(Agent.Service, {}),
  deps: [],
})
const coordinatorIt = testEffect(LayerNode.compile(LayerNode.group([
  testSupervisorNode,
  testPrincipalNode,
  testAgentProfileNode,
  testProviderNode,
  testAuthNode,
  coordinatorSessionPromptNode,
  coordinatorSessionNode,
  coordinatorAgentNode,
])))

test("managed child scheduler takes its principal from TrustedPrincipalContext, never caller input", async () => {
  // The input type carries no `trustedPrincipal`; authority is derived solely
  // from the authenticated TrustedPrincipalContext. A host_os context is denied
  // before any Session/Supervisor/Prompt service is yielded, so this focused
  // guard test casts the static requirements to `never` (the guard
  // short-circuits, so those services are never touched at runtime). tsgo
  // enforces that a caller can no longer inject a principal through the input.
  const effect = executeNextManagedTask({
    goalID: "goal-test",
    runID: "run-test",
    rootSessionID: "ses_root00000000000000000000000001",
    locationID: "loc-test",
    expectedRevision: "1",
  }).pipe(
    Effect.provideService(TrustedPrincipalContext, { principal: { kind: "host_os" } }),
  ) as unknown as Effect.Effect<unknown, unknown, never>
  const result = await Effect.runPromise(Effect.exit(effect))

  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.cause.toString()).toContain("authorization_denied")
})

const cancellingQuiescenceFixture = (
  kernel: FakeHostKernel,
  settlementOutcome: "FAILED" | "UNKNOWN",
  unknownEffect = false,
) => {
  const goalID = "goal-cancel"
  const runID = "run-cancel"
  const taskID = "task-cancel"
  const attemptID = `attempt_${"1".repeat(64)}`
  const sessionID = ManagedControl.managedTaskSessionID(attemptID)
  const runPhase = "CANCELLING"
  const consumed = {
    status: "CONSUMED",
    goalID,
    runID,
    taskID,
    parentSessionID: "session-root",
    sessionID,
    attemptID,
    handoffID: "handoff-cancel",
    handoffDigest: RECEIPT,
    claimedProofDigest: RECEIPT,
    workerExecutionID: "worker-cancel",
    pinsDigest: RECEIPT,
    bindingDigest: RECEIPT,
    claimNonce: RECEIPT,
    claimOwnerLogID: "owner-log-cancel",
    claimOwnerLogSequence: "1",
    claimOwnerLogEventDigest: RECEIPT,
    workerPoolRevision: "1",
    ownerEpoch: "1",
    processIncarnation: "core-incarnation-cancel",
    deliveryID: "managed_consume_cancel",
    corePID: 1,
    coreStartIdentity: "1",
    coreUID: 1,
    coreGID: 1,
    coreExecutableDigest: RECEIPT,
    consumedManagedRevision: "6",
    receiptDigest: RECEIPT,
    worktreeTarget: {
      worktreeID: "worktree-cancel",
      worktreeBaseRevision: "base-1",
      worktreePoolRevision: "1",
      locationID: "loc-child",
      workspaceID: "workspace-cancel",
      workspaceRef: "refs/heads/managed",
      canonicalRoot: "/workspace/managed",
      workspaceRevision: RECEIPT,
    },
  }
  const quiescence = {
    status: "QUIESCED",
    goalID,
    runID,
    taskID,
    parentSessionID: "session-root",
    sessionID,
    attemptID,
    handoffID: consumed.handoffID,
    handoffDigest: consumed.handoffDigest,
    consumeDeliveryID: consumed.deliveryID,
    consumeReceiptDigest: consumed.receiptDigest,
    ownerEpoch: "1",
    processIncarnation: consumed.processIncarnation,
    childSessionSequence: "2",
    childSessionEventDigest: RECEIPT,
    childSessionStateDigest: RECEIPT,
    childSessionOutputDigest: RECEIPT,
    childSessionOutputBytes: "0",
    childSessionOutcomeKind: "assistant_completed",
    deliveryID: ManagedControl.managedCompletionDeliveryID(attemptID, RECEIPT, RECEIPT),
    managedRevision: "7",
    ownerLogID: "owner-log-cancel",
    ownerLogSequence: "2",
    ownerLogEventDigest: RECEIPT,
    receiptDigest: RECEIPT,
  }
  kernel.managedResponses.next_schedulable_task = {
    status: "NO_TASK",
    goalID,
    runID,
    revision: "7",
    runPhase,
    specID: "spec-cancel",
    specDigest: RECEIPT,
    goalObjective: "cancel a quiesced Task",
    specConstraints: [],
    locationID: "loc-root",
    sessionID: "session-root",
    workspaceRef: "workspace-cancel",
    task: null,
  }
  kernel.managedResponses.active_attempt_recovery = {
    goalID,
    runID,
    locationID: "loc-root",
    sessionID: "session-root",
    revision: "7",
    runPhase,
    specID: "spec-cancel",
    specDigest: RECEIPT,
    goalObjective: "cancel a quiesced Task",
    specConstraints: [],
    workspaceRef: "workspace-cancel",
    status: "ACTIVE_ATTEMPT",
    task: {
      taskID,
      title: "Cancel Task",
      purpose: "Reconcile the stopped child before completing cancellation",
      candidateAttemptID: attemptID,
      attemptCount: "1",
      candidateGeneration: "1",
      taskRevision: "7",
      contextDigest: RECEIPT,
      dependencies: [],
      criterionIDs: ["criterion-cancel"],
      criteria: [{ criterionID: "criterion-cancel", description: "settle the attempt" }],
      requiredCapabilities: [],
      profile: {
        profileID: "profile-cancel",
        revision: "1",
        definitionDigest: RECEIPT,
        ownerBindingDigest: RECEIPT,
      },
    },
    attempt: {
      attemptID,
      sessionID,
      ownerEpoch: "1",
      phase: "EXECUTING",
      runPhase,
      bindingDigest: RECEIPT,
      unknownEffect,
      consumed,
      quiescence,
    },
  }
  kernel.managedResponses.settle = {
    status: "SETTLED",
    outcome: settlementOutcome,
    goalID,
    runID,
    taskID,
    attemptID,
    attemptPhase: settlementOutcome,
    runPhase: settlementOutcome === "UNKNOWN" ? "RECONCILING" : runPhase,
    receiptDigest: settlementOutcome === "UNKNOWN" ? null : RECEIPT,
    revision: 8n,
  }
  kernel.managedResponses.settle_dispatch = {
    status: "QUARANTINED",
    goalID,
    runID,
    taskID,
    attemptID,
    workerExecutionID: "worker-cancel",
    ownerEpoch: "1",
    reservationID: "reservation-cancel",
    worktreeLeaseID: "worktree-lease-cancel",
    reason: "CANCELLED_TASK",
    terminalProofDigest: RECEIPT,
    ownerLogID: "owner-log-cancel",
    ownerLogSequence: "3",
    ownerLogEventDigest: RECEIPT,
    workerPoolRevision: "2",
    receiptDigest: RECEIPT,
  }
  kernel.managedResponses.cancel = {
    status: "CANCELLED",
    goalID,
    runID,
    runPhase: "CANCELLED",
    revision: 9n,
  }
  return { goalID, runID, taskID, attemptID }
}

coordinatorIt.effect("settles assistant-completed quiescence before completing a cancelling Run", () =>
  Effect.gen(function* () {
    const kernel = freshKernel()
    const fixture = cancellingQuiescenceFixture(kernel, "FAILED")
    const result = yield* executeNextManagedTask({
      goalID: fixture.goalID,
      runID: fixture.runID,
      rootSessionID: "session-root",
      locationID: "loc-root",
      expectedRevision: "7",
    })

    expect(result.status).toBe("PROMPT_RETURNED")
    expect(kernel.calls.map((call) => call.operation)).toEqual([
      "next_schedulable_task",
      "active_attempt_recovery",
      "settle",
      "settle_dispatch",
      "cancel",
    ])
    const settlement = kernel.calls.find((call) => call.operation === "settle")
    expect(settlement?.body).toMatchObject({
      goalID: fixture.goalID,
      runID: fixture.runID,
      taskID: fixture.taskID,
      attemptID: fixture.attemptID,
      outcome: "failed",
      failureCode: "managed_prompt_stopped",
      retryable: false,
      expectedRevision: 7n,
    })
    const cancellation = kernel.calls.find((call) => call.operation === "cancel")
    expect(cancellation?.body).toMatchObject({
      goalID: fixture.goalID,
      runID: fixture.runID,
      expectedRevision: 8n,
    })
  }),
)

coordinatorIt.effect("keeps cancelling Run unknown when durable settlement is ambiguous", () =>
  Effect.gen(function* () {
    const kernel = freshKernel()
    const fixture = cancellingQuiescenceFixture(kernel, "UNKNOWN")
    const result = yield* executeNextManagedTask({
      goalID: fixture.goalID,
      runID: fixture.runID,
      rootSessionID: "session-root",
      locationID: "loc-root",
      expectedRevision: "7",
    })

    expect(result.status).toBe("PROMPT_UNKNOWN")
    expect(kernel.calls.map((call) => call.operation)).toEqual([
      "next_schedulable_task",
      "active_attempt_recovery",
      "settle",
    ])
  }),
)

coordinatorIt.effect("does not settle or cancel a quiesced Run with an unknown effect", () =>
  Effect.gen(function* () {
    const kernel = freshKernel()
    const fixture = cancellingQuiescenceFixture(kernel, "FAILED", true)
    const result = yield* executeNextManagedTask({
      goalID: fixture.goalID,
      runID: fixture.runID,
      rootSessionID: "session-root",
      locationID: "loc-root",
      expectedRevision: "7",
    })

    expect(result.status).toBe("PROMPT_UNKNOWN")
    expect(kernel.calls.map((call) => call.operation)).toEqual([
      "next_schedulable_task",
      "active_attempt_recovery",
    ])
  }),
)

const scopeFacts = {
  parentSessionID: "ses_parent00000000000000000000000",
  childSessionID: "ses_child000000000000000000000001",
  agent: "general",
  providerID: "test",
  modelID: "test-model",
  workspaceRoot: "/tmp/workspace",
  permissionRules: ["read:*:allow", "bash:*:ask"],
  deniedTools: ["todowrite", "task"],
  background: false,
  maxAttempts: 1,
  subagentDepth: 1,
}

describe("managed control client", () => {
  it.effect("managed restart recovery decodes the Rust projection and rejects cross-pinned Attempts", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = `attempt_${"1".repeat(64)}`
      const sessionID = ManagedControl.managedTaskSessionID(attemptID)
      kernel.managedResponses.active_attempt_recovery = {
        goalID: "goal-client",
        runID: "run-client",
        locationID: "loc-root",
        sessionID: "session-root",
        revision: "5",
        runPhase: "RUNNING",
        specID: "spec-client",
        specDigest: RECEIPT,
        goalObjective: "recover the active managed Task",
        specConstraints: [],
        workspaceRef: "workspace-client",
        status: "ACTIVE_ATTEMPT",
        task: {
          taskID: "task-client",
          title: "Task",
          purpose: "Recover exact Attempt",
          candidateAttemptID: attemptID,
          attemptCount: "1",
          candidateGeneration: "1",
          taskRevision: "5",
          contextDigest: RECEIPT,
          dependencies: [],
          criterionIDs: ["criterion-one"],
          criteria: [{ criterionID: "criterion-one", description: "complete" }],
          requiredCapabilities: [],
          profile: {
            profileID: "profile-client",
            revision: "1",
            definitionDigest: RECEIPT,
            ownerBindingDigest: RECEIPT,
          },
        },
        attempt: {
          attemptID,
          sessionID,
          ownerEpoch: "1",
          phase: "EXECUTING",
          runPhase: "RUNNING",
          bindingDigest: RECEIPT,
          unknownEffect: false,
          consumed: null,
          quiescence: null,
          managedAttempt: {
            goalID: "goal-client",
            runID: "run-client",
            taskID: "task-client",
            attemptID,
            ownerEpoch: "1",
            expectedManagedRevision: "5",
            locationID: "loc-child",
            sessionID,
            workspaceRevision: RECEIPT,
            delegationBindingDigest: RECEIPT,
            requestID: null,
            requestSequence: null,
            contextSelectionDigest: null,
          },
        },
      }

      const recoveryInput = {
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        runID: "run-client",
        locationID: "loc-root",
        sessionID: "session-root",
        expectedRevision: "5",
      }
      const validProjection = yield* Effect.exit(ManagedControl.activeAttemptRecovery(recoveryInput))
      expect(validProjection._tag === "Success" ? "Success" : validProjection.cause.toString()).toBe("Success")
      if (validProjection._tag === "Success" && validProjection.value.status === "ACTIVE_ATTEMPT") {
        expect("effectiveMaxTokens" in validProjection.value.task).toBe(false)
        expect(validProjection.value.attempt.managedAttempt).toBeUndefined()
        expect(validProjection.value.attempt.managedAttemptRecovery?.requestID).toBeNull()
      }

      // A syntactically valid quiescence receipt must remain bound to the exact
      // consume receipt. This deliberately malformed cross-receipt projection
      // is a DTO denial case, not evidence that any managed effect ran.
      const originalRecovery = kernel.managedResponses.active_attempt_recovery!
      const originalAttempt = originalRecovery.attempt as Record<string, unknown>
      const consumed = {
        status: "CONSUMED",
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        parentSessionID: "session-root",
        sessionID,
        attemptID,
        handoffID: "handoff-client",
        handoffDigest: RECEIPT,
        claimedProofDigest: RECEIPT,
        workerExecutionID: "worker-client",
        pinsDigest: RECEIPT,
        bindingDigest: RECEIPT,
        claimNonce: RECEIPT,
        claimOwnerLogID: "owner-log-client",
        claimOwnerLogSequence: "1",
        claimOwnerLogEventDigest: RECEIPT,
        workerPoolRevision: "1",
        ownerEpoch: "1",
        processIncarnation: "core-incarnation-1",
        deliveryID: "managed_consume_client",
        corePID: 1,
        coreStartIdentity: "1",
        coreUID: 1,
        coreGID: 1,
        coreExecutableDigest: RECEIPT,
        consumedManagedRevision: "6",
        receiptDigest: RECEIPT,
        worktreeTarget: {
          worktreeID: "worktree-client",
          worktreeBaseRevision: "base-1",
          worktreePoolRevision: "1",
          locationID: "loc-child",
          workspaceID: "workspace-client",
          workspaceRef: "refs/heads/managed",
          canonicalRoot: "/workspace/managed",
          workspaceRevision: RECEIPT,
        },
      }
      const quiescence = {
        status: "QUIESCED",
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        parentSessionID: "session-root",
        sessionID,
        attemptID,
        handoffID: "handoff-client",
        handoffDigest: RECEIPT,
        consumeDeliveryID: consumed.deliveryID,
        consumeReceiptDigest: `blake3:${"b".repeat(64)}`,
        ownerEpoch: "1",
        processIncarnation: "core-incarnation-1",
        childSessionSequence: "2",
        childSessionEventDigest: RECEIPT,
        childSessionStateDigest: RECEIPT,
        childSessionOutputDigest: RECEIPT,
        childSessionOutputBytes: "0",
        childSessionOutcomeKind: "assistant_completed",
        deliveryID: ManagedControl.managedCompletionDeliveryID(attemptID, RECEIPT, RECEIPT),
        managedRevision: "7",
        ownerLogID: "owner-log-client",
        ownerLogSequence: "2",
        ownerLogEventDigest: RECEIPT,
        receiptDigest: RECEIPT,
      }
      kernel.managedResponses.active_attempt_recovery = {
        ...originalRecovery,
        attempt: { ...originalAttempt, consumed, quiescence },
      }
      const detachedQuiescence = yield* Effect.exit(ManagedControl.activeAttemptRecovery(recoveryInput))
      expect(detachedQuiescence._tag).toBe("Failure")
      if (detachedQuiescence._tag === "Failure") {
        expect(detachedQuiescence.cause.toString()).toContain("quiescence receipt")
      }
      kernel.managedResponses.active_attempt_recovery = originalRecovery

      const response = kernel.managedResponses.active_attempt_recovery!
      const attempt = response.attempt as { managedAttempt: Record<string, unknown> }
      const requestID = `req_managed_${attemptID}_1`
      const selection = Schema.decodeUnknownSync(ContextSelectionV1)({
        schemaVersion: 1,
        lane: "managed",
        sessionID,
        mode: "fresh",
        attemptID,
        requestSequence: "1",
        requestID,
        sourceRevision: "0",
        sources: [
          {
            kind: "managed-task",
            sourceID: "task-client",
            sourceRevision: "0",
            contentDigest: RECEIPT,
            sourceAuthority: "managed-control",
            trust: "user",
            included: true,
            inclusionReason: "required",
          },
          {
            kind: "accepted-spec",
            sourceID: "spec-client",
            sourceRevision: "0",
            contentDigest: RECEIPT,
            sourceAuthority: "managed-control",
            trust: "system",
            included: true,
            inclusionReason: "required",
          },
          {
            kind: "agent-profile",
            sourceID: "specialist.reader",
            sourceRevision: "1",
            contentDigest: DIRECT_PROFILE_DIGEST,
            sourceAuthority: "core-config",
            trust: "system",
            included: true,
            inclusionReason: "profile",
          },
          {
            kind: "tool",
            sourceID: "toolset:native-rich",
            sourceRevision: RECEIPT,
            contentDigest: RECEIPT,
            sourceAuthority: "tool-registry",
            trust: "system",
            included: true,
            inclusionReason: "selected_tool",
            harnessRevision: 1,
          },
          {
            kind: "provider-input",
            sourceID: requestID,
            sourceRevision: "1",
            contentDigest: RECEIPT,
            sourceAuthority: "core-prompt-compiler",
            trust: "mixed",
            included: true,
            inclusionReason: "current_request",
          },
        ],
      })
      ;(attempt.managedAttempt as Record<string, unknown>).requestID = requestID
      ;(attempt.managedAttempt as Record<string, unknown>).requestSequence = "1"
      ;(attempt.managedAttempt as Record<string, unknown>).contextSelectionDigest = RECEIPT
      const selectionProjection = yield* Effect.exit(ManagedControl.activeAttemptRecovery(recoveryInput))
      expect(selectionProjection._tag).toBe("Success")

      attempt.managedAttempt.attemptID = `attempt_${"2".repeat(64)}`
      const mismatchedProjection = yield* Effect.exit(ManagedControl.activeAttemptRecovery(recoveryInput))
      expect(mismatchedProjection._tag).toBe("Failure")
      if (mismatchedProjection._tag === "Failure") expect(mismatchedProjection.cause.toString()).toContain("recovery managed Attempt pins")
    }),
  )

  test("HostRun receipt decoders reject malformed OwnerLog event digests", () => {
    const common = {
      schemaVersion: 1,
      dispatchKeyDigest: RECEIPT,
      bindingDigest: RECEIPT,
      ownerLogSequence: "1",
      ownerLogEventDigest: "not-a-digest",
    }

    expect(() => decodeHostRunDispatchBindingReceipt("test", {
      ...common,
      bindingManagedRevision: "1",
    })).toThrow("ownerLogEventDigest")
    expect(() => decodeHostRunDispatchP8OwnerReceipt("test", {
      ...common,
      ownerLogID: "owner-log-1",
    })).toThrow("ownerLogEventDigest")
  })

  test("HostRun receipt decoders preserve either canonical OwnerLog digest spelling", () => {
    const common = {
      schemaVersion: 1,
      dispatchKeyDigest: RECEIPT,
      bindingDigest: RECEIPT,
      ownerLogSequence: "1",
    }
    for (const ownerLogEventDigest of ["a".repeat(64), `blake3:${"b".repeat(64)}`]) {
      expect(decodeHostRunDispatchBindingReceipt("test", {
        ...common,
        ownerLogEventDigest,
        bindingManagedRevision: "1",
      }).ownerLogEventDigest).toBe(ownerLogEventDigest)
      expect(decodeHostRunDispatchP8OwnerReceipt("test", {
        ...common,
        ownerLogEventDigest,
        ownerLogID: "owner-log-1",
      }).ownerLogEventDigest).toBe(ownerLogEventDigest)
    }
  })

  test("HostRun receipt decoders reject zero and non-canonical OwnerLog sequences", () => {
    const common = {
      schemaVersion: 1,
      dispatchKeyDigest: RECEIPT,
      bindingDigest: RECEIPT,
      ownerLogEventDigest: "a".repeat(64),
      bindingManagedRevision: "1",
      ownerLogID: "owner-log-1",
    }
    for (const ownerLogSequence of ["0", "01", "18446744073709551616"]) {
      expect(() => decodeHostRunDispatchBindingReceipt("test", {
        ...common,
        ownerLogSequence,
      })).toThrow("ownerLogSequence")
      expect(() => decodeHostRunDispatchP8OwnerReceipt("test", {
        ...common,
        ownerLogSequence,
      })).toThrow("ownerLogSequence")
    }
  })

  it.instance("HostRun bind sends only managed selectors and rejects a cross-pinned response", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const goalID = "goal-host-run-bind"
      const attemptID = `attempt_${"1".repeat(64)}`
      const dispatchKeyDigest = RECEIPT
      const foreignDispatchKeyDigest = `blake3:${"f".repeat(64)}`
      const foreignAttemptID = `attempt_${"2".repeat(64)}`

      // Negative client/DTO fixture only: this foreign response is deliberately
      // cross-pinned and is never evidence that a HostRun effect occurred.
      kernel.managedResponses["host_run.bind"] = {
        schemaVersion: 1,
        binding: {
          schemaVersion: 1,
          dispatchKeyDigest: foreignDispatchKeyDigest,
          manifestDigest: RECEIPT,
          evaluatorTaskId: "evaluator-one",
          armId: "arm-one",
          taskGroup: "group-one",
          runId: "run-one",
          managedTaskId: "task-one",
          attemptId: foreignAttemptID,
          evaluationSessionId: "ses_root000000000000000000000001",
          coreProcessGeneration: "1",
          ownerId: "owner-one",
          ownerEpoch: "1",
          workerExecutionId: "worker-one",
          delegationBindingDigest: RECEIPT,
          acceptedSpecDigest: RECEIPT,
          providerSelectionDigest: RECEIPT,
          workspaceBindingDigest: RECEIPT,
          admittedWorkspaceRevision: RECEIPT,
          attemptScopeDigest: RECEIPT,
          ownerPrincipalBindingDigest: RECEIPT,
          bindingDigest: RECEIPT,
        },
        receipt: {
          schemaVersion: 1,
          dispatchKeyDigest: foreignDispatchKeyDigest,
          bindingDigest: RECEIPT,
          ownerLogSequence: "1",
          ownerLogEventDigest: RECEIPT,
          bindingManagedRevision: "1",
        },
      }

      const exit = yield* Effect.exit(ManagedControl.hostRunBind({
        trustedPrincipal: REVIEWER,
        goalID,
        attemptID,
        dispatchKeyDigest,
      }))

      expect(kernel.calls).toHaveLength(1)
      expect(kernel.calls[0]?.body).toEqual({ goalID, attemptID, dispatchKeyDigest })
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("HostRun binding identity")
    }),
  )

  it.instance("HostRun bind rejects a response for a different Attempt even when the DTO is valid", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = `attempt_${"1".repeat(64)}`
      const foreignAttemptID = `attempt_${"2".repeat(64)}`
      kernel.managedResponses["host_run.bind"] = {
        schemaVersion: 1,
        binding: hostRunBindingFixture({ attemptId: foreignAttemptID }),
        receipt: {
          schemaVersion: 1,
          dispatchKeyDigest: RECEIPT,
          bindingDigest: RECEIPT,
          ownerLogSequence: "1",
          ownerLogEventDigest: RECEIPT,
          bindingManagedRevision: "1",
        },
      }

      const exit = yield* Effect.exit(ManagedControl.hostRunBind({
        trustedPrincipal: REVIEWER,
        goalID: "goal-host-run-bind",
        attemptID,
        dispatchKeyDigest: RECEIPT,
      }))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("HostRun binding identity")
    }),
  )

  it.instance("HostRun bind rejects a foreign dispatch key or detached binding receipt", () =>
    Effect.gen(function* () {
      const attemptID = `attempt_${"1".repeat(64)}`
      const foreignDigest = `blake3:${"f".repeat(64)}`
      const receipt = (dispatchKeyDigest: string, bindingDigest: string) => ({
        schemaVersion: 1,
        dispatchKeyDigest,
        bindingDigest,
        ownerLogSequence: "1",
        ownerLogEventDigest: RECEIPT,
        bindingManagedRevision: "1",
      })
      const responses = [
        {
          schemaVersion: 1,
          binding: hostRunBindingFixture({ attemptId: attemptID, dispatchKeyDigest: foreignDigest }),
          receipt: receipt(RECEIPT, RECEIPT),
        },
        {
          schemaVersion: 1,
          binding: hostRunBindingFixture({ attemptId: attemptID }),
          receipt: receipt(foreignDigest, RECEIPT),
        },
        {
          schemaVersion: 1,
          binding: hostRunBindingFixture({ attemptId: attemptID }),
          receipt: receipt(RECEIPT, foreignDigest),
        },
      ]

      for (const response of responses) {
        const kernel = freshKernel()
        kernel.managedResponses["host_run.bind"] = response
        const exit = yield* Effect.exit(ManagedControl.hostRunBind({
          trustedPrincipal: REVIEWER,
          goalID: "goal-host-run-bind",
          attemptID,
          dispatchKeyDigest: RECEIPT,
        }))
        expect(exit._tag).toBe("Failure")
      }
    }),
  )

  it.instance("HostRun bind receipt rejects any response that changes its P8 request", () =>
    Effect.gen(function* () {
      const foreignDigest = `blake3:${"f".repeat(64)}`
      const submitted = {
        schemaVersion: 1,
        dispatchKeyDigest: RECEIPT,
        bindingDigest: RECEIPT,
        ownerLogID: "owner-one",
        ownerLogSequence: "1",
        ownerLogEventDigest: RECEIPT,
      }
      const responses = [
        { ...submitted, dispatchKeyDigest: foreignDigest },
        { ...submitted, bindingDigest: foreignDigest },
        { ...submitted, ownerLogID: "owner-other" },
        { ...submitted, ownerLogSequence: "2" },
        { ...submitted, ownerLogEventDigest: foreignDigest },
      ]

      for (const receipt of responses) {
        const kernel = freshKernel()
        kernel.managedResponses["host_run.bind_receipt"] = {
          schemaVersion: 1,
          status: "RECORDED",
          receipt,
        }
        const exit = yield* Effect.exit(ManagedControl.hostRunBindReceipt({
          trustedPrincipal: REVIEWER,
          goalID: "goal-host-run-bind",
          dispatchKeyDigest: RECEIPT,
          bindingDigest: RECEIPT,
          ownerLogID: "owner-one",
          ownerLogSequence: "1",
          ownerLogEventDigest: RECEIPT,
        }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("HostRun P8 receipt identity")
      }
    }),
  )

  it.instance("HostRun reconciliation rejects mismatched query and attached binding keys", () =>
    Effect.gen(function* () {
      const foreignDigest = `blake3:${"f".repeat(64)}`
      const responses = [
        {
          schemaVersion: 1,
          dispatchKeyDigest: foreignDigest,
          status: "FAILED",
          binding: hostRunBindingFixture({ dispatchKeyDigest: RECEIPT }),
          bindingDigest: RECEIPT,
          attemptReceiptDigest: RECEIPT,
        },
        {
          schemaVersion: 1,
          dispatchKeyDigest: RECEIPT,
          status: "FAILED",
          binding: hostRunBindingFixture({ dispatchKeyDigest: foreignDigest }),
          bindingDigest: RECEIPT,
          attemptReceiptDigest: RECEIPT,
        },
      ]

      for (const response of responses) {
        const kernel = freshKernel()
        kernel.managedResponses["host_run.inspect"] = response
        const exit = yield* Effect.exit(ManagedControl.reconcileHostRun({
          trustedPrincipal: REVIEWER,
          goalID: "goal-host-run-bind",
          dispatchKeyDigest: RECEIPT,
        }))

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("identity")
      }
    }),
  )

  it.instance("UNKNOWN HostRun reconciliation checks the query key before the status reason", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses["host_run.inspect"] = {
        schemaVersion: 1,
        dispatchKeyDigest: `blake3:${"f".repeat(64)}`,
        status: "UNKNOWN",
      }
      const exit = yield* Effect.exit(ManagedControl.reconcileHostRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-host-run-bind",
        dispatchKeyDigest: RECEIPT,
      }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("dispatch key identity")
    }),
  )

  it.instance("UNKNOWN HostRun reconciliation preserves a valid typed UNKNOWN", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses["host_run.inspect"] = {
        schemaVersion: 1,
        dispatchKeyDigest: RECEIPT,
        status: "UNKNOWN",
        unknownReason: "host_run_attempt_unknown",
      }
      const result = yield* ManagedControl.reconcileHostRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-host-run-bind",
        dispatchKeyDigest: RECEIPT,
      })
      expect(result.status).toBe("UNKNOWN")
      expect(result.unknownReason).toBe("host_run_attempt_unknown")
    }),
  )
  it.instance("CANCELLED HostRun reconciliation requires an attached binding identity", () =>
    Effect.gen(function* () {
      const foreignDigest = `blake3:${"f".repeat(64)}`
      const responses = [
        { status: "CANCELLED" },
        {
          status: "CANCELLED",
          binding: hostRunBindingFixture({ dispatchKeyDigest: foreignDigest }),
          bindingDigest: RECEIPT,
        },
        {
          status: "CANCELLED",
          binding: hostRunBindingFixture(),
          bindingDigest: foreignDigest,
        },
      ]

      for (const response of responses) {
        const kernel = freshKernel()
        kernel.managedResponses["host_run.inspect"] = {
          schemaVersion: 1,
          dispatchKeyDigest: RECEIPT,
          ...response,
        }
        const exit = yield* Effect.exit(ManagedControl.reconcileHostRun({
          trustedPrincipal: REVIEWER,
          goalID: "goal-host-run-bind",
          dispatchKeyDigest: RECEIPT,
        }))

        expect(exit._tag).toBe("Failure")
      }
    }),
  )

  it.instance("SUCCEEDED HostRun reconciliation requires Attempt receipt and final revision evidence", () =>
    Effect.gen(function* () {
      const finalRevision = `blake3:${"d".repeat(64)}`
      const responses = [
        {
          schemaVersion: 1,
          dispatchKeyDigest: RECEIPT,
          status: "SUCCEEDED",
          binding: hostRunBindingFixture(),
          bindingDigest: RECEIPT,
          verifiedRevision: finalRevision,
        },
        {
          schemaVersion: 1,
          dispatchKeyDigest: RECEIPT,
          status: "SUCCEEDED",
          binding: hostRunBindingFixture(),
          bindingDigest: RECEIPT,
          attemptReceiptDigest: RECEIPT,
        },
      ]

      for (const response of responses) {
        const kernel = freshKernel()
        kernel.managedResponses["host_run.inspect"] = response
        const exit = yield* Effect.exit(ManagedControl.reconcileHostRun({
          trustedPrincipal: REVIEWER,
          goalID: "goal-host-run-bind",
          dispatchKeyDigest: RECEIPT,
        }))

        expect(exit._tag).toBe("Failure")
      }
    }),
  )

  it.instance("SUCCEEDED HostRun accepts the verified final revision distinct from the admission pin", () =>
    Effect.gen(function* () {
      const admissionRevision = `blake3:${"e".repeat(64)}`
      const finalRevision = `blake3:${"d".repeat(64)}`
      const kernel = freshKernel()
      kernel.managedResponses["host_run.inspect"] = {
        schemaVersion: 1,
        dispatchKeyDigest: RECEIPT,
        status: "SUCCEEDED",
        binding: hostRunBindingFixture({ admittedWorkspaceRevision: admissionRevision }),
        bindingDigest: RECEIPT,
        attemptReceiptDigest: RECEIPT,
        verifiedRevision: finalRevision,
      }
      const result = yield* ManagedControl.reconcileHostRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-host-run-bind",
        dispatchKeyDigest: RECEIPT,
      })
      expect(result.status).toBe("SUCCEEDED")
      expect(result.verifiedRevision).toBe(finalRevision)
      expect(result.binding?.admittedWorkspaceRevision).toBe(admissionRevision)
    }),
  )
  test("HostRun reconciliation requires a reason only for UNKNOWN", () => {
    const base = {
      schemaVersion: 1,
      dispatchKeyDigest: RECEIPT,
    }
    expect(() => decodeHostRunReconciliation("test", {
      ...base,
      status: "UNKNOWN",
    })).toThrow("unknownReason")
    expect(() => decodeHostRunReconciliation("test", {
      ...base,
      status: "SUCCEEDED",
      unknownReason: "host_run_attempt_unknown",
    })).toThrow("unknownReason")
    expect(decodeHostRunReconciliation("test", {
      ...base,
      status: "UNKNOWN",
      unknownReason: "host_run_attempt_unknown",
    }).unknownReason).toBe("host_run_attempt_unknown")
    expect(() => decodeHostRunReconciliation("test", {
      ...base,
      status: "UNKNOWN",
      unknownReason: "caller-invented",
    })).toThrow("unknownReason")
  })

  it.instance("goal.start refuses a SessionLink bound to another Session or workspace before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const exit = yield* Effect.exit(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-start",
        runID: "run-start",
        specID: "spec-start",
        specDigest: RECEIPT,
        expectedGoalRevision: "4",
        idempotencyKey: "start-delivery-1",
        sessionID: "ses_root000000000000000000000001",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        sessionLink: {
          sessionID: "ses_root000000000000000000000002",
          sourceStoreID: "store-one",
          sourceInstanceID: "instance-one",
          sourceCursor: {
            ownerKind: "session",
            ownerId: "ses_root000000000000000000000001",
            seq: "1",
            eventDigest: RECEIPT,
          },
          sourceEpoch: "1",
          latestObservedMessageID: null,
          latestObservedPartID: null,
          sourceDigest: SCOPE,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-start",
          projectID: "project-one",
          workspaceID: "workspace-one",
        },
      }))
      expect(exit._tag).toBe("Failure")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("goal.start rejects a numeric observed message ID before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-start",
        runID: "run-start",
        specID: "spec-start",
        specDigest: RECEIPT,
        expectedGoalRevision: "4",
        idempotencyKey: "start-delivery-1",
        sessionID: "ses_root000000000000000000000001",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        sessionLink: {
          sessionID: "ses_root000000000000000000000001",
          sourceStoreID: "store-one",
          sourceInstanceID: "instance-one",
          sourceCursor: {
            ownerKind: "session",
            ownerId: "ses_root000000000000000000000001",
            seq: "1",
            eventDigest: RECEIPT,
          },
          sourceEpoch: "1",
          latestObservedMessageID: 123 as never,
          latestObservedPartID: null,
          sourceDigest: SCOPE,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-start",
          projectID: "project-one",
          workspaceID: "workspace-one",
        },
      }))

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("goal.start rejects a null SessionLink cursor before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-start",
        runID: "run-start",
        specID: "spec-start",
        specDigest: RECEIPT,
        expectedGoalRevision: "4",
        idempotencyKey: "start-delivery-1",
        sessionID: "ses_root000000000000000000000001",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        sessionLink: {
          sessionID: "ses_root000000000000000000000001",
          sourceStoreID: "store-one",
          sourceInstanceID: "instance-one",
          sourceCursor: null as never,
          sourceEpoch: "1",
          latestObservedMessageID: null,
          latestObservedPartID: null,
          sourceDigest: SCOPE,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-start",
          projectID: "project-one",
          workspaceID: "workspace-one",
        },
      }))

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("goal.start rejects a non-string cursor digest before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-start",
        runID: "run-start",
        specID: "spec-start",
        specDigest: RECEIPT,
        expectedGoalRevision: "4",
        idempotencyKey: "start-delivery-1",
        sessionID: "ses_root000000000000000000000001",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        sessionLink: {
          sessionID: "ses_root000000000000000000000001",
          sourceStoreID: "store-one",
          sourceInstanceID: "instance-one",
          sourceCursor: {
            ownerKind: "session",
            ownerId: "ses_root000000000000000000000001",
            seq: "1",
            eventDigest: [RECEIPT] as never,
          },
          sourceEpoch: "1",
          latestObservedMessageID: null,
          latestObservedPartID: null,
          sourceDigest: SCOPE,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-start",
          projectID: "project-one",
          workspaceID: "workspace-one",
        },
      }))

      expect(kernel.calls).toHaveLength(0)
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
    }),
  )

  it.instance("goal.start rejects a non-string source digest before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-start",
        runID: "run-start",
        specID: "spec-start",
        specDigest: RECEIPT,
        expectedGoalRevision: "4",
        idempotencyKey: "start-delivery-1",
        sessionID: "ses_root000000000000000000000001",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        sessionLink: {
          sessionID: "ses_root000000000000000000000001",
          sourceStoreID: "store-one",
          sourceInstanceID: "instance-one",
          sourceCursor: {
            ownerKind: "session",
            ownerId: "ses_root000000000000000000000001",
            seq: "1",
            eventDigest: RECEIPT,
          },
          sourceEpoch: "1",
          latestObservedMessageID: null,
          latestObservedPartID: null,
          sourceDigest: [SCOPE] as never,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-start",
          projectID: "project-one",
          workspaceID: "workspace-one",
        },
      }))

      expect(kernel.calls).toHaveLength(0)
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
    }),
  )

  it.instance("direct follow-up rejects ordinary DirectAttempt scopes before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const pins = {
        parentSessionID: "ses_parent00000000000000000000000",
        childSessionID: "ses_child000000000000000000000001",
        childOwnerEpoch: "7",
        profileID: DIRECT_PROFILE_SELECTION.profileId,
        profileRevision: DIRECT_PROFILE_SELECTION.revision,
        profileDigest: DIRECT_PROFILE_DIGEST,
        permissionScopeDigest: DIRECT_FACTS.permissionsDigest,
        directAttemptID: "att_0123456789abcdef",
        messageID: "msg_0123456789abcdef",
        deliveryMode: "follow_up" as const,
        mailboxSequence: "1",
      }
      const missingProof = yield* Effect.exit(ManagedControl.prepareDirectMessage({
        pins,
        content: "Continue from the queued message",
        mailboxCapacity: 1,
      }))
      expect(missingProof._tag).toBe("Failure")
      expect(kernel.calls).toHaveLength(0)

      const ordinaryScope = yield* Effect.exit(ManagedControl.prepareDirectMessage({
        pins,
        content: "Continue from the queued message",
        mailboxCapacity: 1,
        directAttempt: {
          attemptID: pins.directAttemptID,
          parentSessionID: pins.parentSessionID,
          childSessionID: pins.childSessionID,
          profileID: pins.profileID,
          profileRevision: pins.profileRevision,
          profileDigest: pins.profileDigest,
          ownerEpoch: pins.childOwnerEpoch,
          expectedRevision: "1",
          locationID: DIRECT_FACTS.locationID,
          workspaceID: DIRECT_FACTS.workspaceID,
          workspaceRevision: DIRECT_FACTS.workspaceRevision,
          capabilityDigest: DIRECT_FACTS.capabilityDigest,
          permissionsDigest: DIRECT_FACTS.permissionsDigest,
          budgetDigest: DIRECT_FACTS.budgetDigest,
          scopeDigest: SCOPE,
        },
      }))
      expect(ordinaryScope._tag).toBe("Failure")
      expect(kernel.calls).toHaveLength(0)

      const queuedWithUnusedProof = yield* Effect.exit(ManagedControl.prepareDirectMessage({
        pins: { ...pins, deliveryMode: "queued" as const },
        content: "Queue only",
        mailboxCapacity: 1,
        directAttempt: {
          attemptID: pins.directAttemptID,
          parentSessionID: pins.parentSessionID,
          childSessionID: pins.childSessionID,
          profileID: pins.profileID,
          profileRevision: pins.profileRevision,
          profileDigest: pins.profileDigest,
          ownerEpoch: pins.childOwnerEpoch,
          expectedRevision: "1",
          locationID: DIRECT_FACTS.locationID,
          workspaceID: DIRECT_FACTS.workspaceID,
          workspaceRevision: DIRECT_FACTS.workspaceRevision,
          capabilityDigest: DIRECT_FACTS.capabilityDigest,
          permissionsDigest: DIRECT_FACTS.permissionsDigest,
          budgetDigest: DIRECT_FACTS.budgetDigest,
          scopeDigest: SCOPE,
        },
      }))
      expect(queuedWithUnusedProof._tag).toBe("Failure")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("direct message rejects non-string content before any HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const pins = {
        parentSessionID: "ses_parent00000000000000000000000",
        childSessionID: "ses_child000000000000000000000001",
        childOwnerEpoch: "7",
        profileID: DIRECT_PROFILE_SELECTION.profileId,
        profileRevision: DIRECT_PROFILE_SELECTION.revision,
        profileDigest: DIRECT_PROFILE_DIGEST,
        permissionScopeDigest: DIRECT_FACTS.permissionsDigest,
        directAttemptID: "att_0123456789abcdef",
        messageID: "msg_0123456789abcdef",
        deliveryMode: "queued" as const,
        mailboxSequence: "1",
      }
      // A non-string payload must be rejected with a typed error before it can
      // be coerced (`TextEncoder.encode` stringifies a number) and reach RPC.
      const error = yield* Effect.flip(ManagedControl.prepareDirectMessage({
        pins,
        content: 123 as never,
        mailboxCapacity: 1,
      }))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(error.reason).toMatch(/content/i)
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("managed message rejects non-string content before any HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      // The content-type guard must fire before scope/pin validation and before
      // `Buffer.byteLength`, which throws a raw TypeError on a number.
      const error = yield* Effect.flip(ManagedControl.prepareManagedMessage({
        scope: {} as never,
        pins: {} as never,
        content: 123 as never,
      }))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(error.reason).toMatch(/content/i)
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("scope and result digests are canonical and sensitive to the intersected facts", () =>
    Effect.gen(function* () {
      const digest = ManagedControl.scopeDigest(scopeFacts)
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // Rule-set order cannot change the digest; any scope change must.
      expect(
        ManagedControl.scopeDigest({
          ...scopeFacts,
          permissionRules: [...scopeFacts.permissionRules].reverse(),
          deniedTools: [...scopeFacts.deniedTools].reverse(),
        }),
      ).toBe(digest)
      expect(ManagedControl.scopeDigest({ ...scopeFacts, workspaceRoot: "/tmp/other" })).not.toBe(digest)
      expect(ManagedControl.scopeDigest({ ...scopeFacts, permissionRules: ["read:*:allow", "bash:*:deny"] })).not.toBe(
        digest,
      )
      expect(ManagedControl.scopeDigest({ ...scopeFacts, background: true })).not.toBe(digest)

      const outputDigest = ManagedControl.outputDigest("child output")
      expect(outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      const managedOutputDigest = ManagedControl.managedOutputDigest("child output")
      expect(managedOutputDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
      expect(ManagedControl.managedOutputDigest("child output")).toBe(managedOutputDigest)
      const result = ManagedControl.resultDigest({
        childSessionID: scopeFacts.childSessionID,
        agent: "general",
        state: "completed",
        outputDigest,
        outputBytes: 12,
      })
      expect(result).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(
        ManagedControl.resultDigest({
          childSessionID: scopeFacts.childSessionID,
          agent: "general",
          state: "completed",
          outputDigest,
          outputBytes: 13,
        }),
      ).not.toBe(result)
      expect(() =>
        ManagedControl.resultDigest({
          childSessionID: scopeFacts.childSessionID,
          agent: "general",
          state: "completed",
          outputDigest: "not-a-digest",
          outputBytes: 1,
        }),
      ).toThrow(ManagedControlError)

      expect(ManagedControl.newAttemptID()).toMatch(/^att_[0-9a-f]{32}$/)
    }),
  )

  it.instance("direct attempts use stable one-use delivery keys and typed host refusals", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = ManagedControl.newAttemptID()
      const admitted = yield* ManagedControl.admitDirectAttempt({
        attemptID,
        parentSessionID: scopeFacts.parentSessionID,
        childSessionID: scopeFacts.childSessionID,
        agent: "general",
        profileSelection: DIRECT_PROFILE_SELECTION,
        profileDefinition: DIRECT_PROFILE,
        scopeDigest: SCOPE,
        ...DIRECT_FACTS,
      })
      expect(admitted.phase).toBe("EXECUTING")
      expect(admitted.revision).toBe("1")
      const admit = kernel.calls[0]!
      expect(admit.operation).toBe("admit_direct_attempt")
      // The Attempt id itself is the one-use key, so a lost response can be retried
      // with the identical logical command.
      expect(admit.deliveryID).toBe(attemptID)
      expect(Object.keys(admit.body).sort()).toEqual(
        ["agent", "attemptID", "childSessionID", "parentSessionID", "scopeDigest", "locationID", "workspaceID", "capabilityDigest", "permissionsDigest", "budgetDigest", "profileSelection", "profileDefinition"].sort(),
      )

      const bound = yield* ManagedControl.bindDirectAttemptEffects({
        scope: admitted.directAttempt,
        effectIDs: ["effect-child-write", "effect-child-read"],
      })
      expect(bound.revision).toBe("2")
      expect(bound.effectIDs).toEqual(["effect-child-write", "effect-child-read"])
      expect(bound.directAttempt.expectedRevision).toBe("2")
      expect(kernel.calls[1]!.operation).toBe("bind_direct_attempt_effects")
      expect(kernel.calls[1]!.body.directAttempt).toEqual({
        ...admitted.directAttempt,
        ownerEpoch: "7",
        expectedRevision: "1",
      })
      expect(kernel.calls[1]!.body.effectIDs).toEqual(["effect-child-write", "effect-child-read"])

      const settled = yield* ManagedControl.settleDirectAttempt({
        attemptID,
        outcome: "succeeded",
        resultDigest: ManagedControl.resultDigest({
          childSessionID: scopeFacts.childSessionID,
          agent: "general",
          state: "completed",
          outputDigest: ManagedControl.outputDigest("done"),
          outputBytes: 4,
        }),
        expectedRevision: 2,
      })
      expect(settled.outcome).toBe("SUCCEEDED")
      expect(settled.receiptDigest).toBe(RECEIPT)
      const settle = kernel.calls[2]!
      expect(settle.deliveryID).toBe(`${attemptID}.settle`)
      expect(settle.body.expectedRevision).toBe(2n)

      // A host refusal keeps the kernel's own code, never a generic failure.
      kernel.failingOperation = { operation: "cancel_direct_attempt", code: "managed_conflict", reason: "not executing" }
      const refusal = yield* ManagedControl.cancelDirectAttempt({ attemptID, expectedRevision: 2 }).pipe(Effect.exit)
      expect(refusal._tag).toBe("Failure")
      const error = yield* Effect.flip(ManagedControl.cancelDirectAttempt({ attemptID, expectedRevision: 2 }))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_conflict")
      expect(kernel.calls.at(-1)!.deliveryID).toBe(`${attemptID}.cancel`)
    }),
  )

  it.instance("a direct Attempt cannot report SUCCEEDED while its phase is UNKNOWN", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = ManagedControl.newAttemptID()
      kernel.directAttemptSettlementResponse = {
        status: "SETTLED",
        outcome: "SUCCEEDED",
        attemptID,
        attemptPhase: "UNKNOWN",
        parentSessionID: scopeFacts.parentSessionID,
        childSessionID: scopeFacts.childSessionID,
        agent: "general",
        scopeDigest: SCOPE,
        receiptDigest: null,
        resultDigest: null,
        failureCode: null,
        retryable: null,
        revision: 2,
      }

      const result = yield* Effect.flip(
        ManagedControl.settleDirectAttempt({ attemptID, outcome: "succeeded", expectedRevision: 1 }),
      )

      expect(result).toBeInstanceOf(ManagedControlError)
      expect(result.code).toBe("managed_protocol")
    }),
  )

  it.instance("cancellation rejects a host response for a different Attempt", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.directAttemptCancellationResponse = {
        status: "CANCELLED",
        attemptID: "att_ffffffffffffffffffffffffffffffff",
        attemptPhase: "CANCELLED",
        parentSessionID: scopeFacts.parentSessionID,
        childSessionID: scopeFacts.childSessionID,
        agent: "general",
        scopeDigest: SCOPE,
        receiptDigest: null,
        resultDigest: null,
        failureCode: null,
        retryable: null,
        revision: 2,
      }

      const error = yield* Effect.flip(
        ManagedControl.cancelDirectAttempt({ attemptID: ManagedControl.newAttemptID(), expectedRevision: 1 }),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
    }),
  )

  it.instance("an unavailable kernel reports managed_unavailable and accepts no digest from the caller", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.hosted = false
      expect(yield* ManagedControl.available()).toBe(false)
      const attemptID = ManagedControl.newAttemptID()
      const error = yield* Effect.flip(
        ManagedControl.admitDirectAttempt({
          attemptID,
          parentSessionID: scopeFacts.parentSessionID,
          childSessionID: scopeFacts.childSessionID,
          agent: "general",
          profileSelection: DIRECT_PROFILE_SELECTION,
          profileDefinition: DIRECT_PROFILE,
          scopeDigest: SCOPE,
          ...DIRECT_FACTS,
        }),
      )
      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_unavailable")
      expect(kernel.calls).toHaveLength(0)

      // A caller cannot even express a receipt digest: the settle request carries
      // only the outcome, the typed result digest and the revision fence.
      kernel.hosted = true
      kernel.admitted = true
      yield* ManagedControl.settleDirectAttempt({
        attemptID,
        outcome: "unknown",
        expectedRevision: 1,
      })
      const body = kernel.calls.at(-1)!.body
      expect("receiptDigest" in body).toBe(false)
      expect(body.outcome).toBe("unknown")
    }),
  )

  it.instance("rejects malformed Goal criterion text before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(
        ManagedControl.createGoalProposal({
          goalID: "goal-malformed-criterion",
          specID: "spec-malformed-criterion",
          objective: "Create a bounded proposal",
          projectRef: "project-one",
          workspaceRef: "workspace-one",
          capabilityScope: [],
          scope: ["packages/opencode/**"],
          constraints: [],
          criteria: [{ id: "tests-pass", description: 17 } as never],
          budget: {
            maxTasks: 1,
            maxAttemptsPerTask: 1,
            maxRunDurationMs: 60_000,
            maxMemoryBytes: null,
            maxDiskBytes: null,
            maxWorkers: 1,
            maxTokens: 1000,
            maxCostMicros: 0,
          },
          sourceDigests: [],
        }),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("rejects a non-string Goal objective before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.createGoalProposal({
        goalID: "goal-malformed-objective",
        specID: "spec-malformed-objective",
        objective: 42 as never,
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        capabilityScope: [],
        scope: ["packages/opencode/**"],
        constraints: [],
        criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
        budget: {
          maxTasks: 1,
          maxAttemptsPerTask: 1,
          maxRunDurationMs: 60_000,
          maxMemoryBytes: null,
          maxDiskBytes: null,
          maxWorkers: 1,
          maxTokens: 1000,
          maxCostMicros: 0,
        },
        sourceDigests: [],
      }))

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("creates a Goal and its first SpecVersion in one host mutation", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const proposal = yield* ManagedControl.createGoalProposal({
        goalID: "goal-atomic",
        specID: "spec-atomic",
        objective: "Create the managed proposal atomically",
        projectRef: "project-one",
        workspaceRef: "workspace-one",
        capabilityScope: [],
        scope: ["packages/opencode/**"],
        constraints: ["Do not dispatch effects"],
        criteria: [{ id: "tests-pass", description: "Focused tests pass" }],
        budget: {
          maxTasks: 1,
          maxAttemptsPerTask: 1,
          maxRunDurationMs: 60_000,
          maxMemoryBytes: null,
          maxDiskBytes: null,
          maxWorkers: 1,
          maxTokens: 1000,
          maxCostMicros: 0,
        },
        sourceDigests: [],
      })
      expect(proposal.specDigest).toBe(RECEIPT)
      expect(kernel.calls).toHaveLength(1)
      expect(kernel.calls[0]!.operation).toBe("create_goal_proposal")
      expect(kernel.calls[0]!.deliveryID).toBe("goal-atomic")
      expect(kernel.calls[0]!.body).not.toHaveProperty("principal")
      expect(kernel.calls[0]!.body).not.toHaveProperty("createdBy")
      expect(kernel.calls[0]!.body).not.toHaveProperty("proposedBy")
    }),
  )

  it.instance("a host OS principal cannot make a SpecVersion review decision", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const result = yield* Effect.flip(
        ManagedControl.acceptSpec({
          trustedPrincipal: { kind: "host_os" },
          goalID: "goal-client",
          specID: "spec-client",
          specDigest: RECEIPT,
          expectedRevision: 2,
        }),
      )

      expect(result).toBeInstanceOf(ManagedControlError)
      expect(result.code).toBe("independent_verifier_required")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("review forwards only the middleware-derived ServerAuth subject", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const result = yield* Effect.flip(
        ManagedControl.rejectSpec({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          specID: "spec-client",
          specDigest: RECEIPT,
          expectedRevision: 2,
        }),
      )

      expect(result).toBeInstanceOf(ManagedControlError)
      expect(result.code).toBe("managed_protocol")
      expect(kernel.calls[0]!.operation).toBe("assign_spec_reviewer")
      expect(kernel.calls[0]!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls[0]!.body).not.toHaveProperty("principal")
      expect(kernel.calls[0]!.body).not.toHaveProperty("rejectedBy")
      expect(kernel.calls[0]!.body).not.toHaveProperty("rejectedAtMs")
      expect(kernel.calls[1]!.operation).toBe("reject_spec")
      expect(kernel.calls[1]!.body.expectedRevision).toBe(3n)
    }),
  )

  it.instance("a SpecVersion decision status must match the requested operation", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "REJECTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 3,
        revision: 4,
      }

      const result = yield* Effect.flip(
        ManagedControl.acceptSpec({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          specID: "spec-client",
          specDigest: RECEIPT,
          expectedRevision: 2,
        }),
      )

      expect(result).toBeInstanceOf(ManagedControlError)
      expect(result.code).toBe("managed_protocol")
    }),
  )

  it.instance("a well-formed kernel SpecVersion decision preserves reviewer provenance", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "ACCEPTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 3,
        revision: 4,
      }

      const result = yield* ManagedControl.acceptSpec({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedRevision: 2,
      })
      expect(result).toEqual({
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        decision: "ACCEPTED",
        decidedBy: "server_auth:reviewer",
        decidedAtMs: 123,
        reviewedRevision: "3",
        revision: "4",
      })
      expect(kernel.calls[1]!.body).toEqual({
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedRevision: 3n,
      })
      expect(kernel.calls[1]!.trustedPrincipal).toEqual(REVIEWER)
    }),
  )

  it.instance("a SpecVersion decision carries the reviewed Goal revision for compare-and-swap", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "ACCEPTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 3,
        revision: 4,
      }

      const decision = yield* ManagedControl.acceptSpec({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedRevision: 2,
      })

      expect(decision.reviewedRevision).toBe("3")
      expect(kernel.calls[1]!.body).toEqual({
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedRevision: 3n,
      })
      expect(kernel.calls[1]!.trustedPrincipal).toEqual(REVIEWER)
    }),
  )

  it.instance("a SpecVersion decision rejects a host echo for a different reviewed revision", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "ACCEPTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 1,
        revision: 4,
      }

      const error = yield* Effect.flip(
        ManagedControl.acceptSpec({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          specID: "spec-client",
          specDigest: RECEIPT,
          expectedRevision: 2,
        }),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
    }),
  )

  it.instance("a SpecVersion decision preserves a u64 Goal revision from the review projection", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "ACCEPTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 9007199254740994n,
        revision: 9007199254740995n,
      }

      const result = yield* ManagedControl.acceptSpec({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedRevision: "9007199254740993",
      })

      expect(result.revision).toBe("9007199254740995")
      expect(kernel.calls[1]!.body.expectedRevision).toBe(9007199254740994n)
    }),
  )

  it.instance("a Goal review snapshot projects pending specs with exact u64 revision strings", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.goalSnapshotResponse = {
        goalID: "goal-client",
        revision: 9007199254740993n,
        goal: {
          objective: "Build a safe feature",
          projectRef: "project-client",
          workspaceRef: "workspace-client",
          createdBy: "server_auth:author",
          activeSpecVersionID: null,
        },
        specs: [
          {
            specID: "spec-client",
            specDigest: RECEIPT,
            accepted: false,
            acceptedBy: null,
            acceptedAtMs: null,
            rejectedBy: null,
            rejectedAtMs: null,
            parentVersionID: null,
            objective: "Build a safe feature",
            projectRef: "project-client",
            workspaceRef: "workspace-client",
            capabilityScope: [],
            scope: ["packages/opencode"],
            constraints: ["No effect bypass"],
            criteria: [{ id: "criterion-1", description: "The behavior is tested" }],
            budget: {
              maxTasks: 2,
              maxAttemptsPerTask: 1,
              maxRunDurationMs: 60_000,
              maxMemoryBytes: 9007199254740993n,
              maxDiskBytes: null,
              maxWorkers: 1,
              maxTokens: null,
              maxCostMicros: null,
            },
            sourceDigests: [SCOPE],
            proposedBy: "server_auth:author",
          },
          {
            specID: "spec-accepted",
            specDigest: RECEIPT,
            accepted: true,
            acceptedBy: "server_auth:reviewer",
            acceptedAtMs: 123,
            rejectedBy: null,
            rejectedAtMs: null,
            parentVersionID: null,
            objective: "Already accepted",
            projectRef: "project-client",
            workspaceRef: "workspace-client",
            capabilityScope: [],
            scope: [],
            constraints: [],
            criteria: [],
            budget: {
              maxTasks: 1,
              maxAttemptsPerTask: 1,
              maxRunDurationMs: 60_000,
              maxMemoryBytes: null,
              maxDiskBytes: null,
              maxWorkers: 1,
              maxTokens: null,
              maxCostMicros: null,
            },
            sourceDigests: [],
            proposedBy: "server_auth:author",
          },
        ],
        runs: [],
        attempts: [],
      }

      const result = yield* ManagedControl.goalReviewSnapshot("goal-client", REVIEWER)
      const selfReview = yield* ManagedControl.goalReviewSnapshot("goal-client", {
        kind: "server_auth",
        subject: "author",
      })
      const localReview = yield* ManagedControl.goalReviewSnapshot("goal-client", { kind: "host_os" })

      expect(result).toEqual({
        goalID: "goal-client",
        goalRevision: "9007199254740993",
        projectRef: "project-client",
        workspaceRef: "workspace-client",
        proposals: [
          {
            goalId: "goal-client",
            goalRevision: "9007199254740993",
            specVersionId: "spec-client",
            parentVersionId: null,
            proposedBy: "server_auth:author",
            reviewAvailability: { available: true },
            specDigest: RECEIPT,
            objective: "Build a safe feature",
            projectRef: "project-client",
            workspaceRef: "workspace-client",
            capabilityScope: [],
            scope: ["packages/opencode"],
            constraints: ["No effect bypass"],
            criteria: [{ id: "criterion-1", description: "The behavior is tested" }],
            budget: {
              maxTasks: 2,
              maxAttemptsPerTask: 1,
              maxRunDurationMs: 60_000,
              maxWorkers: 1,
              maxMemoryBytes: "9007199254740993",
              maxDiskBytes: null,
              maxTokens: null,
              maxCostMicros: null,
            },
            sourceDigests: [SCOPE],
          },
        ],
        acceptedSpecs: [
          {
            specID: "spec-accepted",
            specDigest: RECEIPT,
            objective: "Already accepted",
            scope: [],
            capabilityScope: [],
            constraints: [],
            criteria: [],
            budget: {
              maxTasks: 1,
              maxAttemptsPerTask: 1,
              maxRunDurationMs: 60_000,
              maxWorkers: 1,
              maxMemoryBytes: null,
              maxDiskBytes: null,
              maxTokens: null,
              maxCostMicros: null,
            },
          },
        ],
        eligibleProfiles: [],
        eligibleProfilesTruncated: false,
        runs: [],
      })
      expect(selfReview.proposals[0]?.reviewAvailability).toEqual({
        available: false,
        reason: "The authenticated proposer cannot review their own SpecVersion.",
      })
      expect(localReview.proposals[0]?.reviewAvailability).toEqual({
        available: false,
        reason: "Review requires an authenticated ServerAuth principal.",
      })
      expect(kernel.calls.at(-1)?.body).toEqual({ goalID: "goal-client" })
    }),
  )

  it.instance("lists bounded pending Goal reviews for durable Core to TUI discovery", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses.list_pending_reviews = {
        goals: [
          {
            goalID: "goal-inbox",
            revision: 4n,
            goal: { projectRef: "project-client", workspaceRef: "workspace-client" },
            specs: [
              {
                specID: "spec-inbox",
                specDigest: RECEIPT,
                accepted: false,
                acceptedBy: null,
                acceptedAtMs: null,
                rejectedBy: null,
                rejectedAtMs: null,
                parentVersionID: null,
                objective: "Review this feature",
                projectRef: "project-client",
                workspaceRef: "workspace-client",
                capabilityScope: [],
                scope: [],
                constraints: [],
                criteria: [],
                budget: {
                  maxTasks: 1,
                  maxAttemptsPerTask: 1,
                  maxRunDurationMs: 1000,
                  maxWorkers: 1,
                  maxMemoryBytes: null,
                  maxDiskBytes: null,
                  maxTokens: null,
                  maxCostMicros: null,
                },
                sourceDigests: [],
                proposedBy: "server_auth:author",
              },
            ],
            runs: [],
            attempts: [],
          },
        ],
      }

      const result = yield* ManagedControl.listPendingReviews(REVIEWER)

      expect(result.goals).toHaveLength(1)
      expect(result.goals[0]).toMatchObject({
        goalID: "goal-inbox",
        projectRef: "project-client",
        workspaceRef: "workspace-client",
        proposals: [
          { specVersionId: "spec-inbox", reviewAvailability: { available: true } },
        ],
      })
      expect(kernel.calls.at(-1)).toMatchObject({
        operation: "list_pending_reviews",
        body: {},
      })
    }),
  )

  it.instance("a SpecVersion decision must echo the exact reviewed Goal, version and digest", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.specDecisionResponse = {
        status: "ACCEPTED",
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: `blake3:${"c".repeat(64)}`,
        acceptedBy: "server_auth:reviewer",
        acceptedAtMs: 123,
        reviewedRevision: 2,
        revision: 3,
      }

      const result = yield* Effect.flip(
        ManagedControl.acceptSpec({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          specID: "spec-client",
          specDigest: RECEIPT,
          expectedRevision: 2,
        }),
      )

      expect(result).toBeInstanceOf(ManagedControlError)
      expect(result.code).toBe("managed_protocol")
    }),
  )

  it.instance("a managed Attempt admit carries a one-use key, bigint fence and exact u64 revision", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = `att_${"a".repeat(32)}`
      const input = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
        parentSessionID: "ses_parent00000000000000000000000",
        locationID: "location-1",
        sessionID: "ses_child",
        preAdmissionProofDigest: `blake3:${"1".repeat(64)}`,
        resourcePolicyProjectionRevision: "1",
        resourcePolicyProjectionDigest: `blake3:${"2".repeat(64)}`,
        expectedRevision: 4 as const,
        profileSelection: DIRECT_PROFILE_SELECTION,
        contextSelection: Schema.decodeUnknownSync(ContextSelectionV1)({
          schemaVersion: 1,
          lane: "managed",
          sessionID: "ses_child",
          mode: "fresh",
          attemptID,
          requestSequence: "1",
          requestID: `req_managed_${attemptID}_1`,
          sourceRevision: "0",
          sources: [
            {
              kind: "managed-task",
              sourceID: "task-client",
              sourceRevision: "0",
              contentDigest: SCOPE,
              sourceAuthority: "managed-control",
              trust: "user",
              included: true,
              inclusionReason: "required",
            },
            {
              kind: "accepted-spec",
              sourceID: "spec-client",
              sourceRevision: "0",
              contentDigest: RECEIPT,
              sourceAuthority: "managed-control",
              trust: "system",
              included: true,
              inclusionReason: "required",
            },
            {
              kind: "agent-profile",
              sourceID: "specialist.reader",
              sourceRevision: "1",
              contentDigest: DIRECT_PROFILE_DIGEST,
              sourceAuthority: "core-config",
              trust: "system",
              included: true,
              inclusionReason: "profile",
            },
            {
              kind: "provider-input",
              sourceID: `req_managed_${attemptID}_1`,
              sourceRevision: "1",
              contentDigest: SCOPE,
              sourceAuthority: "core-prompt-compiler",
              trust: "mixed",
              included: true,
              inclusionReason: "current_request",
            },
            {
              kind: "tool",
              sourceID: "toolset:native-rich",
              sourceRevision: RECEIPT,
              contentDigest: RECEIPT,
              sourceAuthority: "tool-registry",
              trust: "system",
              included: true,
              inclusionReason: "selected_tool",
              harnessRevision: 1,
            },
          ],
        }),
      }
      const admitted = yield* ManagedControl.admitAttempt(input)
      expect(admitted).toEqual({
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
        parentSessionID: "ses_parent00000000000000000000000",
        ownerEpoch: "7",
        locationID: "location-1",
        sessionID: "ses_child",
        attemptPhase: "EXECUTING",
        runPhase: "RUNNING",
        workspaceRevision: `blake3:${"f".repeat(64)}`,
        requestSequence: "1",
        requestID: `req_managed_${attemptID}_1`,
        contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
        profile: {
          profileID: DIRECT_PROFILE.profileId,
          profileRevision: "1",
          profileDigest: DIRECT_PROFILE_DIGEST,
        },
        managedProviderRoute: {
          providerID: "test",
          modelID: "test-model",
          harnessID: "native-rich",
          routeID: TEST_ROUTE_ID,
          endpointRevision: TEST_ENDPOINT_REVISION,
          credentialLeaseRef: "lease-test-0001",
        },
        managedAttempt: {
          goalID: "goal-client",
          runID: "run-client",
          taskID: "task-client",
          attemptID,
          ownerEpoch: "7",
          expectedManagedRevision: "5",
          requestSequence: "1",
          requestID: `req_managed_${attemptID}_1`,
          contextSelectionDigest: `blake3:${"c".repeat(64)}`,
          locationID: "location-1",
          sessionID: "ses_child",
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          effectiveMaxTokens: "5000",
          remainingTokens: "5000",
          delegationBindingDigest: `blake3:${"a".repeat(64)}`,
          permissionScopeDigest: `blake3:${"d".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree-1",
            worktreeBaseRevision: "base-1",
            worktreePoolRevision: "3",
            locationID: "location-1",
            workspaceID: "workspace-1",
            workspaceRef: "refs/heads/managed",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
          },
        },
        revision: "5",
      })
      expect(kernel.calls[0]!.deliveryID).toBe(`${attemptID}.admit`)
      expect(kernel.calls[0]!.body).toEqual({
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
        parentSessionID: "ses_parent00000000000000000000000",
        locationID: "location-1",
        managedProviderRoute: {
          providerID: "test",
          modelID: "test-model",
          harnessID: "native-rich",
          routeID: TEST_ROUTE_ID,
          endpointRevision: TEST_ENDPOINT_REVISION,
          credentialLeaseRef: "lease-test-0001",
        },
        sessionID: "ses_child",
        preAdmissionProofDigest: `blake3:${"1".repeat(64)}`,
        resourcePolicyProjectionRevision: "1",
        resourcePolicyProjectionDigest: `blake3:${"2".repeat(64)}`,
        // Rust reads `expectedRevision` with `canonical_decimal_revision`, so the
        // wire form is the canonical decimal string (as Stage-A `reserve` sends).
        expectedRevision: "4",
        profileDefinition: DIRECT_PROFILE,
        contextSelection: input.contextSelection,
      })
      // Exactly Rust's closed `admit` key set: no unlisted key (the previously
      // sent `profileSelection`) and no missing required key. HostKernel's
      // `strict_fields` rejects any other shape with `invalid_effect_request`.
      expect(Object.keys(kernel.calls[0]!.body).toSorted()).toEqual([...ManagedControl.ADMIT_BODY_KEYS].toSorted())
      expect(Object.keys(kernel.calls[0]!.body)).not.toContain("profileSelection")

      // A retry of the identical logical command reuses the same delivery key, and a
      // full u64 revision survives the kernel's BigInt encoding without precision loss.
      kernel.managedResponses.admit = {
        status: "ADMITTED",
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
        parentSessionID: "ses_parent00000000000000000000000",
        ownerEpoch: 9007199254740993n,
        locationID: "location-1",
        sessionID: "ses_child",
        workspaceRevision: `blake3:${"f".repeat(64)}`,
        attemptPhase: "EXECUTING",
        runPhase: "RUNNING",
        revision: 9007199254740993n,
        requestSequence: 1,
        requestID: `req_managed_${attemptID}_1`,
        contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
        profile: {
          profileID: DIRECT_PROFILE.profileId,
          profileRevision: 1,
          profileDigest: DIRECT_PROFILE_DIGEST,
        },
        managedProviderRoute: {
          providerID: "test",
          modelID: "test-model",
          harnessID: "native-rich",
          routeID: TEST_ROUTE_ID,
          endpointRevision: TEST_ENDPOINT_REVISION,
          credentialLeaseRef: "lease-test-0001",
        },
        managedAttempt: {
          goalID: "goal-client",
          runID: "run-client",
          taskID: "task-client",
          attemptID,
          ownerEpoch: "9007199254740993",
          expectedManagedRevision: "9007199254740993",
          requestSequence: "1",
          requestID: `req_managed_${attemptID}_1`,
          contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
          locationID: "location-1",
          sessionID: "ses_child",
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          effectiveMaxTokens: "5000",
          remainingTokens: "5000",
          delegationBindingDigest: `blake3:${"a".repeat(64)}`,
          permissionScopeDigest: `blake3:${"d".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree-1",
            worktreeBaseRevision: "base-1",
            worktreePoolRevision: "3",
            locationID: "location-1",
            workspaceID: "workspace-1",
            workspaceRef: "refs/heads/managed",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
          },
        },
      }
      const retried = yield* ManagedControl.admitAttempt(input)
      expect(retried.revision).toBe("9007199254740993")
      expect(kernel.calls[1]!.deliveryID).toBe(kernel.calls[0]!.deliveryID)

      // A host echo for another Attempt must never be adopted as this admit's result.
      kernel.managedResponses.admit = {
        status: "ADMITTED",
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: `att_${"b".repeat(32)}`,
        parentSessionID: "ses_parent00000000000000000000000",
        ownerEpoch: 7n,
        locationID: "location-1",
        sessionID: "ses_child",
        workspaceRevision: `blake3:${"f".repeat(64)}`,
        attemptPhase: "EXECUTING",
        runPhase: "RUNNING",
        revision: 6n,
        requestSequence: 1,
        requestID: `req_managed_att_${"b".repeat(32)}_1`,
        contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
        profile: {
          profileID: DIRECT_PROFILE.profileId,
          profileRevision: 1,
          profileDigest: DIRECT_PROFILE_DIGEST,
        },
        managedProviderRoute: {
          providerID: "test",
          modelID: "test-model",
          harnessID: "native-rich",
          routeID: TEST_ROUTE_ID,
          endpointRevision: TEST_ENDPOINT_REVISION,
          credentialLeaseRef: "lease-test-0001",
        },
        managedAttempt: {
          goalID: "goal-client",
          runID: "run-client",
          taskID: "task-client",
          attemptID: `att_${"b".repeat(32)}`,
          ownerEpoch: "7",
          expectedManagedRevision: "6",
          requestSequence: "1",
          requestID: `req_managed_att_${"b".repeat(32)}_1`,
          contextSelectionDigest: CONTEXT_SELECTION_DIGEST,
          locationID: "location-1",
          sessionID: "ses_child",
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          effectiveMaxTokens: "5000",
          remainingTokens: "5000",
          delegationBindingDigest: `blake3:${"a".repeat(64)}`,
          permissionScopeDigest: `blake3:${"d".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree-1",
            worktreeBaseRevision: "base-1",
            worktreePoolRevision: "3",
            locationID: "location-1",
            workspaceID: "workspace-1",
            workspaceRef: "refs/heads/managed",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
          },
        },
      }
      const error = yield* Effect.flip(ManagedControl.admitAttempt(input))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")

      // Fail closed before dispatch: without this candidate's HostKernel
      // resource-policy projection pin Rust's `admit` answers
      // `resource_policy_unavailable`, so the client refuses to send at all.
      const dispatched = kernel.calls.length
      const {
        resourcePolicyProjectionRevision: _ignoredRevision,
        resourcePolicyProjectionDigest: _ignoredDigest,
        ...withoutProjection
      } = input
      const missing = yield* Effect.flip(ManagedControl.admitAttempt(withoutProjection))
      expect(missing).toBeInstanceOf(ManagedControlError)
      expect("code" in missing ? missing.code : undefined).toBe("managed_protocol")
      expect(kernel.calls.length).toBe(dispatched)

      // The same boundary rejects a non-canonical projection revision and a
      // non-BLAKE3 projection digest before anything is dispatched.
      const nonCanonical = yield* Effect.flip(
        ManagedControl.admitAttempt({ ...input, resourcePolicyProjectionRevision: "01" }),
      )
      expect("code" in nonCanonical ? nonCanonical.code : undefined).toBe("managed_protocol")
      const wrongDigest = yield* Effect.flip(
        ManagedControl.admitAttempt({ ...input, resourcePolicyProjectionDigest: `sha256:${"3".repeat(64)}` }),
      )
      expect("code" in wrongDigest ? wrongDigest.code : undefined).toBe("managed_protocol")
      expect(kernel.calls.length).toBe(dispatched)
    }),
  )

  it.instance("the admit body guard refuses any key outside the HostKernel closed set", () =>
    Effect.gen(function* () {
      // Rust's `strict_fields(body, required, &[])` accepts exactly these 14
      // keys for `admit`; there are no optional keys.
      expect(ManagedControl.ADMIT_BODY_KEYS).toHaveLength(14)
      const closedBody: Record<string, unknown> = Object.fromEntries(
        ManagedControl.ADMIT_BODY_KEYS.map((key) => [key, "value"]),
      )
      expect(() => ManagedControl.requireClosedAdmitBody("admit", closedBody)).not.toThrow()
      // The key this client used to send — and any other unlisted key — is
      // refused before dispatch, exactly as HostKernel rejects it.
      expect(() =>
        ManagedControl.requireClosedAdmitBody("admit", {
          ...closedBody,
          profileSelection: DIRECT_PROFILE_SELECTION,
        }),
      ).toThrow()
      // A missing required key is refused too, mirroring `strict_fields`.
      const missingRequired: Record<string, unknown> = { ...closedBody }
      delete missingRequired.goalID
      expect(() => ManagedControl.requireClosedAdmitBody("admit", missingRequired)).toThrow()
      expect(() => ManagedControl.requireClosedAdmitBody("admit", { goalID: "goal-client" })).toThrow()
      yield* Effect.void
    }),
  )

  it.instance("a managed delivery key longer than the kernel bound becomes one stable digest", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = `att_${"a".repeat(240)}`
      const input = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
        parentSessionID: "ses_parent00000000000000000000000",
        locationID: "location-1",
        sessionID: "ses_child",
        preAdmissionProofDigest: `blake3:${"1".repeat(64)}`,
        resourcePolicyProjectionRevision: "1",
        resourcePolicyProjectionDigest: `blake3:${"2".repeat(64)}`,
        expectedRevision: 1,
        profileSelection: DIRECT_PROFILE_SELECTION,
        contextSelection: Schema.decodeUnknownSync(ContextSelectionV1)({
          schemaVersion: 1,
          lane: "managed",
          sessionID: "ses_child",
          mode: "fresh",
          attemptID,
          requestSequence: "1",
          requestID: `req_managed_long_key_1`,
          sourceRevision: "0",
          sources: [
            {
              kind: "managed-task",
              sourceID: "task-client",
              sourceRevision: "0",
              contentDigest: SCOPE,
              sourceAuthority: "managed-control",
              trust: "user",
              included: true,
              inclusionReason: "required",
            },
            {
              kind: "accepted-spec",
              sourceID: "spec-client",
              sourceRevision: "0",
              contentDigest: RECEIPT,
              sourceAuthority: "managed-control",
              trust: "system",
              included: true,
              inclusionReason: "required",
            },
            {
              kind: "agent-profile",
              sourceID: "specialist.reader",
              sourceRevision: "1",
              contentDigest: DIRECT_PROFILE_DIGEST,
              sourceAuthority: "core-config",
              trust: "system",
              included: true,
              inclusionReason: "profile",
            },
            {
              kind: "provider-input",
              sourceID: `req_managed_long_key_1`,
              sourceRevision: "1",
              contentDigest: SCOPE,
              sourceAuthority: "core-prompt-compiler",
              trust: "mixed",
              included: true,
              inclusionReason: "current_request",
            },
            {
              kind: "tool",
              sourceID: "toolset:native-rich",
              sourceRevision: RECEIPT,
              contentDigest: RECEIPT,
              sourceAuthority: "tool-registry",
              trust: "system",
              included: true,
              inclusionReason: "selected_tool",
              harnessRevision: 1,
            },
          ],
        }),
      }
      yield* ManagedControl.admitAttempt(input)
      yield* ManagedControl.admitAttempt(input)

      const first = kernel.calls[0]!.deliveryID!
      expect(first).toMatch(/^key\.[0-9a-f]{64}$/)
      expect(first.length).toBeLessThanOrEqual(200)
      expect(kernel.calls[1]!.deliveryID).toBe(first)
    }),
  )

  it.instance("binding a settled effect to an Attempt stays exact and one-use", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const input = {
        scope: {
          goalID: "goal-client",
          runID: "run-client",
          taskID: "task-client",
          attemptID: "att-managed",
          ownerEpoch: "9007199254740993",
          expectedManagedRevision: "9007199254740995",
          requestSequence: "1",
          requestID: "req_managed_att-managed_1",
          contextSelectionDigest: `blake3:${"c".repeat(64)}`,
          locationID: "location-1",
          sessionID: "ses_child",
          workspaceRevision: `blake3:${"f".repeat(64)}`,
          effectiveMaxTokens: "5000",
          remainingTokens: "5000",
          delegationBindingDigest: `blake3:${"a".repeat(64)}`,
          permissionScopeDigest: `blake3:${"d".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree-1",
            worktreeBaseRevision: "base-1",
            worktreePoolRevision: "3",
            locationID: "location-1",
            workspaceID: "workspace-1",
            workspaceRef: "refs/heads/managed",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
          },
        },
        effectID: "effect-1",
      }
      const bound = yield* ManagedControl.bindAttemptEffect(input)
      expect(bound).toEqual({
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "att-managed",
        effectID: "effect-1",
        locationID: "location-1",
        revision: "6",
      })
      expect(kernel.calls[0]!.deliveryID).toBe("att-managed.bind")
      expect(kernel.calls[0]!.body).toEqual({
        goalID: input.scope.goalID,
        runID: input.scope.runID,
        taskID: input.scope.taskID,
        attemptID: input.scope.attemptID,
        effectID: input.effectID,
        locationID: input.scope.locationID,
        sessionID: input.scope.sessionID,
        managedAttempt: {
          ...input.scope,
          ownerEpoch: "9007199254740993",
          expectedManagedRevision: "9007199254740995",
        },
      })

      // The kernel only resolves effects of this Attempt; another Attempt's binding
      // is never accepted as this command's provenance.
      kernel.managedResponses.bind_attempt_effect = {
        status: "BOUND",
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "att-other",
        effectID: "effect-1",
        locationID: "location-1",
        revision: 7n,
      }
      const error = yield* Effect.flip(ManagedControl.bindAttemptEffect(input))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
    }),
  )

  it.instance("managed effect scope rejects noncanonical counters before RPC", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(
        ManagedControl.bindAttemptEffect({
          scope: {
            goalID: "goal-client",
            runID: "run-client",
            taskID: "task-client",
            attemptID: "att-managed",
            ownerEpoch: "07",
            expectedManagedRevision: "5",
            requestSequence: "1",
            requestID: "req_managed_att-managed_1",
            contextSelectionDigest: `blake3:${"c".repeat(64)}`,
            locationID: "location-1",
            sessionID: "ses_child",
            workspaceRevision: `blake3:${"f".repeat(64)}`,
            effectiveMaxTokens: "5000",
            remainingTokens: "5000",
            delegationBindingDigest: `blake3:${"a".repeat(64)}`,
            permissionScopeDigest: `blake3:${"d".repeat(64)}`,
            worktreeTarget: {
              worktreeID: "worktree-1",
              worktreeBaseRevision: "base-1",
              worktreePoolRevision: "3",
              locationID: "location-1",
              workspaceID: "workspace-1",
              workspaceRef: "refs/heads/managed",
              canonicalRoot: "/workspace/managed",
              workspaceRevision: `blake3:${"f".repeat(64)}`,
            },
          },
          effectID: "effect-1",
        }),
      )
      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("managed scope rejects JSON numbers and preserves the full decimal u64 boundary", () =>
    Effect.gen(function* () {
      const scope = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "att-managed",
        ownerEpoch: "18446744073709551615",
        expectedManagedRevision: "9007199254740993",
        requestSequence: "1",
        requestID: "req_managed_att-managed_1",
        contextSelectionDigest: `blake3:${"c".repeat(64)}`,
        locationID: "location-1",
        sessionID: "ses_child",
        workspaceRevision: `blake3:${"f".repeat(64)}`,
        effectiveMaxTokens: "5000",
        remainingTokens: "5000",
        delegationBindingDigest: `blake3:${"a".repeat(64)}`,
        permissionScopeDigest: `blake3:${"d".repeat(64)}`,
        worktreeTarget: {
          worktreeID: "worktree-1",
          worktreeBaseRevision: "base-1",
          worktreePoolRevision: "18446744073709551615",
          locationID: "location-1",
          workspaceID: "workspace-1",
          workspaceRef: "refs/heads/managed",
          canonicalRoot: "/workspace/managed",
          workspaceRevision: `blake3:${"f".repeat(64)}`,
        },
      } as const

      const wire = ManagedControl.managedAttemptScopeToWire(scope)
      expect(wire.ownerEpoch).toBe("18446744073709551615")
      expect(wire.expectedManagedRevision).toBe("9007199254740993")
      expect(wire.worktreeTarget.worktreePoolRevision).toBe("18446744073709551615")

      // JSON numbers at a decimal-string boundary must not be coerced through
      // RegExp.test/BigInt; a value above 2^53 may already have lost precision.
      const numeric = { ...scope, ownerEpoch: 9007199254740993 as unknown as string }
      expect(() => ManagedControl.managedAttemptScopeToWire(numeric)).toThrow(ManagedControlError)
    }),
  )

  it.instance("plan and start reject numeric Goal revisions before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const numericRevision = 9007199254740993 as unknown as string

      const planError = yield* Effect.flip(ManagedControl.createRunPlan({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedGoalRevision: numericRevision,
        runID: "run-client",
        projectRef: "project-client",
        workspaceRef: "workspace-client",
        tasks: [],
      }))
      expect(planError).toBeInstanceOf(ManagedControlError)
      expect("reason" in planError ? planError.reason : undefined).toBe("expectedGoalRevision is not a canonical u64")
      expect(kernel.calls).toHaveLength(0)

      const startError = yield* Effect.flip(ManagedControl.startPlannedRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        runID: "run-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedGoalRevision: numericRevision,
        idempotencyKey: "start-key-1",
        sessionID: "ses_root",
        projectRef: "project-client",
        workspaceRef: "workspace-client",
        sessionLink: {
          sessionID: "ses_root",
          sourceStoreID: "store-root",
          sourceInstanceID: "instance-root",
          sourceCursor: {
            ownerKind: "session",
            ownerId: "ses_root",
            seq: "1",
            eventDigest: RECEIPT,
          },
          sourceEpoch: "1",
          latestObservedMessageID: null,
          latestObservedPartID: null,
          sourceDigest: SCOPE,
          redactionProfile: "horizon.session-link.ids-only.v1",
          protocolVersion: 1,
          goalID: "goal-client",
          projectID: "project-client",
          workspaceID: "workspace-client",
        },
      }))
      expect(startError).toBeInstanceOf(ManagedControlError)
      expect("reason" in startError ? startError.reason : undefined).toBe("expectedGoalRevision is not a canonical u64")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("Run planning rejects a malformed Task collection before HostKernel dispatch", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(ManagedControl.createRunPlan({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        specID: "spec-client",
        specDigest: RECEIPT,
        expectedGoalRevision: "1",
        runID: "run-client",
        projectRef: "project-client",
        workspaceRef: "workspace-client",
        tasks: null as never,
      }))

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("a managed Attempt settlement carries exactly the outcome shape the kernel requires", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const attemptID = `att_${"c".repeat(32)}`
      const base = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID,
      }

      const succeeded = yield* ManagedControl.settleAttempt({
        ...base,
        outcome: "succeeded",
        expectedRevision: "6",
      })
      expect(succeeded).toEqual({
        outcome: "SUCCEEDED",
        ...base,
        attemptPhase: "SUCCEEDED",
        runPhase: "RUNNING",
        receiptDigest: RECEIPT,
        revision: "7",
      })
      expect(kernel.calls[0]!.deliveryID).toBe(`${attemptID}.settle`)
      expect(kernel.calls[0]!.body).toEqual({
        ...base,
        outcome: "succeeded",
        expectedRevision: 6n,
      })

      // A failure names a bounded code and retryability; no other outcome may carry
      // either field, and an invalid shape never reaches the socket.
      const callsBeforeFailure = kernel.calls.length
      const missing = yield* Effect.flip(
        ManagedControl.settleAttempt({ ...base, outcome: "failed", expectedRevision: 7 }),
      )
      expect(missing).toBeInstanceOf(ManagedControlError)
      expect(missing.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(callsBeforeFailure)

      const failed = yield* ManagedControl.settleAttempt({
        ...base,
        outcome: "failed",
        expectedRevision: 7,
        failureCode: "tool_error",
        retryable: true,
      })
      expect(failed.outcome).toBe("FAILED")
      expect(failed.attemptPhase).toBe("FAILED")
      expect(failed.receiptDigest).toBeNull()
      expect(kernel.calls.at(-1)!.body).toEqual({
        ...base,
        outcome: "failed",
        expectedRevision: 7n,
        failureCode: "tool_error",
        retryable: true,
      })

      const callsBeforeUnknown = kernel.calls.length
      const extra = yield* Effect.flip(
        ManagedControl.settleAttempt({
          ...base,
          outcome: "unknown",
          expectedRevision: 8,
          failureCode: "tool_error",
        }),
      )
      expect(extra.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(callsBeforeUnknown)

      // UNKNOWN fences the Run as RECONCILING rather than reporting success.
      const unknown = yield* ManagedControl.settleAttempt({ ...base, outcome: "unknown", expectedRevision: 8 })
      expect(unknown.outcome).toBe("UNKNOWN")
      expect(unknown.runPhase).toBe("RECONCILING")

      // A settlement phase that disagrees with the reported outcome is not settled.
      kernel.managedResponses.settle = {
        status: "SETTLED",
        outcome: "SUCCEEDED",
        ...base,
        attemptPhase: "FAILED",
        runPhase: "RUNNING",
        receiptDigest: RECEIPT,
        revision: 9n,
      }
      const mismatch = yield* Effect.flip(
        ManagedControl.settleAttempt({ ...base, outcome: "succeeded", expectedRevision: 9 }),
      )
      expect(mismatch).toBeInstanceOf(ManagedControlError)
      expect(mismatch.code).toBe("managed_protocol")
    }),
  )

  it.instance("pause, resume and cancel stay on the exact durable Run phase", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const input = { trustedPrincipal: REVIEWER, goalID: "goal-client", runID: "run-client", expectedRevision: 3 }

      const paused = yield* ManagedControl.pauseRun(input)
      expect(paused).toEqual({
        status: "PAUSED",
        goalID: "goal-client",
        runID: "run-client",
        runPhase: "PAUSED",
        revision: "8",
      })
      expect(kernel.calls[0]!.deliveryID).toBe("run-client.pause.3")
      expect(kernel.calls[0]!.body).toEqual({ goalID: "goal-client", runID: "run-client", expectedRevision: 3n })

      const resumed = yield* ManagedControl.resumeRun({ ...input, expectedRevision: 8n })
      expect(resumed.status).toBe("RUNNING")
      expect(resumed.runPhase).toBe("RUNNING")
      expect(kernel.calls[1]!.deliveryID).toBe("run-client.resume.8")

      const cancelling = yield* ManagedControl.cancelRun(input)
      expect(cancelling).toEqual({
        status: "CANCELLING",
        goalID: "goal-client",
        runID: "run-client",
        runPhase: "CANCELLING",
        revision: "10",
      })
      expect(kernel.calls[2]!.deliveryID).toBe("run-client.cancel.3")

      // Repeating a cancel after every Attempt stopped completes the same command.
      kernel.managedResponses.cancel = {
        status: "CANCELLED",
        goalID: "goal-client",
        runID: "run-client",
        runPhase: "CANCELLED",
        revision: 11n,
      }
      const cancelled = yield* ManagedControl.cancelRun({ ...input, expectedRevision: 10 })
      expect(cancelled.status).toBe("CANCELLED")
      expect(cancelled.runPhase).toBe("CANCELLED")

      // A pause response that reports a live Run is a protocol violation, not a pause.
      kernel.managedResponses.pause_run = {
        status: "PAUSED",
        goalID: "goal-client",
        runID: "run-client",
        runPhase: "RUNNING",
        revision: 12n,
      }
      const error = yield* Effect.flip(ManagedControl.pauseRun({ ...input, expectedRevision: 11 }))
      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
    }),
  )

  it.instance("finalize_run rejects a nonterminal Run phase even with a SUCCEEDED status", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses.finalize_run = {
        status: "SUCCEEDED",
        goalID: "goal-client",
        runID: "run-client",
        runPhase: "RUNNING",
        revision: 14n,
      }

      const error = yield* Effect.flip(ManagedControl.finalizeRun({
        trustedPrincipal: REVIEWER,
        goalID: "goal-client",
        runID: "run-client",
      }))

      expect(error).toBeInstanceOf(ManagedControlError)
      expect(error.code).toBe("managed_protocol")
      expect(error.reason).toContain("Run phase")
    }),
  )

  it.instance("bounds one-use delivery keys by UTF-8 bytes and rejects non-ASCII managed IDs", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const goalID = "g".repeat(256)
      const runID = "r".repeat(256)

      yield* ManagedControl.pauseRun({ trustedPrincipal: REVIEWER, goalID, runID, expectedRevision: 3 })

      const deliveryID = kernel.calls[0]!.deliveryID!
      expect(deliveryID).toMatch(/^key\.[a-f0-9]{64}$/)
      expect(Buffer.byteLength(deliveryID, "utf8")).toBeLessThanOrEqual(256)

      const invalid = yield* Effect.flip(
        ManagedControl.pauseRun({ trustedPrincipal: REVIEWER, goalID, runID: `${"r".repeat(255)}💥`, expectedRevision: 3 }),
      )
      expect(invalid).toBeInstanceOf(ManagedControlError)
      expect(invalid.code).toBe("managed_protocol")
      expect(kernel.calls).toHaveLength(1)
    }),
  )

  it.instance("a new verifier retry uses a new stable begin delivery key", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.failingOperation = {
        operation: "begin_verification",
        code: "capability_unavailable",
        reason: "no trusted independent verifier adapter is configured",
      }
      const input = {
        goalID: "goal-client",
        runID: "run-client",
      }

      yield* Effect.flip(ManagedControl.runVerification(input))
      yield* Effect.flip(ManagedControl.runVerification(input))

      const beginCalls = kernel.calls.filter((call) => call.operation === "begin_verification")
      expect(beginCalls).toHaveLength(2)
      expect(beginCalls[0]!.deliveryID).toBeDefined()
      expect(beginCalls[1]!.deliveryID).toBeDefined()
      expect(beginCalls[0]!.deliveryID).not.toBe(beginCalls[1]!.deliveryID)
    }),
  )

  it.instance("verifier operations stay fail-closed with the kernel's own refusal codes", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()

      kernel.failingOperation = {
        operation: "begin_verification",
        code: "capability_unavailable",
        reason: "no trusted independent verifier adapter is configured",
      }
      const begun = yield* Effect.flip(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }),
      )
      expect(begun).toBeInstanceOf(ManagedControlError)
      expect("code" in begun ? begun.code : undefined).toBe("capability_unavailable")
      expect(kernel.calls.at(-1)!.deliveryID).toMatch(/^run-client\.verify\.[0-9a-f-]{36}$/)
      expect(kernel.calls.at(-1)!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls.at(-1)!.body).toEqual({
        goalID: "goal-client",
        runID: "run-client",
      })

      kernel.failingOperation = {
        operation: "verify_task",
        code: "independent_verifier_required",
        reason: "the local OS principal is not an independent verifier",
      }
      const verified = yield* Effect.flip(
        ManagedControl.verifyTask({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          runID: "run-client",
          taskID: "task-client",
          attemptID: "att-managed",
        }),
      )
      expect(verified.code).toBe("independent_verifier_required")
      expect(kernel.calls.at(-1)!.deliveryID).toBe("att-managed.verify_task")
      expect(kernel.calls.at(-1)!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls.at(-1)!.body).not.toHaveProperty("principal")

      kernel.failingOperation = {
        operation: "record_criterion_evidence",
        code: "capability_unavailable",
        reason: "no trusted independent verifier adapter is configured",
      }
      const evidence = yield* Effect.flip(
        ManagedControl.recordCriterionEvidence({
          trustedPrincipal: REVIEWER,
          goalID: "goal-client",
          runID: "run-client",
          criterionID: "tests-pass",
        }),
      )
      expect(evidence.code).toBe("capability_unavailable")
      expect(kernel.calls.at(-1)!.deliveryID).toBe("run-client.evidence.tests-pass")
      expect(kernel.calls.at(-1)!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls.at(-1)!.body).not.toHaveProperty("principal")

      kernel.failingOperation = {
        operation: "finalize_run",
        code: "capability_unavailable",
        reason: "no trusted independent verifier adapter is configured",
      }
      const finalized = yield* Effect.flip(
        ManagedControl.finalizeRun({ trustedPrincipal: REVIEWER, goalID: "goal-client", runID: "run-client" }),
      )
      expect(finalized.code).toBe("capability_unavailable")
      expect(kernel.calls.at(-1)!.deliveryID).toBe("run-client.finalize")
      expect(kernel.calls.at(-1)!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls.at(-1)!.body).not.toHaveProperty("principal")
    }),
  )

  it.instance("managed verification keeps host challenge details inside the approval bridge", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })
      expect(result.status).toBe("SUCCEEDED")
      expect(result).not.toHaveProperty("challenges")
      // finalRevision is part of the public VerificationRunResult contract;
      // only bridge-internal challenge detail must stay hidden.
      // challengeSetDigest is a public result pin; only bridge-internal
      // challenge detail must stay hidden.
      expect(result).not.toHaveProperty("leases")
      expect(result).not.toHaveProperty("artifacts")
      expect(kernel.calls[0]!.body).toEqual({ goalID: "goal-client", runID: "run-client" })
      expect(kernel.calls[0]!.trustedPrincipal).toEqual(REVIEWER)
    }),
  )

  it.instance("a token-exhaustion usage receipt returns an exhausted authenticated scope and never authorizes another step", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const workspaceRevision = `blake3:${"d".repeat(64)}`
      const scope = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "attempt-client",
        ownerEpoch: "7",
        expectedManagedRevision: "5",
        requestSequence: "1",
        requestID: "req_managed_attempt-client_1",
        contextSelectionDigest: `blake3:${"c".repeat(64)}`,
        locationID: "location-1",
        sessionID: "ses_child",
        workspaceRevision,
        effectiveMaxTokens: "5000",
        remainingTokens: "12",
        delegationBindingDigest: RECEIPT,
        permissionScopeDigest: `blake3:${"d".repeat(64)}`,
        worktreeTarget: {
          worktreeID: "worktree-1",
          worktreeBaseRevision: "base-1",
          worktreePoolRevision: "3",
          locationID: "location-1",
          workspaceID: "workspace-1",
          workspaceRef: "refs/heads/managed",
          canonicalRoot: "/workspace/managed",
          workspaceRevision,
        },
      }
      const exhaustedScope = { ...scope, expectedManagedRevision: "6", remainingTokens: "0" }
      kernel.managedResponses.record_usage = {
        status: "STOPPED",
        goalID: scope.goalID,
        attemptID: scope.attemptID,
        operationKey: `managed_usage_${"a".repeat(64)}`,
        usageDigest: RECEIPT,
        managedRevision: 6,
        accountingCursor: 6,
        tokenTotal: 5000,
        costMicrosTotal: 0,
        providerID: "test",
        modelID: "test-model",
        operationID: null,
        requestID: null,
        costStatus: "provider-reported",
        metricStatuses: {
          input: "provider-reported",
          output: "provider-reported",
          reasoning: "provider-reported",
          "cache.read": "provider-reported",
          "cache.write": "provider-reported",
        },
        usageState: "KNOWN",
        stopReason: "TOKEN_CEILING",
        ceilingDigest: RECEIPT,
        receiptDigest: RECEIPT,
        managedAttempt: exhaustedScope,
      }
      const result = yield* ManagedControl.recordAttemptUsage({
        scope,
        assistantMessageID: "message-assistant",
        stepFinishIndex: 0,
        usageProvenance: {
          providerID: "test",
          modelID: "test-model",
          cost: { status: "provider-reported", value: 0 },
          tokens: {
            input: { status: "provider-reported", value: 12 },
            output: { status: "provider-reported", value: 0 },
            reasoning: { status: "provider-reported", value: 0 },
            cache: {
              read: { status: "provider-reported", value: 0 },
              write: { status: "provider-reported", value: 0 },
            },
          },
        },
      })
      expect(result.status).toBe("STOPPED")
      expect(result.managedAttempt.remainingTokens).toBe("0")
      expect(kernel.calls[0]!.body.managedAttempt).toEqual(scope)
    }),
  )

  it.instance("settlement recovery finalizes a verified Run before releasing its P8 reservation", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const terminalSnapshot = {
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "attempt-client",
        taskRevision: "20",
        attemptRevision: "19",
        managedRevision: "20",
        admissionWorkspaceRevision: RECEIPT,
        observedWorkspaceHead: RECEIPT,
        finalRevision: RECEIPT,
        evidenceRefs: [{ artifactId: "artifact-verifier", digest: RECEIPT, byteLength: "12", mediaType: "text/plain", classification: "workspace" }],
        specID: "spec-client",
        specDigest: RECEIPT,
        runPhase: "Verifying",
        taskState: "Verified",
        attemptState: "Succeeded",
        childPromptState: "Quiesced",
        childPromptQuiescenceDigest: RECEIPT,
        bindingDigest: RECEIPT,
        ownerLogID: "owner-log-client",
        ownerLogSequence: "42",
        ownerLogEventDigest: RECEIPT,
        attemptStateDigest: RECEIPT,
        effectChainState: "AllSettled",
        effectChainDigest: RECEIPT,
        evidenceDigest: RECEIPT,
        usageAccounting: {
          accountingCursor: "18",
          tokenKnownSubtotal: "120",
          costKnownSubtotalMicros: "45",
          tokenRemainderStatus: "UNKNOWN",
          costRemainderStatus: "KNOWN",
          usageState: "UNKNOWN",
          stopReason: "USAGE_UNCERTAIN",
          ceilingDigest: RECEIPT,
          costStatus: "provider-reported",
          metricStatuses: {
            input: "provider-reported",
            output: "unknown",
            reasoning: "unknown",
            "cache.read": "unknown",
            "cache.write": "unknown",
          },
          receiptCount: "2",
          receiptChainDigest: RECEIPT,
        },
      }
      kernel.managedResponses.settlement_recovery = {
        status: "SETTLEMENT_PENDING",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: "attempt-client",
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        finalRevision: RECEIPT,
        evidencePlanDigest: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        setIdentityDigest: RECEIPT,
        challengeSetDigest: RECEIPT,
        terminalSnapshot,
      }
      kernel.managedResponses.settle_dispatch = {
        status: "SETTLED",
        goalID: "goal-client",
        runID: "run-client",
        verificationRunID: VERIFICATION_RUN_ID,
        setIdentityDigest: RECEIPT,
        challengeSetDigest: RECEIPT,
        taskID: "task-client",
        attemptID: "attempt-client",
        workerExecutionID: "worker-client",
        disposition: "RELEASED",
        proofDigest: RECEIPT,
        ownerLogID: "pool-log-client",
        ownerLogSequence: "8",
        ownerLogEventDigest: RECEIPT,
        workerPoolRevision: "9",
        receiptDigest: RECEIPT,
        worktreeDisposition: {
          ownerEpoch: "7",
          disposition: "REUSABLE",
          settlementReceiptDigest: RECEIPT,
          finalWorktreeOperationID: "worktree-inspect-op",
          finalWorktreeHostReceiptRef: RECEIPT,
          observedWorkspaceRevision: RECEIPT,
          inspectReceiptDigest: RECEIPT,
          ownerLogID: "worktree-log-client",
          ownerLogSequence: "27",
          ownerLogEventDigest: RECEIPT,
          workerPoolRevision: "10",
          receiptDigest: `blake3:${"a".repeat(64)}`,
        },
      }

      const result = yield* ManagedControl.runVerification({ goalID: "goal-client", runID: "run-client" })

      expect(result.status).toBe("SUCCEEDED")
      // Narrow past the ABORTED variant before reading execution-only receipts.
      const executed = result as Exclude<VerificationRunResult, { readonly status: "ABORTED" }>
      expect(executed.usageAccounting).toMatchObject({
        accountingCursor: "18",
        tokenKnownSubtotal: "120",
        tokenRemainderStatus: "UNKNOWN",
        usageState: "UNKNOWN",
        costKnownSubtotalMicros: "45",
      })
      const settlement = executed.dispatchSettlement
      expect(settlement && "worktreeDisposition" in settlement ? settlement.worktreeDisposition : undefined).toMatchObject({
        disposition: "REUSABLE",
        observedWorkspaceRevision: terminalSnapshot.finalRevision,
        ownerLogSequence: "27",
      })
      expect(kernel.calls.map((call) => call.operation)).toEqual([
        "settlement_recovery",
        "snapshot",
        "finalize_run",
        "settle_dispatch",
      ])
      expect(kernel.calls[2]!.trustedPrincipal).toEqual(REVIEWER)
      expect(kernel.calls[3]!.deliveryID).toBe("managed_settle_attempt-client")
    }),
  )

  it.instance("managed verification rejects a local OS identity before contacting HostKernel", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const error = yield* Effect.flip(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }).pipe(
          Effect.provideService(TrustedPrincipalContext, TrustedPrincipalContext.of({ principal: { kind: "host_os" } })),
        ),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("independent_verifier_required")
      expect(kernel.calls).toHaveLength(0)
    }),
  )

  it.instance("managed verification refuses a HostKernel challenge set above the accepted 32 criteria", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses.begin_verification = {
        status: "NEEDS_APPROVAL",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: ATTEMPT_ID,
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        evidencePlanDigest: RECEIPT,
        setIdentityDigest: RECEIPT,
        finalRevision: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        approvalLocation: {
          locationID: LOCATION_ID,
          workspaceID: "wrk_client_workspace",
          canonicalRoot: "/workspace/client",
          workspaceRevision: RECEIPT,
        },
        evidenceDigest: null,
        artifactRefs: [],
        challenges: Array.from({ length: 33 }, (_, index) => ({
          ...verifierGuardProjection(),
          criterionID: `criterion-${index}`,
          challengeID: `challenge-${index}`,
          effectID: `effect-${index}`,
          capabilityID: "builtin.verifier",
          locationID: LOCATION_ID,
          inputDigest: RECEIPT,
          normalizedTargets: [{ criterionID: `criterion-${index}` }],
          expiresAtUnixMs: Date.now() + 60_000,
          policySummary: "Run the approved verifier profile for this criterion.",
        })),
        revision: 11n,
      }
      const error = yield* Effect.flip(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }),
      )
      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
      expect(kernel.calls.map((call) => call.operation)).toEqual([
        "settlement_recovery",
        "begin_verification",
      ])
      expect(kernel.approvalWindows).toHaveLength(0)
      expect(kernel.calls.some((call) => call.operation === "resolve_verification_approvals")).toBe(false)
    }),
  )

  it.instance("managed verification rejects an incomplete authenticated Guard projection before prompting", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const { policyDigest: _policyDigest, ...incompleteProjection } = verifierGuardProjection()
      kernel.managedResponses.begin_verification = {
        status: "NEEDS_APPROVAL",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: ATTEMPT_ID,
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        evidencePlanDigest: RECEIPT,
        setIdentityDigest: RECEIPT,
        finalRevision: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        approvalLocation: {
          locationID: LOCATION_ID,
          workspaceID: "wrk_client_workspace",
          canonicalRoot: "/workspace/client",
          workspaceRevision: RECEIPT,
        },
        evidenceDigest: null,
        artifactRefs: [],
        challenges: [
          {
            ...incompleteProjection,
            criterionID: "tests-pass",
            challengeID: "challenge-verifier-1",
            effectID: "effect-verifier-1",
            capabilityID: "builtin.verifier",
            locationID: LOCATION_ID,
            inputDigest: RECEIPT,
            normalizedTargets: [{ criterionID: "tests-pass" }],
            expiresAtUnixMs: Date.now() + 60_000,
            policySummary: "Run the approved verifier profile for this criterion.",
          },
        ],
        revision: 11n,
      }

      const error = yield* Effect.flip(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
      expect(kernel.approvalWindows).toHaveLength(0)
      expect(kernel.calls.map((call) => call.operation)).toEqual([
        "settlement_recovery",
        "begin_verification",
      ])
    }),
  )

  it.instance("managed verification resolves the complete approval set before execution", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const challenges = Array.from({ length: 32 }, (_, index) => ({
        ...verifierGuardProjection(),
        criterionID: `criterion-${index + 1}`,
        challengeID: `challenge-${index + 1}`,
        effectID: `effect-${index + 1}`,
        capabilityID: "builtin.verifier",
        locationID: LOCATION_ID,
        inputDigest: RECEIPT,
        normalizedTargets: [{ criterionID: `criterion-${index + 1}` }],
        expiresAtUnixMs: Date.now() + 60_000,
        policySummary: "Run the approved verifier profile for this criterion.",
      }))
      kernel.managedResponses.begin_verification = {
        status: "NEEDS_APPROVAL",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: ATTEMPT_ID,
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        evidencePlanDigest: RECEIPT,
        setIdentityDigest: RECEIPT,
        finalRevision: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        approvalLocation: {
          locationID: LOCATION_ID,
          workspaceID: "wrk_client_workspace",
          canonicalRoot: "/workspace/client",
          workspaceRevision: RECEIPT,
        },
        evidenceDigest: null,
        artifactRefs: [],
        challenges,
        revision: 11n,
      }

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
        sessionID: "ses-managed",
      })

      expect(kernel.approvalWindows.map((window) => window.length)).toEqual([32])
      const calls = kernel.calls.map((call) => call.operation)
      expect(calls).toEqual([
        "settlement_recovery",
        "begin_verification",
        "snapshot",
        "resolve_verification_approvals",
        "execute_verification",
        "prepare_final_inspect",
        "execute_final_inspect",
        "settle",
        "finalize_run",
        "settle_dispatch",
      ])
      const resolve = kernel.calls[3]!
      expect(resolve.body).toMatchObject({
        goalID: "goal-client",
        runID: "run-client",
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        resolution: {
          kind: "decisions",
          decisions: challenges.map((challenge) => ({ challengeID: challenge.challengeID, decision: "allow_once" })),
        },
      })
      expect(resolve.trustedPrincipal).toEqual(REVIEWER)
      const execute = kernel.calls[4]!
      expect(execute.body).toEqual({
        goalID: "goal-client",
        runID: "run-client",
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
      })
      expect(execute.body).not.toHaveProperty("principal")
      expect(execute.body).not.toHaveProperty("criterionID")
      expect(execute.body).not.toHaveProperty("capabilityLeaseDigest")
      expect(result.status).toBe("SUCCEEDED")
      expect(result).not.toHaveProperty("leases")
      expect(result).not.toHaveProperty("artifacts")
    }),
  )

  it.instance("managed verification never executes an incomplete or duplicated lease set", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.managedResponses.resolve_verification_approvals = {
        status: "APPROVED",
        goalID: "goal-client",
        runID: "run-client",
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        leases: [
          {
            criterionID: "tests-pass",
            challengeID: "challenge-verifier-1",
            effectID: "effect-verifier-1",
            capabilityLeaseDigest: RECEIPT,
          },
          {
            criterionID: "tests-pass",
            challengeID: "challenge-verifier-1",
            effectID: "effect-verifier-1",
            capabilityLeaseDigest: RECEIPT,
          },
        ],
        revision: 12n,
      }

      const error = yield* Effect.flip(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }),
      )

      expect(error).toBeInstanceOf(ManagedControlError)
      expect("code" in error ? error.code : undefined).toBe("managed_protocol")
      expect(kernel.calls.map((call) => call.operation)).toEqual([
        "settlement_recovery",
        "begin_verification",
        "snapshot",
        "resolve_verification_approvals",
      ])
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
    }),
  )

  it.instance("a real denial aborts the full challenge set without synthetic decisions or execution", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const challenges = ["one", "two", "three"].map((id) => ({
        ...verifierGuardProjection(),
        criterionID: `criterion-${id}`,
        challengeID: `challenge-${id}`,
        effectID: `effect-${id}`,
        capabilityID: "builtin.verifier",
        locationID: LOCATION_ID,
        inputDigest: RECEIPT,
        normalizedTargets: [{ criterionID: `criterion-${id}` }],
        expiresAtUnixMs: Date.now() + 60_000,
        policySummary: "Run the approved verifier profile for this criterion.",
      }))
      kernel.managedResponses.begin_verification = {
        status: "NEEDS_APPROVAL",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: ATTEMPT_ID,
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        evidencePlanDigest: RECEIPT,
        setIdentityDigest: RECEIPT,
        finalRevision: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        approvalLocation: {
          locationID: LOCATION_ID,
          workspaceID: "wrk_client_workspace",
          canonicalRoot: "/workspace/client",
          workspaceRevision: RECEIPT,
        },
        evidenceDigest: null,
        artifactRefs: [],
        challenges,
        revision: 11n,
      }
      kernel.approvalDecisions = [
        { challengeID: "challenge-one", decision: "allow_once" },
        { challengeID: "challenge-two", decision: "deny" },
      ]

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })

      expect(kernel.approvalWindows.map((window) => window.length)).toEqual([3])
      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: {
          kind: "abort",
          reason: "reviewer_denied",
          decisions: [
            { challengeID: "challenge-one", decision: "allow_once" },
            { challengeID: "challenge-two", decision: "deny" },
          ],
        },
      })
      expect((resolve.body.resolution as { decisions: unknown[] }).decisions).toHaveLength(2)
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
      expect(result.status).toBe("ABORTED")
    }),
  )

  it.instance("a genuine denial closes the complete set without resolving unseen prompts", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      const challenges = Array.from({ length: 17 }, (_, index) => ({
        ...verifierGuardProjection(),
        criterionID: `criterion-${index + 1}`,
        challengeID: `challenge-${index + 1}`,
        effectID: `effect-${index + 1}`,
        capabilityID: "builtin.verifier",
        locationID: LOCATION_ID,
        inputDigest: RECEIPT,
        normalizedTargets: [{ criterionID: `criterion-${index + 1}` }],
        expiresAtUnixMs: Date.now() + 60_000,
        policySummary: "Run the approved verifier profile for this criterion.",
      }))
      kernel.managedResponses.begin_verification = {
        status: "NEEDS_APPROVAL",
        schemaVersion: 1,
        goalID: "goal-client",
        runID: "run-client",
        taskID: "task-client",
        attemptID: ATTEMPT_ID,
        ownerEpoch: "7",
        specID: "spec-client",
        specDigest: RECEIPT,
        profileID: DIRECT_PROFILE.profileId,
        profileRevision: "1",
        profileDigest: DIRECT_PROFILE_DIGEST,
        evidencePlanDigest: RECEIPT,
        setIdentityDigest: RECEIPT,
        finalRevision: RECEIPT,
        verificationRunID: VERIFICATION_RUN_ID,
        challengeSetDigest: RECEIPT,
        approvalLocation: {
          locationID: LOCATION_ID,
          workspaceID: "wrk_client_workspace",
          canonicalRoot: "/workspace/client",
          workspaceRevision: RECEIPT,
        },
        evidenceDigest: null,
        artifactRefs: [],
        challenges,
        revision: 11n,
      }
      kernel.approvalDecisions = [{ challengeID: "challenge-1", decision: "deny" }]

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })

      expect(kernel.approvalWindows.map((window) => window.length)).toEqual([17])
      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: {
          kind: "abort",
          reason: "reviewer_denied",
          decisions: [{ challengeID: "challenge-1", decision: "deny" }],
        },
      })
      expect((resolve.body.resolution as { decisions: unknown[] }).decisions).toHaveLength(1)
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
      expect(result).toMatchObject({ status: "ABORTED", reason: "reviewer_denied" })
    }),
  )

  it.instance("malformed supervisor decisions abort without attributing an unknown reviewer choice", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.approvalResult = {
        kind: "abort",
        reason: "transport_lost",
        decisions: [{ challengeID: "forged-challenge", decision: "deny" }],
      }

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })

      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: { kind: "abort", reason: "transport_lost", decisions: [] },
      })
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
      expect(result).toMatchObject({ status: "ABORTED", reason: "transport_lost" })
    }),
  )

  it.instance("interruption retires pending approvals and fences the HostKernel challenge set", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.interruptApprovals = true

      const exit = yield* Effect.exit(
        ManagedControl.runVerification({
          goalID: "goal-client",
          runID: "run-client",
        }),
      )

      expect(exit._tag).toBe("Failure")
      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: { kind: "abort", reason: "cancelled", decisions: [] },
      })
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
    }),
  )

  it.instance("partial approval abort preserves only genuine choices from the completed prompt", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.approvalResult = {
        kind: "abort",
        reason: "transport_lost",
        decisions: [{ challengeID: "challenge-verifier-1", decision: "allow_once" }],
      }

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })

      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: {
          kind: "abort",
          reason: "transport_lost",
          decisions: [{ challengeID: "challenge-verifier-1", decision: "allow_once" }],
        },
      })
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
      expect(result).toMatchObject({ status: "ABORTED", reason: "transport_lost" })
    }),
  )

  it.instance("a reviewer_denied tag without an observed denial is recorded as transport loss", () =>
    Effect.gen(function* () {
      const kernel = freshKernel()
      kernel.approvalResult = {
        kind: "abort",
        reason: "reviewer_denied",
        decisions: [{ challengeID: "challenge-verifier-1", decision: "allow_once" }],
      }

      const result = yield* ManagedControl.runVerification({
        goalID: "goal-client",
        runID: "run-client",
      })

      const resolve = kernel.calls.find((call) => call.operation === "resolve_verification_approvals")!
      expect(resolve.body).toMatchObject({
        resolution: {
          kind: "abort",
          reason: "transport_lost",
          decisions: [{ challengeID: "challenge-verifier-1", decision: "allow_once" }],
        },
      })
      expect(kernel.calls.some((call) => call.operation === "execute_verification")).toBe(false)
      expect(result).toMatchObject({ status: "ABORTED", reason: "transport_lost" })
    }),
  )
})
