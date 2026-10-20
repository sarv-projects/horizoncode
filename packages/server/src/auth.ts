export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { isIP } from "node:net"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly reviewerPassword: Option.Option<string>
  readonly reviewerUsername: Option.Option<string>
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
            reviewerPassword: EffectConfig.string("OPENCODE_SERVER_REVIEWER_PASSWORD").pipe(EffectConfig.option),
            reviewerUsername: EffectConfig.string("OPENCODE_SERVER_REVIEWER_USERNAME").pipe(EffectConfig.option),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

/** Reviewer auth is an optional second identity, enabled only as a complete pair
 * distinct from the primary credentials. */
export function reviewerConfigured(config: Info) {
  return (
    required(config) &&
    Option.isSome(config.password) &&
    Option.isSome(config.reviewerUsername) &&
    Option.isSome(config.reviewerPassword) &&
    config.reviewerUsername.value.length > 0 &&
    config.reviewerPassword.value.length > 0 &&
    config.reviewerUsername.value !== config.username &&
    config.reviewerPassword.value !== config.password.value
  )
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  const primary = (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
  const reviewer =
    reviewerConfigured(config) &&
    Option.isSome(config.reviewerUsername) &&
    Option.isSome(config.reviewerPassword) &&
    credentials.username === config.reviewerUsername.value &&
    Redacted.value(credentials.password) === config.reviewerPassword.value
  return primary || reviewer
}

/** Returns only the identity whose configured credential actually authenticated. */
export function authenticatedUsername(credentials: DecodedCredentials, config: Info) {
  if (!authorized(credentials, config)) return undefined
  if (
    reviewerConfigured(config) &&
    Option.isSome(config.reviewerUsername) &&
    Option.isSome(config.reviewerPassword) &&
    credentials.username === config.reviewerUsername.value &&
    Redacted.value(credentials.password) === config.reviewerPassword.value
  )
    return config.reviewerUsername.value
  return config.username
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}


function ipv6Words(address: string) {
  if (isIP(address) !== 6) return
  const normalized = address.toLowerCase()
  const halves = normalized.split("::")
  if (halves.length > 2) return
  let left = halves[0] ? halves[0].split(":") : []
  let right = halves[1] ? halves[1].split(":") : []
  if (halves.length === 1) {
    right = left
    left = []
  }
  const last = right.at(-1)
  if (last?.includes(".")) {
    if (isIP(last) !== 4) return
    const octets = last.split(".").map(Number)
    right = [
      ...right.slice(0, -1),
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ]
  }
  const gap = 8 - left.length - right.length
  if (halves.length === 1 && gap !== 0) return
  if (halves.length === 2 && gap < 1) return
  const expanded = [...left, ...Array(Math.max(gap, 0)).fill("0"), ...right]
  if (expanded.length !== 8 || expanded.some((word) => !/^[\da-f]{1,4}$/.test(word))) return
  return expanded.map((word) => Number.parseInt(word, 16))
}

export function isTrustedLoopbackPeer(remoteAddress: string | undefined, headers: object) {
  if (
    !remoteAddress ||
    Object.keys(headers).some((key) => {
      const name = key.toLowerCase()
      return name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-")
    })
  )
    return false

  if (isIP(remoteAddress) === 4 && Number(remoteAddress.split(".", 1)[0]) === 127) return true
  const words = ipv6Words(remoteAddress)
  if (!words) return false
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
  return (
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff &&
    words[6] >> 8 === 127
  )
}
