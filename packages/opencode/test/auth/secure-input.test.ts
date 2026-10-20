import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { SecureInputVault, readSecureTTYInput } from "../../src/auth/secure-input"

const bytes = (value: string) => new TextEncoder().encode(value)

test("secure input handles are random, one-use, short-lived, and erase transferred buffers", async () => {
  let clock = 100
  const supplied = bytes("native-input")
  const vault = new SecureInputVault(() => clock, 5, () => "h".repeat(48))
  const handle = vault.issue(supplied)
  expect(supplied.every((byte) => byte === 0)).toBe(true)
  expect(await vault.consume(handle)).toEqual(bytes("native-input"))
  await expect(vault.consume(handle)).rejects.toMatchObject({ code: "UNAVAILABLE" })

  const expired = vault.issue(bytes("expired"))
  clock += 5
  await expect(vault.consume(expired)).rejects.toMatchObject({ code: "EXPIRED" })
  vault.close()
})

test("secure input expires unused entries during allocation, bounds pending handles, and closes idempotently", async () => {
  let clock = 10
  let next = 0
  const vault = new SecureInputVault(() => clock, 5, () => `handle-${++next}`.padEnd(48, "x"))
  for (let index = 0; index < 16; index++) vault.issue(bytes(`secret-${index}`))
  const overCapacity = bytes("must-be-zeroed")
  expect(() => vault.issue(overCapacity)).toThrow(/pending secure input limit/)
  expect(overCapacity.every((byte) => byte === 0)).toBe(true)

  clock += 5
  const afterExpiry = vault.issue(bytes("fresh-secret"))
  expect(await vault.consume(afterExpiry)).toEqual(bytes("fresh-secret"))
  vault.close()
  vault.close()
  await expect(vault.consume(afterExpiry)).rejects.toMatchObject({ code: "UNAVAILABLE" })
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
