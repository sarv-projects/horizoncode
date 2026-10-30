/**
 * Private P1-10 direct read-batch caller contract.
 *
 * One authenticated `effects.v2/prepare_tool_batch_read` RPC admits 1..8
 * ordinary `files.read` calls for the current direct Session/Location. HostKernel
 * returns a *read-only projection* per call; it never executes the read and it
 * never mints an `EffectLease`. Core must:
 *
 *  1. validate the whole strict request locally before any send,
 *  2. decode the whole strict response and recompute every canonical digest,
 *  3. execute each read through the canonical materialization path,
 *  4. revalidate the authenticated workspace snapshot before publishing any
 *     read result, and
 *  5. treat every failure as a whole-wave failure with no partial results, no
 *     same-wave retry and UNKNOWN-equivalent semantics for a possibly-sent RPC.
 *
 * This module owns steps 1, 2 and 4. Execution/settlement stays inside the
 * existing `Materialization.settle` boundary; nothing here widens write or
 * terminal `EffectLease` authority, enables managed/child lanes, CodeMode,
 * provider-hosted effects, or any effect gate.
 */
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1 } from "@horizoncode/schema"
import { Effect } from "effect"
import { TrustedPrincipalContext } from "../trusted-principal"
import type { DirectSessionWorkspaceSnapshotV1, Interface as SessionSupervisorPort } from "./supervisor"

export const DIRECT_READ_MAX_CALLS = 8
export const DIRECT_READ_RESULT_BUDGET_BYTES = 50 * 1024
export const DIRECT_READ_OFFSET_LIMIT_MAX = 2_000
const DIRECT_READ_LEASE_DOMAIN = "horizoncode.direct-read-lease.v1\0"
const MAX_PATH_BYTES = 4096
const IDENTITY = /^[A-Za-z0-9._:-]{1,256}$/
const BLAKE3 = /^blake3:[0-9a-f]{64}$/
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/

export type DirectReadCallV1 = {
  readonly callID: string
  readonly capabilityID: "files.read"
  readonly arguments: {
    readonly path: string
    readonly offset: number
    readonly limit: number
  }
}

export type DirectReadBatchRequestV1 = {
  readonly schemaVersion: 1
  readonly sessionID: string
  readonly locationID: string
  readonly calls: ReadonlyArray<DirectReadCallV1>
}

export type DirectReadProjectionV1 = {
  readonly schemaVersion: 1
  readonly requestID: string
  /** Derived from the authenticated private request context, never from the row body. */
  readonly sessionID: string
  readonly callID: string
  readonly capabilityID: "files.read"
  readonly locationID: string
  readonly target: string
  readonly offset: number
  readonly limit: number
  readonly argumentsDigest: string
  readonly resultBudgetBytes: typeof DIRECT_READ_RESULT_BUDGET_BYTES
  readonly ownerEpoch: string
  readonly policyDigest: string
  readonly permissionModeDigest: string
  readonly revision: string
  readonly workspaceBinding: string
  readonly subjectBinding: string
  readonly readLeaseDigest: string
}

export type DirectReadPreparationV1 = {
  readonly requestID: string
  readonly workspaceRevision: string
  readonly calls: ReadonlyArray<DirectReadProjectionV1>
}

export type DirectReadFailureV1 = {
  readonly status: "failed"
  readonly phase: "request" | "host" | "response" | "fence" | "result"
  /** A possibly-sent RPC is UNKNOWN-equivalent; the wave must never be retried. */
  readonly unknown: boolean
  readonly replay: "forbidden"
  readonly reason: string
}

export type DirectReadPreparationResultV1 =
  | ({ readonly status: "prepared" } & DirectReadPreparationV1)
  | DirectReadFailureV1

export type DirectReadWaveClassificationV1 =
  | { readonly kind: "direct_read"; readonly calls: ReadonlyArray<DirectReadCallV1> }
  | {
      readonly kind: "not_direct_read"
      readonly reason: "code_mode" | "managed_lane" | "attempt_lane" | "child_lane" | "mixed_wave" | "no_calls"
    }

