/**
 * CP-01 integrated-chain fixtures for P2/P7 consumers.
 *
 * FIXTURE ONLY — not acceptance. These builders model the strict Core-side
 * ToolBatch → Guard approval → one-use lease shapes that the integrated
 * HostKernel/EffectHost path will consume. They never mint production authority.
 */
import { Effect } from "effect"
import type { SessionSupervisorError } from "@horizoncode/core/session/supervisor"

export const CP01_FIXTURE_ONLY = true as const
export const CP01_SESSION_ID = "ses_cp01_fixture"
export const CP01_LOCATION_ID = `loc_${"a".repeat(64)}`
export const CP01_BATCH_ID = "batch_cp01_fixture"
export const CP01_TURN_CONTEXT_DIGEST = `sha256:${"c".repeat(64)}`
const BLAKE3_A = `blake3:${"a".repeat(64)}`
const BLAKE3_B = `blake3:${"b".repeat(64)}`
const GUARANTEES = ["beneath_workspace_root", "no_symlink", "no_hardlink", "one_use"] as const

export type Cp01GuardedCallFixture = {
  readonly callID: string
  readonly capabilityID: "files.write" | "files.patch"
  readonly arguments: Readonly<Record<string, unknown>>
}

export function cp01GuardedCalls(): ReadonlyArray<Cp01GuardedCallFixture> {
  return [
    {
      callID: "cp01_call_write",
      capabilityID: "files.write",
      arguments: { path: "a.txt", content: "fixture" },
    },
    {
      callID: "cp01_call_patch",
      capabilityID: "files.patch",
      arguments: {
        operations: [
          {
            operation: "write",
            path: "b.txt",
            expectedBeforeBase64: null,
            contentBase64: Buffer.from("fixture").toString("base64"),
            executable: false,
          },
        ],
      },
    },
  ]
}

function fixtureTarget(capabilityID: Cp01GuardedCallFixture["capabilityID"]) {
  const target = { target: "/workspace/a.txt", resource: "a.txt", operation: "write", existed: false }
  return capabilityID === "files.patch" ? [{ ...target, executable: false }] : [target]
}

export function cp01NeedsApprovalResponse(
  overrides: {
    readonly expiresAtUnixMs?: number
    readonly mutate?: (entries: Array<Record<string, unknown>>) => void
  } = {},
): Readonly<Record<string, unknown>> {
  const entries = cp01GuardedCalls().map((call) => ({
    callId: call.callID,
    capabilityId: call.capabilityID,
    challengeId: `ch_${call.callID}`,
    effectId: `eff_${call.callID}`,
    locationID: CP01_LOCATION_ID,
    inputDigest: BLAKE3_A,
    normalizedTargets: fixtureTarget(call.capabilityID),
    targets: fixtureTarget(call.capabilityID),
    expiresAtUnixMs: overrides.expiresAtUnixMs ?? Date.now() + 60_000,
    policySummary: "CP-01 fixture workspace write",
    origin: "session_batch",
    source: "core.tool_batch",
    policyID: "workspace-write.local.v1",
    policyDigest: BLAKE3_B,
    normalizedAction: call.capabilityID,
    argumentSummary: { status: "available", text: `fixture ${call.callID}` },
    requestedGuarantees: GUARANTEES,
    guaranteeAssessment: { status: "assessed", residual: [] },
    noResponse: "deny_and_expire",
    allowEnabled: true,
  }))
  overrides.mutate?.(entries)
  return { status: "needs_approval", batchId: CP01_BATCH_ID, calls: entries }
}

export function cp01DeniedBatchFixture(reason: string) {
  return { status: "denied" as const, reason }
}

export function cp01PreparedBatchFixture(
  leaseDigest = BLAKE3_A,
): {
  readonly status: "prepared_batch"
  readonly calls: ReadonlyArray<{
    readonly callID: string
    readonly capabilityID: "files.write" | "files.patch"
    readonly lease: { readonly effectID: string; readonly capabilityLeaseDigest: string }
  }>
} {
  return {
    status: "prepared_batch",
    calls: cp01GuardedCalls().map((call) => ({
      callID: call.callID,
      capabilityID: call.capabilityID,
      lease: {
        effectID: `eff_${call.callID}`,
        capabilityLeaseDigest: leaseDigest,
      },
    })),
  }
}

