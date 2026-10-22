import type { TrustedPrincipal } from "@opencode-ai/core/trusted-principal"

/** Match only Core-stored owner metadata against identity supplied by auth middleware. */
export function ownerMatchesPrincipal(principal: TrustedPrincipal, owner: unknown): boolean {
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return false
  const record = owner as Record<string, unknown>
  if (principal.kind === "server_auth") {
    return Object.keys(record).length === 2 && record.kind === "server_auth" && record.subject === principal.subject
  }
  return Object.keys(record).length === 1 && record.kind === "host_os"
}

/** Narrow compatibility for pre-owner-metadata local root Sessions only. */
export function legacyHostRootCompatible(
  principal: TrustedPrincipal,
  input: { parentID?: string; directory: string; instanceDirectory: string; ownerMetadata: unknown },
): boolean {
  return (
    principal.kind === "host_os" &&
    input.parentID === undefined &&
    input.directory === input.instanceDirectory &&
    input.ownerMetadata === undefined
  )
}
