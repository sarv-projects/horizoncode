import { describe, expect, it } from "bun:test"
import { boundedJsonByteLength, boundedJsonSnapshot } from "../../src/server/routes/instance/httpapi/event-payload-bounds"

describe("bounded JSON payload measurement", () => {
  it("matches JSON UTF-8 bytes including escaping and multibyte characters", () => {
    for (const value of [{ text: "quote \" slash \\ newline\n" }, { text: "Horizon 🌅" }, [null, true, 4.5]]) {
      const expected = Buffer.byteLength(JSON.stringify(value), "utf8")
      expect(boundedJsonByteLength(value, expected)).toBe(expected)
      expect(boundedJsonByteLength(value, expected - 1)).toBeUndefined()
    }
  })

  it("rejects large strings before creating a serialized copy", () => {
    expect(boundedJsonByteLength({ text: "x".repeat(2 * 1024 * 1024) }, 64 * 1024)).toBeUndefined()
  })

  it("rejects cycles, accessors, excessive depth and excessive node counts", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    let getterCalls = 0
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { getterCalls++; return "unsafe" } })
    let deep: unknown = null
    for (let i = 0; i < 40; i++) deep = [deep]
    expect(boundedJsonByteLength(cycle, 1024)).toBeUndefined()
    expect(boundedJsonByteLength(accessor, 1024)).toBeUndefined()
    expect(boundedJsonByteLength(deep, 1024)).toBeUndefined()
    expect(getterCalls).toBe(0)
    expect(boundedJsonByteLength(Array(9000).fill(null), 64 * 1024)).toBeUndefined()
    expect(boundedJsonByteLength(new Array(10_000_000), 64 * 1024)).toBeUndefined()
    const manyKeys = Object.create(null) as Record<string, null>
    for (let i = 0; i < 10_000; i++) manyKeys[`key-${i}`] = null
    expect(boundedJsonByteLength(manyKeys, 64 * 1024)).toBeUndefined()
  })

  it("detaches and freezes the bounded snapshot before the source can mutate", () => {
    const source = { id: "event-1", properties: { sessionID: "owned-session", text: "before" } }
    const snapshot = boundedJsonSnapshot(source, 1024)
    source.properties.sessionID = "foreign-session"
    source.properties.text = "after".repeat(1000)
    expect(snapshot?.json).toBe('{"id":"event-1","properties":{"sessionID":"owned-session","text":"before"}}')
    expect(snapshot?.bytes).toBe(Buffer.byteLength(snapshot?.json ?? "", "utf8"))
  })

  it("matches JSON omission and array null behavior for inherited and unsupported values", () => {
    const prototype = { inherited: "ignored" }
    const value = Object.assign(Object.create(prototype), {
      present: "kept",
      omitted: undefined,
      unsupported: () => "ignored",
      symbolValue: Symbol("ignored"),
    })
    value[Symbol("ignored key")] = "ignored"
    const array = [undefined, () => "ignored", Symbol("ignored")]
    const inheritedArrayPrototype = Object.create(Array.prototype) as unknown[]
    Object.defineProperty(inheritedArrayPrototype, "0", { value: "inherited-array-value", enumerable: true })
    const inheritedArray = [] as unknown[]
    inheritedArray.length = 1
    Object.setPrototypeOf(inheritedArray, inheritedArrayPrototype)
    const payload = { value, array, inheritedArray }
    expect(boundedJsonSnapshot(payload, 1024)?.json).toBe(JSON.stringify(payload))
  })
})
