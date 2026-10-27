import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ServiceUnavailableError } from "../errors"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const catalogSnapshot = yield* ModelsDev.Service.use((s) => s.getSnapshot())
      const all = catalogSnapshot.providers
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const configuredProviders = yield* provider.list()
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        configuredProviders,
      )
      // Only metadata references for IDs resolved by the canonical provider
      // registry count as a configured credential source. This remains a UI
      // projection; SecretBroker presence does not authorize provider dispatch.
      const credentialRefs = yield* authStore.credentialRefsForProviders(Object.keys(providers)).pipe(Effect.orDie)
      // If a test or alternate provider layer lacks the policy projection, fail
      // closed and expose no anonymous model selection.
      let anonymousFreeModels: string[] = []
      if (provider.anonymousFreeModelRefs) anonymousFreeModels = yield* provider.anonymousFreeModelRefs()
      const anonymousFreeProviders = anonymousFreeModels.length > 0 ? [ProviderV2.ID.opencode] : []
      const defaults = Provider.defaultModelIDs(providers)
      const anonymousModelIDs = anonymousFreeModels
        .filter((ref) => ref.startsWith(`${ProviderV2.ID.opencode}/`))
        .map((ref) => ref.slice(`${ProviderV2.ID.opencode}/`.length))
      if (anonymousModelIDs.length === 0) delete defaults.opencode
      else if (!anonymousModelIDs.includes(defaults.opencode)) defaults.opencode = anonymousModelIDs[0]
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: defaults,
        anonymousFreeProviders,
        anonymousFreeModels,
        catalogSnapshot: {
          source: catalogSnapshot.source,
          freshness: catalogSnapshot.freshness,
          ...(catalogSnapshot.updatedAt === undefined ? {} : { updatedAt: catalogSnapshot.updatedAt }),
          ...(catalogSnapshot.provenance?.retrievedAt === undefined ? {} : { retrievedAt: catalogSnapshot.provenance.retrievedAt }),
          ...(catalogSnapshot.provenance?.contentDigest === undefined ? {} : { contentDigest: catalogSnapshot.provenance.contentDigest }),
          ...(catalogSnapshot.provenance?.license === undefined ? {} : { license: catalogSnapshot.provenance.license }),
          ...(catalogSnapshot.provenance?.attribution === undefined ? {} : { attribution: catalogSnapshot.provenance.attribution }),
        },
        connected: Object.values(providers)
          .filter((item) => item.source !== "custom" || credentialRefs[item.id] || anonymousFreeProviders.includes(item.id))
          .map((item) => item.id),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (_ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      // The upstream OAuth flow persists credentials through legacy Auth and
      // has no protected native input/Guarded SecretBroker write authority.
      // Reject before constructing a provider authorization URL or mutating
      // auth state; the V1 UI reports this capability as unavailable.
      return yield* Effect.fail(new ServiceUnavailableError({
        message: "Provider credential entry is unavailable until Guarded SecretBroker input is integrated",
        service: "provider-credential-write",
      }))
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (_ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      // OAuth callbacks can persist caller-supplied authorization material.
      // Keep the entire legacy mutation route disabled at its authenticated
      // boundary until a trusted protected-input exchange exists.
      return yield* Effect.fail(new ServiceUnavailableError({
        message: "Provider credential callbacks are unavailable until Guarded SecretBroker input is integrated",
        service: "provider-credential-write",
      }))
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
