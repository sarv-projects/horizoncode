import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { testEffect } from "../lib/effect"

let authJsonWrites = 0
let authJsonReads = 0
let authJsonValue: unknown = {
  "legacy-provider": { type: "api", key: "legacy-plaintext-must-not-be-returned" },
}
const fileSystem = Layer.mock(FSUtil.Service, {
  readJson: () =>
    Effect.sync(() => {
      authJsonReads++
      return authJsonValue
    }),
  writeJson: () =>
    Effect.sync(() => {
      authJsonWrites++
    }),
} as unknown as FSUtil.Interface)

const authLayer = LayerNode.compile(Auth.node, [[FSUtil.node, fileSystem]])
const it = testEffect(authLayer)

it.effect("provider auth reads fail closed on plaintext auth.json and OPENCODE_AUTH_CONTENT", () =>
  Effect.gen(function* () {
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "environment-provider": { type: "api", key: "environment-plaintext-must-not-be-returned" },
    })
    authJsonReads = 0
    try {
      const auth = yield* Auth.Service
      expect(yield* auth.get("legacy-provider")).toBeUndefined()
      expect(yield* auth.get("environment-provider")).toBeUndefined()
      expect(yield* auth.all()).toEqual({})
      expect(authJsonReads).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
    }
  }),
)

it.effect("provider API key and OAuth credential mutations fail closed before auth.json writes", () =>
  Effect.gen(function* () {
    authJsonWrites = 0
    const api = yield* Effect.exit(
      Auth.Service.use((auth) => auth.set("test-provider", { type: "api", key: "never-persist-this" })),
    )
    const oauth = yield* Effect.exit(
      Auth.Service.use((auth) =>
        auth.set("test-provider", {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        }),
      ),
    )
    const remove = yield* Effect.exit(Auth.Service.use((auth) => auth.remove("test-provider")))

    expect(Exit.isFailure(api)).toBe(true)
    expect(Exit.isFailure(oauth)).toBe(true)
    expect(Exit.isFailure(remove)).toBe(true)
    for (const result of [api, oauth, remove]) {
      if (Exit.isFailure(result)) {
        expect(Cause.prettyErrors(result.cause).map(String).join(" ")).toContain("Secure credential storage is unavailable")
      }
    }
    expect(authJsonWrites).toBe(0)
  }),
)

it.effect("exposes only SecretBroker metadata operations and keeps legacy raw auth views empty", () =>
  Effect.gen(function* () {
    const metadata = Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({
      schemaVersion: 1,
      secretRef: "secret_test" as SecretBrokerV1.SecretRef,
      providerId: "test-provider",
      label: "Test API",
      status: "AVAILABLE",
      version: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })
    const receipt = Schema.decodeUnknownSync(SecretBrokerV1.RevocationReceiptV1)({
      schemaVersion: 1,
      secretRef: metadata.secretRef,
      revokedVersion: 2,
      revokedAt: new Date(0).toISOString(),
      receiptId: "receipt_test",
    })
    const broker = {
      put: async (input: SecretBrokerV1.PutRequestV1) => {
        expect(input.secureInputHandle).toBe("opaque-handle-not-secret-content")
        return metadata
      },
      describe: async () => metadata,
      revoke: async () => receipt,
      authorizeUse: async () => { throw new Error("unused credential lease fixture") },
    }
    const auth = Auth.makeService(broker)
    const put = yield* Effect.exit(auth.putCredential({
      schemaVersion: 1,
      providerId: "test-provider",
      secureInputHandle: "opaque-handle-not-secret-content",
      idempotencyKey: "put_test",
    }))
    expect(Exit.isSuccess(put)).toBe(true)
    if (Exit.isSuccess(put)) expect(put.value).toEqual(metadata)
    expect(yield* auth.get("test-provider")).toBeUndefined()
    expect(yield* auth.all()).toEqual({})
    expect(yield* auth.describeCredential(metadata.secretRef)).toEqual(metadata)
    expect(yield* auth.revokeCredential(metadata.secretRef, 1)).toEqual(receipt)
    const lease = yield* Effect.exit(auth.authorizeCredentialUse({
      schemaVersion: 1,
      secretRef: metadata.secretRef,
      providerId: "test-provider",
      operationDigest: `sha256:${"a".repeat(64)}` as SecretBrokerV1.SecretOperationDigest,
      destination: "https://api.example.test/v1/responses",
      purpose: "PROVIDER_REQUEST",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      maxRequests: 1,
    }))
    expect(Exit.isFailure(lease)).toBe(true)
    if (Exit.isFailure(lease)) {
      expect(Cause.prettyErrors(lease.cause).map(String).join(" ")).toContain("Guarded provider credential authorization is unavailable")
    }
    expect(Exit.isFailure(yield* Effect.exit(auth.set("test-provider", { type: "api", key: "raw" })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(auth.remove("test-provider")))).toBe(true)
  }),
)

it.effect("redacts lower-level keyring details from Auth errors", () =>
  Effect.gen(function* () {
    const auth = Auth.makeService({
      put: async () => { throw new Error("credential bytes and private D-Bus details") },
      describe: async () => { throw new Error("credential bytes and private D-Bus details") },
      revoke: async () => { throw new Error("credential bytes and private D-Bus details") },
      authorizeUse: async () => { throw new Error("credential bytes and private D-Bus details") },
    })
    const result = yield* Effect.exit(auth.describeCredential("secret_test" as SecretBrokerV1.SecretRef))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const message = Cause.prettyErrors(result.cause).map(String).join(" ")
      expect(message).toContain("Secure credential storage is unavailable")
      expect(message).not.toContain("credential bytes")
      expect(message).not.toContain("private D-Bus")
    }
  }),
)
