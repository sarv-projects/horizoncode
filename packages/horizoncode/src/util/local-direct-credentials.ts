/** Audited local/dev path: env and legacy auth store may dispatch without SecretBroker transport. */
export function localDirectProviderCredentialsEnabled(): boolean {
  return process.env.HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS === "1"
}
