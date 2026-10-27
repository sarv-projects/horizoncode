import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { SecureInputVault, readSecureTTYInput, type SecureInputBinding } from "../../src/auth/secure-input"

const bytes = (value: string) => new TextEncoder().encode(value)

const secureBinding = (overrides: Partial<SecureInputBinding> = {}): SecureInputBinding => ({
  principalRef: "host-os:local",
  providerId: "test-provider",
  operation: "put",
  idempotencyKey: "put_test",
  ...overrides,
})

test("secure input handles are random, one-use, short-lived, and erase transferred buffers", async () => {
  let clock = 100
  const supplied = bytes("native-input")
  const vault = new SecureInputVault(() => clock, 5, () => "h".repeat(48))
  const binding = secureBinding()
  const handle = vault.issue(supplied, binding)
  expect(supplied.every((byte) => byte === 0)).toBe(true)
  expect(await vault.consume(handle, binding)).toEqual(bytes("native-input"))
  await expect(vault.consume(handle, binding)).rejects.toMatchObject({ code: "UNAVAILABLE" })

  const expired = vault.issue(bytes("expired"), binding)
  clock += 5
  await expect(vault.consume(expired, binding)).rejects.toMatchObject({ code: "EXPIRED" })
  vault.close()
})

test("secure input binds handles to the exact principal, provider, operation, version, and idempotency key", async () => {
  const vault = new SecureInputVault(() => 100, 30_000)
  const binding = secureBinding()
  const handle = vault.issue(bytes("bound-secret"), binding)

  const denied: SecureInputBinding[] = [
    { ...binding, principalRef: "server-auth:other" },
    { ...binding, providerId: "other-provider" },
    { ...binding, operation: "revoke" },
    { ...binding, idempotencyKey: "put_other" },
    { ...binding, operation: "rotate", expectedVersion: 1 },
  ]
  for (const attempt of denied) {
    await expect(vault.consume(handle, attempt)).rejects.toMatchObject({ code: "MISMATCH" })
  }

  // Every mismatch above must leave the legitimate handle intact.
  expect(await vault.consume(handle, { ...binding })).toEqual(bytes("bound-secret"))
  await expect(vault.consume(handle, binding)).rejects.toMatchObject({ code: "UNAVAILABLE" })
})

test("secure input denies a mismatched expectedVersion without consuming the legitimate rotation handle", async () => {
  const vault = new SecureInputVault(() => 100, 30_000)
  const binding = secureBinding({ operation: "rotate", expectedVersion: 1 })
  const handle = vault.issue(bytes("rotated-secret"), binding)

  await expect(vault.consume(handle, { ...binding, expectedVersion: 2 })).rejects.toMatchObject({ code: "MISMATCH" })
  await expect(vault.consume(handle, { ...binding, expectedVersion: undefined })).rejects.toMatchObject({
    code: "MISMATCH",
  })
  expect(await vault.consume(handle, { ...binding })).toEqual(bytes("rotated-secret"))
})

test("secure input rejects an invalid binding before storing bytes", () => {
  const vault = new SecureInputVault(() => 100, 30_000)
  const supplied = bytes("must-be-zeroed")
  expect(() => vault.issue(supplied, secureBinding({ principalRef: "" }))).toThrow()
  expect(supplied.every((byte) => byte === 0)).toBe(true)

  const oversized = bytes("too-big")
  expect(() => vault.issue(oversized, secureBinding({ providerId: "p".repeat(257) }))).toThrow()
  expect(oversized.every((byte) => byte === 0)).toBe(true)
  vault.close()
})

test("secure input erases its owned copy when handle allocation throws", () => {
  const supplied = bytes("credential-bytes")
  const owned = bytes("credential-bytes")
  Object.defineProperty(supplied, "slice", { value: () => owned })
  const vault = new SecureInputVault(Date.now, 30_000, () => {
    throw new Error("random handle allocation failed")
  })

  expect(() => vault.issue(supplied, secureBinding())).toThrow("random handle allocation failed")
  expect(supplied.every((byte) => byte === 0)).toBe(true)
  expect(owned.every((byte) => byte === 0)).toBe(true)
})

test("secure input erases caller bytes when the initial expiry clock throws", () => {
  const supplied = bytes("credential-bytes")
  const vault = new SecureInputVault(() => {
    throw new Error("expiry clock failed")
  })

  expect(() => vault.issue(supplied, secureBinding())).toThrow("expiry clock failed")
  expect(supplied.every((byte) => byte === 0)).toBe(true)
})

