import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { Schema } from "effect"
import { ProviderV2 } from "@horizoncode/core/provider"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { ProviderError } from "@/provider/error"
import { SessionRetry } from "@/session/retry"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})

const freeLimitBody = (message: string) => ({
  type: "error",
  error: { type: "FreeUsageLimitError", message },
})

const freeTierBody = (message: string) => ({
  type: "error",
  error: { type: "FreeTierError", message },
})

const apiCallError = (input: {
  statusCode: number
  body: unknown
  responseHeaders?: Record<string, string>
}) =>
  new APICallError({
    message: "provider request failed",
    url: "https://opencode.ai/inference/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: input.statusCode,
    responseHeaders: input.responseHeaders,
    responseBody: JSON.stringify(input.body),
    isRetryable: input.statusCode === 429 || input.statusCode >= 500,
  })

// Exercises the real session retry policy so the mapping cannot regress into a
// retry loop for terminal free-tier failures.
const retryOutcome = (parsed: {
  message: string
  isRetryable: boolean
  statusCode?: number
  responseBody?: string
  responseHeaders?: Record<string, string>
}) =>
  SessionRetry.retryable(
    Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: parsed.message,
        isRetryable: parsed.isRetryable,
        statusCode: parsed.statusCode,
        responseBody: parsed.responseBody,
        responseHeaders: parsed.responseHeaders,
      }).toObject(),
    ),
    "opencode",
  )

describe("opencode free-tier error surfacing", () => {
  test("429 FreeUsageLimitError becomes the daily quota message with Retry-After and does not retry", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.opencode,
      error: apiCallError({
        statusCode: 429,
        body: freeLimitBody("Rate limit exceeded. Please try again later."),
        responseHeaders: { "retry-after": "57000" },
      }),
    })
    if (parsed.type !== "api_error") throw new Error("expected api_error")

    expect(parsed.message).toBe("Daily free quota exhausted. The quota resets around 00:00 UTC. Retry-After: 57000s.")
    expect(parsed.isRetryable).toBe(false)
    expect(parsed.statusCode).toBe(429)
    expect(parsed.responseHeaders?.["retry-after"]).toBe("57000")
    expect(retryOutcome(parsed)).toBeUndefined()
  })

  test("429 FreeUsageLimitError without Retry-After still reports the daily reset window", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.opencode,
      error: apiCallError({
        statusCode: 429,
        body: freeLimitBody("Rate limit exceeded. Please try again later."),
      }),
    })
    if (parsed.type !== "api_error") throw new Error("expected api_error")

    expect(parsed.message).toBe("Daily free quota exhausted. The quota resets around 00:00 UTC.")
    expect(parsed.isRetryable).toBe(false)
    expect(retryOutcome(parsed)).toBeUndefined()
  })

  test("403 FreeTierError surfaces the gateway message verbatim plus guidance and does not retry", () => {
    const gateway =
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.opencode,
      error: apiCallError({ statusCode: 403, body: freeTierBody(gateway) }),
    })
    if (parsed.type !== "api_error") throw new Error("expected api_error")

    expect(parsed.message).toContain(gateway)
    expect(parsed.message).toContain("OPENCODE_API_KEY")
    expect(parsed.isRetryable).toBe(false)
    expect(parsed.statusCode).toBe(403)
    expect(retryOutcome(parsed)).toBeUndefined()
  })

  test("streamed FreeUsageLimitError maps to the daily quota message without retrying", () => {
    const parsed = ProviderError.parseStreamError(freeLimitBody("Rate limit exceeded. Please try again later."))
    if (!parsed || parsed.type !== "api_error") throw new Error("expected api_error")

    expect(parsed.message).toBe("Daily free quota exhausted. The quota resets around 00:00 UTC.")
    expect(parsed.isRetryable).toBe(false)
    expect(retryOutcome(parsed)).toBeUndefined()
  })

  test("streamed FreeTierError maps to the gateway message without retrying", () => {
    const gateway =
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
    const parsed = ProviderError.parseStreamError(freeTierBody(gateway))
    if (!parsed || parsed.type !== "api_error") throw new Error("expected api_error")

    expect(parsed.message).toContain(gateway)
    expect(parsed.isRetryable).toBe(false)
    expect(retryOutcome(parsed)).toBeUndefined()
  })
})
