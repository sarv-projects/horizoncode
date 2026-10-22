/** Narrow Core projection of the HostKernel's verifier-artifact read permit. */
import { Effect, Schema } from "effect"
import type { Location as LocationSchema } from "@opencode-ai/core/location"
import type { ArtifactRefWireV1, DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@opencode-ai/core/session/supervisor"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"

const MAX_RANGE_BYTES = 768 * 1024
const DECIMAL_U64 = /^(0|[1-9][0-9]{0,19})$/
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const ID = /^[A-Za-z0-9._-]{1,256}$/

export class ArtifactControlError extends Schema.TaggedErrorClass<ArtifactControlError>()(
  "ArtifactControlError",
  { operation: Schema.String, code: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Artifact ${this.operation} failed (${this.code}): ${this.reason}`
  }
}

/** Host-minted managed Attempt scope, never accepted from an HTTP payload. */
export type ArtifactReadScopeV1 = {
  readonly sessionID: string
  readonly managedAttempt: ManagedAttemptScopeV1
} | {
  readonly sessionID: string
  readonly directAttempt: DirectAttemptScopeV1
} | {
  readonly sessionID: string
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly directSession: { readonly ownerEpoch: string }
}

export type ArtifactMetadataV1 = {
  readonly artifactRef: ArtifactRefWireV1
  readonly retentionClass: string
  readonly createdAt: string
  readonly fidelity: "FULL" | "SAMPLE" | "FAILED"
  readonly droppedByteCount: string
  readonly encryption: "NONE" | "STATE_KEY"
  readonly redaction: "NOT_NEEDED" | "APPLIED" | "UNKNOWN"
}

export type ArtifactRangeV1 = {
  readonly artifactRef: ArtifactRefWireV1
  readonly offset: string
  readonly nextOffset: string
  readonly complete: boolean
  readonly bytes: Uint8Array
}

function fail(operation: string, code: string, reason: string) {
  return new ArtifactControlError({ operation, code, reason })
}

function record(operation: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(operation, "artifact_protocol", "HostKernel returned a malformed object")
  }
  return value as Record<string, unknown>
}

function exactKeys(operation: string, value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).toSorted().join("\0") !== [...keys].sort().join("\0")) {
    throw fail(operation, "artifact_protocol", "HostKernel returned unexpected fields")
  }
}

function decimal(operation: string, value: unknown, name: string): string {
  if (typeof value !== "string" || !DECIMAL_U64.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw fail(operation, "artifact_protocol", `HostKernel returned an invalid ${name}`)
  }
  return value
}

function artifactRef(operation: string, value: unknown, expected: ArtifactRefWireV1): ArtifactRefWireV1 {
  const ref = record(operation, value)
  exactKeys(operation, ref, ["artifactId", "digest", "byteLength", "mediaType", "classification"])
  const classification = typeof ref.classification === "string" ? ref.classification.toLowerCase() : ""
  if (
    typeof ref.artifactId !== "string" || !ID.test(ref.artifactId) ||
    typeof ref.digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(ref.digest) ||
    typeof ref.byteLength !== "string" || !DECIMAL_U64.test(ref.byteLength) || BigInt(ref.byteLength) > MAX_U64 ||
    typeof ref.mediaType !== "string" || !ref.mediaType || Buffer.byteLength(ref.mediaType, "utf8") > 256 ||
    !["public", "workspace", "sensitive"].includes(classification)
  ) throw fail(operation, "artifact_protocol", "HostKernel returned an invalid ArtifactRef")
  const result: ArtifactRefWireV1 = {
    artifactId: ref.artifactId,
    digest: ref.digest,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    classification: classification as ArtifactRefWireV1["classification"],
  }
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw fail(operation, "artifact_protocol", "HostKernel returned a different ArtifactRef")
  }
  return result
}

function validateScope(operation: string, scope: ArtifactReadScopeV1) {
  if ("managedAttempt" in scope && scope.managedAttempt.sessionID !== scope.sessionID ||
      "directAttempt" in scope && scope.directAttempt.childSessionID !== scope.sessionID ||
      "directSession" in scope && (!/^[1-9][0-9]{0,19}$/.test(scope.directSession.ownerEpoch) || BigInt(scope.directSession.ownerEpoch) > MAX_U64)) {
    throw fail(operation, "artifact_scope_unavailable", "a matching authenticated Attempt scope is required")
  }
}

const directSessionArtifacts = new WeakMap<object, ReadonlyMap<string, ArtifactRefWireV1>>()

function artifactKey(ref: ArtifactRefWireV1): string {
  return `${ref.artifactId}\0${ref.digest}\0${ref.byteLength}\0${ref.mediaType}\0${ref.classification}`
}

function request(
  operation: "artifacts.inspect" | "artifacts.read_range",
  scope: ArtifactReadScopeV1,
  ref: ArtifactRefWireV1,
  range?: { readonly offset: string; readonly maxBytes: number },
) {
  validateScope(operation, scope)
  return Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    if (operation === "artifacts.read_range" && !range) {
      return yield* Effect.fail(fail(operation, "artifact_protocol", "a bounded range selector is required"))
    }
    const operationRequest = "directSession" in scope
      ? (() => {
          const refs = directSessionArtifacts.get(scope)
          if (!refs?.has(artifactKey(ref))) return undefined
          return operation === "artifacts.inspect"
            ? supervisor.inspectDirectSessionArtifact({ sessionID: scope.sessionID, locationRef: scope.locationRef, ownerEpoch: scope.directSession.ownerEpoch, artifactRef: ref })
            : supervisor.readDirectSessionArtifactRange({ sessionID: scope.sessionID, locationRef: scope.locationRef, ownerEpoch: scope.directSession.ownerEpoch, artifactRef: ref, ...range! })
        })()
      : "managedAttempt" in scope
      ? operation === "artifacts.inspect"
        ? supervisor.inspectManagedArtifact?.({ sessionID: scope.sessionID, managedAttempt: scope.managedAttempt, artifactRef: ref })
        : supervisor.readManagedArtifactRange?.({ sessionID: scope.sessionID, managedAttempt: scope.managedAttempt, artifactRef: ref, ...range! })
      : operation === "artifacts.inspect"
        ? supervisor.inspectDirectAttemptArtifact?.({ sessionID: scope.sessionID, directAttempt: scope.directAttempt, artifactRef: ref })
        : supervisor.readDirectAttemptArtifactRange?.({ sessionID: scope.sessionID, directAttempt: scope.directAttempt, artifactRef: ref, ...range! })
    if (!operationRequest) return yield* Effect.fail(fail(operation, "artifact_unavailable", "authenticated HostKernel artifact reads are unavailable"))
    return yield* operationRequest.pipe(Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
      Effect.fail(fail(operation, error.hostCode ?? "artifact_unavailable", error.reason)),
    ))
  })
}

/** Build a read scope only from the live, trusted direct-child Attempt authority. */
export function directAttemptReadScope(input: {
  readonly sessionID: string
  readonly directAttempt: { readonly currentScope: () => DirectAttemptScopeV1 }
}): ArtifactReadScopeV1 {
  const scope = input.directAttempt.currentScope()
  if (scope.childSessionID !== input.sessionID) {
    throw fail("artifacts.inspect", "artifact_scope_unavailable", "DirectAttempt does not own the current Session")
  }
  return { sessionID: input.sessionID, directAttempt: scope }
}

/** Build a root Session scope only from the authenticated Rust receipt index. */
export const directSessionReadScope = Effect.fn("ArtifactControl.directSessionReadScope")(function* (input: {
  readonly sessionID: string
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly artifactRef: ArtifactRefWireV1
}) {
  const operation = "artifacts.direct_session_scope"
  const supervisor = yield* SessionSupervisor.Service
  const projection = yield* supervisor.listDirectSessionArtifacts({ sessionID: input.sessionID, locationRef: input.locationRef }).pipe(
    Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
      Effect.fail(fail(operation, error.hostCode ?? "artifact_unavailable", error.reason)),
    ),
  )
  const refs = new Map<string, ArtifactRefWireV1>()
  for (const artifact of projection.artifacts) refs.set(artifactKey(artifact.artifactRef), artifact.artifactRef)
  if (!refs.has(artifactKey(input.artifactRef))) return undefined
  const scope: ArtifactReadScopeV1 = Object.freeze({
    sessionID: input.sessionID,
    locationRef: input.locationRef,
    directSession: Object.freeze({ ownerEpoch: projection.currentOwnerEpoch }),
  })
  directSessionArtifacts.set(scope, refs)
  return scope
})

export const inspect = Effect.fn("ArtifactControl.inspect")(function* (scope: ArtifactReadScopeV1, ref: ArtifactRefWireV1) {
  const operation = "artifacts.inspect"
  const value = record(operation, yield* request(operation, scope, ref))
  exactKeys(operation, value, ["artifactRef", "retentionClass", "createdAt", "fidelity", "droppedByteCount", "encryption", "redaction"])
  const resultRef = artifactRef(operation, value.artifactRef, ref)
  if (typeof value.retentionClass !== "string" || !ID.test(value.retentionClass) ||
      typeof value.createdAt !== "string" || value.createdAt.length > 64 ||
      !["FULL", "SAMPLE", "FAILED"].includes(String(value.fidelity)) ||
      !["NONE", "STATE_KEY"].includes(String(value.encryption)) ||
      !["NOT_NEEDED", "APPLIED", "UNKNOWN"].includes(String(value.redaction))) {
    return yield* fail(operation, "artifact_protocol", "HostKernel returned invalid artifact metadata")
  }
  return {
    artifactRef: resultRef,
    retentionClass: value.retentionClass,
    createdAt: value.createdAt,
    fidelity: value.fidelity as ArtifactMetadataV1["fidelity"],
    droppedByteCount: decimal(operation, value.droppedByteCount, "droppedByteCount"),
    encryption: value.encryption as ArtifactMetadataV1["encryption"],
    redaction: value.redaction as ArtifactMetadataV1["redaction"],
  } satisfies ArtifactMetadataV1
})

/** Resolve scope exclusively from authenticated Rust evidence; HTTP callers never submit Attempt scope. */
export const resolveVerifiedScope = Effect.fn("ArtifactControl.resolveVerifiedScope")(function* (input: {
  readonly sessionID: string
  readonly locationRef: typeof LocationSchema.Ref.Type
  readonly artifactRef: ArtifactRefWireV1
}) {
  const operation = "artifacts.resolve_scope"
  const supervisor = yield* SessionSupervisor.Service
  if (!supervisor.resolveVerifiedManagedArtifactScope) {
    return yield* fail(operation, "artifact_unavailable", "authenticated verified-artifact scope resolution is unavailable")
  }
  const managedAttempt = yield* supervisor.resolveVerifiedManagedArtifactScope(input).pipe(
    Effect.catchTag("SessionSupervisorError", (error: SessionSupervisorError) =>
      Effect.fail(fail(operation, error.hostCode ?? "artifact_unavailable", error.reason)),
    ),
  )
  const scope = { sessionID: managedAttempt.sessionID, managedAttempt }
  validateScope(operation, scope)
  return scope
})

export const readRange = Effect.fn("ArtifactControl.readRange")(function* (
  scope: ArtifactReadScopeV1,
  ref: ArtifactRefWireV1,
  offset: string,
  maxBytes: number,
) {
  const operation = "artifacts.read_range"
  const start = BigInt(decimal(operation, offset, "offset"))
  const length = BigInt(decimal(operation, ref.byteLength, "artifact byteLength"))
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RANGE_BYTES) {
    return yield* fail(operation, "artifact_bounds", "maxBytes exceeds the 768 KiB range bound")
  }
  if (start > length) {
    return yield* fail(operation, "artifact_bounds", "offset is beyond the artifact byte length")
  }
  const value = record(operation, yield* request(operation, scope, ref, { offset, maxBytes }))
  exactKeys(operation, value, ["artifactRef", "offset", "nextOffset", "complete", "bytes"])
  const resultRef = artifactRef(operation, value.artifactRef, ref)
  const returnedOffset = decimal(operation, value.offset, "offset")
  const nextOffset = decimal(operation, value.nextOffset, "nextOffset")
  if (returnedOffset !== offset || BigInt(nextOffset) < start || BigInt(nextOffset) > length ||
      typeof value.complete !== "boolean" || !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength > maxBytes || BigInt(value.bytes.byteLength) !== BigInt(nextOffset) - start ||
      value.complete !== (BigInt(nextOffset) === length) ||
      (!value.complete && nextOffset === offset)) {
    return yield* fail(operation, "artifact_protocol", "HostKernel returned an invalid bounded range")
  }
  return { artifactRef: resultRef, offset: returnedOffset, nextOffset, complete: value.complete, bytes: value.bytes } satisfies ArtifactRangeV1
})