test("secure input expires unused entries during allocation, bounds pending handles, and closes idempotently", async () => {
  let clock = 10
  let next = 0
  const vault = new SecureInputVault(() => clock, 5, () => `handle-${++next}`.padEnd(48, "x"))
  for (let index = 0; index < 16; index++) vault.issue(bytes(`secret-${index}`), secureBinding({ idempotencyKey: `put_${index}` }))
  const overCapacity = bytes("must-be-zeroed")
  expect(() => vault.issue(overCapacity, secureBinding({ idempotencyKey: "put_overflow" }))).toThrow(
    /pending secure input limit/,
  )
  expect(overCapacity.every((byte) => byte === 0)).toBe(true)

  clock += 5
  const freshBinding = secureBinding({ idempotencyKey: "put_fresh" })
  const afterExpiry = vault.issue(bytes("fresh-secret"), freshBinding)
  expect(await vault.consume(afterExpiry, freshBinding)).toEqual(bytes("fresh-secret"))
  vault.close()
  vault.close()
  await expect(vault.consume(afterExpiry, freshBinding)).rejects.toMatchObject({ code: "UNAVAILABLE" })
})

test("terminal credential reader disables echo, restores mode, and returns bytes only", async () => {
  class Input extends EventEmitter {
    isTTY = true
    isRaw = false
    rawModes: boolean[] = []
    paused = false
    setRawMode(value: boolean) { this.isRaw = value; this.rawModes.push(value); return this }
    isPaused() { return this.paused }
    pause() { this.paused = true; return this }
    resume() {
      this.paused = false
      queueMicrotask(() => {
        this.emit("data", Buffer.from("s3cr3t\r"))
      })
      return this
    }
  }
  const input = new Input()
  const output = { isTTY: true, value: "", write(text: string) { this.value += text; return true } }
  const result = await readSecureTTYInput({ stdin: input as never, stdout: output as never, prompt: "API key: " })
  expect(result).toEqual(bytes("s3cr3t"))
  expect(input.rawModes).toEqual([true, false])
  expect(output.value).toBe("API key: \n")
  result.fill(0)
})

test("terminal credential reader restores raw mode when enabling it throws", async () => {
  const rawModes: boolean[] = []
  const input = {
    isTTY: true,
    isRaw: false,
    isPaused: () => false,
    setRawMode(value: boolean) {
      rawModes.push(value)
      this.isRaw = value
      if (value) throw new Error("raw mode setup failed")
      return this
    },
    pause() { return this },
    resume() { return this },
    on() { return this },
    off() { return this },
  }
  const output = { isTTY: true, write() { return true } }

  await expect(readSecureTTYInput({ stdin: input as never, stdout: output as never })).rejects.toThrow("raw mode setup failed")
  expect(rawModes).toEqual([true, false])
  expect(input.isRaw).toBe(false)
})

test("terminal credential reader removes its data listener when resume throws", async () => {
  const listeners = new Set<(...args: unknown[]) => void>()
  const input = {
    isTTY: true,
    isRaw: false,
    isPaused: () => false,
    setRawMode(value: boolean) { this.isRaw = value; return this },
    pause() { return this },
    resume() { throw new Error("resume failed") },
    on(_event: string, listener: (...args: unknown[]) => void) { listeners.add(listener); return this },
    off(_event: string, listener: (...args: unknown[]) => void) { listeners.delete(listener); return this },
  }
  const output = { isTTY: true, write() { return true } }

  await expect(readSecureTTYInput({ stdin: input as never, stdout: output as never })).rejects.toThrow("resume failed")
  expect(listeners.size).toBe(0)
  expect(input.isRaw).toBe(false)
})

test("terminal credential reader erases its string-event byte copy", async () => {
  class Input extends EventEmitter {
    isTTY = true
    isRaw = false
    isPaused() { return false }
    setRawMode(value: boolean) { this.isRaw = value; return this }
    pause() { return this }
    resume() { queueMicrotask(() => this.emit("data", "offline-test-secret\r")); return this }
  }
  const input = new Input()
  const output = { isTTY: true, write() { return true } }
  const allocated: Buffer[] = []
  const originalFrom = Buffer.from
  Buffer.from = ((value: Parameters<typeof Buffer.from>[0], ...args: any[]) => {
    const result = originalFrom(value as never, ...args)
    if (value === "offline-test-secret\r") allocated.push(result as Buffer)
    return result
  }) as typeof Buffer.from
  let result: Uint8Array | undefined
  try {
    result = await readSecureTTYInput({ stdin: input as never, stdout: output as never })
  } finally {
    Buffer.from = originalFrom
  }

  expect(result).toEqual(bytes("offline-test-secret"))
  expect(allocated).toHaveLength(1)
  expect(allocated[0]!.every((byte) => byte === 0)).toBe(true)
  result!.fill(0)
})
