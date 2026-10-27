import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import { isJSONObject, type SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { LLMEvent } from "@opencode-ai/llm"
import { Usage } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import * as SessionUsage from "./session"
import type { SessionMessage as SessionMessageSchema } from "@opencode-ai/schema/session-message"
import type { ContextSelectionV1 } from "@opencode-ai/schema/context-selection-v1"
import { ContextSelectionV1 as ContextSelectionSchemaV1 } from "@opencode-ai/schema/context-selection-v1"
import type { ContextLedgerEntryV2 } from "@opencode-ai/schema/context-ledger-v2"
import { compileContextLedgerV2, type CompiledContextLedgerV2 } from "@opencode-ai/core/session"
import { builtinHarnessProfileV1 } from "@opencode-ai/core/harness-profile"
import { AgentProfileService } from "@opencode-ai/core/config"
import { agentProfileDefinitionDigest } from "@opencode-ai/core/session/context-selection"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LocationServiceMap, locationServiceMapNode } from "@opencode-ai/core/location-services"
import { Pty } from "@opencode-ai/core/pty"
import { InstanceState } from "@/effect/instance-state"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import {
  SessionSupervisor,
  SessionSupervisorError,
  Service as SessionSupervisorService,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { requireMediatedWorkflowProvider } from "./hosted-tools"
import {
  createToolBatchContext,
  isStandaloneControlTool,
  requireToolExecution,
  toolBatchMiddleware,
  type ToolBatchDefinition,
  type CodeModeToolBatchV1,
  type DirectAttemptAuthority,
} from "./tool-batch"
import type { DirectTurnAuthority, ManagedAttemptAuthority } from "./managed-control"
import type { ToolsetSourceRefV1 } from "@/tool/discovery"
import type { CodeModeToolV1 } from "@/tool/code-mode-protocol"
import type { ManagedProviderRouteProjectionV1 } from "@/provider/provider"
import type { ManagedProviderAuthorizationHandleV1, ManagedProviderSendPinsV1 } from "@/auth/provider-transport"


export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

/** Clamp one managed provider step to HostKernel's current decimal-u64 remainder. */
export function managedStepOutputTokenLimit(remainingTokens: string, providerMaximum: number): number {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(remainingTokens) ||
    !Number.isSafeInteger(providerMaximum) || providerMaximum < 1) {
    throw new RangeError("managed provider token allowance is malformed")
  }
  const remaining = BigInt(remainingTokens)
  if (remaining > 18_446_744_073_709_551_615n) throw new RangeError("managed provider token allowance is malformed")
  if (remaining === 0n) throw new RangeError("managed provider token allowance is exhausted")
  return Number(remaining < BigInt(providerMaximum) ? remaining : BigInt(providerMaximum))
}

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  /**
   * Trusted direct-session provider authority resolved by Core Config and the
   * authenticated session owner. This is never taken from model, request JSON,
   * or the legacy primary Agent name. The request ID and payload digest are
   * minted later, per normalized SDK provider call.
   */
  directProviderAuthority?: DirectProviderAuthorityV1
  /** Trusted direct child Attempt authority injected by TaskTool only. */
  directAttempt?: DirectAttemptAuthority
  /** HostKernel-issued per-turn scope for a direct child; no model input can set it. */
  directTurn?: DirectTurnAuthority
  /** Trusted managed Task Attempt authority injected by the managed scheduler only. */
  managedAttempt?: ManagedAttemptAuthority
  /** Immutable managed context pins prepared by the Rust-selected Task adapter. */
  managedContext?: ManagedProviderContextV1
  /** Rust-selected remaining budget used while preparing sequence 1 before admission. */
  managedRemainingTokens?: string
  /** Effect-backed authorization fence called immediately before each provider request. */
  authorizeManagedProviderRequest?: (selection: ContextSelectionV1) => Effect.Effect<void, unknown>
  /** Called after HostKernel begin and before Auth send; never includes the one-use authorization. */
  onManagedProviderDispatch?: (handoff: ManagedProviderDispatchHandoffV1) => Effect.Effect<void, unknown>
  /** Core-owned prepare/Guard approval/begin bridge invoked after exact SDK transport serialization. */
  authorizeManagedProviderTransport?: (input: {
    readonly contextSelection: ContextSelectionV1
    readonly routeProjection: ManagedProviderRouteProjectionV1
    readonly requestPins: ManagedProviderDispatchHandoffV1["requestPins"]
    readonly profileSelection: { readonly profileId: string; readonly revision: string }
  }) => Effect.Effect<{
    readonly authorization: ManagedProviderAuthorizationHandleV1
    readonly expected: ManagedProviderSendPinsV1
    readonly handoff: ManagedProviderDispatchHandoffV1
  }, unknown>
  /** Processor-owned usage receipt callback; invoked before a managed effect reaches Guard. */
  beforeManagedEffects?: (input: {
    readonly stepFinishIndex: number
    readonly usageProvenance: SessionMessageSchema.UsageProvenance
    readonly finishReason: SessionV1.Assistant["finish"]
    readonly cost: number
    readonly tokens: SessionV1.Assistant["tokens"]
    readonly calls: readonly {
      readonly toolCallID: string
      readonly toolName: string
      readonly capabilityID: string
      readonly arguments: Record<string, unknown>
    }[]
  }) => Effect.Effect<"ACCOUNTED" | "STOPPED", unknown>
  /** Receives the reference-only projection of the exact normalized provider call. */
  onContextLedgerV2?: (projection: CompiledContextLedgerV2) => Effect.Effect<void, unknown>
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  toolDefinitions?: Readonly<Record<string, ToolBatchDefinition>>
  toolDiscovery?: {
    readonly harnessID: string
    readonly harnessRevision: number
    readonly generation: string
    readonly sourceRefs: readonly ToolsetSourceRefV1[]
    /** Exact authorized CodeMode catalog; deferred entries do not enter provider tools. */
    readonly codeModeTools: readonly CodeModeToolV1[]
    /** Exact post-transform wrappers from the same SessionTools.resolve pass. */
    readonly codeModeExecutors: Readonly<Record<string, Tool>>
    readonly prepareNextProviderRequest: () => {
      readonly tools: Record<string, Tool>
      readonly generation: string
      readonly sourceRefs: readonly ToolsetSourceRefV1[]
      readonly codeModeTools: readonly CodeModeToolV1[]
      readonly codeModeExecutors: Readonly<Record<string, Tool>>
    }
  }
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

/** Immutable turn-level pins required before a direct request can be built. */
export type DirectProviderAuthorityV1 = {
  readonly profile: {
    readonly profileID: string
    readonly revision: string
    readonly profileDigest: string
    readonly trust: "system" | "user"
  }
  readonly permissionScopeDigest: string
  readonly policyRevision: string
  readonly policyDigest: string
  readonly harnessID: string
  readonly harnessRevision: string
  readonly route: {
    readonly providerID: string
    readonly modelID: string
    readonly accountRef?: string
    readonly routeRevision: string
    readonly endpointRevision: string
  }
}

