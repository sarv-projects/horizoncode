import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { createLinuxSecretServiceStore, SECRET_STORE_DIRECTORY, type SecretServiceCredentialBackend } from "../../src/auth/secret-service-store"

const timestamp = "2026-10-19T12:00:00.000Z"

function fixture() {
  const credentials = new Map<string, { secretRef: SecretBrokerV1.SecretRef; version: number; bytes: Uint8Array }>()
  const removed: string[] = []
  let nextItem = 0
  const backend: SecretServiceCredentialBackend = {
    async createSecret(secretRef, version, bytes) {
      const item = `/org/freedesktop/secrets/collection/horizon/item_${++nextItem}`
      credentials.set(item, { secretRef, version, bytes: bytes.slice() })
      return item
    },
    async getSecret(item) {
      const value = credentials.get(item)
      if (!value) throw new Error("missing credential item")
      return value.bytes.slice()
    },
    async deleteSecret(item) {
      credentials.get(item)?.bytes.fill(0)
      credentials.delete(item)
      removed.push(item)
    },
    async deleteOrphanedSecret(secretRef, version) {
      for (const [item, value] of credentials) {
        if (value.secretRef === secretRef && value.version === version) {
          value.bytes.fill(0)
          credentials.delete(item)
          removed.push(item)
        }
      }
    },
  }
  const dirs: string[] = []
  const directory = async () => {
    const value = await mkdtemp(path.join(os.tmpdir(), "horizon-secret-store-"))
    dirs.push(value)
    return value
  }
  return { backend, credentials, removed, dirs, directory }
}

