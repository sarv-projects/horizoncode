import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { pack, unpack } from "msgpackr"
import {
  MULTI_CALL_BATCH_FEATURE,
  SessionSupervisorError,
  directAttemptScopeToWire,
  relayMultiCallToolBatch,
  type EffectAdmission,
  type EffectLease,
  type GuardApprovalDecision,
  type GuardApprovalRequest,
  type GuardedToolCall,
  type ToolBatchRelayPort,
} from "@opencode-ai/core/session/supervisor"
import { it } from "./lib/effect"

/**
 * Focused C20 Core tests for the complete multi-call ToolBatch relay.
 *
 * The relay parses the guard owner's per-call `calls[]` challenge response, raises one
 * approval request per member, resolves every approved member to its own one-use lease,
 * and cancels the whole batch when anything denies, expires or fails. It is exercised
 * here through an explicit port so no transport or host kernel is required; the
 * production path stays gated behind a negotiated host feature and is therefore not
 * runnable until the host RPC surface accepts multi-call batches.
 */

const DIGEST = `blake3:${"a".repeat(64)}`
/** One-use leases carry distinct digests; the relay rejects duplicates across members. */
const leaseDigest = (index: number) => `blake3:${(index + 1).toString(16).padStart(64, "0")}`
const TARGETS = [{ target: "/workspace/a.txt", resource: "a.txt", operation: "write", existed: false }]

function call(callID: string, capabilityID: string): GuardedToolCall {
  return { callID, capabilityID, arguments: { path: `${callID}.txt`, content: "x" } }
}

function responseFor(
  calls: ReadonlyArray<GuardedToolCall>,
  overrides: { readonly expiresAtUnixMs?: number; readonly mutate?: (entries: Array<Record<string, unknown>>) => void } = {},
) {
  const entries: Array<Record<string, unknown>> = calls.map((member) => {
    // A `files.patch` member's targets must carry the executable mode, exactly like the
    // proven single-call patch challenge.
    const targets =
      member.capabilityID === "files.patch"
        ? TARGETS.map((target) => ({ ...target, executable: false }))
        : TARGETS
    return {
      callId: member.callID,
      capabilityId: member.capabilityID,
      challengeId: `ch_${member.callID}`,
      effectId: `eff_${member.callID}`,
      locationID: "loc_1",
      inputDigest: DIGEST,
      normalizedTargets: TARGETS,
      targets,
      expiresAtUnixMs: overrides.expiresAtUnixMs ?? Date.now() + 60_000,
      policySummary: "workspace-write.local.v1 requires explicit approval",
      origin: "session_batch",
      source: "core.tool_batch",
      policyID: "workspace-write.local.v1",
      policyDigest: DIGEST,
      normalizedAction: member.capabilityID,
      argumentSummary: { status: "available", text: `Write ${member.callID}.txt (1 byte)` },
      requestedGuarantees: ["beneath_workspace_root", "no_symlink", "no_hardlink", "one_use"],
      guaranteeAssessment: { status: "assessed", residual: [] },
      noResponse: "deny_and_expire",
      allowEnabled: true,
    }
  })
  overrides.mutate?.(entries)
  return {
    status: "needs_approval" as const,
    batchId: "batch_multi",
    calls: entries,
  } as Readonly<Record<string, unknown>>
}

type Recorded = {
  readonly approvals: Array<GuardApprovalRequest>
  readonly resolves: Array<{
    readonly sessionID: string
    readonly locationID: string
    readonly batchID: string
    readonly challengeIDs: ReadonlyArray<string>
  }>
  readonly cancels: Array<{ readonly sessionID: string; readonly batchID: string }>
}

