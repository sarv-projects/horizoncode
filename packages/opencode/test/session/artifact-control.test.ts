import { describe, expect, test } from "bun:test"
import { SessionSupervisor, type ArtifactRefWireV1, type ManagedAttemptScopeV1 } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Layer } from "effect"
import { ArtifactControlError, directSessionReadScope, inspect, readRange, type ArtifactReadScopeV1 } from "@/session/artifact-control"

const testPrincipal = { kind: "server_auth", subject: "artifact-control-test" } as const

const ref: ArtifactRefWireV1 = {
  artifactId: "artifact-1",
  digest: `blake3:${"a".repeat(64)}`,
  byteLength: "42",
  mediaType: "text/plain",
  classification: "workspace",
}

const managedAttempt: ManagedAttemptScopeV1 = {
  goalID: "goal-1",
  runID: "run-1",
  taskID: "task-1",
  attemptID: "attempt-1",
  ownerEpoch: "7",
  expectedManagedRevision: "12",
  requestSequence: "1",
  requestID: "req_managed_1",
  contextSelectionDigest: `blake3:${"d".repeat(64)}`,
  locationID: "location-1",
  sessionID: "session-1",
  workspaceRevision: `blake3:${"b".repeat(64)}`,
  effectiveMaxTokens: "5000",
  remainingTokens: "5000",
  delegationBindingDigest: `blake3:${"c".repeat(64)}`,
  permissionScopeDigest: `blake3:${"7".repeat(64)}`,
  worktreeTarget: {
    worktreeID: "wt-1",
    worktreeBaseRevision: "base-1",
    worktreePoolRevision: "1",
    locationID: "location-1",
    workspaceID: "wrk-1",
    workspaceRef: "refs/heads/managed",
    canonicalRoot: "/workspace",
    workspaceRevision: `blake3:${"b".repeat(64)}`,
  },
}

const scope: ArtifactReadScopeV1 = { sessionID: "session-1", managedAttempt }

function supervisor(options: {
  metadata?: unknown
  range?: unknown
  onRange?: () => void
}) {
  return Layer.mock(SessionSupervisor.Service)({
    inspectManagedArtifact: () => Effect.succeed(options.metadata as Record<string, unknown>),
    readManagedArtifactRange: () => {
      options.onRange?.()
      return Effect.succeed(options.range as Record<string, unknown>)
    },
  })
}

