import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { SearchProviderStatus } from "./websearch-broker"
import { WebSearchRuntime } from "./websearch-runtime"
import * as Tool from "./tool"

const Parameters = Schema.Struct({})

/**
 * Read-only settings and local-dispatch inspection. It may resolve opaque
 * SecretBroker reference metadata for configuration status, but never consumes
 * credentials, invokes provider transport, or probes the network.
 */
export const WebSearchInspectProviderTool = Tool.define(
  "web_search_inspect_provider",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const runtime = yield* WebSearchRuntime.Service

    return {
      description:
        "Inspect web-search route enablement, local configuration, runtime availability, cost/auth class, and the last sanitized route attempt. This never contacts a provider and does not report provider health.",
      parameters: Parameters,
      capability: { id: "web.search.inspect_provider", effectClass: "read_only" },
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const current = yield* config.get()
          const providers = yield* runtime.inspect({
            settings: current.websearch,
            workspace: instance.directory,
          })
          return {
            title: "Web search provider status",
            metadata: { providerCount: providers.length, providerHealth: "not_probed" },
            output: [
              "Provider health: not probed. Inspection reads local settings and in-process route state only.",
              "Provider metadata freshness: unknown; inspection does not refresh catalogs or contact providers.",
              "Attempt/cooldown retention: process-local; state resets on restart.",
              ...providers.map(renderProvider),
            ].join("\n"),
          }
        }),
    }
  }),
)

function renderProvider(provider: SearchProviderStatus) {
  const fields = [
    `${provider.provider}: ${provider.status}`,
    `enabled=${provider.enabled}`,
    `configured=${provider.configured}`,
    `available=${provider.available}`,
    `auth=${provider.authSource}`,
    `cost=${provider.costClass}`,
    `health=${provider.providerHealth}`,
    `freshness=${provider.freshness}`,
  ]
  if (provider.lastAttemptAt) fields.push(`lastAttempt=${provider.lastAttemptAt}`)
  if (provider.lastAttemptStatus) fields.push(`lastAttemptStatus=${provider.lastAttemptStatus}`)
  if (provider.lastFailureAt) fields.push(`lastFailureAt=${provider.lastFailureAt}`)
  if (provider.lastStatusCode) fields.push(`lastStatus=${provider.lastStatusCode}`)
  if (provider.retryAfterMs !== undefined) fields.push(`retryAfterMs=${provider.retryAfterMs}`)
  if (provider.cooldownUntil) fields.push(`cooldownUntil=${provider.cooldownUntil}`)
  if (provider.lastError) fields.push(`lastFailure=${provider.lastError}`)
  if (provider.unavailableReason) fields.push(`reason=${provider.unavailableReason}`)
  return fields.join("; ")
}
