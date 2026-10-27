import { createHash } from "node:crypto"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { SecretBrokerError, type TrustedSecretUseContext } from "./secret-broker"
import type { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import type { TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import { providerOperationDigest, type CredentialUseAuthorizer } from "./credential-use-authorizer"
import type {
  ModelsDevCatalogFreshnessV1 as ModelsDevCatalogFreshnessSchema,
  ModelsDevCatalogSourceV1 as ModelsDevCatalogSourceSchema,
  PrefixCacheSupportV1 as PrefixCacheSupportSchema,
} from "@opencode-ai/schema/context-compile-policy-v1"

/** §30.26.4 route-capability vocabulary; the schema contract is the sole type authority. */
type PrefixCacheSupportV1 = typeof PrefixCacheSupportSchema.Type
type CatalogSourceV1 = typeof ModelsDevCatalogSourceSchema.Type
type CatalogFreshnessV1 = typeof ModelsDevCatalogFreshnessSchema.Type

const MAX_PROVIDER_BODY_BYTES = 1024 * 1024
const MAX_DIRECT_PROVIDER_RESPONSE_BYTES = 10 * 1024 * 1024

export type ProviderTransportInput = {
  providerId: string
  method: "GET" | "POST"
  destination: string
  body: string
  headers: Record<string, string>
  credentialHeader: { name: "authorization" | "x-api-key" | "x-subscription-token"; prefix: string }
}

export type ProviderTransportRequest = {
  url: string
  method: "GET" | "POST"
  body: string
  headers: Record<string, string>
  signal: AbortSignal
  maxResponseBytes: number
}

/** Direct, user-selected provider route. It is intentionally a Core projection, not HostKernel authority. */
export type DirectProviderRouteV1 = {
  readonly providerID: string
  readonly modelID: string
  readonly harnessID: string
  readonly routeID: string
  readonly routeRevision: string
  readonly endpointRevision: string
  readonly endpointBase: string
  readonly anonymousOpenCodeFree: boolean
  /**
   * Temporary explicit opt-in: this route was selected for a zero-priced model
   * and carries the user's own provider key. `anonymousOpenCodeFree` stays
   * false, so the journaled/pinned direct transport and the managed route
   * projection MUST keep refusing it until a Guarded SecretBroker lease exists.
   */
  readonly explicitFreeCredential?: true
  readonly credentialHeader: ProviderTransportInput["credentialHeader"]
  /**
   * §30.26.4/§30.26.9 prefix-cache capability for this exact pinned route.
   * Projected together with the route selection and never mutated after pin.
   * Readers MUST treat a missing value as `"unknown"`; it is only ever
   * promoted away from `"unknown"` with §30.26.10 real-route validation
   * evidence. The route adapter is authoritative here — advisory catalog
   * pricing can never set it (CX-017). Read-only capability metadata: it is
   * deliberately excluded from the transport digest and changes no dispatch
   * bound, eligibility check, or UNKNOWN/no-replay rule.
   */
  readonly prefixCacheSupport?: PrefixCacheSupportV1
}

export type PreparedDirectProviderTransportV1 = {
  readonly route: DirectProviderRouteV1
  readonly transport: Readonly<ProviderTransportInput>
  readonly transportRequestDigest: string
}

/** §30.26.4 `catalogSnapshot` input: advisory Models.dev provenance for one pinned route. */
export type ContextCompileCatalogSnapshotV1 = {
  readonly source: CatalogSourceV1
  readonly freshness: CatalogFreshnessV1
  readonly model?: {
    readonly limit: { readonly context: number; readonly output: number; readonly input?: number }
    readonly cost?: { readonly cache_read?: number; readonly cache_write?: number }
  }
}

type SnapshotModelRow = {
  readonly id?: string
  readonly limit?: { readonly context?: number; readonly output?: number; readonly input?: number }
  readonly cost?: { readonly cache_read?: number; readonly cache_write?: number }
}

export type ContextCompileCatalogSnapshotInputV1 = {
  /** Result of Core `ModelsDev.getSnapshot()`: provenance plus raw provider rows. */
  readonly snapshot: {
    readonly source: string
    readonly freshness: string
    readonly providers: Readonly<Record<string, { readonly models?: Readonly<Record<string, SnapshotModelRow>> }>>
  }
  readonly providerID: string
  readonly modelID: string
}

const positiveLimit = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const knownPrice = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * Project the pinned Models.dev snapshot's advisory row for this exact route
 * into the §30.26.4 `catalogSnapshot` resolver input (step 3). Read-only: it
 * never enables a route, never claims freshness the snapshot did not record,
 * and OMITS rather than fabricates a malformed/unavailable model row so the
 * resolver falls back to the conservative tier instead of throwing at the
 * consumer. Matches the row by key first, then by declared model id (catalog
 * keys and declared ids can differ).
 */
export function contextCompileCatalogSnapshot(
  input: ContextCompileCatalogSnapshotInputV1,
): ContextCompileCatalogSnapshotV1 {
  const source: CatalogSourceV1 =
    input.snapshot.source === "cache" ||
    input.snapshot.source === "bundled" ||
    input.snapshot.source === "override" ||
    input.snapshot.source === "unavailable"
      ? input.snapshot.source
      : "unavailable"
  const freshness: CatalogFreshnessV1 =
    input.snapshot.freshness === "fresh" || input.snapshot.freshness === "stale"
      ? input.snapshot.freshness
      : "unknown"
  // An unavailable snapshot never carries a model row (resolver contract).
  if (source === "unavailable") return { source, freshness }

  const models = input.snapshot.providers[input.providerID]?.models
  const row = models?.[input.modelID] ?? Object.values(models ?? {}).find((candidate) => candidate.id === input.modelID)
  if (!row) return { source, freshness }
  const context = row.limit?.context
  const output = row.limit?.output
  if (!positiveLimit(context) || !positiveLimit(output)) return { source, freshness }
  const inputLimit = positiveLimit(row.limit?.input) ? row.limit.input : undefined
  const cacheRead = knownPrice(row.cost?.cache_read)
  const cacheWrite = knownPrice(row.cost?.cache_write)
  return {
    source,
    freshness,
    model: {
      limit: { context, output, ...(inputLimit === undefined ? {} : { input: inputLimit }) },
      ...(cacheRead === undefined && cacheWrite === undefined
        ? {}
        : {
            cost: {
              ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
              ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
            },
          }),
    },
  }
}

const DIRECT_PUBLIC_TOKEN = "public"
export const DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER = "horizoncode-direct-credential-placeholder-v1"

/** Inspect and freeze the SDK's exact request before the SessionStore PINNED commit. */
export async function prepareDirectProviderTransportRequest(options: {
  readonly route: DirectProviderRouteV1
  readonly input: RequestInfo | URL
  readonly init?: RequestInit
}): Promise<PreparedDirectProviderTransportV1> {
  const route = options.route
  const identifier = (value: unknown) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
  if (!identifier(route.providerID) || !identifier(route.modelID) || !identifier(route.harnessID) ||
    !/^llm_[a-f0-9]{64}$/.test(route.routeID) || !identifier(route.routeRevision) ||
    !/^blake3:[a-f0-9]{64}$/.test(route.endpointRevision)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider route identity is invalid")
  }
  const credentialedFreeRoute = route.explicitFreeCredential === true &&
    route.providerID === "openrouter" && route.modelID === "nvidia/nemotron-3.5-super-vl:free" &&
    !route.anonymousOpenCodeFree
  if (!credentialedFreeRoute && (!route.anonymousOpenCodeFree || route.providerID !== "opencode")) {
    throw new SecretBrokerError("UNAVAILABLE", "Direct provider transport is not enabled for this selected route")
  }
  // The credentialed lane is one exact OpenRouter free offer. The SDK only
  // sees this synthetic placeholder; actual bytes enter at the send boundary.
  if (route.credentialHeader?.name !== "authorization" || route.credentialHeader.prefix !== "Bearer ") {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider credential header is invalid")
  }
  let request: Request
  let endpoint: URL
  let destination: URL
  try {
    request = new Request(options.input, options.init)
    endpoint = new URL(route.endpointBase)
    destination = new URL(request.url)
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider request or endpoint is malformed")
  }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]"
  const credentialedDestinationAllowed = credentialedFreeRoute && endpoint.protocol === "https:" &&
    endpoint.hostname === "openrouter.ai" && endpoint.port === "" && endpoint.pathname === "/api/v1" &&
    destination.protocol === "https:" && destination.hostname === "openrouter.ai" && destination.port === "" &&
    destination.pathname === "/api/v1/chat/completions" && destination.search === "" && destination.hash === ""
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    destination.origin !== endpoint.origin || destination.username || destination.password || destination.hash ||
    (destination.pathname !== endpoint.pathname && !destination.pathname.startsWith(endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`)) ||
    destination.toString() !== request.url || (request.method !== "GET" && request.method !== "POST") ||
    (request.method === "GET" && request.body !== null) ||
    (credentialedFreeRoute && (!credentialedDestinationAllowed || request.method !== "POST" || destination.search !== ""))) {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider request escaped its fixed selected endpoint")
  }
  let body = ""
  if (request.body !== null) {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
    if (!contentType.includes("json")) throw new SecretBrokerError("UNAVAILABLE", "Direct provider request body is not bounded JSON")
    body = await readBoundedRequestBody(request)
  }
  if (credentialedFreeRoute) {
    let bodyModel: unknown
    try {
      const parsed: unknown = JSON.parse(body)
      bodyModel = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).model
        : undefined
    } catch {
      throw new SecretBrokerError("INVALID_REQUEST", "OpenRouter free request body is malformed")
    }
    if (bodyModel !== route.modelID) throw new SecretBrokerError("INVALID_REQUEST", "OpenRouter request body differs from its fixed free model")
  }
  const credentialName = route.credentialHeader.name.toLowerCase()
  const forbidden = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|x-azure-api-key|x-subscription-token|api-key|x-auth-token|x-access-token|cookie|set-cookie)$/
  const headers: Record<string, string> = {}
  for (const [rawName, value] of request.headers.entries()) {
    const name = rawName.toLowerCase()
    if (forbidden.test(name) && name !== credentialName) throw new SecretBrokerError("INVALID_REQUEST", "Direct provider request contains an unselected credential header")
    if (name === credentialName) {
      const expectedCredential = credentialedFreeRoute
        ? `${route.credentialHeader.prefix}${DIRECT_PROVIDER_CREDENTIAL_PLACEHOLDER}`
        : `${route.credentialHeader.prefix}${DIRECT_PUBLIC_TOKEN}`
      if (value !== expectedCredential) {
        throw new SecretBrokerError("UNAVAILABLE", "Direct provider SDK did not use its isolated credential placeholder")
      }
      if (credentialedFreeRoute) continue
    }
    if (/[\r\n\u0000]/.test(value)) throw new SecretBrokerError("INVALID_REQUEST", "Direct provider header is malformed")
    headers[name] = value
  }
  // Anonymous OpenCode uses its public sentinel. The credentialed route must
  // arrive with the SDK-generated synthetic placeholder and never gets a key
  // synthesized or copied into the prepared transport.
  if (!Object.hasOwn(headers, credentialName)) {
    if (credentialedFreeRoute) {
      if (!request.headers.has(credentialName)) throw new SecretBrokerError("INVALID_REQUEST", "OpenRouter SDK omitted its credential placeholder")
    } else {
      headers[credentialName] = `${route.credentialHeader.prefix}${DIRECT_PUBLIC_TOKEN}`
    }
  }
  if (Object.keys(headers).length > 64) {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider request exceeded its header bound")
  }
  if (Buffer.byteLength(destination.toString(), "utf8") > 8 * 1024 ||
    Object.entries(headers).reduce((bytes, [name, value]) => bytes + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8"), 0) > 32 * 1024) {
    throw new SecretBrokerError("INVALID_REQUEST", "Direct provider URL or headers exceed their byte bounds")
  }
  if (Buffer.byteLength(body, "utf8") > MAX_PROVIDER_BODY_BYTES) throw new SecretBrokerError("INVALID_REQUEST", "Direct provider request body exceeds its bound")
  const transport: ProviderTransportInput = Object.freeze({
    providerId: route.providerID,
    method: request.method,
    destination: destination.toString(),
    body,
    headers: Object.freeze(headers),
    credentialHeader: Object.freeze({ ...route.credentialHeader }),
  })
  const digestMaterial = JSON.stringify([
    "horizoncode.direct-provider-transport.v1", route.providerID, route.modelID, route.harnessID,
    route.routeID, route.routeRevision, route.endpointRevision, transport.method, transport.destination,
    transport.credentialHeader.name, transport.credentialHeader.prefix,
    Object.entries(transport.headers).map(([name, value]) => [name, name === credentialName ? "<public-placeholder>" : value]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0),
    transport.body,
  ])
  return Object.freeze({
    route: Object.freeze({ ...route, credentialHeader: Object.freeze({ ...route.credentialHeader }) }),
    transport,
    transportRequestDigest: `blake3:${bytesToHex(blake3(new TextEncoder().encode(digestMaterial)))}`,
  })
}

/** A request-local SDK fetch adapter. It sends only the prepared request once; any post-begin ambiguity is UNKNOWN. */
export function createPinnedDirectProviderFetch(options: {
  readonly prepared: PreparedDirectProviderTransportV1
  readonly expectedPinDigest: string
  readonly expectedTransportDigest: string
  readonly journalState: "PINNED"
  readonly beginDispatch: () => Promise<{ readonly state: "DISPATCHING"; readonly pinDigest: string; readonly transportRequestDigest: string }>
  readonly markUnknown: (reason: string) => Promise<void>
  readonly send: (request: ProviderTransportRequest) => Promise<Response>
  readonly signal?: AbortSignal
}): typeof fetch {
  let used = false
  return (async (input, init) => {
    if (used) throw new SecretBrokerError("CONFLICT", "Direct provider request permits exactly one SDK dispatch")
    used = true
    const replay = await prepareDirectProviderTransportRequest({ route: options.prepared.route, input, init })
    if (options.journalState !== "PINNED" || replay.transportRequestDigest !== options.expectedTransportDigest ||
      replay.transportRequestDigest !== options.prepared.transportRequestDigest) {
      throw new SecretBrokerError("CONFLICT", "SDK request differs from the immutable direct provider pin")
    }
    // Finish local Request validation before the durable DISPATCHING transition;
    // after that point any transport uncertainty must be terminal UNKNOWN.
    const request = new Request(input, init)
    const signal = options.signal && options.signal !== request.signal
      ? AbortSignal.any([options.signal, request.signal])
      : request.signal
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Direct provider request was cancelled before dispatch", "AbortError")
    }
    let dispatch: Awaited<ReturnType<typeof options.beginDispatch>>
    try {
      dispatch = await options.beginDispatch()
      if (dispatch.state !== "DISPATCHING" || dispatch.pinDigest !== options.expectedPinDigest || dispatch.transportRequestDigest !== options.expectedTransportDigest) {
        throw new SecretBrokerError("CONFLICT", "SessionStore did not confirm this exact direct dispatch")
      }
    } catch (error) {
      // The transition may have committed even if its acknowledgement was lost.
      await options.markUnknown("direct provider dispatch authorization acknowledgement was lost or mismatched").catch(() => undefined)
      throw error
    }
    if (signal.aborted) {
      await options.markUnknown("direct provider request was cancelled after DISPATCHING but before transport send")
      throw signal.reason ?? new DOMException("Direct provider request was cancelled before transport send", "AbortError")
    }
    try {
      const response = await options.send({
        url: replay.transport.destination,
        method: replay.transport.method,
        body: replay.transport.body,
        headers: replay.transport.headers,
        signal,
        maxResponseBytes: MAX_DIRECT_PROVIDER_RESPONSE_BYTES,
      })
      // A non-success response is not a canonical assistant/usage settlement.
      // Preserve the exact response for the caller's typed provider error, but
      // make the request terminal so it cannot remain DISPATCHING or be replayed.
      if (response.status >= 400) {
        await options.markUnknown(`provider returned HTTP ${response.status} without a canonical response settlement`)
      }
      if (!response.body) {
        await options.markUnknown("provider response has no bounded stream after dispatch")
        return response
      }
      const reader = response.body.getReader()
      let bytes = 0
      const bounded = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              controller.close()
              reader.releaseLock()
              return
            }
            bytes += chunk.value.byteLength
            if (bytes > MAX_DIRECT_PROVIDER_RESPONSE_BYTES) {
              await reader.cancel().catch(() => undefined)
              controller.error(new SecretBrokerError("INVALID_REQUEST", "Direct provider response exceeds its byte bound"))
              await options.markUnknown("direct provider response exceeded the bounded response size after dispatch").catch(() => undefined)
              return
            }
            controller.enqueue(chunk.value)
          } catch (error) {
            controller.error(error)
            await options.markUnknown("direct provider response stream failed after dispatch").catch(() => undefined)
          }
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => undefined)
          await options.markUnknown("provider response stream was cancelled after dispatch").catch(() => undefined)
        },
      })
      return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      await options.markUnknown("provider transport failed after durable DISPATCHING; delivery may have occurred")
      throw error
    }
  }) as typeof fetch
}

export type AuthorizedSearchProviderResponseV1 = {
  status: number
  retryAfterMs: number | null
  body: Uint8Array
  bodyDigest: string
  bodyBytes: number
  complete: true
}

export type SearchDispatchPermitV1 = {
  schemaVersion: 1
  attemptRef: string
  attemptDigest: string
  state: "DISPATCHING"
  dispatchAllowed: true
}

/** HostKernel facts returned only by the fresh managed_provider.begin transition. */
export type ManagedProviderSecretUseContextV1 = {
  requesterRef: string
  runRef: string
  profileRef: string
  purpose: "PROVIDER_REQUEST"
  expiresAtUnixMs: number
}

export type ManagedProviderSendPermitV1 = {
  providerRequestID: string
  prepareDigest: string
  dispatchDigest: string
  /** Opaque HostKernel one-use token; consumed only by the in-process Auth callback. */
  sendAuthorization: string
  attemptID: string
  ownerEpoch: string
  requestID: string
  requestSequence: string
  contextSelectionDigest: string
  providerID: string
  modelID: string
  harnessID: string
  credentialLeaseRef: string | null
  guardChallengeID: string
  effectID: string
  capabilityLeaseDigest: string
  authorizationBindingDigest: string
  requestDigest: string
  transportRequestDigest: string
  operationDigest: string
  routeID: string
  endpointRevision: string
  secretUseContext: ManagedProviderSecretUseContextV1
}

export type ManagedProviderSendPinsV1 = Pick<ManagedProviderSendPermitV1,
  | "providerRequestID" | "prepareDigest" | "dispatchDigest" | "attemptID" | "ownerEpoch" | "requestID" | "requestSequence"
  | "contextSelectionDigest" | "providerID" | "modelID" | "harnessID" | "routeID"
  | "credentialLeaseRef" | "guardChallengeID" | "effectID" | "capabilityLeaseDigest" | "authorizationBindingDigest"
  | "endpointRevision" | "requestDigest" | "transportRequestDigest" | "operationDigest"
>

/** Opaque handle that cannot be forged from an HTTP/RPC object or replayed. */
export type ManagedProviderAuthorizationHandleV1 = object

const managedAuthorizationData = new WeakMap<object, ManagedProviderSendPermitV1>()

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecretBrokerError("INVALID_REQUEST", `Managed provider ${label} is malformed`)
  }
  return value as Record<string, unknown>
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider authorization has an invalid shape")
  }
}

/**
 * Validate the fresh HostKernel begin response against all locally frozen
 * request pins. A replay or unavailable response is intentionally not accepted.
 */
export function retainManagedProviderSendAuthorization(
  raw: unknown,
  expected: ManagedProviderSendPinsV1,
): ManagedProviderAuthorizationHandleV1 {
  const permit = exactRecord(raw, "send authorization")
  exactRecordKeys(permit, [
    "providerRequestID", "prepareDigest", "dispatchDigest", "sendAuthorization",
    "attemptID", "ownerEpoch", "requestID", "requestSequence", "contextSelectionDigest",
    "providerID", "modelID", "harnessID", "credentialLeaseRef", "guardChallengeID",
    "effectID", "capabilityLeaseDigest", "authorizationBindingDigest", "requestDigest", "transportRequestDigest", "operationDigest",
    "routeID", "endpointRevision", "secretUseContext",
  ])
  const identifier = (value: unknown) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
  const digest = (value: unknown) => typeof value === "string" && /^blake3:[a-f0-9]{64}$/.test(value)
  const revision = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
  for (const key of ["providerRequestID", "sendAuthorization", "attemptID", "requestID", "providerID", "modelID", "harnessID", "guardChallengeID", "effectID", "routeID"]) {
    if (!identifier(permit[key])) throw new SecretBrokerError("INVALID_REQUEST", `Managed provider ${key} is invalid`)
  }
  if (permit.credentialLeaseRef !== null && !identifier(permit.credentialLeaseRef)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider credential reference is invalid")
  }
  for (const key of ["prepareDigest", "dispatchDigest", "contextSelectionDigest", "capabilityLeaseDigest", "authorizationBindingDigest", "requestDigest", "transportRequestDigest", "endpointRevision"]) {
    if (!digest(permit[key])) throw new SecretBrokerError("INVALID_REQUEST", `Managed provider ${key} is invalid`)
  }
  if (!revision(permit.ownerEpoch) || !revision(permit.requestSequence) ||
    !/^(?:sha256|blake3):[a-f0-9]{64}$/.test(String(permit.operationDigest))) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider revision or operation digest is invalid")
  }
  for (const key of Object.keys(expected) as (keyof ManagedProviderSendPinsV1)[]) {
    if (permit[key] !== expected[key]) {
      throw new SecretBrokerError("CONFLICT", `Managed provider authorization changed ${key}`)
    }
  }
  const secretUseContext = exactRecord(permit.secretUseContext, "SecretBroker context")
  exactRecordKeys(secretUseContext, ["requesterRef", "runRef", "profileRef", "purpose", "expiresAtUnixMs"])
  const expiresAtUnixMs = secretUseContext.expiresAtUnixMs
  if (!identifier(secretUseContext.requesterRef) || !identifier(secretUseContext.runRef) ||
    !identifier(secretUseContext.profileRef) || secretUseContext.purpose !== "PROVIDER_REQUEST" ||
    typeof expiresAtUnixMs !== "number" || !Number.isSafeInteger(expiresAtUnixMs) ||
    expiresAtUnixMs <= Date.now() || expiresAtUnixMs > Date.now() + 15_000) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider SecretBroker context is invalid")
  }
  const handle = Object.freeze(Object.create(null)) as object
  managedAuthorizationData.set(handle, Object.freeze({
    ...permit,
    secretUseContext: Object.freeze({ ...secretUseContext }),
  }) as unknown as ManagedProviderSendPermitV1)
  return handle
}

/** Remove before callback invocation, so throw/cancel still consumes the handle. */
export async function consumeManagedProviderSendAuthorization<Value>(
  handle: ManagedProviderAuthorizationHandleV1,
  expected: ManagedProviderSendPinsV1,
  use: (authorization: ManagedProviderSendPermitV1) => Promise<Value>,
): Promise<Value> {
  if (typeof handle !== "object" || handle === null) throw new SecretBrokerError("INVALID_REQUEST", "Managed provider authorization is unavailable")
  const authorization = managedAuthorizationData.get(handle)
  if (!authorization) throw new SecretBrokerError("CONFLICT", "Managed provider authorization was already consumed or is foreign")
  managedAuthorizationData.delete(handle)
  for (const key of Object.keys(expected) as (keyof ManagedProviderSendPinsV1)[]) {
    if (authorization[key] !== expected[key]) throw new SecretBrokerError("CONFLICT", `Managed provider authorization changed ${key}`)
  }
  return use(authorization)
}

/**
 * Consume the fresh Auth-only handle only after the SDK's concrete request has
 * been reconstructed and matched to every route/transport/credential pin.
 * The callback is the sole place allowed to hand this capability to the
 * existing SecretBroker + Guarded ExecutionHost transport adapter.
 */
export async function consumeManagedProviderTransportAuthorization<Value>(options: {
  handle: ManagedProviderAuthorizationHandleV1
  expected: ManagedProviderSendPinsV1
  route: ManagedProviderRouteV1
  transport: ProviderTransportInput
  use: (authorization: ManagedProviderSendPermitV1) => Promise<Value>
}): Promise<Value> {
  return consumeManagedProviderSendAuthorization(options.handle, options.expected, async (authorization) => {
    const route = options.route
    const transport = options.transport
    if (authorization.providerID !== route.providerID || authorization.modelID !== route.modelID ||
      authorization.harnessID !== route.harnessID || authorization.routeID !== route.routeID ||
      authorization.endpointRevision !== route.endpointRevision ||
      authorization.credentialLeaseRef !== route.credentialLeaseRef ||
      transport.providerId !== route.providerID ||
      managedProviderTransportDigest(route, transport) !== authorization.transportRequestDigest ||
      providerRequestDigest(transport) !== authorization.operationDigest) {
      throw new SecretBrokerError("CONFLICT", "Managed provider transport differs from its one-use HostKernel authorization")
    }
    return options.use(authorization)
  })
}

/**
 * Consume a fresh managed HostKernel authorization immediately before using
 * the existing SecretBroker-backed provider transport. `send` is supplied by
 * the existing Provider owner; this helper never chooses an endpoint or
 * network fallback. A consume error prevents SecretBroker use and dispatch.
 */
export async function dispatchAuthorizedManagedProviderRequest(options: {
  broker: Pick<ReturnType<typeof import("./secret-broker").createSecretBroker>, "authorizeUse" | "withUse">
  handle: ManagedProviderAuthorizationHandleV1
  expected: ManagedProviderSendPinsV1
  route: ManagedProviderRouteV1
  prepared: PreparedManagedProviderTransportV1
  signal?: AbortSignal
  consumeAuthorization: (authorization: ManagedProviderSendPermitV1) => Promise<void>
  markUnknown: (authorization: ManagedProviderSendPermitV1, reason: string) => Promise<void>
  send: (request: ProviderTransportRequest) => Promise<{
    status: number
    headers: HeadersInit
    body: AsyncIterable<Uint8Array>
  }>
  now?: () => number
}): Promise<Response> {
  const now = options.now ?? Date.now
  const anonymous = options.route.credentialLeaseRef === null
  // The anonymous lane is intentionally narrower than the credentialed
  // SecretBroker lane: only the exact catalog-backed OpenCode free offer may
  // reach it, and it still consumes the same fresh HostKernel authorization.
  if (anonymous && options.route.providerID !== "opencode") {
    throw new SecretBrokerError("UNAVAILABLE", "Anonymous managed transport is limited to the selected OpenCode free offer")
  }
  const prepared = options.prepared
  if (prepared.routeID !== options.route.routeID || prepared.endpointRevision !== options.route.endpointRevision ||
    prepared.operationDigest !== options.expected.operationDigest ||
    prepared.transportRequestDigest !== options.expected.transportRequestDigest) {
    throw new SecretBrokerError("CONFLICT", "Prepared managed provider transport differs from its HostKernel pins")
  }

  let responseMetadata: { status: number; headers: HeadersInit } | undefined
  let consumedAuthorization: ManagedProviderSendPermitV1 | undefined
  let body: AsyncIterable<Uint8Array>
  try {
    body = await consumeManagedProviderTransportAuthorization({
    handle: options.handle,
    expected: options.expected,
    route: options.route,
    transport: prepared.transport as ProviderTransportInput,
    use: async (authorization) => {
      consumedAuthorization = authorization
      await options.consumeAuthorization(authorization)
      const useContext = authorization.secretUseContext
      if (anonymous) {
        const input = prepared.transport as ProviderTransportInput
        const credentialName = input.credentialHeader.name.toLowerCase()
        const forbidden = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|x-azure-api-key|x-subscription-token|api-key|x-auth-token|x-access-token|cookie|set-cookie)$/
        if (Object.keys(input.headers).some((name) => name.toLowerCase() === credentialName || forbidden.test(name.toLowerCase()))) {
          throw new SecretBrokerError("INVALID_REQUEST", "Anonymous provider request contains a credential header")
        }
        const destination = new URL(input.destination)
        const loopback = destination.hostname === "localhost" || destination.hostname === "127.0.0.1" || destination.hostname === "[::1]"
        if ((destination.protocol !== "https:" && !(destination.protocol === "http:" && loopback)) ||
          destination.username || destination.password || destination.hash || destination.toString() !== input.destination ||
          [...destination.searchParams.keys()].some((name) => /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth|credential|secret|^(?:key|token)$)/i.test(name))) {
          throw new SecretBrokerError("INVALID_REQUEST", "Anonymous provider request is outside its fixed route profile")
        }
        if (!Number.isSafeInteger(useContext.expiresAtUnixMs) || useContext.expiresAtUnixMs <= now() ||
          useContext.expiresAtUnixMs > now() + 15_000) {
          throw new SecretBrokerError("EXPIRED", "Anonymous provider authorization is expired or exceeds its bound")
        }
        const controller = new AbortController()
        const abortFromCaller = () => controller.abort(options.signal?.reason)
        options.signal?.addEventListener("abort", abortFromCaller, { once: true })
        let timeout: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          if (timeout !== undefined) clearTimeout(timeout)
          options.signal?.removeEventListener("abort", abortFromCaller)
        }
        const remaining = useContext.expiresAtUnixMs - now()
        if (remaining <= 0 || controller.signal.aborted) {
          cleanup()
          throw new SecretBrokerError("EXPIRED", "Anonymous provider authorization expired before dispatch")
        }
        timeout = setTimeout(() => controller.abort(), remaining)
        const aborted = Symbol("managed-provider-aborted")
        const abortPromise = new Promise<typeof aborted>((resolve) => {
          if (controller.signal.aborted) resolve(aborted)
          else controller.signal.addEventListener("abort", () => resolve(aborted), { once: true })
        })
        try {
          const response = await Promise.race([
            options.send({
              url: input.destination,
              method: input.method,
              body: input.body,
              headers: { ...input.headers },
              signal: controller.signal,
              maxResponseBytes: 10 * 1024 * 1024,
            }),
            abortPromise,
          ])
          if (response === aborted) throw new SecretBrokerError("EXPIRED", "Anonymous provider request was cancelled or exceeded its deadline")
          if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || [204, 205, 304].includes(response.status)) {
            throw new SecretBrokerError("UNAVAILABLE", "Managed provider returned an unsupported response status")
          }
          responseMetadata = { status: response.status, headers: safeProviderResponseHeaders(response.headers) }
          return (async function* () {
            const iterator = response.body[Symbol.asyncIterator]()
            let consumed = 0
            try {
              while (true) {
                const next = await Promise.race([Promise.resolve(iterator.next()), abortPromise])
                if (next === aborted) throw new SecretBrokerError("EXPIRED", "Anonymous provider response was cancelled or exceeded its deadline")
                if (next.done) return
                if (!(next.value instanceof Uint8Array) || consumed + next.value.byteLength > 10 * 1024 * 1024) {
                  controller.abort()
                  throw new SecretBrokerError("UNAVAILABLE", "Managed provider response exceeded its size limit")
                }
                consumed += next.value.byteLength
                yield next.value
              }
            } finally {
              cleanup()
              if (!controller.signal.aborted) controller.abort()
              await iterator.return?.()
            }
          })()
        } catch (error) {
          cleanup()
          controller.abort()
          throw error
        }
      }
      const maxExpiresAt = new Date(useContext.expiresAtUnixMs).toISOString()
      const trusted: TrustedSecretUseContext = {
        requesterRef: useContext.requesterRef,
        providerId: options.route.providerID,
        operationDigest: prepared.operationDigest,
        destination: prepared.transport.destination,
        purpose: "PROVIDER_REQUEST",
        maxExpiresAt,
        runRef: useContext.runRef,
        profileRef: useContext.profileRef,
      }
      const useRequest: SecretBrokerV1.UseRequestV1 = {
        schemaVersion: 1,
        secretRef: options.route.credentialLeaseRef as SecretBrokerV1.SecretRef,
        providerId: options.route.providerID,
        operationDigest: prepared.operationDigest,
        destination: prepared.transport.destination,
        purpose: "PROVIDER_REQUEST",
        expiresAt: maxExpiresAt,
        maxRequests: 1,
        runRef: useContext.runRef,
        profileRef: useContext.profileRef,
      }
      const lease = await options.broker.authorizeUse(useRequest, trusted)
      return dispatchProviderRequest({
        broker: options.broker,
        lease,
        trusted,
        input: prepared.transport as ProviderTransportInput,
        send: async (request) => {
          const response = await options.send(request)
          if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || [204, 205, 304].includes(response.status)) {
            throw new SecretBrokerError("UNAVAILABLE", "Managed provider returned an unsupported response status")
          }
          responseMetadata = {
            status: response.status,
            headers: safeProviderResponseHeaders(response.headers),
          }
          return response.body
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        deadlineAt: useContext.expiresAtUnixMs,
        maxResponseBytes: 10 * 1024 * 1024,
        now,
      })
    },
    })
  } catch (error) {
    if (consumedAuthorization) {
      await options.markUnknown(consumedAuthorization, "provider_dispatch_or_response_unavailable").catch(() => undefined)
    }
    throw error
  }

  if (!responseMetadata) throw new SecretBrokerError("UNAVAILABLE", "Managed provider response metadata is unavailable")
  const iterator = body[Symbol.asyncIterator]()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next()
        if (item.done) controller.close()
        else controller.enqueue(item.value)
      } catch (error) {
        if (consumedAuthorization) {
          await options.markUnknown(consumedAuthorization, "provider_response_stream_failed").catch(() => undefined)
        }
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
      if (consumedAuthorization) {
        await options.markUnknown(consumedAuthorization, "provider_response_stream_cancelled").catch(() => undefined)
      }
    },
  })
  return new Response(stream, responseMetadata)
}

function safeProviderResponseHeaders(input: HeadersInit): Headers {
  const source = new Headers(input)
  const output = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const value = source.get(name)
    if (value && value.length <= 2048 && !/[\r\n\u0000]/.test(value)) output.set(name, value)
  }
  return output
}

export type ManagedProviderRouteV1 = {
  providerID: string
  modelID: string
  harnessID: string
  routeID: string
  endpointRevision: string
  credentialLeaseRef: string | null
}

const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024

export type PreparedManagedProviderTransportV1 = {
  readonly routeID: string
  readonly endpointRevision: string
  readonly transport: Readonly<ProviderTransportInput>
  readonly transportRequestDigest: string
  readonly operationDigest: SecretBrokerV1.SecretOperationDigest
}

/** Synthetic only: SDK adapters must be constructed with this value, never an ambient credential. */
export const MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER = "horizoncode-managed-credential-placeholder-v1"

/** Exact SDK bytes, with credential values excluded and the credential profile pinned. */
export function managedProviderTransportDigest(route: ManagedProviderRouteV1, transport: ProviderTransportInput): string {
  const canonical = JSON.stringify([
    "horizoncode.managed-provider-transport.v1",
    route.providerID, route.modelID, route.harnessID, route.routeID, route.endpointRevision,
    transport.method, transport.destination, transport.credentialHeader.name, transport.credentialHeader.prefix,
    Object.entries(transport.headers).map(([name, value]) => [name.toLowerCase(), value])
      .sort(([left], [right]) => left! < right! ? -1 : left! > right! ? 1 : 0),
    transport.body,
  ])
  return `blake3:${bytesToHex(blake3(new TextEncoder().encode(canonical)))}`
}

async function readBoundedRequestBody(request: Request): Promise<string> {
  if (!request.body) return ""
  // Keep the original request available for the exact one-shot fetch replay.
  const reader = request.clone().body!.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request exceeds its body bound")
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    JSON.parse(body)
    return body
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider body is not valid UTF-8 JSON")
  }
}

export function decodeSearchDispatchPermit(value: unknown, authorization: SearchSecretAuthorizationV1): SearchDispatchPermitV1 {
  const permit = record(value, "dispatch permit")
  exactKeys(permit, ["schemaVersion", "attemptRef", "attemptDigest", "state", "dispatchAllowed"])
  if (permit.schemaVersion !== 1 || permit.attemptRef !== authorization.attemptRef ||
    permit.attemptDigest !== authorization.attemptDigest || permit.state !== "DISPATCHING" ||
    permit.dispatchAllowed !== true) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel did not authorize this exact provider dispatch")
  }
  return permit as SearchDispatchPermitV1
}

const canonicalHeaders = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n")

const SEARCH_PROFILES = {
  brave: { providerId: "brave", routeId: "web.search.brave", method: "GET", host: "api.search.brave.com", path: "/res/v1/web/search", credentialHeader: "x-subscription-token", prefix: "" },
  exa: { providerId: "exa", routeId: "web.search.exa", method: "POST", host: "api.exa.ai", path: "/search", credentialHeader: "x-api-key", prefix: "" },
  youcom: { providerId: "youcom", routeId: "web.search.youcom", method: "POST", host: "ydc-index.io", path: "/v1/search", credentialHeader: "x-api-key", prefix: "" },
  tavily: { providerId: "tavily", routeId: "web.search.tavily", method: "POST", host: "api.tavily.com", path: "/search", credentialHeader: "authorization", prefix: "Bearer " },
  firecrawl: { providerId: "firecrawl", routeId: "web.search.firecrawl", method: "POST", host: "api.firecrawl.dev", path: "/v2/search", credentialHeader: "authorization", prefix: "Bearer " },
  parallel: { providerId: "parallel", routeId: "web.search.parallel", method: "POST", host: "api.parallel.ai", path: "/v1/search", credentialHeader: "x-api-key", prefix: "" },
} as const

export type SearchSecretAuthorizationV1 = {
  attemptRef: string
  attemptDigest: string
  routeKey: keyof typeof SEARCH_PROFILES
  attempt: 1 | 2
  providerRequest: {
    providerId: string
    routeId: string
    method: "GET" | "POST"
    destination: string
    body: string
    headers: readonly { name: string; value: string }[]
    credentialHeaderName: string
    credentialHeaderPrefix: string
    operationDigest: string
  }
  request: {
    schemaVersion: 1
    secretRef: SecretBrokerV1.SecretRef
    providerId: string
    operationDigest: string
    destination: string
    purpose: "PROVIDER_REQUEST"
    expiresAtUnixMs: number
    maxRequests: 1
    runRef?: string
    profileRef?: string
  }
  trusted: {
    requesterRef: string
    providerId: string
    operationDigest: string
    destination: string
    purpose: "PROVIDER_REQUEST"
    maxExpiresAtUnixMs: number
    runRef?: string
    profileRef?: string
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecretBrokerError("INVALID_REQUEST", `HostKernel search ${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search authorization has an invalid shape")
  }
}

/** Decode P1's RPC projection as untrusted data before it reaches SecretBroker. */
export function decodeSearchSecretAuthorization(value: unknown, now = Date.now()): SearchSecretAuthorizationV1 {
  const root = record(value, "authorization")
  exactKeys(root, ["attemptRef", "attemptDigest", "routeKey", "attempt", "providerRequest", "request", "trusted"])
  if (typeof root.attemptRef !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,256}$/.test(root.attemptRef) ||
    typeof root.attemptDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(root.attemptDigest)) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search attempt identity is invalid")
  }
  if (typeof root.routeKey !== "string" || !Object.hasOwn(SEARCH_PROFILES, root.routeKey) ||
    (root.attempt !== 1 && root.attempt !== 2)) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search authorization route is invalid")
  }
  const rawProvider = record(root.providerRequest, "provider request")
  exactKeys(rawProvider, ["providerId", "routeId", "method", "destination", "body", "headers", "credentialHeaderName", "credentialHeaderPrefix", "operationDigest"])
  if (typeof rawProvider.providerId !== "string" || typeof rawProvider.routeId !== "string" ||
    (rawProvider.method !== "GET" && rawProvider.method !== "POST") || typeof rawProvider.destination !== "string" ||
    typeof rawProvider.body !== "string" || !Array.isArray(rawProvider.headers) || rawProvider.headers.length > 1 ||
    typeof rawProvider.credentialHeaderName !== "string" || typeof rawProvider.credentialHeaderPrefix !== "string" ||
    typeof rawProvider.operationDigest !== "string") {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search provider request is invalid")
  }
  const headers = rawProvider.headers.map((item) => {
    const header = record(item, "provider header")
    exactKeys(header, ["name", "value"])
    if (typeof header.name !== "string" || typeof header.value !== "string" || header.name.length > 128 ||
      header.value.length > 8192 || /[\r\n\u0000]/.test(header.name + header.value)) {
      throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search provider header is invalid")
    }
    return { name: header.name, value: header.value }
  })
  const rawRequest = record(root.request, "SecretBroker request")
  exactKeys(rawRequest, ["schemaVersion", "secretRef", "providerId", "operationDigest", "destination", "purpose", "expiresAtUnixMs", "maxRequests"], ["runRef", "profileRef"])
  const rawTrusted = record(root.trusted, "trusted context")
  exactKeys(rawTrusted, ["requesterRef", "providerId", "operationDigest", "destination", "purpose", "maxExpiresAtUnixMs"], ["runRef", "profileRef"])
  const identifier = (value: unknown) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
  const digest = (value: unknown) => typeof value === "string" && /^(?:sha256|blake3):[0-9a-f]{64}$/.test(value)
  if (rawRequest.schemaVersion !== 1 || rawRequest.purpose !== "PROVIDER_REQUEST" || rawRequest.maxRequests !== 1 ||
    !identifier(rawRequest.secretRef) || !identifier(rawRequest.providerId) || !digest(rawRequest.operationDigest) ||
    !identifier(rawRequest.destination) || !Number.isSafeInteger(rawRequest.expiresAtUnixMs) ||
    (rawRequest.runRef !== undefined && !identifier(rawRequest.runRef)) ||
    (rawRequest.profileRef !== undefined && !identifier(rawRequest.profileRef)) ||
    typeof rawTrusted.requesterRef !== "string" || !/^principal_[a-f0-9]{64}$/.test(rawTrusted.requesterRef) ||
    !identifier(rawTrusted.providerId) || !digest(rawTrusted.operationDigest) || !identifier(rawTrusted.destination) ||
    rawTrusted.purpose !== "PROVIDER_REQUEST" || !Number.isSafeInteger(rawTrusted.maxExpiresAtUnixMs) ||
    (rawTrusted.runRef !== undefined && !identifier(rawTrusted.runRef)) ||
    (rawTrusted.profileRef !== undefined && !identifier(rawTrusted.profileRef))) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search authorization metadata is invalid")
  }
  const authorization = {
    attemptRef: root.attemptRef,
    attemptDigest: root.attemptDigest,
    routeKey: root.routeKey as SearchSecretAuthorizationV1["routeKey"],
    attempt: root.attempt,
    // Every field below was validated by exactKeys and the guard chain above;
    // assemble the typed projection explicitly instead of casting a spread of
    // unknown-typed records.
    providerRequest: {
      providerId: rawProvider.providerId,
      routeId: rawProvider.routeId,
      method: rawProvider.method,
      destination: rawProvider.destination,
      body: rawProvider.body,
      headers,
      credentialHeaderName: rawProvider.credentialHeaderName,
      credentialHeaderPrefix: rawProvider.credentialHeaderPrefix,
      operationDigest: rawProvider.operationDigest,
    },
    request: rawRequest as SearchSecretAuthorizationV1["request"],
    trusted: rawTrusted as SearchSecretAuthorizationV1["trusted"],
  } as SearchSecretAuthorizationV1
  const expiresAt = authorization.request.expiresAtUnixMs
  if (expiresAt <= now || expiresAt > now + 15_000 ||
    expiresAt !== authorization.trusted.maxExpiresAtUnixMs ||
    authorization.request.runRef !== authorization.trusted.runRef ||
    authorization.request.profileRef !== authorization.trusted.profileRef) {
    throw new SecretBrokerError("EXPIRED", "HostKernel search authorization is expired or has mismatched scope")
  }
  return authorization
}