describe("ArtifactControl", () => {
  test("root Session reads require a reference from the authenticated receipt index", async () => {
    let inspectDispatched = false
    let rangeDispatched = false
    const locationRef = { directory: "/workspace", workspaceID: "workspace-1" } as never
    const layer = Layer.mock(SessionSupervisor.Service)({
      listDirectSessionArtifacts: () => Effect.succeed({
        status: "RECOVERED",
        sessionID: "session-1",
        locationID: "location-1",
        currentOwnerEpoch: "7",
        artifacts: [],
      }),
      inspectDirectSessionArtifact: () => {
        inspectDispatched = true
        return Effect.succeed({})
      },
      readDirectSessionArtifactRange: () => {
        rangeDispatched = true
        return Effect.succeed({})
      },
    })
    const result = await Effect.runPromise(Effect.gen(function* () {
      const scope = yield* directSessionReadScope({ sessionID: "session-1", locationRef, artifactRef: ref })
      expect(scope).toBeUndefined()
      return yield* Effect.result(
        inspect(scope ?? { sessionID: "session-1", locationRef, directSession: { ownerEpoch: "7" } }, ref),
      )
    }).pipe(
      Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
      Effect.provide(layer),
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ArtifactControlError)
    expect(inspectDispatched).toBe(false)
    expect(rangeDispatched).toBe(false)
  })

  test("root Session inspect and bounded range use the indexed receipt scope", async () => {
    let inspectInput: unknown
    let rangeInput: unknown
    const metadata = {
      artifactRef: ref,
      retentionClass: "terminal",
      createdAt: "2026-10-24T00:00:00.000Z",
      fidelity: "FULL",
      droppedByteCount: "0",
      encryption: "NONE",
      redaction: "APPLIED",
    }
    const range = {
      artifactRef: ref,
      offset: "0",
      nextOffset: "2",
      complete: false,
      bytes: new Uint8Array([0x6f, 0x6b]),
    }
    const locationRef = { directory: "/workspace", workspaceID: "workspace-1" } as never
    const layer = Layer.mock(SessionSupervisor.Service)({
      listDirectSessionArtifacts: () => Effect.succeed({
        status: "RECOVERED",
        sessionID: "session-1",
        locationID: "location-1",
        currentOwnerEpoch: "7",
        artifacts: [{
          artifactRef: ref,
          effectID: "effect-1",
          batchID: "batch-1",
          ownerEpoch: "7",
          callIndex: 0,
          callID: "call-1",
          challengeID: "challenge-1",
          receiptDigest: `blake3:${"e".repeat(64)}`,
          outputDigest: `blake3:${"f".repeat(64)}`,
          workspaceRevision: `blake3:${"b".repeat(64)}`,
          fidelity: "FULL",
          observedBytes: "42",
          droppedBytes: "0",
        }],
      }),
      inspectDirectSessionArtifact: (input) => {
        inspectInput = input
        return Effect.succeed(metadata)
      },
      readDirectSessionArtifactRange: (input) => {
        rangeInput = input
        return Effect.succeed(range)
      },
    })
    const output = await Effect.runPromise(Effect.gen(function* () {
      const scope = yield* directSessionReadScope({ sessionID: "session-1", locationRef, artifactRef: ref })
      expect(scope).toBeDefined()
      const inspected = yield* inspect(scope!, ref)
      const chunk = yield* readRange(scope!, ref, "0", 128)
      return { inspected, chunk }
    }).pipe(
      Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
      Effect.provide(layer),
    ))
    expect(output.inspected).toMatchObject({ artifactRef: ref, fidelity: "FULL", redaction: "APPLIED" })
    expect(output.chunk).toMatchObject({ artifactRef: ref, offset: "0", nextOffset: "2", complete: false })
    expect(inspectInput).toMatchObject({ sessionID: "session-1", locationRef, ownerEpoch: "7", artifactRef: ref })
    expect(rangeInput).toMatchObject({ sessionID: "session-1", locationRef, ownerEpoch: "7", artifactRef: ref, offset: "0", maxBytes: 128 })
  })

  test("preserves truthful fidelity and redaction metadata", async () => {
    for (const fidelity of ["FULL", "SAMPLE", "FAILED"] as const) {
      // Annotated so the fixture keeps the literal redaction union that the
      // typed ArtifactMetadataV1 projection expects.
      const redaction: "APPLIED" | "UNKNOWN" = fidelity === "FAILED" ? "UNKNOWN" : "APPLIED"
      const metadata = {
        artifactRef: ref,
        retentionClass: "managed-verifier",
        createdAt: "2026-10-20T00:00:00.000Z",
        fidelity,
        droppedByteCount: fidelity === "SAMPLE" ? "20" : "0",
        encryption: "STATE_KEY",
        redaction,
      }
      const result = await Effect.runPromise(
        inspect(scope, ref).pipe(
          Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
          Effect.provide(supervisor({ metadata })),
        ),
      )
      expect(result.fidelity).toBe(fidelity)
      expect(result.redaction).toBe(metadata.redaction)
      expect(result.droppedByteCount).toBe(metadata.droppedByteCount)
    }
  })

  test("rejects a mismatched Attempt Session before dispatch", async () => {
    let dispatched = false
    const result = await Effect.runPromise(Effect.result(
      readRange({ ...scope, sessionID: "session-other" }, ref, "0", 128).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
        Effect.provide(supervisor({ range: {}, onRange: () => { dispatched = true } })),
      ),
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ArtifactControlError)
    expect(dispatched).toBe(false)
  })

  test("rejects offsets beyond the immutable artifact before dispatch", async () => {
    let dispatched = false
    const result = await Effect.runPromise(Effect.result(
      readRange(scope, ref, "43", 128).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
        Effect.provide(supervisor({ range: {}, onRange: () => { dispatched = true } })),
      ),
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ArtifactControlError)
    expect(dispatched).toBe(false)
  })

  test("rejects a nonterminal range that makes no progress", async () => {
    const result = await Effect.runPromise(Effect.result(
      readRange(scope, ref, "0", 128).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
        Effect.provide(supervisor({ range: {
          artifactRef: ref,
          offset: "0",
          nextOffset: "0",
          complete: false,
          bytes: new Uint8Array(),
        } })),
      ),
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ArtifactControlError)
  })

  test("accepts a bounded progressing range with exact cursor and bytes", async () => {
    const bytes = new Uint8Array([0x6f, 0x6b])
    const result = await Effect.runPromise(
      readRange(scope, ref, "0", 128).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: testPrincipal }),
        Effect.provide(supervisor({ range: {
          artifactRef: ref,
          offset: "0",
          nextOffset: "2",
          complete: false,
          bytes,
        } })),
      ),
    )
    expect(result).toEqual({ artifactRef: ref, offset: "0", nextOffset: "2", complete: false, bytes })
  })
})