const secretRef = "secret_test_1" as SecretBrokerV1.SecretRef
const metadata = {
  schemaVersion: 1,
  secretRef,
  providerId: "example-provider",
  status: "AVAILABLE",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies SecretBrokerV1.MetadataV1
const lease = {
  schemaVersion: 1,
  leaseId: "lease_test_1" as SecretBrokerV1.SecretUseLeaseId,
  secretRef,
  secretVersion: 1,
  requesterRef: "principal_test_1",
  providerId: "example-provider",
  operationDigest: `sha256:${"a".repeat(64)}` as SecretBrokerV1.SecretOperationDigest,
  destination: "https://api.example.invalid/v1/chat/completions",
  purpose: "PROVIDER_REQUEST",
  state: "ISSUED",
  issuedAt: timestamp,
  expiresAt: "2026-10-19T12:00:30.000Z",
  maxRequests: 1,
} satisfies SecretBrokerV1.UseLeaseV1

const active: string[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("durable Linux Secret Service broker store", () => {
  test("stores credential bytes only through Secret Service and keeps its durable index private", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    const input = new TextEncoder().encode("test-only-secret")

    const result = await store.put(metadata, input, "put_test_1")

    expect(result).toEqual(metadata)
    expect([...input].every((byte) => byte === 0)).toBe(false)
    expect([...f.credentials.values()][0]?.bytes).toEqual(new TextEncoder().encode("test-only-secret"))
    const index = await readFile(path.join(directory, SECRET_STORE_DIRECTORY, "secret-broker-v1.json"), "utf8")
    expect(index).not.toContain("test-only-secret")
    expect(JSON.parse(index).secrets[secretRef].itemPath).toMatch(/^\/org\/freedesktop\/secrets\//)
    expect((await stat(path.join(directory, SECRET_STORE_DIRECTORY))).mode & 0o077).toBe(0)
  })

  test("lists only bounded provider metadata without returning credential bytes", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    await store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await expect(store.listByProviderIds(["example-provider"])).resolves.toEqual([metadata])
    expect(JSON.stringify(await store.listByProviderIds(["example-provider"]))).not.toContain("test-only-secret")
    await expect(store.listByProviderIds(Array.from({ length: 17 }, (_, index) => `provider-${index}`))).rejects.toThrow()
  })

  test("reopens durable metadata and commits a one-use lease before delivering bytes", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    const first = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    await first.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await first.putLease(lease, 1)

    const reopened = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    expect(await reopened.describe(secretRef)).toEqual(metadata)
    let delivered: Uint8Array | undefined
    await expect(reopened.withConsumedLease(lease, timestamp, async (record, bytes) => {
      delivered = bytes
      expect(record).toEqual(metadata)
      expect(bytes).toEqual(new TextEncoder().encode("test-only-secret"))
      return "sent"
    })).resolves.toBe("sent")
    expect(delivered && [...delivered].every((byte) => byte === 0)).toBe(true)
    await expect(reopened.withConsumedLease(lease, timestamp, async () => "replayed")).resolves.toBeUndefined()
  })

  test("rotates an existing SecretRef only at the expected version and retires old leases/items", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    await store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await store.putLease(lease, 1)

    const rotated = { ...metadata, version: 2, updatedAt: "2026-10-19T12:00:00.000Z" }
    const rotatedBytes = new TextEncoder().encode("rotated-test-secret")
    await expect(store.put(rotated, rotatedBytes, "put_test_2", 1)).resolves.toEqual(rotated)
    expect(await store.describe(secretRef)).toEqual(rotated)
    expect(f.credentials.size).toBe(1)
    expect([...f.credentials.values()][0]?.bytes).toEqual(rotatedBytes)
    expect(f.removed).toHaveLength(1)
    await expect(store.withConsumedLease(lease, timestamp, async () => "old version used")).resolves.toBeUndefined()

    const stale = { ...rotated, version: 3, updatedAt: "2026-10-19T12:01:00.000Z" }
    await expect(store.put(stale, new TextEncoder().encode("stale-secret"), "put_test_3", 1)).rejects.toThrow()
    expect(await store.describe(secretRef)).toEqual(rotated)
    expect(f.credentials.size).toBe(1)
  })

  test("keeps the previous credential usable when rotation commit fails before index replacement", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let writes = 0
    const store = await createLinuxSecretServiceStore({
      directory,
      backend: f.backend,
      now: () => new Date(timestamp),
      persistIndex: async (_directory, target, value) => {
        writes++
        if (writes === 5) throw new Error("simulated rotation commit failure before rename")
        const temporary = `${target}.rotation-tmp-${writes}`
        await writeFile(temporary, value, { mode: 0o600 })
        const { rename } = await import("node:fs/promises")
        await rename(temporary, target)
      },
    })
    await store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await store.putLease(lease, 1)

    const rotated = { ...metadata, version: 2, updatedAt: "2026-10-19T12:01:00.000Z" }
    await expect(store.put(rotated, new TextEncoder().encode("rotated-test-secret"), "put_test_2", 1)).rejects.toThrow()
    expect(f.credentials.size).toBe(1)

    const reopened = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    expect(await reopened.describe(secretRef)).toEqual(metadata)
    await expect(reopened.withConsumedLease(lease, timestamp, async (_record, bytes) => {
      expect(bytes).toEqual(new TextEncoder().encode("test-only-secret"))
      return "old-version-usable"
    })).resolves.toBe("old-version-usable")
  })

  test("reconciles an activated rotation when retiring the previous keyring item fails", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let failDelete = true
    const backend: SecretServiceCredentialBackend = {
      ...f.backend,
      async deleteSecret(itemPath, ref, version) {
        if (failDelete) {
          failDelete = false
          throw new Error("simulated crash while retiring old version")
        }
        return f.backend.deleteSecret(itemPath, ref, version)
      },
    }
    const store = await createLinuxSecretServiceStore({ directory, backend, now: () => new Date(timestamp) })
    await store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await store.putLease(lease, 1)

    const rotated = { ...metadata, version: 2, updatedAt: "2026-10-19T12:01:00.000Z" }
    const rotatedBytes = new TextEncoder().encode("rotated-test-secret")
    await expect(store.put(rotated, rotatedBytes, "put_test_2", 1)).rejects.toThrow()
    expect(await store.describe(secretRef)).toEqual(rotated)
    expect(f.credentials.size).toBe(2)

    const reopened = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    expect(await reopened.describe(secretRef)).toEqual(rotated)
    expect(f.credentials.size).toBe(1)
    await expect(reopened.withConsumedLease(lease, timestamp, async () => "stale lease used")).resolves.toBeUndefined()
    const rotatedLease = { ...lease, leaseId: "lease_test_2" as SecretBrokerV1.SecretUseLeaseId, secretVersion: 2 }
    await reopened.putLease(rotatedLease, 2)
    await expect(reopened.withConsumedLease(rotatedLease, timestamp, async (_record, bytes) => {
      expect(bytes).toEqual(rotatedBytes)
      return "new-version-usable"
    })).resolves.toBe("new-version-usable")
  })

  test("revocation invalidates issued leases and deletes the OS credential item", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend, now: () => new Date(timestamp) })
    await store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await store.putLease(lease, 1)
    const receipt = {
      schemaVersion: 1,
      secretRef,
      revokedVersion: 2,
      revokedAt: timestamp,
      receiptId: "receipt_test_1",
    } satisfies SecretBrokerV1.RevocationReceiptV1

    await expect(store.revoke(secretRef, 1, 2, receipt)).resolves.toBe(true)
    expect(f.removed).toHaveLength(1)
    expect(await store.describe(secretRef)).toMatchObject({ status: "REVOKED", version: 2 })
    await expect(store.withConsumedLease(lease, timestamp, async () => "must-not-run")).resolves.toBeUndefined()
  })

  test("rejects symlink storage paths without changing the target directory permissions", async () => {
    const f = fixture()
    const parent = await f.directory()
    active.push(parent)
    const target = path.join(parent, "user-owned")
    await mkdir(target, { mode: 0o755 })
    await chmod(target, 0o755)
    const link = path.join(parent, "alias")
    await symlink(target, link)

    await expect(createLinuxSecretServiceStore({ directory: link, backend: f.backend })).rejects.toThrow()
    expect((await stat(target)).mode & 0o777).toBe(0o755)
  })

  test("rejects a permissive or corrupted durable index before using the credential backend", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    await mkdir(path.join(directory, SECRET_STORE_DIRECTORY), { mode: 0o700 })
    const indexPath = path.join(directory, SECRET_STORE_DIRECTORY, "secret-broker-v1.json")
    await writeFile(indexPath, "not-json", { mode: 0o600 })
    await chmod(indexPath, 0o600)

    await expect(createLinuxSecretServiceStore({ directory, backend: f.backend })).rejects.toThrow()
    expect(f.credentials.size).toBe(0)
  })

  test("rejects a valid but world-readable durable index", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    await mkdir(path.join(directory, SECRET_STORE_DIRECTORY), { mode: 0o700 })
    const indexPath = path.join(directory, SECRET_STORE_DIRECTORY, "secret-broker-v1.json")
    await writeFile(indexPath, JSON.stringify({ schemaVersion: 1, secrets: {}, leases: {}, idempotency: {}, pending: {} }), { mode: 0o644 })
    await chmod(indexPath, 0o644)
    await expect(createLinuxSecretServiceStore({ directory, backend: f.backend })).rejects.toThrow()
  })

  test("recovers a stale lock after a prior process crashed", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    await mkdir(path.join(directory, SECRET_STORE_DIRECTORY), { mode: 0o700 })
    const lock = path.join(directory, SECRET_STORE_DIRECTORY, ".secret-broker-v1.lock")
    await mkdir(lock, { mode: 0o700 })
    await writeFile(path.join(lock, "owner"), "2147483646:dead-process", { mode: 0o600 })
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend })

    await expect(store.describe(secretRef)).resolves.toBeUndefined()
    expect(await stat(lock).then(() => true, () => false)).toBe(false)
  })

  test("cleans an item when durable commit fails before atomic index replacement", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let writes = 0
    const store = await createLinuxSecretServiceStore({
      directory,
      backend: f.backend,
      persistIndex: async (_directory, target, value) => {
        writes++
        if (writes === 2) throw new Error("simulated pre-rename persistence failure")
        const temporary = `${target}.test-tmp-${writes}`
        await writeFile(temporary, value, { mode: 0o600 })
        const { rename } = await import("node:fs/promises")
        await rename(temporary, target)
      },
    })

    await expect(store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")).rejects.toThrow()
    expect(f.credentials.size).toBe(1)
    await createLinuxSecretServiceStore({ directory, backend: f.backend })
    expect(f.credentials.size).toBe(0)
    const index = JSON.parse(await readFile(path.join(directory, SECRET_STORE_DIRECTORY, "secret-broker-v1.json"), "utf8"))
    expect(index.secrets).toEqual({})
    expect(index.pending).toEqual({})
  })

  test("preserves the credential when index replacement may have committed before fsync failure", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let writes = 0
    const store = await createLinuxSecretServiceStore({
      directory,
      backend: f.backend,
      persistIndex: async (_directory, target, value) => {
        writes++
        const temporary = `${target}.test-tmp-${writes}`
        await writeFile(temporary, value, { mode: 0o600 })
        const { rename } = await import("node:fs/promises")
        await rename(temporary, target)
        if (writes === 2) throw new Error("simulated post-rename fsync failure")
      },
    })

    await expect(store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")).rejects.toThrow()
    expect(f.credentials.size).toBe(1)
    expect(await store.describe(secretRef)).toEqual(metadata)
  })
  test("does not chmod the caller's existing data directory", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    await chmod(directory, 0o755)
    await createLinuxSecretServiceStore({ directory, backend: f.backend })
    expect((await stat(directory)).mode & 0o777).toBe(0o755)
  })

  test("a second opener cannot reconcile a live credential creation", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let unblock!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const wait = new Promise<void>((resolve) => { unblock = resolve })
    const backend = { ...f.backend, async createSecret(ref: SecretBrokerV1.SecretRef, version: number, bytes: Uint8Array) {
      const item = await f.backend.createSecret(ref, version, bytes)
      started()
      await wait
      return item
    } }
    const first = await createLinuxSecretServiceStore({ directory, backend })
    const put = first.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")
    await ready
    const reopened = createLinuxSecretServiceStore({ directory, backend: f.backend })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const countDuringCreate = f.credentials.size
    unblock()
    const result = await Promise.allSettled([put, reopened])
    expect(countDuringCreate).toBe(1)
    expect(result.every((entry) => entry.status === "fulfilled")).toBe(true)
    expect(f.credentials.size).toBe(1)
  })

  test("preserves an item when failed persistence leaves the index unreadable", async () => {
    const f = fixture()
    const directory = await f.directory()
    active.push(directory)
    let writes = 0
    const store = await createLinuxSecretServiceStore({ directory, backend: f.backend,
      persistIndex: async (_directory, target, value) => {
        writes++
        await writeFile(target, value, { mode: 0o600 })
        if (JSON.parse(value).secrets[secretRef]) {
          await writeFile(target, "uncertain-index", { mode: 0o600 })
          throw new Error("simulated unknown replacement outcome")
        }
      },
    })
    await expect(store.put(metadata, new TextEncoder().encode("test-only-secret"), "put_test_1")).rejects.toThrow()
    expect(writes).toBeGreaterThan(1)
    expect(f.credentials.size).toBe(1)
    expect(f.removed).toEqual([])
  })

})
