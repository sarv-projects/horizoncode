import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { Auth } from "@/auth"
import { SecureInputVault, type SecureInputBinding } from "@/auth/secure-input"
import { principalRefOf } from "@/auth/secret-mutation"

const hostPrincipal: TrustedPrincipal = { kind: "host_os" }

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal: hostPrincipal })))

const runExit = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal: hostPrincipal })))

const encoder = new TextEncoder()

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

const receipt = (secretRef: SecretBrokerV1.SecretRef, revokedVersion = 2) =>
  Schema.decodeUnknownSync(SecretBrokerV1.RevocationReceiptV1)({
    schemaVersion: 1,
    secretRef,
    revokedVersion,
    revokedAt: new Date(0).toISOString(),
    receiptId: "receipt_test",
  })

const brokerFixture = (overrides: Partial<{
  put: (input: SecretBrokerV1.PutRequestV1, binding?: SecureInputBinding) => Promise<SecretBrokerV1.MetadataV1>
  describe: (secretRef: SecretBrokerV1.SecretRef) => Promise<SecretBrokerV1.MetadataV1>
  revoke: (secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) => Promise<SecretBrokerV1.RevocationReceiptV1>
}> = {}) => {
  const calls = { put: 0, describe: 0, revoke: 0, authorizeUse: 0 }
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
      return overrides.revoke ? overrides.revoke(secretRef, expectedVersion) : receipt(secretRef)
    },
    authorizeUse: async () => {
      calls.authorizeUse++
      throw new Error("credential lease must not be minted")
    },
    withUse: async () => {
      throw new Error("credential bytes must not be released")
    },
  }
  return { broker, calls }
}

const grantFor = (binding: SecureInputBinding): Auth.CredentialMutationGrant => ({
  grantRef: "grant_test",
  ...binding,
})

test("guarded put succeeds only for the exact bound handle and validated grant", async () => {
  const vault = new SecureInputVault()
  const bindingSeen: SecureInputBinding[] = []
  const { broker, calls } = brokerFixture({
    put: async (input, binding) => {
      expect(binding).toBeDefined()
      bindingSeen.push(binding!)
      expect(input.providerId).toBe("test-provider")
      expect(input.secureInputHandle).not.toContain("sk-live-secret")
      const consumed = await vault.consume(input.secureInputHandle, binding!)
      expect(new TextDecoder().decode(consumed)).toBe("sk-live-secret")
      return metadata(input.providerId)
    },
  })
  let authorizations = 0
  const authorizer: Auth.CredentialMutationAuthorizer = {
    authorize: async (binding) => {
      authorizations++
      return grantFor(binding)
    },
  }
  const auth = Auth.makeService(broker, undefined, undefined, authorizer, vault)
  const key = encoder.encode("sk-live-secret")
  const handle = await run(
    auth.issueCredentialHandle({
      bytes: key,
      providerId: "test-provider",
      operation: "put",
      idempotencyKey: "put_1",
    }),
  )
  expect(key.every((byte) => byte === 0)).toBe(true)
  expect(await run(auth.credentialMutationAvailable())).toBe(true)

  const written = await run(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: handle,
      idempotencyKey: "put_1",
    }),
  )

  expect(written.providerId).toBe("test-provider")
  expect(calls.put).toBe(1)
  expect(authorizations).toBe(1)
  expect(bindingSeen).toEqual([
    {
      principalRef: principalRefOf(hostPrincipal)!,
      providerId: "test-provider",
      operation: "put",
      idempotencyKey: "put_1",
    },
  ])
})

test("guarded put and revoke fail closed without a validated grant", async () => {
  const { broker, calls } = brokerFixture()
  let authorizations = 0
  const auth = Auth.makeService(broker, undefined, undefined, undefined, new SecureInputVault())
  expect(await run(auth.credentialMutationAvailable())).toBe(false)

  const put = await runExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: "opaque-handle-not-secret-content",
      idempotencyKey: "put_1",
    }),
  )
  const revoke = await runExit(auth.revokeCredential(SecretBrokerV1.SecretRef.make("secret_test"), 1))

  const results: Array<Exit.Exit<unknown, Auth.AuthError>> = [put, revoke]
  for (const result of results) {
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.prettyErrors(result.cause).map(String).join(" ")).toContain(
        "Secure credential storage is unavailable",
      )
    }
  }
  expect(calls.put).toBe(0)
  expect(calls.revoke).toBe(0)
  expect(calls.describe).toBe(0)
  expect(authorizations).toBe(0)
})