/** Reject stale/partial producer projections before any provider resolver runs. */
export function validateDirectProviderAuthorityV1(
  value: unknown,
  expected: { readonly providerID: string; readonly modelID: string },
): DirectProviderAuthorityV1 {
  const exact = (item: unknown, keys: readonly string[]): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item) &&
    Object.keys(item).toSorted().join("\0") === [...keys].toSorted().join("\0")
  const id = (item: unknown) => typeof item === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(item)
  const revision = (item: unknown) => typeof item === "string" && /^[1-9][0-9]{0,19}$/.test(item) && BigInt(item) <= 18_446_744_073_709_551_615n
  const digest = (item: unknown, schemes: readonly string[]) => typeof item === "string" && schemes.some((scheme) => new RegExp(`^${scheme}:[0-9a-f]{64}$`).test(item))
  if (!exact(value, ["profile", "permissionScopeDigest", "policyRevision", "policyDigest", "harnessID", "harnessRevision", "route"])) {
    throw new TypeError("direct provider authority is missing or has unexpected fields")
  }
  const profile = value.profile
  const route = value.route
  if (!exact(profile, ["profileID", "revision", "profileDigest", "trust"]) ||
      !id(profile.profileID) || !revision(profile.revision) || !digest(profile.profileDigest, ["blake3"]) ||
      (profile.trust !== "system" && profile.trust !== "user") ||
      !digest(value.permissionScopeDigest, ["sha256", "blake3"]) || !revision(value.policyRevision) ||
      !digest(value.policyDigest, ["sha256", "blake3"]) || !id(value.harnessID) || !revision(value.harnessRevision) ||
      !exact(route, Object.hasOwn(route ?? {}, "accountRef")
        ? ["providerID", "modelID", "accountRef", "routeRevision", "endpointRevision"]
        : ["providerID", "modelID", "routeRevision", "endpointRevision"]) ||
      !id(route.providerID) || !id(route.modelID) || !id(route.routeRevision) || !digest(route.endpointRevision, ["blake3"]) ||
      (route.accountRef !== undefined && !id(route.accountRef)) ||
      route.providerID !== expected.providerID || route.modelID !== expected.modelID) {
    throw new TypeError("direct provider authority contains stale or malformed profile, scope, policy, harness, or route pins")
  }
  return value as unknown as DirectProviderAuthorityV1
}

/**
 * §15.2 direct-turn pins, resolved only from the authenticated Core Config
 * profile, the HostKernel-authored direct permission-mode snapshot and the
 * trusted harness profile. Model fields, request JSON and user input never
 * contribute to these pins, and no route/endpoint value is derived here: the
 * route is pinned separately from the transport object that actually sends.
 */
export type DirectProviderAuthorityPinsV1 = {
  readonly profileID: string
  readonly revision: string
  readonly profileDigest: string
  readonly trust: "system" | "user"
  readonly permissionScopeDigest: string
  readonly policyRevision: string
  readonly policyDigest: string
  readonly harnessID: string
  readonly harnessRevision: string
}

/** The single owner-scoped SecretBroker route enabled for direct free inference. */
export const DIRECT_FREE_PROVIDER_ID = "openrouter"
export const DIRECT_FREE_MODEL_ID = "nvidia/nemotron-3.5-super-vl:free"

const CREDENTIAL_HEADER_FIELD = /auth|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|credential/i

function hasSensitiveHeaderValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value as Record<string, unknown>).some(
    ([name, item]) =>
      CREDENTIAL_HEADER_FIELD.test(name) &&
      item !== undefined &&
      item !== null &&
      (typeof item !== "string" || item.length > 0),
  )
}

/**
 * The exact anonymous OpenCode offer carries the literal `public` token, which
 * is not a user credential. Every other credential-bearing projection - a user
 * key, a declared environment source, an auth record or a sensitive header -
 * stays closed until request-scoped SecretBroker transport and its Guard
 * authorization are verified.
 */
export function hasUnadmittedCredentialProjection(input: {
  readonly provider: Provider.Info
  readonly model: Provider.Model
  readonly env: Readonly<Record<string, string | undefined>>
}): boolean {
  const provider = input.provider
  if (provider.env.some((name) => (input.env[name] ?? "").length > 0)) return true
  if (provider.key !== undefined && provider.key !== null && (typeof provider.key !== "string" || provider.key.length > 0)) {
    return true
  }
  if (hasSensitiveHeaderValue((provider.options as Record<string, unknown>).headers)) return true
  const apiKey = (provider.options as Record<string, unknown>).apiKey
  if (apiKey === "public") return !Provider.isAnonymousFreeModel(provider, input.model)
  return apiKey !== undefined && apiKey !== null && (typeof apiKey !== "string" || apiKey.length > 0)
}

export function directFreeCredentialRouteOptIn(input: {
  readonly managed: boolean
  readonly providerID: string
  readonly modelID: string
}): boolean {
  return !input.managed && input.providerID === DIRECT_FREE_PROVIDER_ID && input.modelID === DIRECT_FREE_MODEL_ID
}

export const resolveDirectProviderAuthorityPinsV1 = Effect.fn(
  "LLM.resolveDirectProviderAuthorityPinsV1",
)(function* (input: {
  readonly sessionID: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly locationRef: typeof Location.Ref.Type
  readonly supervisor: Pick<SessionSupervisorInterface, "directSessionPermissionModeSnapshot">
  /**
   * Location-scoped AgentProfileV2 service resolved through the
   * LocationServiceMap by the caller. The ambient service remains the fallback
   * for hosts and tests that already provide it directly.
   */
  readonly agentProfiles?: Option.Option<Context.Service.Shape<typeof AgentProfileService>>
}) {
  const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
  if (Option.isNone(principal) || principal.value.principal.kind !== "server_auth" || !principal.value.principal.subject) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "direct provider pins require an authenticated ServerAuth principal",
    })
  }
  const profiles = input.agentProfiles ?? (yield* Effect.serviceOption(AgentProfileService))
  if (Option.isNone(profiles)) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "direct provider pins require the authenticated Core AgentProfileV2 service",
    })
  }
  const profile = yield* profiles.value.primaryAgentProfile().pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!profile) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "direct provider pins require the configured primary AgentProfileV2",
    })
  }
  if (profile.source === "plugin" || profile.source === "external") {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "only Core Config AgentProfileV2 sources can pin a direct provider turn",
    })
  }
  if (profile.model.providerId !== input.model.providerID || profile.model.modelId !== input.model.id) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "the selected provider/model is not the authenticated AgentProfileV2 selection",
    })
  }
  const harness = builtinHarnessProfileV1(profile.harness)
  if (!harness) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "the authenticated AgentProfileV2 harness profile is unavailable",
    })
  }
  const mode = yield* input.supervisor
    .directSessionPermissionModeSnapshot({ sessionID: input.sessionID, locationRef: input.locationRef })
    .pipe(
      Effect.provideService(TrustedPrincipalContext, principal.value),
      Effect.catch((error) =>
        Effect.fail(
          new SessionSupervisorError({
            stage: "direct_provider_authority",
            reason: `the HostKernel direct permission-mode snapshot is unavailable: ${error.reason}`,
          }),
        ),
      ),
    )
  if (mode.sessionId !== input.sessionID) {
    return yield* new SessionSupervisorError({
      stage: "direct_provider_authority",
      reason: "the HostKernel permission-mode snapshot belongs to a different Session",
    })
  }
  // Widened to the public pin type: callers and validators must see exactly
  // DirectProviderAuthorityPinsV1, never the narrower branded source aliases.
  const pins: DirectProviderAuthorityPinsV1 = {
    profileID: profile.profileId,
    revision: String(profile.revision),
    profileDigest: agentProfileDefinitionDigest(profile),
    trust: profile.source === "builtin" ? ("system" as const) : ("user" as const),
    permissionScopeDigest: mode.digest,
    policyRevision: mode.revision,
    policyDigest: mode.policyDigest,
    harnessID: harness.harnessId,
    harnessRevision: String(harness.revision),
  }
  return pins
})

/**
 * Combine the authenticated pins with the exact route projection of the
 * transport that will send this turn. Any caller-supplied authority must equal
 * the authenticated projection field-for-field; a stale or divergent caller
 * projection fails closed before bytes are prepared.
 */
