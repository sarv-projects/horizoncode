import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import type { TrustedSecretUseContext } from "./secret-broker"
import { principalRefOf } from "./secret-mutation"

export const SECRET_USE_SERVICE_ID = "secret.v1"
export const DIRECT_FREE_PROVIDER_ID = "openrouter"
export const DIRECT_FREE_MODEL_ID = "nvidia/nemotron-3.5-super-vl:free"
export const DIRECT_FREE_DESTINATION = "https://openrouter.ai/api/v1/chat/completions"
const LEASE_TTL_MS = 15_000
const WIRE_ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const BLAKE3 = /^blake3:[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/

type Digest = SecretBrokerV1.SecretOperationDigest

export type CredentialUseAuthorizationInput = {
  readonly secretRef: SecretBrokerV1.SecretRef
  readonly providerId: string
  readonly modelId: string
  readonly destination: string
  readonly providerRequestDigest: string
  readonly purpose: "PROVIDER_REQUEST"
}

export type ProviderCredentialUseGrantV1 = {
  readonly leaseId: string
  readonly secretRef: SecretBrokerV1.SecretRef
  readonly secretVersion: number
  readonly providerId: typeof DIRECT_FREE_PROVIDER_ID
  readonly modelId: typeof DIRECT_FREE_MODEL_ID
  readonly providerRequestDigest: string
  readonly operationDigest: Digest
  readonly destination: typeof DIRECT_FREE_DESTINATION
  readonly purpose: "PROVIDER_REQUEST"
  readonly expiresAtUnixMs: number
  readonly trusted: TrustedSecretUseContext
}

export type CredentialUseRpc = (
  serviceID: string,
  operation: "authorize_use" | "redeem_use",
  body: Readonly<Record<string, unknown>>,
  principal: TrustedPrincipal,
) => Promise<unknown>

export type CredentialUseDenialCode = "denied" | "conflict" | "unavailable" | "unknown" | "malformed" | "transport"

export class CredentialUseDenied extends Error {
  constructor(readonly code: CredentialUseDenialCode) {
    super(`HostKernel provider credential use authorization is ${code}`)
    this.name = "CredentialUseDenied"
  }
}

const deny = (code: CredentialUseDenialCode): never => {
  throw new CredentialUseDenied(code)
}

const HOST_CODES: Readonly<Record<string, CredentialUseDenialCode>> = {
  secret_denied: "denied",
  effect_denied: "denied",
  missing_principal: "denied",
  invalid_effect_request: "malformed",
  secret_conflict: "conflict",
  secret_provider_mismatch: "conflict",
  secret_use_consumed: "conflict",
  secret_not_found: "unavailable",
  secret_revoked: "unavailable",
  secret_unavailable: "unavailable",
  expired: "conflict",
  secret_outcome_unknown: "unknown",
}

const rpcCode = (error: unknown): CredentialUseDenialCode => {
  const hostCode = typeof error === "object" && error !== null && "hostCode" in error
    ? (error as { readonly hostCode?: unknown }).hostCode
    : undefined
  return typeof hostCode === "string" ? (HOST_CODES[hostCode] ?? "unavailable") : "transport"
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return deny("malformed")
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    return deny("malformed")
  }
  return record
}

/** Domain-separated HostKernel operation digest derived from the exact SHA-256 request digest. */
export function providerOperationDigest(providerRequestDigest: string): Digest {
  if (!SHA256.test(providerRequestDigest)) return deny("malformed")
  const material = new TextEncoder().encode(`horizoncode.secret-use.provider-operation.v1\n${providerRequestDigest}`)
  return `blake3:${bytesToHex(blake3(material))}` as Digest
}

function validateBinding(input: CredentialUseAuthorizationInput): Digest {
  if (input.providerId !== DIRECT_FREE_PROVIDER_ID || input.modelId !== DIRECT_FREE_MODEL_ID ||
    input.destination !== DIRECT_FREE_DESTINATION || input.purpose !== "PROVIDER_REQUEST" ||
    !WIRE_ID.test(input.secretRef) || !SHA256.test(input.providerRequestDigest)) {
    return deny("denied")
  }
  return providerOperationDigest(input.providerRequestDigest)
}

