import { createHash } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema, Context, Option } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { SecretBrokerV1 } from "@opencode-ai/schema/secret-broker-v1"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import type { DirectProviderTransport } from "@opencode-ai/llm/route"
import type {
  DirectAttemptScopeV1,
  Interface as SessionSupervisorInterface,
  ManagedAttemptScopeV1,
} from "@opencode-ai/core/session/supervisor"
import { createLazyProductionCredentialBroker, CredentialStoreError } from "./credential-broker-runtime"
import { makeCredentialMutationAuthorizer } from "./credential-mutation-authorizer"
import { makeCredentialUseAuthorizer, type CredentialUseAuthorizer } from "./credential-use-authorizer"
import { SecureInputVault } from "./secure-input"
import type { TrustedSecretUseContext } from "./secret-broker"
import { SecretBrokerError } from "./secret-broker"
import { TrustedPrincipalContext, type TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import {
  exactMutationGrant,
  mutationBinding,
  principalRefOf,
  putBinding,
  type CredentialMutationAuthorizer,
} from "./secret-mutation"
import {
  decodeSearchSecretAuthorization,
  decodeSearchDispatchPermit,
  dispatchAuthorizedSearchRequest,
  dispatchAuthorizedManagedProviderRequest as dispatchManagedProviderTransport,
  type AuthorizedSearchProviderResponseV1,
  type DirectProviderRouteV1,
  type ManagedProviderAuthorizationHandleV1,
  type ManagedProviderRouteV1,
  type ManagedProviderSendPinsV1,
  type ManagedProviderSendPermitV1,
  type PreparedManagedProviderTransportV1,
  type PreparedDirectProviderTransportV1,
  type ProviderTransportRequest,
  createPinnedDirectProviderFetch,
  dispatchAuthorizedDirectFreeProviderRequest as dispatchDirectFreeProviderTransport,
  prepareDirectProviderTransportRequest,
  providerRequestDigest,
} from "./provider-transport"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export type { CredentialMutationAuthorizer, CredentialMutationGrant } from "./secret-mutation"

const credentialStorageUnavailable = () =>
  new AuthError({ message: "Secure credential storage is unavailable; provider credential changes are disabled" })

// §14.22 requires a trusted native input channel bound to the authenticated
// principal and the exact write operation. Put/rotate/revoke stay closed until
// a HostKernel `secret.v1` grant is supplied through CredentialMutationAuthorizer
// and validated against that exact binding.
const revokeIdempotencyKey = (secretRef: string, expectedVersion?: number) =>
  `revoke_${expectedVersion ?? "current"}_${createHash("sha256").update(secretRef).digest("hex")}`

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
  /**
   * Issue a one-use native-input handle bound to the trusted authenticated
   * principal and this exact write intent. The handle is never persisted.
   */
  readonly issueCredentialHandle: (input: {
    readonly bytes: Uint8Array
    readonly providerId: string
    readonly operation: "put" | "rotate" | "revoke"
    readonly expectedVersion?: number
    readonly idempotencyKey: string
    readonly secretRef?: SecretBrokerV1.SecretRef
  }) => Effect.Effect<string, AuthError>
  /** True only when a trusted grant channel and authenticated principal are installed. */
  readonly credentialMutationAvailable: () => Effect.Effect<boolean>
  readonly describeCredential: (secretRef: SecretBrokerV1.SecretRef) => Effect.Effect<SecretBrokerV1.MetadataV1, AuthError>
  /** Trusted, metadata-only Route → SecretRef projection for built-in search. */
  readonly searchCredentialRefs: () => Effect.Effect<Partial<Record<SearchCredentialRoute, SecretBrokerV1.SecretRef>>, AuthError>
  /** Metadata-only refs for provider IDs already resolved by the canonical provider registry. Presence is not dispatch authority. */
  readonly credentialRefsForProviders: (
    providerIDs: readonly string[],
  ) => Effect.Effect<Partial<Record<string, SecretBrokerV1.SecretRef>>, AuthError>
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
  /** Consume a HostKernel metadata grant in-process; the SecretBroker lease never leaves this service. */
  readonly dispatchAuthorizedSearchRequest: (input: {
    authorization: unknown
    scope: {
      sessionID: string
      locationID: string
      effectID: string
      challengeID: string
      capabilityLeaseDigest: string
      cascadeRef: string
      cascadeDigest: string
      directAttempt?: DirectAttemptScopeV1
      managedAttempt?: ManagedAttemptScopeV1
    }
    signal?: AbortSignal
  }) => Effect.Effect<AuthorizedSearchProviderResponseV1 & { receipt: SearchSecretAttemptReceiptV1 }, AuthError>
  /** Consume one exact managed provider permit before the existing bounded SecretBroker transport. */
  readonly dispatchAuthorizedManagedProviderRequest: (input: {
    authorization: ManagedProviderAuthorizationHandleV1
    expected: ManagedProviderSendPinsV1
    managedAttempt: ManagedAttemptScopeV1
    route: ManagedProviderRouteV1
    prepared: PreparedManagedProviderTransportV1
    signal?: AbortSignal
  }) => Effect.Effect<Response, AuthError>
  /** Bind a direct SDK fetch to one already pinned SessionStore request and one fixed route. */
  readonly createPinnedDirectProviderFetch: (input: {
    readonly prepared: PreparedDirectProviderTransportV1
    readonly journal: {
      readonly sessionID: string
      readonly requestID: string
      readonly pinDigest: string
      readonly state: "PINNED"
      readonly providerID: string
      readonly modelID: string
      readonly harnessID: string
      readonly routeRevision: string
      readonly endpointRevision: string
      readonly transportRequestDigest: string
    }
    readonly beginDispatch: () => Effect.Effect<{ readonly state: "DISPATCHING"; readonly pinDigest: string; readonly transportRequestDigest: string }>
    readonly markUnknown: (reason: string) => Effect.Effect<void>
    readonly signal?: AbortSignal
  }) => Effect.Effect<typeof fetch, AuthError>
  /** Core's private request-info/init seam; route pinning and auth remain inside Auth. */
  readonly dispatchPinnedDirectProviderRequest: (input: {
    readonly route: DirectProviderTransport.DirectProviderRouteV1
    readonly request: Request
    readonly pin: (input: DirectProviderTransport.DirectProviderPinV1) => Effect.Effect<DirectProviderTransport.DirectProviderJournalV1, unknown>
  }) => Effect.Effect<Response, AuthError>
}