type Built = { readonly ok: true; readonly request: DirectReadBatchRequestV1 } | { readonly ok: false; readonly failure: DirectReadFailureV1 }
type Decoded = { readonly ok: true; readonly prepared: DirectReadPreparationV1 } | { readonly ok: false; readonly failure: DirectReadFailureV1 }
type Fenced = { readonly ok: true } | { readonly ok: false; readonly failure: DirectReadFailureV1 }

function fail(phase: DirectReadFailureV1["phase"], reason: string, unknown = false): DirectReadFailureV1 {
  return Object.freeze({ status: "failed" as const, phase, unknown, replay: "forbidden" as const, reason })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
  return Object.keys(value).toSorted().join("\0") === [...expected].sort().join("\0")
}

/**
 * Repository-relative document path matching HostKernel's canonical form:
 * non-empty, bounded, relative, forward slashes only, no control bytes and no
 * `.`/`..`/empty components (a round-trip normalisation must be lossless).
 */
export function validDirectReadPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return false
  if (path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) return false
  const segments = path.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false
  return segments.join("/") === path
}

function validPageInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= DIRECT_READ_OFFSET_LIMIT_MAX
}

/** Canonical BLAKE3 digest of one exact `files.read` argument map. */
export function directReadArgumentsDigestV1(arguments_: DirectReadCallV1["arguments"]): string {
  const encoded = encodeCanonicalMessagePackV1(
    { path: arguments_.path, offset: arguments_.offset, limit: arguments_.limit },
    // The path alone may be the full 4 KiB canonical bound; include the bounded
    // map envelope and the two page integers instead of throwing during digest
    // recomputation.
    { maxEncodedBytes: 4224, maxDepth: 4, maxNodes: 16 },
  )
  return `blake3:${bytesToHex(blake3(encoded))}`
}

/** Domain-separated digest over the projection map without `readLeaseDigest`. */
export function directReadLeaseDigestV1(projection: Omit<DirectReadProjectionV1, "readLeaseDigest">): string {
  const binding = {
    argumentsDigest: projection.argumentsDigest,
    callID: projection.callID,
    capabilityID: projection.capabilityID,
    locationID: projection.locationID,
    limit: projection.limit,
    offset: projection.offset,
    ownerEpoch: projection.ownerEpoch,
    policyDigest: projection.policyDigest,
    permissionModeDigest: projection.permissionModeDigest,
    revision: projection.revision,
    resultBudgetBytes: projection.resultBudgetBytes,
    requestID: projection.requestID,
    schemaVersion: projection.schemaVersion,
    sessionID: projection.sessionID,
    subjectBinding: projection.subjectBinding,
    target: projection.target,
    workspaceBinding: projection.workspaceBinding,
  }
  const encoded = encodeCanonicalMessagePackV1(binding, { maxEncodedBytes: 8192, maxDepth: 4, maxNodes: 32 })
  const preimage = new Uint8Array([...new TextEncoder().encode(DIRECT_READ_LEASE_DOMAIN), ...encoded])
  return `blake3:${bytesToHex(blake3(preimage))}`
}

/**
 * Classify a completed provider wave before any admission. Only an ordinary
 * direct Session wave made entirely of `files.read` calls may use the fast path;
 * every other lane or mixed wave keeps the existing Guard/settlement behavior.
 */
export function classifyDirectReadWaveV1(input: {
  readonly codeMode: boolean
  readonly lane: "direct_session" | "managed_attempt" | "direct_attempt"
  readonly parentSessionID?: string
  readonly calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly arguments: unknown }>
}): DirectReadWaveClassificationV1 {
  if (input.codeMode) return { kind: "not_direct_read", reason: "code_mode" }
  if (input.lane === "managed_attempt") return { kind: "not_direct_read", reason: "managed_lane" }
  if (input.lane === "direct_attempt") return { kind: "not_direct_read", reason: "attempt_lane" }
  if (input.parentSessionID !== undefined) return { kind: "not_direct_read", reason: "child_lane" }
  if (input.calls.length === 0) return { kind: "not_direct_read", reason: "no_calls" }
  if (input.calls.some((call) => call.capabilityID !== "files.read"))
    return { kind: "not_direct_read", reason: "mixed_wave" }
  return {
    kind: "direct_read",
    calls: input.calls.map((call) => ({
      callID: call.callID,
      capabilityID: "files.read" as const,
      arguments: call.arguments as DirectReadCallV1["arguments"],
    })),
  }
}

