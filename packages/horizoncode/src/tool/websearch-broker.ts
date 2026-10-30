/** HorizonCode's bounded ordered provider cascade for `websearch`. */

import { ConfigV1 } from "@horizoncode/core/v1/config/config"

export const SEARCH_ROUTE_IDS = ConfigV1.WEB_SEARCH_ROUTE_IDS
export type SearchRouteID = (typeof SEARCH_ROUTE_IDS)[number]

// Independent release seams: the anonymous/free cascade needs P1 Guarded
// acceptance; authenticated routes additionally need P6 SecretBroker acceptance.
// Do not make keyless search wait for unrelated credentialed-route work.
//
// ANONYMOUS SEAM RELEASED (2026-10-29, gated): the built-in keyless routes are
// executable only through HostKernel, never from here. Core holds no socket and
// no credential for them: every dispatch is a fixed-host HTTPS request issued by
// http_execution::fixed_web_search_mcp_route (mcp.exa.ai, api.you.com,
// mcp.firecrawl.dev, search.parallel.ai) under a Guard challenge, a one-use
// aggregate lease, and a durable HTTP receipt journal. Route admission alone
// still exposes nothing -- the ToolRegistry gate ANDs this seam with the
// host-negotiated `execution.v1.web-search-cascade` and `effects.v2` features,
// which a host only advertises after its Guard/containment preflight passed.
// The switch is operator-owned (environment, not project config) so a repository
// cannot release its own network egress, and it defaults closed: an unreleased
// deployment keeps the previous fail-closed behaviour. Provider-backed (BYO)
// routes stay closed below; this constant grants no credentialed route.
export const WEB_SEARCH_ANONYMOUS_RUNTIME_READY =
  process.env.HORIZON_WEB_SEARCH_ANONYMOUS_RELEASE === "1"
export const WEB_SEARCH_BYO_RUNTIME_READY = false

/** Routes that need no credential and charge nothing. `duckduckgo` is the
 * default anonymous route even though its id carries no `_keyless` suffix; the
 * MCP `_keyless` endpoints stay later fallbacks that some networks refuse. */
export function isKeylessSearchRoute(route: SearchRouteID | string) {
  return route === "duckduckgo" || route === "youcom_free" || route.endsWith("_keyless")
}

export function searchRouteRuntimeReady(route: SearchRouteID) {
  return isKeylessSearchRoute(route)
    ? WEB_SEARCH_ANONYMOUS_RUNTIME_READY
    : WEB_SEARCH_BYO_RUNTIME_READY
}

export function hasEnabledSearchRouteReady(settings?: SearchCascadeSettings) {
  return normalizeSearchCascadeSettings(settings).enabled.some(searchRouteRuntimeReady)
}
export type SearchCostClass = "FREE" | "PAID" | "TRIAL" | "UNKNOWN"
export type SearchRouteClass = "DIRECT_SEARCH" | "GROUNDED_MODEL_SEARCH"
export type SearchAuthSource = "none" | "saved_credential" | "secret_broker" | "environment" | "model_provider" | "unknown"

export interface SearchResultItem {
  title: string
  url: string
  snippet?: string
}

export interface SearchRouteResult {
  results: SearchResultItem[]
  provider: SearchRouteID
  routeClass: SearchRouteClass
  costClass: SearchCostClass
  authSource: SearchAuthSource
  freshness: "current" | "unknown"
  retrievedAt: string
  /** Observed aggregate dispatch round-trip, including bounded route retries; not provider-server time. */
  latencyMs?: number
  /** True when the adapter omitted results or content to stay within its bound. */
  truncated?: boolean
  /** The ordered, bounded attempts for this query; no raw response bodies or credentials. */
  routeAttempts?: SearchRouteAttempt[]
}

export interface SearchRoute {
  id: SearchRouteID
  label: string
  routeClass: SearchRouteClass
  costClass: SearchCostClass
  authSource: SearchAuthSource
  configured: boolean
}

export interface SearchRouteAttempt {
  provider: SearchRouteID
  /** Fixed HostKernel route identity and zero-based index in the admitted plan. */
  routeId?: string
  routeIndex?: number
  attempt: number
  status: "succeeded" | "failed" | "rate_limited" | "retryable_failure" | "empty" | "not_dispatched" | "unknown"
  /** Host-owned reason for a durable zero-send receipt; never inferred from Fetch errors. */
  notDispatchedFailure?: "cancelled" | "timed_out" | "transport_failure"
  /** Configured route provenance; never inferred from provider output. */
  costClass?: SearchCostClass
  authSource?: SearchAuthSource
  reason?: string
  statusCode?: number
  retryAfterMs?: number
  observedAt?: string
  /** HostKernel-owned durable receipt identity; required for known outcomes, absent for UNKNOWN. */
  receiptRef?: string
}