function fixedSearchTransportInput(rawAuthorization: unknown, now: () => number): ProviderTransportInput {
  const authorization = decodeSearchSecretAuthorization(rawAuthorization, now())
  const profile = SEARCH_PROFILES[authorization.routeKey]
  const request = authorization.providerRequest
  if (
    !profile || request.providerId !== profile.providerId || request.routeId !== profile.routeId ||
    request.method !== profile.method || request.credentialHeaderName.toLowerCase() !== profile.credentialHeader ||
    request.credentialHeaderPrefix !== profile.prefix || request.headers.length > 1
  ) throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search request differs from its fixed provider profile")
  let destination: URL
  try {
    destination = new URL(request.destination)
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search destination is invalid")
  }
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.hash ||
    destination.hostname !== profile.host || destination.pathname !== profile.path || destination.port !== "") {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search destination differs from its fixed provider profile")
  }
  const headers: Record<string, string> = {}
  for (const header of request.headers) {
    const name = header.name.toLowerCase()
    if (Object.hasOwn(headers, name) || /^(authorization|proxy-authorization|x-api-key|x-subscription-token|api-key|cookie)$/.test(name)) {
      throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search headers contain a credential or duplicate field")
    }
    headers[name] = header.value
  }
  if (profile.method === "GET") {
    const keys = [...destination.searchParams.keys()].toSorted()
    if (keys.join("\0") !== ["count", "q", "safesearch"].toSorted().join("\0") ||
      !destination.searchParams.get("q") || !/^[1-9]$|^10$/.test(destination.searchParams.get("count") ?? "") ||
      destination.searchParams.get("safesearch") !== "moderate" || request.body !== "" || Object.keys(headers).length !== 0) {
      throw new SecretBrokerError("INVALID_REQUEST", "HostKernel Brave request is outside its fixed GET profile")
    }
  } else if (Object.keys(headers).length !== 1 || headers["content-type"] !== "application/json" ||
    new TextEncoder().encode(request.body).byteLength === 0) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search request is outside its fixed JSON POST profile")
  }
  const input: ProviderTransportInput = {
    providerId: profile.providerId,
    method: profile.method,
    destination: request.destination,
    body: request.body,
    headers,
    credentialHeader: { name: profile.credentialHeader, prefix: profile.prefix },
  }
  if (providerRequestDigest(input) !== request.operationDigest ||
    request.operationDigest !== authorization.request.operationDigest ||
    authorization.trusted.operationDigest !== request.operationDigest ||
    authorization.request.providerId !== profile.providerId || authorization.trusted.providerId !== profile.providerId ||
    authorization.request.destination !== request.destination || authorization.trusted.destination !== request.destination ||
    authorization.request.purpose !== "PROVIDER_REQUEST" || authorization.trusted.purpose !== "PROVIDER_REQUEST" ||
    authorization.request.schemaVersion !== 1 || authorization.request.maxRequests !== 1 ||
    !/^principal_[a-f0-9]{64}$/.test(authorization.trusted.requesterRef) ||
    !authorization.trusted.profileRef || !/^profile_[a-f0-9]{64}$/.test(authorization.trusted.profileRef) ||
    authorization.request.profileRef !== authorization.trusted.profileRef ||
    authorization.request.runRef !== authorization.trusted.runRef) {
    throw new SecretBrokerError("INVALID_REQUEST", "HostKernel search authorization projection is invalid")
  }
  const currentTime = now()
  if (!Number.isSafeInteger(authorization.request.expiresAtUnixMs) ||
    authorization.request.expiresAtUnixMs <= currentTime || authorization.request.expiresAtUnixMs > currentTime + 15_000 ||
    authorization.request.expiresAtUnixMs !== authorization.trusted.maxExpiresAtUnixMs) {
    throw new SecretBrokerError("EXPIRED", "HostKernel search authorization has expired or exceeds its bound")
  }
  return input
}

