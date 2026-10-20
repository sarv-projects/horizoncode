import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SecretBrokerV1 } from "../src/secret-broker-v1"

const timestamp = "2026-10-18T17:00:00.000Z"
const ref = Schema.decodeUnknownSync(SecretBrokerV1.SecretRef)("secret_01")
const leaseId = Schema.decodeUnknownSync(SecretBrokerV1.SecretUseLeaseId)("secret_lease_01")
const operationDigest = Schema.decodeUnknownSync(SecretBrokerV1.SecretOperationDigest)(`sha256:${"a".repeat(64)}`)

describe("SecretBroker V1 contracts", () => {
  test("decodes only bounded non-secret metadata records", () => {
    const metadata = {
      schemaVersion: 1,
      secretRef: ref,
      providerId: "example-provider",
      label: "Example API",
      status: "AVAILABLE",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)(metadata, { onExcessProperty: "error" })).toEqual(metadata)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({ ...metadata, key: "raw-secret" }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({ ...metadata, status: "CONNECTED" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({ ...metadata, version: 0 })).toThrow()
  })

  test("put request carries only a one-use secure input handle", () => {
    const request = {
      schemaVersion: 1,
      providerId: "example-provider",
      secureInputHandle: "input_01",
      label: "Example API",
      idempotencyKey: "put_01",
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)(request, { onExcessProperty: "error" })).toEqual(request)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)({ ...request, key: "raw-secret" }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)({ ...request, expectedVersion: 0 })).toThrow()
  })

  test("rotation binds an existing SecretRef and expected version as an inseparable pair", () => {
    const create = {
      schemaVersion: 1,
      providerId: "example-provider",
      secureInputHandle: "input_01",
      idempotencyKey: "put_01",
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)(create, { onExcessProperty: "error" })).toEqual(create)
    const rotation = { ...create, secretRef: ref, expectedVersion: 3 }
    expect(Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)(rotation, { onExcessProperty: "error" })).toEqual(rotation)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)({ ...create, expectedVersion: 3 })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.PutRequestV1)({ ...create, secretRef: ref })).toThrow()
  })

  test("use request is bounded and cannot assert its authenticated requester", () => {
    const request = {
      schemaVersion: 1,
      secretRef: ref,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      expiresAt: timestamp,
      maxRequests: 1,
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.UseRequestV1)(request, { onExcessProperty: "error" })).toEqual(request)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.UseRequestV1)({ ...request, requesterRef: "forged" }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.UseRequestV1)({ ...request, maxRequests: 2 })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.UseRequestV1)({ ...request, operationDigest: "not-a-digest" })).toThrow()
  })

  test("lease and revocation records contain provenance but never secret bytes or store locators", () => {
    const lease = {
      schemaVersion: 1,
      leaseId,
      secretRef: ref,
      secretVersion: 1,
      requesterRef: "principal_01",
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      state: "ISSUED",
      issuedAt: timestamp,
      expiresAt: timestamp,
      maxRequests: 1,
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.UseLeaseV1)(lease, { onExcessProperty: "error" })).toEqual(lease)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.UseLeaseV1)({ ...lease, credential: "raw-secret" }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.UseLeaseV1)({ ...lease, state: "AVAILABLE" })).toThrow()

    const revoked = {
      schemaVersion: 1,
      secretRef: ref,
      revokedVersion: 2,
      revokedAt: timestamp,
      receiptId: "receipt_01",
    } as const
    expect(Schema.decodeUnknownSync(SecretBrokerV1.RevocationReceiptV1)(revoked, { onExcessProperty: "error" })).toEqual(revoked)
    expect(() => Schema.decodeUnknownSync(SecretBrokerV1.RevocationReceiptV1)({ ...revoked, storePath: "/private" }, { onExcessProperty: "error" })).toThrow()
  })

  test("exports the canonical wire contract as Draft 2020-12 JSON Schema", async () => {
    const document = SecretBrokerV1.jsonSchemaDocument()
    const put = document.$defs["Horizon.SecretBrokerV1.SecretPutRequestV1"] as {
      type: string
      additionalProperties: boolean
      properties: Record<string, unknown>
    }
    expect(document.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(put).toMatchObject({ type: "object", additionalProperties: false })
    expect(put.properties).toHaveProperty("secureInputHandle")
    expect(put.properties).not.toHaveProperty("secretBytes")
    const generated = await Bun.file("src/secret-broker-v1.schema.json").json()
    expect(generated).toEqual(document)
  })
})
