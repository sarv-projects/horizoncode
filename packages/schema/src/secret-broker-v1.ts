/** Browser-safe SecretBroker records. Secret bytes are never represented by these schemas. */

export * as SecretBrokerV1 from "./secret-broker-v1"

import { Schema } from "effect"
import * as Composition from "./composition-v1"
import { optional } from "./schema"

const Identifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
const Label = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256))
const Revision = Schema.Int.check(Schema.isGreaterThan(0))
const Destination = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2048)).check(
  Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/),
)

export const SecretRef = Identifier.pipe(Schema.brand("Horizon.SecretBrokerV1.SecretRef"))
export type SecretRef = typeof SecretRef.Type

export const SecretUseLeaseId = Identifier.pipe(Schema.brand("Horizon.SecretBrokerV1.SecretUseLeaseId"))
export type SecretUseLeaseId = typeof SecretUseLeaseId.Type

export const SecretOperationDigest = Schema.String
  .check(Schema.isPattern(/^(?:sha256|blake3):[0-9a-f]{64}$/))
  .pipe(Schema.brand("Horizon.SecretBrokerV1.SecretOperationDigest"))
export type SecretOperationDigest = typeof SecretOperationDigest.Type

export const SecretStatusV1 = Schema.Literals(["AVAILABLE", "NEEDS_AUTH", "REVOKED", "UNAVAILABLE"])
export type SecretStatusV1 = typeof SecretStatusV1.Type

export const SecretUseLeaseStateV1 = Schema.Literals(["ISSUED", "CONSUMED", "EXPIRED", "REVOKED"])
export type SecretUseLeaseStateV1 = typeof SecretUseLeaseStateV1.Type

export const MetadataV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  secretRef: SecretRef,
  providerId: Identifier,
  label: optional(Label),
  status: SecretStatusV1,
  version: Revision,
  createdAt: Composition.Timestamp,
  updatedAt: Composition.Timestamp,
}).annotate({ identifier: "Horizon.SecretBrokerV1.SecretMetadataV1" })
export type MetadataV1 = typeof MetadataV1.Type

export const PutRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providerId: Identifier,
  secureInputHandle: Identifier,
  secretRef: optional(SecretRef),
  label: optional(Label),
  idempotencyKey: Identifier,
  expectedVersion: optional(Revision),
})
  .check(
    Schema.makeFilter((request) =>
      (request.secretRef === undefined) === (request.expectedVersion === undefined)
        ? undefined
        : "secretRef and expectedVersion must be supplied together for rotation",
    ),
  )
  .annotate({ identifier: "Horizon.SecretBrokerV1.SecretPutRequestV1" })
export type PutRequestV1 = typeof PutRequestV1.Type

export const UseRequestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  secretRef: SecretRef,
  providerId: Identifier,
  operationDigest: SecretOperationDigest,
  destination: Destination,
  purpose: Schema.Literals(["PROVIDER_REQUEST", "MCP_OPERATION"]),
  runRef: optional(Identifier),
  profileRef: optional(Identifier),
  expiresAt: Composition.Timestamp,
  maxRequests: Schema.Literal(1),
}).annotate({ identifier: "Horizon.SecretBrokerV1.SecretUseRequestV1" })
export type UseRequestV1 = typeof UseRequestV1.Type

export const UseLeaseV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  leaseId: SecretUseLeaseId,
  secretRef: SecretRef,
  secretVersion: Revision,
  requesterRef: Identifier,
  providerId: Identifier,
  operationDigest: SecretOperationDigest,
  destination: Destination,
  purpose: Schema.Literals(["PROVIDER_REQUEST", "MCP_OPERATION"]),
  runRef: optional(Identifier),
  profileRef: optional(Identifier),
  state: SecretUseLeaseStateV1,
  issuedAt: Composition.Timestamp,
  expiresAt: Composition.Timestamp,
  maxRequests: Schema.Literal(1),
}).annotate({ identifier: "Horizon.SecretBrokerV1.SecretUseLeaseV1" })
export type UseLeaseV1 = typeof UseLeaseV1.Type

export const RevocationReceiptV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  secretRef: SecretRef,
  revokedVersion: Revision,
  revokedAt: Composition.Timestamp,
  receiptId: Identifier,
}).annotate({ identifier: "Horizon.SecretBrokerV1.SecretRevocationReceiptV1" })
export type RevocationReceiptV1 = typeof RevocationReceiptV1.Type

export const jsonSchemaDocument = () => {
  const contracts = [MetadataV1, PutRequestV1, UseRequestV1, UseLeaseV1, RevocationReceiptV1]
  const definitions = Object.assign(
    {},
    ...contracts.map((schema) => Schema.toJsonSchemaDocument(schema).definitions),
  )
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://horizoncode.dev/contracts/secret-broker-v1.schema.json",
    title: "SecretBroker credential records V1",
    $defs: definitions,
  }
}
