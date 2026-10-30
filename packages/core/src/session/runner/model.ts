export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@horizoncode/llm"
import * as AnthropicMessages from "@horizoncode/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@horizoncode/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@horizoncode/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@horizoncode/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  /** Exact catalog-selected route identity for the protected direct transport. */
  readonly resolveSelection?: (session: SessionSchema.Info) => Effect.Effect<ResolvedSelectionV1, Error>
}

export type DirectProviderRouteProjectionV1 = {
  readonly providerID: string
  readonly modelID: string
  readonly routeID: string
  readonly routeRevision: string
  readonly endpointRevision: string
  /** Public endpoint base from the selected route; never includes auth material. */
  readonly endpointBase: string
}

export type ResolvedSelectionV1 = {
  readonly model: Model
  readonly directProviderRoute?: DirectProviderRouteProjectionV1
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const directProviderRouteProjection = (
  selected: ModelV2.Info,
  model: Model,
): DirectProviderRouteProjectionV1 | undefined => {
  if (selected.providerID !== "opencode" || selected.status !== "active" || !selected.enabled ||
    selected.cost.length === 0 || selected.cost.some((cost) =>
      cost.input !== 0 || cost.output !== 0 || cost.cache.read !== 0 || cost.cache.write !== 0,
    )) return undefined
  if (selected.api.type !== "aisdk") return undefined
  const endpointText = model.route.endpoint.baseURL
  if (typeof endpointText !== "string" || endpointText.length > 2048) return undefined
  let endpoint: URL
  try {
    endpoint = new URL(endpointText)
  } catch {
    return undefined
  }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]"
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined

  const routeMaterial = JSON.stringify([
    "horizoncode.direct-provider-route.v1",
    selected.providerID,
    selected.id,
    selected.api.package,
    selected.api.id,
  ])
  const routeID = `llm_${bytesToHex(blake3(new TextEncoder().encode(routeMaterial)))}`
  const endpointBase = endpoint.href
  const endpointRevision = `blake3:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([
    "horizoncode.direct-provider-endpoint.v1",
    routeID,
    endpointBase,
  ]))))}`
  return Object.freeze({
    providerID: selected.providerID,
    modelID: selected.id,
    routeID,
    routeRevision: routeID,
    endpointRevision,
    endpointBase,
  })
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
  options: { readonly allowCredentials?: boolean } = {},
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = options.allowCredentials === false ? undefined : apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const resolveSelection = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  options: { readonly allowCredentials?: boolean } = {},
) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((selected) => fromCatalogModel(selected, credential, options).pipe(
      Effect.map((resolved) => ({
        model: resolved,
        directProviderRoute: directProviderRouteProjection(selected, resolved),
      })),
    )),
  )

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const resolveSelectionForSession = Effect.fn("SessionRunnerModel.resolveSelection")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        return yield* resolveSelection(
          session,
          selected,
          undefined,
          { allowCredentials: false },
        )
      })
    return Service.of({
      resolveSelection: resolveSelectionForSession,
      resolve: (session) => resolveSelectionForSession(session).pipe(Effect.map((result) => result.model)),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node] })
