import { expect, test } from "bun:test"
import { Effect } from "effect"
import { relayMultiCallToolBatch, SessionSupervisorError, type ToolBatchRelayPort } from "@opencode-ai/core/session/supervisor"
import {
  CP01_BATCH_ID,
  CP01_DELEGATION_ROUTE,
  CP01_EVALUATOR_BINDING,
  CP01_LOCATION_ID,
  CP01_SESSION_ID,
  CP01_SESSION_LINK,
  CP01_SPEC_SOURCE,
  CP01_TURN_CONTEXT_DIGEST,
  CP01_WORKSPACE_REVISION,
  cp01ConsultReceiptProjection,
  cp01ConsultSequenceFixture,
  cp01ConsultUnknownProjection,
  cp01DeniedBatchFixture,
  cp01GuardedCalls,
  cp01NeedsApprovalResponse,
  cp01PreparedBatchFixture,
  cp01ReceiptFixture,
  cp01RelayPort,
  cp01UnknownFixture,
  validateCp01ConsultSequence,
} from "./fixture/cp01-chain"

function relay(response: unknown, port: ToolBatchRelayPort) {
  return Effect.runPromise(
    relayMultiCallToolBatch(
      {
        sessionID: CP01_SESSION_ID,
        batchID: CP01_BATCH_ID,
        locationID: CP01_LOCATION_ID,
        turnContextDigest: CP01_TURN_CONTEXT_DIGEST,
        calls: cp01GuardedCalls(),
        response,
      } as never,
      port,
    ),
  )
}

test("FIXTURES: CP-01 needs-approval response yields one prepared batch with distinct leases", async () => {
  const port = cp01RelayPort()
  const admission = await relay(cp01NeedsApprovalResponse(), port as ToolBatchRelayPort)
  expect(admission.status).toBe("prepared_batch")
  if (admission.status !== "prepared_batch") return
  expect(admission.calls.map((call) => call.callID)).toEqual(["cp01_call_write", "cp01_call_patch"])
  const leaseDigests = admission.calls.map((call) => call.lease?.capabilityLeaseDigest)
  expect(new Set(leaseDigests).size).toBe(2)
  expect(port.recorded.approvals).toHaveLength(2)
  expect(port.recorded.resolves).toHaveLength(1)
  expect(port.recorded.cancels).toHaveLength(0)
})

test("FIXTURES: CP-01 denial cancels the complete batch without leases", async () => {
  const port = cp01RelayPort({ decisions: ["allow_once", "deny"] })
  const admission = await relay(cp01NeedsApprovalResponse(), port as ToolBatchRelayPort)
  expect(admission).toEqual(cp01DeniedBatchFixture("Guard approval was denied"))
  expect(port.recorded.resolves).toHaveLength(0)
  expect(port.recorded.cancels).toEqual([{ sessionID: CP01_SESSION_ID, batchID: CP01_BATCH_ID }])
})

test("FIXTURES: CP-01 approval expiry and approval-set failure both cancel", async () => {
  const expired = cp01RelayPort({
    approvalError: new SessionSupervisorError({ stage: "approval-conflict", reason: "Guard approval expired" }),
  })
  await expect(relay(cp01NeedsApprovalResponse(), expired as ToolBatchRelayPort)).rejects.toThrow()
  expect(expired.recorded.resolves).toHaveLength(0)
  expect(expired.recorded.cancels).toHaveLength(1)

  const resolveFailed = cp01RelayPort({
    resolveError: new SessionSupervisorError({ stage: "host-kernel", reason: "approval set rejected" }),
  })
  await expect(relay(cp01NeedsApprovalResponse(), resolveFailed as ToolBatchRelayPort)).rejects.toThrow()
  expect(resolveFailed.recorded.resolves).toHaveLength(1)
  expect(resolveFailed.recorded.cancels).toHaveLength(1)
})

test("FIXTURES: CP-01 prepared, receipt, and UNKNOWN projection shapes are distinguishable", () => {
  const prepared = cp01PreparedBatchFixture()
  expect(prepared.status).toBe("prepared_batch")
  expect(prepared.calls.every((call) => call.lease.effectID.length > 0)).toBe(true)

  const receipt = cp01ReceiptFixture()
  expect(receipt.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  expect(Object.hasOwn(receipt, "status")).toBe(false)

  const unknown = cp01UnknownFixture()
  expect(unknown.status).toBe("UNKNOWN")
  expect(unknown.receiptRef).toBeNull()
  expect(unknown.receiptDigest).toBeNull()
  expect(unknown.replay).toBe("forbidden")
})

test("FIXTURES: P2 consult chain preserves pinned SHA-256 authority and exact order", () => {
  const steps = cp01ConsultSequenceFixture()
  expect(validateCp01ConsultSequence(steps)).toEqual({ ok: true })
  expect(steps.map((entry) => entry.step)).toEqual([
    "spec",
    "plan_run",
    "start_planned_run",
    "admit_attempt",
    "start_attempt",
    "workspace_revision",
    "delegation_route",
    "evaluator_binding",
    "wave",
    "receipt",
  ])

  const spec = steps.find((entry) => entry.step === "spec")!.value as { sourceDigests: { sessionLink: string } }
  const planned = steps.find((entry) => entry.step === "start_planned_run")!.value as { rootSessionLink: { eventDigest: string } }
  const start = steps.find((entry) => entry.step === "start_attempt")!.value as { workspaceRevision: string; providerRouteDigest: string }
  const binding = steps.find((entry) => entry.step === "evaluator_binding")!.value as { bindingDigest: string }
  expect(spec.sourceDigests.sessionLink).toBe(CP01_SPEC_SOURCE)
  expect(planned.rootSessionLink.eventDigest).toBe(CP01_SESSION_LINK)
  expect(start.workspaceRevision).toBe(CP01_WORKSPACE_REVISION)
  expect(start.providerRouteDigest).toBe(CP01_DELEGATION_ROUTE)
  expect(binding.bindingDigest).toBe(CP01_EVALUATOR_BINDING)
})

test("FIXTURES: P2 consult chain rejects out-of-order and missing durable steps", () => {
  const valid = cp01ConsultSequenceFixture()
  const outOfOrder = [...valid]
  ;[outOfOrder[1], outOfOrder[2]] = [outOfOrder[2]!, outOfOrder[1]!]
  expect(validateCp01ConsultSequence(outOfOrder)).toMatchObject({ ok: false })
  expect(validateCp01ConsultSequence(valid.slice(0, -1))).toMatchObject({ ok: false })
  expect(validateCp01ConsultSequence([...valid, valid[0]!])).toMatchObject({ ok: false })
})

test("FIXTURES: P2 consult receipt and UNKNOWN projections are distinguishable", () => {
  const receipt = cp01ConsultReceiptProjection()
  expect(receipt.status).toBe("RECOVERED")
  expect(receipt.bindingDigest).toBe(CP01_EVALUATOR_BINDING)
  expect(receipt.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  expect(receipt.waveIndex).toBe(0)

  const unknown = cp01ConsultUnknownProjection()
  expect(unknown).toEqual({
    status: "UNKNOWN",
    bindingDigest: null,
    receiptDigest: null,
    waveIndex: null,
  })
})
