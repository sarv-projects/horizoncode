import { ProviderDoctor } from "@/provider/doctor"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const providerDoctorHandlers = HttpApiBuilder.group(InstanceHttpApi, "providerDoctor", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const models = yield* ModelsDev.Service
    return handlers.handle("offline", ({ payload }) =>
      Effect.gen(function* () {
        const authenticated = yield* Effect.serviceOption(TrustedPrincipalContext)
        if (Option.isNone(authenticated)) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
        const [effectiveConfig, catalog] = yield* Effect.all([config.get(), models.getSnapshot()])
        return yield* Effect.sync(() =>
          ProviderDoctor.inspectOffline(payload, authenticated.value, {
            config: effectiveConfig,
            catalog: catalog.providers,
            catalogFreshness: catalog.freshness,
          }),
        )
      }),
    )
  }),
)
