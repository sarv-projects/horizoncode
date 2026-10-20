import { Config, Effect, Redacted } from "effect"
import { Headers } from "effect/unstable/http"
import { AuthenticationReason, InvalidRequestReason, LLMError, type LLMRequest } from "../schema"

export class MissingCredentialError extends Error {
  readonly _tag = "MissingCredentialError"

  constructor(readonly source: string) {
    super(`Missing auth credential: ${source}`)
  }
}

export type CredentialError = MissingCredentialError | Config.ConfigError
export type AuthError = CredentialError | LLMError
type Secret = string | Redacted.Redacted | Config.Config<string | Redacted.Redacted>

export interface AuthInput {
  readonly request: LLMRequest
  readonly method: "POST" | "GET"
  readonly url: string
  readonly body: string
  readonly headers: Headers.Headers
}

export interface Credential {
  readonly load: Effect.Effect<Redacted.Redacted, CredentialError>
  readonly orElse: (that: Credential) => Credential
  readonly bearer: () => Auth
  readonly header: (name: string) => Auth
  readonly pipe: <A>(f: (self: Credential) => A) => A
}

export interface Auth {
  readonly apply: (input: AuthInput) => Effect.Effect<Headers.Headers, AuthError>
  /**
   * Resolves auth for one request while the supplied dispatch is in scope.
   * Implementations with one-use credentials override this to keep the lease
   * alive only for the outbound request and to avoid returning secret headers.
   */
  readonly withRequest: <Value>(
    input: AuthInput,
    dispatch: (headers: Headers.Headers) => Effect.Effect<Value, AuthError>,
  ) => Effect.Effect<Value, AuthError>
  readonly andThen: (that: Auth) => Auth
  readonly orElse: (that: Auth) => Auth
  readonly pipe: <A>(f: (self: Auth) => A) => A
}

export const isAuth = (input: unknown): input is Auth =>
  typeof input === "object" && input !== null && "apply" in input && typeof input.apply === "function"

const credential = (load: Effect.Effect<Redacted.Redacted, CredentialError>): Credential => {
  const self: Credential = {
    load,
    orElse: (that) => credential(load.pipe(Effect.catch(() => that.load))),
    bearer: () => fromCredential(self, (secret) => ({ authorization: `Bearer ${secret}` })),
    header: (name) => fromCredential(self, (secret) => ({ [name]: secret })),
    pipe: (f) => f(self),
  }
  return self
}

const auth = (apply: Auth["apply"], withRequest?: Auth["withRequest"]): Auth => {
  const self: Auth = {
    apply,
    withRequest: withRequest ?? ((input, dispatch) => apply(input).pipe(Effect.flatMap(dispatch))),
    andThen: (that) =>
      auth(
        (input) => apply(input).pipe(Effect.flatMap((headers) => that.apply({ ...input, headers }))),
        (input, dispatch) => self.withRequest(input, (headers) => that.withRequest({ ...input, headers }, dispatch)),
      ),
    orElse: (that) =>
      auth(
        (input) => apply(input).pipe(Effect.catch(() => that.apply(input))),
        (input, dispatch) => {
          let dispatched = false
          return self.withRequest(input, (headers) => {
            dispatched = true
            return dispatch(headers)
          }).pipe(Effect.catch((error) => (dispatched ? Effect.fail(error) : that.withRequest(input, dispatch))))
        },
      ),
    pipe: (f) => f(self),
  }
  return self
}

const fromCredential = (source: Credential, render: (secret: string) => Headers.Input) =>
  auth((input) =>
    source.load.pipe(Effect.map((secret) => Headers.setAll(input.headers, render(Redacted.value(secret))))),
  )

const secretEffect = (secret: string | Redacted.Redacted, source: string) => {
  const redacted = typeof secret === "string" ? Redacted.make(secret) : secret
  if (Redacted.value(redacted) === "") return Effect.fail(new MissingCredentialError(source))
  return Effect.succeed(redacted)
}

