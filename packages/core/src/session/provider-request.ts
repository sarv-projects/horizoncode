import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { ContextSelectionV1, type ContextSelectionV1 as ContextSelectionValueV1 } from "@horizoncode/schema/context-selection-v1"
import { encodeCanonicalMessagePackV1 } from "@horizoncode/schema"
import { Schema } from "effect"
import { SessionSchema } from "./schema"

export type DirectProviderRequestStateV1 = "PINNED" | "DISPATCHING" | "SETTLED" | "UNKNOWN"

/** Non-secret immutable pins for one direct provider request. No prompt or serialized request body is accepted here. */
export type DirectProviderRequestPinsV1 = {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly sourceRevision: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionScopeDigest: string
  readonly contextSelection: ContextSelectionValueV1
  readonly providerID: string
  readonly modelID: string
  readonly accountRef?: string
  readonly harnessID: string
  readonly harnessRevision: string
  readonly routeRevision: string
  readonly endpointRevision: string
  readonly policyDigest: string
  readonly normalizedInputDigest: string
  readonly transportRequestDigest: string
}

export type DirectProviderRequestV1 = DirectProviderRequestPinsV1 & {
  readonly contextSelectionDigest: string
  readonly pinDigest: string
  readonly state: DirectProviderRequestStateV1
  readonly assistantMessageID?: string
  readonly usage?: Readonly<Record<string, unknown>>
}

/** The transport-side projection that must exactly match the pinned direct route. */
export type DirectProviderRouteProjectionV1 = {
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly routeID: string
  readonly routeRevision: string
  readonly endpointRevision: string
}

const ID = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^(?:blake3|sha256):[0-9a-f]{64}$/
const U64_MAX = "18446744073709551615"
const U64 = /^(0|[1-9][0-9]{0,19})$/
const POSITIVE_U64 = /^[1-9][0-9]{0,19}$/
const MAX_CANONICAL_BYTES = 64 * 1024

function canonical(value: unknown): string {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > 20_000 || depth > 32) throw new RangeError("provider request pins exceed bounds")
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number" && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map((part) => visit(part, depth + 1))
    if (typeof item === "object") {
      const out: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(item as Record<string, unknown>).toSorted()) {
        const child = (item as Record<string, unknown>)[key]
        if (child !== undefined) out[key] = visit(child, depth + 1)
      }
      return out
    }
    throw new TypeError("provider request pins contain an unsupported value")
  }
  const result = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(result, "utf8") > MAX_CANONICAL_BYTES) throw new RangeError("provider request pins exceed byte bound")
  return result
}

export function digestDirectProviderRequestPinsV1(pins: DirectProviderRequestPinsV1): string {
  canonical(pins)
  return digestCanonical("horizoncode.direct-provider-request.v1", pins)
}

export function digestContextSelectionV1(selection: ContextSelectionValueV1): string {
  canonical(selection)
  return digestCanonical("horizoncode.context-selection.direct.v1", selection)
}

function digestCanonical(domain: string, value: unknown): string {
  const encoded = encodeCanonicalMessagePackV1(value, {
    maxEncodedBytes: MAX_CANONICAL_BYTES,
    maxDepth: 32,
    maxNodes: 20_000,
    maxCollectionItems: 20_000,
    maxScalarBytes: 64 * 1024,
  })
  const prefix = new TextEncoder().encode(`${domain}\0`)
  const preimage = new Uint8Array(prefix.byteLength + encoded.byteLength)
  preimage.set(prefix)
  preimage.set(encoded, prefix.byteLength)
  return `blake3:${bytesToHex(blake3(preimage))}`
}

export function validateDirectProviderRequestPinsV1(value: DirectProviderRequestPinsV1): DirectProviderRequestPinsV1 {
  const validU64 = (candidate: string) => U64.test(candidate) && (candidate.length < U64_MAX.length || (candidate.length === U64_MAX.length && candidate <= U64_MAX))
  const validPositiveU64 = (candidate: string) => POSITIVE_U64.test(candidate) && (candidate.length < U64_MAX.length || (candidate.length === U64_MAX.length && candidate <= U64_MAX))
  if (!ID.test(value.requestID) || !ID.test(value.profileID) || !validPositiveU64(value.profileRevision) ||
    !ID.test(value.providerID) || !ID.test(value.modelID) || !ID.test(value.harnessID) ||
    !validPositiveU64(value.harnessRevision) || !ID.test(value.routeRevision) || !ID.test(value.endpointRevision)) {
    throw new TypeError("provider request identity pin is malformed")
  }
  if (!validU64(value.sourceRevision) || !/^blake3:[0-9a-f]{64}$/.test(value.profileDigest) ||
    !DIGEST.test(value.permissionScopeDigest) || !DIGEST.test(value.policyDigest) ||
    !DIGEST.test(value.normalizedInputDigest) || !DIGEST.test(value.transportRequestDigest)) {
    throw new TypeError("provider request revision or digest pin is malformed")
  }
  if (value.accountRef !== undefined && !ID.test(value.accountRef)) throw new TypeError("provider account reference is malformed")
  const selection = Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(value.contextSelection)
  if (selection.lane !== "direct" || selection.sessionID !== value.sessionID || selection.requestID !== value.requestID || selection.sourceRevision !== value.sourceRevision) {
    throw new TypeError("direct provider request does not match its ContextSelection")
  }
  const hasInputPin = selection.sources.some((source) => source.kind === "provider-input" && source.sourceID === value.requestID && source.contentDigest === value.normalizedInputDigest)
  const hasProfilePin = selection.sources.some((source) => source.kind === "agent-profile" && source.sourceID === value.profileID && source.sourceRevision === value.profileRevision && source.contentDigest === value.profileDigest)
  if (!hasInputPin || !hasProfilePin) throw new TypeError("ContextSelection does not carry the exact provider input and profile pins")
  // Canonicalization also enforces strict serializability and the persistent-reference bound.
  canonical(value)
  return { ...value, contextSelection: selection }
}

/**
 * Prove that the frozen transport route is the exact route the journal pinned.
 * Any provider/model/account/harness/route/endpoint revision difference fails
 * before bytes are sent. There is no fallback comparison and no "closest" route.
 */
export function assertDirectProviderRouteMatchV1(
  pins: Pick<DirectProviderRequestPinsV1, "providerID" | "modelID" | "harnessID" | "routeRevision" | "endpointRevision">,
  route: DirectProviderRouteProjectionV1,
): void {
  if (pins.providerID !== route.providerID) throw new TypeError("direct provider route mismatch: provider")
  if (pins.modelID !== route.modelID) throw new TypeError("direct provider route mismatch: model")
  if (pins.harnessID !== route.harnessID) throw new TypeError("direct provider route mismatch: harness")
  if (pins.routeRevision !== route.routeRevision || route.routeID !== route.routeRevision)
    throw new TypeError("direct provider route mismatch: route revision")
  if (pins.endpointRevision !== route.endpointRevision)
    throw new TypeError("direct provider route mismatch: endpoint revision")
  if (!/^llm_[a-f0-9]{64}$/.test(route.routeID) || !/^blake3:[a-f0-9]{64}$/.test(route.endpointRevision))
    throw new TypeError("direct provider route identity is malformed")
}