export interface SearchProviderStatus {
  provider: SearchRouteID
  routeClass: SearchRouteClass
  costClass: SearchCostClass
  authSource: SearchAuthSource
  enabled: boolean
  configured: boolean
  status: "disabled" | "unconfigured" | "unavailable" | "ready" | "rate_limited"
  available: boolean
  /** Inspection never infers current provider health from local state. */
  providerHealth: "not_probed"
  stateSource: "process_local"
  /** Pricing and live route metadata have no current source in offline inspection. */
  freshness: "unknown"
  lastAttemptStatus?: SearchRouteAttempt["status"]
  lastFailureAt?: string
  unavailableReason?: string
  lastError?: string
  lastStatusCode?: number
  lastAttemptAt?: string
  retryAfterMs?: number
  cooldownUntil?: string
}

/**
 * Workspace-shared cooldown contract. Production composition must supply the
 * owning durable/shared store; the cascade never keeps provider-global state
 * in config or changes the user's route order.
 */
export interface SearchCooldownStore {
  get(input: { workspace: string; provider: SearchRouteID }): Promise<number | undefined>
  set(input: { workspace: string; provider: SearchRouteID; until: number }): Promise<void>
}

export interface SearchAttemptStore {
  list(input: { workspace: string }): Promise<SearchRouteAttempt[]>
  listFailures?(input: { workspace: string }): Promise<SearchRouteAttempt[]>
  record(input: { workspace: string; attempt: SearchRouteAttempt }): Promise<void>
}

/**
 * Process-local last-attempt projection. Production may replace this with a
 * durable workspace store; this implementation never stores queries, bodies,
 * URLs, credentials, or raw provider errors.
 */
export function createProcessSearchAttemptStore(maxWorkspaces = 64): SearchAttemptStore {
  const values = new Map<string, Map<SearchRouteID, SearchRouteAttempt>>()
  const failures = new Map<string, Map<SearchRouteID, SearchRouteAttempt>>()
  return {
    async list({ workspace }) {
      return [...(values.get(workspace)?.values() ?? [])].map((attempt) => ({ ...attempt }))
    },
    async listFailures({ workspace }) {
      return [...(failures.get(workspace)?.values() ?? [])].map((attempt) => ({ ...attempt }))
    },
    async record({ workspace, attempt }) {
      if (!workspace || workspace.length > 512) return
      if (!values.has(workspace) && values.size >= maxWorkspaces) {
        const oldest = values.keys().next().value
        if (oldest) {
          values.delete(oldest)
          failures.delete(oldest)
        }
      }
      let routes = values.get(workspace)
      if (!routes) {
        routes = new Map()
        values.set(workspace, routes)
      }
      const sanitized = {
        ...attempt,
        reason: attempt.reason ? reason(attempt.reason) : undefined,
      }
      routes.set(attempt.provider, sanitized)
      if (attempt.status !== "succeeded") {
        if (!failures.has(workspace)) failures.set(workspace, new Map())
        failures.get(workspace)!.set(attempt.provider, sanitized)
      }
    },
  }
}

export const processSearchCooldownStore = createProcessSearchCooldownStore()
export const processSearchAttemptStore = createProcessSearchAttemptStore()

/** Suitable only for a single server process. Multi-process deployments must
 * inject a shared implementation of SearchCooldownStore. */
export function createProcessSearchCooldownStore(now: () => number = Date.now): SearchCooldownStore {
  const values = new Map<string, number>()
  const maxEntries = 512
  const key = (workspace: string, provider: SearchRouteID) => `${workspace}\u0000${provider}`
  return {
    async get(input) {
      const id = key(input.workspace, input.provider)
      const until = values.get(id)
      if (until === undefined) return undefined
      if (until <= now()) {
        values.delete(id)
        return undefined
      }
      return until
    },
    async set(input) {
      if (!Number.isSafeInteger(input.until) || input.until <= now()) return
      const id = key(input.workspace, input.provider)
      if (!values.has(id) && values.size >= maxEntries) {
        const oldest = values.keys().next().value
        if (oldest) values.delete(oldest)
      }
      values.set(id, input.until)
    },
  }
}

