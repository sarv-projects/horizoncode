/**
 * P5-owned §32.28 search acceptance rows (WS bullets / V1-ADAPT-006) that are
 * assertable *today* without a live P1/P2/P6 lifecycle:
 *
 *   - direct-search results carry provider, source URL and retrieved time;
 *   - per-route provenance: known outcomes carry a durable route receipt,
 *     UNKNOWN never claims one, not-dispatched carries its zero-send reason;
 *   - consent binding: enable = consent, and a gated route reports an honest
 *     unavailable reason instead of being reported ready.
 *
 * Everything here is a schema/plan/inspection contract over fixtures. No
 * provider, network, credential, paid route, helper or Git operation occurs,
 * and no readiness gate changes.
 */

import { expect, test } from "bun:test"
import { Schema } from "effect"
import { WebSearchV1 } from "@horizoncode/schema"
import {
  createSearchInspectionRoutes,
  createSearchRoutePlan,
} from "../../src/tool/websearch-adapters"
import {
  inspectSearchProviders,
  normalizeSearchCascadeSettings,
  SEARCH_ROUTE_IDS,
  type SearchRouteAttempt,
} from "../../src/tool/websearch-broker"
import { projectRouteAttempts } from "../../src/tool/websearch"
import * as mcpWebSearch from "../../src/tool/mcp-websearch"
import {
  consentBindingFixture,
  directSearchResultFixture,
  PROVENANCE_RETRIEVED_AT,
  routeAttemptFixture,
} from "./websearch-provenance.fixture"

const decodeResult = Schema.decodeUnknownSync(WebSearchV1.SearchResultV1)
const secretRef = {
  schemaVersion: 1,
  secretRef: "secret_route_reference_1",
  provider: "brave",
  authKind: "api_key",
} as never

function without(object: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const clone = { ...object }
  for (const key of keys) delete clone[key]
  return clone
}

test("the direct-search projection carries provider, source URL, and retrieved time", () => {
  const decoded = decodeResult(directSearchResultFixture())
  expect(decoded.providerId).toBe("exa_keyless")
  expect(decoded.routeClass).toBe("direct_search")
  expect(decoded.retrievedAt).toBe(PROVENANCE_RETRIEVED_AT)
  expect(decoded.results.map((item) => item.url)).toEqual([
    "https://example.test/docs",
    "https://example.test/guide",
  ])
  expect(decoded.routeAttempts.map((attempt) => attempt.receiptRef)).toEqual([
    "route_receipt_exa_keyless_0",
  ])

  // Provenance must be present, not merely plausible.
  expect(() => decodeResult(without(directSearchResultFixture(), "retrievedAt"))).toThrow()
  expect(() => decodeResult({ ...directSearchResultFixture(), retrievedAt: "" })).toThrow()
  expect(() => decodeResult(without(directSearchResultFixture(), "providerId"))).toThrow()
  expect(() => decodeResult({ ...directSearchResultFixture(), results: [{ title: "no url" }] })).toThrow()
  expect(() => decodeResult({ ...directSearchResultFixture(), results: [{ url: "", title: "empty" }] })).toThrow()
  expect(() => decodeResult(without(directSearchResultFixture(), "routePlanDigest"))).toThrow()
})

test("per-route provenance distinguishes known, unknown and not-dispatched outcomes", () => {
  // A known terminal outcome requires its durable route receipt.
  const succeeded = without(routeAttemptFixture("exa_keyless", 0, "succeeded"), "receiptRef")
  expect(() => decodeResult({
    ...directSearchResultFixture(),
    routeAttempts: [succeeded],
  })).toThrow("durable route receipt")

  // An UNKNOWN attempt may not invent or reuse a settled route receipt.
  const unknownWithReceipt = {
    ...routeAttemptFixture("youcom_free", 1, "unknown"),
    receiptRef: "route_receipt_exa_keyless_0",
  }
  expect(() => decodeResult({
    ...directSearchResultFixture(),
    routeAttempts: [unknownWithReceipt],
  })).toThrow("cannot claim a settled route receipt")

  // UNKNOWN without a receipt is accepted and stays UNKNOWN.
  const unknown = decodeResult({
    ...directSearchResultFixture(),
    routeAttempts: [routeAttemptFixture("youcom_free", 1, "unknown")],
  })
  expect(unknown.routeAttempts[0]).toMatchObject({ status: "unknown" })
  expect("receiptRef" in unknown.routeAttempts[0]!).toBe(false)

  // A not-dispatched row must carry its trusted zero-send reason.
  const notDispatched = without(
    routeAttemptFixture("exa_keyless", 0, "not_dispatched"),
    "notDispatchedFailure",
  )
  expect(() => decodeResult({
    ...directSearchResultFixture(),
    routeAttempts: [notDispatched],
  })).toThrow("zero-send reason")
  const dispatched = decodeResult({
    ...directSearchResultFixture(),
    routeAttempts: [routeAttemptFixture("exa_keyless", 0, "not_dispatched")],
  })
  expect(dispatched.routeAttempts[0]).toMatchObject({
    status: "not_dispatched",
    notDispatchedFailure: "transport_failure",
    receiptRef: "route_receipt_exa_keyless_0",
  })
})