const credentialFromSecret = (secret: Secret, source: string) => {
  if (typeof secret === "string" || Redacted.isRedacted(secret)) return credential(secretEffect(secret, source))
  return credential(
    Effect.gen(function* () {
      return yield* secretEffect(yield* secret, source)
    }),
  )
}

export const value = (secret: string, source = "value") => credentialFromSecret(secret, source)

export const optional = (secret: Secret | undefined, source = "optional value") =>
  secret === undefined
    ? credential(Effect.fail(new MissingCredentialError(source)))
    : credentialFromSecret(secret, source)

export const config = (name: string) => credentialFromSecret(Config.redacted(name), name)

export const effect = (load: Effect.Effect<Redacted.Redacted, CredentialError>) => credential(load)

export const none = auth((input) => Effect.succeed(input.headers))

export const headers = (input: Headers.Input) =>
  auth((inputAuth) => Effect.succeed(Headers.setAll(inputAuth.headers, input)))

export const remove = (name: string) => auth((input) => Effect.succeed(Headers.remove(input.headers, name)))

export const custom = (apply: (input: AuthInput) => Effect.Effect<Headers.Headers, LLMError>) => auth(apply)

/**
 * Creates auth that can only be resolved at dispatch time. Calling `apply`
 * fails closed; the callback receives headers only within the single request
 * dispatch scope and must not retain them.
 */
export const requestScoped = (withRequest: Auth["withRequest"]) =>
  auth(
    () =>
      Effect.fail(
        new LLMError({
          module: "Auth",
          method: "apply",
          reason: new AuthenticationReason({
            message: "Request-scoped credentials are unavailable outside transport dispatch",
            kind: "missing",
          }),
        }),
      ),
    withRequest,
  )

export const passthrough = none

const credentialInput = (source: Secret | Credential) =>
  typeof source === "string" || Redacted.isRedacted(source) || Config.isConfig(source)
    ? credentialFromSecret(source, "value")
    : source

export function bearer(source: Secret | Credential): Auth
export function bearer(source: Secret | Credential) {
  return credentialInput(source).bearer()
}

export const apiKey = bearer

export function header(name: string): (source: Secret | Credential) => Auth
export function header(name: string, source: Secret | Credential): Auth
export function header(name: string, source?: Secret | Credential) {
  if (source === undefined) {
    return (next: Secret | Credential) => credentialInput(next).header(name)
  }
  return credentialInput(source).header(name)
}

export function bearerHeader(name: string): (source: Secret | Credential) => Auth
export function bearerHeader(name: string, source: Secret | Credential): Auth
export function bearerHeader(name: string, source?: Secret | Credential) {
  const render = (input: Secret | Credential) =>
    fromCredential(credentialInput(input), (secret) => ({ [name]: `Bearer ${secret}` }))
  if (source === undefined) return render
  return render(source)
}

const toLLMError = (error: AuthError): LLMError => {
  if (error instanceof MissingCredentialError || error instanceof Config.ConfigError) {
    return new LLMError({
      module: "Auth",
      method: "apply",
      reason:
        error instanceof MissingCredentialError
          ? new AuthenticationReason({ message: error.message, kind: "missing" })
          : new InvalidRequestReason({ message: `Failed to resolve auth config: ${error.message}` }),
    })
  }
  return error
}

export const toEffect =
  (input: Auth) =>
  (authInput: AuthInput): Effect.Effect<Headers.Headers, LLMError> =>
    input.apply(authInput).pipe(Effect.mapError(toLLMError))

export const withRequestEffect = <Value>(
  input: Auth,
  authInput: AuthInput,
  dispatch: (headers: Headers.Headers) => Effect.Effect<Value, AuthError>,
) => input.withRequest(authInput, dispatch).pipe(Effect.mapError(toLLMError))

export * as Auth from "./auth"
