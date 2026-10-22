import { ProviderDoctor } from "@/provider/doctor"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const providerDoctorHandlers = HttpApiBuilder.group(InstanceHttpApi, "providerDoctor", (handlers) =>
  Effect.gen(function* () {
    const models = yield* ModelsDev.Service
    const config = yield* Config.Service
    return handlers
      .handle("offline", ({ payload }) =>
        Effect.gen(function* () {
          const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(authenticated)) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
          const catalog = yield* models.getSnapshot()
          const localConfig = config.getOfflineProviderDoctorConfig
            ? yield* config.getOfflineProviderDoctorConfig()
            : yield* Effect.succeed(Option.none())
          return yield* Effect.sync(() =>
            ProviderDoctor.inspectOffline(payload, authenticated.value, {
              catalog: catalog.providers,
              catalogFreshness: catalog.freshness,
              ...(Option.isSome(localConfig) ? { config: localConfig.value } : {}),
            }),
          )
        }),
      )
      .handle("catalog", ({ payload }) =>
        Effect.gen(function* () {
          const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(authenticated)) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
          const catalog = yield* models.getSnapshot()
          const localConfig = config.getOfflineProviderDoctorConfig
            ? yield* config.getOfflineProviderDoctorConfig()
            : yield* Effect.succeed(Option.none())
          return yield* Effect.sync(() => ProviderDoctor.inspectCatalog(payload, authenticated.value, {
            catalog: catalog.providers,
            catalogFreshness: catalog.freshness,
            ...(Option.isSome(localConfig) ? { config: localConfig.value } : {}),
          }))
        }),
      )
      .handle("full", ({ payload }) =>
        Effect.gen(function* () {
          const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
          if (Option.isNone(authenticated)) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
          const catalog = yield* models.getSnapshot()
          const localConfig = config.getOfflineProviderDoctorConfig
            ? yield* config.getOfflineProviderDoctorConfig()
            : yield* Effect.succeed(Option.none())
          return yield* Effect.sync(() =>
            ProviderDoctor.inspectFull(payload, authenticated.value, {
              catalog: catalog.providers,
              catalogFreshness: catalog.freshness,
              ...(Option.isSome(localConfig) ? { config: localConfig.value } : {}),
            }),
          )
        }),
      )
  }),
)
