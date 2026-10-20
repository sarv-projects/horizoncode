import { ProviderDoctorV1 } from "@opencode-ai/schema/provider-doctor-v1"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ProviderDoctorApi = HttpApi.make("provider-doctor")
  .add(
    HttpApiGroup.make("providerDoctor")
      .add(
        HttpApiEndpoint.post("offline", "/provider/doctor/offline", {
          query: WorkspaceRoutingQuery,
          payload: ProviderDoctorV1.OfflineRequestV1,
          success: described(ProviderDoctorV1.ResultV1, "Offline provider configuration diagnostics"),
          error: HttpApiError.Unauthorized,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.doctor.offline",
            summary: "Inspect provider configuration offline",
            description:
              "Inspect the selected provider/model configuration without reading credentials or contacting a provider.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "providerDoctor",
          description: "Provider Doctor routes with offline inspection separated from consented probes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode provider Doctor HttpApi",
      version: "0.0.1",
      description: "Offline provider diagnostics. Catalog and paid probes are not exposed by this group.",
    }),
  )
