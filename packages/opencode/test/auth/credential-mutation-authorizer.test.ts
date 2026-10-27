import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { Auth } from "@/auth"
import { createSecretBroker } from "@/auth/secret-broker"
import { SecureInputVault, type SecureInputBinding } from "@/auth/secure-input"
import { mutationBinding, principalRefOf } from "@/auth/secret-mutation"
import {
  CredentialMutationDenied,
  makeCredentialMutationAuthorizer,
  type CredentialMutationRpc,
} from "@/auth/credential-mutation-authorizer"

const hostPrincipal: TrustedPrincipal = { kind: "host_os" }
const serverPrincipal: TrustedPrincipal = { kind: "server_auth", subject: "alice" }

const run = <A, E>(effect: Effect.Effect<A, E, never>, principal: TrustedPrincipal = hostPrincipal) =>
  Effect.runPromise(effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal })))

const runExit = <A, E>(effect: Effect.Effect<A, E, never>, principal: TrustedPrincipal = hostPrincipal) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal })))

const encoder = new TextEncoder()
const DIGEST = "a".repeat(64)

/** Exact HostKernel `secret.v1` response projection for one authorized mutation. */
const kernelGrant = (
  operation: "put" | "rotate" | "revoke",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  operation,
  providerId: "test-provider",
  secretRef: operation === "put" ? "secret_created" : "secret_test",
  expectedVersion: operation === "put" ? null : "1",
  version: "1",
  label: null,
  revokedVersion: operation === "revoke" ? "1" : null,
  expiresAtUnixMs: 1_700_000_000_000,
  grantID: `secret_grant_${DIGEST}`,
  grantDigest: `blake3:${DIGEST}`,
  receiptID: `secret_receipt_${DIGEST}`,
  receiptDigest: `blake3:${DIGEST}`,
  ...overrides,
})

const kernelResponse = (
  operation: "put" | "rotate" | "revoke",
  options: { readonly grant?: Record<string, unknown>; readonly top?: Record<string, unknown> } = {},
): Record<string, unknown> => ({
  status: "COMMITTED",
  grant: kernelGrant(operation, options.grant),
  ...(operation === "revoke"
    ? {
        revocation: {
          schemaVersion: 1,
          secretRef: "secret_test",
          revokedVersion: "1",
          revokedAtUnixMs: 1_700_000_000_000,
          receiptID: `secret_receipt_${DIGEST}`,
        },
      }
    : {}),
  ...options.top,
})

const bindingFor = (operation: "put" | "rotate" | "revoke", principal: TrustedPrincipal = hostPrincipal) => {
  const binding = mutationBinding(principal, {
    providerId: "test-provider",
    operation,
    idempotencyKey: `${operation}_1`,
    ...(operation === "put" ? {} : { secretRef: "secret_test", expectedVersion: 1 }),
  })
  if (!binding) throw new Error(`fixture binding is invalid for ${operation}`)
  return binding
}

type Call = {
  readonly serviceID: string
  readonly operation: string
  readonly body: Readonly<Record<string, unknown>>
  readonly principal: TrustedPrincipal
}

const recordingRpc = (respond: (call: Call) => Promise<Readonly<Record<string, unknown>>>) => {
  const calls: Call[] = []
  const rpc: CredentialMutationRpc = async (serviceID, operation, body, principal) => {
    const call = { serviceID, operation, body, principal }
    calls.push(call)
    return respond(call)
  }
  return { rpc, calls }
}

const hostCodeError = (hostCode: string) =>
  Object.assign(new Error(`host kernel denied ${hostCode}`), { hostCode })

const metadata = (providerId: string, version = 1) =>
  Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({
    schemaVersion: 1,
    secretRef: "secret_test" as SecretBrokerV1.SecretRef,
    providerId,
    status: "AVAILABLE",
    version,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  })