export interface SearchCascadeSettings {
  /** First-use acknowledgement for the built-in anonymous/free cascade. */
  querySharingConsent?: "anonymous_free_v1"
  /** Per-route acknowledgement for authenticated routes with unknown possible charges. */
  byoConsents?: readonly { route: SearchRouteID; consent: "secret_broker_unknown_cost_v1" }[]
  enabled?: SearchRouteID[]
  order?: SearchRouteID[]
}

export const DEFAULT_ANONYMOUS_SEARCH_ROUTES = [
  "duckduckgo",
  "exa_keyless",
  "youcom_free",
  "firecrawl_keyless",
  "parallel_keyless",
] as const satisfies readonly SearchRouteID[]

export const DEFAULT_SEARCH_CASCADE_SETTINGS: Readonly<SearchCascadeSettings> = {
  // Consent is intentionally absent from defaults. The first explicit user
  // action in Settings records it before anonymous routes enter an executable plan.
  byoConsents: [],
  enabled: [],
  order: [...DEFAULT_ANONYMOUS_SEARCH_ROUTES, "brave", "exa", "youcom", "tavily", "firecrawl", "parallel"],
}

const MAX_ROUTES = SEARCH_ROUTE_IDS.length

/** Project errors to fixed status text; raw provider messages may contain
 * echoed queries, response bodies, request IDs, or credential material. */
function reason(value: string) {
  const normalized = value.trim().toLowerCase()
  if (/not[_ -]?dispatched|before (?:the )?provider request was sent/.test(normalized)) return "connection failed before provider request was sent"
  if (/\b(401|403|407)\b|auth/.test(normalized)) return "provider authentication rejected"
  if (/\b429\b|rate.?limit/.test(normalized)) return "provider rate limit"
  if (/empty|no results/.test(normalized)) return "provider returned no results"
  if (/unknown|uncertain/.test(normalized)) return "dispatch outcome unknown"
  const status = normalized.match(/\b(4\d\d|5\d\d)\b/)
  if (status) return `provider returned HTTP ${status[1]}`
  return "provider request failed"
}

export function normalizeSearchCascadeSettings(input?: SearchCascadeSettings) {
  const anonymousConsent = input?.querySharingConsent === "anonymous_free_v1"
  const byoConsents = [...new Set((input?.byoConsents ?? [])
    .filter((entry) => entry.consent === "secret_broker_unknown_cost_v1" &&
      (ConfigV1.WEB_SEARCH_BYO_ROUTE_IDS as readonly string[]).includes(entry.route))
    .map((entry) => entry.route))]
  const requestedEnabled = input?.enabled ?? (anonymousConsent ? [...DEFAULT_ANONYMOUS_SEARCH_ROUTES] : [])
  const order = input?.order ?? DEFAULT_SEARCH_CASCADE_SETTINGS.order
  const uniqueEnabled = [...new Set(requestedEnabled)]
    .filter((id): id is SearchRouteID => SEARCH_ROUTE_IDS.includes(id))
    .filter((id) => isKeylessSearchRoute(id)
      ? anonymousConsent
      : byoConsents.includes(id))
    .slice(0, MAX_ROUTES)
  const uniqueOrder = [...new Set(order)].filter((id): id is SearchRouteID => SEARCH_ROUTE_IDS.includes(id))
  // Keep the full supported preference order for Settings even before consent
  // or route enablement. Executable plans separately intersect this order with
  // the consented enabled set, so retaining disabled IDs grants no route.
  const cascade = [...uniqueOrder, ...uniqueEnabled.filter((id) => !uniqueOrder.includes(id))]
  return {
    querySharingConsent: anonymousConsent ? "anonymous_free_v1" as const : undefined,
    byoConsents: byoConsents.map((route) => ({ route, consent: "secret_broker_unknown_cost_v1" as const })),
    enabled: uniqueEnabled,
    order: cascade,
  }
}

/**
 * Read-only provider inspection derived from explicit settings, available
 * adapters, and the current/last cascade attempts. It performs no I/O.
 */
