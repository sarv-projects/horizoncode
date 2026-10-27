import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SecureInputVault, type SecureInputBinding } from "../../src/auth/secure-input"
import { createCredentialBrokerRuntime } from "../../src/auth/credential-broker-runtime"
import type { SecretServiceCredentialBackend } from "../../src/auth/secret-service-store"
import { SECRET_STORE_DIRECTORY } from "../../src/auth/secret-service-store"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function keyring() {
  const items = new Map<string, Uint8Array>()
  return {
    items,
    backend: {
      async createSecret(secretRef, version, bytes) {
        const itemPath = `${secretRef}:${version}`
        items.set(itemPath, bytes.slice())
        return itemPath
      },
      async getSecret(itemPath) {
        const bytes = items.get(itemPath)
        if (!bytes) throw new Error("missing item")
        return bytes.slice()
      },
      async deleteSecret(itemPath) {
        items.get(itemPath)?.fill(0)
        items.delete(itemPath)
      },
      async deleteOrphanedSecret(secretRef, version) {
        const itemPath = `${secretRef}:${version}`
        items.get(itemPath)?.fill(0)
        items.delete(itemPath)
      },
    } satisfies SecretServiceCredentialBackend,
  }
}

const secureBinding = (suffix: string, rotation?: { expectedVersion: number }): SecureInputBinding => ({
  principalRef: "host-os:local",
  providerId: "example-provider",
  operation: rotation ? "rotate" : "put",
  ...(rotation ? { expectedVersion: rotation.expectedVersion } : {}),
  idempotencyKey: `credential-${suffix}`,
})

function request(secureInputHandle: string, suffix: string, rotation?: { secretRef: SecretBrokerV1.SecretRef; expectedVersion: number }) {
  return {
    schemaVersion: 1 as const,
    providerId: "example-provider",
    secureInputHandle,
    label: "Example API",
    idempotencyKey: `credential-${suffix}`,
    ...rotation,
  } satisfies SecretBrokerV1.PutRequestV1
}

