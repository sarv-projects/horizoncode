import { Effect, Schema } from "effect"
import { WebSearchV1 } from "@opencode-ai/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./websearch.txt"
import { hasEnabledSearchRouteReady, normalizeSearchCascadeSettings, SearchCascadeError, searchRouteRuntimeReady, type SearchRouteAttempt, type SearchRouteID } from "./websearch-broker"
import { Config } from "@/config/config"
import { WebSearchRuntime, SearchRuntimeError, type SearchEffectArgumentsV1 } from "./websearch-runtime"
import {
  failToolBatchLease,
  settleToolBatchLease,
  type DirectAttemptAuthority,
} from "@/session/tool-batch"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import type { EffectLease } from "@opencode-ai/core/session/supervisor"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
    description: "Web search query (up to 2,000 characters)",
  }),
  numResults: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))).annotate({
    description: "Maximum number of results to return (1–10; default 8)",
  }),
  domains: Schema.optional(Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253))
      .check(Schema.isPattern(/^(\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/)),
  ).check(Schema.isMaxLength(100), Schema.makeFilter((domains) =>
    new Set(domains).size === domains.length ? undefined : "Search domain filters must be unique",
  ))).annotate({
    description: "Optional provider-side search filter, not a security boundary; up to 100 DNS names or leading *. wildcards.",
  }),
})

export function webSearchProviderLabel(provider: SearchRouteID | undefined) {
  switch (provider) {
    case "exa_keyless":
      return "Built-in Web Search · Exa"
    case "youcom_free":
      return "Built-in Web Search · You.com"
    case "firecrawl_keyless":
      return "Built-in Web Search · Firecrawl"
    case "parallel_keyless":
      return "Built-in Web Search · Parallel"
    case "brave":
      return "Brave Search"
    case "exa":
      return "Exa Web Search"
    case "youcom":
      return "You.com Search"
    case "tavily":
      return "Tavily Search"
    case "firecrawl":
      return "Firecrawl Search"
    case "parallel":
      return "Parallel Search"
    default:
      return "Web Search"
  }
}

function projectRouteAttempts(attempts: readonly SearchRouteAttempt[]) {
  // Route identity and index are required by the public V1 schema. Never infer
  // them from the provider name/order at projection time; rows lacking the
  // authenticated HostKernel pins are omitted from the bounded public view.
  return attempts.filter((attempt) => attempt.routeId === `web.search.${attempt.provider}` &&
    Number.isSafeInteger(attempt.routeIndex) && attempt.routeIndex! >= 0 && attempt.routeIndex! <= 9).slice(0, 20).map((attempt) => ({
    providerId: attempt.provider,
    routeId: attempt.routeId,
    routeIndex: attempt.routeIndex,
    attempt: Math.min(2, Math.max(1, Math.floor(attempt.attempt))),
    status: attempt.status,
    ...(attempt.status === "not_dispatched" && attempt.notDispatchedFailure
      ? { notDispatchedFailure: attempt.notDispatchedFailure }
      : {}),
    ...(attempt.costClass === undefined ? {} : { costClass: attempt.costClass.toLowerCase() }),
    ...(attempt.authSource === undefined ? {} : { authSource: attempt.authSource }),
    ...(() => {
      const safeReason = attempt.status === "unknown" ? "dispatch outcome unknown"
        : attempt.status === "rate_limited" ? "provider rate limit"
          : attempt.status === "retryable_failure" ? "provider returned a retryable transient failure"
          : attempt.status === "not_dispatched" ? attempt.notDispatchedFailure === "cancelled"
            ? "search cancelled before provider request was sent"
            : attempt.notDispatchedFailure === "timed_out"
              ? "connection timed out before provider request was sent"
              : "transport failed before provider request was sent"
          : attempt.status === "empty" ? "provider returned no results"
            : attempt.statusCode === 401 || attempt.statusCode === 403 || attempt.statusCode === 407 ? "provider authentication rejected"
              : attempt.statusCode === undefined ? attempt.status === "failed" ? "provider request failed" : undefined : `provider returned HTTP ${attempt.statusCode}`
      return safeReason === undefined ? {} : { reason: safeReason }
    })(),
    ...(attempt.statusCode === undefined ? {} : { statusCode: Math.min(599, Math.max(100, attempt.statusCode)) }),
    ...(attempt.retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(60_000, Math.max(0, attempt.retryAfterMs)) }),
    ...(attempt.observedAt === undefined ? {} : { observedAt: attempt.observedAt.slice(0, 64) }),
    ...(attempt.receiptRef === undefined ? {} : { receiptRef: attempt.receiptRef.slice(0, 256) }),
  }))
}

/**
 * The Rust Guard/ExecutionHost has not yet accepted the outbound network
 * contract for this origin. Keep the tool definition gated in ToolRegistry and
 * retain a second fail-closed check here so direct or malformed dispatches have
 * zero network effect until the parent releases this gate.
 */
