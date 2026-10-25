import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import * as InstanceState from "@/effect/instance-state"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConflictError, ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service
    const supervisor = yield* SessionSupervisor.Service

    const permissionFailure = (error: SessionSupervisorError) => {
      if (error.stage === "authorization" || error.hostCode === "forbidden") {
        return new ForbiddenError({ message: "Direct Session permission settings are not authorized" })
      }
      if (error.hostCode?.includes("conflict")) {
        return new ConflictError({ message: "Direct Session permission settings changed; reload the current posture", resource: "direct-session-permission-mode" })
      }
      return new ServiceUnavailableError({ message: "HostKernel direct Session permission settings are unavailable", service: "HostKernel" })
    }

    const trustedServerPrincipal = Effect.gen(function* () {
      const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(authenticated) || authenticated.value.principal.kind !== "server_auth" || !authenticated.value.principal.subject) {
        return yield* Effect.fail(new ForbiddenError({ message: "Direct Session permission settings require authenticated ServerAuth" }))
      }
      return authenticated.value
    })

    const directSessionPermissionMode = Effect.fn("ConfigHttpApi.directSessionPermissionMode")(function* (ctx) {
      const instance = yield* InstanceState.context
      const authenticated = yield* trustedServerPrincipal
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      return yield* supervisor.directSessionPermissionModeSnapshot({ sessionID: ctx.query.sessionID, locationRef }).pipe(
        Effect.provideService(TrustedPrincipalContext, authenticated),
        Effect.mapError((error) => {
          // The read endpoint does not declare a conflict response. Keep
          // authorization failures explicit; other snapshot failures mean the
          // authoritative HostKernel posture could not be read.
          if (error.stage === "authorization" || error.hostCode === "forbidden") {
            return new ForbiddenError({ message: "Direct Session permission settings are not authorized" })
          }
          return new ServiceUnavailableError({ message: "HostKernel direct Session permission settings are unavailable", service: "HostKernel" })
        }),
      )
    })

    const updateDirectSessionPermissionMode = Effect.fn("ConfigHttpApi.updateDirectSessionPermissionMode")(function* (ctx) {
      const instance = yield* InstanceState.context
      const authenticated = yield* trustedServerPrincipal
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      return yield* supervisor.setDirectSessionPermissionMode({
        sessionID: ctx.query.sessionID,
        locationRef,
        sandboxMode: ctx.payload.sandboxMode,
        approvalPolicy: ctx.payload.approvalPolicy,
        expectedRevision: ctx.payload.expectedRevision,
      }).pipe(
        Effect.provideService(TrustedPrincipalContext, authenticated),
        Effect.mapError(permissionFailure),
      )
    })

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const externalEditorProfiles = Effect.fn("ConfigHttpApi.externalEditorProfiles")(function* () {
      return yield* configSvc.getExternalEditorProfiles()
    })

    const updateExternalEditorProfiles = Effect.fn("ConfigHttpApi.updateExternalEditorProfiles")(function* (ctx) {
      return yield* configSvc.updateExternalEditorProfiles(ctx.payload).pipe(
        Effect.mapError((error) => {
          if (error instanceof Config.ExternalEditorProfileConflict) {
            return new ConflictError({ message: error.message, resource: "external-editor-profiles" })
          }
          if (error instanceof Config.ExternalEditorProfileInvalid) {
            return new InvalidRequestError({ message: error.message, field: "external_editor_profiles" })
          }
          return new HttpApiError.InternalServerError({})
        }),
      )
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const features = Effect.fn("ConfigHttpApi.features")(function* () {
      return yield* configSvc.getFeatures()
    })

    const resourcePolicy = Effect.fn("ConfigHttpApi.resourcePolicy")(function* () {
      return yield* configSvc.getResourcePolicy()
    })

    const featureUpdate = Effect.fn("ConfigHttpApi.featureUpdate")(function* (ctx) {
      const result = yield* configSvc.updateFeature(ctx.payload).pipe(
        Effect.mapError((error) => {
          if (error instanceof Config.FeatureSettingConflict)
            return new ConflictError({ message: error.message, resource: ctx.payload.featureId })
          if (error instanceof Config.FeatureSettingLocked)
            return new ForbiddenError({ message: error.message })
          return new HttpApiError.InternalServerError({})
        }),
      )
      // Feature updates have an explicit apply boundary. Disposing the instance
      // here would reload the effective config immediately and bypass the
      // next-turn pending state returned by Config.updateFeature.
      return result
    })

    const repoIntelProfile = Effect.fn("ConfigHttpApi.repoIntelProfile")(function* () {
      return yield* configSvc.getRepoIntelProfile()
    })

    const updateRepoIntelProfile = Effect.fn("ConfigHttpApi.updateRepoIntelProfile")(function* (ctx) {
      return yield* configSvc.updateRepoIntelProfile(ctx.payload).pipe(
        Effect.mapError((error) => {
          if (error instanceof Config.RepoIntelProfileConflict)
            return new ConflictError({ message: error.message, resource: "repo_intelligence.profile" })
          if (error instanceof Config.RepoIntelProfileLocked)
            return new ForbiddenError({ message: error.message })
          return new HttpApiError.InternalServerError({})
        }),
      )
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      // Provider construction may inspect catalog/provider integration state.
      // Keep that work exclusive to this endpoint; feature settings must be
      // readable without resolving any provider or credential surface.
      const providerSvc = yield* Provider.Service
      const providers = yield* providerSvc.list()
      let anonymousFreeModels: string[] = []
      if (providerSvc.anonymousFreeModelRefs) anonymousFreeModels = yield* providerSvc.anonymousFreeModelRefs()
      const defaults = Provider.defaultModelIDs(providers)
      const eligibleOpenCode = anonymousFreeModels
        .filter((ref) => ref.startsWith("opencode/"))
        .map((ref) => ref.slice("opencode/".length))
      if (eligibleOpenCode.length === 0) delete defaults.opencode
      else if (!eligibleOpenCode.includes(defaults.opencode)) defaults.opencode = eligibleOpenCode[0]
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: defaults,
      }
    })

    return handlers
      .handle("get", get)
      .handle("externalEditorProfiles", externalEditorProfiles)
      .handle("updateExternalEditorProfiles", updateExternalEditorProfiles)
      .handle("directSessionPermissionMode", directSessionPermissionMode)
      .handle("updateDirectSessionPermissionMode", updateDirectSessionPermissionMode)
      .handle("update", update)
      .handle("features", features)
      .handle("resourcePolicy", resourcePolicy)
      .handle("featureUpdate", featureUpdate)
      .handle("repoIntelProfile", repoIntelProfile)
      .handle("updateRepoIntelProfile", updateRepoIntelProfile)
      .handle("providers", providers)
  }),
)
