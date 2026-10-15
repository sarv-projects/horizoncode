import { Context } from "effect"

export type TrustedPrincipal =
  | { readonly kind: "server_auth"; readonly subject: string }
  | { readonly kind: "host_os" }

export interface TrustedPrincipalContextValue {
  readonly principal: TrustedPrincipal
}

export class TrustedPrincipalContext extends Context.Service<
  TrustedPrincipalContext,
  TrustedPrincipalContextValue
>()("@opencode/TrustedPrincipalContext") {}
