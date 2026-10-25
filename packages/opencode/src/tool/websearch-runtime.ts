import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSupervisor, SessionSupervisorError, WEB_SEARCH_CASCADE_FEATURE } from "@opencode-ai/core/session/supervisor"
import type { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1, EffectChallenge, EffectLease } from "@opencode-ai/core/session/supervisor"
import type { SearchRouteID, SearchProviderStatus, SearchCascadeSettings, SearchRouteAttempt, SearchResultItem } from "./websearch-broker"
import { inspectSearchProviders, normalizeSearchCascadeSettings, processSearchAttemptStore, processSearchCooldownStore, SEARCH_ROUTE_IDS, searchRouteRuntimeReady } from "./websearch-broker"
import { createSearchInspectionRoutes, createSearchRoutePlan, parseSearchProviderResponse, searchProviderResponseTruncated, type SearchCredentialRefs } from "./websearch-adapters"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import { isReceiptAdvancedManagedAttemptScope, managedAttemptScopeToWire, sameManagedAttemptScope } from "@/session/managed-control"

export type SearchEffectArgumentsV1 = {
  query: string
  limit: number
  /** Exact model-requested domain filters; omitted and [] remain distinct. */
  domains?: readonly string[]
  routes: readonly { routeKey: SearchRouteID; attemptCount: 2 }[]
  credentialRefsByRoute?: readonly { routeKey: SearchRouteID; secretRef: SecretBrokerV1.SecretRef }[]
}

/**
 * Trusted pre-admission projection for P1's ToolBatch hook. `modelArgs` is
 * used only for query/limit; enablement, order, supported routes, and opaque
 * SecretBroker references must come from trusted Core/P6 services. The exact
 * returned `arguments` object is what Guard must hash and pin.
 */
export function prepareSearchEffectArguments(input: {
  modelArgs: unknown
  settings: SearchCascadeSettings
  supportedProviders: readonly SearchRouteID[]
  runtimeReady?: Partial<Record<SearchRouteID, boolean>>
  credentialRefs?: SearchCredentialRefs
}): { arguments: SearchEffectArgumentsV1; execution: SearchEffectArgumentsV1 } {
  if (typeof input.modelArgs !== "object" || input.modelArgs === null || Array.isArray(input.modelArgs)) {
    throw new Error("Invalid web-search arguments")
  }
  const model = input.modelArgs as Record<string, unknown>
  if (typeof model.query !== "string" || !model.query.trim() || new TextEncoder().encode(model.query).byteLength > 2_000) {
    throw new Error("Web-search query is invalid or exceeds its UTF-8 byte limit")
  }
  const rawLimit = model.limit ?? model.numResults ?? 8
  if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 10) {
    throw new Error("Web-search result limit is outside the supported range")
  }
  let domains: readonly string[] | undefined
  if (Object.hasOwn(model, "domains")) {
    domains = boundedDomainFilters(model.domains)
  }
  const settings = normalizeSearchCascadeSettings(input.settings)
  const supportedProviders = input.supportedProviders.filter((route) =>
    input.runtimeReady?.[route] ?? searchRouteRuntimeReady(route))
  const plan = createSearchRoutePlan({
    enabled: settings.enabled,
    order: settings.order,
    supportedProviders,
    credentialRefs: input.credentialRefs ?? {},
  })
  if (plan.routes.length === 0) throw new Error("No explicitly enabled web-search route is available for Guard admission")
  const arguments_: SearchEffectArgumentsV1 = {
    query: model.query.trim(),
    limit: rawLimit,
    ...(domains === undefined ? {} : { domains }),
    routes: plan.routes.slice(0, 10).map((routeKey) => ({ routeKey, attemptCount: 2 as const })),
    ...(plan.credentialRefsByRoute.length ? { credentialRefsByRoute: plan.credentialRefsByRoute.slice(0, 10) } : {}),
  }
  return { arguments: arguments_, execution: arguments_ }
}

/** Exact model-requested domain filters; bounded and duplicate-free. */
function boundedDomainFilters(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 ||
    !value.every((domain) => typeof domain === "string" && domain.length >= 1 && domain.length <= 253 &&
      /^[A-Za-z0-9.*-]+(?:\.[A-Za-z0-9.*-]+)*$/.test(domain) &&
      /^(\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(domain)) ||
    new Set(value).size !== value.length) {
    throw new Error("Web-search domain filters are invalid or exceed their bounds")
  }
  return value as readonly string[]
}

export type WebSearchCascadeRequestV1 = SearchEffectArgumentsV1 & {
  sessionID: string
  effectID: string
  capabilityLeaseDigest: string
}

const BLAKE3_DIGEST = /^blake3:[0-9a-f]{64}$/

/** Bounded identifier rule shared by SecretBroker's `Identifier` schema: no
 * whitespace and no ASCII control characters. */
function trustedOpID(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 256) return false
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || character.trim() === "") return false
  }
  return true
}

/**
 * Trusted aggregate HostKernel request projection for the admitted
 * `execute_search_cascade` operation. It carries the exact ordered route plan
 * plus the opaque BYO SecretBroker references that P6's transport consumes;
 * those references are metadata-only and never credential bytes. The projection
 * is closed: identities, lease digest, query/limit bounds, route order and the
 * per-route credential references all come from trusted Core state, and every
 * referenced BYO route must be an admitted route so no reference can be
 * smuggled into the guarded operation before Guard admission.
 */
export function webSearchCascadeRequestV1(input: WebSearchCascadeRequestV1): WebSearchCascadeRequestV1 {
  if (typeof input !== "object" || input === null) throw new Error("HostKernel web-search request is invalid")
  const boundedID = (value: unknown, name: string) => {
    if (!trustedOpID(value)) throw new Error(`HostKernel web-search ${name} is invalid`)
    return value
  }
  const sessionID = boundedID(input.sessionID, "sessionID")
  const effectID = boundedID(input.effectID, "effectID")
  if (typeof input.capabilityLeaseDigest !== "string" || !BLAKE3_DIGEST.test(input.capabilityLeaseDigest)) {
    throw new Error("HostKernel web-search capability lease digest is invalid")
  }
  if (typeof input.query !== "string" || !input.query.trim() || new TextEncoder().encode(input.query).byteLength > 2_000) {
    throw new Error("HostKernel web-search query is invalid or exceeds its UTF-8 byte limit")
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10) {
    throw new Error("HostKernel web-search result limit is outside the supported range")
  }
  const domains = input.domains === undefined ? undefined : boundedDomainFilters(input.domains)
  const supportedRoutes = new Set<string>(SEARCH_ROUTE_IDS)
  if (!Array.isArray(input.routes) || input.routes.length < 1 || input.routes.length > 10) {
    throw new Error("HostKernel web-search route plan is empty or exceeds its bound")
  }
  const admitted = new Set<string>()
  for (const route of input.routes) {
    if (typeof route !== "object" || route === null ||
      typeof route.routeKey !== "string" || !supportedRoutes.has(route.routeKey) ||
      route.attemptCount !== 2) {
      throw new Error("HostKernel web-search route plan contains an unsupported route or attempt count")
    }
    if (admitted.has(route.routeKey)) throw new Error("HostKernel web-search route plan contains a duplicate route")
    admitted.add(route.routeKey)
  }
  let credentialRefsByRoute: WebSearchCascadeRequestV1["credentialRefsByRoute"]
  if (input.credentialRefsByRoute !== undefined) {
    if (!Array.isArray(input.credentialRefsByRoute) || input.credentialRefsByRoute.length > 10) {
      throw new Error("HostKernel web-search credential reference plan exceeds its bound")
    }
    const referenced = new Set<string>()
    for (const entry of input.credentialRefsByRoute) {
      if (typeof entry !== "object" || entry === null ||
        typeof entry.routeKey !== "string" || !admitted.has(entry.routeKey) ||
        !trustedOpID(entry.secretRef)) {
        throw new Error("HostKernel web-search credential reference does not match an admitted route")
      }
      if (referenced.has(entry.routeKey)) throw new Error("HostKernel web-search credential reference is duplicated")
      referenced.add(entry.routeKey)
    }
    credentialRefsByRoute = input.credentialRefsByRoute
  }
  return {
    sessionID,
    effectID,
    capabilityLeaseDigest: input.capabilityLeaseDigest,
    query: input.query,
    limit: input.limit,
    ...(domains === undefined ? {} : { domains: input.domains }),
    routes: input.routes.map((route) => ({ routeKey: route.routeKey, attemptCount: 2 as const })),
    ...(credentialRefsByRoute === undefined ? {} : { credentialRefsByRoute }),
  }
}