const brokerFixture = (overrides: Partial<{
  put: (input: SecretBrokerV1.PutRequestV1, binding?: SecureInputBinding) => Promise<SecretBrokerV1.MetadataV1>
  describe: (secretRef: SecretBrokerV1.SecretRef) => Promise<SecretBrokerV1.MetadataV1>
  revoke: (secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) => Promise<SecretBrokerV1.RevocationReceiptV1>
}> = {}) => {
  const calls = { put: 0, describe: 0, revoke: 0 }
  const broker = {
    put: async (input: SecretBrokerV1.PutRequestV1, binding?: SecureInputBinding) => {
      calls.put++
      return overrides.put ? overrides.put(input, binding) : metadata(input.providerId)
    },
    describe: async (secretRef: SecretBrokerV1.SecretRef) => {
      calls.describe++
      return overrides.describe ? overrides.describe(secretRef) : metadata("test-provider")
    },
    listByProviderIds: async () => [] as SecretBrokerV1.MetadataV1[],
    revoke: async (secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) => {
      calls.revoke++
      return overrides.revoke
        ? overrides.revoke(secretRef, expectedVersion)
        : Schema.decodeUnknownSync(SecretBrokerV1.RevocationReceiptV1)({
            schemaVersion: 1,
            secretRef,
            revokedVersion: 2,
            revokedAt: new Date(0).toISOString(),
            receiptId: "receipt_test",
          })
    },
    authorizeUse: async () => {
      throw new Error("credential lease must not be minted")
    },
    withUse: async () => {
      throw new Error("credential bytes must not be released")
    },
  }
  return { broker, calls }
}

/** In-memory durable store so a refused grant can be proven to write nothing. */
const memoryBroker = (vault: SecureInputVault, seed: SecretBrokerV1.MetadataV1[] = []) => {
  const records = new Map<string, SecretBrokerV1.MetadataV1>(seed.map((item) => [item.secretRef, item]))
  const writes: SecretBrokerV1.MetadataV1[] = []
  const store = {
    put: async (
      record: SecretBrokerV1.MetadataV1,
      _bytes: Uint8Array,
      _idempotencyKey: string,
      _expectedVersion?: number,
    ) => {
      writes.push(record)
      records.set(record.secretRef, record)
      return record
    },
    describe: async (secretRef: SecretBrokerV1.SecretRef) => records.get(secretRef),
    listByProviderIds: async () => [...records.values()],
    withConsumedLease: async () => {
      throw new Error("credential use must not be minted")
    },
    revoke: async () => {
      throw new Error("revoke is not part of this fixture")
    },
    putLease: async () => {
      throw new Error("credential use must not be minted")
    },
  }
  const broker = createSecretBroker({ store, secureInput: vault, id: (kind) => `${kind}_test` })
  return {
    writes,
    broker: {
      put: (input: SecretBrokerV1.PutRequestV1, binding?: SecureInputBinding) => broker.put(input, binding),
      describe: (secretRef: SecretBrokerV1.SecretRef) => broker.describe(secretRef),
      listByProviderIds: (providerIDs: readonly string[]) => broker.listByProviderIds(providerIDs),
      revoke: (secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) => broker.revoke(secretRef, expectedVersion),
      authorizeUse: async () => {
        throw new Error("credential lease must not be minted")
      },
      withUse: async () => {
        throw new Error("credential bytes must not be released")
      },
    },
  }
}