export type SearchSecretAttemptReceiptV1 = {
  schemaVersion: 1
  attemptRef: string
  attemptDigest: string
  routeKey: string
  attempt: 1 | 2
  outcome: "SUCCEEDED" | "FAILED" | "RATE_LIMITED" | "RETRYABLE_FAILURE" | "EMPTY"
  httpStatus: number
  retryAfterMs: number | null
  resultCount: number | null
  bodyDigest: string | null
  bodyBytes: number
  responseComplete: boolean
  settledAtUnixMs: number
  receiptDigest: string
  status: "SETTLED"
}

function decodeSearchSecretAttemptReceipt(
  value: unknown,
  authorization: ReturnType<typeof decodeSearchSecretAuthorization>,
  response: AuthorizedSearchProviderResponseV1,
  outcome: SearchSecretAttemptReceiptV1["outcome"],
): SearchSecretAttemptReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("HostKernel search receipt is malformed")
  const receipt = value as Record<string, unknown>
  const keys = [
    "schemaVersion", "attemptRef", "attemptDigest", "routeKey", "attempt", "outcome", "httpStatus",
    "retryAfterMs", "resultCount", "bodyDigest", "bodyBytes", "responseComplete", "settledAtUnixMs",
    "receiptDigest", "status",
  ]
  if (Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.hasOwn(receipt, key)) ||
    receipt.schemaVersion !== 1 || receipt.attemptRef !== authorization.attemptRef ||
    receipt.attemptDigest !== authorization.attemptDigest || receipt.routeKey !== authorization.routeKey ||
    receipt.attempt !== authorization.attempt || receipt.outcome !== outcome || receipt.httpStatus !== response.status ||
    receipt.retryAfterMs !== response.retryAfterMs || receipt.resultCount !== (response.status >= 200 && response.status < 300
      ? searchSecretResultCount(authorization.routeKey, response.body) : null) ||
    receipt.bodyDigest !== response.bodyDigest || receipt.bodyBytes !== response.bodyBytes ||
    receipt.responseComplete !== response.complete || !Number.isSafeInteger(receipt.settledAtUnixMs) ||
    typeof receipt.receiptDigest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(receipt.receiptDigest) ||
    receipt.status !== "SETTLED") {
    throw new Error("HostKernel search receipt does not match the dispatched provider response")
  }
  return receipt as SearchSecretAttemptReceiptV1
}