test("guarded put denies a grant whose principal, provider, operation, or version differs", async () => {
  const mismatches: Array<Partial<Auth.CredentialMutationGrant>> = [
    { principalRef: "server-auth:someone-else" },
    { providerId: "other-provider" },
    { operation: "revoke" },
    { idempotencyKey: "put_other" },
  ]
  for (const mismatch of mismatches) {
    const { broker, calls } = brokerFixture()
    const authorizer: Auth.CredentialMutationAuthorizer = {
      authorize: async (binding) => ({ ...grantFor(binding), ...mismatch }),
    }
    const auth = Auth.makeService(broker, undefined, undefined, authorizer, new SecureInputVault())
    const result = await runExit(
      auth.putCredential({
        schemaVersion: 1,
        providerId: "test-provider",
        secureInputHandle: "opaque-handle-not-secret-content",
        idempotencyKey: "put_1",
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.prettyErrors(result.cause).map(String).join(" ")).toContain(
        "Secure credential storage is unavailable",
      )
    }
    expect(calls.put).toBe(0)
  }

  const { broker, calls } = brokerFixture()
  const authorizer: Auth.CredentialMutationAuthorizer = {
    authorize: async (binding) => ({ ...grantFor(binding), expectedVersion: 2 }),
  }
  const auth = Auth.makeService(broker, undefined, undefined, authorizer, new SecureInputVault())
  const rotated = await runExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: "opaque-handle-not-secret-content",
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      expectedVersion: 1,
      idempotencyKey: "rotate_1",
    }),
  )
  expect(Exit.isFailure(rotated)).toBe(true)
  expect(calls.put).toBe(0)
})

test("guarded mutation denies when the trusted authenticated principal is absent", async () => {
  const { broker, calls } = brokerFixture()
  let authorizations = 0
  const authorizer: Auth.CredentialMutationAuthorizer = {
    authorize: async (binding) => {
      authorizations++
      return grantFor(binding)
    },
  }
  const auth = Auth.makeService(broker, undefined, undefined, authorizer, new SecureInputVault())
  const result = await Effect.runPromiseExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: "opaque-handle-not-secret-content",
      idempotencyKey: "put_1",
    }),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    expect(Cause.prettyErrors(result.cause).map(String).join(" ")).toContain(
      "Secure credential storage is unavailable",
    )
  }
  expect(authorizations).toBe(0)
  expect(calls.put).toBe(0)
})

test("guarded rotation requires the exact expectedVersion and revoke binds the described provider", async () => {
  const vault = new SecureInputVault()
  const { broker, calls } = brokerFixture({
    put: async (input, binding) => {
      const consumed = await vault.consume(input.secureInputHandle, binding!)
      expect(new TextDecoder().decode(consumed)).toBe("sk-rotated-secret")
      return metadata(input.providerId, 2)
    },
    describe: async () => metadata("test-provider", 1),
  })
  const seen: SecureInputBinding[] = []
  const authorizer: Auth.CredentialMutationAuthorizer = {
    authorize: async (binding) => {
      seen.push(binding)
      return grantFor(binding)
    },
  }
  const auth = Auth.makeService(broker, undefined, undefined, authorizer, vault)
  const handle = await run(
    auth.issueCredentialHandle({
      bytes: encoder.encode("sk-rotated-secret"),
      providerId: "test-provider",
      operation: "rotate",
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      expectedVersion: 1,
      idempotencyKey: "rotate_1",
    }),
  )
  const rotated = await run(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: handle,
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      expectedVersion: 1,
      idempotencyKey: "rotate_1",
    }),
  )
  expect(rotated.version).toBe(2)
  expect(calls.put).toBe(1)

  const revoked = await run(auth.revokeCredential(metadata("test-provider").secretRef, 1))
  expect(String(revoked.secretRef)).toBe("secret_test")
  expect(calls.revoke).toBe(1)
  expect(seen[1]).toMatchObject({
    principalRef: principalRefOf(hostPrincipal)!,
    providerId: "test-provider",
    operation: "revoke",
    secretRef: "secret_test",
    expectedVersion: 1,
  })
  expect(calls.describe).toBe(1)
})

test("guarded mutation never surfaces rejected credential bytes in typed errors", async () => {
  const { broker } = brokerFixture({
    put: async () => {
      throw new Error("rejected key sk-live-secret must not escape")
    },
  })
  const authorizer: Auth.CredentialMutationAuthorizer = {
    authorize: async () => {
      throw new Error("HostKernel rejected sk-live-secret")
    },
  }
  const auth = Auth.makeService(broker, undefined, undefined, authorizer, new SecureInputVault())
  const result = await runExit(
    auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: "opaque-handle-not-secret-content",
      idempotencyKey: "put_1",
    }),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    const message = Cause.prettyErrors(result.cause).map(String).join(" ")
    expect(message).toContain("Secure credential storage is unavailable")
    expect(message).not.toContain("sk-live-secret")
  }

  expect(Exit.isFailure(yieldExit(auth.set("test-provider", { type: "api", key: "sk-live-secret" })))).toBe(true)
  expect(Exit.isFailure(yieldExit(auth.remove("test-provider")))).toBe(true)
})

// Auth.set/remove are synchronous Effect values; inspect them without a runtime.
const yieldExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.exit(effect))