function port(
  input: {
    readonly decisions?: ReadonlyArray<GuardApprovalDecision>
    readonly approvalError?: SessionSupervisorError
    /** The atomic approval-set transaction fails as one unit: no member keeps a lease. */
    readonly resolveSetError?: SessionSupervisorError
    readonly leaseEffectID?: (challengeID: string) => string
    readonly cancelError?: SessionSupervisorError
    readonly recorded: Recorded
  },
): ToolBatchRelayPort {
  let next = 0
  return {
    requestApproval: (request) => {
      input.recorded.approvals.push(request)
      if (input.approvalError) return Effect.fail(input.approvalError)
      return Effect.succeed(input.decisions?.[next++] ?? "allow_once")
    },
    resolveApprovalSet: (request) => {
      input.recorded.resolves.push(request)
      if (input.resolveSetError) return Effect.fail(input.resolveSetError)
      return Effect.succeed({
        leases: request.challengeIDs.map((challengeID, index) => ({
          challengeID,
          lease: {
            effectID: input.leaseEffectID?.(challengeID) ?? `eff_${challengeID.slice(3)}`,
            capabilityLeaseDigest: leaseDigest(index),
          } as EffectLease,
        })),
      })
    },
    cancelBatch: (value) =>
      Effect.suspend(() => {
        input.recorded.cancels.push(value)
        if (input.cancelError) return Effect.fail(input.cancelError)
        return Effect.void
      }),
  }
}

function recorded(): Recorded {
  return { approvals: [], resolves: [], cancels: [] }
}

const relay = (calls: ReadonlyArray<GuardedToolCall>, response: Readonly<Record<string, unknown>>, portValue: ToolBatchRelayPort) =>
  relayMultiCallToolBatch(
    { sessionID: "ses_1", batchID: "batch_multi", locationID: "loc_1", calls, response },
    portValue,
  )

it.live("encodes decimal Attempt fences as MessagePack unsigned integers", () =>
  Effect.sync(() => {
    const scope = {
      attemptID: "att_0123456789abcdef",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child",
      profileID: "profile_general",
      profileRevision: "3",
      profileDigest: `blake3:${"f".repeat(64)}`,
      ownerEpoch: "18446744073709551615",
      expectedRevision: "42",
      locationID: "loc_child",
      workspaceID: "wrk_child",
      workspaceRevision: `blake3:${"a".repeat(64)}`,
      capabilityDigest: `sha256:${"b".repeat(64)}`,
      permissionsDigest: `sha256:${"c".repeat(64)}`,
      budgetDigest: `sha256:${"d".repeat(64)}`,
      scopeDigest: `sha256:${"e".repeat(64)}`,
    }
    const wire = directAttemptScopeToWire(scope)
    expect(wire).toEqual({
      ...scope,
      ownerEpoch: 18446744073709551615n,
      expectedRevision: 42n,
    })
    const roundTrip = unpack(pack({ directAttempt: wire })) as { directAttempt: typeof wire }
    expect(roundTrip.directAttempt.ownerEpoch).toBe(18446744073709551615n)
    expect(roundTrip.directAttempt.expectedRevision).toBe(42n)
    expect(() => directAttemptScopeToWire({ ...scope, expectedRevision: "0" })).toThrow()
    expect(() => directAttemptScopeToWire({ ...scope, ownerEpoch: "18446744073709551616" })).toThrow()
    expect(() => directAttemptScopeToWire({ ...scope, profileRevision: "0" })).toThrow()
    expect(() => directAttemptScopeToWire({ ...scope, profileRevision: "18446744073709551616" })).toThrow()
  })
)

it.live("asks one approval per member and returns one lease per approved call", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.patch")]
  const seen = recorded()
  const decisions = ["allow_once", "allow_once"] as const
  return Effect.gen(function* () {
    const admission = yield* relay(calls, responseFor(calls), port({ decisions, recorded: seen }))
    expect(admission.status).toBe("prepared_batch")
    if (admission.status !== "prepared_batch") return
    expect(admission.calls.map((entry) => entry.callID)).toEqual(["call_a", "call_b"])
    expect(admission.calls.map((entry) => entry.capabilityID)).toEqual(["files.write", "files.patch"])
    expect(admission.calls.map((entry) => entry.lease?.capabilityLeaseDigest)).toEqual([leaseDigest(0), leaseDigest(1)])
    expect(seen.approvals).toHaveLength(2)
    expect(seen.approvals.map((request) => request.challengeID)).toEqual(["ch_call_a", "ch_call_b"])
    expect(seen.approvals.map((request) => request.capabilityID)).toEqual(["files.write", "files.patch"])
    expect(seen.approvals.every((request) => request.locationID === "loc_1")).toBe(true)
    expect(seen.resolves).toEqual([{
      sessionID: "ses_1",
      locationID: "loc_1",
      batchID: "batch_multi",
      challengeIDs: ["ch_call_a", "ch_call_b"],
    }])
    expect(seen.cancels).toHaveLength(0)
  })
})

