import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import {
  ContextSelectionV1,
  type ContextSelectionModeV1,
  type ContextSelectionSourceV1,
} from "@opencode-ai/schema/context-selection-v1"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import type { DirectProviderRequestContextV1 } from "@opencode-ai/llm/route"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const MAX_SOURCES = 64
const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_PROVIDER_INPUT_BYTES = 16 * 1024 * 1024
const MAX_PROVIDER_INPUT_NODES = 200_000
const MAX_PROVIDER_INPUT_DEPTH = 48
const U64_MAX = "18446744073709551615"

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
  readonly providerInput: ProviderInputV1
}) => {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID)) throw new TypeError("Session request identity is invalid")
  if (!validU64(input.sourceRevision)) throw new RangeError("Session context revision is invalid")

  // The provider-input and active profile pins are mandatory, so at most 62
  // message refs fit the shared 64-source schema.
  const selected = input.mode === "fresh" ? [] : input.messages.slice(-(MAX_SOURCES - 2))
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
  }
  readonly pin: DirectProviderRequestContextV1["pin"]
}): DirectProviderRequestContextV1 {
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
      trust: "user",
    },
    sourceRevision: input.sourceRevision,
    messages: [...input.messages],
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
    }),
    contextSelection,
    pin: input.pin,
  })
}
