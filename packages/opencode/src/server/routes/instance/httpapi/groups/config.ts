import { Config } from "@/config/config"
import { FeatureExposure } from "@opencode-ai/core/v1/config/feature-exposure"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import * as DirectSessionPermissionModeV1 from "@opencode-ai/schema/direct-session-permission-mode-v1"
import * as ExternalEditorProfileV1 from "@opencode-ai/schema/external-editor-profile-v1"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConflictError, ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors"

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
        HttpApiEndpoint.get("directSessionPermissionMode", `${root}/direct-session-permission-mode`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/)) }),
          success: described(DirectSessionPermissionModeV1.ModeV1, "HostKernel-derived direct Session permission posture"),
          error: [ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.directSessionPermissionMode",
            summary: "Read direct Session permission posture",
            description: "Read the strict HostKernel-owned posture for this authenticated direct Session. Request fields carry no authority.",
          }),
        ),
        HttpApiEndpoint.patch("updateDirectSessionPermissionMode", `${root}/direct-session-permission-mode`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.String.check(Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/)) }),
          payload: DirectSessionPermissionModeV1.UpdateV1,
          success: described(DirectSessionPermissionModeV1.ModeV1, "Updated HostKernel-owned direct Session permission posture"),
          error: [ConflictError, ForbiddenError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.updateDirectSessionPermissionMode",
            summary: "Update direct Session permission posture",
            description: "Compare-and-set sandbox and approval choices through authenticated SessionSupervisor and HostKernel. It does not dispatch an effect.",
          }),
        ),
        HttpApiEndpoint.get("externalEditorProfiles", `${root}/external-editor-profiles`, {
          query: WorkspaceRoutingQuery,
          success: described(ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1, "Global user-owned immutable external editor profiles"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.externalEditorProfiles",
            summary: "List external editor profiles",
            description: "Read only user global editor profiles. Project, plugin, environment, account and model configuration cannot authorize editor launch.",
          }),
        ),
        HttpApiEndpoint.patch("updateExternalEditorProfiles", `${root}/external-editor-profiles`, {
          query: WorkspaceRoutingQuery,
          payload: ExternalEditorProfileV1.UpdateExternalEditorProfilesV1,
          success: described(ExternalEditorProfileV1.ExternalEditorProfilesProjectionV1, "Updated selected immutable external editor profile"),
          error: [ConflictError, ForbiddenError, InvalidRequestError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.updateExternalEditorProfiles",
            summary: "Add and select an external editor profile",
            description: "Append an immutable global user-owned profile revision and compare-and-set the selected profile. This does not launch a process or grant editor authority.",
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
          error: [ConflictError, ForbiddenError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.featureUpdate",
            summary: "Update optional feature setting",
            description: "Conditionally update one supported config setting without changing unrelated values.",
          }),
        ),
        HttpApiEndpoint.get("repoIntelProfile", `${root}/repo-intelligence/profile`, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.ConfigRepoIntelligenceV1.ProfileProjection, "RepoIntel analysis profile state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.repoIntelProfile",
            summary: "Get RepoIntel analysis profile",
            description: "Return requested/effective profile and config source, policy lock, and narrowing reason.",
          }),
        ),
        HttpApiEndpoint.get("resourcePolicy", `${root}/resources`, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.ConfigResourcePolicyV1.ResourcePolicyProjectionV1, "Requested and effective resource limit state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.resourcePolicy",
            summary: "Get resource policy state",
            description: "Return requested exact limits and truthful platform enforcement state; unavailable OS limits remain unsupported.",
          }),
        ),
        HttpApiEndpoint.patch("updateRepoIntelProfile", `${root}/repo-intelligence/profile`, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.ConfigRepoIntelligenceV1.UpdateProfile,
          success: described(ConfigV1.ConfigRepoIntelligenceV1.ProfileProjection, "Updated RepoIntel analysis profile"),
          error: [ConflictError, ForbiddenError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.updateRepoIntelProfile",
            summary: "Update RepoIntel analysis profile",
            description: "Conditionally update the Config-owned analysis mode without starting RepoIntel work.",
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
