import { timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import type { SecretBrokerStore } from "./secret-broker"

export const SECRET_STORE_DIRECTORY = "horizoncode-secret-broker-v1"

const INDEX_NAME = "secret-broker-v1.json"
const MAX_INDEX_BYTES = 1024 * 1024
const LOCK_WAIT_MS = 10_000
const STALE_OWNERLESS_LOCK_MS = 2_000

export interface SecretServiceCredentialBackend {
  createSecret(secretRef: SecretBrokerV1.SecretRef, version: number, bytes: Uint8Array): Promise<string>
  getSecret(itemPath: string, secretRef: SecretBrokerV1.SecretRef, version: number): Promise<Uint8Array>
  deleteSecret(itemPath: string, secretRef: SecretBrokerV1.SecretRef, version: number): Promise<void>
  deleteOrphanedSecret(secretRef: SecretBrokerV1.SecretRef, version: number): Promise<void>
  close?(): Promise<void>
}

type StoredSecret = {
  metadata: SecretBrokerV1.MetadataV1
  itemPath: string
}

type StoredLease = {
  lease: SecretBrokerV1.UseLeaseV1
  state: SecretBrokerV1.UseLeaseV1["state"]
  consumedAt?: string
}

type Index = {
  schemaVersion: 1
  secrets: Record<string, StoredSecret>
  leases: Record<string, StoredLease>
  idempotency: Record<string, { secretRef: SecretBrokerV1.SecretRef }>
  pending: Record<string, {
    metadata: SecretBrokerV1.MetadataV1
    idempotencyKey: string
    itemPath?: string
    previous?: StoredSecret
  }>
}

const emptyIndex = (): Index => ({ schemaVersion: 1, secrets: {}, leases: {}, idempotency: {}, pending: {} })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeIndex(value: unknown): Index {
  if (
    !isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.secrets) ||
    !isRecord(value.leases) || !isRecord(value.idempotency) ||
    (value.pending !== undefined && !isRecord(value.pending))
  ) throw new Error("SecretBroker index is invalid")

  const secrets: Index["secrets"] = {}
  for (const [key, raw] of Object.entries(value.secrets)) {
    if (!isRecord(raw) || typeof raw.itemPath !== "string" || raw.itemPath.length > 1024) {
      throw new Error("SecretBroker index is invalid")
    }
    const metadata = Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)(raw.metadata)
    if (metadata.secretRef !== key) throw new Error("SecretBroker index is invalid")
    secrets[key] = { metadata, itemPath: raw.itemPath }
  }

  const leases: Index["leases"] = {}
  for (const [key, raw] of Object.entries(value.leases)) {
    if (!isRecord(raw) || !["ISSUED", "CONSUMED", "EXPIRED", "REVOKED"].includes(String(raw.state))) {
      throw new Error("SecretBroker index is invalid")
    }
    const lease = Schema.decodeUnknownSync(SecretBrokerV1.UseLeaseV1)(raw.lease)
    if (lease.leaseId !== key) throw new Error("SecretBroker index is invalid")
    leases[key] = {
      lease,
      state: raw.state as SecretBrokerV1.UseLeaseV1["state"],
      ...(typeof raw.consumedAt === "string" ? { consumedAt: raw.consumedAt } : {}),
    }
  }

  const idempotency: Index["idempotency"] = {}
  for (const [key, raw] of Object.entries(value.idempotency)) {
    if (!isRecord(raw) || typeof raw.secretRef !== "string" || !secrets[raw.secretRef]) {
      throw new Error("SecretBroker index is invalid")
    }
    idempotency[key] = { secretRef: raw.secretRef as SecretBrokerV1.SecretRef }
  }
  const pending: Index["pending"] = {}
  for (const [key, raw] of Object.entries(value.pending ?? {})) {
    if (!isRecord(raw) || typeof raw.idempotencyKey !== "string" ||
        (raw.itemPath !== undefined && typeof raw.itemPath !== "string")) {
      throw new Error("SecretBroker index is invalid")
    }
    const pendingMetadata = Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)(raw.metadata)
    let previous: StoredSecret | undefined
    if (raw.previous !== undefined) {
      if (!isRecord(raw.previous) || typeof raw.previous.itemPath !== "string" || raw.previous.itemPath.length > 1024) {
        throw new Error("SecretBroker index is invalid")
      }
      const previousMetadata = Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)(raw.previous.metadata)
      if (previousMetadata.secretRef !== pendingMetadata.secretRef || previousMetadata.version + 1 !== pendingMetadata.version) {
        throw new Error("SecretBroker index is invalid")
      }
      previous = { metadata: previousMetadata, itemPath: raw.previous.itemPath }
    }
    pending[key] = {
      metadata: pendingMetadata,
      idempotencyKey: raw.idempotencyKey,
      ...(typeof raw.itemPath === "string" ? { itemPath: raw.itemPath } : {}),
      ...(previous ? { previous } : {}),
    }
  }
  return { schemaVersion: 1, secrets, leases, idempotency, pending }
}

