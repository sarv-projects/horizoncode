import { describe, expect, test } from "bun:test"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { createSecretBroker, type SecretBrokerStore } from "../../src/auth/secret-broker"
import {
  dispatchProviderRequest,
  providerRequestDigest,
  type ProviderTransportRequest,
} from "../../src/auth/provider-transport"

const timestamp = "2026-10-18T17:00:00.000Z"
const operationDigest = `sha256:${"a".repeat(64)}` as SecretBrokerV1.SecretOperationDigest

function fixture() {
  const secrets = new Map<string, { metadata: SecretBrokerV1.MetadataV1; bytes: Uint8Array }>()
  const leases = new Map<string, SecretBrokerV1.UseLeaseV1>()
  const idempotency = new Map<string, { metadata: SecretBrokerV1.MetadataV1; bytes: Uint8Array }>()
  const writes: string[] = []
  const store: SecretBrokerStore = {
    async put(metadata, bytes, idempotencyKey, expectedVersion) {
      const previous = idempotency.get(idempotencyKey)
      if (previous) {
        if (!Bun.deepEquals(previous.bytes, bytes)) throw new Error("idempotency conflict")
        return previous.metadata
      }
      const existing = secrets.get(metadata.secretRef)
      if (expectedVersion === undefined ? existing !== undefined : existing?.metadata.version !== expectedVersion) {
        throw new Error("version conflict")
      }
      secrets.set(metadata.secretRef, { metadata, bytes: bytes.slice() })
      idempotency.set(idempotencyKey, { metadata, bytes: bytes.slice() })
      writes.push("put")
      return metadata
    },
    async describe(secretRef) {
      return secrets.get(secretRef)?.metadata
    },
    async revoke(secretRef, expectedVersion, next, receipt) {
      const secret = secrets.get(secretRef)
      if (!secret || secret.metadata.version !== expectedVersion) return false
      secret.metadata = { ...secret.metadata, status: "REVOKED", version: next, updatedAt: receipt.revokedAt }
      for (const [id, lease] of leases) {
        if (lease.secretRef === secretRef && lease.state === "ISSUED") leases.set(id, { ...lease, state: "REVOKED" })
      }
      writes.push("revoke")
      return true
    },
    async putLease(lease) {
      leases.set(lease.leaseId, lease)
      writes.push("lease")
    },
    async withConsumedLease(lease, _at, use) {
      const current = leases.get(lease.leaseId)
      const secret = secrets.get(lease.secretRef)
      if (
        !current ||
        current.state !== "ISSUED" ||
        !Bun.deepEquals(current, lease) ||
        !secret ||
        secret.metadata.status !== "AVAILABLE" ||
        secret.metadata.version !== lease.secretVersion
      ) return undefined
      leases.set(lease.leaseId, { ...current, state: "CONSUMED" })
      writes.push("consume")
      const bytes = secret.bytes.slice()
      try {
        return await use(secret.metadata, bytes)
      } finally {
        bytes.fill(0)
      }
    },
  }
  const inputs = new Map([
    ["handle_1", new TextEncoder().encode("test-only-secret")],
    ["handle_2", new TextEncoder().encode("rotated-test-secret")],
    ["handle_3", new TextEncoder().encode("stale-rotation")],
  ])
  const consumed = inputs.get("handle_1")!
  const broker = createSecretBroker({
    store,
    secureInput: {
      async consume(handle) {
        const bytes = inputs.get(handle)
        inputs.delete(handle)
        if (!bytes) throw new Error("secure input unavailable")
        return bytes
      },
    },
    now: () => new Date(timestamp),
    id: (kind) => `${kind}_generated`,
  })
  return { broker, secrets, leases, idempotency, inputs, consumed, writes }
}

const putRequest = {
  schemaVersion: 1,
  providerId: "example-provider",
  secureInputHandle: "handle_1",
  label: "Example API",
  idempotencyKey: "put_1",
} satisfies SecretBrokerV1.PutRequestV1

