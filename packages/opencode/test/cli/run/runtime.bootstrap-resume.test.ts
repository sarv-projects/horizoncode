import { describe, expect, test } from "bun:test"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { resolveSessionInfo } from "@/cli/cmd/run/runtime.boot"
import { SessionNotFoundError, requireSessionData, requireSessionID } from "@/cli/cmd/run/runtime.session"

type Sdk = InstanceType<typeof OpencodeClient>

/**
 * Item 44 guard for the `Session not found` / bootstrap path.
 *
 * Resuming a session that no longer exists must degrade to a fresh boot rather
 * than crash the runtime before the first frame: the boot resolver owns that
 * decision, and it returns the empty session shape on every lookup failure.
 */
function sdkWithMessages(messages: () => Promise<unknown>): Sdk {
  return { session: { messages } } as unknown as Sdk
}

describe("run runtime resume bootstrap", () => {
  test("a rejected resume lookup boots as a fresh session", async () => {
    const sdk = sdkWithMessages(() => Promise.reject(new SessionNotFoundError()))
    const info = await resolveSessionInfo(sdk, "ses_missing", undefined)

    expect(info).toEqual({ first: true, history: [], variant: undefined })
  })

  test("a lookup that returns neither data nor error boots as a fresh session", async () => {
    const sdk = sdkWithMessages(() => Promise.resolve({ data: undefined }))
    const info = await resolveSessionInfo(sdk, "ses_missing", undefined)

    expect(info).toEqual({ first: true, history: [], variant: undefined })
  })

  test("an SDK error payload is surfaced instead of being read as an empty history", async () => {
    const sdk = sdkWithMessages(() => Promise.resolve({ error: { message: "boom" } }))

    await expect(requireSessionData(sdk.session.messages({ sessionID: "ses_missing" }))).rejects.toEqual({
      message: "boom",
    })
  })

  test("a resumed session with history is not reported as first", async () => {
    const sdk = sdkWithMessages(() =>
      Promise.resolve({
        data: [
          {
            info: {
              id: "msg_1",
              role: "user",
              sessionID: "ses_1",
              time: { created: 1 },
              model: { providerID: "test", modelID: "model" },
            },
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      }),
    )

    const info = await resolveSessionInfo(sdk, "ses_1", undefined)

    expect(info.first).toBe(false)
    expect(info.history.map((turn) => turn.text)).toEqual(["hello"])
  })

  test("a created session without an id fails with the typed missing-session error", () => {
    expect(() => requireSessionID(undefined)).toThrow(SessionNotFoundError)
    expect(() => requireSessionID({})).toThrow("Session not found")
    expect(requireSessionID({ id: "ses_1" })).toBe("ses_1")
  })
})
