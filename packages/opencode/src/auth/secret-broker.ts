import { Schema } from "effect"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import type { SecureInputBinding } from "./secure-input"

const MAX_SECRET_BYTES = 16 * 1024

export type TrustedSecretUseContext = {
  requesterRef: string
  providerId: string
  operationDigest: SecretBrokerV1.SecretOperationDigest
  destination: string
  purpose: SecretBrokerV1.UseRequestV1["purpose"]
  maxExpiresAt: string
  runRef?: string
  profileRef?: string
}

/**
 * The store owns atomicity and durability. `put` must commit idempotencyKey and
 * the expected-version check in the same transaction as the secret metadata;
 * `putLease` must compare the still-current secret version atomically; and
 * `revoke` must revoke outstanding ISSUED leases atomically with versioning.
 * Implementations must copy/persist `bytes` before resolving and must never
 * retain the caller's buffer.
 */
export interface SecretBrokerStore {
  put(
    metadata: SecretBrokerV1.MetadataV1,
    bytes: Uint8Array,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<SecretBrokerV1.MetadataV1>
  describe(secretRef: SecretBrokerV1.SecretRef): Promise<SecretBrokerV1.MetadataV1 | undefined>
  /** Metadata-only bounded lookup used by trusted provider-route projections. */
  listByProviderIds(providerIds: readonly string[]): Promise<readonly SecretBrokerV1.MetadataV1[]>
  /**
   * Atomically verifies the exact ISSUED lease and current secret version,
   * commits ISSUED -> CONSUMED, then returns a fresh byte copy. Implementations
   * must never return bytes if the lease is stale, expired, revoked, reused, or
   * does not match the persisted lease record.
   */
  withConsumedLease<Value>(
    lease: SecretBrokerV1.UseLeaseV1,
    consumedAt: string,
    use: (metadata: SecretBrokerV1.MetadataV1, bytes: Uint8Array) => Promise<Value>,
  ): Promise<Value | undefined>
  revoke(
    secretRef: SecretBrokerV1.SecretRef,
    expectedVersion: number,
    nextVersion: number,
    receipt: SecretBrokerV1.RevocationReceiptV1,
  ): Promise<boolean>
  putLease(lease: SecretBrokerV1.UseLeaseV1, expectedSecretVersion: number): Promise<void>
}

export interface SecureInputHandleConsumer {
  /** Consumes and invalidates the handle even when the caller later fails. */
  consume(handle: string, binding?: SecureInputBinding): Promise<Uint8Array>
}

export class SecretBrokerError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "UNAVAILABLE" | "CONFLICT" | "EXPIRED", message: string) {
    super(message)
    this.name = "SecretBrokerError"
  }
}

const decode = <S extends Schema.Decoder<unknown>>(schema: S): ((input: unknown) => S["Type"]) => {
  const decodeUnknown = Schema.decodeUnknownSync(schema)
  return (input) => {
    try {
      return decodeUnknown(input)
    } catch {
      throw new SecretBrokerError("INVALID_REQUEST", "SecretBroker request is invalid")
    }
  }
}

const decodePut = decode(SecretBrokerV1.PutRequestV1)
const decodeUse = decode(SecretBrokerV1.UseRequestV1)
const decodeMetadata = decode(SecretBrokerV1.MetadataV1)
const decodeLease = decode(SecretBrokerV1.UseLeaseV1)

const iso = (value: string) => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SecretBrokerError("INVALID_REQUEST", "SecretBroker timestamp is invalid")
  }
  return timestamp
}