type ValidatedCalls =
  | { readonly ok: true; readonly calls: ReadonlyArray<DirectReadCallV1> }
  | { readonly ok: false; readonly failure: DirectReadFailureV1 }

/**
 * Whole-wave call validation with no host interaction: 1..8 unique canonical
 * `files.read` members, each a strict three-field argument map with a
 * repository-relative path and an in-range page. Split from request
 * construction so a caller can reject a malformed wave before it registers or
 * contacts anything.
 */
export function validateDirectReadCallsV1(
  calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly arguments: unknown }>,
): ValidatedCalls {
  if (calls.length < 1 || calls.length > DIRECT_READ_MAX_CALLS)
    return { ok: false, failure: fail("request", "read batch requires one to eight calls") }
  const seen = new Set<string>()
  const validated: DirectReadCallV1[] = []
  for (const call of calls) {
    if (!isRecord(call) || !exactFields(call, ["callID", "capabilityID", "arguments"]))
      return { ok: false, failure: fail("request", "read batch call must carry exactly callID, capabilityID and arguments") }
    if (typeof call.callID !== "string" || !IDENTITY.test(call.callID))
      return { ok: false, failure: fail("request", "read batch call identity is malformed") }
    if (seen.has(call.callID)) return { ok: false, failure: fail("request", "read batch call identities must be unique") }
    seen.add(call.callID)
    if (call.capabilityID !== "files.read")
      return { ok: false, failure: fail("request", "read batch accepts only the canonical files.read capability") }
    if (!isRecord(call.arguments) || !exactFields(call.arguments, ["path", "offset", "limit"]))
      return { ok: false, failure: fail("request", "files.read arguments must be exactly path, offset and limit") }
    if (!validDirectReadPath(call.arguments.path))
      return { ok: false, failure: fail("request", "files.read path must be a canonical repository-relative document path") }
    if (!validPageInteger(call.arguments.offset) || !validPageInteger(call.arguments.limit))
      return { ok: false, failure: fail("request", "files.read offset and limit must be integers from 1 to 2000") }
    validated.push({
      callID: call.callID,
      capabilityID: "files.read",
      arguments: { path: call.arguments.path, offset: call.arguments.offset, limit: call.arguments.limit },
    })
  }
  return { ok: true, calls: validated }
}

/** Strict local request construction; a malformed wave never reaches the host. */
export function buildDirectReadBatchRequestV1(input: {
  readonly sessionID: string
  readonly locationID: string
  readonly calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly arguments: unknown }>
}): Built {
  if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID))
    return { ok: false, failure: fail("request", "read batch requires an authenticated direct Session ID") }
  if (!/^loc_[0-9a-f]{64}$/.test(input.locationID))
    return { ok: false, failure: fail("request", "read batch requires an authenticated Location ID") }
  const validated = validateDirectReadCallsV1(input.calls)
  if (!validated.ok) return { ok: false, failure: validated.failure }
  const calls = validated.calls
  return {
    ok: true,
    request: Object.freeze({
      schemaVersion: 1 as const,
      sessionID: input.sessionID,
      locationID: input.locationID,
      calls: Object.freeze(calls),
    }),
  }
}

