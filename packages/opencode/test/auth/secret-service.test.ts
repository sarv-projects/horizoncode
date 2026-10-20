import { describe, expect, test } from "bun:test"
import { beginSecretServiceDhSession, negotiateSecretServiceSession, SECRET_SERVICE_ALGORITHM } from "../../src/auth/secret-service"

describe("Secret Service encrypted D-Bus session", () => {
  test("matches the RFC 2409 DH/HKDF/AES-CBC encrypted-byte exchange", () => {
    const client = beginSecretServiceDhSession({ privateExponent: 123456789n })
    const service = beginSecretServiceDhSession({ privateExponent: 987654321n })
    client.complete(service.clientPublicKey)
    service.complete(client.clientPublicKey)
    const encrypted = client.encrypt(new TextEncoder().encode("fake-service-contract"))
    expect(service.decrypt(encrypted.parameters, encrypted.value).toString()).toBe("fake-service-contract")
    client.close()
    service.close()
  })

  test("negotiation selects only encrypted DH and refuses malformed replies", async () => {
    let algorithm: string | undefined
    let input: unknown
    const session = await negotiateSecretServiceSession(
      {
        async OpenSession(selected, sent) {
          algorithm = selected
          input = sent
          const server = beginSecretServiceDhSession({ privateExponent: 987654321n })
          const publicKey = Buffer.from(server.clientPublicKey)
          server.close()
          return [{ signature: "ay", value: publicKey }, "/org/freedesktop/secrets/session/fake"]
        },
      },
      (signature, value) => ({ signature, value }),
      (value) => (value as { signature: string; value: unknown }).value,
      (size) => new Uint8Array(size).fill(7),
    )

    expect(algorithm).toBe(SECRET_SERVICE_ALGORITHM)
    expect((input as { signature: string }).signature).toBe("ay")
    expect(session.sessionPath).toBe("/org/freedesktop/secrets/session/fake")
    session.cipher.close()

    await expect(
      negotiateSecretServiceSession(
        { async OpenSession() { return ["plain", "/"] } },
        (signature, value) => ({ signature, value }),
        (value) => value,
      ),
    ).rejects.toThrow("invalid Secret Service OpenSession result")
  })
})

function encryptedFixture() {
  const client = beginSecretServiceDhSession({ privateExponent: 123456789n })
  const server = beginSecretServiceDhSession({ privateExponent: 987654321n })
  client.complete(server.clientPublicKey)
  server.complete(client.clientPublicKey)
  const sessionPath = "/org/freedesktop/secrets/session/fake"
  const itemPath = "/org/freedesktop/secrets/collection/login/item_1"
  let encrypted: ReturnType<typeof server.encrypt> | undefined
  let created: unknown
  let locked: string[] = []
  let paths: string[] = [itemPath]
  const searches: unknown[] = []
  const removed: string[] = []
  let closed = 0
  const session = {
    sessionPath,
    cipher: client,
    variant: (signature: string, value: unknown) => ({ signature, value }),
    valueOfVariant: (value: unknown) => value,
    async close() { closed++; client.close(); server.close() },
    service: {
      async getInterface<Value>(objectPath: string, _name: string): Promise<Value> {
        if (objectPath === "/org/freedesktop/secrets") return {
          async ReadAlias() { return "/org/freedesktop/secrets/collection/login" },
          async SearchItems(attributes: unknown) { searches.push(attributes); return [paths, locked] },
        } as Value
        if (objectPath === "/org/freedesktop/secrets/collection/login") return {
          async CreateItem(properties: unknown, secret: unknown[], replace: boolean) {
            created = { properties, secret: structuredClone(secret), replace }
            const clear = server.decrypt(secret[1] as Uint8Array, secret[2] as Uint8Array)
            encrypted = server.encrypt(clear)
            clear.fill(0)
            return [itemPath, "/"]
          },
        } as Value
        if (paths.includes(objectPath)) return {
          async GetSecret() { return [sessionPath, encrypted!.parameters, encrypted!.value, "text/plain; charset=utf-8"] },
          async Delete() { removed.push(objectPath); paths = paths.filter((path) => path !== objectPath); return "/" },
        } as Value
        throw new Error("unexpected object path")
      },
    },
  }
  return { session, searches, removed, get created() { return created }, get closed() { return closed },
    setPaths(value: string[]) { paths = value }, setLocked(value: string[]) { locked = value } }
}

describe("encrypted credential CRUD protocol", () => {
  test("uses pinned D-Bus single-result shapes and exact attributes after object paths change", async () => {
    const f = encryptedFixture()
    const { createSecretServiceCredentialBackend } = await import("../../src/auth/secret-service")
    const backend = await createSecretServiceCredentialBackend(f.session)
    const ref = "secret_test_1" as import("@opencode-ai/schema/secret-broker-v1").SecretBrokerV1.SecretRef
    const item = await backend.createSecret(ref, 1, new TextEncoder().encode("test-only-secret"))
    const moved = "/org/freedesktop/secrets/collection/login/moved_item"
    f.setPaths([moved])
    const clear = await backend.getSecret(item, ref, 1)
    expect(new TextDecoder().decode(clear)).toBe("test-only-secret")
    clear.fill(0)
    await backend.deleteSecret(item, ref, 1)
    expect(f.removed).toEqual([moved])
    expect(f.searches).toContainEqual({ "horizoncode.product": "horizoncode", "horizoncode.secret_ref": ref, "horizoncode.secret_version": "1" })
    expect(JSON.stringify(f.created)).not.toContain("test-only-secret")
    await backend.close()
    expect(f.closed).toBe(1)
  })

  test("refuses duplicate or locked attribute matches without deleting any item", async () => {
    const f = encryptedFixture()
    const { createSecretServiceCredentialBackend } = await import("../../src/auth/secret-service")
    const backend = await createSecretServiceCredentialBackend(f.session)
    const ref = "secret_test_1" as import("@opencode-ai/schema/secret-broker-v1").SecretBrokerV1.SecretRef
    f.setPaths(["/item_1", "/item_2"])
    await expect(backend.getSecret("/stale", ref, 1)).rejects.toThrow()
    await expect(backend.deleteSecret("/stale", ref, 1)).rejects.toThrow()
    f.setPaths([])
    f.setLocked(["/item_1"])
    await expect(backend.deleteOrphanedSecret(ref, 1)).rejects.toThrow()
    expect(f.removed).toEqual([])
    await backend.close()
  })
})
