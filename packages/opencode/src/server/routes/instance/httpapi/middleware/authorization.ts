import { ServerAuth } from "@/server/auth"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@opencode-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function trustedContext(
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  const username = ServerAuth.authenticatedUsername(credential, config)
  if (username) return { principal: { kind: "server_auth" as const, subject: username } }
  const address = Option.getOrUndefined(request.remoteAddress)
  if (ServerAuth.isTrustedLoopbackPeer(address, request.headers)) return { principal: { kind: "host_os" as const } }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    if (ServerAuth.required(config) && !ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    const context = trustedContext(request, credential, config)
    return context ? yield* Effect.provideService(effect, TrustedPrincipalContext, context) : yield* effect
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
) {
  if (ServerAuth.required(config) && !ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  const context = trustedContext(request, credential, config)
  return context ? Effect.provideService(effect, TrustedPrincipalContext, context) : effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (request.method === "GET" && url.pathname !== "/doc") return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config, request)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, request)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, request)),
        )
      }),
    )
  }),
)