export type SearchCascadeScopeV1 = {
  sessionID: string
  messageID: string
  callID: string
  /** Trusted local Location root used only to namespace bounded status history. */
  workspace: string
  directAttempt?: DirectAttemptScopeV1
  managedAttempt?: ManagedAttemptScopeV1
}

export type SearchCascadeAttemptReceiptV1 = {
  provider: SearchRouteID
  routeId: string
  routeIndex: number
  attempt: number
  status: "SUCCEEDED" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "EMPTY" | "NOT_DISPATCHED" | "UNKNOWN"
  /** Required host-authenticated classification; non-NOT_DISPATCHED rows carry null. */
  notDispatchedFailure: "cancelled" | "timed_out" | "transport_failure" | null
  httpStatus?: number
  retryAfterMs?: number
  observedAt: string
  receiptRef?: string
  resultCount?: number
}

export type SearchCascadeResponseV1 = {
  status: "SUCCEEDED" | "FAILED" | "EXHAUSTED" | "CANCELLED" | "UNKNOWN" | "NEEDS_APPROVAL" | "NOT_DISPATCHED" | "RECONCILED_RESULT_UNAVAILABLE" | "WAITING_SECRET"
  selectedProvider?: SearchRouteID
  body?: unknown
  attempts: readonly SearchCascadeAttemptReceiptV1[]
  receiptRef?: string
  managedAttempt?: ManagedAttemptScopeV1
  attemptScopeTransition?: "effect_receipt"
  cascadeRef?: string
  cascadeDigest?: string
  routePlanDigest?: string
  routeIndex?: number
  nextRoute?: Readonly<Record<string, unknown>>
}

/** Trusted Core-to-HostKernel aggregate cascade bridge. */
export interface WebSearchGuardedCapability {
  readonly ready: boolean
  readonly supportedProviders: readonly SearchRouteID[]
  /** Optional deterministic route gate for isolated contract seams only. */
  readonly runtimeReady?: Partial<Record<SearchRouteID, boolean>>
  credentialRefs(): Promise<Partial<Record<SearchRouteID, SecretBrokerV1.SecretRef>>>
  /**
   * Mint the metadata-only SecretBroker request context for one approved BYO
   * route attempt. This does not expose credential bytes or authorize a
   * network send by itself; P6's in-process broker/transport validates and
   * consumes the returned projection. Production dispatch remains separately
   * gated until its durable per-route receipt path is composed.
   */
  authorizeSearchSecretUse?(input: {
    scope: SearchCascadeScopeV1
    routeKey: SearchRouteID
    attempt: 1 | 2
    challenge: EffectChallenge
    lease: EffectLease
    signal?: AbortSignal
  }): Promise<Readonly<Record<string, unknown>>>
  executeSearchCascade(input: SearchEffectArgumentsV1 & {
    sessionID: string
    messageID: string
    callID: string
    directAttempt?: DirectAttemptScopeV1
    managedAttempt?: ManagedAttemptScopeV1
    challenge?: EffectChallenge
    lease?: EffectLease
    signal?: AbortSignal
  }): Promise<SearchCascadeResponseV1>
  workspace(): string
}

export interface Interface {
  prepareEffectArguments(modelArgs: unknown): Effect.Effect<{ arguments: SearchEffectArgumentsV1; execution: SearchEffectArgumentsV1 }, Error>
  search(input: {
    execution: SearchEffectArgumentsV1
    scope: SearchCascadeScopeV1
    managedAuthority?: ManagedAttemptAuthority
    challenge?: EffectChallenge
    lease?: EffectLease
    signal?: AbortSignal
  }): Effect.Effect<{
    result: {
      provider: SearchRouteID
      routePlanDigest: string
      results: SearchResultItem[]
      routeClass: "DIRECT_SEARCH" | "GROUNDED_MODEL_SEARCH"
      costClass: "FREE" | "UNKNOWN"
      authSource: "none" | "secret_broker"
      freshness: "current" | "unknown"
      retrievedAt: string
      latencyMs: number
      routeAttempts: SearchRouteAttempt[]
      truncated: boolean
    }
    attempts: SearchRouteAttempt[]
  }, Error>
  inspect(input: { settings?: SearchCascadeSettings; workspace: string }): Effect.Effect<SearchProviderStatus[], never>
}

export class SearchRuntimeError extends Error {
  constructor(
    message: string,
    readonly attempts: SearchRouteAttempt[],
    readonly outcome: "FAILED" | "EXHAUSTED" | "CANCELLED" | "UNKNOWN" | "NOT_DISPATCHED" | "RESULT_UNAVAILABLE" = "EXHAUSTED",
    readonly receiptRef?: string,
    readonly routePlanDigest?: string,
  ) {
    super(message)
    this.name = "SearchRuntimeError"
  }
}

/** §37.5/DEC-V1-26 transient set: 408/425 and every 5xx carry the bounded
 * same-route retry. At attempt 1 they may only be classified as the retryable
 * failure — a terminal `FAILED` there would silently skip the mandated retry
 * and could fail over or report exhaustion early. */
function transientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 425 || (status !== undefined && status >= 500 && status <= 599)
}

/** Ensure HostKernel's bounded route evidence is a projection of the exact
 * ordered plan Core admitted. A valid provider ID alone is not enough: a
 * disabled route must never silently exceed the user's consent. */