/** Match HostKernel's fixed BYO result-array projection before durable receipt
 * settlement. This is bounded by the transport's 2 MiB body cap and does not
 * turn malformed or unknown provider JSON into an empty result. */
function searchSecretResultCount(routeKey: string, body: Uint8Array): number | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  if (root.isError === true || (Object.hasOwn(root, "error") && root.error !== null && root.error !== false && root.error !== "")) {
    return null
  }
  const web = typeof root.web === "object" && root.web !== null && !Array.isArray(root.web)
    ? root.web as Record<string, unknown> : undefined
  const results = typeof root.results === "object" && root.results !== null && !Array.isArray(root.results)
    ? root.results as Record<string, unknown> : undefined
  const rows = routeKey === "brave" ? web?.results
    : routeKey === "youcom" ? results?.web
      : routeKey === "exa" || routeKey === "tavily" || routeKey === "parallel" ? root.results
        : routeKey === "firecrawl" ? root.data
          : undefined
  return Array.isArray(rows) ? Math.min(rows.length, 10) : null
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

type CredentialBroker = Pick<
  ReturnType<typeof createLazyProductionCredentialBroker>,
  "put" | "describe" | "listByProviderIds" | "revoke" | "authorizeUse" | "withUse"
>

const SEARCH_CREDENTIAL_ROUTES = ["brave", "exa", "youcom", "tavily", "firecrawl", "parallel"] as const
export type SearchCredentialRoute = (typeof SEARCH_CREDENTIAL_ROUTES)[number]

async function projectSearchCredentialRefs(credentialBroker: CredentialBroker) {
  return projectCredentialRefs(credentialBroker, SEARCH_CREDENTIAL_ROUTES) as Promise<
    Partial<Record<SearchCredentialRoute, SecretBrokerV1.SecretRef>>
  >
}

async function projectCredentialRefs(credentialBroker: CredentialBroker, providerIDs: readonly string[]) {
  // Provider IDs must come from the already-resolved canonical provider catalog.
  // Use bounded chunks because catalogs commonly exceed SecretBroker's per-query
  // limit. The total work and returned record count remain bounded.
  if (providerIDs.length > 256 || providerIDs.some((id) => !/^[^\s\u0000-\u001f\u007f]{1,128}$/.test(id))) return {}
  const allowed = new Set(providerIDs)
  const unique = [...allowed]
  const records: SecretBrokerV1.MetadataV1[] = []
  for (let offset = 0; offset < unique.length; offset += 16) {
    records.push(...await credentialBroker.listByProviderIds(unique.slice(offset, offset + 16)))
    if (records.length > 256) return {}
  }
  const grouped = new Map<string, SecretBrokerV1.SecretRef[]>()
  for (const item of records) {
    if (item.status !== "AVAILABLE" || !allowed.has(item.providerId)) continue
    const refs = grouped.get(item.providerId) ?? []
    refs.push(item.secretRef)
    grouped.set(item.providerId, refs)
  }
  // Multiple active credentials make the route ambiguous. Omit it instead of
  // silently selecting an account or changing provider identity.
  return Object.fromEntries([...grouped].flatMap(([provider, refs]) => refs.length === 1 ? [[provider, refs[0]!]] : [])) as
    Partial<Record<string, SecretBrokerV1.SecretRef>>
}

/** P1 supplies this only after Guard has admitted the exact provider effect. */
export interface ProviderCredentialAuthorizer {
  authorize(input: SecretBrokerV1.UseRequestV1): Promise<TrustedSecretUseContext>
}

const credentialInput = new SecureInputVault()

