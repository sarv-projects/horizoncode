import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@horizoncode/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the opencode username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = {
      password: Option.some("secret"),
      username: "alice",
      reviewerPassword: Option.none<string>(),
      reviewerUsername: Option.none<string>(),
    }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("authenticates a configured distinct reviewer and returns the identity that authenticated", () => {
    const config = {
      password: Option.some("executor-secret"),
      username: "executor",
      reviewerPassword: Option.some("reviewer-secret"),
      reviewerUsername: Option.some("reviewer"),
    }
    const reviewer = { username: "reviewer", password: Redacted.make("reviewer-secret") }
    expect(ServerAuth.reviewerConfigured(config)).toBe(true)
    expect(ServerAuth.authorized(reviewer, config)).toBe(true)
    expect(ServerAuth.authenticatedUsername(reviewer, config)).toBe("reviewer")
    expect(ServerAuth.authenticatedUsername({ username: "executor", password: Redacted.make("executor-secret") }, config)).toBe(
      "executor",
    )
    expect(ServerAuth.authorized({ username: "reviewer", password: Redacted.make("wrong") }, config)).toBe(false)
  })

  test("refuses incomplete or non-distinct reviewer credentials", () => {
    const primary = { password: Option.some("executor-secret"), username: "executor" }
    for (const reviewer of [
      { reviewerUsername: Option.some("reviewer"), reviewerPassword: Option.none<string>() },
      { reviewerUsername: Option.none<string>(), reviewerPassword: Option.some("reviewer-secret") },
      { reviewerUsername: Option.some("executor"), reviewerPassword: Option.some("reviewer-secret") },
      { reviewerUsername: Option.some("reviewer"), reviewerPassword: Option.some("executor-secret") },
    ]) {
      const config = { ...primary, ...reviewer }
      expect(ServerAuth.reviewerConfigured(config)).toBe(false)
      expect(ServerAuth.authorized({ username: "reviewer", password: Redacted.make("reviewer-secret") }, config)).toBe(false)
    }
  })
})