export function validateCascadeResponseRoutes(
  response: SearchCascadeResponseV1,
  execution: SearchEffectArgumentsV1,
): SearchCascadeResponseV1 {
  const routeIndexes = new Map(execution.routes.map((route, index) => [route.routeKey, index]))
  const seenReceiptRefs = new Set<string>()
  let previousIndex = -1
  let previousAttempt = 0
  let previousStatus: SearchCascadeAttemptReceiptV1["status"] | undefined
  let previousNotDispatchedFailure: SearchCascadeAttemptReceiptV1["notDispatchedFailure"] = null
  let previousHttpStatus: number | undefined
  for (const item of response.attempts) {
    if (item.receiptRef !== undefined) {
      if (seenReceiptRefs.has(item.receiptRef)) {
        throw new Error("HostKernel reused a web-search route receipt reference")
      }
      seenReceiptRefs.add(item.receiptRef)
    }
    if (item.status === "FAILED" && item.attempt === 1 && transientHttpStatus(item.httpStatus)) {
      throw new Error("HostKernel returned a retryable HTTP status without its required same-route retry")
    }
    if (previousStatus === "SUCCEEDED" || previousStatus === "UNKNOWN" ||
      (previousStatus === "NOT_DISPATCHED" && previousNotDispatchedFailure === "cancelled")) {
      throw new Error("HostKernel continued the web-search cascade after a terminal route outcome")
    }
    if ((previousStatus === "RETRYABLE_FAILURE" ||
      (previousStatus === "NOT_DISPATCHED" && (previousNotDispatchedFailure === "timed_out" || previousNotDispatchedFailure === "transport_failure"))) &&
      previousAttempt === 1 && item.routeIndex !== previousIndex) {
      throw new Error("HostKernel skipped the required bounded same-route retry")
    }
    if (previousHttpStatus !== undefined && previousHttpStatus >= 400 && previousHttpStatus < 500 &&
      previousHttpStatus !== 401 && previousHttpStatus !== 403 && previousHttpStatus !== 407 && previousHttpStatus !== 429 &&
      ![408, 425].includes(previousHttpStatus)) {
      throw new Error("HostKernel continued after a terminal non-rate-limit HTTP 4xx route failure")
    }
    const index = routeIndexes.get(item.provider)
    if (index === undefined || item.routeIndex !== index || item.routeId !== `web.search.${item.provider}` ||
      index < previousIndex || index > previousIndex + 1) {
      throw new Error("HostKernel returned a web-search receipt outside the approved route order")
    }
    if (index === previousIndex) {
      if (item.attempt !== previousAttempt + 1 ||
        (previousStatus !== "RETRYABLE_FAILURE" &&
          !(previousStatus === "NOT_DISPATCHED" && (previousNotDispatchedFailure === "timed_out" || previousNotDispatchedFailure === "transport_failure")))) {
        throw new Error("HostKernel returned an invalid same-route retry sequence")
      }
    } else if (item.attempt !== 1) {
      throw new Error("HostKernel returned a route retry without its first attempt")
    }
    previousIndex = index
    previousAttempt = item.attempt
    previousStatus = item.status
    previousNotDispatchedFailure = item.notDispatchedFailure
    previousHttpStatus = item.httpStatus
  }
  if (response.status !== "UNKNOWN" && response.attempts.some((item) => item.status === "UNKNOWN")) {
    throw new Error("HostKernel must preserve an unknown route outcome as an UNKNOWN aggregate outcome")
  }
  if ((previousStatus === "RETRYABLE_FAILURE" ||
    (previousStatus === "NOT_DISPATCHED" && (previousNotDispatchedFailure === "timed_out" || previousNotDispatchedFailure === "transport_failure"))) &&
    previousAttempt === 1 && response.status !== "UNKNOWN" && response.status !== "CANCELLED") {
    throw new Error("HostKernel ended the cascade before the required bounded same-route retry")
  }
  if (previousStatus === "FAILED" && (previousHttpStatus === 408 || previousHttpStatus === 425) &&
    previousAttempt === 1 && response.status !== "UNKNOWN" && response.status !== "CANCELLED") {
    throw new Error("HostKernel ended the cascade before the required bounded same-route retry")
  }
  if (response.routePlanDigest !== undefined && !/^blake3:[0-9a-f]{64}$/.test(response.routePlanDigest)) {
    throw new Error("HostKernel returned an invalid web-search route-plan digest")
  }
  // Settled/possibly-dispatched aggregate outcomes require the host plan pin.
  if (["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "UNKNOWN", "RECONCILED_RESULT_UNAVAILABLE"].includes(response.status) && !response.routePlanDigest) {
    throw new Error("HostKernel omitted the trusted route-plan digest for a settled search cascade")
  }
  if (response.status === "NOT_DISPATCHED" && (
    response.attempts.length !== 0 || response.routePlanDigest !== undefined ||
    response.selectedProvider !== undefined || response.body !== undefined ||
    response.receiptRef !== undefined || response.managedAttempt !== undefined || response.attemptScopeTransition !== undefined ||
    response.cascadeRef !== undefined || response.cascadeDigest !== undefined || response.routeIndex !== undefined || response.nextRoute !== undefined
  )) {
    throw new Error("HostKernel returned dispatch evidence for a not-dispatched web-search request")
  }
  if (response.status === "WAITING_SECRET") {
    const nextRouteKey = response.nextRoute?.routeKey
    const nextAttempt = response.nextRoute?.attempt
    const approvedIndex = execution.routes.findIndex((route) => route.routeKey === nextRouteKey)
    if (approvedIndex < 0 || approvedIndex !== response.routeIndex || nextAttempt !== 1 ||
      (previousIndex === -1 ? approvedIndex !== 0 : approvedIndex !== previousIndex + 1)) {
      throw new Error("HostKernel BYO continuation does not match the next approved route")
    }
  }
  if (response.selectedProvider !== undefined &&
    (!routeIndexes.has(response.selectedProvider) ||
      response.status !== "SUCCEEDED" ||
      response.attempts.at(-1)?.provider !== response.selectedProvider ||
      response.attempts.at(-1)?.status !== "SUCCEEDED")) {
    throw new Error("HostKernel selected a route without an approved successful receipt")
  }
  if (response.status === "SUCCEEDED" && response.selectedProvider === undefined) {
    throw new Error("HostKernel succeeded without selecting an approved route")
  }
  if (response.status === "EXHAUSTED" && response.attempts.some((item) => item.status === "SUCCEEDED")) {
    throw new Error("HostKernel exhausted the web-search cascade after reporting a successful route")
  }
  if (response.status === "EXHAUSTED") {
    if (response.attempts.some((item) =>
      item.status === "NOT_DISPATCHED" && item.notDispatchedFailure === "cancelled")) {
      throw new Error("HostKernel reported exhaustion after a cancelled route receipt")
    }
    const last = response.attempts.at(-1)
    if (!last || last.routeIndex !== execution.routes.length - 1) {
      throw new Error("HostKernel reported exhaustion before every approved route was consumed")
    }
    if (last.status === "FAILED" && last.httpStatus !== undefined && last.httpStatus >= 400 && last.httpStatus < 500 &&
      ![401, 403, 407, 429].includes(last.httpStatus) &&
      !([408, 425].includes(last.httpStatus) && last.attempt === 2)) {
      throw new Error("HostKernel must report a terminal non-authentication 4xx as FAILED, not EXHAUSTED")
    }
  }
  if (response.status === "FAILED") {
    const last = response.attempts.at(-1)
    if (!last || last.status !== "FAILED" || last.httpStatus === undefined || last.httpStatus < 400 || last.httpStatus >= 500 ||
      [401, 403, 407, 429, 408, 425].includes(last.httpStatus) ||
      response.selectedProvider !== undefined || response.body !== undefined ||
      response.attempts.some((item) => item.status === "SUCCEEDED" || item.status === "UNKNOWN")) {
      throw new Error("HostKernel returned FAILED without a settled terminal non-authentication 4xx receipt")
    }
  }
  if (response.status === "UNKNOWN" && response.attempts.some((item) => item.status === "SUCCEEDED")) {
    throw new Error("HostKernel reported an unknown cascade after a successful route")
  }
  if (response.status === "CANCELLED" && (
    !response.routePlanDigest || !response.receiptRef || response.selectedProvider !== undefined || response.body !== undefined ||
    response.attempts.some((item) => item.status === "SUCCEEDED" || item.status === "UNKNOWN")
  )) {
    throw new Error("HostKernel returned an invalid cancelled web-search outcome")
  }
  if (response.status === "RECONCILED_RESULT_UNAVAILABLE" && response.attempts.at(-1)?.status !== "SUCCEEDED") {
    throw new Error("HostKernel reconciled an unavailable result without a successful route receipt")
  }
  return response
}

/** A continuing WAITING_SECRET projection retains its durable HostKernel
 * cursor identity across resume. Terminal recovery is receipt-only by §37.5
 * and intentionally carries no cascadeRef/cascadeDigest to compare. */
export function validateCascadeContinuationIdentity<
  T extends Pick<SearchCascadeResponseV1, "status" | "cascadeRef" | "cascadeDigest">,
>(
  previous: Pick<SearchCascadeResponseV1, "cascadeRef" | "cascadeDigest">,
  resumed: T,
): T {
  if (resumed.status === "WAITING_SECRET" &&
    (resumed.cascadeRef !== previous.cascadeRef || resumed.cascadeDigest !== previous.cascadeDigest)) {
    throw new Error("HostKernel changed its durable cascade cursor during BYO resume")
  }
  return resumed
}

function parseAndValidateCascadeResponse(
  value: Readonly<Record<string, unknown>>,
  execution: SearchEffectArgumentsV1,
  pinnedRoutePlanDigest?: string,
): SearchCascadeResponseV1 {
  try {
    const response = parseCascadeResponse(value)
    if (pinnedRoutePlanDigest !== undefined && response.routePlanDigest !== pinnedRoutePlanDigest) {
      throw new Error("HostKernel route-plan digest differs from the exact approved consent pin")
    }
    return validateCascadeResponseRoutes(response, execution)
  } catch {
    // Once HostKernel dispatch was entered, malformed response evidence is an
    // UNKNOWN outcome. Keep only a digest returned by HostKernel that exactly
    // matches the trusted approval pin; never derive one from the request.
    const hostDigest = value.routePlanDigest
    const digest = typeof hostDigest === "string" && /^blake3:[0-9a-f]{64}$/.test(hostDigest)
      ? hostDigest
      : undefined
    const pinned = typeof pinnedRoutePlanDigest === "string" && /^blake3:[0-9a-f]{64}$/.test(pinnedRoutePlanDigest)
      ? pinnedRoutePlanDigest
      : undefined
    throw new SearchRuntimeError(
      "HostKernel returned malformed web-search evidence after dispatch; outcome remains UNKNOWN and no route was retried.",
      [],
      "UNKNOWN",
      typeof value.receiptRef === "string" && value.receiptRef.length <= 256 ? value.receiptRef : undefined,
      digest && (!pinned || digest === pinned) ? digest : pinned,
    )
  }
}

/** A settled successful provider receipt with no safely decoded result is a
 * completed effect with unavailable data, never route exhaustion. */
export function decodeSuccessfulCascadeResults(
  response: SearchCascadeResponseV1,
  limit: number,
  attempts: SearchRouteAttempt[],
): SearchResultItem[] {
  if (response.status !== "SUCCEEDED" || !response.selectedProvider) {
    throw new Error("Search result decoding requires a successful selected route")
  }
  const results = response.body === undefined
    ? []
    : (() => {
        try {
          return parseSearchProviderResponse(response.selectedProvider!, response.body, limit)
        } catch {
          return []
        }
      })()
  if (results.length === 0) {
    throw new SearchRuntimeError(
      "Search completed successfully, but its result payload could not be safely decoded; no route was retried.",
      attempts,
      "RESULT_UNAVAILABLE",
      response.receiptRef,
      response.routePlanDigest,
    )
  }
  return results
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/WebSearchRuntime") {}

export function parseCascadeResponse(value: Readonly<Record<string, unknown>>): SearchCascadeResponseV1 {
  const allowed = new Set(["status", "selectedProvider", "body", "attempts", "receiptRef", "managedAttempt", "attemptScopeTransition", "cascadeRef", "cascadeDigest", "routePlanDigest", "routeIndex", "nextRoute"])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("HostKernel returned an unknown web-search response field")
  if (value.status !== "SUCCEEDED" && value.status !== "FAILED" && value.status !== "EXHAUSTED" && value.status !== "CANCELLED" && value.status !== "UNKNOWN" && value.status !== "NEEDS_APPROVAL" && value.status !== "NOT_DISPATCHED" && value.status !== "RECONCILED_RESULT_UNAVAILABLE" && value.status !== "WAITING_SECRET") {
    throw new Error("HostKernel returned an invalid web-search status")
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > 20) throw new Error("HostKernel returned invalid web-search route receipts")
  const attempts = value.attempts.map((raw): SearchCascadeAttemptReceiptV1 => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("HostKernel returned an invalid route receipt")
    const item = raw as Record<string, unknown>
    const provider = item.provider
    const routeId = item.routeId
    const routeIndex = item.routeIndex
    const status = item.status
    const attempt = item.attempt
    const observedAt = item.observedAt
    if (Object.keys(item).some((key) => !["provider", "routeId", "routeIndex", "attempt", "status", "notDispatchedFailure", "httpStatus", "retryAfterMs", "observedAt", "receiptRef", "resultCount"].includes(key)) ||
      typeof provider !== "string" || !(SEARCH_ROUTE_IDS as readonly string[]).includes(provider) ||
      typeof routeId !== "string" || routeId !== `web.search.${provider}` || routeId.length > 128 ||
      !Number.isSafeInteger(routeIndex) || (routeIndex as number) < 0 || (routeIndex as number) > 9 ||
      !Number.isSafeInteger(attempt) || (attempt as number) < 1 || (attempt as number) > 2 ||
      (status !== "SUCCEEDED" && status !== "FAILED" && status !== "RATE_LIMITED" && status !== "RETRYABLE_FAILURE" && status !== "EMPTY" && status !== "NOT_DISPATCHED" && status !== "UNKNOWN") ||
      !Object.hasOwn(item, "notDispatchedFailure") ||
      (status === "NOT_DISPATCHED"
        ? item.notDispatchedFailure !== "cancelled" && item.notDispatchedFailure !== "timed_out" && item.notDispatchedFailure !== "transport_failure"
        : item.notDispatchedFailure !== null) ||
       typeof observedAt !== "string" || observedAt.trim().length === 0 || observedAt.length > 64) {
      throw new Error("HostKernel returned an invalid route receipt")
    }
    const optionalInt = (key: string, max: number) => {
      const field = item[key]
      if (field === undefined || field === null) return undefined
      if (key === "httpStatus" && Number.isSafeInteger(field) && ((field as number) < 100 || (field as number) > 599)) {
        throw new Error("HostKernel returned an invalid HTTP status")
      }
      if (!Number.isSafeInteger(field) || (field as number) < 0 || (field as number) > max) throw new Error("HostKernel returned an invalid route receipt bound")
      return field as number
    }
    const receiptRef = item.receiptRef
    if (receiptRef !== undefined && receiptRef !== null && (typeof receiptRef !== "string" || receiptRef.trim().length === 0 || receiptRef.length > 256)) {
      throw new Error("HostKernel returned an invalid route receipt reference")
    }
    if (status !== "UNKNOWN" && typeof receiptRef !== "string") {
      throw new Error("HostKernel omitted the durable receipt for a known route outcome")
    }
    if (status === "UNKNOWN" && receiptRef !== undefined && receiptRef !== null) {
      throw new Error("HostKernel attached a settled receipt to an unknown route outcome")
    }
    const resultCount = optionalInt("resultCount", 10)
    const httpStatus = optionalInt("httpStatus", 599)
    if (status === "EMPTY" && (resultCount !== 0 || httpStatus === undefined || httpStatus < 200 || httpStatus > 299)) {
      throw new Error("HostKernel returned an invalid empty-result route outcome")
    }
    if (httpStatus !== undefined && httpStatus >= 200 && httpStatus <= 299 &&
      ((resultCount === 0 && status !== "EMPTY") || (resultCount !== undefined && resultCount > 0 && status !== "SUCCEEDED") ||
        (resultCount === undefined && status !== "FAILED"))) {
      throw new Error("HostKernel route status does not match the recognized result count")
    }
    if (status === "SUCCEEDED" && (httpStatus === undefined || httpStatus < 200 || httpStatus > 299 || resultCount === undefined || resultCount === 0)) {
      throw new Error("HostKernel returned success without a complete positive result count")
    }
    if (status === "RATE_LIMITED" && httpStatus !== 429) {
      throw new Error("HostKernel returned a rate-limit outcome without HTTP 429")
    }
    if (status === "RETRYABLE_FAILURE" && (attempt !== 1 || httpStatus === undefined ||
      !([408, 425].includes(httpStatus) || (httpStatus >= 500 && httpStatus <= 599)))) {
      throw new Error("HostKernel returned a retryable outcome outside the bounded transient policy")
    }
    if (status === "FAILED" && attempt === 1 && transientHttpStatus(httpStatus)) {
      throw new Error("HostKernel returned a retryable HTTP status without its required same-route retry")
    }
    // The host wire projection carries all three response fields explicitly as
    // JSON null for a proven zero-send receipt. `optionalInt` intentionally
    // maps that null to `undefined`; inspect the normalized value here too so
    // the required null-presence check below remains the single wire-shape
    // authority.
    if (status === "NOT_DISPATCHED" && (httpStatus !== undefined || resultCount !== undefined || optionalInt("retryAfterMs", 60_000) !== undefined)) {
      throw new Error("HostKernel returned a pre-dispatch connection failure with response evidence")
    }
    if (status === "NOT_DISPATCHED" && ["httpStatus", "retryAfterMs", "resultCount"].some((key) =>
      !Object.hasOwn(item, key) || item[key] !== null)) {
      throw new Error("HostKernel omitted the exact empty-response proof for a not-dispatched route")
    }
    return {
      provider: provider as SearchRouteID,
      routeId,
      routeIndex: routeIndex as number,
      attempt: attempt as number,
      status,
      notDispatchedFailure: item.notDispatchedFailure as SearchCascadeAttemptReceiptV1["notDispatchedFailure"],
      observedAt,
      ...(optionalInt("httpStatus", 599) !== undefined ? { httpStatus: optionalInt("httpStatus", 599) } : {}),
      ...(optionalInt("retryAfterMs", 60_000) !== undefined ? { retryAfterMs: optionalInt("retryAfterMs", 60_000) } : {}),
      ...(receiptRef ? { receiptRef } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
    }
  })
  if (value.status !== "UNKNOWN" && attempts.some((item) => item.status === "UNKNOWN")) {
    throw new Error("HostKernel must preserve an unknown route outcome as an UNKNOWN aggregate outcome")
  }
  const selectedProvider = value.selectedProvider
  if (selectedProvider !== undefined && selectedProvider !== null &&
    (typeof selectedProvider !== "string" || !(SEARCH_ROUTE_IDS as readonly string[]).includes(selectedProvider))) {
    throw new Error("HostKernel returned an invalid selected web-search route")
  }
  if (value.receiptRef !== undefined && value.receiptRef !== null &&
    (typeof value.receiptRef !== "string" || value.receiptRef.trim().length === 0 || value.receiptRef.length > 256)) throw new Error("HostKernel returned an invalid aggregate receipt reference")
  const routePlanDigest = value.routePlanDigest
  if (routePlanDigest !== undefined && routePlanDigest !== null &&
    (typeof routePlanDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(routePlanDigest))) {
    throw new Error("HostKernel returned an invalid trusted web-search route-plan digest")
  }
  if (value.status === "SUCCEEDED" && (!selectedProvider || value.body === undefined || value.body === null)) {
    throw new Error("HostKernel omitted the successful web-search response body")
  }
  if (value.body !== undefined && value.body !== null) assertBoundedSearchBody(value.body)
  if ((value.status === "SUCCEEDED" || value.status === "FAILED" || value.status === "EXHAUSTED" || value.status === "CANCELLED" || value.status === "RECONCILED_RESULT_UNAVAILABLE") && typeof value.receiptRef !== "string") {
    throw new Error("HostKernel omitted the durable web-search aggregate receipt")
  }
  if (value.status === "NOT_DISPATCHED" && (
    value.attempts.length !== 0 || routePlanDigest !== undefined ||
    value.selectedProvider !== undefined || value.body !== undefined ||
    value.receiptRef !== undefined || value.managedAttempt !== undefined || value.attemptScopeTransition !== undefined
  )) {
    throw new Error("HostKernel returned route-plan or dispatch evidence for a pre-plan not-dispatched request")
  }
  if (value.status === "CANCELLED" && (
    !routePlanDigest || typeof value.receiptRef !== "string" || value.selectedProvider !== undefined || value.body !== undefined ||
    attempts.some((item) => item.status === "SUCCEEDED" || item.status === "UNKNOWN")
  )) {
    throw new Error("HostKernel returned an invalid cancelled web-search outcome")
  }
  if (value.status === "RECONCILED_RESULT_UNAVAILABLE" && (value.body !== undefined || value.selectedProvider !== undefined)) {
    throw new Error("HostKernel returned a payload for a result-unavailable search reconciliation")
  }
  let cascade: Pick<SearchCascadeResponseV1, "cascadeRef" | "cascadeDigest" | "routePlanDigest" | "routeIndex" | "nextRoute"> = {}
  if (value.status === "WAITING_SECRET") {
    const nextRoute = value.nextRoute
    const authorizationKeys = ["attemptRef", "attemptDigest", "routeKey", "attempt", "providerRequest", "request", "trusted"]
    const authorizationRecord = typeof nextRoute === "object" && nextRoute !== null && !Array.isArray(nextRoute)
      ? nextRoute as Record<string, unknown>
      : undefined
    if (!authorizationRecord || Object.keys(authorizationRecord).length !== authorizationKeys.length ||
      authorizationKeys.some((key) => !Object.hasOwn(authorizationRecord, key)) ||
      ["providerRequest", "request", "trusted"].some((key) => {
        const field = authorizationRecord[key]
        return typeof field !== "object" || field === null || Array.isArray(field)
      })) {
      throw new Error("HostKernel returned an invalid BYO search authorization projection")
    }
    if (typeof value.cascadeRef !== "string" || !/^search_cascade_[a-f0-9]{64}$/.test(value.cascadeRef) ||
      typeof value.cascadeDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(value.cascadeDigest) ||
      typeof value.routePlanDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(value.routePlanDigest) ||
      !Number.isSafeInteger(value.routeIndex) || (value.routeIndex as number) < 0 || (value.routeIndex as number) > 9 ||
      value.selectedProvider !== undefined || value.body !== undefined || value.receiptRef !== undefined ||
      value.managedAttempt !== undefined || value.attemptScopeTransition !== undefined ||
      attempts.some((item) => item.status === "SUCCEEDED" || item.status === "UNKNOWN")) {
      throw new Error("HostKernel returned an invalid BYO web-search continuation")
    }
    cascade = {
      cascadeRef: value.cascadeRef,
      cascadeDigest: value.cascadeDigest,
      routePlanDigest: value.routePlanDigest,
      routeIndex: value.routeIndex as number,
      nextRoute: authorizationRecord,
    }
  } else if (["cascadeRef", "cascadeDigest", "routeIndex", "nextRoute"].some((key) => value[key] !== undefined)) {
    throw new Error("HostKernel returned orphaned BYO web-search continuation fields")
  }
  let managedAttempt: ManagedAttemptScopeV1 | undefined
  let attemptScopeTransition: "effect_receipt" | undefined
  if (value.managedAttempt !== undefined && value.managedAttempt !== null) {
    if (value.attemptScopeTransition !== "effect_receipt") throw new Error("HostKernel returned an invalid managed web-search receipt transition")
    try {
      managedAttempt = managedAttemptScopeToWire(value.managedAttempt as ManagedAttemptScopeV1)
    } catch {
      throw new Error("HostKernel returned an invalid managed web-search scope")
    }
    attemptScopeTransition = "effect_receipt"
  } else if (value.attemptScopeTransition !== undefined) {
    throw new Error("HostKernel returned an orphaned managed web-search transition")
  }
  return {
    status: value.status,
    ...(selectedProvider ? { selectedProvider: selectedProvider as SearchRouteID } : {}),
    ...(value.body !== undefined && value.body !== null ? { body: value.body } : {}),
    attempts,
    ...(typeof routePlanDigest === "string" ? { routePlanDigest } : {}),
    ...cascade,
    ...(typeof value.receiptRef === "string" ? { receiptRef: value.receiptRef } : {}),
    ...(managedAttempt ? { managedAttempt, attemptScopeTransition } : {}),
  }
}

/** Enforce a second Core-side bound before any provider body is retained or
 * projected to the model. HostKernel is the primary framing boundary; this
 * rejects malformed/future transports that return an oversized nested value. */
export function assertBoundedSearchBody(root: unknown) {
  const maxNodes = 20_000
  const maxDepth = 24
  const maxStringBytes = 2 * 1024 * 1024
  const maxTotalBytes = 4 * 1024 * 1024
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let bytes = 0
  while (stack.length) {
    const current = stack.pop()!
    if (++nodes > maxNodes || current.depth > maxDepth) throw new Error("HostKernel web-search body exceeds structural bounds")
    if (typeof current.value === "string") {
      const size = new TextEncoder().encode(current.value).byteLength
      if (size > maxStringBytes) throw new Error("HostKernel web-search body contains an oversized string")
      bytes += size
    } else if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new Error("HostKernel web-search body contains a non-finite number")
      bytes += 8
    } else if (typeof current.value === "boolean") {
      bytes += 1
    } else if (current.value === null || current.value === undefined) {
      bytes += 1
    } else if (typeof current.value === "object") {
      if (seen.has(current.value)) throw new Error("HostKernel web-search body contains a cycle")
      seen.add(current.value)
      if (Array.isArray(current.value)) {
        bytes += 4
        for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 })
      } else {
        const entries = Object.entries(current.value)
        bytes += 4
        for (const [key, child] of entries) {
          bytes += new TextEncoder().encode(key).byteLength
          stack.push({ value: child, depth: current.depth + 1 })
        }
      }
    } else {
      throw new Error("HostKernel web-search body contains an unsupported value")
    }
    if (bytes > maxTotalBytes) throw new Error("HostKernel web-search body exceeds its aggregate byte bound")
  }
}