export function cp01ReceiptFixture() {
  return {
    effectID: "eff_cp01_call_write",
    receiptDigest: BLAKE3_A,
    target: "/workspace/a.txt",
    resource: "a.txt",
    existed: false,
  } as const
}

export function cp01UnknownFixture() {
  return {
    status: "UNKNOWN",
    receiptRef: null,
    receiptDigest: null,
    replay: "forbidden",
  } as const
}

/** FIXTURE ONLY — mirrors P2 continuation 66's durable consult chain for P7/P2 TS consumers. */
export const CP01_SHA256_SPEC_SOURCE = `sha256:${"1".repeat(64)}`
export const CP01_SHA256_SESSION_LINK = `sha256:${"2".repeat(64)}`
export const CP01_SHA256_WORKSPACE_REVISION = `sha256:${"3".repeat(64)}`
export const CP01_SHA256_DELEGATION_ROUTE = `sha256:${"4".repeat(64)}`
export const CP01_SHA256_EVALUATOR_BINDING = `sha256:${"5".repeat(64)}`
export const CP01_SPEC_SOURCE = CP01_SHA256_SPEC_SOURCE
export const CP01_SESSION_LINK = CP01_SHA256_SESSION_LINK
export const CP01_WORKSPACE_REVISION = CP01_SHA256_WORKSPACE_REVISION
export const CP01_EVALUATOR_BINDING = CP01_SHA256_EVALUATOR_BINDING
export const CP01_DELEGATION_ROUTE = CP01_SHA256_DELEGATION_ROUTE

export type Cp01ConsultStep =
  | "spec"
  | "plan_run"
  | "start_planned_run"
  | "admit_attempt"
  | "start_attempt"
  | "workspace_revision"
  | "delegation_route"
  | "evaluator_binding"
  | "wave"
  | "receipt"

export function cp01SpecVersionFixture() {
  return {
    specVersionID: "spec_cp01_fixture",
    goalID: "goal_cp01_fixture",
    sourceDigests: { sessionLink: CP01_SHA256_SPEC_SOURCE },
    capabilityScope: ["files.read", "files.write"],
  } as const
}

export function cp01PlanRunFixture() {
  return {
    goalID: "goal_cp01_fixture",
    runID: "run_cp01_fixture",
    taskIDs: ["task_cp01_fixture"],
    planDigest: BLAKE3_A,
  } as const
}

export function cp01StartPlannedRunFixture() {
  return {
    runID: "run_cp01_fixture",
    rootSessionLink: {
      sessionID: "ses_cp01_root",
      eventDigest: CP01_SHA256_SESSION_LINK,
    },
    acceptedSpecDigest: BLAKE3_B,
  } as const
}

export function cp01AdmitAttemptFixture() {
  return {
    attemptID: "attempt_cp01_fixture",
    runID: "run_cp01_fixture",
    taskID: "task_cp01_fixture",
    profileID: "profile_cp01_fixture",
    profileRevision: "1",
    profileDigest: BLAKE3_A,
  } as const
}

export function cp01StartAttemptFixture() {
  return {
    attemptID: "attempt_cp01_fixture",
    workspaceRevision: CP01_SHA256_WORKSPACE_REVISION,
    delegationBindingDigest: BLAKE3_B,
    providerRouteDigest: CP01_SHA256_DELEGATION_ROUTE,
  } as const
}

export function cp01WorkspaceRevisionFixture() {
  return {
    attemptID: "attempt_cp01_fixture",
    workspaceRevision: CP01_SHA256_WORKSPACE_REVISION,
  } as const
}

export function cp01DelegationRouteFixture() {
  return {
    attemptID: "attempt_cp01_fixture",
    providerRouteDigest: CP01_SHA256_DELEGATION_ROUTE,
    permissionScopeDigest: BLAKE3_A,
  } as const
}

export function cp01EvaluatorBindingFixture() {
  return {
    constructor: "HostRunDispatchBindingV1::from_authenticated_evaluator",
    bindingDigest: CP01_SHA256_EVALUATOR_BINDING,
    attemptID: "attempt_cp01_fixture",
    evaluatorTaskId: "evaluator_cp01_fixture",
    armId: "arm_cp01_fixture",
    taskGroup: "group_cp01_fixture",
  } as const
}