function decodeProjection(input: {
  readonly raw: unknown
  readonly index: number
  readonly expected: DirectReadCallV1
  readonly request: DirectReadBatchRequestV1
  readonly requestID: string
  readonly workspaceRevision: string
}): DirectReadProjectionV1 | DirectReadFailureV1 {
  if (!isRecord(input.raw)) return fail("response", `read batch row ${input.index} is not a projection map`)
  const fields = [
    "argumentsDigest", "callID", "capabilityID", "limit", "locationID", "offset", "ownerEpoch",
    "permissionModeDigest", "policyDigest", "readLeaseDigest", "requestID", "resultBudgetBytes",
    "revision", "schemaVersion", "sessionID", "subjectBinding", "target", "workspaceBinding",
  ]
  if (!exactFields(input.raw, fields)) return fail("response", `read batch row ${input.index} has an unexpected field set`)
  const row = input.raw
  if (row.schemaVersion !== 1) return fail("response", `read batch row ${input.index} has an unsupported schema version`)
  if (row.requestID !== input.requestID) return fail("response", `read batch row ${input.index} is bound to a different request`)
  if (row.sessionID !== input.request.sessionID) return fail("response", `read batch row ${input.index} is bound to a different Session`)
  if (row.callID !== input.expected.callID) return fail("response", `read batch row ${input.index} substituted the admitted call identity`)
  if (row.capabilityID !== "files.read") return fail("response", `read batch row ${input.index} substituted the admitted capability`)
  if (row.locationID !== input.request.locationID) return fail("response", `read batch row ${input.index} is bound to a different Location`)
  if (row.target !== input.expected.arguments.path)
    return fail("response", `read batch row ${input.index} substituted the admitted read target`)
  if (row.offset !== input.expected.arguments.offset || row.limit !== input.expected.arguments.limit)
    return fail("response", `read batch row ${input.index} substituted the admitted read page`)
  if (row.resultBudgetBytes !== DIRECT_READ_RESULT_BUDGET_BYTES)
    return fail("response", `read batch row ${input.index} widened the direct read result budget`)
  if (typeof row.ownerEpoch !== "string" || !UNSIGNED_DECIMAL.test(row.ownerEpoch) || row.ownerEpoch === "0")
    return fail("response", `read batch row ${input.index} carries a malformed owner epoch`)
  if (typeof row.policyDigest !== "string" || !BLAKE3.test(row.policyDigest))
    return fail("response", `read batch row ${input.index} carries a malformed policy digest`)
  if (typeof row.permissionModeDigest !== "string" || !BLAKE3.test(row.permissionModeDigest))
    return fail("response", `read batch row ${input.index} carries a malformed permission-mode digest`)
  if (typeof row.workspaceBinding !== "string" || !BLAKE3.test(row.workspaceBinding))
    return fail("response", `read batch row ${input.index} carries a malformed workspace binding`)
  if (typeof row.subjectBinding !== "string" || !BLAKE3.test(row.subjectBinding))
    return fail("response", `read batch row ${input.index} carries a malformed subject binding`)
  if (typeof row.revision !== "string" || !BLAKE3.test(row.revision) || row.revision !== input.workspaceRevision)
    return fail("response", `read batch row ${input.index} is bound to a stale workspace revision`)
  if (typeof row.argumentsDigest !== "string" || !BLAKE3.test(row.argumentsDigest))
    return fail("response", `read batch row ${input.index} carries a malformed arguments digest`)
  if (row.argumentsDigest !== directReadArgumentsDigestV1(input.expected.arguments))
    return fail("response", `read batch row ${input.index} arguments digest does not match the admitted read`)
  if (typeof row.readLeaseDigest !== "string" || !BLAKE3.test(row.readLeaseDigest))
    return fail("response", `read batch row ${input.index} carries a malformed read lease digest`)
  const projection: DirectReadProjectionV1 = {
    schemaVersion: 1,
    requestID: input.requestID,
    sessionID: input.request.sessionID,
    callID: input.expected.callID,
    capabilityID: "files.read",
    locationID: input.request.locationID,
    target: input.expected.arguments.path,
    offset: input.expected.arguments.offset,
    limit: input.expected.arguments.limit,
    argumentsDigest: row.argumentsDigest,
    resultBudgetBytes: DIRECT_READ_RESULT_BUDGET_BYTES,
    ownerEpoch: row.ownerEpoch,
    policyDigest: row.policyDigest,
    permissionModeDigest: row.permissionModeDigest,
    revision: row.revision,
    workspaceBinding: row.workspaceBinding,
    subjectBinding: row.subjectBinding,
    readLeaseDigest: row.readLeaseDigest,
  }
  if (directReadLeaseDigestV1(projection) !== row.readLeaseDigest)
    return fail("response", `read batch row ${input.index} read lease digest does not match its projection`)
  return Object.freeze(projection)
}