it.live("does not permit allow when the host has not assessed residual guarantees", () =>
  Effect.gen(function* () {
    const calls = [call("call_1", "files.write"), call("call_2", "files.write")]
    const response = responseFor(calls, {
      mutate: (entries) => {
        for (const entry of entries) {
          entry.guaranteeAssessment = { status: "not_assessed", residual: null }
          entry.allowEnabled = false
        }
      },
    })
    const callsMade = recorded()
    const result = yield* relay(calls, response, port({ recorded: callsMade }))
    expect(result.status).toBe("denied")
    expect(callsMade.approvals).toHaveLength(2)
    expect(callsMade.resolves).toHaveLength(0)
    expect(callsMade.cancels).toHaveLength(1)
  }),
)

it.live("rejects host approval metadata missing the typed consent projection", () =>
  Effect.gen(function* () {
    const calls = [call("call_1", "files.write"), call("call_2", "files.write")]
    const response = responseFor(calls, {
      mutate: (entries) => {
        delete entries[0]!.argumentSummary
      },
    })
    const callsMade = recorded()
    const error = yield* relay(calls, response, port({ recorded: callsMade })).pipe(Effect.flip)
    expect(error.reason).toContain("argument summary")
    expect(callsMade.approvals).toHaveLength(0)
    expect(callsMade.resolves).toHaveLength(0)
    expect(callsMade.cancels).toHaveLength(1)
  }),
)

it.live("denies the complete batch and cancels every member when one approval is denied", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const seen = recorded()
  const decisions = ["allow_once", "deny"] as const
  return Effect.gen(function* () {
    const admission = yield* relay(calls, responseFor(calls), port({ decisions, recorded: seen }))
    expect(admission).toEqual({ status: "denied", reason: "Guard approval was denied" })
    expect(seen.resolves).toHaveLength(0)
    expect(seen.cancels).toEqual([{ sessionID: "ses_1", batchID: "batch_multi" }])
  })
})

it.live("interruption while approvals are pending cancels the durable complete batch", () =>
  Effect.gen(function* () {
    const pending = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const calls = [call("a", "files.write"), call("b", "files.write")]
    const running = yield* relayMultiCallToolBatch(
      { sessionID: "ses_1", batchID: "batch_multi", locationID: "loc_1", calls, response: responseFor(calls) },
      {
        requestApproval: () => Deferred.succeed(pending, undefined).pipe(Effect.andThen(Effect.never)),
        resolveApprovalSet: () => Effect.die("must not resolve a pending approval"),
        cancelBatch: () => Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
      },
    ).pipe(Effect.forkChild)
    yield* Deferred.await(pending)
    yield* Fiber.interrupt(running)
    expect(yield* Deferred.isDone(cancelled)).toBe(true)
  }),
)

it.live("cancels the batch when an approval expires or fails", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const seen = recorded()
  return Effect.gen(function* () {
    const exit = yield* relay(
      calls,
      responseFor(calls),
      port({
        recorded: seen,
        approvalError: new SessionSupervisorError({ stage: "approval-conflict", reason: "Guard approval expired" }),
      }),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(seen.resolves).toHaveLength(0)
    expect(seen.cancels).toEqual([{ sessionID: "ses_1", batchID: "batch_multi" }])
  })
})