export function finalizeDirectProviderAuthorityV1(input: {
  readonly pins: DirectProviderAuthorityPinsV1
  readonly route: {
    readonly providerID: string
    readonly modelID: string
    readonly harnessID: string
    readonly routeRevision: string
    readonly endpointRevision: string
  }
  readonly expected: { readonly providerID: string; readonly modelID: string }
  readonly provided?: DirectProviderAuthorityV1
}): DirectProviderAuthorityV1 {
  if (input.route.harnessID !== input.pins.harnessID) {
    throw new TypeError("direct provider route harness differs from the authenticated harness pin")
  }
  const authority: DirectProviderAuthorityV1 = {
    profile: {
      profileID: input.pins.profileID,
      revision: input.pins.revision,
      profileDigest: input.pins.profileDigest,
      trust: input.pins.trust,
    },
    permissionScopeDigest: input.pins.permissionScopeDigest,
    policyRevision: input.pins.policyRevision,
    policyDigest: input.pins.policyDigest,
    harnessID: input.pins.harnessID,
    harnessRevision: input.pins.harnessRevision,
    route: {
      providerID: input.route.providerID,
      modelID: input.route.modelID,
      routeRevision: input.route.routeRevision,
      endpointRevision: input.route.endpointRevision,
    },
  }
  const validated = validateDirectProviderAuthorityV1(authority, input.expected)
  if (input.provided !== undefined) {
    const caller = validateDirectProviderAuthorityV1(input.provided, input.expected)
    const equal =
      caller.profile.profileID === validated.profile.profileID &&
      caller.profile.revision === validated.profile.revision &&
      caller.profile.profileDigest === validated.profile.profileDigest &&
      caller.profile.trust === validated.profile.trust &&
      caller.permissionScopeDigest === validated.permissionScopeDigest &&
      caller.policyRevision === validated.policyRevision &&
      caller.policyDigest === validated.policyDigest &&
      caller.harnessID === validated.harnessID &&
      caller.harnessRevision === validated.harnessRevision &&
      caller.route.providerID === validated.route.providerID &&
      caller.route.modelID === validated.route.modelID &&
      caller.route.routeRevision === validated.route.routeRevision &&
      caller.route.endpointRevision === validated.route.endpointRevision &&
      caller.route.accountRef === validated.route.accountRef
    if (!equal) {
      throw new TypeError("caller-supplied direct provider pins differ from the authenticated projection")
    }
  }
  return validated
}

export type ManagedProviderContextV1 = {
  readonly attemptID: string
  readonly taskID: string
  readonly specID: string
  readonly specDigest: string
  readonly taskRevision: string
  readonly taskContextDigest: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly harnessID: string
  readonly selectionSessionID: string
  readonly sourceRevision: string
  /** Stable Core request identity, allocated before the corresponding HostKernel admission/advance. */
  readonly requestID: string
  readonly requestSequence: string
  /** HostKernel receipt for the exact frozen sequence-1 selection. */
  readonly contextSelectionDigest: string
  /** The exact frozen selection for sequence 1; later requests are compiled at prepareStep. */
  readonly initialSelection?: ContextSelectionV1
  /** The exact SDK-normalized sequence-1 body captured before admission. */
  readonly initialProviderInput?: ManagedProviderInputV1
}

export type ManagedProviderInputV1 = {
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    readonly schema: unknown
    readonly internal: boolean
    readonly strict?: boolean
  }[]
  readonly toolChoice: string
  readonly maxOutputTokens: number
  /** Exact non-secret generation/provider parameters passed to the adapter. */
  readonly temperature: number | undefined
  readonly topP: number | undefined
  readonly topK: number | undefined
  readonly providerOptions: unknown
}

/** Non-secret exact dispatch facts handed to SessionProcessor for settlement. */
export type ManagedProviderDispatchHandoffV1 = {
  readonly status: "DISPATCHING"
  /** Provider SDK stream step used to join this dispatch to its persisted step-finish. */
  readonly stepFinishIndex: number
  readonly contextSelection: ContextSelectionV1
  readonly routeProjection: ManagedProviderRouteProjectionV1
  readonly requestPins: {
    readonly requestID: string
    readonly requestSequence: string
    readonly contextSelectionDigest: string
    readonly requestDigest: string
    readonly transportRequestDigest: string
    readonly operationDigest: string
  }
  readonly providerRequestID: string
  readonly prepareDigest: string
  readonly dispatchDigest: string
}

/** Opaque coordinator handoff; it carries the compiled body and its exact refs together. */
export type ManagedPreparedRequestV1 = {
  readonly contextSelection: ContextSelectionV1
  readonly providerInput: ManagedProviderInputV1
  readonly toolSources: readonly ToolsetSourceRefV1[]
  readonly context: Omit<ManagedProviderContextV1, "initialSelection" | "initialProviderInput" | "contextSelectionDigest">
}

const MAX_PROVIDER_INPUT_CANONICAL_BYTES = 16 * 1024 * 1024

function contextLedgerEntries(selection: ContextSelectionV1): ContextLedgerEntryV2[] {
  return selection.sources.map((source) => {
    const sourceRef = `${source.kind}:${source.sourceID}`
    const entryKind: ContextLedgerEntryV2["kind"] = source.kind === "managed-task" || source.kind === "accepted-spec"
      ? "goal"
      : source.kind === "agent-profile" || source.kind === "instruction"
        ? "system"
        : source.kind === "session-message"
          ? "environment"
          : source.kind === "tool"
            ? "tool_call"
            : source.kind === "skill"
              ? "skill"
              : source.kind === "artifact"
                ? "artifact"
                : "environment"
    const cacheClass: ContextLedgerEntryV2["cacheClass"] = source.kind === "session-message"
      ? "history"
      : source.kind === "provider-input"
        ? "turn"
        : source.kind === "artifact"
          ? "attachment"
          : source.kind === "tool" || source.kind === "agent-profile" || source.kind === "instruction"
            ? "static"
            : "none"
    return {
      entryID: `context:${sourceRef}`,
      kind: entryKind,
      sourceRef,
      sourceRevision: source.sourceRevision,
      trust: source.trust,
      bytesKind: "unknown",
      tokens: { kind: "unknown" },
      included: true,
      inclusionReason: source.inclusionReason,
      protected: source.kind !== "tool" && source.kind !== "skill",
      cacheClass,
      digest: `blake3:${bytesToHex(blake3(Buffer.from(`${sourceRef}\0${source.contentDigest}`, "utf8")))}`,
    }
  })
}

/** Canonical JSON form for hashing only the normalized provider-visible request fields. */
function canonicalProviderInput(value: unknown): string {
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > 200_000 || depth > 48) throw new RangeError("provider input exceeds the context-selection bound")
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
      const record = item as Record<string, unknown>
      const output: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(record).toSorted()) {
        const entry = record[key]
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
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_INPUT_CANONICAL_BYTES) {
    throw new RangeError("provider input exceeds the context-selection byte bound")
  }
  return encoded
}

function freezeProviderValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const item of Object.values(value as Record<string, unknown>)) freezeProviderValue(item, seen)
  return Object.freeze(value)
}

/**
 * Narrow frozen managed provider options to the adapter's JSON record shape.
 * A frozen value that is not a namespace/object record falls back to the same
 * transform the request digest validates, so an unexpected shape never reaches
 * the provider adapter as-is.
 */
function sharedProviderOptions(value: unknown): SharedV3ProviderOptions | undefined {
  if (!isJSONObject(value)) return undefined
  const result: SharedV3ProviderOptions = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isJSONObject(item)) return undefined
    result[key] = item
  }
  return result
}

/** Hashes the exact normalized inputs supplied to the provider adapter; never a legacy/session scalar. */
export function providerInputDigest(input: {
  readonly system: readonly string[]
  readonly messages: readonly unknown[]
  readonly tools: Readonly<Record<string, unknown>> | readonly unknown[]
  readonly toolChoice?: string
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly providerOptions?: unknown
}): string {
  const canonical = canonicalProviderInput({
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    temperature: input.temperature ?? null,
    topP: input.topP ?? null,
    topK: input.topK ?? null,
    providerOptions: input.providerOptions ?? null,
  })
  return `blake3:${bytesToHex(blake3(Buffer.from(canonical, "utf8")))}`
}