/** Consume HostKernel's metadata-only grant through the existing local broker and fixed transport. */
export async function dispatchAuthorizedSearchRequest(options: {
  broker: Pick<ReturnType<typeof import("./secret-broker").createSecretBroker>, "authorizeUse" | "withUse">
  authorization: unknown
  dispatchPermit: unknown
  signal?: AbortSignal
  now?: () => number
}): Promise<AuthorizedSearchProviderResponseV1> {
  const now = options.now ?? Date.now
  const authorization = decodeSearchSecretAuthorization(options.authorization, now())
  decodeSearchDispatchPermit(options.dispatchPermit, authorization)
  const input = fixedSearchTransportInput(options.authorization, now)
  const request = authorization.request
  const trusted: TrustedSecretUseContext = {
    requesterRef: authorization.trusted.requesterRef as SecretBrokerV1.SecretRef,
    providerId: authorization.trusted.providerId,
    operationDigest: authorization.trusted.operationDigest as SecretBrokerV1.SecretOperationDigest,
    destination: authorization.trusted.destination,
    purpose: authorization.trusted.purpose,
    maxExpiresAt: new Date(authorization.trusted.maxExpiresAtUnixMs).toISOString(),
    ...(authorization.trusted.runRef === undefined ? {} : { runRef: authorization.trusted.runRef }),
    ...(authorization.trusted.profileRef === undefined ? {} : { profileRef: authorization.trusted.profileRef }),
  }
  const useRequest: SecretBrokerV1.UseRequestV1 = {
    schemaVersion: 1,
    secretRef: request.secretRef,
    providerId: request.providerId,
    operationDigest: request.operationDigest as SecretBrokerV1.SecretOperationDigest,
    destination: request.destination,
    purpose: request.purpose,
    expiresAt: new Date(request.expiresAtUnixMs).toISOString(),
    maxRequests: 1,
    ...(request.runRef === undefined ? {} : { runRef: request.runRef }),
    ...(request.profileRef === undefined ? {} : { profileRef: request.profileRef }),
  }
  const lease = await options.broker.authorizeUse(useRequest, trusted)
  let status: number | undefined
  let retryAfterMs: number | null = null
  const stream = await dispatchProviderRequest({
    broker: options.broker,
    lease,
    trusted,
    input,
    send: async (request) => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "GET" ? {} : { body: request.body }),
        signal: request.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      status = response.status
      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now())
      return responseBodyChunks(response)
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    deadlineAt: request.expiresAtUnixMs,
    maxResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
    now,
  })
  const chunks: Uint8Array[] = []
  let bodyBytes = 0
  for await (const chunk of stream) {
    bodyBytes += chunk.byteLength
    if (bodyBytes > MAX_SEARCH_RESPONSE_BYTES) {
      throw new SecretBrokerError("UNAVAILABLE", "Search provider response exceeded its size limit")
    }
    chunks.push(chunk)
  }
  if (status === undefined) throw new SecretBrokerError("UNAVAILABLE", "Search provider response status is unavailable")
  const body = new Uint8Array(bodyBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    status,
    retryAfterMs,
    body,
    bodyDigest: `blake3:${bytesToHex(blake3(body))}`,
    bodyBytes,
    complete: true,
  }
}

