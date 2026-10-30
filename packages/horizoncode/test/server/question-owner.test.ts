import { describe, expect, test } from "bun:test"
import { legacyHostRootCompatible, ownerMatchesPrincipal } from "../../src/question/owner"

describe("question owner scope", () => {
  test("matches server-auth questions only to the middleware subject", () => {
    const alice = { kind: "server_auth", subject: "alice" } as const
    expect(ownerMatchesPrincipal(alice, { kind: "server_auth", subject: "alice" })).toBe(true)
    expect(ownerMatchesPrincipal(alice, { kind: "server_auth", subject: "bob" })).toBe(false)
    expect(ownerMatchesPrincipal(alice, { kind: "host_os" })).toBe(false)
  })

  test("host OS access requires Core-owned host metadata; malformed and request-like labels fail closed", () => {
    expect(ownerMatchesPrincipal({ kind: "host_os" }, { kind: "host_os" })).toBe(true)
    expect(ownerMatchesPrincipal({ kind: "host_os" }, { kind: "server_auth", subject: "alice" })).toBe(false)
    expect(ownerMatchesPrincipal({ kind: "host_os" }, { kind: "host_os", subject: "forged" })).toBe(false)
    expect(ownerMatchesPrincipal({ kind: "host_os" }, null)).toBe(false)
    expect(ownerMatchesPrincipal({ kind: "host_os" }, "host_os")).toBe(false)
  })

  test("legacy fallback is limited to an ownerless root in the current instance directory", () => {
    const root = { directory: "/workspace", instanceDirectory: "/workspace", ownerMetadata: undefined }
    expect(legacyHostRootCompatible({ kind: "host_os" }, root)).toBe(true)
    expect(legacyHostRootCompatible({ kind: "server_auth", subject: "alice" }, root)).toBe(false)
    expect(legacyHostRootCompatible({ kind: "host_os" }, { ...root, parentID: "ses_parent" })).toBe(false)
    expect(legacyHostRootCompatible({ kind: "host_os" }, { ...root, directory: "/other" })).toBe(false)
    expect(legacyHostRootCompatible({ kind: "host_os" }, { ...root, ownerMetadata: { kind: "server_auth", subject: "alice" } })).toBe(false)
  })
})
