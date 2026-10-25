/**
 * P5 fixtures for §32.28 web-search acceptance (WS rows / V1-ADAPT-006).
 *
 * Builders only — no provider, network, credential or paid route is touched.
 * They model:
 *   - per-route provenance (route receipts with exact observedAt/receiptRef)
 *   - the direct-search result projection (provider, source URL, retrieved time)
 *   - consent binding (anonymous first-use consent + per-route BYO consent)
 *
 * Every value is a pure in-memory shape used by `websearch-provenance.test.ts`
 * to prove the *contract* today; live dispatch stays behind the P1/P2/P6 gates.
 */

import type { SearchCascadeSettings, SearchRouteID } from "../../src/tool/websearch-broker"

export const PROVENANCE_ROUTE_PLAN_DIGEST = `blake3:${"b".repeat(64)}`
export const PROVENANCE_OBSERVED_AT = "2026-10-24T00:00:00.000Z"
export const PROVENANCE_RETRIEVED_AT = "2026-10-24T00:00:01.000Z"

export type RouteAttemptStatus =
  | "succeeded"
  | "failed"
  | "rate_limited"
  | "retryable_failure"
  | "empty"
  | "not_dispatched"
  | "unknown"

/** `Horizon.WebSearchV1.RouteAttemptV1` shape with honest receipt provenance. */
export function routeAttemptFixture(
  provider: string,
  routeIndex: number,
  status: RouteAttemptStatus,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: provider,
    routeId: `web.search.${provider}`,
    routeIndex,
    attempt: 1,
    status,
    ...(status === "not_dispatched" ? { notDispatchedFailure: "transport_failure" } : {}),
    observedAt: PROVENANCE_OBSERVED_AT,
    // A known outcome must carry a durable route receipt; an UNKNOWN attempt
    // must not claim one (removed by the caller for the UNKNOWN case).
    ...(status === "unknown" ? {} : { receiptRef: `route_receipt_${provider}_${routeIndex}` }),
    ...overrides,
  }
}

/** Successful direct-search result projection with bounded provenance. */
export function directSearchResultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestId: "call_websearch_1",
    providerId: "exa_keyless",
    routeClass: "direct_search",
    retrievedAt: PROVENANCE_RETRIEVED_AT,
    costClass: "free",
    authSource: "none",
    freshness: "current",
    latencyMs: 42,
    truncated: false,
    routePlanDigest: PROVENANCE_ROUTE_PLAN_DIGEST,
    routeAttempts: [routeAttemptFixture("exa_keyless", 0, "succeeded")],
    results: [
      {
        url: "https://example.test/docs",
        title: "Docs",
        snippet: "bounded snippet",
      },
      {
        url: "https://example.test/guide",
        title: "Guide",
      },
    ],
    ...overrides,
  }
}

export type ConsentBindingFixture = SearchCascadeSettings

/**
 * A consent scope as Settings records it: anonymous first-use consent gates the
 * free keyless routes, and each BYO route needs its own explicit consent plus
 * an opaque SecretBroker reference before it may join an executable plan.
 */
export function consentBindingFixture(input: {
  readonly anonymous?: boolean
  readonly enabled?: readonly SearchRouteID[]
  readonly byoConsents?: readonly { route: SearchRouteID; consent: "secret_broker_unknown_cost_v1" }[]
  readonly order?: readonly SearchRouteID[]
}): ConsentBindingFixture {
  const enabled = [...(input.enabled ?? [])]
  const byoConsents = (input.byoConsents ?? []).map((entry) => ({ ...entry }))
  return {
    ...(input.anonymous ? { querySharingConsent: "anonymous_free_v1" as const } : {}),
    byoConsents,
    enabled,
    order: [...(input.order ?? ["exa_keyless", "youcom_free", "firecrawl_keyless", "parallel_keyless", "brave", "exa"])],
  }
}
