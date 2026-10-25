export type Utf8ByteLengthInspection = {
  readonly byteLength: number
  readonly scannedCodeUnits: number
  readonly exceeded: boolean
}

/**
 * Count UTF-8 bytes exactly up to a caller's cap, then stop. The over-cap
 * sentinel is cap + 1, sufficient for queue admission without allocating a
 * second full encoded copy of an untrusted stream delta.
 */
export function inspectUtf8ByteLength(value: string, maxBytes: number): Utf8ByteLengthInspection {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0
  let byteLength = 0
  let scannedCodeUnits = 0
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index)
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
    const paired = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    const size = paired ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (byteLength + size > limit) {
      return { byteLength: limit + 1, scannedCodeUnits: scannedCodeUnits + (paired ? 2 : 1), exceeded: true }
    }
    byteLength += size
    index += paired ? 2 : 1
    scannedCodeUnits += paired ? 2 : 1
  }
  return { byteLength, scannedCodeUnits, exceeded: false }
}
