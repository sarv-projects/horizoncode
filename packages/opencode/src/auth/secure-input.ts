import { randomBytes } from "node:crypto"

const MAX_SECRET_BYTES = 16 * 1024
const MAX_PENDING_HANDLES = 16
const DEFAULT_TTL_MS = 30_000

export class SecureInputError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "EXPIRED" | "INVALID", message: string) {
    super(message)
    this.name = "SecureInputError"
  }
}

/**
 * Process-local, one-use byte channel. Handles are opaque random references;
 * they are never persisted and must only be passed inside the trusted host.
 */
export class SecureInputVault {
  #entries = new Map<string, { bytes: Uint8Array; expiresAt: number }>()

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

  issue(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SECRET_BYTES) {
      bytes?.fill?.(0)
      throw new SecureInputError("INVALID", "Secret input is empty or exceeds the supported bound")
    }
    this.#removeExpired(this.now())
    if (this.#entries.size >= MAX_PENDING_HANDLES) {
      bytes.fill(0)
      throw new SecureInputError("UNAVAILABLE", "The pending secure input limit has been reached")
    }
    const owned = bytes.slice()
    bytes.fill(0)
    const handle = this.newHandle()
    if (!handle || this.#entries.has(handle)) {
      owned.fill(0)
      throw new SecureInputError("UNAVAILABLE", "Secure input handle could not be allocated")
    }
    this.#entries.set(handle, { bytes: owned, expiresAt: this.now() + this.ttlMs })
    return handle
  }

  async consume(handle: string): Promise<Uint8Array> {
    if (typeof handle !== "string" || handle.length < 32 || handle.length > 128) {
      throw new SecureInputError("INVALID", "Secure input handle is invalid")
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
    this.#entries.delete(handle)
    if (!entry) throw new SecureInputError("UNAVAILABLE", "Secure input handle is unavailable or already consumed")
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
  stdin.setRawMode(true)
  try {
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
      }
      stdin.on("data", onData)
      stdin.resume()
    })
  } finally {
    stdin.setRawMode(priorRaw ?? false)
    if (priorPaused) stdin.pause()
  }
}