function decodeGrant(
  value: unknown,
  input: CredentialUseAuthorizationInput,
  operationDigest: Digest,
  idempotencyKey: string,
  now: number,
): { readonly leaseId: string; readonly secretVersion: number; readonly expiresAtUnixMs: number; readonly receiptDigest: string } {
  const response = exactRecord(value, ["status", "lease", "receipt"])
  if (response.status !== "COMMITTED" && response.status !== "REPLAY") return deny("malformed")
  const lease = exactRecord(response.lease, [
    "schemaVersion", "leaseId", "secretRef", "secretVersion", "providerId", "operationDigest", "destination",
    "purpose", "state", "issuedAt", "expiresAt", "maxRequests",
  ])
  const receipt = exactRecord(response.receipt, [
    "schemaVersion", "receiptID", "receiptDigest", "leaseID", "secretRef", "secretVersion", "providerId",
    "operationDigest", "destination", "purpose", "expiresAtUnixMs", "committedAtUnixMs",
  ])
  const leaseVersion = lease.secretVersion
  const receiptVersion = receipt.secretVersion
  const leaseID = lease.leaseId
  const expiresAtValue = unsignedMs(lease.expiresAt)
  const issuedAtValue = unsignedMs(lease.issuedAt)
  const committedAtValue = unsignedMs(receipt.committedAtUnixMs)
  const receiptExpiryValue = unsignedMs(receipt.expiresAtUnixMs)
  const expiresAt = expiresAtValue ?? -1
  const issuedAt = issuedAtValue ?? -1
  const committedAt = committedAtValue ?? -1
  const receiptDigest = receipt.receiptDigest
  const nowAtDecode = Date.now()
  if (lease.schemaVersion !== 1 || typeof leaseID !== "string" || !/^secret_lease_[a-f0-9]{40}$/.test(leaseID) ||
    typeof leaseVersion !== "string" || !DECIMAL.test(leaseVersion) ||
    !Number.isSafeInteger(Number(leaseVersion)) || Number(leaseVersion) < 1 ||
    lease.secretRef !== input.secretRef || lease.providerId !== input.providerId ||
    lease.operationDigest !== operationDigest || lease.destination !== input.destination ||
    lease.purpose !== "PROVIDER_REQUEST" || lease.state !== "ISSUED" || lease.maxRequests !== 1 ||
    issuedAtValue === undefined || expiresAtValue === undefined ||
    expiresAt <= Math.max(now, nowAtDecode) ||
    expiresAt <= issuedAt || expiresAt - issuedAt > LEASE_TTL_MS ||
    receipt.schemaVersion !== 1 || typeof receipt.receiptID !== "string" || !WIRE_ID.test(receipt.receiptID) ||
    typeof receiptDigest !== "string" || !BLAKE3.test(receiptDigest) ||
    receipt.receiptID !== `secret_use_receipt_${receiptDigest.slice("blake3:".length)}` ||
    receipt.leaseID !== leaseID || receipt.secretRef !== input.secretRef || receiptVersion !== leaseVersion ||
    receipt.providerId !== input.providerId || receipt.operationDigest !== operationDigest ||
    receipt.destination !== input.destination || receipt.purpose !== "PROVIDER_REQUEST" ||
    receiptExpiryValue !== expiresAt || committedAtValue === undefined ||
    committedAt < issuedAt || committedAt > expiresAt ||
    idempotencyKey.length < 1) {
    return deny("denied")
  }
  return {
    leaseId: leaseID,
    secretVersion: Number(leaseVersion),
    expiresAtUnixMs: expiresAt,
    receiptDigest,
  }
}

function decodeRedemption(value: unknown, grant: ProviderCredentialUseGrantV1, receiptDigest: string) {
  const response = exactRecord(value, ["status", "redemption"])
  if (response.status !== "CONSUMED") return deny("malformed")
  const redemption = exactRecord(response.redemption, [
    "schemaVersion", "leaseID", "secretRef", "secretVersion", "providerId", "operationDigest", "destination",
    "purpose", "state", "redeemedAt", "maxRequests", "leaseReceiptDigest", "redemptionDigest",
  ])
  const redeemedAt = unsignedMs(redemption.redeemedAt)
  if (redemption.schemaVersion !== 1 || redemption.leaseID !== grant.leaseId ||
    redemption.secretRef !== grant.secretRef || redemption.secretVersion !== String(grant.secretVersion) ||
    redemption.providerId !== grant.providerId || redemption.operationDigest !== grant.operationDigest ||
    redemption.destination !== grant.destination || redemption.purpose !== grant.purpose || redemption.state !== "CONSUMED" ||
    redemption.maxRequests !== 1 || redemption.leaseReceiptDigest !== receiptDigest ||
    redeemedAt === undefined || redeemedAt >= grant.expiresAtUnixMs ||
    typeof redemption.redemptionDigest !== "string" || !BLAKE3.test(redemption.redemptionDigest)) {
    return deny("denied")
  }
}