export function makeService(
  credentialBroker: CredentialBroker,
  providerAuthorizer?: ProviderCredentialAuthorizer,
  supervisor?: SessionSupervisorInterface,
  mutationAuthorizer?: CredentialMutationAuthorizer,
  secureInput?: SecureInputVault,
  providerUseAuthorizer?: CredentialUseAuthorizer,
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
    putCredential: Effect.fn("Auth.putCredential")(function* (input: SecretBrokerV1.PutRequestV1) {
      if (!mutationAuthorizer) return yield* Effect.fail(credentialStorageUnavailable())
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(principal)) return yield* Effect.fail(credentialStorageUnavailable())
      const binding = putBinding(input, principal.value.principal)
      if (!binding) return yield* Effect.fail(credentialStorageUnavailable())
      const grant = yield* Effect.tryPromise({
        try: () => mutationAuthorizer.authorize(binding, principal.value.principal),
        catch: () => credentialStorageUnavailable(),
      })
      if (!exactMutationGrant(grant, binding)) return yield* Effect.fail(credentialStorageUnavailable())
      return yield* wrap(() => credentialBroker.put(input, binding))
    }),
    describeCredential: Effect.fn("Auth.describeCredential")((secretRef: SecretBrokerV1.SecretRef) =>
      wrap(() => credentialBroker.describe(secretRef)),
    ),
    searchCredentialRefs: Effect.fn("Auth.searchCredentialRefs")(() =>
      wrap(() => projectSearchCredentialRefs(credentialBroker)).pipe(
        Effect.catch(() => Effect.succeed({} as Partial<Record<SearchCredentialRoute, SecretBrokerV1.SecretRef>>)),
      ),
    ),
    credentialRefsForProviders: Effect.fn("Auth.credentialRefsForProviders")((providerIDs: readonly string[]) =>
      wrap(() => projectCredentialRefs(credentialBroker, providerIDs)).pipe(
        Effect.catch(() => Effect.succeed({} as Partial<Record<string, SecretBrokerV1.SecretRef>>)),
      ),
    ),
    revokeCredential: Effect.fn("Auth.revokeCredential")(function* (
      secretRef: SecretBrokerV1.SecretRef,
      expectedVersion?: number,
    ) {
      if (!mutationAuthorizer) return yield* Effect.fail(credentialStorageUnavailable())
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(principal)) return yield* Effect.fail(credentialStorageUnavailable())
      const current = yield* wrap(() => credentialBroker.describe(secretRef))
      const binding = mutationBinding(principal.value.principal, {
        providerId: current.providerId,
        operation: "revoke",
        expectedVersion,
        secretRef,
        idempotencyKey: revokeIdempotencyKey(secretRef, expectedVersion),
      })
      if (!binding) return yield* Effect.fail(credentialStorageUnavailable())
      const grant = yield* Effect.tryPromise({
        try: () => mutationAuthorizer.authorize(binding, principal.value.principal),
        catch: () => credentialStorageUnavailable(),
      })
      if (!exactMutationGrant(grant, binding)) return yield* Effect.fail(credentialStorageUnavailable())
      return yield* wrap(() => credentialBroker.revoke(secretRef, expectedVersion))
    }),
    issueCredentialHandle: Effect.fn("Auth.issueCredentialHandle")(function* (input: {
      readonly bytes: Uint8Array
      readonly providerId: string
      readonly operation: "put" | "rotate" | "revoke"
      readonly expectedVersion?: number
      readonly idempotencyKey: string
      readonly secretRef?: SecretBrokerV1.SecretRef
    }) {
      if (!secureInput) {
        input.bytes.fill(0)
        return yield* Effect.fail(credentialStorageUnavailable())
      }
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isNone(principal)) {
        input.bytes.fill(0)
        return yield* Effect.fail(credentialStorageUnavailable())
      }
      const binding = mutationBinding(principal.value.principal, input)
      if (!binding) {
        input.bytes.fill(0)
        return yield* Effect.fail(credentialStorageUnavailable())
      }
      return yield* Effect.tryPromise({
        try: async () => secureInput.issue(input.bytes, binding),
        catch: () => new AuthError({ message: "Secure credential input is unavailable" }),
      })
    }),
    credentialMutationAvailable: Effect.fn("Auth.credentialMutationAvailable")(function* () {
      if (!mutationAuthorizer || !secureInput) return false
      const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
      return !Option.isNone(principal) && principalRefOf(principal.value.principal) !== undefined
    }),
    authorizeCredentialUse: Effect.fn("Auth.authorizeCredentialUse")((input: SecretBrokerV1.UseRequestV1) => {
      if (!providerAuthorizer) {
        return Effect.fail(new AuthError({ message: "Guarded provider credential authorization is unavailable" }))
      }
      return wrap(async () => credentialBroker.authorizeUse(input, await providerAuthorizer.authorize(input)))
    }),

    dispatchAuthorizedSearchRequest: Effect.fn("Auth.dispatchAuthorizedSearchRequest")((input: {
      authorization: unknown
      scope: {
        sessionID: string
        locationID: string
        effectID: string
        challengeID: string
        capabilityLeaseDigest: string
        cascadeRef: string
        cascadeDigest: string
        directAttempt?: DirectAttemptScopeV1
        managedAttempt?: ManagedAttemptScopeV1
      }
      signal?: AbortSignal
    }) => {
      if (!supervisor) {
        return Effect.fail(new AuthError({ message: "Guarded provider request dispatch is unavailable" }))
      }
      return Effect.tryPromise({
        try: async () => {
          const authorization = decodeSearchSecretAuthorization(input.authorization)
          const scope = input.scope
          const validID = (value: unknown) => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(value)
          if (!scope || !validID(scope.sessionID) || !validID(scope.locationID) || !validID(scope.effectID) ||
            !validID(scope.challengeID) || !/^blake3:[a-f0-9]{64}$/.test(scope.capabilityLeaseDigest) ||
            !/^search_cascade_[a-f0-9]{64}$/.test(scope.cascadeRef) || !/^blake3:[a-f0-9]{64}$/.test(scope.cascadeDigest) ||
            (scope.directAttempt === undefined) === (scope.managedAttempt === undefined)) {
            throw new Error("Guarded provider request scope is invalid")
          }
          const context = {
            sessionID: scope.sessionID,
            locationID: scope.locationID,
            effectID: scope.effectID,
            challengeID: scope.challengeID,
            capabilityLeaseDigest: scope.capabilityLeaseDigest,
            cascadeRef: scope.cascadeRef,
            cascadeDigest: scope.cascadeDigest,
            attemptRef: authorization.attemptRef,
            attemptDigest: authorization.attemptDigest,
            routeKey: authorization.routeKey,
            attempt: authorization.attempt,
            ...(scope.directAttempt === undefined ? {} : { directAttempt: scope.directAttempt }),
            ...(scope.managedAttempt === undefined ? {} : { managedAttempt: scope.managedAttempt }),
          }
          const requestHostKernel = (operation: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal) => {
            const request = supervisor!.requestHostKernel("execution.v1", operation, body)
            return signal ? Effect.runPromise(request, { signal }) : Effect.runPromise(request)
          }
          let dispatchPermit: Readonly<Record<string, unknown>>
          try {
            dispatchPermit = await requestHostKernel("begin_search_secret_dispatch", context, input.signal)
            decodeSearchDispatchPermit(dispatchPermit, authorization)
          } catch (error) {
            // begin may have committed even when its response was lost. No send
            // follows a missing or malformed permit; reconcile as UNKNOWN.
            await requestHostKernel("mark_search_secret_attempt_unknown", context).catch(() => undefined)
            throw error
          }
          let response: AuthorizedSearchProviderResponseV1
          try {
            response = await dispatchAuthorizedSearchRequest({
              broker: credentialBroker,
              authorization,
              dispatchPermit,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            })
          } catch (error) {
            await requestHostKernel("mark_search_secret_attempt_unknown", context).catch(() => undefined)
            throw error
          }
          const resultCount = response.status >= 200 && response.status < 300
            ? searchSecretResultCount(authorization.routeKey, response.body) : null
          const outcome = response.status >= 200 && response.status < 300
            ? resultCount === 0 ? "EMPTY" : resultCount !== null ? "SUCCEEDED" : "FAILED"
            : response.status === 429 ? "RATE_LIMITED"
              : response.status >= 500 ? "RETRYABLE_FAILURE" : "FAILED"
          try {
            const rawReceipt = await requestHostKernel("settle_search_secret_attempt", {
              ...context,
              outcome,
              httpStatus: response.status,
              retryAfterMs: response.retryAfterMs,
              resultCount,
              bodyDigest: response.bodyDigest,
              bodyBytes: response.bodyBytes,
              responseComplete: response.complete,
            }, input.signal)
            const receipt = decodeSearchSecretAttemptReceipt(rawReceipt, authorization, response, outcome)
            return { ...response, receipt }
          } catch (error) {
            // The response may be complete while durable settlement is not.
            // Never resend; preserve uncertainty at the host boundary.
            await requestHostKernel("mark_search_secret_attempt_unknown", context).catch(() => undefined)
            throw error
          }
        },
        catch: () => new AuthError({ message: "Guarded provider request is unavailable" }),
      })
    }),
    dispatchAuthorizedManagedProviderRequest: Effect.fn("Auth.dispatchAuthorizedManagedProviderRequest")((input: {
      authorization: ManagedProviderAuthorizationHandleV1
      expected: ManagedProviderSendPinsV1
      managedAttempt: ManagedAttemptScopeV1
      route: ManagedProviderRouteV1
      prepared: PreparedManagedProviderTransportV1
      signal?: AbortSignal
    }) => {
      if (!supervisor) {
        return Effect.fail(new AuthError({ message: "Guarded managed provider dispatch is unavailable" }))
      }
      return Effect.tryPromise({
        try: async () => {
          const scope = input.managedAttempt
          const requestHostKernel = (operation: string, body: Readonly<Record<string, unknown>>) => {
            const request = supervisor!.requestHostKernel("managed.v1", operation, body)
            return input.signal ? Effect.runPromise(request, { signal: input.signal }) : Effect.runPromise(request)
          }
          return dispatchManagedProviderTransport({
            broker: credentialBroker,
            handle: input.authorization,
            expected: input.expected,
            route: input.route,
            prepared: input.prepared,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            consumeAuthorization: async (authorization: ManagedProviderSendPermitV1) => {
              if (scope.attemptID !== authorization.attemptID || scope.ownerEpoch !== authorization.ownerEpoch ||
                scope.requestID !== authorization.requestID || scope.requestSequence !== authorization.requestSequence ||
                scope.contextSelectionDigest !== authorization.contextSelectionDigest) {
                throw new Error("Managed provider authorization differs from the live Attempt scope")
              }
              const raw = await requestHostKernel("managed_provider.consume_send_authorization", {
                managedAttempt: scope,
                routeProjection: {
                  providerID: authorization.providerID,
                  modelID: authorization.modelID,
                  harnessID: authorization.harnessID,
                  routeID: authorization.routeID,
                  endpointRevision: authorization.endpointRevision,
                  credentialLeaseRef: authorization.credentialLeaseRef,
                },
                requestPins: {
                  requestID: authorization.requestID,
                  requestSequence: authorization.requestSequence,
                  contextSelectionDigest: authorization.contextSelectionDigest,
                  requestDigest: authorization.requestDigest,
                  transportRequestDigest: authorization.transportRequestDigest,
                  operationDigest: authorization.operationDigest,
                },
                providerRequestID: authorization.providerRequestID,
                prepareDigest: authorization.prepareDigest,
                dispatchDigest: authorization.dispatchDigest,
                guardChallengeID: authorization.guardChallengeID,
                effectID: authorization.effectID,
                capabilityLeaseDigest: authorization.capabilityLeaseDigest,
                authorizationBindingDigest: authorization.authorizationBindingDigest,
                sendAuthorization: authorization.sendAuthorization,
                secretUseContext: authorization.secretUseContext,
              })
              if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                throw new Error("HostKernel managed provider consume receipt is malformed")
              }
              const receipt = raw as Record<string, unknown>
              const keys = ["status", "providerRequestID", "dispatchDigest", "transportRequestDigest", "operationDigest"].toSorted()
              if (Object.keys(receipt).toSorted().join("\0") !== keys.join("\0") || receipt.status !== "CONSUMED" ||
                receipt.providerRequestID !== authorization.providerRequestID || receipt.dispatchDigest !== authorization.dispatchDigest ||
                receipt.transportRequestDigest !== authorization.transportRequestDigest || receipt.operationDigest !== authorization.operationDigest) {
                throw new Error("HostKernel managed provider consume receipt changed exact request pins")
              }
            },
            markUnknown: async (authorization: ManagedProviderSendPermitV1, reasonCode: string) => {
              await requestHostKernel("managed_provider.unknown", {
                managedAttempt: scope,
                routeProjection: {
                  providerID: authorization.providerID,
                  modelID: authorization.modelID,
                  harnessID: authorization.harnessID,
                  routeID: authorization.routeID,
                  endpointRevision: authorization.endpointRevision,
                  credentialLeaseRef: authorization.credentialLeaseRef,
                },
                requestPins: {
                  requestID: authorization.requestID,
                  requestSequence: authorization.requestSequence,
                  contextSelectionDigest: authorization.contextSelectionDigest,
                  requestDigest: authorization.requestDigest,
                  transportRequestDigest: authorization.transportRequestDigest,
                  operationDigest: authorization.operationDigest,
                },
                providerRequestID: authorization.providerRequestID,
                prepareDigest: authorization.prepareDigest,
                dispatchDigest: authorization.dispatchDigest,
                guardChallengeID: authorization.guardChallengeID,
                effectID: authorization.effectID,
                capabilityLeaseDigest: authorization.capabilityLeaseDigest,
                authorizationBindingDigest: authorization.authorizationBindingDigest,
                reasonCode,
              })
            },
            send: async (request) => {
              const response = await fetch(request.url, {
                method: request.method,
                headers: request.headers,
                ...(request.method === "GET" ? {} : { body: request.body }),
                signal: request.signal,
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                referrerPolicy: "no-referrer",
              })
              return {
                status: response.status,
                headers: response.headers,
                body: managedProviderResponseBytes(response),
              }
            },
          })
        },
        catch: () => new AuthError({ message: "Guarded managed provider request is unavailable" }),
      })
    }),
    createPinnedDirectProviderFetch: Effect.fn("Auth.createPinnedDirectProviderFetch")(function* (input: {
      prepared: PreparedDirectProviderTransportV1
      journal: {
        sessionID: string
        requestID: string
        pinDigest: string
        state: "PINNED"
        providerID: string
        modelID: string
        harnessID: string
        routeRevision: string
        endpointRevision: string
        transportRequestDigest: string
      }
      beginDispatch: () => Effect.Effect<{ state: "DISPATCHING"; pinDigest: string; transportRequestDigest: string }>
      markUnknown: (reason: string) => Effect.Effect<void>
      signal?: AbortSignal
    }) {
      const route = input.prepared.route
      const journal = input.journal
      if (journal.state !== "PINNED" || !/^blake3:[a-f0-9]{64}$/.test(journal.pinDigest) ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(journal.sessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(journal.requestID) ||
        journal.providerID !== route.providerID || journal.modelID !== route.modelID || journal.harnessID !== route.harnessID ||
        journal.routeRevision !== route.routeRevision || journal.endpointRevision !== route.endpointRevision ||
        journal.transportRequestDigest !== input.prepared.transportRequestDigest) {
        return yield* Effect.fail(new AuthError({ message: "Direct provider request differs from its immutable SessionStore pin" }))
      }
      return createPinnedDirectProviderFetch({
        prepared: input.prepared,
        expectedPinDigest: journal.pinDigest,
        expectedTransportDigest: journal.transportRequestDigest,
        journalState: journal.state,
        beginDispatch: () => Effect.runPromise(input.beginDispatch()),
        markUnknown: (reason) => Effect.runPromise(input.markUnknown(reason)),
        send: (request) => fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "GET" || request.body === "" ? {} : { body: request.body }),
          signal: request.signal,
          redirect: "error",
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }),
    dispatchPinnedDirectProviderRequest: Effect.fn("Auth.dispatchPinnedDirectProviderRequest")(function* (input: {
      route: DirectProviderTransport.DirectProviderRouteV1
      request: Request
      pin: (input: DirectProviderTransport.DirectProviderPinV1) => Effect.Effect<DirectProviderTransport.DirectProviderJournalV1, unknown>
    }) {
      const principalOption = yield* Effect.serviceOption(TrustedPrincipalContext)
      const principal = Option.isSome(principalOption) ? principalOption.value.principal : undefined
      const route: DirectProviderRouteV1 = {
        ...input.route,
        anonymousOpenCodeFree: input.route.providerID === "opencode",
        ...(input.route.providerID === "openrouter" &&
          input.route.modelID === "nvidia/nemotron-3.5-super-vl:free" &&
          input.route.endpointBase === "https://openrouter.ai/api/v1"
          ? { explicitFreeCredential: true as const }
          : {}),
        credentialHeader: { name: "authorization", prefix: "Bearer " },
      }
      const credentialedFree = route.explicitFreeCredential === true
      if (credentialedFree && (!providerUseAuthorizer || principal?.kind !== "server_auth" || !principal.subject)) {
        return yield* Effect.fail(new AuthError({ message: "Pinned free-provider use requires the same authenticated ServerAuth owner" }))
      }
      return yield* Effect.tryPromise({
        try: async () => {
          const prepared = await prepareDirectProviderTransportRequest({ route, input: input.request })
          const journal = await Effect.runPromise(input.pin({
            endpointRevision: prepared.route.endpointRevision,
            transportRequestDigest: prepared.transportRequestDigest,
          }))
          if (journal.state !== "PINNED" || !/^[A-Za-z0-9._:-]{1,256}$/.test(journal.sessionID) ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(journal.requestID) || !/^blake3:[a-f0-9]{64}$/.test(journal.pinDigest) ||
            journal.providerID !== prepared.route.providerID ||
            journal.modelID !== prepared.route.modelID || journal.harnessID !== prepared.route.harnessID ||
            journal.routeRevision !== prepared.route.routeRevision || journal.endpointRevision !== prepared.route.endpointRevision ||
            journal.transportRequestDigest !== prepared.transportRequestDigest) {
            throw new SecretBrokerError("CONFLICT", "Direct provider request differs from its durable Core journal pin")
          }
          const requestFetch = createPinnedDirectProviderFetch({
            prepared,
            expectedPinDigest: journal.pinDigest,
            expectedTransportDigest: journal.transportRequestDigest,
            journalState: journal.state,
            beginDispatch: () => Effect.runPromise(journal.beginDispatch()),
            markUnknown: (reason) => Effect.runPromise(journal.markUnknown(reason)),
            send: async (request) => {
              const sendRequest = (authorized: ProviderTransportRequest) => fetch(authorized.url, {
                method: authorized.method,
                headers: authorized.headers,
                ...(authorized.method === "GET" || authorized.body === "" ? {} : { body: authorized.body }),
                signal: authorized.signal,
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                referrerPolicy: "no-referrer",
              })
              if (!credentialedFree) {
                return sendRequest(request)
              }
              const actualDigest = providerRequestDigest({
                ...prepared.transport,
                method: request.method,
                destination: request.url,
                body: request.body,
                headers: request.headers,
              })
              if (actualDigest !== providerRequestDigest(prepared.transport)) {
                throw new SecretBrokerError("CONFLICT", "Pinned OpenRouter request changed before credential use")
              }
              const refs = await projectCredentialRefs(credentialBroker, ["openrouter"])
              const secretRef = refs.openrouter
              if (!secretRef || !providerUseAuthorizer || !principal) {
                throw new SecretBrokerError("UNAVAILABLE", "A unique owner-scoped OpenRouter SecretBroker credential is unavailable")
              }
              return dispatchDirectFreeProviderTransport({
                broker: credentialBroker,
                authorizer: providerUseAuthorizer,
                principal,
                secretRef,
                prepared,
                signal: input.request.signal,
                send: sendRequest,
              })
            },
            signal: input.request.signal,
          })
          return requestFetch(input.request)
        },
        catch: () => new AuthError({ message: "Pinned direct provider transport is unavailable" }),
      })
    }),
  })
}