/** Production bridge: no provider SDK or direct fetch is available in Core. */
const guardedLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const supervisor = yield* SessionSupervisor.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    return Service.of(make({
      // Route-specific release gates control plan admission. The operation
      // still checks HostKernel feature negotiation before any dispatch.
      ready: true,
      supportedProviders: [
        "exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless",
        "brave", "exa", "youcom", "tavily", "firecrawl", "parallel",
      ],
      credentialRefs: async () => Effect.runPromise(auth.searchCredentialRefs()),
      workspace: () => "",
      authorizeSearchSecretUse: async (input) => {
        if (!searchRouteRuntimeReady(input.routeKey)) {
          throw new Error("Search credential authorization is unavailable until the Guarded cascade is released")
        }
        const cascadeReady = await Effect.runPromise(supervisor.hostFeatureEnabled(WEB_SEARCH_CASCADE_FEATURE))
        const effectsReady = await Effect.runPromise(supervisor.hostFeatureEnabled("effects.v2"))
        if (!cascadeReady || !effectsReady) {
          throw new Error("HostKernel did not negotiate guarded web-search cascade authorization")
        }
        const leasePins = input.lease as EffectLease & { readonly challengeID?: string; readonly locationID?: string }
        const challengeID = input.challenge.challengeID
        const locationID = input.challenge.approval?.locationID ?? leasePins.locationID
        if (!challengeID || !locationID || input.lease.effectID !== input.challenge.effectID ||
          !input.lease.capabilityLeaseDigest) {
          throw new Error("Search credential authorization requires the exact Guard challenge and lease")
        }
        const request = supervisor.requestHostKernel("execution.v1", "authorize_search_secret_use", {
          sessionID: input.scope.sessionID,
          effectID: input.lease.effectID,
          challengeID,
          locationID,
          capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
          routeKey: input.routeKey,
          attempt: input.attempt,
          ...(input.scope.directAttempt ? { directAttempt: input.scope.directAttempt } : {}),
          ...(input.scope.managedAttempt ? { managedAttempt: input.scope.managedAttempt } : {}),
        }, { cancelOnInterrupt: true })
        return input.signal
          ? Effect.runPromise(request, { signal: input.signal })
          : Effect.runPromise(request)
      },
      executeSearchCascade: async (input) => {
        const cascadeReady = await Effect.runPromise(supervisor.hostFeatureEnabled(WEB_SEARCH_CASCADE_FEATURE))
        const effectsReady = await Effect.runPromise(supervisor.hostFeatureEnabled("effects.v2"))
        if (!cascadeReady || !effectsReady) {
          throw new Error("HostKernel did not negotiate guarded web-search cascade dispatch")
        }
        if (!input.lease) throw new Error("HostKernel web-search execution requires its one-use Guard lease")
        const leasePins = input.lease as EffectLease & { readonly challengeID?: string; readonly locationID?: string }
        const challengeID = input.challenge?.challengeID ?? leasePins.challengeID
        const locationID = input.challenge?.approval?.locationID ?? leasePins.locationID
        const body = {
          ...webSearchCascadeRequestV1({
            sessionID: input.sessionID,
            effectID: input.lease.effectID,
            capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
            query: input.query,
            limit: input.limit,
            ...(input.domains === undefined ? {} : { domains: input.domains }),
            routes: input.routes,
            ...(input.credentialRefsByRoute?.length ? { credentialRefsByRoute: input.credentialRefsByRoute } : {}),
          }),
          ...(challengeID ? { challengeID } : {}),
          ...(locationID ? { locationID } : {}),
          ...(input.directAttempt ? { directAttempt: input.directAttempt } : {}),
          ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
        }
        const request = supervisor.requestHostKernel("execution.v1", "execute_search_cascade", body, { cancelOnInterrupt: true })
        let response: Readonly<Record<string, unknown>> | undefined
        try {
          response = input.signal
            ? await Effect.runPromise(request, { signal: input.signal })
            : await Effect.runPromise(request)
        } catch (error) {
          // Feature negotiation is checked before HostKernel enters the route
          // operation. Other typed errors can occur after durable intent or
          // provider dispatch (including receipt persistence/response parsing),
          // so they must go through exact-pin reconciliation.
          if (error instanceof SessionSupervisorError && error.hostCode === "feature_not_negotiated") {
            throw new SearchRuntimeError("HostKernel denied web search before provider dispatch.", [], "NOT_DISPATCHED")
          }
          const challenge = input.challenge
          const approval = challenge?.approval
          const routePlanDigest = approval?.consent.routePlanDigest
          const locationID = approval?.locationID ?? leasePins.locationID
          // Reconcile only with HostKernel-minted pins from the exact challenge
          // and consumed lease. Missing pins leave the result UNKNOWN; Core must
          // never reconstruct authority from model arguments or retry dispatch.
          if (
            challenge && approval && locationID &&
            /^blake3:[0-9a-f]{64}$/.test(approval.inputDigest) &&
            typeof routePlanDigest === "string" && /^blake3:[0-9a-f]{64}$/.test(routePlanDigest) &&
            input.lease.capabilityLeaseDigest
          ) {
            try {
              const reconciled = await Effect.runPromise(supervisor.requestHostKernel(
                "execution.v1",
                "inspect_search_cascade",
                {
                  sessionID: input.sessionID,
                  effectID: input.lease.effectID,
                  challengeID: challenge.challengeID,
                  locationID,
                  capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
                  approvedArgumentsDigest: approval.inputDigest,
                  routePlanDigest,
                  ...(input.domains === undefined ? {} : { domains: input.domains }),
                  ...(input.directAttempt ? { directAttempt: input.directAttempt } : {}),
                  ...(input.managedAttempt ? { managedAttempt: input.managedAttempt } : {}),
                },
              ))
              // Continue through the same WAITING_SECRET loop below so a
              // recovered prepared cursor follows the original ordered route
              // plan instead of being surfaced as a terminal UNKNOWN result.
              response = reconciled
            } catch {
              // A missing or conflicting durable row cannot authorize replay.
              // Preserve UNKNOWN so the caller stops the rest of the batch.
            }
          }
          if (response === undefined) {
            throw new SearchRuntimeError(
              "Search dispatch outcome is unknown; no route was retried.",
              [],
              "UNKNOWN",
              undefined,
              typeof routePlanDigest === "string" && /^blake3:[0-9a-f]{64}$/.test(routePlanDigest) ? routePlanDigest : undefined,
            )
          }
        }
        if (response === undefined) {
          throw new SearchRuntimeError(
            "Search dispatch outcome is unknown; no route was retried.",
            [],
            "UNKNOWN",
          )
        }
        let cascade = parseAndValidateCascadeResponse(
          response,
          input,
          input.challenge?.approval?.consent.routePlanDigest,
        )
        let continuationCount = 0
        while (cascade.status === "WAITING_SECRET") {
          if (input.signal?.aborted) {
            // A resolver may return an already prepared continuation after an
            // interrupted RPC. Cancellation fences delivery too: Core must not
            // begin a new SecretBroker send once the owning request is aborted.
            try {
              await Effect.runPromise(supervisor.requestHostKernel(
                "execution.v1",
                "cancel_search_cascade",
                {
                  cascadeRef: cascade.cascadeRef,
                  cascadeDigest: cascade.cascadeDigest,
                  sessionID: input.sessionID,
                  effectID: input.lease.effectID,
                  challengeID,
                  locationID,
                  capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
                  ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
                  ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
                },
              ))
            } catch {
              // Cancellation fencing is best-effort from Core; durable HostKernel
              // recovery remains UNKNOWN if the private cancel RPC is unavailable.
            }
            throw new SearchRuntimeError(
              "The web-search cascade was cancelled before its next guarded route; no provider request was sent.",
              attemptProjection(cascade.attempts),
              "UNKNOWN",
              undefined,
              cascade.routePlanDigest,
            )
          }
          if (++continuationCount > input.routes.length || !cascade.nextRoute ||
            !cascade.cascadeRef || !cascade.cascadeDigest || !cascade.routePlanDigest ||
            cascade.routeIndex === undefined || !challengeID || !locationID ||
            (input.directAttempt === undefined) === (input.managedAttempt === undefined)) {
            throw new SearchRuntimeError(
              "HostKernel requested a BYO continuation without a complete authenticated scope; outcome remains UNKNOWN.",
              attemptProjection(cascade.attempts),
              "UNKNOWN",
              undefined,
              cascade.routePlanDigest,
            )
          }
          let dispatched: {
            status: number | null
            retryAfterMs: number | null
            body: Uint8Array
            bodyDigest: string | null
            bodyBytes: number
            complete: boolean
            receipt: {
              attemptRef: string
              attemptDigest: string
              routeKey: string
              attempt: number
              outcome: "NOT_DISPATCHED" | "SUCCEEDED" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "EMPTY"
              httpStatus: number | null
              retryAfterMs: number | null
              resultCount: number | null
              bodyDigest: string | null
              bodyBytes: number
              responseComplete: boolean
              receiptDigest: string
              status: "SETTLED"
            }
          }
          try {
            const authRequest = auth.dispatchAuthorizedSearchRequest({
              authorization: cascade.nextRoute,
              scope: {
                sessionID: input.sessionID,
                locationID,
                effectID: input.lease.effectID,
                challengeID,
                capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
                cascadeRef: cascade.cascadeRef,
                cascadeDigest: cascade.cascadeDigest,
                ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
                ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
              },
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
            dispatched = input.signal
              ? await Effect.runPromise(authRequest, { signal: input.signal })
              : await Effect.runPromise(authRequest)
          } catch {
            // Auth durably records UNKNOWN whenever begin/send/settle cannot be
            // reconciled. Never retry a provider dispatch from Core.
            throw new SearchRuntimeError(
              "The BYO search route outcome is UNKNOWN; no route was retried.",
              attemptProjection(cascade.attempts),
              "UNKNOWN",
              undefined,
              cascade.routePlanDigest,
            )
          }
          const receipt = dispatched.receipt
          const knownPreDispatchFailure = receipt.outcome === "NOT_DISPATCHED"
          const responseMatchesReceipt = knownPreDispatchFailure
            ? dispatched.status === null && !dispatched.complete && !receipt.responseComplete &&
              receipt.httpStatus === null && receipt.retryAfterMs === null && receipt.resultCount === null &&
              receipt.bodyDigest === null && receipt.bodyBytes === 0 && dispatched.body.byteLength === 0 &&
              dispatched.bodyBytes === 0 && dispatched.bodyDigest === null
            : dispatched.status !== null && dispatched.complete && receipt.responseComplete &&
              receipt.httpStatus === dispatched.status && receipt.retryAfterMs === dispatched.retryAfterMs &&
              dispatched.body.byteLength === receipt.bodyBytes && dispatched.bodyDigest === receipt.bodyDigest
          if (receipt.status !== "SETTLED" || receipt.routeKey !== cascade.nextRoute.routeKey ||
            receipt.attempt !== cascade.nextRoute.attempt || !responseMatchesReceipt) {
            throw new SearchRuntimeError(
              "The BYO search receipt did not match its bounded provider response; outcome remains UNKNOWN.",
              attemptProjection(cascade.attempts),
              "UNKNOWN",
              undefined,
              cascade.routePlanDigest,
            )
          }
          const resumeBody = {
            schemaVersion: 1,
            cascadeRef: cascade.cascadeRef,
            cascadeDigest: cascade.cascadeDigest,
            routePlanDigest: cascade.routePlanDigest,
            routeIndex: cascade.routeIndex,
            query: input.query,
            limit: input.limit,
            ...(input.domains === undefined ? {} : { domains: input.domains }),
            sessionID: input.sessionID,
            effectID: input.lease.effectID,
            challengeID,
            locationID,
            capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
            settledAttemptRef: receipt.attemptRef,
            settledAttemptDigest: receipt.attemptDigest,
            routeKey: receipt.routeKey,
            attempt: receipt.attempt,
            receiptDigest: receipt.receiptDigest,
            outcome: receipt.outcome,
            httpStatus: receipt.httpStatus,
            retryAfterMs: receipt.retryAfterMs,
            bodyDigest: receipt.bodyDigest,
            bodyBytes: receipt.bodyBytes,
            responseComplete: receipt.responseComplete,
            responseBody: dispatched.body,
            ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
            ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
          }
          let resumed: Readonly<Record<string, unknown>>
          try {
            const request = supervisor.requestHostKernel(
              "execution.v1",
              "resume_search_cascade",
              resumeBody,
              { cancelOnInterrupt: true },
            )
            resumed = input.signal
              ? await Effect.runPromise(request, { signal: input.signal })
              : await Effect.runPromise(request)
          } catch {
            // The durable route receipt already exists. Resolve only from the
            // exact authenticated Rust cursor; this endpoint cannot dispatch or
            // return a persisted result body. Never resend the provider route.
            try {
              const recovered = await Effect.runPromise(supervisor.requestHostKernel(
                "execution.v1",
                "inspect_search_cascade_continuation",
                {
                  cascadeRef: cascade.cascadeRef,
                  cascadeDigest: cascade.cascadeDigest,
                  routePlanDigest: cascade.routePlanDigest,
                  lastReceiptDigest: receipt.receiptDigest,
                  query: input.query,
                  limit: input.limit,
                  ...(input.domains === undefined ? {} : { domains: input.domains }),
                  sessionID: input.sessionID,
                  effectID: input.lease.effectID,
                  challengeID,
                  locationID,
                  capabilityLeaseDigest: input.lease.capabilityLeaseDigest,
                  ...(input.directAttempt === undefined ? {} : { directAttempt: input.directAttempt }),
                  ...(input.managedAttempt === undefined ? {} : { managedAttempt: input.managedAttempt }),
                },
              ))
              resumed = recovered
            } catch {
              throw new SearchRuntimeError(
                "The settled BYO search route could not be reconciled with HostKernel; no provider retry was attempted.",
                attemptProjection(cascade.attempts),
                "UNKNOWN",
                receipt.receiptDigest,
                cascade.routePlanDigest,
              )
            }
          }
          const resumedCascade = parseAndValidateCascadeResponse(resumed, input, cascade.routePlanDigest)
          cascade = validateCascadeContinuationIdentity(cascade, resumedCascade)
        }
        return cascade
      },
    }, config))
  }),
)

