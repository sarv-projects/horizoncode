export type BoundedJsonSnapshot = {
  /** Immutable, detached JSON-compatible value with no references to its input. */
  value: unknown
  /** Exact bounded JSON serialization of `value`. */
  json: string
  bytes: number
  nodes: number
}

function unsafeToJSON(value: object) {
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON")
    if (!descriptor) continue
    return !("value" in descriptor) || typeof descriptor.value === "function"
  }
  return false
}

/**
 * Clone and serialize JSON data under byte, node, and depth budgets. This
 * avoids Object.keys' unbounded key-array allocation, never invokes accessors
 * or custom toJSON hooks, and detaches the admitted payload from later source
 * event mutation. Inherited and symbol properties follow JSON.stringify and
 * are omitted.
 */
export function boundedJsonSnapshot(
  value: unknown,
  maxBytes: number,
  maxNodes = 8192,
  maxDepth = 32,
): BoundedJsonSnapshot | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0) return undefined

  let bytes = 0
  let nodes = 0
  const active = new Set<object>()
  const consumeNode = () => ++nodes <= maxNodes
  const add = (amount: number) => {
    bytes += amount
    return bytes <= maxBytes
  }
  const stringBytes = (text: string) => {
    if (!add(2)) return false
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 0x22 || code === 0x5c) {
        if (!add(2)) return false
      } else if (code <= 0x1f) {
        if (!add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6)) return false
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          if (!add(4)) return false
          i++
        } else if (!add(6)) return false
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (!add(6)) return false
      } else if (code <= 0x7f) {
        if (!add(1)) return false
      } else if (code <= 0x7ff) {
        if (!add(2)) return false
      } else if (!add(3)) return false
    }
    return true
  }
  const visit = (item: unknown, depth: number): { ok: true; value: unknown } | { ok: false } => {
    if (!consumeNode() || depth > maxDepth) return { ok: false }
    if (item === null) return add(4) ? { ok: true, value: null } : { ok: false }
    if (typeof item === "boolean") return add(item ? 4 : 5) ? { ok: true, value: item } : { ok: false }
    if (typeof item === "string") return stringBytes(item) ? { ok: true, value: item } : { ok: false }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return add(4) ? { ok: true, value: null } : { ok: false }
      const json = JSON.stringify(item)
      return add(json.length) ? { ok: true, value: item } : { ok: false }
    }
    if (typeof item !== "object") return { ok: false }
    if (active.has(item)) return { ok: false }
    active.add(item)
    try {
      if (Array.isArray(item)) {
        if (unsafeToJSON(item) || !add(2)) return { ok: false }
        const result: unknown[] = []
        for (let i = 0; i < item.length; i++) {
          if (i > 0 && !add(1)) return { ok: false }
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
          if (descriptor && !("value" in descriptor)) return { ok: false }
          let source = descriptor?.value
          if (!descriptor) {
            // JSON.stringify reads array holes through the prototype chain.
            // Preserve data values and reject inherited accessors rather than
            // invoking them during admission.
            for (let prototype = Object.getPrototypeOf(item); prototype; prototype = Object.getPrototypeOf(prototype)) {
              const inherited = Object.getOwnPropertyDescriptor(prototype, String(i))
              if (!inherited) continue
              if (!("value" in inherited)) return { ok: false }
              source = inherited.value
              break
            }
          }
          // JSON.stringify emits null for holes and unsupported array entries.
          // Visit the null replacement so sparse arrays consume the node cap
          // too, instead of iterating an arbitrarily large declared length.
          const child = source === undefined || typeof source === "function" || typeof source === "symbol"
            ? visit(null, depth + 1)
            : visit(source, depth + 1)
          if (!child.ok) return child
          result.push(child.value)
        }
        return { ok: true, value: Object.freeze(result) }
      }

      if (unsafeToJSON(item) || !add(2)) return { ok: false }
      const result = Object.create(null) as Record<string, unknown>
      let emitted = 0
      for (const key in item) {
        // Count every enumerated key, including inherited ones and undefined
        // values, so a wide object cannot evade the node cap via omission.
        if (!consumeNode()) return { ok: false }
        if (!Object.hasOwn(item, key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !("value" in descriptor)) return { ok: false }
        if (descriptor.value === undefined || typeof descriptor.value === "function" || typeof descriptor.value === "symbol") {
          continue // JSON.stringify omits these object values.
        }
        if (emitted++ > 0 && !add(1)) return { ok: false }
        if (!stringBytes(key) || !add(1)) return { ok: false }
        const child = visit(descriptor.value, depth + 1)
        if (!child.ok) return child
        Object.defineProperty(result, key, { value: child.value, enumerable: true })
      }
      return { ok: true, value: Object.freeze(result) }
    } catch {
      // Proxies and revoked objects can throw from reflection operations.
      return { ok: false }
    } finally {
      active.delete(item)
    }
  }

  const cloned = visit(value, 0)
  if (!cloned.ok) return undefined
  try {
    const json = JSON.stringify(cloned.value)
    if (typeof json !== "string") return undefined
    const actualBytes = Buffer.byteLength(json, "utf8")
    if (actualBytes !== bytes || actualBytes > maxBytes) return undefined
    return { value: cloned.value, json, bytes: actualBytes, nodes }
  } catch {
    return undefined
  }
}

/** Compatibility helper for fixtures that need only the measured byte count. */
export function boundedJsonByteLength(value: unknown, maxBytes: number, maxNodes = 8192, maxDepth = 32) {
  return boundedJsonSnapshot(value, maxBytes, maxNodes, maxDepth)?.bytes
}