export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const runtime = yield* WebSearchRuntime.Service
    const instance = yield* InstanceState.context
    return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: Parameters,
    capability: { id: "web.search", effectClass: "effect" as const },
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const current = yield* config.get()
        const settings = normalizeSearchCascadeSettings(current.websearch)
        const enabledRouteReady = hasEnabledSearchRouteReady(settings)
        const execution = ctx.extra?.searchExecution as SearchEffectArgumentsV1 | undefined
        const admittedRoutesReady = !!execution?.routes.length && execution.routes.every((route) => searchRouteRuntimeReady(route.routeKey))
        const reason = !enabledRouteReady
          ? "No enabled search route has passed its Guard/SecretBroker release gate."
          : "The admitted search plan contains a route that is unavailable."
        if (!enabledRouteReady || !admittedRoutesReady) {
          const metadata = { status: "unavailable", reason, enabledRoutes: settings.enabled, provider: undefined as SearchRouteID | undefined }
          yield* ctx.metadata({ title: "Web Search unavailable", metadata })
          failToolBatchLease(ctx.extra?.guardedLease, metadata.reason)
          return { output: reason, title: "Web Search unavailable", metadata }
        }
        const effect = ctx.effect
        const directAuthority = ctx.extra?.directAttempt as DirectAttemptAuthority | undefined
        const managedAuthority = ctx.extra?.managedAttempt as ManagedAttemptAuthority | undefined
        const directAttempt = directAuthority?.currentScope()
        const managedAttempt = managedAuthority?.currentScope()
        // An ordinary direct Core session is not a managed Attempt and must not
        // be forced to create a Goal merely to use an explicitly approved
        // read-only network capability. HostKernel authenticates the session,
        // Location, Guard challenge/lease and durable HTTP receipt for that
        // lane. Direct Task Attempts remain separately scoped and HostKernel
        // currently rejects them until its external-effect receipt transition
        // can preserve their workspace revision.
        if (!ctx.callID) {
          const metadata = { status: "unavailable", reason: "An authenticated tool-call identity is required for web search.", enabledRoutes: settings.enabled, provider: undefined as SearchRouteID | undefined }
          yield* ctx.metadata({ title: "Web Search unavailable", metadata })
          failToolBatchLease(ctx.extra?.guardedLease, metadata.reason)
          return { output: metadata.reason, title: "Web Search unavailable", metadata }
        }
        const lease = ctx.extra?.guardedLease as EffectLease | undefined
        if (!effect && !lease) {
          const metadata = { status: "unavailable", reason: "A Guard challenge or one-use aggregate lease is required for web search.", enabledRoutes: settings.enabled, provider: undefined as SearchRouteID | undefined }
          yield* ctx.metadata({ title: "Web Search unavailable", metadata })
          failToolBatchLease(ctx.extra?.guardedLease, metadata.reason)
          return { output: metadata.reason, title: "Web Search unavailable", metadata }
        }
        const requestedDomains = params.domains
        const admittedDomains = execution?.domains
        const sameDomains = requestedDomains === undefined
          ? admittedDomains === undefined
          : admittedDomains !== undefined && requestedDomains.length === admittedDomains.length &&
            requestedDomains.every((domain, index) => domain === admittedDomains[index])
        if (!execution || execution.query !== params.query.trim() || execution.limit !== (params.numResults ?? 8) || !sameDomains) {
          const metadata = { status: "unavailable", reason: "The admitted web-search plan does not match this tool call.", enabledRoutes: settings.enabled, provider: undefined as SearchRouteID | undefined }
          yield* ctx.metadata({ title: "Web Search unavailable", metadata })
          failToolBatchLease(ctx.extra?.guardedLease, metadata.reason)
          return { output: metadata.reason, title: "Web Search unavailable", metadata }
        }
        const searched = yield* runtime.search({
          execution,
          signal: ctx.abort,
          scope: {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            workspace: instance.directory,
            ...(directAttempt ? { directAttempt } : {}),
            ...(managedAttempt ? { managedAttempt } : {}),
          },
          ...(managedAuthority ? { managedAuthority } : {}),
          ...(effect ? { challenge: effect } : {}),
          ...(lease ? { lease } : {}),
        }).pipe(Effect.either)
        if (searched._tag === "Left") {
          const error = searched.left
          const routeAttempts = error instanceof SearchCascadeError || error instanceof SearchRuntimeError ? error.attempts.slice(0, 20) : []
          // Runtime errors may contain transport/provider text. Never expose
          // them as the aggregate reason; safe route classifications are kept
          // separately in the bounded route-attempt projection.
          const message = error instanceof SearchRuntimeError && error.outcome === "CANCELLED"
            ? "Web search was cancelled after route admission; no later route was dispatched."
            : "Web search did not produce an available result."
          const failureStatus = error instanceof SearchRuntimeError
            ? error.outcome === "UNKNOWN" ? "unknown"
              : error.outcome === "NOT_DISPATCHED" ? "not_dispatched"
                : error.outcome === "FAILED" ? "failed"
                : error.outcome === "CANCELLED" ? "cancelled"
                : error.outcome === "RESULT_UNAVAILABLE" ? "completed_result_unavailable"
                  : "exhausted"
            // A legacy in-process cascade error has no HostKernel route-plan
            // digest, so nonempty attempts cannot prove exhaustion. Preserve
            // them as UNKNOWN instead of inventing a settled result.
            : error instanceof SearchCascadeError ? routeAttempts.length ? "unknown" : "not_dispatched" : "unknown"
          const failure = failureStatus === "not_dispatched" ||
            (error instanceof SearchRuntimeError && error.routePlanDigest)
            ? Schema.decodeUnknownSync(WebSearchV1.SearchFailureV1)({
                schemaVersion: 1,
                requestId: ctx.callID,
                status: failureStatus,
                reason: message.slice(0, 1_024) || "Web search failed before a result was available.",
                routeAttempts: projectRouteAttempts(routeAttempts),
                ...(error instanceof SearchRuntimeError && error.routePlanDigest
                  ? { routePlanDigest: error.routePlanDigest }
                  : {}),
              })
            : undefined
          const metadata = {
            status: error instanceof SearchRuntimeError
              ? error.outcome === "UNKNOWN" ? "unknown" : error.outcome === "NOT_DISPATCHED" ? "unavailable" : error.outcome === "FAILED" ? "failed" : error.outcome === "CANCELLED" ? "cancelled" : error.outcome === "RESULT_UNAVAILABLE" ? "completed_result_unavailable" : "exhausted"
              : error instanceof SearchCascadeError ? routeAttempts.length ? "unknown" : "unavailable" : "unknown",
            reason: message.slice(0, 1_024),
            enabledRoutes: settings.enabled,
            routeAttempts: projectRouteAttempts(routeAttempts),
            ...(failure ? { failure } : {}),
          }
          const title = metadata.status === "unknown" ? "Web Search outcome unknown"
            : metadata.status === "unavailable" ? "Web Search unavailable"
              : metadata.status === "cancelled" ? "Web Search cancelled"
              : metadata.status === "completed_result_unavailable" ? "Web Search completed; results unavailable"
              : "Web Search failed"
          yield* ctx.metadata({ title, metadata })
          if (lease && error instanceof SearchRuntimeError && (error.outcome === "FAILED" || error.outcome === "EXHAUSTED" || error.outcome === "CANCELLED" || error.outcome === "RESULT_UNAVAILABLE") && error.receiptRef) {
            // Known terminal aggregate receipts consume the one-use lease.
            // UNKNOWN and pre-dispatch failures remain unsettled; a reconciled
            // completion with a lost body is never represented as exhaustion.
            yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: lease.effectID }))
          } else {
            // UNKNOWN and pre-dispatch failures must not mint a success receipt;
            // fail the local serial chain so later members cannot proceed.
            failToolBatchLease(lease, message)
          }
          return { title, metadata, output: metadata.reason }
        }
        const outcome = searched.right
        const result = outcome.result
        if (lease) {
          yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: lease.effectID }))
        }
        const resultProjection = Schema.decodeUnknownSync(WebSearchV1.SearchResultV1)({
          schemaVersion: 1,
          requestId: ctx.callID,
          providerId: result.provider,
          routeClass: result.routeClass === "DIRECT_SEARCH" ? "direct_search" : "grounded_model_search",
          costClass: result.costClass.toLowerCase(),
          authSource: result.authSource,
          freshness: result.freshness,
          retrievedAt: result.retrievedAt,
          latencyMs: result.latencyMs,
          truncated: result.truncated,
          routeAttempts: projectRouteAttempts(outcome.attempts),
          routePlanDigest: outcome.routePlanDigest,
          results: result.results.slice(0, 10).map((item) => ({
            url: item.url.slice(0, 2_048),
            title: item.title.slice(0, 240),
            ...(item.snippet === undefined ? {} : { snippet: item.snippet.slice(0, 1_200) }),
          })),
        })
        const metadata = {
          status: "succeeded",
          provider: result.provider,
          providerLabel: webSearchProviderLabel(result.provider),
          routeClass: result.routeClass,
          costClass: result.costClass,
          authSource: result.authSource,
          freshness: result.freshness,
          retrievedAt: result.retrievedAt,
          latencyMs: result.latencyMs,
          routeAttempts: projectRouteAttempts(outcome.attempts),
          result: resultProjection,
        }
        yield* ctx.metadata({ title: `${webSearchProviderLabel(result.provider)}: ${params.query}`, metadata })
        return {
          title: `${webSearchProviderLabel(result.provider)}: ${params.query}`,
          metadata,
          output: resultProjection.results.map((item, index) => [
            `${index + 1}. ${item.title}`,
            item.url,
            item.snippet,
          ].filter(Boolean).join("\n")).join("\n\n"),
        }
      }),
    }
  }),
)
