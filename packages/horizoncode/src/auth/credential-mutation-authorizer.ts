/**
 * Production `CredentialMutationAuthorizer`.
 *
 * This is the only Core path that can obtain a HostKernel `secret.v1` grant for
 * a provider credential mutation. The grant request is metadata-only and is
 * built exclusively from the already-validated `SecureInputBinding`; the
 * authenticated identity always comes from `TrustedPrincipalContext`, never
 * from CLI flags or request bodies. A `host_os` principal sends no typed
 * `ServerAuth` principal on the wire, so the kernel identifies the caller by its
 * `SO_PEERCRED`-derived `host_os_uid:<uid>` principal instead.
 */
import type { TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import {
  exactMutationGrant,
  principalRefOf,
  type CredentialMutationAuthorizer,
  type CredentialMutationGrant,
} from "./secret-mutation"
import type { SecureInputBinding, SecureInputOperation } from "./secure-input"

export const SECRET_MUTATION_SERVICE_ID = "secret.v1"

const HOST_OPERATION: Readonly<Record<SecureInputOperation, string>> = {
  put: "authorize_put",
  rotate: "authorize_rotate",
  revoke: "authorize_revoke",
}

/** Strict field set the kernel accepts for a `secret.v1` authorization request. */
const MAX_LABEL_BYTES = 128
const WIRE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const BLAKE3 = /^blake3:[a-f0-9]{64}$/
const GRANT_REF = /^secret_grant_[a-f0-9]{64}$/
const RECEIPT_REF = /^secret_receipt_[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/

const GRANT_FIELDS = [
  "schemaVersion",
  "operation",
  "providerId",
  "secretRef",
  "expectedVersion",
  "version",
  "label",
  "revokedVersion",
  "expiresAtUnixMs",
  "grantID",
  "grantDigest",
  "receiptID",
  "receiptDigest",
] as const

const REVOCATION_FIELDS = [
  "schemaVersion",
  "secretRef",
  "revokedVersion",
  "revokedAtUnixMs",
  "receiptID",
] as const

export type CredentialMutationDenialCode =
  | "denied"
  | "conflict"
  | "unavailable"
  | "unknown"
  | "malformed"
  | "transport"

/** Bounded rejection for a refused, lost, or malformed grant. Carries no secret material. */
export class CredentialMutationDenied extends Error {
  constructor(readonly code: CredentialMutationDenialCode) {
    super(`HostKernel secret mutation grant is ${code}`)
    this.name = "CredentialMutationDenied"
  }
}

/**
 * Trusted host request seam. In production this is the SessionSupervisor
 * `requestHostKernel` RPC; it is injected so the exact wire body can be tested
 * without a host kernel.
 */
export type CredentialMutationRpc = (
  serviceID: string,
  operation: string,
  body: Readonly<Record<string, unknown>>,
  principal: TrustedPrincipal,
) => Promise<Readonly<Record<string, unknown>>>

const deny = (code: CredentialMutationDenialCode): never => {
  throw new CredentialMutationDenied(code)
}

/** Exact own-key record; any extra, missing, or inherited field fails closed. */
const exactRecord = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return deny("malformed")
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== fields.length) return deny("malformed")
  for (const field of fields) if (!Object.hasOwn(record, field)) return deny("malformed")
  return record
}

const positiveVersion = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !DECIMAL.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

const boundedLabel = (value: unknown): boolean =>
  value === null ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LABEL_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value))

/**
 * HostKernel projects `expiresAtUnixMs` as an unsigned 64-bit integer, and the
 * Core messagepack decoder widens those to `bigint`. Accept either exact
 * integer form; floats, negatives, zero, and values beyond the safe-integer
 * range still fail closed.
 */
const positiveTimestamp = (value: unknown): boolean =>
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))

const HOST_CODES: Readonly<Record<string, CredentialMutationDenialCode>> = {
  secret_denied: "denied",
  missing_principal: "denied",
  invalid_effect_request: "malformed",
  effect_denied: "denied",
  secret_conflict: "conflict",
  secret_stale_version: "conflict",
  secret_provider_mismatch: "conflict",
  secret_not_found: "unavailable",
  secret_unavailable: "unavailable",
  secret_outcome_unknown: "unknown",
}

/** Only a host `SessionSupervisorError.hostCode` is inspected; the original error is never surfaced. */
const hostDenialCode = (error: unknown): CredentialMutationDenialCode => {
  const hostCode =
    typeof error === "object" && error !== null && "hostCode" in error
      ? (error as { readonly hostCode?: unknown }).hostCode
      : undefined
  return typeof hostCode === "string" ? (HOST_CODES[hostCode] ?? "unavailable") : "transport"
}

/**
 * Decode one HostKernel `secret.v1` success projection. Every field that binds
 * the grant to the authorized mutation is compared exactly; a grant that differs
 * in any field, carries an extra field, or lacks a required one is refused.
 */
