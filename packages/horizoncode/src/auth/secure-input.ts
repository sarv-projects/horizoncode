import { randomBytes } from "node:crypto"

const MAX_SECRET_BYTES = 16 * 1024
const MAX_PENDING_HANDLES = 16
const DEFAULT_TTL_MS = 30_000
const MAX_BINDING_TEXT = 256

export type SecureInputOperation = "put" | "rotate" | "revoke"

/**
 * Exact write intent a native credential handle is issued for. HostKernel
 * grants bind these same fields; callers must never widen or recompute them
 * from request bodies.
 */
export interface SecureInputBinding {
  readonly principalRef: string
  readonly providerId: string
  readonly operation: SecureInputOperation
  readonly expectedVersion?: number
  readonly idempotencyKey: string
  /** Exact HostKernel target ref; required whenever a rotation/revocation is intended. */
  readonly secretRef?: string
}

export class SecureInputError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "EXPIRED" | "INVALID" | "MISMATCH", message: string) {
    super(message)
    this.name = "SecureInputError"
  }
}

const isBoundedText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_BINDING_TEXT &&
  !/[\u0000-\u001f\u007f]/.test(value)

const isExpectedVersion = (value: unknown): value is number | undefined =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)

function isSecureInputBinding(value: unknown): value is SecureInputBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  return (
    isBoundedText(binding.principalRef) &&
    isBoundedText(binding.providerId) &&
    (binding.operation === "put" || binding.operation === "rotate" || binding.operation === "revoke") &&
    isExpectedVersion(binding.expectedVersion) &&
    isBoundedText(binding.idempotencyKey) &&
    (binding.secretRef === undefined || isBoundedText(binding.secretRef))
  )
}

function sameBinding(left: SecureInputBinding, right: SecureInputBinding): boolean {
  return (
    left.principalRef === right.principalRef &&
    left.providerId === right.providerId &&
    left.operation === right.operation &&
    left.expectedVersion === right.expectedVersion &&
    left.idempotencyKey === right.idempotencyKey &&
    left.secretRef === right.secretRef
  )
}

function ownedBinding(binding: SecureInputBinding): SecureInputBinding {
  return Object.freeze({
    principalRef: binding.principalRef,
    providerId: binding.providerId,
    operation: binding.operation,
    ...(binding.expectedVersion === undefined ? {} : { expectedVersion: binding.expectedVersion }),
    idempotencyKey: binding.idempotencyKey,
    ...(binding.secretRef === undefined ? {} : { secretRef: binding.secretRef }),
  })
}

/**
 * Process-local, one-use byte channel. Handles are opaque random references;
 * they are never persisted and must only be passed inside the trusted host.
 * Each handle is bound to the exact principal/provider/operation/version/
 * target-ref/idempotency intent and can only be consumed with the same binding. A
 * mismatched consume is denied without consuming the legitimate handle.
 */
