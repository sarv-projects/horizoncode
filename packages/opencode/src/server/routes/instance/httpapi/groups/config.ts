import { Config } from "@/config/config"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConflictError } from "../errors"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("features", `${root}/features`, {
          query: WorkspaceRoutingQuery,
          success: described(FeatureExposure.FeatureListSchema, "List effective optional feature settings"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.features",
            summary: "Get optional feature settings",
            description: "Return backend-owned effective FeatureExposure settings for this workspace.",
          }),
        ),
        HttpApiEndpoint.patch("featureUpdate", `${root}/features`, {
          query: WorkspaceRoutingQuery,
          payload: FeatureExposure.UpdateSchema,
          success: described(FeatureExposure.FeatureListSchema, "Updated effective feature settings"),
          error: [ConflictError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.featureUpdate",
            summary: "Update optional feature setting",
            description: "Conditionally update one supported config setting without changing unrelated values.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