// §32.28 "per-route auth/cost/retry provenance": the public wire projection
// must carry every provenance field for each outcome class, keep UNKNOWN
// receiptless, keep not-dispatched rows carrying their zero-send reason and
// durable receipt, and drop rows that lack their HostKernel identity pins.
test("the wire route-attempt projection is complete and schema-valid for every outcome", () => {
  const observedAt = "2026-10-20T00:00:00.000Z"
  const rows: SearchRouteAttempt[] = [
    { provider: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "succeeded", costClass: "FREE", authSource: "none", statusCode: 200, observedAt, receiptRef: "route_receipt_exa_keyless_0" },
    { provider: "brave", routeId: "web.search.brave", routeIndex: 1, attempt: 1, status: "failed", costClass: "UNKNOWN", authSource: "secret_broker", statusCode: 401, observedAt, receiptRef: "route_receipt_brave_1" },
    { provider: "brave", routeId: "web.search.brave", routeIndex: 1, attempt: 1, status: "rate_limited", costClass: "UNKNOWN", authSource: "secret_broker", statusCode: 429, retryAfterMs: 5_000, observedAt, receiptRef: "route_receipt_brave_2" },
    { provider: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "retryable_failure", costClass: "FREE", authSource: "none", statusCode: 503, observedAt, receiptRef: "route_receipt_exa_keyless_3" },
    { provider: "youcom_free", routeId: "web.search.youcom_free", routeIndex: 2, attempt: 2, status: "empty", costClass: "FREE", authSource: "none", statusCode: 200, observedAt, receiptRef: "route_receipt_youcom_free_4" },
    { provider: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "not_dispatched", notDispatchedFailure: "timed_out", costClass: "FREE", authSource: "none", observedAt, receiptRef: "route_receipt_exa_keyless_5" },
    { provider: "youcom_free", routeId: "web.search.youcom_free", routeIndex: 2, attempt: 1, status: "unknown", costClass: "FREE", authSource: "none", observedAt },
  ]

  const projected = projectRouteAttempts(rows)
  expect(projected).toEqual([
    { providerId: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "succeeded", costClass: "free", authSource: "none", reason: "provider returned HTTP 200", statusCode: 200, observedAt, receiptRef: "route_receipt_exa_keyless_0" },
    { providerId: "brave", routeId: "web.search.brave", routeIndex: 1, attempt: 1, status: "failed", costClass: "unknown", authSource: "secret_broker", reason: "provider authentication rejected", statusCode: 401, observedAt, receiptRef: "route_receipt_brave_1" },
    { providerId: "brave", routeId: "web.search.brave", routeIndex: 1, attempt: 1, status: "rate_limited", costClass: "unknown", authSource: "secret_broker", reason: "provider rate limit", statusCode: 429, retryAfterMs: 5_000, observedAt, receiptRef: "route_receipt_brave_2" },
    { providerId: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "retryable_failure", costClass: "free", authSource: "none", reason: "provider returned a retryable transient failure", statusCode: 503, observedAt, receiptRef: "route_receipt_exa_keyless_3" },
    { providerId: "youcom_free", routeId: "web.search.youcom_free", routeIndex: 2, attempt: 2, status: "empty", costClass: "free", authSource: "none", reason: "provider returned no results", statusCode: 200, observedAt, receiptRef: "route_receipt_youcom_free_4" },
    { providerId: "exa_keyless", routeId: "web.search.exa_keyless", routeIndex: 0, attempt: 1, status: "not_dispatched", notDispatchedFailure: "timed_out", costClass: "free", authSource: "none", reason: "connection timed out before provider request was sent", observedAt, receiptRef: "route_receipt_exa_keyless_5" },
    { providerId: "youcom_free", routeId: "web.search.youcom_free", routeIndex: 2, attempt: 1, status: "unknown", costClass: "free", authSource: "none", reason: "dispatch outcome unknown", observedAt },
  ])

  // Every projected row is a valid public provenance row in the result schema.
  expect(decodeResult({ ...directSearchResultFixture(), routeAttempts: projected }).routeAttempts)
    .toHaveLength(projected.length)

  // Rows without their authenticated route identity pins are never projected,
  // and the public view stays bounded to 20 rows.
  const unpinned: SearchRouteAttempt = { provider: "brave", attempt: 1, status: "failed", observedAt, receiptRef: "route_receipt_brave_unpinned" }
  const outOfRange: SearchRouteAttempt = { provider: "brave", routeId: "web.search.brave", routeIndex: 99, attempt: 1, status: "failed", observedAt, receiptRef: "route_receipt_brave_range" }
  expect(projectRouteAttempts([unpinned, outOfRange, rows[1]!])).toHaveLength(1)
  expect(projectRouteAttempts(Array.from({ length: 25 }, (_, index) => ({
    ...rows[1]!,
    routeIndex: index % 10,
    receiptRef: `route_receipt_brave_${index}`,
  })))).toHaveLength(20)
})