type GrantState = {
  readonly receiptDigest: string
  readonly principalRef: string
}

/** Exact non-negative integer from a u64 wire field (Core decodes those as bigint). */
const unsignedMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return undefined
}

export interface CredentialUseAuthorizer {
  authorize(input: CredentialUseAuthorizationInput, principal: TrustedPrincipal): Promise<ProviderCredentialUseGrantV1>
  /** Consumes the local capability before exactly one HostKernel redemption RPC. */
  redeem(grant: ProviderCredentialUseGrantV1, principal: TrustedPrincipal): Promise<void>
}

/** HostKernel-backed, owner-scoped `secret.v1` provider-use authorizer. */
export function makeCredentialUseAuthorizer(
  rpc: CredentialUseRpc,
  options: { readonly now?: () => number; readonly id?: () => string } = {},
): CredentialUseAuthorizer {
  const now = options.now ?? Date.now
  const id = options.id ?? (() => `secret_use_${crypto.randomUUID().replaceAll("-", "")}`)
  const grants = new WeakMap<object, GrantState>()

  return {
    async authorize(input, principal) {
      const operationDigest = validateBinding(input)
      const ownerRef = principalRefOf(principal)
      if (!ownerRef) return deny("denied")
      const idempotencyKey = id()
      if (!WIRE_ID.test(idempotencyKey)) return deny("malformed")
      const issuedAt = now()
      if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return deny("malformed")
      const body = Object.freeze({
        secretRef: input.secretRef,
        providerId: input.providerId,
        destination: input.destination,
        operationDigest,
        purpose: input.purpose,
        idempotencyKey,
        ttlMs: LEASE_TTL_MS,
      })
      let raw: unknown
      try {
        raw = await rpc(SECRET_USE_SERVICE_ID, "authorize_use", body, principal)
      } catch (error) {
        return deny(rpcCode(error))
      }
      const decoded = decodeGrant(raw, input, operationDigest, idempotencyKey, issuedAt)
      const trusted: TrustedSecretUseContext = Object.freeze({
        requesterRef: ownerRef,
        providerId: input.providerId,
        operationDigest: input.providerRequestDigest as Digest,
        destination: input.destination,
        purpose: input.purpose,
        maxExpiresAt: new Date(decoded.expiresAtUnixMs).toISOString(),
      })
      const grant = Object.freeze({
        leaseId: decoded.leaseId,
        secretRef: input.secretRef,
        secretVersion: decoded.secretVersion,
        providerId: DIRECT_FREE_PROVIDER_ID,
        modelId: DIRECT_FREE_MODEL_ID,
        providerRequestDigest: input.providerRequestDigest,
        operationDigest,
        destination: DIRECT_FREE_DESTINATION,
        purpose: "PROVIDER_REQUEST" as const,
        expiresAtUnixMs: decoded.expiresAtUnixMs,
        trusted,
      })
      grants.set(grant, { receiptDigest: decoded.receiptDigest, principalRef: ownerRef })
      return grant
    },

    async redeem(grant, principal) {
      if (typeof grant !== "object" || grant === null) return deny("malformed")
      const state = grants.get(grant)
      if (!state) return deny("conflict")
      grants.delete(grant)
      if (principalRefOf(principal) !== state.principalRef) return deny("denied")
      const idempotencyKey = `${grant.leaseId}_redeem`
      if (!WIRE_ID.test(idempotencyKey)) return deny("malformed")
      let raw: unknown
      try {
        raw = await rpc(SECRET_USE_SERVICE_ID, "redeem_use", Object.freeze({
          leaseId: grant.leaseId,
          idempotencyKey,
        }), principal)
      } catch (error) {
        return deny(rpcCode(error))
      }
      decodeRedemption(raw, grant, state.receiptDigest)
    },
  }
}

export * as CredentialUseAuthorizer from "./credential-use-authorizer"
