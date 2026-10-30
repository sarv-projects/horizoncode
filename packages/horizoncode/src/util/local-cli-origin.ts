import { localDirectProviderCredentialsEnabled } from "./local-direct-credentials"

/**
 * Audited local development: allow read-only or bounded legacy origins (git inspect,
 * outbound HTTP fetch, MCP stdio) without a Guard lease. Production remains fail-closed.
 */
export function localCliOriginRoutesEnabled(): boolean {
  return process.env.HORIZONCODE_LOCAL_CLI === "1" && localDirectProviderCredentialsEnabled()
}

export function localCliEffectMutationPrincipal(input: {
  kind?: string
  subject?: string
} | undefined): boolean {
  if (!input) return false
  if (input.kind === "server_auth" && input.subject) return true
  if (localCliOriginRoutesEnabled() && input.kind === "host_os") return true
  return false
}
