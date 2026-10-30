export * as ServerAuth from "./auth"

import { isTrustedLoopbackPeer as trustedLoopbackPeer } from "@horizoncode/server/auth"
import { ConfigService } from "@/effect/config-service"
import { Flag } from "@horizoncode/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
  reviewerPassword: EffectConfig.string("OPENCODE_SERVER_REVIEWER_PASSWORD").pipe(EffectConfig.option),
  reviewerUsername: EffectConfig.string("OPENCODE_SERVER_REVIEWER_USERNAME").pipe(EffectConfig.option),
}) {}

export type Info = Context.Service.Shape<typeof Config>

/**
 * Peer trust is decided once, in the shared server auth owner: a loopback peer is only
 * trusted when the address proves it and no proxy header rewrote the origin.
 */
export function isTrustedLoopbackPeer(remoteAddress: string | undefined, headers: object) {
  return trustedLoopbackPeer(remoteAddress, headers)
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

/** Authentication is configured only when `required()` holds, i.e. a non-empty
 * password. An unset *or empty* configured password must never authorize a
 * guessed credential pair: `Some("") === ""` would otherwise mint a
 * `server_auth` identity for any peer from the trivially guessable
 * `opencode:` header, while the middleware simultaneously reports auth as
 * not configured. Identity then comes solely from the trusted-loopback rule. */
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (!required(config)) return false
  const primary =
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  return primary || reviewerAuthorized(credentials, config)
}

/** The optional reviewer credential is valid only as a complete, distinct pair
 * alongside the normal ServerAuth account. This does not create an identity from
 * a request body: middleware returns the username that actually authenticated.
 */
export function reviewerConfigured(config: Info) {
  return (
    required(config) &&
    Option.isSome(config.reviewerUsername) &&
    Option.isSome(config.reviewerPassword) &&
    config.reviewerUsername.value.length > 0 &&
    config.reviewerPassword.value.length > 0 &&
    config.reviewerUsername.value !== config.username &&
    Option.isSome(config.password) &&
    config.reviewerPassword.value !== config.password.value
  )
}

function reviewerAuthorized(credentials: DecodedCredentials, config: Info) {
  return (
    reviewerConfigured(config) &&
    Option.isSome(config.reviewerUsername) &&
    Option.isSome(config.reviewerPassword) &&
    credentials.username === config.reviewerUsername.value &&
    Redacted.value(credentials.password) === config.reviewerPassword.value
  )
}

export function authenticatedUsername(credentials: DecodedCredentials, config: Info) {
  if (!authorized(credentials, config)) return undefined
  if (reviewerAuthorized(credentials, config)) return Option.getOrUndefined(config.reviewerUsername)
  return config.username
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