/**
 * Produce the exact message array handed to the provider adapter. The provider
 * transform is deliberately applied during managed preflight/step preparation,
 * before ContextSelection is authorized, and its result is then reused at
 * dispatch. Clone first because several existing provider transforms normalize
 * message parts in place.
 */
function managedProviderMessages(
  messages: readonly ModelMessage[],
  model: Provider.Model,
  options: Record<string, unknown>,
): readonly ModelMessage[] {
  const copy = structuredClone(messages) as ModelMessage[]
  return freezeProviderValue(ProviderTransform.message(copy, model, options))
}

/**
 * Build the HostKernel-verifiable reference envelope for one exact managed
 * provider request. The request payload itself is never copied into the DTO;
 * its aggregate digest is carried by the required provider-input reference.
 * Callers must freeze and dispatch the same normalized payload they hash here.
 */
export function compileManagedContextSelection(input: {
  readonly sessionID: string
  readonly requestID: string
  readonly requestSequence: string
  readonly sourceRevision: string
  readonly attemptID: string
  readonly taskID: string
  readonly taskRevision: string
  readonly taskContextDigest: string
  readonly specID: string
  readonly specDigest: string
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly toolSources: readonly ToolsetSourceRefV1[]
  readonly providerInput: {
    readonly system: readonly string[]
    readonly messages: readonly unknown[]
    readonly tools: readonly unknown[]
    readonly toolChoice?: string
    readonly maxOutputTokens?: number
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly providerOptions?: unknown
  }
}): ContextSelectionV1 {
  const selection = {
    schemaVersion: 1 as const,
    lane: "managed" as const,
    sessionID: input.sessionID,
    requestID: input.requestID,
    attemptID: input.attemptID,
    requestSequence: input.requestSequence,
    mode: "fresh" as const,
    sourceRevision: input.sourceRevision,
    sources: [
      {
        kind: "managed-task" as const,
        sourceID: input.taskID,
        sourceRevision: input.taskRevision,
        contentDigest: input.taskContextDigest,
        sourceAuthority: "managed-control" as const,
        trust: "system" as const,
        included: true as const,
        inclusionReason: "required" as const,
      },
      {
        kind: "accepted-spec" as const,
        sourceID: input.specID,
        sourceRevision: input.specID,
        contentDigest: input.specDigest,
        sourceAuthority: "managed-control" as const,
        trust: "system" as const,
        included: true as const,
        inclusionReason: "required" as const,
      },
      {
        kind: "agent-profile" as const,
        sourceID: input.profileID,
        sourceRevision: input.profileRevision,
        contentDigest: input.profileDigest,
        sourceAuthority: "core-config" as const,
        trust: "system" as const,
        included: true as const,
        inclusionReason: "profile" as const,
      },
      {
        kind: "provider-input" as const,
        sourceID: input.requestID,
        sourceRevision: input.requestSequence,
        contentDigest: providerInputDigest(input.providerInput),
        sourceAuthority: "core-prompt-compiler" as const,
        trust: "mixed" as const,
        included: true as const,
        inclusionReason: "current_request" as const,
      },
      ...input.toolSources,
    ],
  }
  return Schema.decodeUnknownSync(ContextSelectionSchemaV1, { onExcessProperty: "error" })(selection)
}