export const node = LayerNode.make({ service: Service, layer: guardedLayer, deps: [SessionSupervisor.node, Auth.node, Config.node] })

/** Injectable transport seam for isolated contracts; production uses the HostKernel node above. */
export function layerFor(capability: WebSearchGuardedCapability) {
  return Layer.effect(Service, Effect.map(Config.Service, (config) => Service.of(make(capability, config))))
}

function attemptProjection(attempts: readonly SearchCascadeAttemptReceiptV1[]): SearchRouteAttempt[] {
  return attempts.slice(0, 20).map((item) => {
    const keyless = item.provider.endsWith("_keyless") || item.provider === "youcom_free"
    return {
      provider: item.provider,
      routeId: item.routeId,
      routeIndex: item.routeIndex,
      attempt: Math.min(2, Math.max(1, Math.floor(item.attempt))),
      status: item.status === "SUCCEEDED" ? "succeeded"
        : item.status === "RATE_LIMITED" ? "rate_limited"
          : item.status === "EMPTY" ? "empty"
          : item.status === "NOT_DISPATCHED" ? "not_dispatched"
          : item.status === "UNKNOWN" ? "unknown"
            : item.status === "RETRYABLE_FAILURE" ? "retryable_failure"
            : "failed",
      ...(item.status === "NOT_DISPATCHED" ? { notDispatchedFailure: item.notDispatchedFailure! } : {}),
      costClass: keyless ? "FREE" : "UNKNOWN",
      authSource: keyless ? "none" : "secret_broker",
      ...(Number.isSafeInteger(item.httpStatus) && item.httpStatus! >= 100 && item.httpStatus! <= 599 ? { statusCode: item.httpStatus } : {}),
      ...(item.retryAfterMs !== undefined ? { retryAfterMs: Math.min(60_000, Math.max(0, item.retryAfterMs)) } : {}),
      ...(item.receiptRef ? { receiptRef: item.receiptRef.slice(0, 256) } : {}),
      observedAt: typeof item.observedAt === "string" ? item.observedAt.slice(0, 64) : "",
      ...(item.status === "UNKNOWN"
        ? { reason: "dispatch outcome unknown; cascade stopped" }
        : item.status === "EMPTY"
          ? { reason: "provider returned no results" }
        : item.status === "NOT_DISPATCHED"
          ? { reason: item.notDispatchedFailure === "cancelled"
            ? "search cancelled before provider request was sent"
            : item.notDispatchedFailure === "timed_out"
              ? "connection timed out before provider request was sent"
              : "transport failed before provider request was sent" }
        : item.httpStatus === 429
          ? { reason: "provider rate limit" }
          : item.httpStatus === 401 || item.httpStatus === 403 || item.httpStatus === 407
            ? { reason: "provider authentication rejected" }
            : item.httpStatus
              ? { reason: `provider returned HTTP ${item.httpStatus}` }
              : item.status !== "SUCCEEDED" ? { reason: "provider request failed" } : {}),
    }
  })
}

