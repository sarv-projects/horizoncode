import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@horizoncode/core/provider"
import { isContextOverflow } from "@horizoncode/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// The free-tier gateway reports terminal access failures with its own body
// types. They get honest, actionable messages instead of the generic gateway
// text, and they must not enter the retry loop.
const FREE_USAGE_LIMIT_MESSAGE = "Daily free quota exhausted. The quota resets around 00:00 UTC."
const FREE_TIER_GUIDANCE =
  "Free access is only granted to the OpenCode client identity; if this persists, set OPENCODE_API_KEY or run `opencode auth login opencode` for authenticated access."

function freeUsageLimitMessage(retryAfter: number | undefined) {
  if (retryAfter === undefined) return FREE_USAGE_LIMIT_MESSAGE
  return `${FREE_USAGE_LIMIT_MESSAGE} Retry-After: ${retryAfter}s.`
}

function retryAfterSeconds(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "retry-after")
  const value = key === undefined ? undefined : headers[key]
  if (value === undefined) return undefined
  const seconds = Number.parseFloat(value)
  if (Number.isNaN(seconds)) return undefined
  return Math.ceil(seconds)
}

function freeTierMessage(body: unknown): string {
  const gateway = iife(() => {
    if (typeof body !== "object" || body === null) return undefined
    const error = (body as { error?: unknown }).error
    if (typeof error !== "object" || error === null) return undefined
    const message = (error as { message?: unknown }).message
    if (typeof message !== "string" || message === "") return undefined
    return message
  })
  return `${gateway ?? "Free tier access was refused for this request."} ${FREE_TIER_GUIDANCE}`
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  if (body?.error?.type === "FreeUsageLimitError") {
    const message = freeUsageLimitMessage(undefined)
    return {
      type: "api_error",
      message,
      isRetryable: false,
      responseBody: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message } }),
    }
  }

  if (body?.error?.type === "FreeTierError") {
    return {
      type: "api_error",
      message: freeTierMessage(body),
      isRetryable: false,
      responseBody,
    }
  }

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }

  return {
    type: "api_error",
    message: typeof body?.error?.message === "string" ? body.error.message : "Server error.",
    isRetryable: true,
    responseBody,
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined

  // The gateway's free-tier error types are terminal. The raw APICallError
  // stays attached as the cause; the 429 parsed body is normalized so its
  // vague "rate limit" text cannot loop the inherited retry policy while the
  // daily quota is exhausted.
  if (body?.error?.type === "FreeUsageLimitError") {
    const limit = freeUsageLimitMessage(retryAfterSeconds(input.error.responseHeaders))
    return {
      type: "api_error",
      message: limit,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: limit } }),
      metadata,
    }
  }

  if (body?.error?.type === "FreeTierError") {
    return {
      type: "api_error",
      message: freeTierMessage(body),
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata,
    }
  }

  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