async function ensurePrivateDirectory(directory: string) {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("SecretBroker cannot verify the storage owner on this platform")
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (index !== parts.length - 1) throw new Error("SecretBroker data directory must already exist")
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      info = await lstat(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0)) {
      throw new Error("SecretBroker storage path has an invalid type or owner")
    }
    // Inspect existing parents without changing caller-owned permissions.
    // Only this application-private child is created, and unsafe existing
    // children are rejected rather than silently repaired.
    if (index === parts.length - 1) {
      if (info.uid !== uid) throw new Error("SecretBroker storage directory is not owned by this user")
      if ((info.mode & 0o077) !== 0) throw new Error("SecretBroker storage directory is not private")
    }
  }
}

function processExists(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function acquireDirectoryLock(lockDirectory: string) {
  const deadline = Date.now() + LOCK_WAIT_MS
  const ownerToken = `${process.pid}:${crypto.randomUUID()}`
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
      const handle = await open(path.join(lockDirectory, "owner"), "wx", 0o600)
      try {
        await handle.writeFile(ownerToken, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      return async () => {
        const current = await readFile(path.join(lockDirectory, "owner"), "utf8").catch(() => "")
        if (current === ownerToken) await rm(lockDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }

    let stale = false
    try {
      const owner = (await readFile(path.join(lockDirectory, "owner"), "utf8")).split(":", 1)[0]
      const pid = Number(owner)
      if (Number.isSafeInteger(pid) && pid > 0) stale = !processExists(pid)
      else {
        const info = await lstat(lockDirectory).catch(() => undefined)
        stale = !!info && Date.now() - info.mtimeMs > STALE_OWNERLESS_LOCK_MS
      }
    } catch {
      const info = await lstat(lockDirectory).catch(() => undefined)
      stale = !!info && Date.now() - info.mtimeMs > STALE_OWNERLESS_LOCK_MS
    }
    if (stale) {
      const quarantine = `${lockDirectory}.stale-${process.pid}-${crypto.randomUUID()}`
      await rename(lockDirectory, quarantine).then(() => rm(quarantine, { recursive: true, force: true })).catch(() => undefined)
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)))
  }
  throw new Error("SecretBroker storage lock is unavailable")
}

async function atomicWrite(directory: string, target: string, value: string) {
  const temporary = path.join(directory, `.secret-broker-${process.pid}-${crypto.randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
    const dirHandle = await open(directory, "r")
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readIndex(file: string): Promise<Index> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex()
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("SecretBroker index has an invalid type, owner, or permission mode")
    }
    if (info.size > MAX_INDEX_BYTES) throw new Error("SecretBroker index exceeds its size limit")
    const raw = await handle.readFile({ encoding: "utf8" })
    return decodeIndex(JSON.parse(raw))
  } finally {
    await handle.close()
  }
}

export async function createLinuxSecretServiceStore(options: {
  directory: string
  backend: SecretServiceCredentialBackend
  now?: () => Date
  /** Narrow persistence fault-injection seam for crash-recovery contract tests. */
  persistIndex?: (directory: string, target: string, value: string) => Promise<void>
}): Promise<SecretBrokerStore & { close?: () => Promise<void> }> {
  if (process.platform !== "linux") throw new Error("Linux Secret Service is unavailable on this platform")
  const directory = path.join(path.resolve(options.directory), SECRET_STORE_DIRECTORY)
  await ensurePrivateDirectory(directory)
  const indexPath = path.join(directory, INDEX_NAME)
  const lockPath = path.join(directory, ".secret-broker-v1.lock")
  const persist = options.persistIndex ?? atomicWrite

  const transact = async <Value>(operation: (index: Index) => Promise<{ value: Value; changed?: boolean }>): Promise<Value> => {
    const release = await acquireDirectoryLock(lockPath)
    try {
      const index = await readIndex(indexPath)
      const result = await operation(index)
      if (result.changed) await persist(directory, indexPath, JSON.stringify(index))
      return result.value
    } finally {
      await release()
    }
  }

  const recoverPending = async () => transact(async (index) => {
    const entries = Object.entries(index.pending)
    for (const [id, pending] of entries) {
      const current = index.secrets[pending.metadata.secretRef]
      const replacementIsActive = !!pending.itemPath &&
        current?.itemPath === pending.itemPath && current.metadata.version === pending.metadata.version
      if (replacementIsActive) {
        // Pointer activation reached disk. Finish retiring the prior item;
        // deleteSecret is required to be idempotent by the backend contract.
        if (pending.previous) {
          await options.backend.deleteSecret(
            pending.previous.itemPath,
            pending.previous.metadata.secretRef,
            pending.previous.metadata.version,
          )
        }
      } else if (pending.itemPath) {
        await options.backend.deleteSecret(pending.itemPath, pending.metadata.secretRef, pending.metadata.version)
      } else {
        await options.backend.deleteOrphanedSecret(pending.metadata.secretRef, pending.metadata.version)
      }
      delete index.pending[id]
    }
    // Revocation commits before deleting the OS credential item. If backend
    // deletion failed after that commit, retry it on reopen; revoked records
    // remain non-readable and deleteSecret is required to be idempotent.
    for (const secret of Object.values(index.secrets)) {
      if (secret.metadata.status === "REVOKED") {
        await options.backend.deleteSecret(secret.itemPath, secret.metadata.secretRef, secret.metadata.version - 1)
      }
    }
    return { value: undefined, ...(entries.length === 0 ? {} : { changed: true }) }
  })

  await recoverPending()

  return {
    async put(metadata, bytes, idempotencyKey, expectedVersion) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) {
        throw new Error("Secret value is outside the supported bound")
      }
      return transact(async (index) => {
        const prior = index.idempotency[idempotencyKey]
        if (prior) {
          const previous = index.secrets[prior.secretRef]
          if (!previous || previous.metadata.status !== "AVAILABLE" || previous.metadata.providerId !== metadata.providerId) {
            throw new Error("SecretBroker idempotency key conflict")
          }
          const stored = await options.backend.getSecret(previous.itemPath, previous.metadata.secretRef, previous.metadata.version)
          try {
            if (stored.byteLength !== bytes.byteLength || !timingSafeEqual(bytes, stored)) {
              throw new Error("SecretBroker idempotency key conflict")
            }
          } finally {
            stored.fill(0)
          }
          return { value: previous.metadata }
        }
        const existing = index.secrets[metadata.secretRef]
        if (
          (expectedVersion === undefined && (existing !== undefined || metadata.version !== 1)) ||
          (expectedVersion !== undefined &&
            (!existing ||
              existing.metadata.status !== "AVAILABLE" ||
              existing.metadata.providerId !== metadata.providerId ||
              existing.metadata.version !== expectedVersion ||
              metadata.version !== expectedVersion + 1))
        ) {
          throw new Error("Secret reference version conflict")
        }
        if (Object.values(index.pending).some((pending) =>
          pending.metadata.secretRef === metadata.secretRef || pending.idempotencyKey === idempotencyKey)) {
          throw new Error("Secret reference or idempotency key is pending reconciliation")
        }
        const pendingId = crypto.randomUUID()
        index.pending[pendingId] = {
          metadata,
          idempotencyKey,
          ...(existing ? { previous: existing } : {}),
        }
        // Journal before entering D-Bus. Keep the lock through creation and
        // commit so another store opener cannot reconcile this live write.
        await persist(directory, indexPath, JSON.stringify(index))
        const itemPath = await options.backend.createSecret(metadata.secretRef, metadata.version, bytes)
        index.pending[pendingId] = { ...index.pending[pendingId]!, itemPath }
        index.secrets[metadata.secretRef] = { metadata, itemPath }
        index.idempotency[idempotencyKey] = { secretRef: metadata.secretRef }
        if (existing) {
          for (const record of Object.values(index.leases)) {
            if (record.lease.secretRef === metadata.secretRef && record.state === "ISSUED") record.state = "REVOKED"
          }
        }
        // Atomically activate the replacement while preserving a recovery
        // journal. If the write outcome is uncertain, recovery can inspect the
        // durable pointer to decide whether the old or new item is current.
        await persist(directory, indexPath, JSON.stringify(index))
        if (existing) {
          await options.backend.deleteSecret(existing.itemPath, metadata.secretRef, existing.metadata.version)
        }
        delete index.pending[pendingId]
        await persist(directory, indexPath, JSON.stringify(index))
        return { value: metadata }
      })
    },

    async describe(secretRef) {
      return transact(async (index) => ({ value: index.secrets[secretRef]?.metadata }))
    },

    async listByProviderIds(providerIds) {
      if (providerIds.length > 16) throw new Error("SecretBroker provider lookup exceeds its bound")
      const providers = new Set(providerIds)
      return transact(async (index) => {
        const matches = Object.values(index.secrets)
          .map((record) => record.metadata)
          .filter((metadata) => providers.has(metadata.providerId))
        if (matches.length > 256) throw new Error("SecretBroker provider lookup exceeds its result bound")
        return { value: matches }
      })
    },

    async putLease(lease, expectedSecretVersion) {
      await transact(async (index) => {
        const secret = index.secrets[lease.secretRef]
        if (!secret || secret.metadata.status !== "AVAILABLE" || secret.metadata.version !== expectedSecretVersion ||
            lease.secretVersion !== expectedSecretVersion || lease.state !== "ISSUED" || lease.maxRequests !== 1) {
          throw new Error("SecretBroker lease does not match the current secret")
        }
        if (index.leases[lease.leaseId]) throw new Error("SecretBroker lease ID already exists")
        index.leases[lease.leaseId] = { lease, state: "ISSUED" }
        return { value: undefined, changed: true }
      })
    },

    async withConsumedLease<Value>(
      lease: SecretBrokerV1.UseLeaseV1,
      consumedAt: string,
      use: (metadata: SecretBrokerV1.MetadataV1, bytes: Uint8Array) => Promise<Value>,
    ) {
      const delivery = await transact(async (index) => {
        const current = index.leases[lease.leaseId]
        const secret = index.secrets[lease.secretRef]
        if (!current || !secret || current.state !== "ISSUED" ||
            JSON.stringify(current.lease) !== JSON.stringify(lease) ||
            secret.metadata.status !== "AVAILABLE" || secret.metadata.version !== lease.secretVersion ||
            Date.parse(lease.expiresAt) <= Date.parse(consumedAt)) {
          return { value: undefined }
        }
        current.state = "CONSUMED"
        current.consumedAt = consumedAt
        // Commit the one-use transition before fetching bytes or entering the
        // transport callback. A crash cannot make this lease replayable.
        await persist(directory, indexPath, JSON.stringify(index))
        const bytes = await options.backend.getSecret(secret.itemPath, secret.metadata.secretRef, secret.metadata.version)
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) {
          bytes?.fill?.(0)
          throw new Error("Secret Service returned an invalid secret value")
        }
        return { value: { metadata: secret.metadata, bytes } }
      })
      if (!delivery) return undefined
      try {
        return await use(delivery.metadata, delivery.bytes)
      } finally {
        delivery.bytes.fill(0)
      }
    },

    async revoke(secretRef, expectedVersion, nextVersion, receipt) {
      const removedPath = await transact(async (index) => {
        const secret = index.secrets[secretRef]
        if (!secret || secret.metadata.status !== "AVAILABLE" || secret.metadata.version !== expectedVersion ||
            nextVersion !== expectedVersion + 1 || receipt.secretRef !== secretRef || receipt.revokedVersion !== nextVersion) {
          return { value: undefined }
        }
        secret.metadata = { ...secret.metadata, status: "REVOKED", version: nextVersion, updatedAt: receipt.revokedAt }
        for (const record of Object.values(index.leases)) {
          if (record.lease.secretRef === secretRef && record.state === "ISSUED") record.state = "REVOKED"
        }
        await persist(directory, indexPath, JSON.stringify(index))
        return { value: secret.itemPath }
      })
      if (!removedPath) return false
      // Access is already revoked durably; deletion failure leaves no readable
      // SecretRef but is surfaced as unavailable for repair/cleanup.
      await options.backend.deleteSecret(removedPath, secretRef, expectedVersion)
      return true
    },
    close: options.backend.close,
  }
}