export function cp01WaveFixture() {
  return {
    batchID: CP01_BATCH_ID,
    waveIndex: 0,
    calls: cp01GuardedCalls().map((call, index) => ({
      callIndex: index,
      callID: call.callID,
      capabilityID: call.capabilityID,
      status: "PREPARED" as const,
    })),
  } as const
}

export function cp01ConsultSequenceFixture(): ReadonlyArray<{ readonly step: Cp01ConsultStep; readonly value: unknown }> {
  return [
    { step: "spec", value: cp01SpecVersionFixture() },
    { step: "plan_run", value: cp01PlanRunFixture() },
    { step: "start_planned_run", value: cp01StartPlannedRunFixture() },
    { step: "admit_attempt", value: cp01AdmitAttemptFixture() },
    { step: "start_attempt", value: cp01StartAttemptFixture() },
    { step: "workspace_revision", value: cp01WorkspaceRevisionFixture() },
    { step: "delegation_route", value: cp01DelegationRouteFixture() },
    { step: "evaluator_binding", value: cp01EvaluatorBindingFixture() },
    { step: "wave", value: cp01WaveFixture() },
    { step: "receipt", value: cp01ReceiptFixture() },
  ]
}

export function validateCp01ConsultSequence(
  steps: ReadonlyArray<{ readonly step: Cp01ConsultStep }>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const expected = cp01ConsultSequenceFixture().map((entry) => entry.step)
  const seen = new Set<Cp01ConsultStep>()
  for (const [index, entry] of steps.entries()) {
    if (entry.step !== expected[index]) {
      return { ok: false, reason: `consult sequence step ${index} must be ${expected[index]}` }
    }
    if (seen.has(entry.step)) return { ok: false, reason: `duplicate consult step ${entry.step}` }
    seen.add(entry.step)
  }
  if (steps.length !== expected.length) {
    return { ok: false, reason: "consult sequence is missing one or more durable steps" }
  }
  return { ok: true }
}

export type Cp01ConsultProjection = {
  readonly status: "RECOVERED" | "UNKNOWN"
  readonly bindingDigest: string | null
  readonly receiptDigest: string | null
  readonly waveIndex: number | null
}

export function cp01ConsultReceiptProjection(): Cp01ConsultProjection {
  return {
    status: "RECOVERED",
    bindingDigest: CP01_SHA256_EVALUATOR_BINDING,
    receiptDigest: BLAKE3_A,
    waveIndex: 0,
  }
}

export function cp01ConsultUnknownProjection(): Cp01ConsultProjection {
  return {
    status: "UNKNOWN",
    bindingDigest: null,
    receiptDigest: null,
    waveIndex: null,
  }
}

export type Cp01RelayRecorded = {
  readonly approvals: Array<unknown>
  readonly resolves: Array<unknown>
  readonly cancels: Array<unknown>
}

export function cp01RelayPort(
  options: {
    readonly decisions?: ReadonlyArray<"allow_once" | "deny">
    readonly approvalError?: SessionSupervisorError
    readonly resolveError?: SessionSupervisorError
    readonly recorded?: Cp01RelayRecorded
  } = {},
) {
  const recorded = options.recorded ?? { approvals: [], resolves: [], cancels: [] }
  let next = 0
  return {
    recorded,
    requestApproval: (request: unknown) => {
      recorded.approvals.push(request)
      if (options.approvalError) return Effect.fail(options.approvalError)
      return Effect.succeed(options.decisions?.[next++] ?? "allow_once" as const)
    },
    resolveApprovalSet: (request: unknown) => {
      recorded.resolves.push(request)
      if (options.resolveError) return Effect.fail(options.resolveError)
      return Effect.succeed({
        leases: cp01GuardedCalls().map((call, index) => ({
          challengeID: `ch_${call.callID}`,
          lease: {
            effectID: `eff_${call.callID}`,
            capabilityLeaseDigest: `blake3:${(index + 1).toString(16).padStart(64, "0")}`,
          },
        })),
      })
    },
    cancelBatch: (request: unknown) => {
      recorded.cancels.push(request)
      return Effect.void
    },
  }
}
