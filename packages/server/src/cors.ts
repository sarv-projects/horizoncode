import { Context } from "effect"

const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (
    input === "oc://renderer" ||
    input === "tauri://localhost" ||
    input === "http://tauri.localhost" ||
    input === "https://tauri.localhost"
  )
    return true
  try {
    const parsed = new URL(input)
    if (
      parsed.origin !== input ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    )
      return false
    if (
      parsed.protocol === "http:" &&
      parsed.port !== "" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    )
      return true
  } catch {
    return false
  }
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      parsed.host === host
    )
  } catch {
    return false
  }
}

