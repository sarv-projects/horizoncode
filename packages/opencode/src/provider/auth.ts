import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { optional } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer, Context, Schema } from "effect"

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optional(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optional(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly authorize: (
    input: {
      providerID: ProviderV2.ID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderV2.ID } & CallbackInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAuth") {}

export const use = serviceUse(Service)

const unavailable = () =>
  new ValidationFailed({
    field: "guardedCredentialLifecycle",
    message: "Provider credential changes are unavailable until Guarded credential-write support is enabled",
  })

const methods = Effect.fn("ProviderAuth.methods")(() => Effect.succeed(Schema.decodeUnknownSync(Methods)({})))
const authorize = Effect.fn("ProviderAuth.authorize")(function* (
  _input: { providerID: ProviderV2.ID } & AuthorizeInput,
) {
  return yield* Effect.fail(unavailable())
})
const callback = Effect.fn("ProviderAuth.callback")(function* (
  _input: { providerID: ProviderV2.ID } & CallbackInput,
) {
  return yield* Effect.fail(unavailable())
})

const layer = Layer.succeed(Service, Service.of({ methods, authorize, callback }))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as ProviderAuth from "./auth"