export class SecureInputVault {
  #entries = new Map<string, { bytes: Uint8Array; binding: SecureInputBinding; expiresAt: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly newHandle: () => string = () => randomBytes(32).toString("base64url"),
  ) {}

  #removeExpired(now: number) {
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt > now) continue
      entry.bytes.fill(0)
      this.#entries.delete(handle)
    }
  }

  issue(bytes: Uint8Array, binding: SecureInputBinding): string {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SECRET_BYTES) {
      bytes?.fill?.(0)
      throw new SecureInputError("INVALID", "Secret input is empty or exceeds the supported bound")
    }
    if (!isSecureInputBinding(binding)) {
      bytes.fill(0)
      throw new SecureInputError("INVALID", "Secret input binding is invalid")
    }
    try {
      this.#removeExpired(this.now())
    } catch (error) {
      bytes.fill(0)
      throw error
    }
    if (this.#entries.size >= MAX_PENDING_HANDLES) {
      bytes.fill(0)
      throw new SecureInputError("UNAVAILABLE", "The pending secure input limit has been reached")
    }
    const owned = bytes.slice()
    bytes.fill(0)
    try {
      const handle = this.newHandle()
      if (!handle || this.#entries.has(handle)) {
        throw new SecureInputError("UNAVAILABLE", "Secure input handle could not be allocated")
      }
      const expiresAt = this.now() + this.ttlMs
      this.#entries.set(handle, { bytes: owned, binding: ownedBinding(binding), expiresAt })
      return handle
    } catch (error) {
      owned.fill(0)
      throw error
    }
  }

  async consume(handle: string, binding: SecureInputBinding): Promise<Uint8Array> {
    if (typeof handle !== "string" || handle.length < 32 || handle.length > 128) {
      throw new SecureInputError("INVALID", "Secure input handle is invalid")
    }
    if (!isSecureInputBinding(binding)) {
      throw new SecureInputError("INVALID", "Secret input binding is invalid")
    }
    const entry = this.#entries.get(handle)
    const now = this.now()
    if (entry && entry.expiresAt <= now) {
      this.#entries.delete(handle)
      entry.bytes.fill(0)
      this.#removeExpired(now)
      throw new SecureInputError("EXPIRED", "Secure input handle has expired")
    }
    this.#removeExpired(now)
    if (!entry) throw new SecureInputError("UNAVAILABLE", "Secure input handle is unavailable or already consumed")
    // A foreign or mismatched binding must not consume or zeroize the handle:
    // the legitimate caller keeps its one-use entry until the TTL expires.
    if (!sameBinding(entry.binding, binding)) {
      throw new SecureInputError("MISMATCH", "Secure input binding does not match the issued handle")
    }
    this.#entries.delete(handle)
    return entry.bytes
  }

  close() {
    for (const entry of this.#entries.values()) entry.bytes.fill(0)
    this.#entries.clear()
  }
}

export async function readSecureTTYInput(options: {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  prompt?: string
} = {}): Promise<Uint8Array> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function" || !stdout.isTTY) {
    throw new SecureInputError("UNAVAILABLE", "Secure credential entry requires an interactive terminal")
  }
  const priorRaw = stdin.isRaw
  const priorPaused = stdin.isPaused()
  const buffer = Buffer.alloc(MAX_SECRET_BYTES)
  let length = 0
  stdout.write(options.prompt ?? "Credential: ")
  try {
    stdin.setRawMode(true)
    return await new Promise<Uint8Array>((resolve, reject) => {
      const finish = (error?: Error) => {
        stdin.off("data", onData)
        stdout.write("\n")
        if (error) {
          buffer.fill(0)
          reject(error)
        } else {
          const result = Uint8Array.from(buffer.subarray(0, length))
          buffer.fill(0)
          resolve(result)
        }
      }
      const onData = (input: Buffer | string) => {
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
        try {
          for (const byte of bytes) {
            if (byte === 0x03) {
              finish(new SecureInputError("UNAVAILABLE", "Credential entry cancelled"))
              return
            }
            if (byte === 0x0d || byte === 0x0a) {
              if (length === 0) {
                finish(new SecureInputError("INVALID", "Credential is empty"))
                return
              }
              finish()
              return
            }
            if (byte === 0x7f || byte === 0x08) {
              if (length > 0) {
                length--
                while (length > 0 && (buffer[length] & 0xc0) === 0x80) length--
                buffer.fill(0, length)
              }
              continue
            }
            if (byte < 0x20 || byte === 0x7f) continue
            if (length >= MAX_SECRET_BYTES) {
              finish(new SecureInputError("INVALID", "Credential exceeds the supported bound"))
              return
            }
            buffer[length] = byte
            length++
          }
        } finally {
          if (!Buffer.isBuffer(input)) bytes.fill(0)
        }
      }
      try {
        stdin.on("data", onData)
        stdin.resume()
      } catch (error) {
        stdin.off("data", onData)
        buffer.fill(0)
        reject(error)
      }
    })
  } finally {
    stdin.setRawMode(priorRaw ?? false)
    if (priorPaused) stdin.pause()
  }
}