/** Compare persisted/reprepared selections without weakening their order or source pins. */
export function sameManagedContextSelectionV1(left: ContextSelectionV1, right: ContextSelectionV1): boolean {
  try {
    const decode = Schema.decodeUnknownSync(ContextSelectionSchemaV1, { onExcessProperty: "error" })
    return canonicalProviderInput(decode(left)) === canonicalProviderInput(decode(right))
  } catch {
    return false
  }
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
  readonly prepareManagedRequest: (input: StreamInput) => Effect.Effect<ManagedProviderInputV1, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
  | SessionSupervisorService
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const supervisor = yield* SessionSupervisor.Service
    const locations = yield* Effect.serviceOption(LocationServiceMap.Service)

    // AgentProfileService is a Core Config location node: it is only bound
    // inside the per-location LocationServiceMap, never in this global graph.
    // Resolve it through the map for the exact turn location instead of adding
    // the location node (and its unbound Location dependency) to this node.
    const agentProfilesAt = (
      ref: typeof Location.Ref.Type,
    ): Effect.Effect<Option.Option<Context.Service.Shape<typeof AgentProfileService>>> =>
      Option.isNone(locations)
        ? Effect.succeed(Option.none())
        : Effect.serviceOption(AgentProfileService).pipe(
            Effect.provide(locations.value.get(ref)),
            Effect.catch(() => Effect.succeed(Option.none())),
          )

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      // Managed provider transport remains gated until HostKernel has durably
      // prepared the exact request, routed its host-created Guard challenge
      // through authenticated approval, issued and consumed the one-use send
      // authorization, and exposed settlement/UNKNOWN recovery end to end.
      const gatedManagedAttempt = input.managedAttempt
      if (gatedManagedAttempt) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_provider_transport",
          reason: "managed provider requests remain unavailable until Guard approval, one-use HostKernel authorization, bounded SecretBroker transport, and settlement recovery are integrated",
        }))
      }
      const trustedPrincipal = yield* Effect.serviceOption(TrustedPrincipalContext)
      const instance = yield* InstanceState.context
      const managedScope = input.managedAttempt?.currentScope()
      const managedTarget = managedScope?.worktreeTarget
      if (managedTarget && AbsolutePath.make(instance.directory) !== AbsolutePath.make(managedTarget.canonicalRoot)) {
        return yield* Effect.fail(new SessionSupervisorError({ stage: "managed_worktree", reason: "managed prompt Instance directory differs from its authenticated P8 worktree target" }))
      }
      const workspaceID = managedTarget
        ? WorkspaceV2.ID.make(managedTarget.workspaceID)
        : yield* InstanceState.workspaceID
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory), workspaceID })
      // §15.2 pins are resolved from Core Config + HostKernel only, before any
      // provider/plugin hook runs; the route pin is finalized with the exact
      // transport route where the language model is constructed.
      //
      // The pin set is an AUTHORITY projection, so it is required only for a
      // turn that claims §15.2 authority: a managed Attempt, a direct child
      // Attempt/turn, or an explicit caller-supplied projection. A legacy
      // direct prompt claims none of those, so when the authenticated pin set
      // cannot be built (no configured primary AgentProfileV2, or no reachable
      // HostKernel permission-mode snapshot) it keeps the ordinary direct
      // provider path instead of fabricating a pin. Credential, Guard and
      // SecretBroker gates below are untouched by this fail-over.
      const resolvePins = resolveDirectProviderAuthorityPinsV1({
        sessionID: input.sessionID,
        model: { providerID: input.model.providerID, id: input.model.id },
        locationRef,
        supervisor,
        agentProfiles: yield* agentProfilesAt(locationRef),
      })
      const authorityRequired =
        input.managedAttempt !== undefined ||
        input.directAttempt !== undefined ||
        input.directTurn !== undefined ||
        input.directProviderAuthority !== undefined
      const authorityPins: Option.Option<DirectProviderAuthorityPinsV1> = authorityRequired
        ? Option.some(yield* resolvePins)
        : yield* resolvePins.pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              Effect.logWarning(
                "legacy direct turn has no §15.2 authority pins; continuing on the ordinary direct provider path",
                {
                  "session.id": input.sessionID,
                  reason: error instanceof SessionSupervisorError ? error.reason : String(error),
                },
              ).pipe(Effect.map((): Option.Option<DirectProviderAuthorityPinsV1> => Option.none())),
            ),
          )
      const directHarnessID = Option.isSome(authorityPins)
        ? authorityPins.value.harnessID
        : (input.toolDiscovery?.harnessID ?? "native-rich")
      if (managedTarget) {
        if (Option.isNone(trustedPrincipal)) {
          return yield* Effect.fail(new SessionSupervisorError({ stage: "managed_worktree", reason: "managed prompt has no authenticated Core principal" }))
        }
        const registeredLocationID = yield* supervisor.registerHostLocation(locationRef).pipe(
          Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value),
        )
        if (registeredLocationID !== managedTarget.locationID) {
          return yield* Effect.fail(new SessionSupervisorError({ stage: "managed_worktree", reason: "managed prompt Location differs from HostKernel's authenticated P8 worktree target" }))
        }
      }
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      // No provider SDK may receive legacy auth, environment credentials or
      // credential headers until the SecretBroker lease is wired to the native
      // request-scoped transport. Fail before provider construction or plugin
      // hooks so an unsupported native route cannot silently fall back to AI SDK auth.
      const sensitiveHeaders = (value: unknown) =>
        typeof value === "object" && value !== null
          ? Object.entries(value).some(
              ([name, item]) =>
                /auth|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|credential/i.test(name) &&
                item !== undefined &&
                item !== null &&
                (typeof item !== "string" || item.length > 0),
            )
          : false
      // Provider resolution can invoke provider/plugin hooks. Reject all
      // credential material visible from the already loaded config and model
      // before calling that service, so denial has no provider-hook effects.
      const [cfg, info] = yield* Effect.all(
        [config.get(), auth.get(input.model.providerID)],
        { concurrency: "unbounded" },
      )
      const configured = cfg.provider?.[input.model.providerID]
      const hasCredentialValue = (value: unknown) =>
        value !== undefined && value !== null && (typeof value !== "string" || value.length > 0)
      const hasConfiguredCredential =
        hasCredentialValue(configured?.options?.apiKey) ||
        (configured?.env ?? []).some((name) => typeof process.env[name] === "string" && process.env[name]!.length > 0) ||
        sensitiveHeaders(configured?.options?.headers)
      const directFreeOptIn = directFreeCredentialRouteOptIn({
        managed: input.managedAttempt !== undefined,
        providerID: input.model.providerID,
        modelID: input.model.id,
      })
      // OpenRouter's AI SDK path calls its configured fetch directly and does
      // not enter Core RequestExecutor's pinned SessionStore dispatcher. Never
      // construct/send the synthetic placeholder until that bridge is selected.
      if (directFreeOptIn) {
        return yield* Effect.fail(new Auth.AuthError({
          message: "The OpenRouter free route is unavailable until Core RequestExecutor owns its pinned provider send",
        }))
      }

      const hasCredentialedAuth =
        info !== undefined ||
        hasConfiguredCredential ||
        hasCredentialValue(input.model.options.apiKey) ||
        sensitiveHeaders(input.model.options.headers) ||
        sensitiveHeaders(input.model.headers)
      if (hasCredentialedAuth) {
        return yield* Effect.fail(new Auth.AuthError({
          message: "Provider credentials are unavailable until request-scoped SecretBroker transport is verified",
        }))
      }

      const item = yield* provider.getProvider(input.model.providerID)
      // The literal `public` token of the exact anonymous OpenCode offer is the
      // only credential-looking value admitted here; it is not a user secret.
      const hasResolvedCredential = hasUnadmittedCredentialProjection({
        provider: item,
        model: input.model,
        env: process.env,
      })
      // SecretBroker reference is metadata only. It is consumed inside Auth at
      // the pinned request transport; it never enters Provider config or logs.
      if (hasResolvedCredential) {
        return yield* Effect.fail(
          new Auth.AuthError({
            message: "Provider credentials are unavailable until request-scoped SecretBroker transport is verified",
          }),
        )
      }

      // Pin the exact selected route; free credentials are not passed into the
      // Provider projection and only enter Auth's pinned send boundary.
      const directTransport = yield* provider.getDirectLanguage({
        model: input.model,
        harnessID: directHarnessID,
        fetch,
      })
      // Finalisation is the same authority claim: a legacy direct turn that
      // resolved no pins never finalises (and never logs) a §15.2 projection.
      if (Option.isSome(authorityPins)) {
        const directProviderAuthority = yield* Effect.try({
          try: () =>
            finalizeDirectProviderAuthorityV1({
              pins: authorityPins.value,
              route: directTransport.route,
              expected: { providerID: input.model.providerID, modelID: input.model.id },
              ...(input.directProviderAuthority === undefined ? {} : { provided: input.directProviderAuthority }),
            }),
          catch: (error) =>
            new SessionSupervisorError({
              stage: "direct_provider_authority",
              reason: error instanceof Error ? error.message : "direct provider authority pins are invalid",
            }),
        })
        yield* Effect.logInfo("direct provider authority resolved", {
          "session.id": input.sessionID,
          profileID: directProviderAuthority.profile.profileID,
          profileRevision: directProviderAuthority.profile.revision,
          trust: directProviderAuthority.profile.trust,
          harnessID: directProviderAuthority.harnessID,
          harnessRevision: directProviderAuthority.harnessRevision,
          routeRevision: directProviderAuthority.route.routeRevision,
          endpointRevision: directProviderAuthority.route.endpointRevision,
          routeCredential: "anonymous-free",
          permissionScopeDigest: directProviderAuthority.permissionScopeDigest,
          policyRevision: directProviderAuthority.policyRevision,
        })
      }
      const language = directTransport.language

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      // This provider may execute tools server-side before our callbacks run.
      // Do not treat provider approval hooks as kernel EffectHost admission.
      requireMediatedWorkflowProvider(isWorkflow)
      const definitions: Record<string, ToolBatchDefinition> = { ...(input.toolDefinitions ?? {}) }
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        tools: filterTools(input.tools, definitions, !isWorkflow),
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
        managedRequest: input.managedAttempt !== undefined,
      })
      if (prepared.tools["_noop"] && !definitions["_noop"]) {
        definitions["_noop"] = {
          capability: { id: "tool.noop", effectClass: "control" },
          schema: {},
          internal: true,
          validate: async (value) => value,
        }
      }
      const runtimeTools = filterTools(prepared.tools, definitions, !isWorkflow)

      const managedRequestCursor = input.managedContext
        ? { sequence: BigInt(input.managedContext.requestSequence), requestID: input.managedContext.requestID }
        : undefined
      let activeManagedSelection = input.managedContext?.initialSelection
      let activeManagedSelectionDigest = input.managedContext?.contextSelectionDigest

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      const batchContext = createToolBatchContext()
      const permissionRules = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
      const adapterState = LLMAISDK.adapterState()
      const definitionsSnapshot = Object.entries(definitions)
        .filter(([name]) => runtimeTools[name])
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => ({
          name,
          capability: definition.capability,
          schema: definition.schema,
          internal: definition.internal === true,
        }))
      const providerTools = Object.entries(runtimeTools)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => ({
          name,
          description: typeof definition.description === "string" ? definition.description : "",
          schema: definitions[name]?.schema ?? null,
          internal: definitions[name]?.internal === true,
          strict: definition.strict,
        }))
      const providerToolList = (tools: Readonly<Record<string, Tool>>) => Object.entries(tools)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => ({
          name,
          description: typeof definition.description === "string" ? definition.description : "",
          schema: definitions[name]?.schema ?? null,
          internal: definitions[name]?.internal === true,
          strict: definition.strict,
        }))
      // The exact SessionTools.resolve catalog and wrappers are bound to the
      // ordinary ToolBatch middleware below. A caller-provided dispatcher must
      // never become an alternate route around this request's Guarded path.
      if (input.managedAttempt) {
        if (!input.managedContext || !input.authorizeManagedProviderRequest) {
          return yield* Effect.fail(new SessionSupervisorError({
            stage: "managed_context",
            reason: "managed provider dispatch has no authenticated request authority",
          }))
        }
        const initial = input.managedContext?.initialProviderInput
        if (!initial) {
          return yield* Effect.fail(new SessionSupervisorError({
            stage: "managed_context",
            reason: "managed Attempt has no frozen pre-admission provider request",
          }))
        }
        const preparedProviderInput: ManagedProviderInputV1 = {
          system: prepared.system,
          messages: managedProviderMessages(prepared.messages, input.model, prepared.messageTransformOptions),
          tools: providerTools,
          toolChoice: input.toolChoice ?? "auto",
          maxOutputTokens: managedStepOutputTokenLimit(
            input.managedAttempt.remainingTokens(),
            prepared.params.maxOutputTokens ?? OUTPUT_TOKEN_MAX,
          ),
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
        }
        if (providerInputDigest(preparedProviderInput) !== providerInputDigest(initial)) {
          return yield* Effect.fail(new SessionSupervisorError({
            stage: "managed_context",
            reason: "post-admission LLM preparation differs from the frozen sequence-1 provider request",
          }))
        }
      }
      const turnContextDigest = `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            runner: "HorizonCodeV1LLM",
            sessionID: input.sessionID,
            userID: input.user.id,
            agentName: input.agent.name,
            agentMode: input.agent.mode,
            providerID: input.model.providerID,
            modelID: input.model.id,
            modelVariant: input.user.model.variant ?? null,
            permissionRules,
            toolDefinitions: definitionsSnapshot,
          }),
        )
        .digest("hex")}`
      const batchMiddleware = toolBatchMiddleware({
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        directAttempt: input.directAttempt,
        directTurn: input.directTurn,
        managedAttempt: input.managedAttempt,
        onProviderRawChunk: (rawValue) => {
          const billed = LLMAISDK.copilotTotalNanoAiu(rawValue)
          if (billed !== undefined) adapterState.copilotTotalNanoAiu = billed
        },
        nextStepFinishIndex: () => adapterState.step,
        beforeManagedEffects:
          input.managedAttempt && input.beforeManagedEffects
            ? async ({ finish, stepFinishIndex, calls }) => {
                const normalized = LLMAISDK.providerStepFinish({
                  usage: finish.usage,
                  providerMetadata: finish.providerMetadata,
                  copilotTotalNanoAiu: adapterState.copilotTotalNanoAiu,
                })
                const usage = SessionUsage.getUsage({
                  model: input.model,
                  usage: new Usage(normalized.usage ?? {}),
                  metadata: normalized.providerMetadata,
                })
                const reason = LLMAISDK.finishReason(finish.finishReason.unified)
                return bridge.promise(
                  input.beforeManagedEffects!({
                    stepFinishIndex,
                    usageProvenance: usage.usageProvenance,
                    finishReason: reason,
                    cost: usage.cost,
                    tokens: usage.tokens,
                    calls,
                  }),
                  { signal: input.abort },
                )
              }
            : undefined,
        locationRef,
        turnContextDigest,
        signal: input.abort,
        definitions,
        context: batchContext,
        ...(input.toolDiscovery ? {
          codeMode: {
            tools: input.toolDiscovery.codeModeTools,
            executors: input.toolDiscovery.codeModeExecutors,
            lane: input.managedAttempt ? "managed_attempt" as const : "direct_session" as const,
            prepare: ({ callID, requestID, frame, calls }) => {
              if (Option.isNone(trustedPrincipal)) return Promise.reject(new Error("Authenticated principal is unavailable for CodeMode admission"))
              return bridge.promise(supervisor.prepareCodeModeToolBatch({
                sessionID: input.sessionID,
                locationRef,
                callID,
                lane: input.managedAttempt ? "managed_attempt" : "direct_session",
                ...(input.managedAttempt ? { managedAttempt: input.managedAttempt.currentScope() } : {}),
                requestID,
                waveFrame: frame,
                calls,
              }).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)))
            },
            receipts: ({ callID, requestID, waveIndex }) => {
              if (Option.isNone(trustedPrincipal)) return Promise.reject(new Error("Authenticated principal is unavailable for CodeMode receipt lookup"))
              return bridge.promise(supervisor.codeModeWaveReceipts({
                sessionID: input.sessionID,
                locationRef,
                callID,
                lane: input.managedAttempt ? "managed_attempt" : "direct_session",
                ...(input.managedAttempt ? { managedAttempt: input.managedAttempt.currentScope() } : {}),
                requestID,
                waveIndex,
              }).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)), { signal: input.abort })
            },
            settleResults: ({ callID, requestID, waveIndex, results }) => {
              if (Option.isNone(trustedPrincipal)) return Promise.reject(new Error("Authenticated principal is unavailable for CodeMode callback settlement"))
              // The host settlement projection is consumed by the wave receipt
              // path; this callback's contract is Promise<void>.
              return bridge.promise(supervisor.settleCodeModeToolResults({
                sessionID: input.sessionID,
                locationRef,
                callID,
                lane: input.managedAttempt ? "managed_attempt" : "direct_session",
                ...(input.managedAttempt ? { managedAttempt: input.managedAttempt.currentScope() } : {}),
                requestID,
                waveIndex,
                results,
              }).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)), { signal: input.abort })
                .then(() => undefined)
            },
            cancel: ({ callID, requestID, waveIndex, reason }) => {
              if (Option.isNone(trustedPrincipal) || !supervisor.cancelCodeModeWave) {
                return Promise.reject(new Error("Correlated CodeMode wave cancellation is unavailable"))
              }
              return bridge.promise(supervisor.cancelCodeModeWave({
                sessionID: input.sessionID,
                locationRef,
                callID,
                lane: input.managedAttempt ? "managed_attempt" : "direct_session",
                ...(input.managedAttempt ? { managedAttempt: input.managedAttempt.currentScope() } : {}),
                requestID,
                waveIndex,
                reason,
              }).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)), { signal: input.abort })
            },
          } satisfies CodeModeToolBatchV1,
        } : {}),
        prepareToolBatch: (request) => {
          if (Option.isNone(trustedPrincipal)) {
            return Promise.resolve({ status: "denied" as const, reason: "Authenticated principal is unavailable" })
          }
          if (!request.calls.some((call) => call.capabilityID === "terminal.run"))
            return bridge.promise(
              supervisor.prepareToolBatch(request).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)),
              { signal: request.signal },
            )
          if (!Option.isSome(locations)) {
            return Promise.resolve({
              status: "denied" as const,
              reason: "PTY location services are unavailable",
            })
          }
          return bridge.promise(
            Effect.gen(function* () {
              const terminal = yield* Pty.Service
              return yield* terminal.prepareToolBatch(request)
            }).pipe(
              Effect.provide(locations.value.get(locationRef)),
              Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value),
            ),
            { signal: request.signal },
          )
        },
        cancelToolBatch: ({ sessionID, batchID }) =>
          Option.isNone(trustedPrincipal)
            ? Promise.resolve()
            : bridge.promise(
                Effect.gen(function* () {
                  const locationID = yield* supervisor.registerHostLocation(locationRef)
                  yield* supervisor
                    .requestHostKernel(
                      "effects.v2",
                      "cancel_batch",
                      { locationID, sessionID, batchID },
                      { trustedPrincipal: trustedPrincipal.value.principal },
                    )
                    .pipe(Effect.asVoid)
                }).pipe(Effect.provideService(TrustedPrincipalContext, trustedPrincipal.value)),
              ),
      })
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = runtimeTools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(runtimeTools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      const managedOutputLimit = input.managedAttempt
        ? managedStepOutputTokenLimit(
            input.managedAttempt.remainingTokens(),
            prepared.params.maxOutputTokens ?? OUTPUT_TOKEN_MAX,
          )
        : prepared.params.maxOutputTokens
      // Native transport has no durable HostKernel request-intent adapter yet.
      // Managed requests stay on the AI SDK boundary, where dispatch can be fenced.
      if (flags.experimentalNativeLlm && !input.managedAttempt) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: filterTools(runtimeTools, definitions, false),
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: managedOutputLimit,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      const managedInitial = input.managedContext?.initialProviderInput
      return {
        type: "ai-sdk" as const,
        state: adapterState,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && runtimeTools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: managedInitial?.temperature ?? prepared.params.temperature,
          topP: managedInitial?.topP ?? prepared.params.topP,
          topK: managedInitial?.topK ?? prepared.params.topK,
          providerOptions: sharedProviderOptions(managedInitial?.providerOptions) ??
            ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(runtimeTools).filter((x) => x !== "invalid"),
          tools: runtimeTools,
          experimental_context: batchContext,
          maxOutputTokens: managedInitial?.maxOutputTokens ?? prepared.params.maxOutputTokens,
          toolChoice: managedInitial?.toolChoice as "auto" | "required" | "none" | undefined ?? input.toolChoice,
          ...(!input.managedAttempt && input.toolDiscovery
            ? { prepareStep: (() => {
                  let firstStep = true
                  return async () => {
                    if (firstStep) {
                      firstStep = false
                      return {}
                    }
                    const next = input.toolDiscovery!.prepareNextProviderRequest()
                    const nextTools = filterTools(next.tools, definitions, !isWorkflow)
                    return {
                      tools: nextTools,
                      activeTools: Object.keys(nextTools).filter((name) => name !== "invalid"),
                    }
                  }
                })() }
            : {}),
          ...(input.managedAttempt ? {
                prepareStep: async (step) => {
                  const context = input.managedContext!
                  const nextSequence = managedRequestCursor!.sequence
                  const maxOutputTokens = managedStepOutputTokenLimit(
                    input.managedAttempt!.remainingTokens(),
                    prepared.params.maxOutputTokens ?? OUTPUT_TOKEN_MAX,
                  )
                  const isInitialRequest = nextSequence === BigInt(context.requestSequence)
                  const nextToolProjection = isInitialRequest
                    ? undefined
                    : input.toolDiscovery?.prepareNextProviderRequest()
                  const nextRuntimeTools = nextToolProjection
                    ? filterTools(nextToolProjection.tools, definitions, !isWorkflow)
                    : runtimeTools
                  const nextProviderTools = nextToolProjection ? providerToolList(nextRuntimeTools) : providerTools
                  const toolSources = isInitialRequest
                    ? (input.toolDiscovery?.sourceRefs ?? [])
                    : (nextToolProjection?.sourceRefs ?? input.toolDiscovery?.sourceRefs ?? [])
                  const messages = isInitialRequest
                    ? context.initialProviderInput!.messages
                    : managedProviderMessages(step.messages, input.model, prepared.messageTransformOptions)
                  const providerInput = freezeProviderValue({
                    system: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.system
                      : prepared.system,
                    messages,
                    tools: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.tools
                      : nextProviderTools,
                    toolChoice: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.toolChoice
                      : input.toolChoice ?? "auto",
                    maxOutputTokens: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.maxOutputTokens
                      : maxOutputTokens,
                    temperature: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.temperature
                      : prepared.params.temperature,
                    topP: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.topP
                      : prepared.params.topP,
                    topK: nextSequence === BigInt(context.requestSequence)
                      ? context.initialProviderInput!.topK
                      : prepared.params.topK,
                    providerOptions: nextSequence === BigInt(context.requestSequence)
                      ? sharedProviderOptions(context.initialProviderInput!.providerOptions) ??
                        ProviderTransform.providerOptions(input.model, prepared.params.options)
                      : ProviderTransform.providerOptions(input.model, prepared.params.options),
                  })
                  const requestID = nextSequence === BigInt(context.requestSequence)
                    ? context.requestID
                    : `req_managed_${context.attemptID}_${nextSequence}`
                  let sourceRevision = context.sourceRevision
                  if (nextSequence !== BigInt(context.requestSequence)) {
                    const cursor = await bridge.promise(supervisor.sessionProjectionCursor(context.selectionSessionID), { signal: input.abort })
                    if (cursor.ownerKind !== "session" || cursor.ownerId !== context.selectionSessionID ||
                      !/^(0|[1-9][0-9]{0,19})$/.test(cursor.seq) ||
                      !/^blake3:[0-9a-f]{64}$/.test(cursor.eventDigest)) {
                      throw new SessionSupervisorError({
                        stage: "managed_context",
                        reason: "child Session projection cursor is unavailable or malformed",
                      })
                    }
                    sourceRevision = cursor.seq
                  }
                  const selection = compileManagedContextSelection({
                    sessionID: context.selectionSessionID,
                    requestID,
                    requestSequence: nextSequence.toString(),
                    sourceRevision,
                    attemptID: context.attemptID,
                    taskID: context.taskID,
                    taskRevision: context.taskRevision,
                    taskContextDigest: context.taskContextDigest,
                    specID: context.specID,
                    specDigest: context.specDigest,
                    profileID: context.profileID,
                    profileRevision: context.profileRevision,
                    profileDigest: context.profileDigest,
                    toolSources,
                    providerInput,
                  })
                  await bridge.promise(input.authorizeManagedProviderRequest!(selection), { signal: input.abort })
                  activeManagedSelection = selection
                  activeManagedSelectionDigest = input.managedAttempt!.contextSelectionPin().contextSelectionDigest
                  managedRequestCursor!.sequence = nextSequence + 1n
                  return {
                    messages: structuredClone(providerInput.messages) as ModelMessage[],
                    tools: nextRuntimeTools,
                    toolChoice: providerInput.toolChoice as "auto" | "required" | "none",
                    maxOutputTokens: providerInput.maxOutputTokens,
                    temperature: providerInput.temperature,
                    topP: providerInput.topP,
                    topK: providerInput.topK,
                    providerOptions: providerInput.providerOptions,
                  }
                },
              } : {}),
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          // Keep the SDK's internal transcript source untransformed so every
          // prepareStep sees the same canonical history. The first managed
          // step supplies the frozen preflight transform result explicitly;
          // subsequent steps transform their raw accumulated history once.
          messages: input.managedAttempt
            ? structuredClone(prepared.messages)
            : prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              batchMiddleware,
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // Managed requests already use the transform result that
                    // was bound into ContextSelection by prepareStep. Running
                    // this again could change the bytes after authorization.
                    if (!input.managedAttempt) {
                      // @ts-expect-error
                      args.params.prompt = ProviderTransform.message(
                        args.params.prompt,
                        input.model,
                        prepared.messageTransformOptions,
                      )
                    }
                    // Capture only the normalized provider-call digest and
                    // bounded metadata. The raw prompt, schemas and options
                    // remain in the SDK request and are never copied into the
                    // ContextLedger projection.
                    if (input.managedAttempt) {
                      const selection = activeManagedSelection
                      const contextSelectionDigest = activeManagedSelectionDigest
                      // The ledger is a best-effort, ephemeral UI projection.
                      // Its absence or publication failure must never authorize
                      // or prevent the provider request.
                      try {
                        if (!selection || !contextSelectionDigest) throw new TypeError("authorized ContextSelection pin is unavailable")
                        const canonical = canonicalProviderInput(args.params)
                        const profile = builtinHarnessProfileV1(input.managedContext!.harnessID)
                        if (!profile) throw new TypeError("resolved HarnessProfileV1 is unavailable")
                        const projection = compileContextLedgerV2({
                          lane: "managed",
                          sessionID: input.managedContext!.selectionSessionID,
                          requestID: selection.requestID,
                          sourceRevision: selection.sourceRevision,
                          providerID: input.model.providerID,
                          modelID: input.model.id,
                          harnessID: profile.harnessId,
                          harnessRevision: profile.revision,
                          requestPayloadDigest: `blake3:${bytesToHex(blake3(Buffer.from(canonical, "utf8")))}`,
                          requestBytes: Buffer.byteLength(canonical, "utf8"),
                          contextSelection: selection,
                          contextSelectionDigest,
                          entries: contextLedgerEntries(selection),
                        })
                        const ledgerEvent = {
                          timestamp: DateTime.makeUnsafe(Date.now()),
                          sessionID: SessionID.make(input.sessionID),
                          requestID: selection.requestID,
                          sourceRevision: selection.sourceRevision,
                          // The Core prompt admission owns the source generation.
                          // This lets reconnecting clients reject a late projection
                          // from an earlier turn even if it was published recently.
                          sourceGeneration: input.user.id,
                          ledger: projection.ledger,
                          ledgerDigest: projection.ledgerDigest,
                        } satisfies SessionEvent.ContextLedger["data"]
                        const ledgerEventBytes = Buffer.byteLength(JSON.stringify(ledgerEvent), "utf8")
                        if (ledgerEventBytes > 48 * 1024) throw new RangeError("ContextLedger UI event exceeds 48 KiB")
                        // UI projection is best effort. Never delay or gate the
                        // provider request on event storage or client listeners.
                        void bridge.promise(events.publish(SessionEvent.ContextLedger, ledgerEvent, { location: locationRef }), { signal: input.abort })
                          .catch((error) => console.warn("ContextLedger UI event unavailable", error))
                        if (input.onContextLedgerV2) {
                          void bridge.promise(input.onContextLedgerV2(projection), { signal: input.abort })
                            .catch((error) => console.warn("ContextLedger observer unavailable", error))
                        }
                      } catch (error) {
                        console.warn("ContextLedger UI projection unavailable", error)
                      }
                    }
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const prepareManagedRequest__inferred = Effect.fn("LLM.prepareManagedRequest")(function* (input) {
      if (input.directAttempt || input.directTurn || !input.managedRemainingTokens ||
        !/^(0|[1-9][0-9]{0,19})$/.test(input.managedRemainingTokens) || BigInt(input.managedRemainingTokens) < 1n) {
        return yield* new SessionSupervisorError({
          stage: "managed_context",
          reason: "managed request preparation requires a valid Rust-selected token remainder and cannot prepare direct turns",
        })
      }
      const [cfg, authInfo] = yield* Effect.all(
        [config.get(), auth.get(input.model.providerID)],
        { concurrency: "unbounded" },
      )
      const configured = cfg.provider?.[input.model.providerID]
      const hasCredentialValue = (value: unknown) =>
        value !== undefined && value !== null && (typeof value !== "string" || value.length > 0)
      const sensitiveHeaders = (value: unknown) =>
        typeof value === "object" && value !== null
          ? Object.entries(value).some(([name, item]) =>
              /auth|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|credential/i.test(name) &&
              item !== undefined && item !== null && (typeof item !== "string" || item.length > 0))
          : false
      if (hasCredentialValue(input.model.options.apiKey) || sensitiveHeaders(input.model.options.headers) ||
        sensitiveHeaders(input.model.headers) || hasCredentialValue(configured?.options?.apiKey) ||
        sensitiveHeaders(configured?.options?.headers) || authInfo !== undefined) {
        return yield* new SessionSupervisorError({
          stage: "managed_context",
          reason: "managed provider preflight cannot resolve credentials outside the guarded request transport",
        })
      }
      const item = yield* provider.getProvider(input.model.providerID)
      const hasResolvedCredential = hasCredentialValue(item.options.apiKey) || hasCredentialValue(item.key) ||
        item.env.some((name) => typeof process.env[name] === "string" && process.env[name]!.length > 0) ||
        sensitiveHeaders(item.options.headers)
      if (hasResolvedCredential) {
        return yield* new SessionSupervisorError({
          stage: "managed_context",
          reason: "managed provider preflight cannot resolve environment or provider credentials outside the guarded request transport",
        })
      }
      const language = yield* provider.getLanguage(input.model)
      if (language instanceof GitLabWorkflowLanguageModel) {
        return yield* new SessionSupervisorError({
          stage: "managed_context",
          reason: "server-side workflow providers are unavailable for managed context preflight",
        })
      }
      const definitions: Record<string, ToolBatchDefinition> = { ...(input.toolDefinitions ?? {}) }
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        tools: filterTools(input.tools, definitions, true),
        provider: item,
        auth: authInfo,
        plugin,
        flags,
        isWorkflow: false,
        managedRequest: true,
      })
      const runtimeTools = filterTools(prepared.tools, definitions, true)
      const remaining = input.managedRemainingTokens!
      const outputLimit = managedStepOutputTokenLimit(remaining, prepared.params.maxOutputTokens ?? OUTPUT_TOKEN_MAX)
      const tools = Object.entries(runtimeTools).toSorted(([left], [right]) => left.localeCompare(right)).map(([name, definition]) => ({
        name,
        description: typeof definition.description === "string" ? definition.description : "",
        schema: definitions[name]?.schema ?? null,
        internal: definitions[name]?.internal === true,
        strict: definition.strict,
      }))
      const providerOptions = ProviderTransform.providerOptions(input.model, prepared.params.options)
      const containsCredentialField = (value: unknown, depth = 0): boolean => {
        if (depth > 32) return true
        if (Array.isArray(value)) return value.some((item) => containsCredentialField(item, depth + 1))
        if (typeof value !== "object" || value === null) return false
        return Object.entries(value).some(([key, item]) =>
          /auth|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|credential/i.test(key) ||
          containsCredentialField(item, depth + 1))
      }
      if (containsCredentialField(providerOptions)) {
        return yield* new SessionSupervisorError({
          stage: "managed_context",
          reason: "provider parameters contain credential-like fields and cannot enter the managed request digest",
        })
      }
      return Object.freeze({
        system: freezeProviderValue([...prepared.system]),
        messages: managedProviderMessages(prepared.messages, input.model, prepared.messageTransformOptions),
        tools: freezeProviderValue(tools),
        toolChoice: input.toolChoice ?? "auto",
        maxOutputTokens: outputLimit,
        temperature: prepared.params.temperature,
        topP: prepared.params.topP,
        topK: prepared.params.topK,
        providerOptions: freezeProviderValue(structuredClone(providerOptions)),
      })
    })
    const prepareManagedRequest: Interface["prepareManagedRequest"] = prepareManagedRequest__inferred

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(result.state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream, prepareManagedRequest })
  }),
)

export function filterTools(
  tools: Record<string, Tool>,
  definitions: Readonly<Record<string, ToolBatchDefinition>>,
  allowEffects: boolean,
): Record<string, Tool> {
  const result: Record<string, Tool> = {}
  for (const [name, item] of Object.entries(tools)) {
    const definition = definitions[name]
    if (!definition) continue
    const allowed =
      definition.internal === true ||
      definition.capability.effectClass === "read_only" ||
      (allowEffects && definition.capability.effectClass === "effect") ||
      isStandaloneControlTool(name, definition)
    if (!allowed) continue
    if (!item.execute) {
      result[name] = item
      continue
    }
    const execute = item.execute
    const wrapped: Tool = {
      ...item,
      execute(args, options) {
        requireToolExecution({
          context: options.experimental_context,
          callID: options.toolCallId,
          toolName: name,
          capability: definition.capability,
          internal: definition.internal,
        })
        return execute(args, options)
      },
    }
    result[name] = wrapped
  }
  return result
}

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
    SessionSupervisor.node,
    locationServiceMapNode,
  ],
})

export * as LLM from "./llm"