/** Strict whole-wave response decoding; any mismatch fails the complete wave. */
export function decodeDirectReadBatchResponseV1(input: {
  readonly request: DirectReadBatchRequestV1
  readonly requestID: string
  readonly body: unknown
}): Decoded {
  if (!isRecord(input.body)) return { ok: false, failure: fail("response", "read batch response is not a body map") }
  if (!exactFields(input.body, ["calls", "schemaVersion", "workspaceRevision"]))
    return { ok: false, failure: fail("response", "read batch response has an unexpected field set") }
  if (input.body.schemaVersion !== 1)
    return { ok: false, failure: fail("response", "read batch response has an unsupported schema version") }
  if (typeof input.body.workspaceRevision !== "string" || !BLAKE3.test(input.body.workspaceRevision))
    return { ok: false, failure: fail("response", "read batch response carries a malformed workspace revision") }
  if (!Array.isArray(input.body.calls) || input.body.calls.length !== input.request.calls.length)
    return { ok: false, failure: fail("response", "read batch response must return exactly one row per admitted call") }
  const calls: DirectReadProjectionV1[] = []
  for (const [index, expected] of input.request.calls.entries()) {
    const decoded = decodeProjection({
      raw: input.body.calls[index],
      index,
      expected,
      request: input.request,
      requestID: input.requestID,
      workspaceRevision: input.body.workspaceRevision,
    })
    if ("status" in decoded) return { ok: false, failure: decoded }
    calls.push(decoded)
  }
  return {
    ok: true,
    prepared: Object.freeze({
      requestID: input.requestID,
      workspaceRevision: input.body.workspaceRevision,
      calls: Object.freeze(calls),
    }),
  }
}

/**
 * Authenticated workspace fence. Must be evaluated after the reads and before
 * publishing any read result: a moved workspace revision, a different
 * Location/Session, a missing snapshot or an unreadable snapshot fails the whole
 * wave. Earlier successful reads are never published under a broken fence.
 */
export function verifyDirectReadWorkspaceFenceV1(input: {
  readonly prepared: DirectReadPreparationV1
  readonly sessionID: string
  readonly locationID: string
  readonly snapshot: DirectSessionWorkspaceSnapshotV1 | undefined
}): Fenced {
  const snapshot = input.snapshot
  if (!snapshot) return { ok: false, failure: fail("fence", "direct read workspace snapshot is unavailable", true) }
  if (snapshot.sessionID !== input.sessionID)
    return { ok: false, failure: fail("fence", "direct read workspace snapshot belongs to a different Session", true) }
  if (snapshot.locationID !== input.locationID)
    return { ok: false, failure: fail("fence", "direct read workspace snapshot belongs to a different Location", true) }
  if (snapshot.workspaceRevision !== input.prepared.workspaceRevision)
    return { ok: false, failure: fail("fence", "workspace revision changed after direct read admission", true) }
  if (input.prepared.calls.some((call) => call.revision !== snapshot.workspaceRevision))
    return { ok: false, failure: fail("fence", "admitted read rows do not share the current workspace revision", true) }
  return { ok: true }
}

/**
 * One-shot admission: local validation, one authenticated send, strict decode.
 * A host/transport failure is UNKNOWN-equivalent and is never retried here.
 */
export const prepare = Effect.fn("DirectReadBatch.prepare")(function* (input: {
  readonly sessionID: string
  readonly locationID: string
  readonly calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly arguments: unknown }>
  readonly requestID: string
  readonly send: (
    request: DirectReadBatchRequestV1,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, unknown>
}) {
  if (!IDENTITY.test(input.requestID))
    return yield* Effect.succeed(fail("request", "read batch requires a canonical request identity"))
  const built = buildDirectReadBatchRequestV1(input)
  if (!built.ok) return yield* Effect.succeed(built.failure)
  const body = yield* input.send(built.request).pipe(
    Effect.catchCause(() =>
      Effect.succeed<Readonly<Record<string, unknown>> | DirectReadFailureV1>(
        fail("host", "direct read admission outcome is UNKNOWN; the wave is not retried", true),
      ),
    ),
  )
  if (isRecord(body) && "status" in body && body.status === "failed" && body.replay === "forbidden")
    return yield* Effect.succeed(body as DirectReadFailureV1)
  const decoded = decodeDirectReadBatchResponseV1({ request: built.request, requestID: input.requestID, body })
  if (!decoded.ok) return yield* Effect.succeed(decoded.failure)
  return yield* Effect.succeed({ status: "prepared" as const, ...decoded.prepared })
})