describe("lazy Linux credential broker runtime", () => {
  test("does no keyring or disk work until an explicit credential operation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    let opens = 0
    const runtime = createCredentialBrokerRuntime({
      directory,
      secureInput: new SecureInputVault(),
      openBackend: async () => {
        opens++
        return keyring().backend
      },
    })
    expect(opens).toBe(0)
    expect(await import("node:fs/promises").then((fs) => fs.readdir(directory))).toEqual([])
    await runtime.close()
    expect(opens).toBe(0)
  })

  test("stores and rotates opaque input, survives restart, and exposes metadata only", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    const input = new SecureInputVault()
    const keyringState = keyring()
    const makeRuntime = () =>
      createCredentialBrokerRuntime({ directory, secureInput: input, openBackend: async () => keyringState.backend })

    const first = makeRuntime()
    const firstBytes = new TextEncoder().encode("first-secret-value")
    const created = await first.put(request(input.issue(firstBytes, secureBinding("create")), "create"), secureBinding("create"))
    expect(firstBytes.every((byte) => byte === 0)).toBe(true)
    expect(created).toMatchObject({ providerId: "example-provider", status: "AVAILABLE", version: 1 })
    expect(JSON.stringify(created)).not.toContain("first-secret-value")

    const rotationBytes = new TextEncoder().encode("second-secret-value")
    const rotateBinding = secureBinding("rotate", { expectedVersion: created.version })
    const rotated = await first.put(request(input.issue(rotationBytes, rotateBinding), "rotate", {
      secretRef: created.secretRef,
      expectedVersion: created.version,
    }), rotateBinding)
    expect(rotated.secretRef).toBe(created.secretRef)
    expect(rotated.version).toBe(2)
    expect(rotationBytes.every((byte) => byte === 0)).toBe(true)
    const staleBinding = secureBinding("stale", { expectedVersion: 1 })
    await expect(first.put(request(input.issue(new TextEncoder().encode("stale"), staleBinding), "stale", {
      secretRef: created.secretRef,
      expectedVersion: 1,
    }), staleBinding)).rejects.toMatchObject({ code: "CONFLICT" })

    await first.close()
    const restarted = makeRuntime()
    expect(await restarted.describe(created.secretRef)).toMatchObject({ secretRef: created.secretRef, version: 2 })
    const receipt = await restarted.revoke(created.secretRef, 2)
    expect(receipt).toMatchObject({ secretRef: created.secretRef, revokedVersion: 3 })
    expect(JSON.stringify(receipt)).not.toContain("second-secret-value")
    await restarted.close()
    expect(keyringState.items.size).toBe(0)
  })

  test("issues only an opaque one-use provider credential lease from trusted transport facts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    const input = new SecureInputVault()
    const runtime = createCredentialBrokerRuntime({ directory, secureInput: input, openBackend: async () => keyring().backend })
    const metadata = await runtime.put(request(input.issue(new TextEncoder().encode("provider-secret"), secureBinding("lease")), "lease"), secureBinding("lease"))
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const trusted = {
      requesterRef: "attempt_test",
      providerId: "example-provider",
      operationDigest: `sha256:${"a".repeat(64)}` as SecretBrokerV1.SecretOperationDigest,
      destination: "https://api.example.test/v1/responses",
      purpose: "PROVIDER_REQUEST" as const,
      maxExpiresAt: expiresAt,
      runRef: "run_test",
      profileRef: "profile_test",
    }
    const lease = await runtime.authorizeUse({
      schemaVersion: 1,
      secretRef: metadata.secretRef,
      providerId: "example-provider",
      operationDigest: trusted.operationDigest,
      destination: trusted.destination,
      purpose: trusted.purpose,
      runRef: trusted.runRef,
      profileRef: trusted.profileRef,
      expiresAt,
      maxRequests: 1,
    }, trusted)
    expect(lease).toMatchObject({
      secretRef: metadata.secretRef,
      requesterRef: trusted.requesterRef,
      providerId: trusted.providerId,
      state: "ISSUED",
      maxRequests: 1,
    })
    expect(JSON.stringify(lease)).not.toContain("provider-secret")
    await runtime.close()
  })

  test("shares one concurrent lazy open and retries after an open failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    const input = new SecureInputVault()
    const state = keyring()
    let opens = 0
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve))
    const runtime = createCredentialBrokerRuntime({
      directory,
      secureInput: input,
      openBackend: async () => {
        opens++
        if (opens === 1) throw new Error("temporary keyring outage")
        if (opens === 2) await openGate
        return state.backend
      },
    })
    await expect(runtime.describe("secret_missing" as SecretBrokerV1.SecretRef)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    const first = runtime.put(request(input.issue(new TextEncoder().encode("secret-a"), secureBinding("concurrent-a")), "concurrent-a"), secureBinding("concurrent-a"))
    const second = runtime.put(request(input.issue(new TextEncoder().encode("secret-b"), secureBinding("concurrent-b")), "concurrent-b"), secureBinding("concurrent-b"))
    await Bun.sleep(1)
    expect(opens).toBe(2)
    releaseOpen()
    const [createdA, createdB] = await Promise.all([first, second])
    expect(createdA.secretRef).not.toBe(createdB.secretRef)
    expect(opens).toBe(2)
    await runtime.close()
  })

  test("close waits for an admitted broker operation and closes the backend once", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    const input = new SecureInputVault()
    const state = keyring()
    let enterCreate!: () => void
    let releaseCreate!: () => void
    const entered = new Promise<void>((resolve) => (enterCreate = resolve))
    const createGate = new Promise<void>((resolve) => (releaseCreate = resolve))
    let closes = 0
    const backend = {
      ...state.backend,
      async createSecret(secretRef: string, version: number, bytes: Uint8Array) {
        enterCreate()
        await createGate
        return state.backend.createSecret(secretRef as SecretBrokerV1.SecretRef, version, bytes)
      },
      async close() { closes++ },
    } satisfies SecretServiceCredentialBackend & { close: () => Promise<void> }
    const runtime = createCredentialBrokerRuntime({ directory, secureInput: input, openBackend: async () => backend })
    const put = runtime.put(request(input.issue(new TextEncoder().encode("in-flight-secret"), secureBinding("close-race")), "close-race"), secureBinding("close-race"))
    await entered
    const close = runtime.close()
    await Bun.sleep(1)
    expect(closes).toBe(0)
    releaseCreate()
    await put
    await close
    await runtime.close()
    expect(closes).toBe(1)
  })

  test("maps unavailable OS keyring and unsafe storage paths to a typed generic error", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    const input = new SecureInputVault()
    const runtime = createCredentialBrokerRuntime({
      directory,
      secureInput: input,
      openBackend: async () => {
        throw new Error("private D-Bus details")
      },
    })
    await expect(runtime.describe("secret_missing" as SecretBrokerV1.SecretRef)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Secure credential storage is unavailable",
    })
    await runtime.close()
  })

  test("fails closed when the private metadata directory is not a directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "horizon-credential-runtime-"))
    roots.push(directory)
    await writeFile(path.join(directory, SECRET_STORE_DIRECTORY), "unsafe", { mode: 0o600 })
    const input = new SecureInputVault()
    const runtime = createCredentialBrokerRuntime({
      directory,
      secureInput: input,
      openBackend: async () => keyring().backend,
    })
    await expect(runtime.describe("secret_missing" as SecretBrokerV1.SecretRef)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Secure credential storage is unavailable",
    })
    await runtime.close()
  })
})