test("consent binding keeps unconsent routes out of the executable plan", () => {
  const supported = [...SEARCH_ROUTE_IDS]
  const noConsent = normalizeSearchCascadeSettings(
    consentBindingFixture({ enabled: ["exa_keyless", "brave"], byoConsents: [] }),
  )
  expect(noConsent.querySharingConsent).toBeUndefined()
  expect(noConsent.enabled).toEqual([])
  const planWithoutConsent = createSearchRoutePlan({
    enabled: noConsent.enabled,
    order: noConsent.order,
    supportedProviders: supported,
    credentialRefs: { brave: secretRef },
  })
  expect(planWithoutConsent.routes).toEqual([])

  const anonymous = normalizeSearchCascadeSettings(
    consentBindingFixture({ anonymous: true, enabled: ["exa_keyless", "brave"] }),
  )
  // Anonymous consent covers only the free keyless routes; `brave` still needs
  // its own BYO consent.
  expect(anonymous.enabled).toEqual(["exa_keyless"])
  const plan = createSearchRoutePlan({
    enabled: anonymous.enabled,
    order: anonymous.order,
    supportedProviders: supported,
    credentialRefs: { brave: secretRef },
  })
  expect(plan.routes).toEqual(["exa_keyless"])
  expect(plan.provenance).toEqual([{
    provider: "exa_keyless",
    label: "Built-in default · Exa",
    costClass: "FREE",
    authSource: "none",
  }])

  const byoConsented = normalizeSearchCascadeSettings(consentBindingFixture({
    anonymous: true,
    enabled: ["exa_keyless", "brave"],
    byoConsents: [{ route: "brave", consent: "secret_broker_unknown_cost_v1" }],
  }))
  expect(byoConsented.enabled).toEqual(["exa_keyless", "brave"])
  // ...but a consented BYO route without an opaque SecretBroker reference is
  // still not executable.
  expect(createSearchRoutePlan({
    enabled: byoConsented.enabled,
    order: byoConsented.order,
    supportedProviders: supported,
    credentialRefs: {},
  }).routes).toEqual(["exa_keyless"])
})

test("the MCP websearch adapter stays parse-only, so no handshake can dispatch", () => {
  // §32.28 requires a transport failure after any MCP handshake request that
  // may have sent to reconcile as UNKNOWN. Today no MCP search route can
  // dispatch at all: the module exposes pure parsing only. If a dispatcher ever
  // appears here, this test fails and the UNKNOWN reconciliation rule must be
  // implemented with it before the route may be enabled.
  expect(Object.keys(mcpWebSearch).sort()).toEqual(["parseResponse"])
  const plan = createSearchRoutePlan({
    enabled: [...SEARCH_ROUTE_IDS],
    order: [...SEARCH_ROUTE_IDS],
    supportedProviders: [...SEARCH_ROUTE_IDS],
    credentialRefs: { brave: secretRef, exa: secretRef, youcom: secretRef, tavily: secretRef, firecrawl: secretRef, parallel: secretRef },
  })
  expect(plan.routes.some((route) => route.startsWith("mcp"))).toBe(false)
})

test("a gated built-in default route reports an honest unavailable reason, never ready", () => {
  const routes = createSearchInspectionRoutes({
    supportedProviders: ["exa_keyless", "brave"],
    credentialRefs: { brave: secretRef },
  })
  const consented = normalizeSearchCascadeSettings(
    consentBindingFixture({ anonymous: true, enabled: ["exa_keyless"] }),
  )
  const gated = inspectSearchProviders({ settings: consented, routes, runtimeReady: false })
  const builtIn = gated.find((entry) => entry.provider === "exa_keyless")!
  expect(builtIn.status).toBe("unavailable")
  expect(builtIn.available).toBe(false)
  expect(builtIn.unavailableReason).toContain("Guarded")
  expect(builtIn.providerHealth).toBe("not_probed")

  // Zero consent: the built-in route stays disabled and unavailable even when
  // the runtime reports ready, so `available` cannot become true by default.
  const noConsent = normalizeSearchCascadeSettings(consentBindingFixture({}))
  const unconsented = inspectSearchProviders({ settings: noConsent, routes, runtimeReady: true })
  const stillDisabled = unconsented.find((entry) => entry.provider === "exa_keyless")!
  expect(stillDisabled.status).toBe("disabled")
  expect(stillDisabled.available).toBe(false)
  expect(stillDisabled.enabled).toBe(false)
})
