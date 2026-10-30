import { localCliOriginRoutesEnabled, localCliEffectMutationPrincipal } from "./local-cli-origin"
import { localDirectProviderCredentialsEnabled } from "./local-direct-credentials"

export type GuardedOriginKind = "process" | "http" | "stdio"

/**
 * Single seam for Guard-backed origins. Production stays fail-closed until a
 * process | http | stdio adapter holds a one-use lease; local audited dev uses
 * the same gate as scripts/horizoncode (HORIZONCODE_LOCAL_CLI + direct creds).
 */
export function guardedOriginAvailable(_kind: GuardedOriginKind): boolean {
  return localCliOriginRoutesEnabled()
}

export function guardedOriginProcessRouteAvailable(): boolean {
  return guardedOriginAvailable("process")
}

export function guardedOriginHttpRouteAvailable(): boolean {
  return guardedOriginAvailable("http")
}

export function guardedOriginMcpRuntimeAvailable(): boolean {
  return guardedOriginAvailable("stdio")
}

export function guardedOriginProviderAuthAvailable(): boolean {
  return localDirectProviderCredentialsEnabled()
}

export { localCliOriginRoutesEnabled, localCliEffectMutationPrincipal }