export type DirectReadSettledResultV1 = {
  readonly callID: string
  readonly status: "settled" | "rejected" | "cancelled" | "unknown"
  readonly output?: string
}

export type DirectReadWavePublicationV1 = {
  readonly callID: string
  readonly projection: DirectReadProjectionV1
  readonly output: string
  readonly bytes: number
}

type Published =
  | { readonly ok: true; readonly calls: ReadonlyArray<DirectReadWavePublicationV1> }
  | { readonly ok: false; readonly failure: DirectReadFailureV1 }

/**
 * Publication gate. Evaluated only after every read settled: the authenticated
 * workspace fence must still hold and the complete ordered wave must have one
 * bounded settled result per admitted call. A missing, foreign, unordered,
 * unsettled or over-budget member fails the entire wave and publishes nothing.
 */
export function publishDirectReadWaveV1(input: {
  readonly prepared: DirectReadPreparationV1
  readonly sessionID: string
  readonly locationID: string
  readonly snapshot: DirectSessionWorkspaceSnapshotV1 | undefined
  readonly results: ReadonlyArray<DirectReadSettledResultV1>
}): Published {
  const fenced = verifyDirectReadWorkspaceFenceV1(input)
  if (!fenced.ok) return { ok: false, failure: fenced.failure }
  if (input.results.length !== input.prepared.calls.length)
    return { ok: false, failure: fail("result", "direct read wave is incomplete; no read result is published") }
  const published: DirectReadWavePublicationV1[] = []
  const seen = new Set<string>()
  for (const [index, projection] of input.prepared.calls.entries()) {
    const result = input.results[index]
    if (!result || result.callID !== projection.callID || seen.has(result.callID))
      return { ok: false, failure: fail("result", "direct read results do not match the admitted ordered wave") }
    seen.add(result.callID)
    if (result.status !== "settled")
      return {
        ok: false,
        failure: fail(
          "result",
          `direct read ${projection.callID} did not settle; no read result from this wave is published`,
          result.status === "unknown",
        ),
      }
    if (typeof result.output !== "string")
      return { ok: false, failure: fail("result", `direct read ${projection.callID} produced no bounded output`) }
    const bytes = Buffer.byteLength(result.output, "utf8")
    if (bytes > projection.resultBudgetBytes)
      return { ok: false, failure: fail("result", `direct read ${projection.callID} exceeded its 50 KiB result budget`) }
    published.push(Object.freeze({ callID: projection.callID, projection, output: result.output, bytes }))
  }
  return { ok: true, calls: Object.freeze(published) }
}

/**
 * The four supervisor operations the caller needs. The port is a `Pick` so the
 * complete wave can be exercised without constructing the 38-method service.
 */
export type DirectReadHostV1 = Pick<
  SessionSupervisorPort,
  "hostFeatureEnabled" | "registerHostLocation" | "requestHostKernel" | "directSessionWorkspaceSnapshot"
>

export type DirectReadWaveOutcomeV1 =
  /** Not a direct-read wave (or the host feature is closed): keep the ordinary path. */
  | { readonly status: "unavailable" }
  /** An admitted wave failed locally, at the host, at decode or at the fence: nothing is published. */
  | { readonly status: "denied"; readonly failure: DirectReadFailureV1 }
  | { readonly status: "published"; readonly calls: ReadonlyArray<DirectReadWavePublicationV1> }

/**
 * The P1-10 Core read caller: one authenticated admission for the complete
 * direct-read wave, canonical execution of every admitted read, and a single
 * publication gate that re-reads the authenticated workspace snapshot only
 * *after* the reads and *before* any result becomes visible.
 *
 * Ordering is part of the contract: `register → send → execute → snapshot →
 * publish`. A feature that is closed, a non-direct lane, a CodeMode or child
 * wave or a mixed read/effect wave yields `unavailable` and the caller keeps
 * the existing Guard/settlement behavior. Once the wave is admitted as a
 * direct read, every later failure is a whole-wave denial with no partial
 * results and no same-wave retry.
 */