/**
 * Prepare the exact SDK fetch request for HostKernel's dual-digest admission.
 * This function sends no bytes and issues no SecretBroker lease. Dispatch must
 * remain unavailable until HostKernel binds both this transport digest and
 * the managed ContextSelection request digest in its one-use permit.
 */
export async function prepareManagedProviderTransportRequest(options: {
  route: ManagedProviderRouteV1
  endpointBase: string
  activeEndpointRevision: string
  credentialHeader: ProviderTransportInput["credentialHeader"]
  credentialPlaceholder: string
  input: RequestInfo | URL
  init?: RequestInit
}): Promise<PreparedManagedProviderTransportV1> {
  const { route } = options
  const identifier = (value: unknown) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
  if (!identifier(route.providerID) || !identifier(route.modelID) || !identifier(route.harnessID) ||
    !/^llm_[a-f0-9]{64}$/.test(route.routeID) || !/^blake3:[a-f0-9]{64}$/.test(route.endpointRevision) ||
    options.activeEndpointRevision !== route.endpointRevision) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider route is not the current canonical selection")
  }
  let request: Request
  let base: URL
  let destination: URL
  try {
    request = new Request(options.input, options.init)
    base = new URL(options.endpointBase)
    destination = new URL(request.url)
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request or active endpoint is invalid")
  }
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]"
  const credentialQuery = [...destination.searchParams.keys()].some((name) =>
    /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth|credential|secret|^(?:key|token)$)/i.test(name),
  )
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username || base.password || base.search || base.hash || destination.origin !== base.origin ||
    destination.username || destination.password || destination.hash || credentialQuery || destination.toString() !== request.url ||
    Buffer.byteLength(destination.toString(), "utf8") > 8 * 1024 ||
    (destination.pathname !== base.pathname && !destination.pathname.startsWith(base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`)) ||
    (request.method !== "POST" && request.method !== "GET") || (request.method === "GET" && request.body !== null)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request differs from its active fixed endpoint")
  }
  // Streaming request bodies cannot be hashed and pinned before admission.
  if (request.body !== null && !request.headers.get("content-type")?.toLowerCase().includes("json")) {
    throw new SecretBrokerError("UNAVAILABLE", "Managed provider body is not a bounded JSON request")
  }
  const requestHeaders = [...request.headers.entries()]
  if (requestHeaders.length > 64) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request exceeds its header count limit")
  }
  let body = ""
  if (request.method !== "GET" && request.body !== null) {
    body = await readBoundedRequestBody(request)
  }
  const headers: Record<string, string> = {}
  let headerBytes = 0
  if (!request.headers.has(options.credentialHeader.name)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Managed provider SDK omitted its pinned credential header")
  }
  const credentialNames = new Set([
    "authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "x-azure-api-key",
    "x-subscription-token", "api-key", "x-auth-token", "x-access-token", "cookie", "set-cookie",
  ])
  for (const [rawName, value] of requestHeaders) {
    const name = rawName.toLowerCase()
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request contains an invalid header name")
    }
    if (name === options.credentialHeader.name.toLowerCase()) {
      const expected = `${options.credentialHeader.prefix}${options.credentialPlaceholder}`
      if (options.credentialPlaceholder !== MANAGED_PROVIDER_CREDENTIAL_PLACEHOLDER || value !== expected) {
        throw new SecretBrokerError("INVALID_REQUEST", "Managed provider SDK did not use the isolated credential placeholder")
      }
      continue
    }
    if (credentialNames.has(name) || /[\r\n\u0000]/.test(value)) {
      throw new SecretBrokerError("INVALID_REQUEST", "Managed provider SDK request contains an unapproved credential header")
    }
    headerBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8")
    if (headerBytes + Buffer.byteLength(options.credentialHeader.prefix, "utf8") + 16 * 1024 > 32 * 1024) {
      throw new SecretBrokerError("INVALID_REQUEST", "Managed provider request exceeds its header size limit")
    }
    headers[name] = value
  }
  const transport: ProviderTransportInput = {
    providerId: route.providerID,
    method: request.method,
    destination: destination.toString(),
    body,
    headers,
    credentialHeader: options.credentialHeader,
  }
  Object.freeze(headers)
  Object.freeze(transport.credentialHeader)
  Object.freeze(transport)
  const operationDigest = providerRequestDigest(transport)
  return Object.freeze({
    routeID: route.routeID,
    endpointRevision: route.endpointRevision,
    transport,
    transportRequestDigest: managedProviderTransportDigest(route, transport),
    operationDigest,
  })
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const seconds = /^\s*(\d{1,5})\s*$/.exec(value)
  if (seconds) return Math.min(60_000, Number(seconds[1]) * 1000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, Math.min(60_000, date - now))
}

async function* responseBodyChunks(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export function providerRequestDigest(
  input: Pick<ProviderTransportInput, "providerId" | "method" | "destination" | "body" | "headers" | "credentialHeader">,
) {
  return `sha256:${createHash("sha256")
    .update(
      `provider-request-v1\n${input.providerId}\n${input.method}\n${input.destination}\n${input.credentialHeader.name}\n${input.credentialHeader.prefix}\n${canonicalHeaders(input.headers)}\n${input.body}`,
      "utf8",
    )
    .digest("hex")}` as SecretBrokerV1.SecretOperationDigest
}

/**
 * Low-level adapter used by the authorized search entrypoint above. Its
 * injected transport exists for isolated adapter fixtures; production callers
 * reach it only after matching HostKernel's one-use DISPATCHING permit.
 * Credential bytes and auth headers never leave this function.
 */
export async function dispatchProviderRequest<Value>(options: {
  broker: Pick<ReturnType<typeof import("./secret-broker").createSecretBroker>, "withUse">
  lease: SecretBrokerV1.UseLeaseV1
  trusted: TrustedSecretUseContext
  input: ProviderTransportInput
  send: (request: ProviderTransportRequest) => Promise<AsyncIterable<Uint8Array>>
  signal?: AbortSignal
  deadlineAt: number
  maxResponseBytes: number
  now?: () => number
}): Promise<AsyncIterable<Uint8Array>> {
  const { input, lease, trusted } = options
  const now = options.now ?? Date.now
  const responseLimit = options.maxResponseBytes
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= now()) {
    throw new SecretBrokerError("EXPIRED", "Provider request deadline has expired")
  }
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 10 * 1024 * 1024) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider response bound is invalid")
  }
  if (options.signal?.aborted) throw new SecretBrokerError("EXPIRED", "Provider request was cancelled")
  if (
    input.providerId !== trusted.providerId ||
    input.providerId !== lease.providerId ||
    input.destination !== trusted.destination ||
    input.destination !== lease.destination ||
    providerRequestDigest(input) !== trusted.operationDigest ||
    providerRequestDigest(input) !== lease.operationDigest
  ) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request does not match its authorized lease")
  }
  if (input.providerId === "brave" || input.credentialHeader.name === "x-subscription-token") {
    let braveURL: URL | undefined
    try { braveURL = new URL(input.destination) } catch { /* rejected below */ }
    if (input.providerId !== "brave" || input.method !== "GET" ||
      input.credentialHeader.name !== "x-subscription-token" || input.credentialHeader.prefix !== "" ||
      !braveURL || braveURL.protocol !== "https:" || braveURL.hostname !== "api.search.brave.com" ||
      braveURL.pathname !== "/res/v1/web/search" || braveURL.port !== "" ||
      new TextEncoder().encode(input.body).byteLength !== 0 || Object.keys(input.headers).length !== 0) {
      throw new SecretBrokerError("INVALID_REQUEST", "Brave credentials require the fixed GET search profile")
    }
  }
  let url: URL
  try {
    url = new URL(input.destination)
  } catch {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider destination is invalid")
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.toString() !== input.destination ||
    new TextEncoder().encode(input.body).byteLength > MAX_PROVIDER_BODY_BYTES
  ) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request is outside the supported transport bounds")
  }
  const headerEntries = Object.entries(input.headers)
  if (headerEntries.length > 64) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header count limit")
  }
  const headers: Record<string, string> = {}
  let headerBytes = 0
  for (const [rawName, value] of headerEntries) {
    const name = rawName.toLowerCase()
    if (Object.hasOwn(headers, name)) {
      throw new SecretBrokerError("INVALID_REQUEST", "Provider request contains duplicate case-insensitive headers")
    }
    if (
      name.length > 128 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      /^(authorization|proxy-authorization|x-api-key|x-subscription-token|api-key|cookie)$/.test(name) ||
      /[\r\n\u0000]/.test(value)
    ) {
      throw new SecretBrokerError("INVALID_REQUEST", "Provider request headers contain a forbidden credential field")
    }
    headerBytes += new TextEncoder().encode(name).byteLength + new TextEncoder().encode(value).byteLength
    if (headerBytes > 32 * 1024) {
      throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header size limit")
    }
    headers[name] = value
  }
  const credentialHeader = input.credentialHeader.name
  if (Object.hasOwn(headers, credentialHeader)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request already contains an auth header")
  }
  if (input.credentialHeader.prefix.length > 32 || /[\r\n\u0000]/.test(input.credentialHeader.prefix)) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider authentication format is invalid")
  }
  if (headerBytes + new TextEncoder().encode(input.credentialHeader.prefix).byteLength + 16 * 1024 > 32 * 1024) {
    throw new SecretBrokerError("INVALID_REQUEST", "Provider request exceeds its header size limit")
  }

  return options.broker.withUse(lease, trusted, async (bytes) => {
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", abortFromCaller, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abortFromCaller)
    }
    controller.signal.addEventListener("abort", cleanup, { once: true })
    const abortError = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new SecretBrokerError("EXPIRED", "Provider request was cancelled or exceeded its deadline")),
        { once: true },
      )
    })
    let credential: string
    const remaining = options.deadlineAt - now()
    if (remaining <= 0 || controller.signal.aborted) {
      cleanup()
      throw new SecretBrokerError("EXPIRED", "Provider request was cancelled or exceeded its deadline")
    }
    try {
      timeout = setTimeout(() => controller.abort(), remaining)
      credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      controller.abort()
      throw new SecretBrokerError("UNAVAILABLE", "Stored provider credential is invalid")
    }
    if (credential.length === 0 || /[\r\n\u0000]/.test(credential)) {
      controller.abort()
      throw new SecretBrokerError("UNAVAILABLE", "Stored provider credential is invalid")
    }
    headers[credentialHeader] = `${input.credentialHeader.prefix}${credential}`
    try {
      let response: AsyncIterable<Uint8Array>
      try {
        response = await Promise.race([
          options.send({
            url: input.destination,
            method: input.method,
            body: input.body,
            headers,
            signal: controller.signal,
            maxResponseBytes: responseLimit,
          }),
          abortError,
        ])
      } catch (error) {
        controller.abort()
        cleanup()
        throw error
      }
      return (async function* () {
        let consumed = 0
        const iterator = response[Symbol.asyncIterator]()
        try {
          while (true) {
            const next = await Promise.race([Promise.resolve(iterator.next()), abortError])
            if (next.done) break
            const chunk = next.value
            if (controller.signal.aborted) {
              throw new SecretBrokerError("EXPIRED", "Provider response was cancelled or exceeded its deadline")
            }
            if (!(chunk instanceof Uint8Array) || consumed + chunk.byteLength > responseLimit) {
              controller.abort()
              throw new SecretBrokerError("UNAVAILABLE", "Provider response exceeded its size limit")
            }
            consumed += chunk.byteLength
            yield chunk
          }
        } finally {
          cleanup()
          if (!controller.signal.aborted) controller.abort()
          void Promise.resolve(iterator.return?.()).catch(() => undefined)
        }
      })()
    } finally {
      delete headers[credentialHeader]
      credential = ""
    }
  })
}
/** Issue, redeem, and dispatch one exact OpenRouter free-route use grant. */
export async function dispatchAuthorizedDirectFreeProviderRequest(options: {
  readonly broker: Pick<ReturnType<typeof import("./secret-broker").createSecretBroker>, "authorizeUse" | "withUse">
  readonly authorizer: CredentialUseAuthorizer
  readonly principal: TrustedPrincipal
  readonly secretRef: SecretBrokerV1.SecretRef
  readonly prepared: PreparedDirectProviderTransportV1
  readonly signal?: AbortSignal
  readonly send: (request: ProviderTransportRequest) => Promise<Response>
  readonly now?: () => number
}): Promise<Response> {
  const now = options.now ?? Date.now
  const prepared = options.prepared
  const route = prepared.route
  const transport = prepared.transport
  if (route.providerID !== "openrouter" || route.modelID !== "nvidia/nemotron-3.5-super-vl:free" ||
    route.explicitFreeCredential !== true || route.anonymousOpenCodeFree ||
    route.endpointBase !== "https://openrouter.ai/api/v1" ||
    transport.providerId !== route.providerID || transport.destination !== "https://openrouter.ai/api/v1/chat/completions" ||
    transport.method !== "POST" || Object.hasOwn(transport.headers, "authorization") ||
    !/^blake3:[a-f0-9]{64}$/.test(prepared.transportRequestDigest)) {
    throw new SecretBrokerError("UNAVAILABLE", "Direct credential dispatch is limited to the exact OpenRouter free offer")
  }
  const requestDigest = providerRequestDigest(transport)
  const operationDigest = providerOperationDigest(requestDigest)
  if (options.signal?.aborted) throw new SecretBrokerError("EXPIRED", "Provider request was cancelled")

  const grant = await options.authorizer.authorize({
    secretRef: options.secretRef,
    providerId: transport.providerId,
    modelId: route.modelID,
    destination: transport.destination,
    providerRequestDigest: requestDigest,
    purpose: "PROVIDER_REQUEST",
  }, options.principal)
  const assertGrantMatches = () => {
    if (grant.secretRef !== options.secretRef || grant.providerId !== transport.providerId ||
      grant.modelId !== route.modelID || grant.destination !== transport.destination ||
      grant.providerRequestDigest !== requestDigest || grant.operationDigest !== operationDigest ||
      grant.purpose !== "PROVIDER_REQUEST" || providerOperationDigest(providerRequestDigest(transport)) !== grant.operationDigest) {
      throw new SecretBrokerError("CONFLICT", "HostKernel provider-use grant differs from the exact request")
    }
  }
  assertGrantMatches()
  const expiresAt = new Date(grant.expiresAtUnixMs).toISOString()
  const useRequest: SecretBrokerV1.UseRequestV1 = {
    schemaVersion: 1,
    secretRef: options.secretRef,
    providerId: transport.providerId,
    operationDigest: requestDigest as SecretBrokerV1.SecretOperationDigest,
    destination: transport.destination,
    purpose: "PROVIDER_REQUEST",
    expiresAt,
    maxRequests: 1,
  }
  const trusted = grant.trusted
  if (trusted.providerId !== transport.providerId || trusted.operationDigest !== requestDigest ||
    trusted.destination !== transport.destination || trusted.purpose !== "PROVIDER_REQUEST" ||
    trusted.maxExpiresAt !== expiresAt) {
    throw new SecretBrokerError("CONFLICT", "HostKernel provider-use context differs from the exact request")
  }
  const lease = await options.broker.authorizeUse(useRequest, trusted)
  if (lease.secretRef !== options.secretRef || lease.secretVersion !== grant.secretVersion ||
    lease.providerId !== transport.providerId || lease.operationDigest !== requestDigest ||
    lease.destination !== transport.destination || lease.purpose !== "PROVIDER_REQUEST" ||
    lease.requesterRef !== trusted.requesterRef || lease.state !== "ISSUED" || lease.maxRequests !== 1 ||
    Date.parse(lease.expiresAt) !== grant.expiresAtUnixMs) {
    throw new SecretBrokerError("CONFLICT", "SecretBroker lease differs from the HostKernel provider-use grant")
  }
  assertGrantMatches()
  await options.authorizer.redeem(grant, options.principal)

  let responseStatus: number | undefined
  let responseHeaders: Headers | undefined
  const chunks = await dispatchProviderRequest({
    broker: options.broker,
    lease,
    trusted,
    input: transport,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    deadlineAt: grant.expiresAtUnixMs,
    maxResponseBytes: MAX_DIRECT_PROVIDER_RESPONSE_BYTES,
    now,
    send: async (request) => {
      assertGrantMatches()
      if (providerRequestDigest(transport) !== requestDigest || providerOperationDigest(providerRequestDigest(transport)) !== grant.operationDigest) {
        throw new SecretBrokerError("CONFLICT", "Provider request digest changed before transport send")
      }
      const response = await options.send(request)
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || [204, 205, 304].includes(response.status)) {
        throw new SecretBrokerError("UNAVAILABLE", "OpenRouter returned an unsupported response status")
      }
      responseStatus = response.status
      responseHeaders = safeProviderResponseHeaders(response.headers)
      return responseBodyChunks(response)
    },
  })
  if (responseStatus === undefined || !responseHeaders) {
    throw new SecretBrokerError("UNAVAILABLE", "OpenRouter response metadata is unavailable")
  }
  const iterator = chunks[Symbol.asyncIterator]()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
  return new Response(body, { status: responseStatus, headers: responseHeaders })
}