test("authorizer sends exactly the strict secret.v1 body for put, rotate, and revoke", async () => {
  for (const [bindingOperation, hostOperation] of [
    ["put", "authorize_put"],
    ["rotate", "authorize_rotate"],
    ["revoke", "authorize_revoke"],
  ] as const) {
    const binding = bindingFor(bindingOperation)
    const { rpc, calls } = recordingRpc(async () => kernelResponse(bindingOperation))
    const authorizer = makeCredentialMutationAuthorizer(rpc)
    const grant = await authorizer.authorize(binding, hostPrincipal)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.serviceID).toBe("secret.v1")
    expect(call.operation).toBe(hostOperation)
    expect(call.principal).toEqual(hostPrincipal)
    expect(call.body).toEqual({
      providerId: "test-provider",
      idempotencyKey: `${bindingOperation}_1`,
      ...(bindingOperation === "put" ? {} : { secretRef: "secret_test", expectedVersion: 1 }),
    })
    // Core must never put identity in the request body.
    expect(Object.keys(call.body).toSorted()).toEqual(
      (bindingOperation === "put"
        ? ["idempotencyKey", "providerId"]
        : ["expectedVersion", "idempotencyKey", "providerId", "secretRef"]).toSorted(),
    )
    expect(JSON.stringify(call.body)).not.toContain("principal")

    expect(grant).toMatchObject({
      grantRef: `secret_grant_${DIGEST}`,
      principalRef: principalRefOf(hostPrincipal)!,
      providerId: "test-provider",
      operation: bindingOperation,
      idempotencyKey: `${bindingOperation}_1`,
    })
    expect(grant.expectedVersion).toBe(bindingOperation === "put" ? undefined : 1)
    expect(grant.secretRef).toBe(bindingOperation === "put" ? undefined : "secret_test")
  }
})

test("authorizer accepts HostKernel u64 timestamps decoded as bigint", async () => {
  // The Core messagepack decoder widens the kernel's unsigned 64-bit
  // `expiresAtUnixMs` to bigint; that must not be mistaken for a malformed grant.
  const { rpc, calls } = recordingRpc(async () =>
    kernelResponse("put", { grant: { expiresAtUnixMs: 1_700_000_000_000n } }),
  )
  const authorizer = makeCredentialMutationAuthorizer(rpc)
  const grant = await authorizer.authorize(bindingFor("put"), hostPrincipal)
  expect(grant.grantRef).toBe(`secret_grant_${DIGEST}`)
  expect(calls).toHaveLength(1)
})

test("authorizer refuses a binding that is not bound to the trusted principal or target ref", async () => {
  const { rpc, calls } = recordingRpc(async () => kernelResponse("put"))
  const authorizer = makeCredentialMutationAuthorizer(rpc)
  const binding = bindingFor("put")

  await expect(authorizer.authorize(binding, serverPrincipal)).rejects.toBeInstanceOf(CredentialMutationDenied)
  // A rotate/revoke intent without an exact target ref never reaches the host.
  const targetless: SecureInputBinding = {
    principalRef: principalRefOf(hostPrincipal)!,
    providerId: "test-provider",
    operation: "rotate",
    expectedVersion: 1,
    idempotencyKey: "rotate_1",
  }
  await expect(authorizer.authorize(targetless, hostPrincipal)).rejects.toBeInstanceOf(CredentialMutationDenied)
  // Neither rejection reached the host: Core cannot ask for a grant it can
  // never redeem.
  expect(calls).toHaveLength(0)
})

