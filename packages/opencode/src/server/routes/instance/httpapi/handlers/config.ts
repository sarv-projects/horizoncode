import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConflictError } from "../errors"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const features = Effect.fn("ConfigHttpApi.features")(function* () {
      return yield* configSvc.getFeatures()
    })

    const featureUpdate = Effect.fn("ConfigHttpApi.featureUpdate")(function* (ctx) {
      const result = yield* configSvc.updateFeature(ctx.payload).pipe(
        Effect.mapError((error) =>
          error instanceof Config.FeatureSettingConflict
            ? new ConflictError({ message: error.message, resource: ctx.payload.featureId })
            : new HttpApiError.InternalServerError({}),
        ),
      )
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return result
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("features", features)
      .handle("featureUpdate", featureUpdate)
      .handle("providers", providers)
  }),
)