/** Convert one host-owned aggregate cascade into the existing result contract. */
export function make(capability: WebSearchGuardedCapability, config: Config.Interface): Interface {
  const routeReady = (route: SearchRouteID) =>
    capability.ready && capability.supportedProviders.includes(route) &&
    (capability.runtimeReady?.[route] ?? searchRouteRuntimeReady(route))
  return {
    inspect(input) {
      return Effect.gen(function* () {
        const current = yield* config.get()
        const credentialRefs = yield* Effect.tryPromise({
          try: () => capability.credentialRefs(),
          catch: () => new Error("Search credential references are unavailable."),
        }).pipe(Effect.catch(() => Effect.succeed({} as SearchCredentialRefs)))
        const settings = normalizeSearchCascadeSettings(input.settings ?? current.websearch)
        // Inspection covers every locally supported route, including disabled
        // routes. Using the executable cascade plan here hid a saved BYO
        // SecretBroker reference whenever its route was disabled, making
        // Settings claim `configured=false` instead of `status=disabled`.
        // This projection is metadata-only: it does not authorize or dispatch.
        const routes = createSearchInspectionRoutes({
          supportedProviders: capability.supportedProviders,
          credentialRefs,
        })
        const cooldownUntil = yield* Effect.promise(() => Promise.all(settings.enabled.map(async (provider) => [
          provider,
          await processSearchCooldownStore.get({ workspace: input.workspace, provider }),
        ] as const)).then(Object.fromEntries))
        return inspectSearchProviders({
          settings,
          routes,
          attempts: yield* Effect.promise(() => processSearchAttemptStore.list({ workspace: input.workspace })),
          failures: yield* Effect.promise(() => processSearchAttemptStore.listFailures?.({ workspace: input.workspace }) ?? Promise.resolve([])),
          cooldownUntil,
          runtimeReady: Object.fromEntries(SEARCH_ROUTE_IDS.map((route) => [
            route,
            routeReady(route),
          ])),
        })
      })
    },
    prepareEffectArguments(modelArgs) {
      return Effect.gen(function* () {
        const current = yield* config.get()
        const credentialRefs = yield* Effect.tryPromise({
          try: () => capability.credentialRefs(),
          catch: () => new Error("SecretBroker route references are unavailable."),
        })
        return prepareSearchEffectArguments({
          modelArgs,
          settings: normalizeSearchCascadeSettings(current.websearch),
          supportedProviders: capability.supportedProviders.filter((route) =>
            routeReady(route)),
          runtimeReady: Object.fromEntries(SEARCH_ROUTE_IDS.map((route) => [route, routeReady(route)])),
          credentialRefs,
        })
      })
    },
    search(input) {
      return Effect.tryPromise({
        try: async () => {
          if (!capability.ready || input.execution.routes.some((route) =>
            !routeReady(route.routeKey))) {
            throw new Error("The prepared web-search route plan contains a route that has not passed its Guard/SecretBroker release gate.")
          }
          if (input.execution.routes.length === 0 || input.execution.routes.length > 10) {
            throw new Error("The prepared web-search route plan is invalid.")
          }
          const dispatchStartedAt = performance.now()
          const dispatchResponse = await capability.executeSearchCascade({
            ...input.scope,
            ...input.execution,
            ...(input.challenge ? { challenge: input.challenge } : {}),
            ...(input.lease ? { lease: input.lease } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
          const dispatchElapsedMs = Math.max(0, Math.ceil(performance.now() - dispatchStartedAt))
          const challengeRoutePlanDigest = input.challenge?.approval?.consent.routePlanDigest
          let response: SearchCascadeResponseV1
          try {
            response = validateCascadeResponseRoutes(dispatchResponse, input.execution)
          } catch {
            throw new SearchRuntimeError(
              "HostKernel returned invalid web-search evidence after dispatch; outcome remains UNKNOWN and no route was retried.",
              [],
              "UNKNOWN",
              dispatchResponse.receiptRef,
              dispatchResponse.routePlanDigest && dispatchResponse.routePlanDigest === challengeRoutePlanDigest
                ? dispatchResponse.routePlanDigest
                : challengeRoutePlanDigest,
            )
          }
          if (response.routePlanDigest && challengeRoutePlanDigest && response.routePlanDigest !== challengeRoutePlanDigest) {
            throw new SearchRuntimeError(
              "HostKernel route-plan digest differs from the exact approved consent pin; outcome remains UNKNOWN.",
              attemptProjection(response.attempts),
              "UNKNOWN",
              response.receiptRef,
              challengeRoutePlanDigest,
            )
          }
          if (input.scope.managedAttempt) {
            if (!input.managedAuthority) throw new Error("Managed web search has no live Attempt authority")
            const current = input.managedAuthority.currentScope()
            if (!sameManagedAttemptScope(current, input.scope.managedAttempt) ||
              response.attemptScopeTransition !== "effect_receipt" || !response.managedAttempt ||
              !isReceiptAdvancedManagedAttemptScope(current, response.managedAttempt)) {
              throw new Error("HostKernel returned a stale or incomplete managed web-search receipt")
            }
            input.managedAuthority.acceptRefreshedScope({
              previous: current,
              refreshed: response.managedAttempt,
              transition: "effect_receipt",
            })
          } else if (response.managedAttempt || response.attemptScopeTransition) {
            throw new Error("HostKernel returned a managed web-search receipt outside managed scope")
          }
          const attempts = attemptProjection(response.attempts)
          const workspace = input.scope.workspace || capability.workspace()
          for (const attempt of attempts) {
            await processSearchAttemptStore.record({ workspace, attempt })
            if (attempt.status === "rate_limited") {
              const delay = Math.min(60_000, Math.max(1_000, attempt.retryAfterMs ?? 60_000))
              await processSearchCooldownStore.set({ workspace, provider: attempt.provider, until: Date.now() + delay })
            }
          }
          if (response.status === "UNKNOWN") {
            throw new SearchRuntimeError("Search dispatch outcome is unknown; no route was retried.", attempts, "UNKNOWN", response.receiptRef, response.routePlanDigest ?? challengeRoutePlanDigest)
          }
          if (response.status === "FAILED") {
            throw new SearchRuntimeError("Web search stopped after a terminal provider HTTP 4xx response.", attempts, "FAILED", response.receiptRef, response.routePlanDigest)
          }
          if (response.status === "CANCELLED") {
            throw new SearchRuntimeError("Web search was cancelled after route admission; no later route was dispatched.", attempts, "CANCELLED", response.receiptRef, response.routePlanDigest)
          }
          if (response.status === "NOT_DISPATCHED") {
            const emptyDomainFilter = input.execution.domains?.length === 0
            const cancelled = response.attempts.at(-1)?.notDispatchedFailure === "cancelled"
            throw new SearchRuntimeError(
              cancelled
                ? "Web search was cancelled before the provider request was sent."
                : emptyDomainFilter
                ? "The explicit empty domain filter selected no search domains; no provider route was dispatched."
                : "The search request was rejected before any provider route was dispatched.",
              attempts,
              "NOT_DISPATCHED",
              undefined,
              response.routePlanDigest,
            )
          }
          if (response.status === "RECONCILED_RESULT_UNAVAILABLE") {
            throw new SearchRuntimeError("Search completed and its durable receipt was reconciled, but the result payload is unavailable; no route was retried.", attempts, "RESULT_UNAVAILABLE", response.receiptRef, response.routePlanDigest)
          }
          if (response.status === "NEEDS_APPROVAL") {
            throw new SearchRuntimeError("Web search requires Guard approval before any provider route can run.", attempts, "NOT_DISPATCHED", response.receiptRef, response.routePlanDigest ?? challengeRoutePlanDigest)
          }
          if (response.status === "WAITING_SECRET") {
            throw new SearchRuntimeError("The HostKernel search cascade is waiting for its guarded SecretBroker continuation; outcome remains UNKNOWN until resumed.", attempts, "UNKNOWN", undefined, response.routePlanDigest)
          }
          if (response.status !== "SUCCEEDED" || !response.selectedProvider) {
            throw new SearchRuntimeError("Web search exhausted its explicitly enabled routes.", attempts, "EXHAUSTED", response.receiptRef, response.routePlanDigest)
          }
          const results = decodeSuccessfulCascadeResults(response, input.execution.limit, attempts)
          const keyless = response.selectedProvider.endsWith("_keyless") || response.selectedProvider === "youcom_free"
          const result = {
            provider: response.selectedProvider,
            routePlanDigest: response.routePlanDigest!,
            results,
            routeClass: "DIRECT_SEARCH" as const,
            costClass: keyless ? "FREE" as const : "UNKNOWN" as const,
            authSource: keyless ? "none" as const : "secret_broker" as const,
            freshness: "unknown" as const,
            retrievedAt: new Date().toISOString(),
            latencyMs: dispatchElapsedMs,
            routeAttempts: attempts,
            truncated: searchProviderResponseTruncated(response.selectedProvider, response.body, input.execution.limit),
          }
          return { result, attempts }
        },
        catch: (error) => error instanceof Error ? error : new Error("Guarded web search failed."),
      })
    },
  }
}

export * as WebSearchRuntime from "./websearch-runtime"