export function createSecretBroker(options: {
  store: SecretBrokerStore
  secureInput: SecureInputHandleConsumer
  now?: () => Date
  id?: (kind: "secret" | "lease" | "receipt") => string
}) {
  const now = options.now ?? (() => new Date())
  const id = options.id ?? ((kind) => `${kind}_${crypto.randomUUID()}`)

  return {
    async put(input: SecretBrokerV1.PutRequestV1, binding?: SecureInputBinding): Promise<SecretBrokerV1.MetadataV1> {
      const request = decodePut(input)
      let bytes: Uint8Array
      try {
        const consumed = await options.secureInput.consume(request.secureInputHandle, binding)
        if (!(consumed instanceof Uint8Array)) {
          throw new SecretBrokerError("INVALID_REQUEST", "Secure input returned an invalid payload")
        }
        bytes = consumed
      } catch {
        throw new SecretBrokerError("UNAVAILABLE", "Secure input handle is unavailable or already consumed")
      }
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SECRET_BYTES) {
          throw new SecretBrokerError("INVALID_REQUEST", "Credential size is outside the supported bound")
        }
        const prior = request.secretRef === undefined ? undefined : await this.describe(request.secretRef)
        if (request.secretRef !== undefined && (
          !prior ||
          prior.status !== "AVAILABLE" ||
          prior.providerId !== request.providerId ||
          prior.version !== request.expectedVersion
        )) {
          throw new SecretBrokerError("CONFLICT", "Secret changed before rotation")
        }
        const at = now().toISOString()
        const metadata = decodeMetadata({
          schemaVersion: 1,
          secretRef: prior?.secretRef ?? id("secret"),
          providerId: request.providerId,
          ...((request.label ?? prior?.label) === undefined ? {} : { label: request.label ?? prior?.label }),
          status: "AVAILABLE",
          version: prior ? prior.version + 1 : 1,
          createdAt: prior?.createdAt ?? at,
          updatedAt: at,
        })
        try {
          // The durable store returns its canonical prior metadata for an
          // idempotent replay, or rejects a conflicting reuse of the key. A
          // rotation's expected version is checked again atomically by store.
          return decodeMetadata(await options.store.put(metadata, bytes, request.idempotencyKey, request.expectedVersion))
        } catch {
          // The write may have crossed an uncertain durable boundary. Callers
          // must re-read metadata rather than treating this as a known conflict.
          throw new SecretBrokerError("UNAVAILABLE", "Secret could not be committed; re-read its status")
        }
      } finally {
        bytes.fill(0)
      }
    },

    async describe(secretRef: SecretBrokerV1.SecretRef): Promise<SecretBrokerV1.MetadataV1> {
      const reference = decode(SecretBrokerV1.SecretRef)(secretRef)
      let metadata: SecretBrokerV1.MetadataV1 | undefined
      try {
        metadata = await options.store.describe(reference)
      } catch {
        throw new SecretBrokerError("UNAVAILABLE", "Secret metadata is unavailable")
      }
      if (!metadata) throw new SecretBrokerError("UNAVAILABLE", "Secret reference is unavailable")
      return decodeMetadata(metadata)
    },

    async listByProviderIds(providerIds: readonly string[]): Promise<readonly SecretBrokerV1.MetadataV1[]> {
      if (!Array.isArray(providerIds) || providerIds.length > 16 || providerIds.some((value) =>
        typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value),
      )) {
        throw new SecretBrokerError("INVALID_REQUEST", "Provider credential lookup is invalid")
      }
      let records: readonly SecretBrokerV1.MetadataV1[]
      try {
        records = await options.store.listByProviderIds([...new Set(providerIds)])
      } catch {
        throw new SecretBrokerError("UNAVAILABLE", "Provider credential metadata is unavailable")
      }
      if (!Array.isArray(records) || records.length > 256) {
        throw new SecretBrokerError("UNAVAILABLE", "Provider credential metadata is invalid")
      }
      const allowed = new Set(providerIds)
      return records.map(decodeMetadata).filter((metadata) =>
        allowed.has(metadata.providerId) && metadata.status === "AVAILABLE",
      )
    },

    async authorizeUse(
      input: SecretBrokerV1.UseRequestV1,
      trusted: TrustedSecretUseContext,
    ): Promise<SecretBrokerV1.UseLeaseV1> {
      const request = decodeUse(input)
      const trustedRequester = decode(SecretBrokerV1.SecretRef)(trusted.requesterRef)
      const nowDate = now()
      const nowMs = nowDate.getTime()
      const expiresMs = iso(request.expiresAt)
      const maxExpiresMs = iso(trusted.maxExpiresAt)
      if (expiresMs <= nowMs || expiresMs > maxExpiresMs) {
        throw new SecretBrokerError("EXPIRED", "Secret use lease expiry is outside the authorized window")
      }
      if (
        request.providerId !== trusted.providerId ||
        request.operationDigest !== trusted.operationDigest ||
        request.destination !== trusted.destination ||
        request.purpose !== trusted.purpose ||
        request.runRef !== trusted.runRef ||
        request.profileRef !== trusted.profileRef
      ) {
        throw new SecretBrokerError("INVALID_REQUEST", "Secret use request does not match trusted authorization")
      }
      const metadata = await this.describe(request.secretRef)
      if (metadata.status !== "AVAILABLE" || metadata.providerId !== request.providerId) {
        throw new SecretBrokerError("UNAVAILABLE", "Secret is not available for the requested provider")
      }
      const lease = decodeLease({
        schemaVersion: 1,
        leaseId: id("lease"),
        secretRef: metadata.secretRef,
        secretVersion: metadata.version,
        requesterRef: trustedRequester,
        providerId: request.providerId,
        operationDigest: request.operationDigest,
        destination: request.destination,
        purpose: request.purpose,
        ...(trusted.runRef === undefined ? {} : { runRef: trusted.runRef }),
        ...(trusted.profileRef === undefined ? {} : { profileRef: trusted.profileRef }),
        state: "ISSUED",
        issuedAt: nowDate.toISOString(),
        expiresAt: request.expiresAt,
        maxRequests: 1,
      })
      try {
        await options.store.putLease(lease, metadata.version)
      } catch {
        throw new SecretBrokerError("CONFLICT", "Secret use lease could not be committed")
      }
      return lease
    },

    async withUse<Value>(
      input: SecretBrokerV1.UseLeaseV1,
      trusted: TrustedSecretUseContext,
      use: (bytes: Uint8Array) => Promise<Value>,
    ): Promise<Value> {
      const lease = decodeLease(input)
      const nowDate = now()
      const nowMs = nowDate.getTime()
      const maxExpiresMs = iso(trusted.maxExpiresAt)
      const expiresMs = iso(lease.expiresAt)
      if (expiresMs <= nowMs || expiresMs > maxExpiresMs) {
        throw new SecretBrokerError("EXPIRED", "Secret use lease is expired or outside the authorized window")
      }
      if (
        lease.state !== "ISSUED" ||
        lease.requesterRef !== trusted.requesterRef ||
        lease.providerId !== trusted.providerId ||
        lease.operationDigest !== trusted.operationDigest ||
        lease.destination !== trusted.destination ||
        lease.purpose !== trusted.purpose ||
        lease.runRef !== trusted.runRef ||
        lease.profileRef !== trusted.profileRef ||
        lease.maxRequests !== 1
      ) {
        throw new SecretBrokerError("INVALID_REQUEST", "Secret use lease does not match trusted authorization")
      }

      let used: Value | undefined
      let entered = false
      try {
        used = await options.store.withConsumedLease(lease, nowDate.toISOString(), async (source, bytes) => {
          entered = true
          try {
            const metadata = decodeMetadata(source)
            if (
              metadata.secretRef !== lease.secretRef ||
              metadata.providerId !== lease.providerId ||
              metadata.status !== "AVAILABLE" ||
              metadata.version !== lease.secretVersion ||
              !(bytes instanceof Uint8Array) ||
              bytes.byteLength === 0 ||
              bytes.byteLength > MAX_SECRET_BYTES
            ) {
              throw new SecretBrokerError("UNAVAILABLE", "Secret is unavailable for this use lease")
            }
            return await use(bytes)
          } finally {
            if (bytes instanceof Uint8Array) bytes.fill(0)
          }
        })
      } catch {
        throw new SecretBrokerError("UNAVAILABLE", "Secret use lease could not be consumed")
      }
      if (!entered) throw new SecretBrokerError("CONFLICT", "Secret use lease is stale, revoked, or already consumed")
      return used as Value
    },

    async revoke(
      secretRef: SecretBrokerV1.SecretRef,
      expectedVersion?: number,
    ): Promise<SecretBrokerV1.RevocationReceiptV1> {
      const metadata = await this.describe(secretRef)
      if (expectedVersion !== undefined && metadata.version !== expectedVersion) {
        throw new SecretBrokerError("CONFLICT", "Secret version changed before revocation")
      }
      const revokedAt = now().toISOString()
      const receipt = decode(SecretBrokerV1.RevocationReceiptV1)({
        schemaVersion: 1,
        secretRef: metadata.secretRef,
        revokedVersion: metadata.version + 1,
        revokedAt,
        receiptId: id("receipt"),
      })
      try {
        if (!(await options.store.revoke(metadata.secretRef, metadata.version, receipt.revokedVersion, receipt))) {
          throw new SecretBrokerError("CONFLICT", "Secret version changed before revocation")
        }
      } catch (error) {
        if (error instanceof SecretBrokerError) throw error
        throw new SecretBrokerError("UNAVAILABLE", "Secret revocation could not be committed")
      }
      return receipt
    },
  }
}
