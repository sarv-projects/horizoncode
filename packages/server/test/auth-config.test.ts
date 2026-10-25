import { describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { ServerAuth } from "../src/auth"

/**
 * Construction coverage for the exact `ServerAuth.Info` values the programmatic
 * route entry points (`createRoutes` / `createEmbeddedRoutes`) pass to
 * `ServerAuth.Config.configLayer`. No HTTP harness is needed: the regression
 * under test is a producer omitting the required reviewer-identity fields, and
 * the semantic contract is that these entry points are primary-only.
 */
describe("programmatic ServerAuth.Info for the route entry points", () => {
  const configured = ServerAuth.primaryOnlyInfo(Option.some("secret"))
  const embedded = ServerAuth.primaryOnlyInfo(Option.none())

  test("states reviewer identity explicitly as absent instead of omitting it", () => {
    // The Info contract requires both reviewer fields; a producer that forgets
    // them is exactly the TS2739 regression this factory prevents.
    const info: ServerAuth.Info = configured
    expect(Option.isNone(info.reviewerUsername)).toBe(true)
    expect(Option.isNone(info.reviewerPassword)).toBe(true)
    expect(ServerAuth.reviewerConfigured(configured)).toBe(false)
    expect(ServerAuth.reviewerConfigured(embedded)).toBe(false)
  })

  test("configured primary credentials authorize as the primary identity only", () => {
    const primary = { username: "opencode", password: Redacted.make("secret") }
    expect(ServerAuth.required(configured)).toBe(true)
    expect(ServerAuth.authorized(primary, configured)).toBe(true)
    expect(ServerAuth.authenticatedUsername(primary, configured)).toBe("opencode")

    // No second identity can authenticate against a primary-only Info.
    const secondIdentity = { username: "reviewer", password: Redacted.make("secret") }
    expect(ServerAuth.authorized(secondIdentity, configured)).toBe(false)
    expect(ServerAuth.authenticatedUsername(secondIdentity, configured)).toBeUndefined()
  })

  test("embedded (passwordless) Info authorizes nothing", () => {
    expect(ServerAuth.required(embedded)).toBe(false)
    const anything = { username: "opencode", password: Redacted.make("") }
    expect(ServerAuth.authorized(anything, embedded)).toBe(false)
    expect(ServerAuth.authenticatedUsername(anything, embedded)).toBeUndefined()
  })

  test("the value satisfies the configLayer contract used by routes.ts", () => {
    expect(ServerAuth.Config.configLayer(configured)).toBeDefined()
    expect(ServerAuth.Config.configLayer(embedded)).toBeDefined()
  })
})
