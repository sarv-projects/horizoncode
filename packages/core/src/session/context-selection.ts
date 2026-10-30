import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import {
  ContextSelectionV1,
  ContextSelectionSourceV1 as ContextSelectionSourceSchema,
  type ContextSelectionModeV1,
} from "@horizoncode/schema/context-selection-v1"

type ContextSelectionSourceV1 = typeof ContextSelectionSourceSchema.Type
import * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import type { DirectProviderRequestContextV1 } from "@horizoncode/llm/route"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const MAX_SOURCES = 64
const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_PROVIDER_INPUT_BYTES = 16 * 1024 * 1024
const MAX_PROVIDER_INPUT_NODES = 200_000
const MAX_PROVIDER_INPUT_DEPTH = 48
const U64_MAX = "18446744073709551615"
const DIGEST_PATTERN = /^blake3:[0-9a-f]{64}$/

/** Exact serialized bytes used for the corresponding ContextSelection source digest. */
export function sessionMessageSourceBytesV1(message: SessionMessage.Message): number {
  return Buffer.byteLength(JSON.stringify(encodeMessage(message)), "utf8")
}

/** Exact canonical bytes used when pinning a resolved AgentProfileV2 definition. */
export function agentProfileSourceBytesV1(profile: AgentProfileV2.AgentProfileDefinitionV2): number {
  return Buffer.byteLength(canonicalProviderInputJson(profile), "utf8")
}

/** The already-normalized fields passed to the provider adapter for this request. */
export type ProviderInputV1 = {
  readonly system: readonly unknown[]
  readonly messages: readonly unknown[]
  readonly tools: Readonly<Record<string, unknown>> | readonly unknown[]
  readonly toolChoice?: string
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly providerOptions?: unknown
  /** Provider-native prepared body and route identity; excludes auth and HTTP headers. */
  readonly preparedRequest?: unknown
}

/** Resolved Core Config profile pin; never populate this from model/display-name input. */
export type ContextProfileRefV1 = {
  readonly profileID: AgentProfileV2.ProfileId
  readonly revision: AgentProfileV2.Revision
  readonly profileDigest: string
  readonly trust: "system" | "user"
}

export function canonicalProviderInputJson(value: unknown): string {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_PROVIDER_INPUT_NODES || depth > MAX_PROVIDER_INPUT_DEPTH) {
      throw new RangeError("provider input exceeds the context-selection bound")
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("provider input contains a non-finite number")
      return item
    }
    if (item instanceof Uint8Array) {
      return { "$bytesBLAKE3": bytesToHex(blake3(item)), "$byteLength": item.byteLength }
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
    if (typeof item === "object") {
      const output: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(item as Record<string, unknown>).toSorted()) {
        const entry = (item as Record<string, unknown>)[key]
        if (entry === undefined) continue
        if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new TypeError("provider input contains a non-serializable value")
        }
        output[key] = visit(entry, depth + 1)
      }
      return output
    }
    throw new TypeError("provider input contains a non-serializable value")
  }
  const encoded = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_INPUT_BYTES) {
    throw new RangeError("provider input exceeds the context-selection byte bound")
  }
  return encoded
}

/** Digest the exact normalized provider-visible request using the managed request algorithm. */
export function providerInputDigest(input: ProviderInputV1): string {
  const canonical = canonicalProviderInputJson({
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    temperature: input.temperature ?? null,
    topP: input.topP ?? null,
    topK: input.topK ?? null,
    providerOptions: input.providerOptions ?? null,
    preparedRequest: input.preparedRequest ?? null,
  })
  return `blake3:${bytesToHex(blake3(Buffer.from(canonical, "utf8")))}`
}

/** Stable Core Config digest for one trusted, versioned AgentProfileV2 definition. */
export function agentProfileDefinitionDigest(profile: AgentProfileV2.AgentProfileDefinitionV2): string {
  const canonical = canonicalProviderInputJson(profile)
  return `blake3:${bytesToHex(blake3(Buffer.from(`horizon.agent-profile-v2.core-config\0${canonical}`, "utf8")))}`
}

function validU64(value: string): boolean {
  return /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    (value.length < U64_MAX.length || (value.length === U64_MAX.length && value <= U64_MAX))
}

/**
 * Compile references for one frozen direct-session provider request. requestID must be minted
 * by the authenticated Core request boundary; providerInput must be the exact normalized value
 * subsequently supplied to the adapter. This function does not authorize dispatch or copy text
 * into the selection. HostKernel must bind this digest to that same frozen payload before use.
 */
