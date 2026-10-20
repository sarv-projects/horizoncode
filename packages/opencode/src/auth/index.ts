import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { createLazyProductionCredentialBroker, CredentialStoreError } from "./credential-broker-runtime"
import { SecureInputVault } from "./secure-input"
import type { TrustedSecretUseContext } from "./secret-broker"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const credentialStorageUnavailable = () =>
  new AuthError({ message: "Secure credential storage is unavailable; provider credential changes are disabled" })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly putCredential: (input: SecretBrokerV1.PutRequestV1) => Effect.Effect<SecretBrokerV1.MetadataV1, AuthError>
  readonly describeCredential: (secretRef: SecretBrokerV1.SecretRef) => Effect.Effect<SecretBrokerV1.MetadataV1, AuthError>
  readonly revokeCredential: (
    secretRef: SecretBrokerV1.SecretRef,
    expectedVersion?: number,
  ) => Effect.Effect<SecretBrokerV1.RevocationReceiptV1, AuthError>
  /**
   * Mints a one-use credential reference lease from internal Guard-authorized
   * context. This does not expose credential bytes or enable provider dispatch;
   * callers must not construct trusted context from HTTP/request fields.
   */
  readonly authorizeCredentialUse: (
    input: SecretBrokerV1.UseRequestV1,
  ) => Effect.Effect<SecretBrokerV1.UseLeaseV1, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

type CredentialBroker = Pick<
  ReturnType<typeof createLazyProductionCredentialBroker>,
  "put" | "describe" | "revoke" | "authorizeUse"
>

/** P1 supplies this only after Guard has admitted the exact provider effect. */
export interface ProviderCredentialAuthorizer {
  authorize(input: SecretBrokerV1.UseRequestV1): Promise<TrustedSecretUseContext>
}

const credentialInput = new SecureInputVault()

/**
 * Native first-party callers may turn bytes read from a protected TTY into an
 * ephemeral one-use handle. The handle, never the bytes, crosses the Auth
 * service interface or any RPC.
 */
export function issueSecureInputHandle(bytes: Uint8Array) {
  return credentialInput.issue(bytes)
}

export function makeService(
  credentialBroker: CredentialBroker,
  providerAuthorizer?: ProviderCredentialAuthorizer,
): Interface {
  const wrap = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) =>
        new AuthError({
          message: error instanceof CredentialStoreError ? error.message : "Secure credential storage is unavailable",
        }),
    })
  return Service.of({
    all: Effect.fn("Auth.all")(() => Effect.succeed({})),
    get: Effect.fn("Auth.get")((_providerID: string) => Effect.succeed(undefined)),
    set: Effect.fn("Auth.set")(function* (_key: string, _info: Info) {
      return yield* Effect.fail(credentialStorageUnavailable())
    }),
    remove: Effect.fn("Auth.remove")(function* (_key: string) {
      return yield* Effect.fail(credentialStorageUnavailable())
    }),
    putCredential: Effect.fn("Auth.putCredential")((input: SecretBrokerV1.PutRequestV1) =>
      wrap(() => credentialBroker.put(input)),
    ),
    describeCredential: Effect.fn("Auth.describeCredential")((secretRef: SecretBrokerV1.SecretRef) =>
      wrap(() => credentialBroker.describe(secretRef)),
    ),
    revokeCredential: Effect.fn("Auth.revokeCredential")(
      (secretRef: SecretBrokerV1.SecretRef, expectedVersion?: number) =>
        wrap(() => credentialBroker.revoke(secretRef, expectedVersion)),
    ),
    authorizeCredentialUse: Effect.fn("Auth.authorizeCredentialUse")((input: SecretBrokerV1.UseRequestV1) => {
      if (!providerAuthorizer) {
        return Effect.fail(new AuthError({ message: "Guarded provider credential authorization is unavailable" }))
      }
      return wrap(async () => credentialBroker.authorizeUse(input, await providerAuthorizer.authorize(input)))
    }),
  })
}

// Legacy auth.json and OPENCODE_AUTH_CONTENT contain raw provider secrets.
// They remain untouched, but are not an authoritative credential source.
// Credentials become available only through a canonical SecretBroker store.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const broker = createLazyProductionCredentialBroker({ directory: Global.Path.data, secureInput: credentialInput })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        credentialInput.close()
        await broker.close()
      }),
    )
    return makeService(broker)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as Auth from "."
