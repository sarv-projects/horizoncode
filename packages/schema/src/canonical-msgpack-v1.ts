/**
 * Bounded canonical MessagePack for the strict JSON wire subset shared with
 * HostKernel. Maps sort keys by UTF-8 bytes, non-negative integers use the
 * unsigned representation, strings and containers use minimal headers, and
 * finite non-integer numbers use IEEE-754 binary64.
 */
export type CanonicalMessagePackLimitsV1 = {
  readonly maxEncodedBytes?: number
  readonly maxDepth?: number
  readonly maxNodes?: number
  readonly maxCollectionItems?: number
  readonly maxScalarBytes?: number
}

const DEFAULT_LIMITS: Required<CanonicalMessagePackLimitsV1> = Object.freeze({
  maxEncodedBytes: 256 * 1024,
  maxDepth: 16,
  maxNodes: 4_096,
  maxCollectionItems: 4_096,
  maxScalarBytes: 64 * 1024,
})

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function utf8Compare(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return left.length - right.length
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("canonical MessagePack strings must contain Unicode scalar values")
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("canonical MessagePack strings must contain Unicode scalar values")
    }
  }
}

function stringHeader(length: number): Uint8Array {
  if (length < 32) return Uint8Array.of(0xa0 | length)
  if (length <= 0xff) return Uint8Array.of(0xd9, length)
  if (length <= 0xffff) return Uint8Array.of(0xda, length >>> 8, length & 0xff)
  return Uint8Array.of(0xdb, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
}

function arrayHeader(length: number): Uint8Array {
  if (length < 16) return Uint8Array.of(0x90 | length)
  if (length <= 0xffff) return Uint8Array.of(0xdc, length >>> 8, length & 0xff)
  return Uint8Array.of(0xdd, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
}

function mapHeader(length: number): Uint8Array {
  if (length < 16) return Uint8Array.of(0x80 | length)
  if (length <= 0xffff) return Uint8Array.of(0xde, length >>> 8, length & 0xff)
  return Uint8Array.of(0xdf, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
}

function integerBytes(value: number): Uint8Array {
  const integer = BigInt(value)
  if (integer >= 0n) {
    if (integer <= 0x7fn) return Uint8Array.of(Number(integer))
    if (integer <= 0xffn) return Uint8Array.of(0xcc, Number(integer))
    if (integer <= 0xffffn) return Uint8Array.of(0xcd, Number((integer >> 8n) & 0xffn), Number(integer & 0xffn))
    if (integer <= 0xffff_ffffn) return Uint8Array.of(0xce, Number((integer >> 24n) & 0xffn), Number((integer >> 16n) & 0xffn), Number((integer >> 8n) & 0xffn), Number(integer & 0xffn))
    return Uint8Array.of(0xcf,
      Number((integer >> 56n) & 0xffn), Number((integer >> 48n) & 0xffn), Number((integer >> 40n) & 0xffn), Number((integer >> 32n) & 0xffn),
      Number((integer >> 24n) & 0xffn), Number((integer >> 16n) & 0xffn), Number((integer >> 8n) & 0xffn), Number(integer & 0xffn))
  }
  if (integer >= -32n) return Uint8Array.of(Number(0x100n + integer))
  if (integer >= -128n) return Uint8Array.of(0xd0, Number(0x100n + integer))
  if (integer >= -32768n) return Uint8Array.of(0xd1, Number((0x1_0000n + integer) >> 8n), Number((0x1_0000n + integer) & 0xffn))
  if (integer >= -2_147_483_648n) {
    const encoded = 0x1_0000_0000n + integer
    return Uint8Array.of(0xd2, Number((encoded >> 24n) & 0xffn), Number((encoded >> 16n) & 0xffn), Number((encoded >> 8n) & 0xffn), Number(encoded & 0xffn))
  }
  const encoded = (1n << 64n) + integer
  return Uint8Array.of(0xd3,
    Number((encoded >> 56n) & 0xffn), Number((encoded >> 48n) & 0xffn), Number((encoded >> 40n) & 0xffn), Number((encoded >> 32n) & 0xffn),
    Number((encoded >> 24n) & 0xffn), Number((encoded >> 16n) & 0xffn), Number((encoded >> 8n) & 0xffn), Number(encoded & 0xffn))
}

/** Encode JSON-compatible values using HostKernel's canonical map/integer rules. */
export function encodeCanonicalMessagePackV1(
  value: unknown,
  requestedLimits: CanonicalMessagePackLimitsV1 = {},
): Uint8Array {
  const limits = { ...DEFAULT_LIMITS, ...requestedLimits }
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name} must be a positive safe integer`)
  }
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let encodedBytes = 0
  let nodes = 0
  const push = (bytes: Uint8Array) => {
    if (bytes.length > limits.maxEncodedBytes - encodedBytes) {
      throw new RangeError("canonical MessagePack value exceeds its encoded byte bound")
    }
    chunks.push(bytes)
    encodedBytes += bytes.length
  }
  const encode = (item: unknown, depth: number): void => {
    nodes++
    if (nodes > limits.maxNodes) throw new RangeError("canonical MessagePack value exceeds its node bound")
    if (depth > limits.maxDepth) throw new RangeError("canonical MessagePack value exceeds its depth bound")
    if (item === null) return push(Uint8Array.of(0xc0))
    if (typeof item === "boolean") return push(Uint8Array.of(item ? 0xc3 : 0xc2))
    if (typeof item === "string") {
      assertUnicodeScalarString(item)
      const bytes = encoder.encode(item)
      if (bytes.length > limits.maxScalarBytes) throw new RangeError("canonical MessagePack string exceeds its scalar bound")
      push(stringHeader(bytes.length))
      return push(bytes)
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("canonical MessagePack number must be finite")
      // JSON.stringify serializes -0 as 0, which HostKernel consequently parses
      // as an unsigned integer. Match that actual wire representation here.
      if (Number.isSafeInteger(item)) return push(integerBytes(item))
      const bytes = new Uint8Array(9)
      bytes[0] = 0xcb
      new DataView(bytes.buffer).setFloat64(1, item, false)
      return push(bytes)
    }
    if (Array.isArray(item)) {
      if (item.length > limits.maxCollectionItems) throw new RangeError("canonical MessagePack array exceeds its item bound")
      const keys = Reflect.ownKeys(item)
      if (keys.length !== item.length + 1 || keys.some((key) => key !== "length" &&
          (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) {
        throw new TypeError("canonical MessagePack arrays may contain only dense indexed data fields")
      }
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("canonical MessagePack arrays must contain dense data fields")
        }
      }
      push(arrayHeader(item.length))
      for (let index = 0; index < item.length; index++) encode(Object.getOwnPropertyDescriptor(item, String(index))!.value, depth + 1)
      return
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical MessagePack maps must be plain objects")
      const keys = Reflect.ownKeys(item)
      if (keys.length > limits.maxCollectionItems || keys.some((key) => typeof key !== "string")) {
        throw new RangeError("canonical MessagePack map exceeds its key bound or has non-string keys")
      }
      const fields = (keys as string[]).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("canonical MessagePack maps may contain only enumerable data fields")
        }
        assertUnicodeScalarString(key)
        const keyBytes = encoder.encode(key)
        if (keyBytes.length > limits.maxScalarBytes) throw new RangeError("canonical MessagePack map key exceeds its scalar bound")
        return { key, keyBytes, value: descriptor.value }
      }).toSorted((left, right) => utf8Compare(left.keyBytes, right.keyBytes))
      push(mapHeader(fields.length))
      for (const field of fields) {
        push(stringHeader(field.keyBytes.length))
        push(field.keyBytes)
        encode(field.value, depth + 1)
      }
      return
    }
    throw new TypeError("canonical MessagePack supports JSON values only")
  }
  encode(value, 0)
  return concat(chunks, encodedBytes)
}
