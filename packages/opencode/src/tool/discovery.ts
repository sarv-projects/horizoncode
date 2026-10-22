import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export type ToolDiscoveryDescriptorV1 = {
  readonly id: string
  readonly description: string
  readonly tags: readonly string[]
  readonly sideEffectClass: "read_only" | "control" | "effect"
  readonly availability: "available" | "requires_approval"
  readonly requiredCapability: string
  readonly schemaDigest: string
}

export type ToolsetMemberV1 = {
  readonly id: string
  readonly schemaDigest: string
}

export type ToolsetSourceRefV1 = {
  readonly kind: "tool"
  readonly sourceID: string
  readonly sourceRevision: string
  readonly contentDigest: string
  readonly sourceAuthority: "tool-registry"
  readonly trust: "system"
  readonly included: true
  readonly inclusionReason: "selected_tool"
  readonly harnessRevision?: number
}

const MAX_CANONICAL_SCHEMA_BYTES = 1024 * 1024
const MAX_CANONICAL_NODES = 50_000
export const TOOL_DISCOVERY_LIMITS_V1 = {
  maxCandidates: 256,
  maxAggregateSchemaBytes: 8 * 1024 * 1024,
  maxAggregateSchemaNodes: 200_000,
  maxAggregateDescriptionBytes: 128 * 1024,
  maxDescriptorDescriptionBytes: 320,
  maxSearchResultBytes: 32 * 1024,
} as const

function canonicalJSON(value: unknown): { readonly encoded: string; readonly nodes: number; readonly bytes: number } {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_CANONICAL_NODES || depth > 48) throw new RangeError("tool schema exceeds canonicalization bounds")
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("tool schema contains a non-finite number")
      return item
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("tool schema is not a plain JSON record")
      const record = item as Record<string, unknown>
      const result: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(record).toSorted()) {
        const child = record[key]
        if (child === undefined) continue
        if (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
          throw new TypeError("tool schema contains a non-JSON value")
        }
        result[key] = visit(child, depth + 1)
      }
      return result
    }
    throw new TypeError("tool schema contains a non-JSON value")
  }
  const encoded = JSON.stringify(visit(value, 0))
  const bytes = Buffer.byteLength(encoded, "utf8")
  if (bytes > MAX_CANONICAL_SCHEMA_BYTES) throw new RangeError("tool schema exceeds byte bound")
  return { encoded, nodes, bytes }
}

function digest(domain: string, value: unknown): string {
  return `blake3:${bytesToHex(blake3(new TextEncoder().encode(`${domain}\0${canonicalJSON(value).encoded}`)))}`
}

export function toolSchemaDigestV1(schema: unknown): string {
  return toolSchemaRecordV1(schema).digest
}

export function toolSchemaRecordV1(schema: unknown): { readonly digest: string; readonly bytes: number; readonly nodes: number } {
  const canonical = canonicalJSON(schema)
  return {
    digest: `blake3:${bytesToHex(blake3(new TextEncoder().encode(`horizon.tool-schema.v1\0${canonical.encoded}`)))}`,
    bytes: canonical.bytes,
    nodes: canonical.nodes,
  }
}

export function toolsetGenerationV1(input: {
  readonly harnessID: string
  readonly harnessRevision: number
  readonly members: readonly ToolsetMemberV1[]
}): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.harnessID) ||
    !Number.isSafeInteger(input.harnessRevision) || input.harnessRevision < 1 ||
    input.members.length > 32) throw new TypeError("toolset generation input is invalid or over limit")
  const members = [...input.members].toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  if (new Set(members.map((member) => member.id)).size !== members.length ||
    members.some((member) => !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(member.id) || !/^blake3:[0-9a-f]{64}$/.test(member.schemaDigest))) {
    throw new TypeError("toolset generation members must have unique canonical IDs and BLAKE3 schema digests")
  }
  return digest("horizon.toolset.v1", { harnessID: input.harnessID, harnessRevision: input.harnessRevision, members })
}

