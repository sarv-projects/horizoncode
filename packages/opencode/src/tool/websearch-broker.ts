/** HorizonCode's bounded ordered provider cascade for `websearch`. */

import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

export const SEARCH_ROUTE_IDS = ConfigV1.WEB_SEARCH_ROUTE_IDS
export type SearchRouteID = (typeof SEARCH_ROUTE_IDS)[number]

// Parent-controlled release seam. Keep false until the integrated P1 Guard and
// ExecutionHost outbound-network contract has passed its adversarial matrix.
export const WEB_SEARCH_GUARD_READY = false
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
  /** Wall-clock duration reported by the adapter, never inferred from model text. */
  latencyMs?: number
  /** True when the adapter omitted results or content to stay within its bound. */
  truncated?: boolean
}

export interface SearchRoute {
  id: SearchRouteID
  label: string
  routeClass: SearchRouteClass
  costClass: SearchCostClass
  authSource: SearchAuthSource
  configured: boolean
  search(input: { query: string; numResults: number; signal?: AbortSignal }): Promise<SearchRouteResult>
}

export interface SearchRouteAttempt {
  provider: SearchRouteID
  attempt: number
  status: "succeeded" | "failed" | "rate_limited" | "empty"
  reason?: string
  statusCode?: number
  retryAfterMs?: number
}

export interface SearchProviderStatus {
  provider: SearchRouteID
  routeClass: SearchRouteClass
  costClass: SearchCostClass
  authSource: SearchAuthSource
  enabled: boolean
  configured: boolean
  status: "disabled" | "unconfigured" | "ready" | "succeeded" | "failed" | "rate_limited" | "empty"
  lastError?: string
  lastStatusCode?: number
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

/** Suitable only for a single server process. Multi-process deployments must
 * inject a shared implementation of SearchCooldownStore. */
export function createProcessSearchCooldownStore(now: () => number = Date.now): SearchCooldownStore {
  const values = new Map<string, number>()
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
      values.set(key(input.workspace, input.provider), input.until)
    },
  }
}

export interface SearchCascadeSettings {
  enabled?: SearchRouteID[]
  order?: SearchRouteID[]
}

export const DEFAULT_SEARCH_CASCADE_SETTINGS: Readonly<Required<SearchCascadeSettings>> = {
  enabled: ["exa_keyless", "youcom_free", "tavily_keyless", "firecrawl_keyless", "parallel_keyless"],
  order: ["exa_keyless", "youcom_free", "tavily_keyless", "firecrawl_keyless", "parallel_keyless", "brave", "exa"],
}

const MAX_ROUTES = SEARCH_ROUTE_IDS.length
const MAX_QUERY_LENGTH = 2_000
const MAX_RESULTS = 10
const MAX_REASON_LENGTH = 240
const DEFAULT_ROUTE_TIMEOUT_MS = 12_000
const MAX_ROUTE_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504])
// Authentication failures are route-local: another explicitly enabled route
// may have a different credential source. Never retry the bad credential on
// the same route during this query.
const AUTH_FAILURE_STATUS = new Set([401, 403, 407])

export function normalizeSearchCascadeSettings(input?: SearchCascadeSettings) {
  const enabled = input?.enabled ?? DEFAULT_SEARCH_CASCADE_SETTINGS.enabled
  const order = input?.order ?? DEFAULT_SEARCH_CASCADE_SETTINGS.order
  const uniqueEnabled = [...new Set(enabled)].filter((id): id is SearchRouteID => SEARCH_ROUTE_IDS.includes(id)).slice(0, MAX_ROUTES)
  const uniqueOrder = [...new Set(order)].filter((id): id is SearchRouteID => SEARCH_ROUTE_IDS.includes(id))
  const cascade = [...uniqueOrder.filter((id) => uniqueEnabled.includes(id)), ...uniqueEnabled.filter((id) => !uniqueOrder.includes(id))]
  return { enabled: uniqueEnabled, order: cascade }
}

/**
 * Read-only provider inspection derived from explicit settings, available
 * adapters, and the current/last cascade attempts. It performs no I/O.
 */