export const compile = (input: {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly mode: ContextSelectionModeV1
  /** Exact active profile resolved by Core Config for this direct Session. */
  readonly agentProfile: ContextProfileRefV1
  /** Canonical decimal aggregate cursor observed from Session storage. */
  readonly sourceRevision: string
  readonly messages: readonly SessionMessage.Message[]
  /**
   * Exact project-instruction references resolved for this request. They enter
   * only the next compile and never grant authority; see the §29.23 resolver.
   */
  readonly instructions?: readonly ContextSelectionSourceV1[]
  readonly providerInput: ProviderInputV1
}) => {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID)) throw new TypeError("Session request identity is invalid")
  if (!validU64(input.sourceRevision)) throw new RangeError("Session context revision is invalid")

  const instructions = input.instructions ?? []
  if (instructions.length > MAX_SOURCES - 2) throw new RangeError("instruction sources exceed the context selection bound")
  const instructionIDs = new Set<string>()
  for (const source of instructions) {
    if (
      source.kind !== "instruction" ||
      source.sourceAuthority !== "instruction-resolver" ||
      source.inclusionReason !== "instruction" ||
      !source.included ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(source.sourceID) ||
      !DIGEST_PATTERN.test(source.contentDigest)
    ) {
      throw new TypeError("instruction source must be an included instruction-resolver reference")
    }
    if (instructionIDs.has(source.sourceID)) throw new TypeError("instruction source references must be unique")
    instructionIDs.add(source.sourceID)
  }

  // The provider-input and active profile pins are mandatory, so at most 62
  // message refs (less any instruction refs) fit the shared 64-source schema.
  const selected = input.mode === "fresh" ? [] : input.messages.slice(-(MAX_SOURCES - 2 - instructions.length))
  const sources: ContextSelectionSourceV1[] = selected.map((message) => {
    const byteLength = sessionMessageSourceBytesV1(message)
    if (byteLength > MAX_MESSAGE_BYTES) throw new RangeError("Session context source exceeds its bound")
    return {
      kind: "session-message" as const,
      sourceID: message.id,
      sourceRevision: input.sourceRevision,
      contentDigest: `blake3:${bytesToHex(blake3(Buffer.from(JSON.stringify(encodeMessage(message)), "utf8")))}`,
      sourceAuthority: "session-store" as const,
      trust: "mixed" as const,
      included: true as const,
      inclusionReason: "history" as const,
    }
  })
  sources.push(...instructions)
  sources.push({
    kind: "provider-input" as const,
    sourceID: input.requestID,
    sourceRevision: input.sourceRevision,
    contentDigest: providerInputDigest(input.providerInput),
    sourceAuthority: "core-prompt-compiler" as const,
    trust: "mixed" as const,
    included: true as const,
    inclusionReason: "current_request" as const,
  })
  sources.push({
    kind: "agent-profile" as const,
    sourceID: input.agentProfile.profileID,
    sourceRevision: String(input.agentProfile.revision),
    contentDigest: input.agentProfile.profileDigest,
    sourceAuthority: "core-config" as const,
    trust: input.agentProfile.trust,
    included: true as const,
    inclusionReason: "profile" as const,
  })
  return Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })({
    schemaVersion: 1,
    lane: "direct",
    sessionID: input.sessionID,
    requestID: input.requestID,
    mode: input.mode,
    sourceRevision: input.sourceRevision,
    sources,
  })
}

/** Freeze the exact direct-lane producer pins passed privately to LLMClient.stream. */
export function compileDirectProviderRequestContextV1(input: {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly sourceRevision: string
  readonly mode: ContextSelectionModeV1
  readonly agentProfile: AgentProfileV2.AgentProfileDefinitionV2
  readonly messages: readonly SessionMessage.Message[]
  /** Exact resolved project-instruction references for this compile. */
  readonly instructions?: readonly ContextSelectionSourceV1[]
  readonly providerInput: ProviderInputV1
  /** HostKernel/Provider authority projection; never infer scope or route revisions here. */
  readonly authority: {
    readonly permissionScopeDigest: string
    readonly policyDigest: string
    readonly providerID: string
    readonly modelID: string
    readonly harnessID: string
    readonly harnessRevision: string
    readonly routeID: string
    readonly routeRevision: string
    readonly endpointRevision: string
    /**
     * Public endpoint base from the selected route projection. Required for the
     * frozen direct request; absent values fail closed before a context exists.
     */
    readonly endpointBase?: string
  }
  readonly pin: DirectProviderRequestContextV1["pin"]
}): DirectProviderRequestContextV1 {
  if (input.agentProfile.source === "plugin" || input.agentProfile.source === "external") {
    throw new TypeError("only Core Config profiles can pin a direct context selection")
  }
  if (
    input.authority.endpointBase === undefined ||
    input.authority.endpointBase.length === 0 ||
    input.authority.endpointBase.length > 2_048 ||
    !URL.canParse(input.authority.endpointBase)
  ) {
    throw new TypeError("direct provider context requires the selectable public endpoint base")
  }
  const trust = input.agentProfile.source === "builtin" ? "system" as const : "user" as const
  const profile = Object.freeze({
    profileID: input.agentProfile.profileId,
    revision: String(input.agentProfile.revision),
    profileDigest: agentProfileDefinitionDigest(input.agentProfile),
  })
  const selection = compile({
    sessionID: input.sessionID,
    requestID: input.requestID,
    mode: input.mode,
    agentProfile: {
      profileID: input.agentProfile.profileId,
      revision: input.agentProfile.revision,
      profileDigest: profile.profileDigest,
      trust,
    },
    sourceRevision: input.sourceRevision,
    messages: [...input.messages],
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    providerInput: input.providerInput,
  })
  const contextSelection = Object.freeze({
    ...selection,
    sources: Object.freeze(selection.sources.map((source) => Object.freeze({ ...source }))),
  })
  return Object.freeze({
    schemaVersion: 1,
    lane: "direct",
    sessionID: input.sessionID,
    requestID: input.requestID,
    sourceRevision: input.sourceRevision,
    profile,
    permissionScopeDigest: input.authority.permissionScopeDigest,
    policyDigest: input.authority.policyDigest,
    providerID: input.authority.providerID,
    modelID: input.authority.modelID,
    harnessID: input.authority.harnessID,
    harnessRevision: input.authority.harnessRevision,
    route: Object.freeze({
      routeID: input.authority.routeID,
      routeRevision: input.authority.routeRevision,
      endpointRevision: input.authority.endpointRevision,
      endpointBase: input.authority.endpointBase,
    }),
    contextSelection,
    pin: input.pin,
  })
}