describe("SecretBroker in-process contract", () => {
  test("canonical request digests ignore ordinary header insertion order", () => {
    const request = {
      providerId: "example-provider",
      method: "POST" as const,
      destination: "https://api.example.invalid/v1/chat/completions",
      body: "{}",
      credentialHeader: { name: "authorization" as const, prefix: "Bearer " },
    }
    expect(
      providerRequestDigest({ ...request, headers: { "x-tenant": "t1", "content-type": "application/json" } }),
    ).toBe(
      providerRequestDigest({ ...request, headers: { "content-type": "application/json", "x-tenant": "t1" } }),
    )
  })

  test("binds a credential to one exact provider request and never dispatches a replay", async () => {
    const { broker } = fixture()
    const created = await broker.put(putRequest)
    const destination = "https://api.example.invalid/v1/chat/completions"
    const body = JSON.stringify({ model: "example-model", messages: [{ role: "user", content: "hello" }] })
    const digest = providerRequestDigest({
      providerId: "example-provider",
      method: "POST",
      destination,
      body,
      headers: { "content-type": "application/json" },
      credentialHeader: { name: "authorization", prefix: "Bearer " },
    })
    const useRequest = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest: digest,
      destination,
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: useRequest.providerId,
      operationDigest: digest,
      destination,
      purpose: useRequest.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(useRequest, trusted)
    let dispatched = 0
    let retainedHeaders: Record<string, string> | undefined
    const input = {
      providerId: useRequest.providerId,
      method: "POST" as const,
      destination,
      body,
      headers: { "content-type": "application/json" },
      credentialHeader: { name: "authorization" as const, prefix: "Bearer " },
    }
    const send = (request: ProviderTransportRequest) => {
      dispatched++
      retainedHeaders = request.headers
      expect(request).toEqual({
        url: destination,
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-only-secret",
        },
        signal: expect.any(AbortSignal),
        maxResponseBytes: 1024,
      })
      return Promise.resolve((async function* () { yield new TextEncoder().encode("accepted") })())
    }

    const response = await dispatchProviderRequest({
      broker,
      lease,
      trusted,
      input,
      send,
      deadlineAt: Date.now() + 10_000,
      maxResponseBytes: 1024,
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of response) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString("utf8")).toBe("accepted")
    expect(retainedHeaders).not.toHaveProperty("authorization")
    await expect(dispatchProviderRequest({
      broker,
      lease,
      trusted,
      input,
      send,
      deadlineAt: Date.now() + 10_000,
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(dispatched).toBe(1)
  })

  test("rejects changed destination, body, or method before consuming a lease", async () => {
    const { broker, writes } = fixture()
    const created = await broker.put(putRequest)
    const destination = "https://api.example.invalid/v1/chat/completions"
    const body = "{}"
    const digest = providerRequestDigest({
      providerId: "example-provider",
      method: "POST",
      destination,
      body,
      headers: { "x-tenant": "t1" },
      credentialHeader: { name: "x-api-key" as const, prefix: "" },
    })
    const useRequest = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest: digest,
      destination,
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: useRequest.providerId,
      operationDigest: digest,
      destination,
      purpose: useRequest.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(useRequest, trusted)
    const input = {
      providerId: useRequest.providerId,
      method: "POST" as const,
      destination,
      body,
      headers: { "x-tenant": "t1" },
      credentialHeader: { name: "x-api-key" as const, prefix: "" },
    }
    let dispatched = 0
    const send = async () => { dispatched++; return (async function* () {})() }
    const options = { broker, lease, trusted, input, send, deadlineAt: Date.now() + 10_000, maxResponseBytes: 1024 }
    await expect(dispatchProviderRequest({ ...options, input: { ...input, destination: "https://evil.invalid/" } })).rejects.toThrow()
    await expect(dispatchProviderRequest({ ...options, input: { ...input, body: "changed" } })).rejects.toThrow()
    await expect(dispatchProviderRequest({ ...options, input: { ...input, headers: { "x-tenant": "t2" } } })).rejects.toThrow()
    await expect(
      dispatchProviderRequest({ ...options, input: { ...input, method: "GET" } as unknown as typeof input }),
    ).rejects.toThrow()
    expect(dispatched).toBe(0)
    expect(writes).toEqual(["put", "lease"])
  })

  test("cancels an in-flight single request and bounds streamed response bytes", async () => {
    const { broker } = fixture()
    const created = await broker.put(putRequest)
    const destination = "https://api.example.invalid/v1/chat/completions"
    const body = "{}"
    const input = {
      providerId: "example-provider",
      method: "POST" as const,
      destination,
      body,
      headers: {},
      credentialHeader: { name: "authorization" as const, prefix: "Bearer " },
    }
    const digest = providerRequestDigest(input)
    const useRequest = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: useRequest.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(useRequest, trusted)
    const controller = new AbortController()
    let sends = 0
    let retained: Record<string, string> | undefined
    const pending = dispatchProviderRequest({
      broker,
      lease,
      trusted,
      input,
      signal: controller.signal,
      deadlineAt: Date.parse(timestamp) + 10_000,
      maxResponseBytes: 3,
      now: () => Date.parse(timestamp),
      send: (request) => {
        sends++
        retained = request.headers
        return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))
      },
    })
    await Bun.sleep(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(sends).toBe(1)
    expect(retained).not.toHaveProperty("authorization")

    await broker.put({
      ...putRequest,
      secureInputHandle: "handle_2",
      idempotencyKey: "put_2",
      secretRef: created.secretRef,
      expectedVersion: 1,
    })
    const secondUseRequest = { ...useRequest, secretRef: created.secretRef }
    const secondLease = await broker.authorizeUse(secondUseRequest, trusted)
    const response = await dispatchProviderRequest({
      broker,
      lease: secondLease,
      trusted,
      input,
      deadlineAt: Date.parse(timestamp) + 10_000,
      maxResponseBytes: 3,
      now: () => Date.parse(timestamp),
      send: async () => (async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4]) })(),
    })
    const collect = async () => {
      for await (const _chunk of response) {
        // Exhaust the stream so the enforced aggregate bound is exercised.
      }
    }
    await expect(collect()).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  test("deadline aborts the one in-flight provider send and removes auth headers", async () => {
    const { broker, leases } = fixture()
    const created = await broker.put(putRequest)
    const destination = "https://api.example.invalid/v1/chat/completions"
    const input = {
      providerId: "example-provider",
      method: "POST" as const,
      destination,
      body: "{}",
      headers: { "content-type": "application/json" },
      credentialHeader: { name: "authorization" as const, prefix: "Bearer " },
    }
    const digest = providerRequestDigest(input)
    const useRequest = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: useRequest.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(useRequest, trusted)
    let sent = 0
    let retained: Record<string, string> | undefined
    const pending = dispatchProviderRequest({
      broker,
      lease,
      trusted,
      input,
      deadlineAt: Date.parse(timestamp) + 5,
      maxResponseBytes: 128,
      now: () => Date.parse(timestamp),
      send: (request) => {
        sent++
        retained = request.headers
        return new Promise((_, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }),
        )
      },
    })

    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(sent).toBe(1)
    expect(leases.get(lease.leaseId)?.state).toBe("CONSUMED")
    expect(retained).not.toHaveProperty("authorization")
  })

  test("deadline interrupts a stalled response body reader", async () => {
    const { broker } = fixture()
    const created = await broker.put(putRequest)
    const destination = "https://api.example.invalid/v1/chat/completions"
    const input = {
      providerId: "example-provider",
      method: "POST" as const,
      destination,
      body: "{}",
      headers: {},
      credentialHeader: { name: "authorization" as const, prefix: "Bearer " },
    }
    const digest = providerRequestDigest(input)
    const useRequest = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: input.providerId,
      operationDigest: digest,
      destination,
      purpose: useRequest.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(useRequest, trusted)
    let sends = 0
    const response = await dispatchProviderRequest({
      broker,
      lease,
      trusted,
      input,
      deadlineAt: Date.now() + 30,
      maxResponseBytes: 128,
      send: async () => {
        sends++
        return {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }
          },
        }
      },
    })
    const consume = async () => {
      for await (const _chunk of response) {
        // The never-settling reader must still be interrupted by the deadline.
      }
    }
    const result = await Promise.race([
      consume().then(() => "resolved", () => "rejected"),
      Bun.sleep(250).then(() => "hung"),
    ])
    expect(result).toBe("rejected")
    expect(sends).toBe(1)
  })

  test("put consumes the private one-use handle, stores only OS bytes, and returns metadata", async () => {
    const { broker, secrets, inputs, consumed } = fixture()
    const result = await broker.put(putRequest)
    expect(result).toMatchObject({ secretRef: "secret_generated", providerId: "example-provider", status: "AVAILABLE", version: 1 })
    expect(inputs.has("handle_1")).toBe(false)
    expect([...consumed].every((byte) => byte === 0)).toBe(true)
    expect(secrets.get(result.secretRef)?.bytes).toEqual(new TextEncoder().encode("test-only-secret"))
    expect(JSON.stringify(result)).not.toContain("test-only-secret")
    expect(JSON.stringify(result)).not.toContain("org/freedesktop/secrets")
  })

  test("put fails before mutation when a secure handle is missing or already consumed", async () => {
    const { broker, writes } = fixture()
    await expect(broker.put({ ...putRequest, secureInputHandle: "foreign_handle" })).rejects.toThrow()
    await broker.put(putRequest)
    await expect(broker.put(putRequest)).rejects.toThrow()
    expect(writes).toEqual(["put"])
  })

  test("put idempotency returns the stable canonical metadata", async () => {
    const { broker, inputs } = fixture()
    const first = await broker.put(putRequest)
    inputs.set("handle_2", new TextEncoder().encode("test-only-secret"))
    const replay = await broker.put({ ...putRequest, secureInputHandle: "handle_2" })
    expect(replay).toEqual(first)
  })

  test("rotates a credential only at its expected version and keeps the same SecretRef", async () => {
    const { broker, inputs, secrets, writes } = fixture()
    const first = await broker.put(putRequest)
    const rotated = await broker.put({
      ...putRequest,
      secureInputHandle: "handle_2",
      idempotencyKey: "put_2",
      secretRef: first.secretRef,
      expectedVersion: first.version,
    })
    expect(rotated).toMatchObject({ secretRef: first.secretRef, providerId: first.providerId, version: 2, status: "AVAILABLE" })
    expect(rotated.createdAt).toBe(first.createdAt)
    expect(inputs.has("handle_2")).toBe(false)
    expect(secrets.get(first.secretRef)?.bytes).toEqual(new TextEncoder().encode("rotated-test-secret"))
    expect(writes).toEqual(["put", "put"])

    inputs.set("handle_3", new TextEncoder().encode("stale-rotation"))
    await expect(broker.put({
      ...putRequest,
      secureInputHandle: "handle_3",
      idempotencyKey: "put_3",
      secretRef: first.secretRef,
      expectedVersion: first.version,
    })).rejects.toThrow()
    expect(secrets.get(first.secretRef)?.metadata.version).toBe(2)
    expect(inputs.has("handle_3")).toBe(false)
    expect(writes).toEqual(["put", "put"])
  })

  test("authorize use derives requester from trusted context and rejects mismatched authority before lease write", async () => {
    const { broker, writes } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      runRef: "run_authenticated",
      profileRef: "profile_authenticated",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: "example-provider",
      operationDigest,
      destination: request.destination,
      purpose: "PROVIDER_REQUEST" as const,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
      runRef: "run_authenticated",
      profileRef: "profile_authenticated",
    }
    await expect(broker.authorizeUse({ ...request, destination: "https://evil.invalid" }, trusted)).rejects.toThrow()
    expect(writes).toEqual(["put"])
    const lease = await broker.authorizeUse(request, trusted)
    expect(lease).toMatchObject({
      requesterRef: "principal_authenticated",
      runRef: "run_authenticated",
      profileRef: "profile_authenticated",
      state: "ISSUED",
      maxRequests: 1,
    })
    expect(writes).toEqual(["put", "lease"])
  })

  test("one-use delivery commits lease before callback, zeroes bytes, and rejects replay", async () => {
    const { broker, writes, leases } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      runRef: "run_authenticated",
      profileRef: "profile_authenticated",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: request.providerId,
      operationDigest,
      destination: request.destination,
      purpose: request.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
      runRef: request.runRef,
      profileRef: request.profileRef,
    }
    const lease = await broker.authorizeUse(request, trusted)
    let delivered: Uint8Array | undefined
    await expect(broker.withUse(lease, trusted, async (bytes) => {
      delivered = bytes
      expect(leases.get(lease.leaseId)?.state).toBe("CONSUMED")
      expect(bytes).toEqual(new TextEncoder().encode("test-only-secret"))
      return "request-sent"
    })).resolves.toBe("request-sent")
    expect(delivered && [...delivered].every((byte) => byte === 0)).toBe(true)
    expect(writes).toEqual(["put", "lease", "consume"])
    await expect(broker.withUse(lease, trusted, async () => "replayed")).rejects.toMatchObject({ code: "CONFLICT" })
  })

  test("one-use delivery zeroes bytes when the provider transport fails", async () => {
    const { broker } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      runRef: "run_authenticated",
      profileRef: "profile_authenticated",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: request.providerId,
      operationDigest,
      destination: request.destination,
      purpose: request.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
      runRef: request.runRef,
      profileRef: request.profileRef,
    }
    const lease = await broker.authorizeUse(request, trusted)
    let delivered: Uint8Array | undefined
    await expect(broker.withUse(lease, trusted, async (bytes) => {
      delivered = bytes
      throw new Error("transport failure")
    })).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(delivered && [...delivered].every((byte) => byte === 0)).toBe(true)
  })

  test("one-use delivery checks trusted scope before consuming lease", async () => {
    const { broker, writes } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: request.providerId,
      operationDigest,
      destination: request.destination,
      purpose: request.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(request, trusted)
    await expect(broker.withUse(lease, { ...trusted, destination: "https://evil.invalid" }, async () => undefined))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(writes).toEqual(["put", "lease"])
  })

  test("authorize use rejects expired, overlong, revoked, or provider-mismatched requests before lease write", async () => {
    const { broker, writes } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: request.providerId,
      operationDigest,
      destination: request.destination,
      purpose: request.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }

    await expect(broker.authorizeUse({ ...request, expiresAt: timestamp }, trusted)).rejects.toMatchObject({ code: "EXPIRED" })
    await expect(
      broker.authorizeUse({ ...request, expiresAt: "2026-10-18T17:00:21.000Z" }, trusted),
    ).rejects.toMatchObject({ code: "EXPIRED" })
    await expect(broker.authorizeUse(request, { ...trusted, providerId: "another-provider" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    await broker.revoke(created.secretRef, 1)
    await expect(broker.authorizeUse(request, trusted)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(writes).toEqual(["put", "revoke"])
  })

  test("revocation increments the secret version and returns a metadata-only receipt", async () => {
    const { broker, leases, writes } = fixture()
    const created = await broker.put(putRequest)
    const request = {
      schemaVersion: 1,
      secretRef: created.secretRef,
      providerId: "example-provider",
      operationDigest,
      destination: "https://api.example.invalid/v1/chat/completions",
      purpose: "PROVIDER_REQUEST",
      expiresAt: "2026-10-18T17:00:15.000Z",
      maxRequests: 1,
    } satisfies SecretBrokerV1.UseRequestV1
    const trusted = {
      requesterRef: "principal_authenticated",
      providerId: request.providerId,
      operationDigest,
      destination: request.destination,
      purpose: request.purpose,
      maxExpiresAt: "2026-10-18T17:00:20.000Z",
    }
    const lease = await broker.authorizeUse(request, trusted)
    const receipt = await broker.revoke(created.secretRef, 1)
    expect(receipt).toMatchObject({ secretRef: created.secretRef, revokedVersion: 2, receiptId: "receipt_generated" })
    expect(leases.get(lease.leaseId)?.state).toBe("REVOKED")
    expect(await broker.describe(created.secretRef)).toMatchObject({ status: "REVOKED", version: 2 })
    expect(writes).toEqual(["put", "lease", "revoke"])
  })
})