export function inspectSearchProviders(input: {
  settings?: SearchCascadeSettings
  routes: SearchRoute[]
  attempts?: SearchRouteAttempt[]
  cooldownUntil?: Partial<Record<SearchRouteID, number>>
  now?: number
}): SearchProviderStatus[] {
  const settings = normalizeSearchCascadeSettings(input.settings)
  const routes = new Map(input.routes.map((route) => [route.id, route]))
  const lastAttempt = new Map<SearchRouteID, SearchRouteAttempt>()
  for (const attempt of input.attempts ?? []) lastAttempt.set(attempt.provider, attempt)
  return SEARCH_ROUTE_IDS.map((provider) => {
    const route = routes.get(provider)
    const enabled = settings.enabled.includes(provider)
    const configured = !!route?.configured
    const attempt = lastAttempt.get(provider)
    const cooldown = input.cooldownUntil?.[provider]
    const status = !enabled
      ? "disabled"
      : !configured
        ? "unconfigured"
        : cooldown !== undefined && cooldown > (input.now ?? Date.now())
          ? "rate_limited"
        : attempt?.status ?? "ready"
    return {
      provider,
      routeClass: route?.routeClass ?? "DIRECT_SEARCH",
      costClass: route?.costClass ?? (provider.endsWith("_keyless") || provider === "youcom_free" ? "FREE" : "UNKNOWN"),
      authSource: route?.authSource ?? (provider.endsWith("_keyless") || provider === "youcom_free" ? "none" : "unknown"),
      enabled,
      configured,
      status,
      ...(attempt?.reason ? { lastError: reason(attempt.reason) } : {}),
      ...(attempt?.statusCode ? { lastStatusCode: attempt.statusCode } : {}),
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
  return normalizeSearchCascadeSettings({ enabled: routes, order })
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

export class SearchCascadeError extends Error {
  readonly code = "SEARCH_CASCADE_EXHAUSTED"

  constructor(readonly attempts: SearchRouteAttempt[]) {
    super(attempts.length ? formatSearchFailures(attempts) : "Web search has no enabled, configured routes.")
    this.name = "SearchCascadeError"
  }
}

function aborted(signal: AbortSignal | undefined, error: unknown) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError")
}

function reason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/((?:api[_ -]?key|token|authorization|x-subscription-token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .slice(0, MAX_REASON_LENGTH)
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return
  const value = Number(error.status)
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("retryAfterMs" in error)) return
  const value = Number(error.retryAfterMs)
  if (!Number.isFinite(value) || value < 0) return
  return Math.min(value, 60 * 60 * 1_000)
}

function shouldRetry(error: unknown) {
  const status = statusCode(error)
  // Retry only the explicitly transient client statuses (408/425). Other
  // client failures are request/configuration errors; authentication failures
  // still fall through to another explicitly enabled route, but never retry
  // the same credential on this route.
  if (status === 429) return false
  if (status !== undefined && status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) return false
  return status === undefined || RETRYABLE_STATUS.has(status)
}

function terminalClientFailure(status: number | undefined) {
  return status !== undefined
    && status >= 400
    && status < 500
    && status !== 429
    && !AUTH_FAILURE_STATUS.has(status)
    && !RETRYABLE_STATUS.has(status)
}

function requestRoute(route: SearchRoute, input: { query: string; numResults: number; signal?: AbortSignal }, timeoutMs: number) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  const request = new Promise<SearchRouteResult>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (timer) clearTimeout(timer)
      removeAbort?.()
      callback()
    }
    const onAbort = () => {
      controller.abort(input.signal?.reason)
      finish(() => reject(input.signal?.reason ?? new DOMException("Search cancelled", "AbortError")))
    }
    if (input.signal?.aborted) {
      onAbort()
      return
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    removeAbort = () => input.signal?.removeEventListener("abort", onAbort)
    timer = setTimeout(() => {
      controller.abort(new DOMException("Search provider timed out", "TimeoutError"))
      finish(() => reject(Object.assign(new Error("provider request timed out"), { status: 408 })))
    }, timeoutMs)
    Promise.resolve(route.search({ ...input, signal: controller.signal })).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
  return request
}

function formatSearchFailures(attempts: readonly SearchRouteAttempt[]) {
  return `Web search failed across enabled routes: ${attempts
    .filter((item) => item.status !== "succeeded")
    .map((item) => `${item.provider}${item.statusCode ? ` (${item.statusCode})` : ""}: ${item.reason ?? item.status}`)
    .join("; ")}`.slice(0, 1_024)
}

/**
 * Execute only enabled and configured routes, in the user-selected order.
 * Every enabled route gets one normal pass first. If that pass exhausts, one
 * bounded retry pass is made for transient transport/server or empty-result
 * failures. Rate limits are recorded and immediately fall through; callers
 * can honor Retry-After on the next query without blocking the interactive
 * turn.
 */
export async function runSearchCascade(input: {
  query: string
  numResults?: number
  enabled?: SearchRouteID[]
  order?: SearchRouteID[]
  routes: SearchRoute[]
  signal?: AbortSignal
  routeTimeoutMs?: number
  cooldownStore?: SearchCooldownStore
  /** Stable workspace identity resolved by the trusted server, never tool input. */
  workspace?: string
  /** User-selected session preference, resolved outside model/tool input. */
  sessionProvider?: SearchRouteID
  now?: () => number
  defaultRateLimitCooldownMs?: number
}) {
  const query = input.query.trim().slice(0, MAX_QUERY_LENGTH)
  if (!query) throw new Error("Search query is required.")
  const numResults = Math.min(MAX_RESULTS, Math.max(1, Math.floor(input.numResults ?? 8)))
  const settings = normalizeSearchCascadeSettings({ enabled: input.enabled, order: input.order })
  const timeoutMs = Math.min(MAX_ROUTE_TIMEOUT_MS, Math.max(1, Math.floor(input.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS)))
  const byId = new Map(input.routes.map((route) => [route.id, route]))
  const routeOrder = input.sessionProvider && settings.enabled.includes(input.sessionProvider)
    ? [input.sessionProvider, ...settings.order.filter((id) => id !== input.sessionProvider)]
    : settings.order
  const now = input.now ?? Date.now
  const workspace = input.workspace
  const cooldownUntil = new Map<SearchRouteID, number>()
  if (input.cooldownStore && workspace) {
    await Promise.all(routeOrder.map(async (id) => {
      const until = await input.cooldownStore!.get({ workspace, provider: id })
      if (until !== undefined && until > now()) cooldownUntil.set(id, until)
    }))
  }
  const configuredRoutes = routeOrder.map((id) => byId.get(id)).filter((route): route is SearchRoute => !!route?.configured)
  const routes = configuredRoutes.filter((route) => !cooldownUntil.has(route.id))
  const attempts: SearchRouteAttempt[] = []

  for (const [provider, until] of cooldownUntil) {
    attempts.push({
      provider,
      attempt: 0,
      status: "rate_limited",
      reason: "provider cooldown is active",
      statusCode: 429,
      retryAfterMs: Math.max(0, until - now()),
    })
  }

  const retryRoutes = new Set<SearchRouteID>()
  for (let pass = 1; pass <= 2; pass++) {
    const candidates = pass === 1 ? routes : routes.filter((route) => retryRoutes.has(route.id))
    if (candidates.length === 0) break
    for (const route of candidates) {
      input.signal?.throwIfAborted()
      try {
        const value = await requestRoute(route, { query, numResults, signal: input.signal }, timeoutMs)
        const results = value.results.slice(0, numResults).flatMap((item) => {
          if (typeof item.title !== "string") return []
          if (typeof item.url !== "string" || item.url.length > 2_048) return []
          try {
            const url = new URL(item.url)
            if (url.protocol !== "http:" && url.protocol !== "https:") return []
          } catch {
            return []
          }
          return [{
            title: item.title.slice(0, 240),
            url: item.url,
            ...(item.snippet ? { snippet: item.snippet.slice(0, 1_200) } : {}),
          }]
        })
        if (results.length === 0) {
          attempts.push({ provider: route.id, attempt: pass, status: "empty", reason: "provider returned no usable results" })
          if (pass === 1) retryRoutes.add(route.id)
          continue
        }
        attempts.push({ provider: route.id, attempt: pass, status: "succeeded" })
        return {
          result: {
            ...value,
            results,
            provider: route.id,
            routeClass: route.routeClass,
            costClass: route.costClass,
            authSource: route.authSource,
          },
          attempts,
        }
      } catch (error) {
        if (aborted(input.signal, error)) throw error
        const status = statusCode(error)
        attempts.push({
          provider: route.id,
          attempt: pass,
          status: status === 429 ? "rate_limited" : "failed",
          reason: reason(error),
          ...(status ? { statusCode: status } : {}),
          ...(status === 429 && retryAfterMs(error) !== undefined ? { retryAfterMs: retryAfterMs(error) } : {}),
        })
        // Authentication failures are recorded for this route, then may
        // continue only through the remaining explicitly enabled routes.
        // Other client errors are request/configuration failures and stop.
        if (terminalClientFailure(status)) {
          throw new SearchCascadeError(attempts)
        }
        if (status === 429 && input.cooldownStore && workspace) {
          const delay = retryAfterMs(error) ?? input.defaultRateLimitCooldownMs ?? 60_000
          const until = now() + Math.min(60 * 60 * 1_000, Math.max(1_000, delay))
          cooldownUntil.set(route.id, until)
          await input.cooldownStore.set({ workspace, provider: route.id, until })
        }
        if (pass === 1 && status !== 429 && !AUTH_FAILURE_STATUS.has(status ?? -1) && shouldRetry(error)) retryRoutes.add(route.id)
      }
    }
  }
  if (attempts.length === 0 && configuredRoutes.length > 0) {
    for (const route of configuredRoutes) {
      const until = cooldownUntil.get(route.id)
      if (until !== undefined) {
        attempts.push({ provider: route.id, attempt: 0, status: "rate_limited", reason: "provider cooldown is active", statusCode: 429, retryAfterMs: until - now() })
      }
    }
  }
  throw new SearchCascadeError(attempts)
}

export function formatSearchCascadeFailure(error: unknown) {
  if (error instanceof SearchCascadeError) return error.message
  return `Web search failed: ${reason(error)}`
}