it.live("cancels the batch and returns no lease when the approval-set resolve fails", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const seen = recorded()
  const decisions = ["allow_once", "allow_once"] as const
  return Effect.gen(function* () {
    const exit = yield* relay(
      calls,
      responseFor(calls),
      port({
        decisions,
        recorded: seen,
        // The approval-set transaction is atomic: the host either durably issues
        // every member's one-use lease or fails the whole set with no lease.
        resolveSetError: new SessionSupervisorError({ stage: "host-kernel", reason: "host rejected Guard approval" }),
      }),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(seen.resolves).toHaveLength(1)
    // A failed approval-set resolution must be cancelled: no member may keep an approval.
    expect(seen.cancels).toEqual([{ sessionID: "ses_1", batchID: "batch_multi" }])
  })
})

it.live("refuses mismatched, duplicated or missing per-call challenges before any approval", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const mutations: Array<(entries: Array<Record<string, unknown>>) => void> = [
    (entries) => {
      entries[1]!.callId = "call_other"
    },
    (entries) => {
      entries[1]!.capabilityId = "files.patch"
    },
    (entries) => {
      entries[1] = { ...entries[0]! }
    },
    (entries) => {
      entries[1]!.inputDigest = "not-a-digest"
    },
    (entries) => {
      entries[1]!.expiresAtUnixMs = Date.now() - 1
    },
    (entries) => {
      entries[1]!.normalizedTargets = []
    },
    (entries) => {
      entries[1]!.challengeId = ""
    },
    (entries) => {
      entries[1]!.locationID = "loc_other"
    },
    (entries) => {
      delete entries[1]!.policySummary
    },
  ]
  return Effect.gen(function* () {
    for (const mutate of mutations) {
      const seen = recorded()
      const exit = yield* relay(calls, responseFor(calls, { mutate }), port({ recorded: seen })).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(seen.approvals).toHaveLength(0)
      expect(seen.cancels).toHaveLength(1)
    }
    // A short/long member list is refused as well.
    for (const shortened of [
      responseFor(calls, { mutate: (entries) => entries.pop() }),
      { status: "needs_approval", batchId: "batch_multi", calls: [] } as Readonly<Record<string, unknown>>,
    ]) {
      const seen = recorded()
      const exit = yield* relay(calls, shortened, port({ recorded: seen })).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(seen.approvals).toHaveLength(0)
      expect(seen.cancels).toHaveLength(1)
    }
  })
})

it.live("cancels the batch when a resolved lease does not match its member", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const seen = recorded()
  const decisions = ["allow_once", "allow_once"] as const
  return Effect.gen(function* () {
    const exit = yield* relay(
      calls,
      responseFor(calls),
      port({
        decisions,
        recorded: seen,
        leaseEffectID: (challengeID) => (challengeID === "ch_call_b" ? "eff_other" : `eff_${challengeID.slice(3)}`),
      }),
    ).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(seen.cancels).toEqual([{ sessionID: "ses_1", batchID: "batch_multi" }])
  })
})

it.live("a failed batch cancellation never masks the original typed failure", () => {
  const calls = [call("call_a", "files.write"), call("call_b", "files.write")]
  const seen = recorded()
  const decisions = ["allow_once", "deny"] as const
  return Effect.gen(function* () {
    const admission = yield* relay(
      calls,
      responseFor(calls),
      port({
        decisions,
        recorded: seen,
        cancelError: new SessionSupervisorError({ stage: "host-kernel", reason: "host kernel request failed" }),
      }),
    )
    expect(admission).toEqual({ status: "denied", reason: "Guard approval was denied" })
    expect(seen.cancels).toHaveLength(1)
  })
})

it.live("relay rejects a single-member batch: multi-call admission requires at least two", () => {
  const calls = [call("call_a", "files.write")]
  const seen = recorded()
  return Effect.gen(function* () {
    const exit = yield* relay(calls, responseFor(calls), port({ recorded: seen })).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(seen.approvals).toHaveLength(0)
  })
})

it.live("negotiated feature name is the stable contract the host must advertise", () => {
  return Effect.sync(() => {
    expect(MULTI_CALL_BATCH_FEATURE).toBe("effects.v2.multi-call")
  })
})