export const runWave = Effect.fn("DirectReadBatch.runWave")(function* (input: {
  readonly host: DirectReadHostV1
  readonly sessionID: string
  readonly locationRef: Parameters<DirectReadHostV1["registerHostLocation"]>[0]
  readonly requestID: string
  readonly lane: "direct_session" | "managed_attempt" | "direct_attempt"
  readonly codeMode: boolean
  readonly parentSessionID?: string
  readonly calls: ReadonlyArray<{ readonly callID: string; readonly capabilityID: string; readonly arguments: unknown }>
  /** Canonical materialization of the admitted reads, in admitted order. */
  readonly execute: (
    projections: ReadonlyArray<DirectReadProjectionV1>,
  ) => Effect.Effect<ReadonlyArray<DirectReadSettledResultV1>, unknown>
}) {
  const trusted = yield* TrustedPrincipalContext
  const classification = classifyDirectReadWaveV1({
    codeMode: input.codeMode,
    lane: input.lane,
    ...(input.parentSessionID === undefined ? {} : { parentSessionID: input.parentSessionID }),
    calls: input.calls,
  })
  if (classification.kind !== "direct_read") return { status: "unavailable" as const }
  if (!IDENTITY.test(input.requestID))
    return {
      status: "denied" as const,
      failure: fail("request", "direct read admission requires a canonical request identity"),
    }
  const enabled = yield* input.host
    .hostFeatureEnabled("effects.v2")
    .pipe(Effect.catch(() => Effect.succeed(false)))
  if (!enabled) return { status: "unavailable" as const }
  if (trusted.principal.kind !== "server_auth" || !trusted.principal.subject)
    return {
      status: "denied" as const,
      failure: fail("request", "direct read admission requires an authenticated ServerAuth principal"),
    }
  // The complete wave is validated locally before any host interaction.
  const validated = validateDirectReadCallsV1(classification.calls)
  if (!validated.ok) return { status: "denied" as const, failure: validated.failure }
  const locationID = yield* input.host.registerHostLocation(input.locationRef).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (locationID === undefined)
    return {
      status: "denied" as const,
      failure: fail("request", "direct read admission could not resolve the authenticated Location"),
    }
  const built = buildDirectReadBatchRequestV1({ sessionID: input.sessionID, locationID, calls: validated.calls })
  if (!built.ok) return { status: "denied" as const, failure: built.failure }
  const prepared = yield* prepare({
    sessionID: input.sessionID,
    locationID,
    calls: validated.calls,
    requestID: input.requestID,
    send: (request) =>
      input.host.requestHostKernel("effects.v2", "prepare_tool_batch_read", request, {
        trustedPrincipal: trusted.principal,
        authenticatedContext: { kind: "repo_read", sessionID: input.sessionID, locationID },
        // P1's read-path-only envelope binding: the exact ID every projection
        // row must echo, so row matching is exact rather than positional.
        requestID: input.requestID,
      }),
  })
  if (prepared.status !== "prepared") return { status: "denied" as const, failure: prepared }
  const results = yield* input.execute(prepared.calls)
  // The fence is re-read from the authenticated projection only after the
  // reads finished; a missing, failed or moved snapshot denies the whole wave.
  const snapshot = yield* input.host
    .directSessionWorkspaceSnapshot({ sessionID: input.sessionID, locationRef: input.locationRef })
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  const published = publishDirectReadWaveV1({
    prepared,
    sessionID: input.sessionID,
    locationID,
    snapshot,
    results,
  })
  if (!published.ok) return { status: "denied" as const, failure: published.failure }
  return { status: "published" as const, calls: published.calls }
})

export const DirectReadBatch = {
  maxCalls: DIRECT_READ_MAX_CALLS,
  resultBudgetBytes: DIRECT_READ_RESULT_BUDGET_BYTES,
  classify: classifyDirectReadWaveV1,
  buildRequest: buildDirectReadBatchRequestV1,
  decodeResponse: decodeDirectReadBatchResponseV1,
  verifyFence: verifyDirectReadWorkspaceFenceV1,
  publish: publishDirectReadWaveV1,
  argumentsDigest: directReadArgumentsDigestV1,
  prepare,
  runWave,
} as const