function decodeGrant(value: unknown, binding: SecureInputBinding): CredentialMutationGrant {
  const responseFields =
    binding.operation === "revoke" ? (["grant", "revocation", "status"] as const) : (["grant", "status"] as const)
  const response = exactRecord(value, responseFields)
  if (response.status !== "COMMITTED" && response.status !== "REPLAY") return deny("malformed")

  const grant = exactRecord(response.grant, GRANT_FIELDS)
  if (grant.schemaVersion !== 1) return deny("malformed")
  if (grant.operation !== binding.operation) return deny("denied")
  if (grant.providerId !== binding.providerId) return deny("denied")
  if (typeof grant.secretRef !== "string" || !WIRE_ID.test(grant.secretRef)) return deny("malformed")
  if (binding.secretRef !== undefined && grant.secretRef !== binding.secretRef) return deny("denied")

  if (grant.expectedVersion === null) {
    if (binding.expectedVersion !== undefined) return deny("denied")
  } else if (positiveVersion(grant.expectedVersion) !== binding.expectedVersion) {
    return deny("denied")
  }
  if (positiveVersion(grant.version) === undefined) return deny("malformed")
  if (!boundedLabel(grant.label)) return deny("malformed")
  if (!positiveTimestamp(grant.expiresAtUnixMs)) return deny("malformed")
  if (typeof grant.grantID !== "string" || !GRANT_REF.test(grant.grantID)) return deny("malformed")
  if (typeof grant.grantDigest !== "string" || !BLAKE3.test(grant.grantDigest)) return deny("malformed")
  if (typeof grant.receiptDigest !== "string" || !BLAKE3.test(grant.receiptDigest)) return deny("malformed")
  if (typeof grant.receiptID !== "string" || !RECEIPT_REF.test(grant.receiptID)) return deny("malformed")

  if (binding.operation === "revoke") {
    if (positiveVersion(grant.revokedVersion) !== binding.expectedVersion) return deny("denied")
    const revocation = exactRecord(response.revocation, REVOCATION_FIELDS)
    if (revocation.schemaVersion !== 1) return deny("malformed")
    if (revocation.secretRef !== grant.secretRef) return deny("denied")
    if (positiveVersion(revocation.revokedVersion) !== binding.expectedVersion) return deny("denied")
    if (!positiveTimestamp(revocation.revokedAtUnixMs)) return deny("malformed")
    if (revocation.receiptID !== grant.receiptID) return deny("denied")
  } else if (grant.revokedVersion !== null) {
    return deny("denied")
  }

  // The final gate re-checks the exact expected-key set for this binding, so the
  // projected grant can only ever carry the fields Core already authorized.
  const projected = exactMutationGrant(
    {
      grantRef: grant.grantID,
      principalRef: binding.principalRef,
      providerId: binding.providerId,
      operation: binding.operation,
      ...(binding.expectedVersion === undefined ? {} : { expectedVersion: binding.expectedVersion }),
      idempotencyKey: binding.idempotencyKey,
      ...(binding.secretRef === undefined ? {} : { secretRef: binding.secretRef }),
    },
    binding,
  )
  if (!projected) return deny("malformed")
  return projected
}

export function makeCredentialMutationAuthorizer(rpc: CredentialMutationRpc): CredentialMutationAuthorizer {
  return {
    async authorize(binding, principal) {
      const principalRef = principalRefOf(principal)
      if (!principalRef || binding.principalRef !== principalRef) return deny("denied")
      if (!WIRE_ID.test(binding.providerId) || !WIRE_ID.test(binding.idempotencyKey)) return deny("malformed")
      if (binding.secretRef !== undefined && !WIRE_ID.test(binding.secretRef)) return deny("malformed")
      // A rotation or revocation without an exact target ref can never be granted.
      if (binding.operation !== "put" && binding.secretRef === undefined) return deny("malformed")
      if (
        binding.expectedVersion !== undefined &&
        (!Number.isSafeInteger(binding.expectedVersion) || binding.expectedVersion <= 0)
      ) {
        return deny("malformed")
      }
      // Strict body: providerId, idempotencyKey, and only the optional
      // secretRef/expectedVersion the exact intent already carries. No identity,
      // no label, no extra field.
      const body = Object.freeze({
        providerId: binding.providerId,
        idempotencyKey: binding.idempotencyKey,
        ...(binding.secretRef === undefined ? {} : { secretRef: binding.secretRef }),
        ...(binding.expectedVersion === undefined ? {} : { expectedVersion: binding.expectedVersion }),
      })
      let response: unknown
      try {
        response = await rpc(SECRET_MUTATION_SERVICE_ID, HOST_OPERATION[binding.operation], body, principal)
      } catch (error) {
        return deny(hostDenialCode(error))
      }
      return decodeGrant(response, binding)
    },
  }
}
