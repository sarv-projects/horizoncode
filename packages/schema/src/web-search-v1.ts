/** Read-only, credential-free web-search provider status projection. */

import { Schema } from "effect"

const ProviderId = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(64))
  .check(Schema.isPattern(/^[A-Za-z0-9._-]+$/))
const AnyIdentifier = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/))
const SearchAuthSource = Schema.Literals(["none", "saved_credential", "secret_broker", "environment", "model_provider", "unknown"])
const SearchCostClass = Schema.Literals(["free", "paid", "trial", "unknown"])

export interface RouteAttemptV1 extends Schema.Schema.Type<typeof RouteAttemptV1> {}
export const RouteAttemptV1 = Schema.Struct({
  providerId: ProviderId,
  routeId: AnyIdentifier,
  routeIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  status: Schema.Literals(["succeeded", "failed", "rate_limited", "retryable_failure", "empty", "not_dispatched", "unknown"]),
  notDispatchedFailure: Schema.optional(Schema.Literals(["cancelled", "timed_out", "transport_failure"])),
  costClass: Schema.optional(SearchCostClass),
  authSource: Schema.optional(SearchAuthSource),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  statusCode: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  retryAfterMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
  observedAt: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  receiptRef: Schema.optional(AnyIdentifier),
}).check(Schema.makeFilter((attempt) =>
  attempt.status === "not_dispatched"
    ? attempt.notDispatchedFailure === undefined
      ? "a not-dispatched route requires its trusted zero-send reason"
      : attempt.receiptRef === undefined
        ? "a known web-search route outcome requires its durable route receipt"
        : undefined
    : attempt.notDispatchedFailure !== undefined
      ? "only a not-dispatched route may carry a zero-send reason"
      : attempt.status === "unknown"
        ? attempt.receiptRef === undefined ? undefined : "an unknown route outcome cannot claim a settled route receipt"
        : attempt.receiptRef !== undefined ? undefined : "a known web-search route outcome requires its durable route receipt",
)).annotate({ identifier: "Horizon.WebSearchV1.RouteAttemptV1" })

export interface ResultItemV1 extends Schema.Schema.Type<typeof ResultItemV1> {}
export const ResultItemV1 = Schema.Struct({
  url: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2_048)),
  title: Schema.String.check(Schema.isMaxLength(240)),
  snippet: Schema.optional(Schema.String.check(Schema.isMaxLength(1_200))),
  sourceId: Schema.optional(Schema.Union([Schema.String.check(Schema.isMaxLength(256)), Schema.Null])),
}).annotate({ identifier: "Horizon.WebSearchV1.ResultItemV1" })

/** Successful result plus the bounded route/auth/cost provenance that produced it. */
export interface SearchResultV1 extends Schema.Schema.Type<typeof SearchResultV1> {}
export const SearchResultV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: AnyIdentifier,
  providerId: ProviderId,
  routeClass: Schema.Literals(["direct_search", "grounded_model_search"]),
  retrievedAt: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(64)),
  costClass: SearchCostClass,
  authSource: SearchAuthSource,
  freshness: Schema.Literals(["current", "unknown"]),
  latencyMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })),
  truncated: Schema.Boolean,
  routePlanDigest: Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/)),
  routeAttempts: Schema.Array(RouteAttemptV1).check(Schema.isMaxLength(20)),
  results: Schema.Array(ResultItemV1).check(Schema.isMaxLength(10)),
}).annotate({ identifier: "Horizon.WebSearchV1.SearchResultV1" })

/** A search with no safely returnable result; route evidence remains explicit. */
export interface SearchFailureV1 extends Schema.Schema.Type<typeof SearchFailureV1> {}
export const SearchFailureV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: AnyIdentifier,
  status: Schema.Literals(["not_dispatched", "failed", "exhausted", "cancelled", "unknown", "completed_result_unavailable"]),
  reason: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(1_024)),
  routePlanDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^blake3:[a-f0-9]{64}$/))),
  routeAttempts: Schema.Array(RouteAttemptV1).check(Schema.isMaxLength(20)),
}).check(Schema.makeFilter((failure) =>
  failure.status !== "not_dispatched" && failure.routePlanDigest === undefined
    ? "a trusted route-plan digest is required once a route plan may have been dispatched"
    : failure.status === "failed" && (() => {
        const last = failure.routeAttempts.at(-1)
        return !last || last.status !== "failed" || last.statusCode === undefined || last.statusCode < 400 ||
          last.statusCode >= 500 || [401, 403, 407, 408, 425, 429].includes(last.statusCode)
      })()
      ? "failed requires a settled terminal non-authentication 4xx route receipt"
      : undefined,
)).annotate({ identifier: "Horizon.WebSearchV1.SearchFailureV1" })

export const ProviderStatusV1 = Schema.Struct({
  provider: ProviderId,
  routeClass: Schema.Literals(["DIRECT_SEARCH", "GROUNDED_MODEL_SEARCH"]),
  costClass: Schema.Literals(["FREE", "PAID", "TRIAL", "UNKNOWN"]),
  authSource: Schema.Literals(["none", "saved_credential", "secret_broker", "environment", "model_provider", "unknown"]),
  enabled: Schema.Boolean,
  configured: Schema.Boolean,
  status: Schema.Literals(["disabled", "unconfigured", "unavailable", "ready", "rate_limited"]),
  available: Schema.Boolean,
  providerHealth: Schema.Literal("not_probed"),
  stateSource: Schema.Literal("process_local"),
  freshness: Schema.Literal("unknown"),
  lastAttemptStatus: Schema.optional(Schema.Literals(["succeeded", "failed", "rate_limited", "retryable_failure", "empty", "not_dispatched", "unknown"])),
  lastFailureAt: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  lastStatusCode: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  lastAttemptAt: Schema.optional(Schema.String),
  retryAfterMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
  cooldownUntil: Schema.optional(Schema.String),
  unavailableReason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
}).annotate({ identifier: "Horizon.WebSearchV1.ProviderStatusV1" })

export const ProviderStatusListV1 = Schema.Array(ProviderStatusV1).check(Schema.isMaxLength(10))
  .annotate({ identifier: "Horizon.WebSearchV1.ProviderStatusListV1" })

