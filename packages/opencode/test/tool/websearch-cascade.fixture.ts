/** Test-only model of the retired callback executor. Production must dispatch
 * exclusively through WebSearchRuntime and HostKernel; this fixture keeps the
 * bounded retry-policy cases useful without leaving a callable product path. */
import {
  normalizeSearchCascadeSettings,
  SearchCascadeError,
  type SearchAttemptStore,
  type SearchCooldownStore,
  type SearchRoute,
  type SearchRouteAttempt,
  type SearchRouteID,
  type SearchRouteResult,
} from "../../src/tool/websearch-broker"

type CallbackSearchRoute = SearchRoute & {
  search(input: { query: string; numResults: number; signal?: AbortSignal }): Promise<SearchRouteResult>
}

const MAX_QUERY_LENGTH = 2_000
const MAX_RESULTS = 10
const DEFAULT_ROUTE_TIMEOUT_MS = 12_000
const MAX_ROUTE_TIMEOUT_MS = 30_000
const MAX_ROUTES = 10
const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504])
const AUTH_FAILURE_STATUS = new Set([401, 403, 407])

function aborted(signal: AbortSignal | undefined, error: unknown) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError")
}

function reason(error: unknown) {
  const status = statusCode(error)
  if (status === 429) return "provider rate limit"
  if (status !== undefined && AUTH_FAILURE_STATUS.has(status)) return "provider authentication rejected"
  if (status !== undefined) return `provider returned HTTP ${status}`
  return "provider request failed"
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
  return Math.min(value, 60_000)
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

function requestRoute(route: CallbackSearchRoute, input: { query: string; numResults: number; signal?: AbortSignal }, timeoutMs: number) {
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
  routes: CallbackSearchRoute[]
  signal?: AbortSignal
  routeTimeoutMs?: number
  cooldownStore?: SearchCooldownStore
  attemptStore?: SearchAttemptStore
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
  // This fake only models the route cascade. An explicitly listed enabled
  // route represents the consented trusted settings that production loads.
  const consentedRoutes = input.enabled ?? []
  const hasAnonymous = consentedRoutes.some((route) => route.endsWith("_keyless") || route === "youcom_free")
  const settings = normalizeSearchCascadeSettings({
    enabled: input.enabled,
    order: input.order,
    ...(hasAnonymous ? { querySharingConsent: "anonymous_free_v1" as const } : {}),
    byoConsents: consentedRoutes
      .filter((route) => !route.endsWith("_keyless") && route !== "youcom_free")
      .map((route) => ({ route, consent: "secret_broker_unknown_cost_v1" as const })),
  })
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
  const recordAttempt = async (attempt: SearchRouteAttempt) => {
    const observed = { ...attempt, observedAt: new Date(now()).toISOString() }
    attempts.push(observed)
    if (input.attemptStore && workspace) {
      await input.attemptStore.record({ workspace, attempt: observed })
    }
  }

  for (const [provider, until] of cooldownUntil) {
    await recordAttempt({
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
          await recordAttempt({ provider: route.id, attempt: pass, status: "empty", reason: "provider returned no usable results" })
          if (pass === 1) retryRoutes.add(route.id)
          continue
        }
        await recordAttempt({ provider: route.id, attempt: pass, status: "succeeded" })
        return {
          result: {
            ...value,
            results,
            provider: route.id,
            routeClass: route.routeClass,
            costClass: route.costClass,
            authSource: route.authSource,
            routeAttempts: attempts.slice(0, MAX_ROUTES * 2),
          },
          attempts,
        }
      } catch (error) {
        if (aborted(input.signal, error)) throw error
        const status = statusCode(error)
        await recordAttempt({
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
          const until = now() + Math.min(60_000, Math.max(1_000, delay))
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
        await recordAttempt({ provider: route.id, attempt: 0, status: "rate_limited", reason: "provider cooldown is active", statusCode: 429, retryAfterMs: until - now() })
      }
    }
  }
  throw new SearchCascadeError(attempts)
}