async function* managedProviderResponseBytes(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

// Legacy auth.json and OPENCODE_AUTH_CONTENT contain raw provider secrets.
// They remain untouched, but are not an authoritative credential source.
// Credentials become available only through a canonical SecretBroker store.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const broker = createLazyProductionCredentialBroker({ directory: Global.Path.data, secureInput: credentialInput })
    const supervisor = yield* SessionSupervisor.Service
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        credentialInput.close()
        await broker.close()
      }),
    )
    // Production grant channel: every credential mutation must obtain an exact
    // HostKernel `secret.v1` grant for the trusted principal before the broker
    // can write. A `host_os` principal sends no typed ServerAuth principal, so
    // the kernel identifies the local CLI by its SO_PEERCRED uid; a
    // `server_auth` principal is asserted as AuthenticatedPrincipalV1::ServerAuth.
    const mutationAuthorizer = makeCredentialMutationAuthorizer((serviceID, operation, body, principal) =>
      Effect.runPromise(supervisor.requestHostKernel(serviceID, operation, body, { trustedPrincipal: principal })),
    )
    const providerUseAuthorizer = makeCredentialUseAuthorizer((serviceID, operation, body, principal) =>
      Effect.runPromise(supervisor.requestHostKernel(serviceID, operation, body, { trustedPrincipal: principal })),
    )
    return makeService(broker, undefined, supervisor, mutationAuthorizer, credentialInput, providerUseAuthorizer)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [SessionSupervisor.node] })

export * as Auth from "."