test("authorizer rejects a response that differs in any field from the authorized binding", async () => {
  const cases: ReadonlyArray<{
    readonly label: string
    readonly operation: "put" | "rotate" | "revoke"
    readonly response: Record<string, unknown>
  }> = [
    { label: "provider", operation: "rotate", response: kernelResponse("rotate", { grant: { providerId: "other-provider" } }) },
    { label: "operation", operation: "rotate", response: kernelResponse("rotate", { grant: { operation: "put" } }) },
    { label: "secretRef", operation: "rotate", response: kernelResponse("rotate", { grant: { secretRef: "secret_other" } }) },
    { label: "expectedVersion", operation: "rotate", response: kernelResponse("rotate", { grant: { expectedVersion: "2" } }) },
    { label: "expectedVersion null", operation: "rotate", response: kernelResponse("rotate", { grant: { expectedVersion: null } }) },
    { label: "schemaVersion", operation: "rotate", response: kernelResponse("rotate", { grant: { schemaVersion: 2 } }) },
    { label: "version", operation: "rotate", response: kernelResponse("rotate", { grant: { version: "0" } }) },
    { label: "version type", operation: "rotate", response: kernelResponse("rotate", { grant: { version: 2 } }) },
    { label: "revokedVersion", operation: "rotate", response: kernelResponse("rotate", { grant: { revokedVersion: "1" } }) },
    { label: "grantID", operation: "rotate", response: kernelResponse("rotate", { grant: { grantID: "secret_grant_short" } }) },
    { label: "grantDigest", operation: "rotate", response: kernelResponse("rotate", { grant: { grantDigest: `sha256:${DIGEST}` } }) },
    { label: "receiptDigest", operation: "rotate", response: kernelResponse("rotate", { grant: { receiptDigest: "blake3:abc" } }) },
    { label: "receiptID", operation: "rotate", response: kernelResponse("rotate", { grant: { receiptID: "receipt_x" } }) },
    { label: "expiresAtUnixMs", operation: "rotate", response: kernelResponse("rotate", { grant: { expiresAtUnixMs: 0 } }) },
    { label: "label", operation: "rotate", response: kernelResponse("rotate", { grant: { label: "x".repeat(129) } }) },
    { label: "extra grant field", operation: "rotate", response: kernelResponse("rotate", { grant: { extra: true } }) },
    { label: "extra top field", operation: "rotate", response: kernelResponse("rotate", { top: { extra: true } }) },
    { label: "status", operation: "rotate", response: kernelResponse("rotate", { top: { status: "DENIED" } }) },
    { label: "status object", operation: "rotate", response: kernelResponse("rotate", { top: { status: { granted: true } } }) },
    { label: "non-object", operation: "rotate", response: [] as unknown as Record<string, unknown> },
    { label: "missing grant", operation: "rotate", response: { status: "COMMITTED" } },
    {
      label: "revocation missing",
      operation: "revoke",
      response: { status: "COMMITTED", grant: kernelGrant("revoke") },
    },
    {
      label: "revocation secretRef",
      operation: "revoke",
      response: {
        status: "COMMITTED",
        grant: kernelGrant("revoke"),
        revocation: {
          schemaVersion: 1,
          secretRef: "secret_other",
          revokedVersion: "1",
          revokedAtUnixMs: 1_700_000_000_000,
          receiptID: `secret_receipt_${DIGEST}`,
        },
      },
    },
    {
      label: "revocation version",
      operation: "revoke",
      response: {
        status: "COMMITTED",
        grant: kernelGrant("revoke"),
        revocation: {
          schemaVersion: 1,
          secretRef: "secret_test",
          revokedVersion: "2",
          revokedAtUnixMs: 1_700_000_000_000,
          receiptID: `secret_receipt_${DIGEST}`,
        },
      },
    },
  ]

  for (const item of cases) {
    const binding = bindingFor(item.operation)
    const { rpc } = recordingRpc(async () => item.response)
    const authorizer = makeCredentialMutationAuthorizer(rpc)
    await expect(authorizer.authorize(binding, hostPrincipal)).rejects.toBeInstanceOf(CredentialMutationDenied)
  }
})

test("authorizer propagates denied and unknown host-kernel codes as rejections", async () => {
  const codes = [
    "secret_denied",
    "secret_conflict",
    "secret_stale_version",
    "secret_not_found",
    "secret_unavailable",
    "secret_outcome_unknown",
    "missing_principal",
    "invalid_effect_request",
    "some_future_code",
  ]
  for (const hostCode of codes) {
    const { rpc } = recordingRpc(async () => {
      throw hostCodeError(hostCode)
    })
    const authorizer = makeCredentialMutationAuthorizer(rpc)
    const binding = bindingFor("rotate")
    const rejected = authorizer.authorize(binding, hostPrincipal)
    await expect(rejected).rejects.toBeInstanceOf(CredentialMutationDenied)
  }

  const { rpc } = recordingRpc(async () => {
    throw new Error("host kernel channel is closed")
  })
  await expect(makeCredentialMutationAuthorizer(rpc).authorize(bindingFor("put"), hostPrincipal)).rejects.toBeInstanceOf(
    CredentialMutationDenied,
  )
})

