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
          success: described(ProviderDoctorV1.ResultV1, "Offline provider and local catalog diagnostics"),
          error: HttpApiError.Unauthorized,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.doctor.offline",
            summary: "Inspect provider and local catalog state offline",
            description:
              "Inspect the selected provider/model references, sanitized local provider configuration, and local catalog snapshot without loading remote config, reading credentials, or contacting a provider. Auth, remote entitlement, quota, and service health remain unchecked.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("catalog", "/provider/doctor/catalog", {
          query: WorkspaceRoutingQuery,
          payload: ProviderDoctorV1.CatalogRequestV1,
          success: described(ProviderDoctorV1.ResultV1, "Catalog-tier provider diagnostics"),
          error: HttpApiError.Unauthorized,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.doctor.catalog",
            summary: "Inspect a provider catalog with explicit network intent",
            description:
              "Accepts a bounded catalog-tier request. The network grant reference is not authority; this route reports the guarded transport as unavailable until HostKernel dispatch is integrated.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("full", "/provider/doctor/full", {
          query: WorkspaceRoutingQuery,
          payload: ProviderDoctorV1.FullRequestV1,
          success: described(ProviderDoctorV1.ResultV1, "Full-tier provider diagnostics"),
          error: HttpApiError.Unauthorized,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.doctor.full",
            summary: "Request a full provider diagnostic",
            description:
              "Requires explicit spend consent in the request contract. No credentials or network are used until a trusted HostKernel probe grant and bounded dispatcher are integrated.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "HorizonCode Provider Doctor",
          description: "Provider Doctor routes with offline inspection separated from consented probes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "HorizonCode Provider Doctor HttpApi",
      version: "0.0.1",
      description: "HorizonCode offline, catalog and full provider diagnostics; effectful probes remain unavailable pending Guarded dispatch.",
    }),
  )