export function toolsetSourceRefsV1(input: {
  readonly harnessID: string
  readonly harnessRevision: number
  readonly generation: string
  readonly members: readonly ToolsetMemberV1[]
}): readonly ToolsetSourceRefV1[] {
  if (!/^blake3:[0-9a-f]{64}$/.test(input.generation) || input.members.length > 32) {
    throw new TypeError("toolset source refs are invalid or over limit")
  }
  const members = [...input.members].toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return [
    {
      kind: "tool",
      sourceID: `toolset:${input.harnessID}`,
      sourceRevision: input.generation,
      contentDigest: input.generation,
      sourceAuthority: "tool-registry",
      trust: "system",
      included: true,
      inclusionReason: "selected_tool",
      harnessRevision: input.harnessRevision,
    },
    ...members.map((member) => ({
      kind: "tool" as const,
      sourceID: member.id,
      sourceRevision: input.generation,
      contentDigest: member.schemaDigest,
      sourceAuthority: "tool-registry" as const,
      trust: "system" as const,
      included: true as const,
      inclusionReason: "selected_tool" as const,
    })),
  ]
}

export function searchToolDescriptorsV1<T extends ToolDiscoveryDescriptorV1>(input: {
  readonly query: string
  readonly descriptors: readonly T[]
  readonly limit?: number
}): readonly T[] {
  if (typeof input.query !== "string" || Buffer.byteLength(input.query, "utf8") > 1024 ||
    !Array.isArray(input.descriptors) || input.descriptors.length > TOOL_DISCOVERY_LIMITS_V1.maxCandidates) {
    throw new RangeError("tool discovery input exceeds its bounded candidate or query limit")
  }
  const query = input.query.trim().toLocaleLowerCase("en-US").slice(0, 256)
  const limit = Math.min(20, Math.max(1, Number.isSafeInteger(input.limit) ? input.limit! : 8))
  if (!query) return []
  const matches: Array<{ readonly descriptor: T; readonly score: number }> = []
  const descriptorIDs = new Set<string>()
  let aggregateDescriptionBytes = 0
  for (const descriptor of input.descriptors) {
    if (typeof descriptor !== "object" || descriptor === null ||
      typeof descriptor.id !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(descriptor.id) ||
      typeof descriptor.description !== "string" || Buffer.byteLength(descriptor.description, "utf8") > TOOL_DISCOVERY_LIMITS_V1.maxDescriptorDescriptionBytes ||
      !Array.isArray(descriptor.tags) || descriptor.tags.length > 32 ||
      descriptor.tags.some((tag) => typeof tag !== "string" || Buffer.byteLength(tag, "utf8") > 64) ||
      typeof descriptor.requiredCapability !== "string" || Buffer.byteLength(descriptor.requiredCapability, "utf8") > 256 ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(descriptor.requiredCapability) ||
      (descriptor.sideEffectClass !== "read_only" && descriptor.sideEffectClass !== "control" && descriptor.sideEffectClass !== "effect") ||
      (descriptor.availability !== "available" && descriptor.availability !== "requires_approval") ||
      !/^blake3:[0-9a-f]{64}$/.test(descriptor.schemaDigest)) {
      throw new TypeError("tool discovery descriptor is malformed or exceeds its bounds")
    }
    if (descriptorIDs.has(descriptor.id)) throw new TypeError("tool discovery candidate IDs must be unique")
    descriptorIDs.add(descriptor.id)
    aggregateDescriptionBytes += Buffer.byteLength(descriptor.description, "utf8")
    aggregateDescriptionBytes += descriptor.tags.reduce((total, tag) => total + Buffer.byteLength(tag, "utf8"), 0)
    if (aggregateDescriptionBytes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateDescriptionBytes) {
      throw new RangeError("tool discovery descriptions exceed the aggregate bound")
    }
    const text = [descriptor.id, descriptor.description, descriptor.tags.join(" "), descriptor.requiredCapability]
      .join(" ").toLocaleLowerCase("en-US")
    const index = text.indexOf(query)
    if (index >= 0) matches.push({ descriptor, score: index === 0 ? 2 : 1 })
  }
  matches.sort((left, right) => right.score - left.score ||
    (left.descriptor.id < right.descriptor.id ? -1 : left.descriptor.id > right.descriptor.id ? 1 : 0))
  return matches.slice(0, limit).map((item) => item.descriptor)
}