export function inspectSearchProviders(input: {
  settings?: SearchCascadeSettings
  routes: SearchRoute[]
  attempts?: SearchRouteAttempt[]
  failures?: SearchRouteAttempt[]
  cooldownUntil?: Partial<Record<SearchRouteID, number>>
  now?: number
  runtimeReady?: boolean | Partial<Record<SearchRouteID, boolean>>
}): SearchProviderStatus[] {
  const settings = normalizeSearchCascadeSettings(input.settings)
  const routes = new Map(input.routes.map((route) => [route.id, route]))
  const lastAttempt = new Map<SearchRouteID, SearchRouteAttempt>()
  const lastFailure = new Map<SearchRouteID, SearchRouteAttempt>()
  for (const attempt of input.attempts ?? []) lastAttempt.set(attempt.provider, attempt)
  for (const failure of input.failures ?? []) lastFailure.set(failure.provider, failure)
  return SEARCH_ROUTE_IDS.map((provider) => {
    const route = routes.get(provider)
    const enabled = settings.enabled.includes(provider)
    const configured = !!route?.configured
    const attempt = lastAttempt.get(provider)
    const failure = lastFailure.get(provider)
    const cooldown = input.cooldownUntil?.[provider]
    const runtimeReady = typeof input.runtimeReady === "boolean"
      ? input.runtimeReady
      : input.runtimeReady?.[provider] ?? false
    const status = !enabled
      ? "disabled"
      : !configured
        ? "unconfigured"
        : !runtimeReady
          ? "unavailable"
        : cooldown !== undefined && cooldown > (input.now ?? Date.now())
          ? "rate_limited"
        : "ready"
    return {
      provider,
      routeClass: route?.routeClass ?? "DIRECT_SEARCH",
      costClass: route?.costClass ?? (isKeylessSearchRoute(provider) ? "FREE" : "UNKNOWN"),
      authSource: route?.authSource ?? (isKeylessSearchRoute(provider) ? "none" : "secret_broker"),
      enabled,
      configured,
      status,
      available: enabled && configured && runtimeReady && !(cooldown !== undefined && cooldown > (input.now ?? Date.now())),
      providerHealth: "not_probed" as const,
      stateSource: "process_local" as const,
      freshness: "unknown" as const,
      ...(attempt ? { lastAttemptStatus: attempt.status } : {}),
      ...(!configured ? {
        unavailableReason: isKeylessSearchRoute(provider)
          ? "No Guarded route transport is currently available."
          : "No Guarded adapter and required SecretBroker reference are currently available.",
      } : {}),
      ...(configured && !runtimeReady ? { unavailableReason: isKeylessSearchRoute(provider)
        ? "Anonymous search dispatch is disabled pending P1 Guarded acceptance."
        : "Credentialed search dispatch is disabled pending P1 Guarded and P6 SecretBroker acceptance." } : {}),
      ...(failure?.reason ? { lastError: reason(failure.reason) } : {}),
      ...(failure?.statusCode ? { lastStatusCode: failure.statusCode } : {}),
      ...(failure?.observedAt ? { lastFailureAt: failure.observedAt } : {}),
      ...(attempt?.observedAt ? { lastAttemptAt: attempt.observedAt } : {}),
      ...(attempt?.retryAfterMs !== undefined ? { retryAfterMs: attempt.retryAfterMs } : {}),
      ...(cooldown !== undefined && cooldown > (input.now ?? Date.now())
        ? { cooldownUntil: new Date(cooldown).toISOString(), retryAfterMs: cooldown - (input.now ?? Date.now()) }
        : {}),
    }
  })
}

export function setSearchRouteEnabled(input: SearchCascadeSettings | undefined, id: SearchRouteID, enabled: boolean) {
  const current = normalizeSearchCascadeSettings(input)
  const routes = enabled ? [...current.enabled, id] : current.enabled.filter((value) => value !== id)
  const order = enabled ? [...current.order, id] : current.order.filter((value) => value !== id)
  return normalizeSearchCascadeSettings({
    ...(current.querySharingConsent ? { querySharingConsent: current.querySharingConsent } : {}),
    byoConsents: current.byoConsents,
    enabled: routes,
    order,
  })
}

export function moveSearchRoute(input: SearchCascadeSettings | undefined, id: SearchRouteID, delta: -1 | 1) {
  const current = normalizeSearchCascadeSettings(input)
  const index = current.order.indexOf(id)
  const next = index + delta
  if (index < 0 || next < 0 || next >= current.order.length) return current
  const order = [...current.order]
  ;[order[index], order[next]] = [order[next], order[index]]
  return { ...current, order }
}

function formatSearchFailures(attempts: readonly SearchRouteAttempt[]) {
  return `Web search failed across enabled routes: ${attempts
    .filter((item) => item.status !== "succeeded")
    .map((item) => `${item.provider}${item.statusCode ? ` (${item.statusCode})` : ""}: ${item.reason ?? item.status}`)
    .join("; ")}`.slice(0, 1_024)
}

export class SearchCascadeError extends Error {
  readonly code = "SEARCH_CASCADE_EXHAUSTED"

  constructor(readonly attempts: SearchRouteAttempt[]) {
    super(attempts.length ? formatSearchFailures(attempts) : "Web search has no enabled, configured routes.")
    this.name = "SearchCascadeError"
  }
}
