import { describe, expect, test } from "bun:test"
import { SessionSupervisor, type ManagedAttemptScopeV1 } from "@opencode-ai/core/session/supervisor"
import { Effect, Layer } from "effect"
import { ArtifactControlError, inspect, readRange, type ArtifactReadScopeV1, type ArtifactRefWireV1 } from "@/session/artifact-control"

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
  locationID: "location-1",
  sessionID: "session-1",
  workspaceRevision: `blake3:${"b".repeat(64)}`,
  effectiveMaxTokens: "5000",
  remainingTokens: "5000",
  delegationBindingDigest: `blake3:${"c".repeat(64)}`,
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
  test("preserves truthful fidelity and redaction metadata", async () => {
    for (const fidelity of ["FULL", "SAMPLE", "FAILED"] as const) {
      const metadata = {
        artifactRef: ref,
        retentionClass: "managed-verifier",
        createdAt: "2026-10-20T00:00:00.000Z",
        fidelity,
        droppedByteCount: fidelity === "SAMPLE" ? "20" : "0",
        encryption: "STATE_KEY",
        redaction: fidelity === "FAILED" ? "UNKNOWN" : "APPLIED",
      }
      const result = await Effect.runPromise(inspect(scope, ref).pipe(Effect.provide(supervisor({ metadata }))))
      expect(result.fidelity).toBe(fidelity)
      expect(result.redaction).toBe(metadata.redaction)
      expect(result.droppedByteCount).toBe(metadata.droppedByteCount)
    }
  })

  test("rejects a mismatched Attempt Session before dispatch", async () => {
    let dispatched = false
    const result = await Effect.runPromise(Effect.either(
      readRange({ ...scope, sessionID: "session-other" }, ref, "0", 128).pipe(
        Effect.provide(supervisor({ range: {}, onRange: () => { dispatched = true } })),
      ),
    ))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(ArtifactControlError)
    expect(dispatched).toBe(false)
  })

  test("rejects offsets beyond the immutable artifact before dispatch", async () => {
    let dispatched = false
    const result = await Effect.runPromise(Effect.either(
      readRange(scope, ref, "43", 128).pipe(
        Effect.provide(supervisor({ range: {}, onRange: () => { dispatched = true } })),
      ),
    ))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(ArtifactControlError)
    expect(dispatched).toBe(false)
  })

  test("rejects a nonterminal range that makes no progress", async () => {
    const result = await Effect.runPromise(Effect.either(
      readRange(scope, ref, "0", 128).pipe(Effect.provide(supervisor({ range: {
        artifactRef: ref,
        offset: "0",
        nextOffset: "0",
        complete: false,
        bytes: new Uint8Array(),
      } }))),
    ))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(ArtifactControlError)
  })

  test("accepts a bounded progressing range with exact cursor and bytes", async () => {
    const bytes = new Uint8Array([0x6f, 0x6b])
    const result = await Effect.runPromise(readRange(scope, ref, "0", 128).pipe(Effect.provide(supervisor({ range: {
      artifactRef: ref,
      offset: "0",
      nextOffset: "2",
      complete: false,
      bytes,
    } }))))
    expect(result).toEqual({ artifactRef: ref, offset: "0", nextOffset: "2", complete: false, bytes })
  })
})
