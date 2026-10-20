import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./websearch.txt"
import { normalizeSearchCascadeSettings, WEB_SEARCH_GUARD_READY, type SearchRouteID } from "./websearch-broker"

export const Parameters = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)).annotate({
    description: "Web search query (up to 2,000 characters)",
  }),
  numResults: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))).annotate({
    description: "Maximum number of results to return (1–10; default 8)",
  }),
})

export function webSearchProviderLabel(provider: SearchRouteID | undefined) {
  switch (provider) {
    case "exa_keyless":
      return "Built-in Web Search · Exa"
    case "youcom_free":
      return "Built-in Web Search · You.com"
    case "tavily_keyless":
      return "Built-in Web Search · Tavily"
    case "firecrawl_keyless":
      return "Built-in Web Search · Firecrawl"
    case "parallel_keyless":
      return "Built-in Web Search · Parallel"
    case "brave":
      return "Brave Search"
    case "exa":
      return "Exa Web Search"
    default:
      return "Web Search"
  }
}

/**
 * The Rust Guard/ExecutionHost has not yet accepted the outbound network
 * contract for this origin. Keep the tool definition gated in ToolRegistry and
 * retain a second fail-closed check here so direct or malformed dispatches have
 * zero network effect until the parent releases this gate.
 */
export const WebSearchTool = Tool.define(
  "websearch",
  Effect.succeed({
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const routes = normalizeSearchCascadeSettings()
        const reason = WEB_SEARCH_GUARD_READY
          ? "The Guarded search transport is not connected."
          : "Web search is unavailable until the Rust Guard and ExecutionHost network gate passes."
        yield* ctx.metadata({
          title: `Web Search "${params.query}"`,
          // Keep the renderer's provider field present while accurately
          // reporting that no provider was selected or contacted.
          metadata: { status: "unavailable", reason, enabledRoutes: routes.enabled, provider: undefined as SearchRouteID | undefined },
        })
        return {
          output: reason,
          title: `Web Search unavailable: ${params.query}`,
          metadata: { status: "unavailable", reason, enabledRoutes: routes.enabled, provider: undefined as SearchRouteID | undefined },
        }
      }),
  }),
)