test("credential mutation availability requires both the grant channel and a trusted principal", async () => {
  const { rpc } = recordingRpc(async () => kernelResponse("put"))
  const authorizer = makeCredentialMutationAuthorizer(rpc)
  const broker = brokerFixture()

  const wired = Auth.makeService(broker.broker, undefined, undefined, authorizer, new SecureInputVault())
  expect(await run(wired.credentialMutationAvailable())).toBe(true)
  expect(await run(wired.credentialMutationAvailable(), serverPrincipal)).toBe(true)

  // No trusted principal context: the grant channel must read as unavailable.
  expect(await Effect.runPromise(wired.credentialMutationAvailable())).toBe(false)
  // A server-auth principal without a bounded subject can never be bound.
  expect(await run(wired.credentialMutationAvailable(), { kind: "server_auth", subject: "" })).toBe(false)

  const unwired = Auth.makeService(broker.broker, undefined, undefined, undefined, new SecureInputVault())
  expect(await run(unwired.credentialMutationAvailable())).toBe(false)

  const noVault = Auth.makeService(broker.broker, undefined, undefined, authorizer, undefined)
  expect(await run(noVault.credentialMutationAvailable())).toBe(false)
})

test("end to end: a bound handle plus the exact host grant commits, a wrong principal or version writes nothing", async () => {
  const vault = new SecureInputVault()
  const { broker, writes } = memoryBroker(vault, [metadata("test-provider", 1)])
  const { rpc, calls } = recordingRpc(async (call) => {
    // The rotate answer is deliberately stale: the exact-grant gate, not the
    // host, must refuse a version the binding never authorized.
    if (call.operation === "authorize_rotate") return kernelResponse("rotate", { grant: { expectedVersion: "2" } })
    return kernelResponse("put")
  })
  const auth = Auth.makeService(broker, undefined, undefined, makeCredentialMutationAuthorizer(rpc), vault)

  const key = encoder.encode("sk-fixture-not-real")
  const handle = await run(
    auth.issueCredentialHandle({
      bytes: key,
      providerId: "test-provider",
      operation: "put",
      idempotencyKey: "put_1",
    }),
  )
  expect(key.every((byte) => byte === 0)).toBe(true)

  const written = await run(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: handle,
      idempotencyKey: "put_1",
    }),
  )
  expect(written.providerId).toBe("test-provider")
  expect(writes).toHaveLength(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.operation).toBe("authorize_put")
  expect(calls[0]!.body).toEqual({ providerId: "test-provider", idempotencyKey: "put_1" })
  expect(calls[0]!.principal).toEqual(hostPrincipal)

  // A handle bound to the local host principal cannot be spent under a
  // server-authenticated principal: the vault refuses the mismatched binding
  // and nothing is durably written.
  const foreign = await runExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: handle,
      idempotencyKey: "put_1",
    }),
    serverPrincipal,
  )
  expect(foreign._tag).toBe("Failure")
  expect(calls).toHaveLength(2)
  expect(calls[1]!.principal).toEqual(serverPrincipal)
  expect(calls[1]!.body).toEqual({ providerId: "test-provider", idempotencyKey: "put_1" })
  expect(writes).toHaveLength(1)

  // A rotation handle must be issued against the same exact target ref.
  const rotateHandle = await run(
    auth.issueCredentialHandle({
      bytes: encoder.encode("sk-fixture-rotated-not-real"),
      providerId: "test-provider",
      operation: "rotate",
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      expectedVersion: 1,
      idempotencyKey: "rotate_1",
    }),
  )
  expect(calls).toHaveLength(2)

  // The host answers with the wrong expected version: the exact grant gate
  // refuses before any broker write.
  const wrongVersion = await runExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: rotateHandle,
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      expectedVersion: 1,
      idempotencyKey: "rotate_1",
    }),
  )
  expect(wrongVersion._tag).toBe("Failure")
  expect(writes).toHaveLength(1)
  expect(calls).toHaveLength(3)
  expect(calls[2]!.operation).toBe("authorize_rotate")
  expect(calls[2]!.body).toEqual({
    providerId: "test-provider",
    idempotencyKey: "rotate_1",
    secretRef: "secret_test",
    expectedVersion: 1,
  })
})
