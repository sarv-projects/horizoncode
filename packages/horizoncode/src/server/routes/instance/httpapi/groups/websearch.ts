import { WebSearchV1 } from "@horizoncode/schema"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const WebSearchApi = HttpApi.make("web-search")
  .add(
    HttpApiGroup.make("webSearch")
      .add(
        HttpApiEndpoint.get("providers", "/websearch/providers", {
          query: WorkspaceRoutingQuery,
          success: described(WebSearchV1.ProviderStatusListV1, "Local web-search provider status"),
          error: HttpApiError.Unauthorized,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "web.search.providers",
            summary: "Inspect web-search provider status",
            description:
              "Return sanitized local enablement, SecretBroker-reference availability, route cost/auth class, freshness, cooldown and last-attempt state. This route requires authenticated workspace context and never calls a provider or network.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "HorizonCode Web Search",
          description: "Authenticated, read-only web-search route inspection; search dispatch remains independently Guard-gated.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "HorizonCode Web Search HttpApi",
      version: "0.0.1",
      description: "Read-only local provider status. No provider probes or search dispatch are exposed here.",
    }),
  )
