import type { TrustedPrincipal } from "@horizoncode/core/trusted-principal"
import { Option } from "effect"
import type { Option as OptionType } from "effect/Option"
import { localCliOriginRoutesEnabled } from "./local-cli-origin"

export function mintServerAuthPrincipal(subject: string): TrustedPrincipal {
  return { kind: "server_auth", subject }
}

export function mintHostOsPrincipal(): TrustedPrincipal {
  return { kind: "host_os" }
}

/** CLI in-process turns: no HTTP middleware, so mint host_os when the launcher armed local CLI. */
export function mintLocalCliFallbackPrincipal(): OptionType<{ principal: TrustedPrincipal }> {
  if (process.env.HORIZONCODE_LOCAL_CLI !== "1") return Option.none()
  return Option.some({ principal: mintHostOsPrincipal() })
}

export function resolveTrustedPrincipalContext(input: {
  authenticatedUsername?: string
  trustedLoopbackHostOs?: boolean
}): { principal: TrustedPrincipal } | undefined {
  if (input.authenticatedUsername) {
    return { principal: mintServerAuthPrincipal(input.authenticatedUsername) }
  }
  if (input.trustedLoopbackHostOs) {
    return { principal: mintHostOsPrincipal() }
  }
  return undefined
}

/** Mutation/checkpoint admission: server auth always; host_os only on audited local CLI. */
export function trustedPrincipalAllowsSessionMutation(principal: TrustedPrincipal | undefined): boolean {
  if (!principal) return false
  if (principal.kind === "server_auth" && principal.subject) return true
  if (localCliOriginRoutesEnabled() && principal.kind === "host_os") return true
  return false
}
