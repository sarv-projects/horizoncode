import { describe, expect, test } from "bun:test"
import { requireSessionData, requireSessionID, SessionNotFoundError } from "@/cli/cmd/run/runtime.session"

describe("run session resolution", () => {
  test("preserves the original rejected session lookup cause", async () => {
    const cause = new Error("session service unavailable")

    await expect(requireSessionData(Promise.reject(cause))).rejects.toBe(cause)
  })

  test("distinguishes a successful lookup with no session from a failed lookup", async () => {
    await expect(requireSessionData(Promise.resolve({ data: undefined }))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    )
  })

  test("uses the typed missing-session error when local bring-up returns no id", () => {
    expect(() => requireSessionID(undefined)).toThrow(SessionNotFoundError)
    expect(() => requireSessionID({ id: "ses-1" })).not.toThrow()
  })

  test("preserves a typed SDK error returned in the response", async () => {
    const cause = { name: "NotFoundError", data: { message: "session does not exist" } }

    await expect(requireSessionData(Promise.resolve({ error: cause }))).rejects.toBe(cause)
  })
})
