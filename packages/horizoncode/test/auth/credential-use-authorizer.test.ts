import { describe, expect, test } from "bun:test"
import type { TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import type { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import {
  CredentialUseDenied,
  makeCredentialUseAuthorizer,
  providerOperationDigest,
  type CredentialUseRpc,
} from "../../src/auth/credential-use-authorizer"

const PRINCIPAL: TrustedPrincipal = { kind: "server_auth", subject: "alice" }
const NOW = 1_798_000_000_000
const SECRET_REF = "secret_openrouter_1" as SecretBrokerV1.SecretRef
const DESTINATION = "https://openrouter.ai/api/v1/chat/completions"
const PROVIDER_REQUEST_DIGEST = `sha256:${"a".repeat(64)}`
const DIGEST = providerOperationDigest(PROVIDER_REQUEST_DIGEST)
const RECEIPT_DIGEST = `blake3:${"c".repeat(64)}`
const LEASE_ID = "secret_lease_0123456789012345678901234567890123456789"

function authorizeResponse(overrides: {
  lease?: Record<string, unknown>
  receipt?: Record<string, unknown>
  status?: string
} = {}) {
  const expiresAtUnixMs = NOW + 15_000
  const lease = {
    schemaVersion: 1,
    leaseId: LEASE_ID,
    secretRef: SECRET_REF,
    secretVersion: "3",
    providerId: "openrouter",
    operationDigest: DIGEST,
    destination: DESTINATION,
    purpose: "PROVIDER_REQUEST",
    state: "ISSUED",
    issuedAt: NOW,
    expiresAt: expiresAtUnixMs,
    maxRequests: 1,
    ...overrides.lease,
  }
  const receipt = {
    schemaVersion: 1,
    receiptID: `secret_use_receipt_${"c".repeat(64)}`,
    receiptDigest: RECEIPT_DIGEST,
    leaseID: LEASE_ID,
    secretRef: SECRET_REF,
    secretVersion: "3",
    providerId: "openrouter",
    operationDigest: DIGEST,
    destination: DESTINATION,
    purpose: "PROVIDER_REQUEST",
    expiresAtUnixMs,
    committedAtUnixMs: NOW,
    ...overrides.receipt,
  }
  return { status: overrides.status ?? "COMMITTED", lease, receipt }
}

function redemptionResponse(overrides: { redemption?: Record<string, unknown>; status?: string } = {}) {
  return {
    status: overrides.status ?? "CONSUMED",
    redemption: {
      schemaVersion: 1,
      leaseID: LEASE_ID,
      secretRef: SECRET_REF,
      secretVersion: "3",
      providerId: "openrouter",
      operationDigest: DIGEST,
      destination: DESTINATION,
      purpose: "PROVIDER_REQUEST",
      state: "CONSUMED",
      redeemedAt: NOW + 1,
      maxRequests: 1,
      leaseReceiptDigest: RECEIPT_DIGEST,
      redemptionDigest: `blake3:${"d".repeat(64)}`,
      ...overrides.redemption,
    },
  }
}

const input = {
  secretRef: SECRET_REF,
  providerId: "openrouter",
  modelId: "nvidia/nemotron-3.5-super-vl:free",
  destination: DESTINATION,
  providerRequestDigest: PROVIDER_REQUEST_DIGEST,
  purpose: "PROVIDER_REQUEST" as const,
}

describe("HostKernel one-use provider credential authorization", () => {
  test("derives a deterministic, domain-separated kernel operation digest from the exact provider digest", () => {
    const first = providerOperationDigest(PROVIDER_REQUEST_DIGEST)
    expect(first).toMatch(/^blake3:[a-f0-9]{64}$/)
    expect(providerOperationDigest(PROVIDER_REQUEST_DIGEST)).toBe(first)
    expect(first).not.toBe(PROVIDER_REQUEST_DIGEST)
    expect(providerOperationDigest(`sha256:${"e".repeat(64)}`)).not.toBe(first)
    expect(() => providerOperationDigest("sha256:bad")).toThrow(CredentialUseDenied)
  })

  test("authorizes the fixed free route and redeems its exact host lease once", async () => {
    const calls: { operation: string; body: Readonly<Record<string, unknown>>; principal: TrustedPrincipal }[] = []
    const rpc: CredentialUseRpc = async (_service, operation, body, principal) => {
      calls.push({ operation, body, principal })
      return operation === "authorize_use" ? authorizeResponse() : redemptionResponse()
    }
    const authorizer = makeCredentialUseAuthorizer(rpc, { now: () => NOW, id: () => "test-use-key" })

    const grant = await authorizer.authorize(input, PRINCIPAL)
    expect(grant.secretRef).toBe(SECRET_REF)
    expect(grant.secretVersion).toBe(3)
    expect(grant.providerRequestDigest).toBe(PROVIDER_REQUEST_DIGEST)
    expect(grant.operationDigest).toBe(providerOperationDigest(PROVIDER_REQUEST_DIGEST))
    expect(grant.destination).toBe(DESTINATION)
    expect(grant.expiresAtUnixMs).toBe(NOW + 15_000)
    expect(calls[0]?.operation).toBe("authorize_use")
    expect(calls[0]?.body).toEqual({
      secretRef: SECRET_REF,
      providerId: "openrouter",
      destination: DESTINATION,
      operationDigest: grant.operationDigest,
      purpose: "PROVIDER_REQUEST",
      idempotencyKey: "test-use-key",
      ttlMs: 15_000,
    })
    expect(calls[0]?.body).not.toHaveProperty("credentialBytes")
    expect(calls[0]?.body).not.toHaveProperty("providerRequestDigest")
    expect(calls[0]?.principal).toBe(PRINCIPAL)

    await authorizer.redeem(grant, PRINCIPAL)
    expect(calls[1]?.operation).toBe("redeem_use")
    expect(calls[1]?.body).toEqual({
      leaseId: LEASE_ID,
      idempotencyKey: `${LEASE_ID}_redeem`,
    })
    await expect(authorizer.redeem(grant, PRINCIPAL)).rejects.toBeInstanceOf(CredentialUseDenied)
    expect(calls.filter((call) => call.operation === "redeem_use")).toHaveLength(1)
  })

  test("refuses altered HostKernel route, expiry, or receipt projections", async () => {
    for (const response of [
      authorizeResponse({ lease: { destination: "https://attacker.invalid/" } }),
      authorizeResponse({ lease: { operationDigest: `blake3:${"f".repeat(64)}` } }),
      authorizeResponse({ receipt: { purpose: "MCP_OPERATION" } }),
      authorizeResponse({ lease: { expiresAt: NOW + 120_001 } }),
      authorizeResponse({ lease: { unexpected: true } }),
    ]) {
      const authorizer = makeCredentialUseAuthorizer(async () => response, {
        now: () => NOW,
        id: () => "test-use-key",
      })
      await expect(authorizer.authorize(input, PRINCIPAL)).rejects.toBeInstanceOf(CredentialUseDenied)
    }
  })

  test("refuses any provider or model outside the sole approved free route before RPC", async () => {
    let calls = 0
    const authorizer = makeCredentialUseAuthorizer(async () => {
      calls++
      return authorizeResponse()
    }, { now: () => NOW, id: () => "test-use-key" })
    await expect(authorizer.authorize({ ...input, modelId: "openai/gpt-5-paid" }, PRINCIPAL)).rejects.toBeInstanceOf(
      CredentialUseDenied,
    )
    await expect(authorizer.authorize({ ...input, providerId: "anthropic" }, PRINCIPAL)).rejects.toBeInstanceOf(
      CredentialUseDenied,
    )
    await expect(authorizer.authorize({ ...input, destination: "https://openrouter.ai.evil.invalid/api/v1/chat/completions" }, PRINCIPAL))
      .rejects.toBeInstanceOf(CredentialUseDenied)
    expect(calls).toBe(0)
  })

  test("accepts HostKernel u64 timestamps decoded as bigint", async () => {
    const asBigInt = (value: Record<string, unknown>, keys: readonly string[]) => {
      for (const key of keys) value[key] = BigInt(value[key] as number)
      return value
    }
    const authorize = authorizeResponse()
    asBigInt(authorize.lease, ["issuedAt", "expiresAt"])
    asBigInt(authorize.receipt, ["expiresAtUnixMs", "committedAtUnixMs"])
    const redemption = redemptionResponse()
    asBigInt(redemption.redemption, ["redeemedAt"])
    const authorizer = makeCredentialUseAuthorizer(
      async (_service, operation) => (operation === "authorize_use" ? authorize : redemption),
      { now: () => NOW, id: () => "test-use-key" },
    )
    const grant = await authorizer.authorize(input, PRINCIPAL)
    expect(grant.expiresAtUnixMs).toBe(NOW + 15_000)
    await authorizer.redeem(grant, PRINCIPAL)
  })

  test("fails closed when HostKernel redemption does not match the issued lease", async () => {
    const authorizer = makeCredentialUseAuthorizer(async (_service, operation) =>
      operation === "authorize_use" ? authorizeResponse() : redemptionResponse({ redemption: { secretRef: "secret_other" } }),
    { now: () => NOW, id: () => "test-use-key" })
    const grant = await authorizer.authorize(input, PRINCIPAL)
    await expect(authorizer.redeem(grant, PRINCIPAL)).rejects.toBeInstanceOf(CredentialUseDenied)
    await expect(authorizer.redeem(grant, PRINCIPAL)).rejects.toBeInstanceOf(CredentialUseDenied)
  })
})
