import { Context } from "effect"

export type TrustedPrincipal =
  | { readonly kind: "server_auth"; readonly subject: string }
  | { readonly kind: "host_os" }

/** Identity comparison for continuations pinned to one authenticated execution owner. */
export const sameTrustedPrincipal = (left: TrustedPrincipal, right: TrustedPrincipal): boolean =>
  left.kind === right.kind &&
  (left.kind !== "server_auth" || (right.kind === "server_auth" && left.subject === right.subject))

export interface TrustedPrincipalContextValue {
  readonly principal: TrustedPrincipal
}

export class TrustedPrincipalContext extends Context.Service<
  TrustedPrincipalContext,
  TrustedPrincipalContextValue
>()("@opencode/TrustedPrincipalContext") {}
